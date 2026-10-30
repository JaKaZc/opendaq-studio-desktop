/**
 * Session state: the connection, the component tree, the selection, notifications.
 *
 * The tree is refetched rather than patched in place when the backend reports a
 * structural change.  A `tree.changed` event is already coalesced server-side, so
 * one extra request per burst buys a guarantee that what is on screen matches the
 * instance - much better than maintaining a second, subtly different model of the
 * openDAQ hierarchy in the browser.
 */

import { create } from 'zustand';
import { api, ApiError } from '../lib/api';
import { realtime, type ConnectionState } from '../lib/realtime';
import { traces } from './traceStore';
import type {
  ComponentDetail,
  ComponentNode,
  InstanceInfo,
  MetadataField,
  NotificationLevel,
  NotificationPayload,
  ViewerEvent,
} from '../lib/types';
import { findNode } from '../lib/views';
import { useSettings } from './useSettings';

export interface Toast {
  id: number;
  level: NotificationLevel;
  message: string;
  detail?: string | null;
  at: number;
  /** Toasts raised locally are dismissed on a timer; backend ones persist in the log. */
  transient: boolean;
}

export interface LogEntry {
  id: number;
  level: NotificationLevel;
  message: string;
  detail: string | null;
  source: string;
  componentId: string | null;
  at: number;
}

interface SessionState {
  connection: ConnectionState;
  reconnectAttempt: number;
  /** Backend identity; null until the first successful load. */
  info: InstanceInfo | null;
  /** Set when the backend cannot be reached at all. */
  fatalError: string | null;

  tree: ComponentNode | null;
  treeLoading: boolean;
  treeError: string | null;
  /** Bumped on every tree refresh so views can reset derived caches. */
  treeRevision: number;

  selectedId: string | null;
  detail: ComponentDetail | null;
  detailLoading: boolean;
  detailError: string | null;

  metadataFields: MetadataField[];

  toasts: Toast[];
  log: LogEntry[];
  unreadLog: number;
}

interface SessionActions {
  bootstrap(): Promise<void>;
  refreshTree(options?: { silent?: boolean }): Promise<void>;
  select(id: string | null): Promise<void>;
  refreshDetail(options?: { silent?: boolean }): Promise<void>;
  notify(level: NotificationLevel, message: string, detail?: string | null): void;
  reportError(error: unknown, context?: string): void;
  dismissToast(id: number): void;
  clearLog(): void;
  markLogRead(): void;
  /** Wrap a mutating call: reports failures and refreshes the affected view. */
  mutate<T>(
    action: () => Promise<T>,
    options?: { success?: string; context?: string; refresh?: 'tree' | 'detail' | 'both' | 'none' },
  ): Promise<T | null>;
}

let nextId = 1;
const TOAST_LIMIT = 5;
const LOG_LIMIT = 500;

export const useSession = create<SessionState & SessionActions>((set, get) => ({
  connection: 'closed',
  reconnectAttempt: 0,
  info: null,
  fatalError: null,

  tree: null,
  treeLoading: false,
  treeError: null,
  treeRevision: 0,

  selectedId: null,
  detail: null,
  detailLoading: false,
  detailError: null,

  metadataFields: [],

  toasts: [],
  log: [],
  unreadLog: 0,

  async bootstrap() {
    set({ fatalError: null });
    try {
      const [info, fields] = await Promise.all([api.system.info(), api.components.metadataFields()]);
      set({ info, metadataFields: fields.fields });
    } catch (error) {
      const message =
        error instanceof ApiError ? error.summary : 'Could not reach the openDAQ Studio backend';
      set({ fatalError: message });
      return;
    }

    await get().refreshTree();
    connectRealtime();
  },

  async refreshTree(options = {}) {
    if (!options.silent) set({ treeLoading: true });
    try {
      const { includeHidden } = useSettings.getState();
      const response = await api.components.tree(includeHidden);
      set((state) => ({
        tree: response.root,
        treeError: null,
        treeLoading: false,
        treeRevision: state.treeRevision + 1,
      }));

      // A selection can disappear when a device is removed elsewhere.
      const { selectedId } = get();
      if (selectedId && !findNode(response.root, selectedId)) {
        set({ selectedId: null, detail: null });
      } else if (selectedId) {
        void get().refreshDetail({ silent: true });
      }
    } catch (error) {
      set({
        treeLoading: false,
        treeError: error instanceof ApiError ? error.summary : String(error),
      });
    }
  },

  async select(id) {
    if (get().selectedId === id) return;
    set({ selectedId: id, detail: null, detailError: null });
    if (id) await get().refreshDetail();
  },

  async refreshDetail(options = {}) {
    const id = get().selectedId;
    if (!id) {
      set({ detail: null, detailLoading: false });
      return;
    }
    if (!options.silent) set({ detailLoading: true });
    try {
      const { includeHidden } = useSettings.getState();
      const detail = await api.components.detail(id, includeHidden);
      // Discard a response for a selection the user has already moved off.
      if (get().selectedId !== id) return;
      set({ detail, detailLoading: false, detailError: null });
    } catch (error) {
      if (get().selectedId !== id) return;
      if (error instanceof ApiError && error.isNotFound) {
        set({ detail: null, detailLoading: false, detailError: null, selectedId: null });
        return;
      }
      set({
        detailLoading: false,
        detailError: error instanceof ApiError ? error.summary : String(error),
      });
    }
  },

  notify(level, message, detail) {
    const entry: LogEntry = {
      id: nextId++,
      level,
      message,
      detail: detail ?? null,
      source: 'viewer',
      componentId: null,
      at: Date.now() / 1000,
    };
    set((state) => ({
      log: [entry, ...state.log].slice(0, LOG_LIMIT),
      unreadLog: state.unreadLog + (level === 'error' || level === 'warning' ? 1 : 0),
      toasts: [
        { id: entry.id, level, message, detail: entry.detail, at: entry.at, transient: level !== 'error' },
        ...state.toasts,
      ].slice(0, TOAST_LIMIT),
    }));
  },

  reportError(error, context) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    const message =
      error instanceof ApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    const detail = error instanceof ApiError ? (error.detail ?? null) : null;
    get().notify('error', context ? `${context}: ${message}` : message, detail);
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },

  clearLog() {
    set({ log: [], unreadLog: 0 });
  },

  markLogRead() {
    set({ unreadLog: 0 });
  },

  async mutate(action, options = {}) {
    const { success, context, refresh = 'both' } = options;
    try {
      const result = await action();
      if (success) get().notify('success', success);
      if (refresh === 'tree' || refresh === 'both') await get().refreshTree({ silent: true });
      if (refresh === 'detail' || refresh === 'both') await get().refreshDetail({ silent: true });
      return result;
    } catch (error) {
      get().reportError(error, context);
      return null;
    }
  },
}));

// --------------------------------------------------------------------------- realtime wiring

let realtimeStarted = false;

/**
 * Connect the WebSocket and route its traffic.
 *
 * Sample blocks go straight into the trace store; only events reach React, so a
 * 20 Hz stream never triggers a render.
 */
export function connectRealtime(): void {
  if (realtimeStarted) return;
  realtimeStarted = true;

  realtime.setHandlers({
    onState(state, attempt) {
      const previous = useSession.getState().connection;
      useSession.setState({ connection: state, reconnectAttempt: attempt });
      if (state === 'open' && (previous === 'reconnecting' || previous === 'closed')) {
        // Whatever changed while we were away is invisible to us, so resync.
        void useSession.getState().refreshTree({ silent: true });
        if (previous === 'reconnecting') {
          useSession.getState().notify('success', 'Reconnected to the backend');
        }
      }
      if (state === 'reconnecting' && previous === 'open') {
        useSession.getState().notify('warning', 'Lost the connection to the backend, retrying…');
      }
    },

    onEvent(event) {
      handleEvent(event);
    },

    onSamples(blocks) {
      traces.ingest(blocks);
    },

    onSubscribed(metas) {
      traces.applyMeta(metas);
    },

    onError(message, code) {
      // A stale UI against a newer backend is worth a loud, persistent message.
      const level: NotificationLevel = code === 'frame_decode' ? 'error' : 'warning';
      useSession.getState().notify(level, message);
    },
  });

  realtime.connect();
}

function handleEvent(event: ViewerEvent): void {
  const session = useSession.getState();

  switch (event.type) {
    case 'tree.changed':
      void session.refreshTree({ silent: true });
      return;

    case 'notification': {
      const payload = event.payload as unknown as NotificationPayload;
      const entry: LogEntry = {
        id: nextId++,
        level: payload.level,
        message: payload.message,
        detail: payload.detail,
        source: payload.source,
        componentId: payload.componentId,
        at: event.at,
      };
      // The backend replays recent notifications to a page that has just
      // connected. Those belong in the log; only news interrupts.
      const fresh = Date.now() / 1000 - event.at < 10;
      useSession.setState((state) => ({
        log: [entry, ...state.log].slice(0, LOG_LIMIT),
        unreadLog: state.unreadLog + (payload.level === 'error' || payload.level === 'warning' ? 1 : 0),
        // Only problems interrupt; routine backend chatter stays in the log.
        toasts:
          fresh && (payload.level === 'error' || payload.level === 'warning')
            ? [
                {
                  id: entry.id,
                  level: payload.level,
                  message: payload.message,
                  detail: payload.detail,
                  at: entry.at,
                  transient: payload.level !== 'error',
                },
                ...state.toasts,
              ].slice(0, TOAST_LIMIT)
            : state.toasts,
      }));
      return;
    }

    case 'component.propertyChanged':
    case 'component.attributeChanged':
    case 'component.statusChanged':
    case 'component.updated': {
      // Only refresh when the change touches what is on screen; another client
      // editing a device we are not looking at should cost us nothing.
      const { componentId, attribute } = event.payload as { componentId?: string; attribute?: string };
      // Whether a component is active is drawn in the tree (and decides whether
      // its signals deliver), so a change made anywhere else refreshes it.
      if (event.type === 'component.attributeChanged' && attribute === 'Active') {
        void useSession.getState().refreshTree({ silent: true });
      }
      const { selectedId } = useSession.getState();
      if (componentId && selectedId && componentId.startsWith(selectedId)) {
        void useSession.getState().refreshDetail({ silent: true });
      }
      return;
    }

    case 'device.connectionStatusChanged':
      void useSession.getState().refreshTree({ silent: true });
      return;

    default:
      // Unknown event types are ignored: a newer backend may emit more of them,
      // and that must not break an older UI.
      return;
  }
}
