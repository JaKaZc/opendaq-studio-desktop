/**
 * The engine host: an Electron utility process that holds the native openDAQ
 * engine (`studio_engine.node`).
 *
 * It runs apart from the main process, so a crash in the SDK or a module ends
 * this process and not the windows. The main process sends it API requests;
 * each window gets its own message port, which carries what the WebSocket at
 * `/api/ws` carried before: JSON control and event messages, and binary ODQV
 * sample frames, one client of live data per window.
 */

import { join } from 'node:path';

interface EngineAddon {
  start(options: string): { ok: boolean; error?: string };
  stop(): void;
  request(method: string, path: string, query: string, body: string): Promise<{ status: number; body: string }>;
  clientOpen(): number;
  clientClose(client: number): void;
  clientSubscribe(client: number, ids: string, pointsPerSecond: number, primeSeconds: number): Promise<{ status: number; body: string }>;
  clientUnsubscribe(client: number, ids: string | null): void;
  clientResolution(client: number, pointsPerSecond: number): void;
  clientPause(client: number, paused: boolean): void;
  clientPoll(client: number): ArrayBuffer | null;
  events(): string;
  picture(id: string, known: number): { data: ArrayBuffer | null; sequence: number };
}

/** What the main process sends. */
export type HostRequest =
  | { type: 'start'; engineDir: string; options: Record<string, unknown>; streamInterval: number; maxPoints: number }
  | { type: 'request'; id: number; method: string; path: string; query: Record<string, unknown>; body: string }
  | { type: 'picture'; id: number; signalId: string; after: number }
  | { type: 'window' }
  | { type: 'stop' };

/** What the host answers. */
export type HostReply =
  | { type: 'started'; ok: boolean; error?: string }
  | { type: 'response'; id: number; status: number; body: string }
  /**
   * A picture, or with `status` and `body` the engine's refusal of the
   * request. `mediaType` is the type the signal's format names,
   * for pictures whose first bytes do not tell.
   */
  | { type: 'picture'; id: number; data: ArrayBuffer | null; sequence: number; mediaType?: string; status?: number; body?: string }
  | { type: 'stopped' };

interface Window {
  port: Electron.MessagePortMain;
  client: number;
  /** The window's subscriptions, in the order they were made. */
  signals: string[];
}

/** An event as the engine sends it, numbered and stamped. */
interface HostEvent {
  type: string;
  seq: number;
  at: number;
  payload: unknown;
}

const parentPort = process.parentPort;
let engine: EngineAddon | null = null;
let streamInterval = 0.05;
let maxPoints = 4000;
const windows = new Set<Window>();
let pump: NodeJS.Timeout | null = null;
let eventPump: NodeJS.Timeout | null = null;

/** How many recent notifications a freshly attached window is given. */
const replayEvents = 40;
/** The media type each image signal's format names, from the picture route's checks. */
const pictureTypes = new Map<string, string>();

function reply(message: HostReply): void {
  parentPort.postMessage(message);
}

function sendJson(window: Window, message: unknown): void {
  window.port.postMessage(JSON.stringify(message));
}

function error(code: string, message: string, extra: Record<string, unknown> = {}): unknown {
  return { type: 'error', payload: { code, message, ...extra } };
}

/** Whether a message member is set: missing, null, false, 0, "" and empty lists and objects are not. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** A message member as a number, or `fallback` when it is not set. */
function number(value: unknown, fallback: number): number {
  if (!truthy(value)) return fallback;
  if (typeof value === 'number') return value;
  if (value === true) return 1;
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) return Number(value);
  if (typeof value === 'string') throw new Error(`'${value}' is not a number`);
  throw new Error(`a number was expected, not ${Array.isArray(value) ? 'a list' : 'an object'}`);
}

// ------------------------------------------------------------------ windows

function attach(port: Electron.MessagePortMain): void {
  if (!engine) return;
  const window: Window = { port, client: engine.clientOpen(), signals: [] };
  windows.add(window);
  port.on('message', (event) => void receive(window, event.data));
  port.on('close', () => detach(window));
  port.start();
  sendJson(window, {
    type: 'hello',
    payload: {
      clientId: `window-${window.client}`,
      appVersion: '1.0.0',
      apiVersion: '1.0',
      frameIntervalSeconds: streamInterval,
      maxPointsPerFrame: maxPoints,
      readOnly: false,
    },
  });
  // The engine keeps the recent notifications for windows that attach later.
  void engine.request('GET', '/api/system/events', JSON.stringify({ limit: String(replayEvents) }), '').then((answer) => {
    if (answer.status === 200) for (const event of (JSON.parse(answer.body) as { events: HostEvent[] }).events) sendJson(window, event);
  });
}

function detach(window: Window): void {
  if (!windows.delete(window)) return;
  engine?.clientClose(window.client);
}

/** One message from a window, as the WebSocket's receive loop. */
async function receive(window: Window, raw: unknown): Promise<void> {
  if (!engine) return;
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(window, error('bad_request', 'message must be an object'));
      return;
    }
    message = parsed as Record<string, unknown>;
  } catch {
    sendJson(window, error('bad_request', 'message is not valid JSON'));
    return;
  }
  try {
    await handle(engine, window, message);
  } catch (cause) {
    // One bad message must not drop the window's port.
    sendJson(window, error('internal_error', cause instanceof Error ? cause.message : String(cause), { request: message.type ?? undefined }));
  }
}

/** One control message from a window. */
async function handle(engine: EngineAddon, window: Window, message: Record<string, unknown>): Promise<void> {
  const kind = truthy(message.type) ? String(message.type) : '';

  switch (kind) {
    case 'ping':
      sendJson(window, { type: 'pong', payload: { echo: message.payload ?? null } });
      return;
    case 'subscribe': {
      const ids = Array.isArray(message.signalIds) ? message.signalIds.map(String) : [];
      const pointsPerSecond = number(message.pointsPerSecond, 4000);
      const primeSeconds = number(message.primeSeconds, 1);
      const answer = await engine.clientSubscribe(window.client, JSON.stringify(ids), pointsPerSecond, primeSeconds);
      const body = JSON.parse(answer.body) as Record<string, unknown>;
      if (answer.status !== 200) {
        const detail = body.detail ? { detail: body.detail } : {};
        sendJson(window, error(String(body.code), String(body.message), { ...detail, request: message.type }));
        return;
      }
      for (const meta of body.signals as { signalId: string }[]) {
        if (!window.signals.includes(meta.signalId)) window.signals.push(meta.signalId);
      }
      // The engine's own text, which keeps numbers such as 1000.0 as it wrote them.
      window.port.postMessage(`{"type":"subscribed","payload":${answer.body}}`);
      return;
    }
    case 'unsubscribe': {
      const ids = message.signalIds == null ? null : Array.isArray(message.signalIds) ? message.signalIds.map(String) : [];
      engine.clientUnsubscribe(window.client, ids === null ? null : JSON.stringify(ids));
      window.signals = ids === null ? [] : window.signals.filter((id) => !ids.includes(id));
      sendJson(window, { type: 'unsubscribed', payload: { signals: window.signals } });
      return;
    }
    case 'resolution':
      engine.clientResolution(window.client, number(message.pointsPerSecond, 4000));
      return;
    case 'pause':
      engine.clientPause(window.client, truthy(message.paused));
      return;
    default:
      sendJson(window, error('bad_request', `unknown message type: ${kind || '(missing)'}`));
  }
}

/** How long a request for a newer picture waits for one, in milliseconds. */
const PICTURE_WAIT = 50;

/**
 * The newest picture of an image signal. When the engine has none, its
 * picture route says why, or which media type the signal's format names.
 *
 * A caller that has a picture already waits up to PICTURE_WAIT for a newer
 * one, which is looked for every millisecond. It gets each picture as soon as
 * it is made, so a viewer polling at the screen's refresh does not miss
 * pictures that are made at the same rate a little later in each frame.
 */
async function picture(engine: EngineAddon, id: number, signalId: string, after: number): Promise<HostReply> {
  let answer = Number.isInteger(after) ? engine.picture(signalId, after) : { data: null, sequence: 0 };
  if (after > 0 && answer.sequence === after) {
    const deadline = performance.now() + PICTURE_WAIT;
    while (answer.sequence === after && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      answer = engine.picture(signalId, after);
    }
  }
  if (!answer.data && answer.sequence === 0) {
    const query = { id: signalId, after: String(after) };
    const check = await engine.request('GET', '/api/signals/picture', JSON.stringify(query), '');
    if (check.status !== 200) return { type: 'picture', id, data: null, sequence: 0, status: check.status, body: check.body };
    pictureTypes.set(signalId, (JSON.parse(check.body) as { mediaType: string }).mediaType);
  }
  return { type: 'picture', id, data: answer.data, sequence: answer.sequence, mediaType: pictureTypes.get(signalId) };
}

// ------------------------------------------------------------------ pumps

function startPumps(): void {
  // Each window gets its frames at the stream interval, as the WebSocket's
  // stream loop sent them.
  pump = setInterval(() => {
    if (!engine) return;
    for (const window of windows) {
      const frame = engine.clientPoll(window.client);
      if (frame) window.port.postMessage(frame);
    }
  }, Math.max(10, streamInterval * 1000));
  // Events go to every window; the engine keeps the notifications for windows
  // that attach later.
  eventPump = setInterval(() => {
    if (!engine) return;
    let events: HostEvent[];
    try {
      events = JSON.parse(engine.events()) as HostEvent[];
    } catch {
      return;
    }
    // The engine numbers and stamps the events.
    for (const event of events) {
      const text = JSON.stringify(event);
      for (const window of windows) window.port.postMessage(text);
    }
  }, 100);
}

function stopPumps(): void {
  if (pump) clearInterval(pump);
  if (eventPump) clearInterval(eventPump);
  pump = null;
  eventPump = null;
}

// ------------------------------------------------------------------ main process

parentPort.on('message', (event) => {
  const message = event.data as HostRequest;
  switch (message.type) {
    case 'start': {
      streamInterval = message.streamInterval;
      maxPoints = message.maxPoints;
      // The addon needs the engine and the SDK's DLLs beside it. Windows
      // finds a DLL's dependencies through PATH, not the DLL's own folder.
      if (process.platform === 'win32') process.env.PATH = `${message.engineDir};${process.env.PATH ?? ''}`;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      engine = require(join(message.engineDir, 'studio_engine.node')) as EngineAddon;
      const result = engine.start(JSON.stringify(message.options));
      if (result.ok) startPumps();
      reply({ type: 'started', ok: result.ok, error: result.error });
      return;
    }
    case 'request': {
      if (!engine) {
        reply({ type: 'response', id: message.id, status: 503, body: JSON.stringify({ code: 'not_ready', message: 'The openDAQ engine is not running' }) });
        return;
      }
      void engine
        .request(message.method, message.path, JSON.stringify(message.query), message.body)
        .then((answer) => reply({ type: 'response', id: message.id, status: answer.status, body: answer.body }))
        .catch((cause: unknown) =>
          reply({ type: 'response', id: message.id, status: 500, body: JSON.stringify({ code: 'internal_error', message: String(cause) }) }),
        );
      return;
    }
    case 'picture': {
      if (!engine) {
        reply({ type: 'picture', id: message.id, data: null, sequence: message.after });
        return;
      }
      void picture(engine, message.id, message.signalId, message.after).then(reply, (cause: unknown) =>
        reply({ type: 'picture', id: message.id, data: null, sequence: 0, status: 500, body: JSON.stringify({ code: 'internal_error', message: String(cause) }) }),
      );
      return;
    }
    case 'window': {
      const port = event.ports[0];
      if (port) attach(port);
      return;
    }
    case 'stop': {
      stopPumps();
      for (const window of [...windows]) {
        detach(window);
        window.port.close();
      }
      engine?.stop();
      engine = null;
      reply({ type: 'stopped' });
      return;
    }
  }
});
