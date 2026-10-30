/**
 * Typed client for the viewer backend.
 *
 * Two conventions worth knowing:
 *
 * - Component ids are openDAQ global ids (`/openDAQDevice/Dev/RefDev0`).  They
 *   contain slashes and may contain spaces, so they always travel as the `id`
 *   query parameter, never as a path segment.
 * - Every failure arrives as a structured `{code, message, detail}` body, which
 *   this module turns into an {@link ApiError}.  UI code can therefore show
 *   `error.message` directly and branch on `error.code` when it needs to.
 */

import type { DeviceTime, TimeMaster } from './timeSync';
import type { FleetDevice } from './fleet';
import type {
  AddResult,
  ApiErrorPayload,
  AttributeEntry,
  ComponentDetail,
  ComponentTypeInfo,
  ComponentTypeKind,
  ConfigurationInspection,
  ConnectionPlan,
  DaqValue,
  DataDescriptor,
  Diagnostics,
  DiscoveredDevice,
  DeviceUpdateMode,
  ExecuteResult,
  InputPortInfo,
  InstanceInfo,
  LastValue,
  LogLevel,
  LogLevelResult,
  LogResponse,
  MetadataField,
  ModuleInfo,
  OperationMode,
  PropertyNode,
  PropertyTree,
  SavedConfiguration,
  ServerInfo,
  SignalInfo,
  StatusSummary,
  TopologyGraph,
  TreeResponse,
  ViewerEvent,
  VersionInfo,
  FunctionBlockFit,
} from './types';

/** Base URL for the API. Empty means "same origin", which is the normal case. */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: string;
  readonly payload: ApiErrorPayload | null;

  constructor(status: number, payload: ApiErrorPayload | null, fallback: string) {
    super(payload?.message ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.code ?? 'http_error';
    this.detail = payload?.detail;
    this.payload = payload;
  }

  /** True when the instance refused the write rather than failing at it. */
  get isReadOnly(): boolean {
    return this.code === 'read_only';
  }

  get isNotFound(): boolean {
    return this.code === 'not_found' || this.status === 404;
  }

  /** A single line suitable for a toast. */
  get summary(): string {
    return this.detail ? `${this.message}: ${this.detail}` : this.message;
  }
}

type QueryValue = string | number | boolean | null | undefined | readonly string[];

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      // Repeated parameters, which is how FastAPI reads a List[str] query.
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const search = params.toString();
  return search ? `${url}?${search}` : url;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, signal } = options;
  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    // fetch only rejects when the request never reached the server.
    throw new ApiError(0, { code: 'offline', message: 'Cannot reach the openDAQ Studio backend' }, 'Network error');
  }

  if (!response.ok) {
    let payload: ApiErrorPayload | null = null;
    try {
      const parsed = (await response.json()) as unknown;
      if (parsed && typeof parsed === 'object') {
        const candidate = parsed as Record<string, unknown>;
        if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
          payload = candidate as unknown as ApiErrorPayload;
        } else if (candidate.detail !== undefined) {
          // FastAPI's own validation errors use {detail: ...}.
          payload = {
            code: response.status === 422 ? 'invalid_request' : 'http_error',
            message: response.status === 422 ? 'The request was rejected as invalid' : response.statusText,
            detail: typeof candidate.detail === 'string' ? candidate.detail : JSON.stringify(candidate.detail),
          };
        }
      }
    } catch {
      // A non-JSON error body (a proxy page, say) leaves payload null.
    }
    throw new ApiError(response.status, payload, `${response.status} ${response.statusText}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// --------------------------------------------------------------------------- system

export const system = {
  version: (signal?: AbortSignal) => request<VersionInfo>('/api/system/version', { signal }),
  info: (signal?: AbortSignal) => request<InstanceInfo>('/api/system/info', { signal }),
  health: (signal?: AbortSignal) =>
    request<{ status: string; ready: boolean; uptimeSeconds: number }>('/api/system/health', { signal }),
  diagnostics: (signal?: AbortSignal) => request<Diagnostics>('/api/system/diagnostics', { signal }),
  events: (limit = 100, signal?: AbortSignal) =>
    request<{ events: ViewerEvent[] }>('/api/system/events', { query: { limit }, signal }),
  shutdown: () => request<{ ok: boolean }>('/api/system/shutdown', { method: 'POST' }),

  /**
   * Log records from the viewer and the SDK, merged.
   *
   * `since` is the sequence number of the newest record already held, so polling
   * asks for what is new rather than re-reading the whole window.
   */
  logs: (
    options: { limit?: number; level?: LogLevel; source?: 'viewer' | 'sdk'; search?: string; since?: number } = {},
    signal?: AbortSignal,
  ) =>
    request<LogResponse>('/api/system/logs', {
      query: {
        limit: options.limit ?? 500,
        level: options.level ?? 'info',
        source: options.source,
        search: options.search,
        since: options.since ?? 0,
      },
      signal,
    }),

  setLogLevel: (levels: { viewer?: LogLevel; sdk?: LogLevel }) =>
    request<LogLevelResult>('/api/system/logs/level', { method: 'PUT', body: levels }),

};

// --------------------------------------------------------------------------- components

export const components = {
  tree: (includeHidden: boolean, signal?: AbortSignal) =>
    request<TreeResponse>('/api/components/tree', { query: { includeHidden }, signal }),

  detail: (id: string, includeHidden: boolean, signal?: AbortSignal) =>
    request<ComponentDetail>('/api/components/detail', { query: { id, includeHidden }, signal }),

  attributes: (id: string, signal?: AbortSignal) =>
    request<{ componentId: string; attributes: AttributeEntry[] }>('/api/components/attributes', {
      query: { id },
      signal,
    }),

  setAttribute: (id: string, key: string, value: DaqValue) =>
    request<{ componentId: string; attributes: AttributeEntry[] }>('/api/components/attributes', {
      method: 'PUT',
      query: { id },
      body: { key, value },
    }),

  setActive: (id: string, active: boolean) =>
    request<{ componentId: string; active: boolean }>('/api/components/active', {
      method: 'PUT',
      query: { id },
      body: { active },
    }),

  statuses: (id: string, signal?: AbortSignal) =>
    request<StatusSummary & { componentId: string }>('/api/components/statuses', { query: { id }, signal }),

  metadataFields: (signal?: AbortSignal) =>
    request<{ fields: MetadataField[] }>('/api/components/metadata-fields', { signal }),

  beginUpdate: (id: string) =>
    request<{ ok: boolean }>('/api/components/begin-update', { method: 'POST', query: { id } }),

  endUpdate: (id: string) =>
    request<{ ok: boolean }>('/api/components/end-update', { method: 'POST', query: { id } }),

  clearProperties: (id: string) =>
    request<{ ok: boolean }>('/api/components/clear-properties', { method: 'POST', query: { id } }),
};

// --------------------------------------------------------------------------- properties

export const properties = {
  list: (id: string, includeHidden: boolean, signal?: AbortSignal) =>
    request<PropertyTree>('/api/properties', { query: { id, includeHidden }, signal }),

  read: (id: string, path: string[]) =>
    request<PropertyNode>('/api/properties/read', { method: 'POST', query: { id }, body: { path } }),

  metadata: (id: string, path: string[]) =>
    request<PropertyNode>('/api/properties/metadata', { method: 'POST', query: { id }, body: { path } }),

  setValue: (id: string, path: string[], value: DaqValue) =>
    request<PropertyNode>('/api/properties/value', { method: 'PUT', query: { id }, body: { path, value } }),

  setStructField: (id: string, path: string[], field: string, value: DaqValue) =>
    request<PropertyNode>('/api/properties/struct-field', {
      method: 'PUT',
      query: { id },
      body: { path, field, value },
    }),

  setContainer: (id: string, path: string[], items: DaqValue) =>
    request<PropertyNode>('/api/properties/container', {
      method: 'PUT',
      query: { id },
      body: { path, items },
    }),

  clear: (id: string, path: string[]) =>
    request<PropertyNode>('/api/properties/clear', { method: 'POST', query: { id }, body: { path } }),

  execute: (id: string, path: string[], args: DaqValue[] = []) =>
    request<ExecuteResult>('/api/properties/execute', {
      method: 'POST',
      query: { id },
      body: { path, arguments: args },
    }),
};


// --------------------------------------------------------------------------- topology

export const topology = {
  /** The whole instance as a dataflow graph, in one request. */
  graph: (includeHidden = false, signal?: AbortSignal) =>
    request<TopologyGraph>('/api/topology/graph', { query: { includeHidden }, signal }),
  /** Every device's synchronization and its clock against this computer's. */
  time: (signal?: AbortSignal) =>
    request<{ devices: DeviceTime[]; master?: TimeMaster; align?: { enabled: boolean } }>('/api/time', { signal }),
  /** Every connected device at a glance, for the Fleet page. */
  fleet: (signal?: AbortSignal) => request<{ devices: FleetDevice[] }>('/api/fleet', { signal }),
  /** Whether each device's samples are shifted by its clock's offset to this computer's, in plots. */
  setTimeAlign: (enabled: boolean) => request<{ enabled: boolean }>('/api/time/align', { method: 'PUT', body: { enabled } }),
  /** Whether Studio points the devices that follow NTP at its own time server. */
  setTimeMaster: (enabled: boolean) => request<TimeMaster>('/api/time/master', { method: 'PUT', body: { enabled } }),

  deviceTypes: (id?: string, signal?: AbortSignal) =>
    request<{ types: ComponentTypeInfo[] }>('/api/device-types', { query: { id }, signal }),

  functionBlockTypes: (id?: string, signal?: AbortSignal) =>
    request<{ hostId: string; types: ComponentTypeInfo[] }>('/api/function-block-types', {
      query: { id },
      signal,
    }),

  serverTypes: (signal?: AbortSignal) =>
    request<{ types: ComponentTypeInfo[] }>('/api/server-types', { signal }),

  streamingTypes: (signal?: AbortSignal) =>
    request<{ types: ComponentTypeInfo[] }>('/api/streaming-types', { signal }),

  typeConfig: (kind: ComponentTypeKind, typeId: string, hostId?: string, signal?: AbortSignal) =>
    request<{
      kind: ComponentTypeKind;
      typeId: string;
      type: ComponentTypeInfo | null;
      config: PropertyTree | null;
    }>('/api/type-config', { query: { kind, typeId, hostId }, signal }),

  /** Runs a real discovery sweep; expect this to take a moment. */
  discover: (id?: string, signal?: AbortSignal) =>
    request<{ parentId: string | null; devices: DiscoveredDevice[] }>('/api/devices/discover', {
      query: { id },
      signal,
    }),

  connectionPlan: (connectionString: string, id?: string, signal?: AbortSignal) =>
    request<ConnectionPlan>('/api/devices/connection-plan', {
      query: { connectionString, id },
      signal,
    }),

  /**
   * Why a connection string does not connect.
   *
   * This one dials: it opens TCP connections to each advertised address and, for
   * configuration protocols, connects and disconnects again. That is what tells a
   * protocol problem apart from a network one, so it is deliberately not run
   * automatically while the user is still typing.
   */

  deviceInfo: (connectionString: string, id?: string, signal?: AbortSignal) =>
    request<DiscoveredDevice>('/api/devices/info', { query: { connectionString, id }, signal }),

  addDevice: (connectionString: string, parentId?: string, config?: Record<string, DaqValue>) =>
    request<AddResult>('/api/devices', {
      method: 'POST',
      body: { connectionString, parentId, config },
    }),

  removeDevice: (id: string) =>
    request<{ removedId: string; parentId: string }>('/api/devices', { method: 'DELETE', query: { id } }),

  setLock: (id: string, locked: boolean, force = false) =>
    request<{ componentId: string; locked: boolean }>('/api/devices/lock', {
      method: 'PUT',
      query: { id },
      body: { locked, force },
    }),

  setOperationMode: (id: string, mode: OperationMode, recursive = false) =>
    request<{ componentId: string; operationMode: string }>('/api/devices/operation-mode', {
      method: 'PUT',
      query: { id },
      body: { mode, recursive },
    }),

  addFunctionBlock: (typeId: string, parentId?: string, config?: Record<string, DaqValue>) =>
    request<AddResult>('/api/function-blocks', { method: 'POST', body: { typeId, parentId, config } }),

  removeFunctionBlock: (id: string) =>
    request<{ removedId: string; parentId: string }>('/api/function-blocks', {
      method: 'DELETE',
      query: { id },
    }),

  setRecording: (id: string, recording: boolean) =>
    request<{ componentId: string; recording: boolean }>('/api/function-blocks/recording', {
      method: 'PUT',
      query: { id },
      body: { recording },
    }),

  servers: (signal?: AbortSignal) =>
    request<{ servers: ServerInfo[] }>('/api/servers', { signal }),

  addServer: (typeId: string, config?: Record<string, DaqValue>) =>
    request<AddResult>('/api/servers', { method: 'POST', body: { typeId, config } }),

  removeServer: (id: string) =>
    request<{ removedId: string }>('/api/servers', { method: 'DELETE', query: { id } }),

  setServerDiscovery: (id: string, enabled: boolean) =>
    request<{ componentId: string; discoveryEnabled: boolean }>('/api/servers/discovery', {
      method: 'PUT',
      query: { id },
      body: { enabled },
    }),

  inputPorts: (id: string, signal?: AbortSignal) =>
    request<{ componentId: string; ports: InputPortInfo[] }>('/api/input-ports', {
      query: { id },
      signal,
    }),

  portCandidates: (id: string, includeHidden: boolean, signal?: AbortSignal) =>
    request<{ componentId: string; signals: SignalInfo[] }>('/api/input-ports/candidates', {
      query: { id, includeHidden },
      signal,
    }),

  connectPort: (id: string, signalId: string | null) =>
    request<{ componentId: string; signalId: string | null }>('/api/input-ports/connection', {
      method: 'PUT',
      query: { id },
      body: { signalId },
    }),
};

// --------------------------------------------------------------------------- signals

export const signals = {
  list: (
    options: {
      id?: string;
      includeHidden?: boolean;
      chartableOnly?: boolean;
      withDescriptor?: boolean;
    } = {},
    signal?: AbortSignal,
  ) =>
    request<{ scopeId: string | null; signals: SignalInfo[] }>('/api/signals', {
      query: {
        id: options.id,
        includeHidden: options.includeHidden ?? false,
        chartableOnly: options.chartableOnly ?? false,
        withDescriptor: options.withDescriptor ?? false,
      },
      signal,
    }),

  detail: (id: string, signal?: AbortSignal) =>
    request<SignalInfo>('/api/signals/detail', { query: { id }, signal }),

  functionBlockFit: (id: string, signal?: AbortSignal) =>
    request<{ signalId: string; types: FunctionBlockFit[] }>('/api/signals/function-block-fit', { query: { id }, signal }),

  descriptor: (id: string, signal?: AbortSignal) =>
    request<{
      signalId: string;
      descriptor: DataDescriptor | null;
      domainDescriptor: DataDescriptor | null;
    }>('/api/signals/descriptor', { query: { id }, signal }),

  lastValues: (ids?: string[], scopeId?: string, includeHidden = false, signal?: AbortSignal) =>
    request<{ at: string; values: LastValue[] }>('/api/signals/last-values', {
      query: { id: ids, scopeId, includeHidden },
      signal,
    }),
};

// --------------------------------------------------------------------------- modules

export const modules = {
  list: (signal?: AbortSignal) => request<{ modules: ModuleInfo[] }>('/api/modules', { signal }),

  type: (moduleId: string, kind: ComponentTypeKind, typeKey: string, signal?: AbortSignal) =>
    request<ComponentTypeInfo>('/api/modules/type', { query: { moduleId, kind, typeKey }, signal }),

  load: (path: string) =>
    request<{ path: string; modules: string[] }>('/api/modules/load', {
      method: 'POST',
      body: { path },
    }),
};

// --------------------------------------------------------------------------- configuration

export const configuration = {
  save: (signal?: AbortSignal) => request<SavedConfiguration>('/api/configuration', { signal }),

  downloadUrl: () => buildUrl('/api/configuration/download'),

  inspect: (content: string) =>
    request<ConfigurationInspection>('/api/configuration/inspect', {
      method: 'POST',
      body: { content },
    }),

  load: (
    content: string,
    parameters?: Record<string, DaqValue>,
    deviceOptions?: Record<string, { updateMode?: DeviceUpdateMode; newConnectionString?: string }>,
  ) =>
    request<{ applied: boolean; ignoredParameterKeys: string[] }>('/api/configuration/load', {
      method: 'POST',
      body: { content, parameters, deviceOptions },
    }),
};

/** WebSocket URL for the realtime channel, derived from the API base. */
export function websocketUrl(): string {
  if (API_BASE) {
    return `${API_BASE.replace(/^http/, 'ws')}/api/ws`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/ws`;
}

export const api = { system, components, properties, topology, signals, modules, configuration };
