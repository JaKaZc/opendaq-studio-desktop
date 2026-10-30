/**
 * The realtime client: one WebSocket carrying both events and sample frames.
 *
 * Responsibilities kept here on purpose:
 *
 * - **Reconnect with backoff.**  A viewer left open across a backend restart has
 *   to come back on its own, and it has to re-issue its subscriptions, so the
 *   desired subscription set is remembered and replayed on every open.
 * - **Sample routing.**  Decoded blocks are handed straight to the trace store;
 *   they never pass through React state, because a 20 Hz frame rate through a
 *   reducer would re-render the whole tree 20 times a second.
 * - **Event fan-out.**  JSON events go to listeners, which *do* live in React.
 *
 * In the desktop app on the native engine there is no WebSocket: the window's
 * message port carries the same messages, and {@link PortSocket} makes it look
 * like one.
 */

import { decodeFrame, FrameDecodeError, type DecodedBlock } from './frames';
import type { StreamMetaWire, ViewerEvent } from './types';
import { websocketUrl } from './api';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'reconnecting';

export interface HelloPayload {
  clientId: string;
  appVersion: string;
  apiVersion: string;
  frameIntervalSeconds: number;
  maxPointsPerFrame: number;
  readOnly: boolean;
}

export interface RealtimeHandlers {
  onState?: (state: ConnectionState, attempt: number) => void;
  onHello?: (payload: HelloPayload) => void;
  onEvent?: (event: ViewerEvent) => void;
  onSubscribed?: (metas: StreamMetaWire[]) => void;
  onSamples?: (blocks: DecodedBlock[], sentAt: number, byteLength: number) => void;
  onError?: (message: string, code?: string) => void;
}

interface SubscriptionRequest {
  signalIds: string[];
  pointsPerSecond: number;
  primeSeconds: number;
}

/** The desktop app's bridge to the native engine's port, from its preload. */
interface RealtimeBridge {
  connect(handlers: { onOpen: () => void; onMessage: (data: string | ArrayBuffer) => void }): void;
  send(text: string): void;
  close(): void;
}

function desktopBridge(): RealtimeBridge | undefined {
  return (window as unknown as { openDaqDesktop?: { realtime?: RealtimeBridge } }).openDaqDesktop?.realtime;
}

/** What the client uses of a WebSocket. */
interface SocketLike {
  readonly readyState: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(): void;
}

/**
 * The native engine's message port in the shape of a WebSocket. The port is
 * the window's for as long as the page lives, so it never closes on its own.
 */
class PortSocket implements SocketLike {
  readyState: number = WebSocket.CONNECTING;
  binaryType: BinaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(private readonly bridge: RealtimeBridge) {
    // The bridge can answer at once, during this constructor, before the
    // caller has set the handlers; as a WebSocket's, they run later, in order.
    bridge.connect({
      onOpen: () =>
        queueMicrotask(() => {
          this.readyState = WebSocket.OPEN;
          this.onopen?.(new Event('open'));
        }),
      onMessage: (data) => queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data }))),
    });
  }

  send(data: string): void {
    this.bridge.send(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.bridge.close();
  }
}

/** Reconnect delays in ms; the last value repeats. */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 15_000];

export class RealtimeClient {
  private socket: SocketLike | null = null;
  private handlers: RealtimeHandlers = {};
  private state: ConnectionState = 'closed';
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private disposed = false;
  /** The subscription we want the server to hold, replayed after a reconnect. */
  private desired: SubscriptionRequest = { signalIds: [], pointsPerSecond: 4000, primeSeconds: 1 };
  private paused = false;

  /** Rolling receive statistics, shown on the diagnostics page. */
  readonly stats = { frames: 0, bytes: 0, events: 0, lastFrameAt: 0, reconnects: 0 };

  setHandlers(handlers: RealtimeHandlers): void {
    this.handlers = handlers;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.disposed || this.socket) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: SocketLike;
    try {
      const bridge = desktopBridge();
      socket = bridge ? new PortSocket(bridge) : new WebSocket(websocketUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      // Re-assert everything the UI asked for before the connection dropped.
      if (this.desired.signalIds.length > 0) this.sendSubscribe();
      if (this.paused) this.send({ type: 'pause', paused: true });
    };

    socket.onmessage = (message) => {
      if (typeof message.data === 'string') {
        this.handleText(message.data);
      } else if (message.data instanceof ArrayBuffer) {
        this.handleBinary(message.data);
      }
    };

    socket.onerror = () => {
      // `onclose` always follows, and carries the useful information.
    };

    socket.onclose = () => {
      this.socket = null;
      if (this.disposed) return;
      this.stats.reconnects += 1;
      this.scheduleReconnect();
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.close();
    }
    this.setState('closed');
  }

  // ------------------------------------------------------------------ commands

  /** Replace the subscription set. Signals not listed are dropped server-side. */
  subscribe(signalIds: string[], pointsPerSecond: number, primeSeconds = 1): void {
    this.desired = { signalIds: [...signalIds], pointsPerSecond, primeSeconds };
    if (signalIds.length === 0) {
      this.send({ type: 'unsubscribe' });
      return;
    }
    this.sendSubscribe();
  }

  setResolution(pointsPerSecond: number): void {
    this.desired.pointsPerSecond = pointsPerSecond;
    this.send({ type: 'resolution', pointsPerSecond });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.send({ type: 'pause', paused });
  }

  ping(): void {
    this.send({ type: 'ping', payload: Date.now() });
  }

  private sendSubscribe(): void {
    this.send({
      type: 'subscribe',
      signalIds: this.desired.signalIds,
      pointsPerSecond: this.desired.pointsPerSecond,
      primeSeconds: this.desired.primeSeconds,
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
    // Otherwise the desired state is already recorded and replayed on open.
  }

  // ------------------------------------------------------------------ receive

  private handleText(raw: string): void {
    let event: ViewerEvent;
    try {
      event = JSON.parse(raw) as ViewerEvent;
    } catch {
      this.handlers.onError?.('Received a malformed message from the backend');
      return;
    }
    this.stats.events += 1;

    switch (event.type) {
      case 'hello':
        this.handlers.onHello?.(event.payload as unknown as HelloPayload);
        return;
      case 'subscribed':
        this.handlers.onSubscribed?.(
          (event.payload as { signals?: StreamMetaWire[] }).signals ?? [],
        );
        return;
      case 'error': {
        const payload = event.payload as { message?: string; code?: string; detail?: string };
        const detail = payload.detail ? `${payload.message}: ${payload.detail}` : payload.message;
        this.handlers.onError?.(detail ?? 'The backend reported an error', payload.code);
        return;
      }
      case 'pong':
        return;
      default:
        this.handlers.onEvent?.(event);
    }
  }

  private handleBinary(buffer: ArrayBuffer): void {
    try {
      const decoded = decodeFrame(buffer);
      this.stats.frames += 1;
      this.stats.bytes += decoded.byteLength;
      this.stats.lastFrameAt = Date.now();
      this.handlers.onSamples?.(decoded.blocks, decoded.frame.sentAt, decoded.byteLength);
    } catch (cause) {
      const message =
        cause instanceof FrameDecodeError ? cause.message : `Could not decode a sample frame: ${String(cause)}`;
      this.handlers.onError?.(message, 'frame_decode');
    }
  }

  // ------------------------------------------------------------------ plumbing

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState?.(state, this.attempt);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)] as number;
    this.attempt += 1;
    this.setState('reconnecting');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

/** One client per browser tab; the store owns its lifetime. */
export const realtime = new RealtimeClient();
