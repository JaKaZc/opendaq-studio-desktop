/**
 * The wire contract with the openDAQ engine.
 *
 * These types mirror the JSON the engine's routes write
 * (`engine/src/routes/`), which `docs/API.md` documents.
 * When you change a payload there, change it here; the type checker then
 * points at every call site that has to follow.
 */

/** Wire names for openDAQ core types (see `daq/coretypes.py`). */
export type CoreTypeName =
  | 'bool'
  | 'int'
  | 'float'
  | 'string'
  | 'list'
  | 'dict'
  | 'ratio'
  | 'proc'
  | 'object'
  | 'binary'
  | 'func'
  | 'complex'
  | 'struct'
  | 'enumeration'
  | 'undefined';

export interface UnitInfo {
  id: number | null;
  symbol: string;
  name: string;
  quantity: string;
}

export interface StructValue {
  kind: 'struct';
  typeName: string | null;
  fieldNames: string[];
  fields: Record<string, DaqValue>;
}

export interface EnumerationValue {
  kind: 'enumeration';
  name: string;
  value: number | null;
  typeName: string | null;
  enumerators: string[];
}

export interface RatioValue {
  kind: 'ratio';
  numerator: number;
  denominator: number;
  value: number | null;
}

export interface ComplexValue {
  kind: 'complex';
  real: number | null;
  imaginary: number | null;
}

export interface ObjectValue {
  kind: 'object';
  className?: string | null;
}

export interface OpaqueValue {
  kind: 'binary' | 'callable' | 'truncated';
  [extra: string]: unknown;
}

/** Any value that can come back from openDAQ, reduced to JSON. */
export type DaqValue =
  | null
  | boolean
  | number
  | string
  | DaqValue[]
  | StructValue
  | EnumerationValue
  | RatioValue
  | ComplexValue
  | ObjectValue
  | OpaqueValue
  | { [key: string]: DaqValue };

// --------------------------------------------------------------------------- components

export type ComponentKind =
  | 'instance'
  | 'device'
  | 'channel'
  | 'functionBlock'
  | 'recorder'
  | 'signal'
  | 'inputPort'
  | 'server'
  | 'syncComponent'
  | 'folder'
  | 'component';

export type StatusLevel = 'ok' | 'warning' | 'error' | 'none';

export interface StatusEntry {
  value: DaqValue;
  message: string;
}

export interface StatusSummary {
  level: StatusLevel;
  message: string | null;
  statuses: Record<string, StatusEntry>;
}

export type OperationMode = 'Unknown' | 'Idle' | 'Operation' | 'SafeOperation';

export interface DeviceFacet {
  locked: boolean;
  connected: boolean;
  operationMode: OperationMode | null;
  availableOperationModes: OperationMode[];
  hasFunctionBlockTypes: boolean;
  isRoot: boolean;
}

export interface FunctionBlockFacet {
  isRecorder: boolean;
  isRecording: boolean | null;
  hasFunctionBlockTypes: boolean;
  inputPortCount: number;
  typeId: string | null;
  typeName: string | null;
  /**
   * Whether this viewer has a module that can build this type.
   *
   * `false` means the device holds a function block whose module lives only on
   * the device — it is shown, but this viewer cannot configure it and could not
   * have connected over a configuration protocol. `null` means the question does
   * not apply: channels arrive as part of the device's IO tree and work
   * regardless of whether their type is known here.
   */
  moduleAvailable: boolean | null;
}

export interface SignalFacet {
  public: boolean;
  streamed: boolean;
  domainSignalId: string | null;
  hasDescriptor: boolean;
}

export interface InputPortFacet {
  requiresSignal: boolean;
  signalId: string | null;
  signalName: string | null;
}

export interface ServerFacet {
  typeId: string | null;
}

export interface ComponentNode {
  id: string;
  localId: string;
  name: string;
  displayName: string;
  description: string;
  kind: ComponentKind;
  parentId: string | null;
  active: boolean;
  parentActive: boolean;
  visible: boolean;
  updating: boolean;
  tags: string[];
  lockedAttributes: string[];
  isDefaultFolder: boolean;
  isCustomComponent?: boolean;
  status: StatusSummary;
  children: ComponentNode[];
  device?: DeviceFacet;
  functionBlock?: FunctionBlockFacet;
  signal?: SignalFacet;
  inputPort?: InputPortFacet;
  server?: ServerFacet;
}

export interface TreeResponse {
  root: ComponentNode;
  includeHidden: boolean;
}

export interface AttributeEntry {
  key: string;
  label: string;
  value: DaqValue;
  valueType: 'string' | 'bool' | 'list';
  locked: boolean;
}

// --------------------------------------------------------------------------- properties

export interface SelectionOption {
  key: DaqValue;
  label: string;
}

export interface CallableInfo {
  returnType: CoreTypeName;
  arguments: { name: string; type: CoreTypeName }[];
}

export interface PropertyNode {
  name: string;
  path: string[];
  description: string;
  valueType: CoreTypeName;
  itemType: CoreTypeName;
  keyType: CoreTypeName;
  readOnly: boolean;
  visible: boolean;
  isReferenced: boolean;
  unit: UnitInfo | null;
  minValue: number | null;
  maxValue: number | null;
  defaultValue: DaqValue;
  suggestedValues: DaqValue;
  selectionValues: SelectionOption[] | null;
  hasCoercer: boolean;
  hasValidator: boolean;
  callable: CallableInfo | null;
  structTypeName: string | null;
  value: DaqValue;
  displayValue: string | null;
  selectionKey: DaqValue;
  children: PropertyNode[] | null;
  error: string | null;
  /** Present only on the Metadata dialog's response. */
  metadata?: Record<string, DaqValue>;
}

export interface PropertyTree {
  componentId: string;
  className: string | null;
  updating: boolean;
  properties: PropertyNode[];
}

export interface MetadataField {
  key: string;
  label: string;
}

export interface ExecuteResult {
  name: string;
  path: string[];
  returned: boolean;
  result: DaqValue;
}

// --------------------------------------------------------------------------- signals

export interface Ratio {
  numerator: number;
  denominator: number;
}

export interface ValueRange {
  low: number | null;
  high: number | null;
}

export interface DataRule {
  type: string | null;
  parameters: Record<string, DaqValue>;
}

export interface DimensionInfo {
  name: string;
  size: number | null;
  unit: UnitInfo | null;
  rule: DataRule | null;
}

export interface DataDescriptor {
  name: string;
  sampleType: string | null;
  unit: UnitInfo | null;
  valueRange: ValueRange | null;
  rule: DataRule | null;
  origin: string;
  tickResolution: Ratio | null;
  dimensions: DimensionInfo[];
  structFieldCount: number;
  structFieldNames: string[];
  metadata: Record<string, DaqValue>;
  postScaling: string | null;
  referenceDomainInfo: Record<string, DaqValue> | null;
}

export type LastValueKind = 'none' | 'number' | 'bool' | 'string' | 'struct' | 'timestamp' | 'other';

export interface LastValue {
  id: string;
  value: DaqValue;
  displayValue: string | null;
  timestamp: string | null;
  kind: LastValueKind;
  error: string | null;
}

export interface SignalInfo {
  id: string;
  localId: string;
  name: string;
  description: string;
  parentId: string | null;
  deviceId: string | null;
  active: boolean;
  public: boolean;
  visible: boolean;
  streamed: boolean;
  domainSignalId: string | null;
  domainSignalName: string | null;
  unit: UnitInfo | null;
  sampleType: string | null;
  sampleRate: number | null;
  chartable: boolean;
  /** One number per sample, a one-dimensional array per sample (an FFT spectrum), or neither. */
  shape?: 'scalar' | 'array' | 'other';
  /**
   * The picture format of an image signal, such as a phone's camera, or null.
   * openDAQ's video convention: sample type Binary, one picture per sample, the
   * format as the unit's symbol.
   */
  image?: string | null;
  /** The picture size of an image signal, where the device gives it. */
  imageSize?: { width: number; height: number } | null;
  timeDomain: boolean;
  relatedSignalIds: string[];
  descriptor?: DataDescriptor | null;
  domainDescriptor?: DataDescriptor | null;
  lastValue?: LastValue;
  /** Added by the input-port candidate endpoint. */
  local?: boolean;
}

// --------------------------------------------------------------------------- detail

export interface InputPortInfo {
  id: string;
  name: string;
  localId: string;
  description: string;
  active: boolean;
  visible: boolean;
  requiresSignal: boolean;
  signalId: string | null;
  signalName: string | null;
}

export interface ComponentDetail {
  node: ComponentNode;
  attributes: AttributeEntry[];
  properties: PropertyTree;
  inputPorts: InputPortInfo[];
  signals: SignalInfo[];
}

// --------------------------------------------------------------------------- topology

export type ComponentTypeKind = 'device' | 'functionBlock' | 'server' | 'streaming';

export interface ComponentTypeInfo {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: ComponentTypeKind;
  connectionStringPrefix: string | null;
  moduleId?: string;
  defaultConfig?: PropertyTree | null;
}

export interface ServerCapability {
  protocolId: string;
  protocolName: string;
  connectionString: string;
  connectionType: string;
  protocolType: string;
  addresses: Record<string, string>;
}

export interface DiscoveredDevice {
  /** This viewer's own server. Connecting to it over a configuration protocol
   *  makes the instance mirror itself until the process dies. */
  isSelf?: boolean;
  selfReason?: string;
  name: string;
  connectionString: string;
  location: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  deviceClass: string;
  deviceType: string | null;
  sdkVersion: string;
  macAddress: string;
  serverCapabilities: ServerCapability[];
  properties?: Record<string, DaqValue>;
}

export interface ConnectionPlan {
  connectionString: string;
  impliedProtocol: string | null;
  discoverable: boolean;
  deviceInfo: DiscoveredDevice | null;
  serverCapabilities: ServerCapability[];
  hasStreaming: boolean;
  hasTcpIp: boolean;
  configProtocols: string[];
  streamingProtocols: string[];
  addressTypes: string[];
  generalWidgetKeys: string[];
  config: PropertyTree;
  errors: string[];
}

export interface AddResult {
  componentId: string;
  name: string;
  typeId?: string;
  connectionString?: string;
  parentId?: string;
  ignoredConfigKeys: string[];
}

export interface ServerInfo {
  componentId: string;
  name: string;
  typeId: string;
  active: boolean;
}

// --------------------------------------------------------------------------- modules

export interface ModuleInfo {
  id: string;
  name: string;
  version: string | null;
  branch: string | null;
  hash: string | null;
  isDevelopment: boolean;
  typeCounts: Record<ComponentTypeKind, number>;
  types: Record<ComponentTypeKind, ComponentTypeInfo[]>;
}

// --------------------------------------------------------------------------- configuration

export type DeviceUpdateMode = 'Load' | 'Skip' | 'Remap' | 'Remove' | 'UpdateOnly';

export interface DeviceUpdateOption {
  path: string[];
  localId: string;
  manufacturer: string;
  serialNumber: string;
  connectionString: string;
  newManufacturer: string;
  newSerialNumber: string;
  newConnectionString: string;
  updateMode: DeviceUpdateMode;
  children: DeviceUpdateOption[];
}

export interface ConfigurationInspection {
  summary: {
    deviceCount: number;
    functionBlockCount: number;
    serverCount: number;
    devices: string[];
    functionBlocks: string[];
    servers: string[];
    sizeBytes: number;
  };
  parameters: PropertyTree;
  deviceOptions: DeviceUpdateOption[];
  updateModes: DeviceUpdateMode[];
}

export interface SavedConfiguration {
  content: string;
  sizeBytes: number;
  suggestedFilename: string;
}

// --------------------------------------------------------------------------- system

export interface VersionInfo {
  app: string;
  appVersion: string;
  apiVersion: string;
  sdkVersion: string | null;
  platform: string;
}

export interface InstanceInfo {
  id: string;
  name: string;
  app: string;
  appVersion: string;
  apiVersion: string;
  sdkVersion: string | null;
  readOnly: boolean;
  allowShutdown: boolean;
  discoveryServers: string[];
  modulePaths: string[];
  streaming: {
    maxPointsPerFrame: number;
    bufferSamples: number;
    frameIntervalSeconds: number;
  };
  startedAt: number;
}

export interface LoopStats {
  uptimeSeconds: number;
  iterations: number;
  workItems: number;
  errors: number;
  lastError: string | null;
  loopMsAvg: number;
  loopMsMax: number;
}

export interface StreamStats {
  signalId: string;
  name: string;
  subscribers: number;
  totalSamples: number;
  samplesPerSecond: number;
  bufferedSamples: number;
  bufferCapacity: number;
  droppedReads: number;
  ended: boolean;
  lastError: string | null;
  epoch: number;
}

export interface Diagnostics {
  loop: LoopStats;
  streaming: {
    streams: StreamStats[];
    clients: Record<string, { paused: boolean; signals: string[] }>;
    totalSamplesPerSecond: number;
  };
  eventSubscribers: number;
  sdk: {
    version: string | null;
    trackedObjects: number | null;
    moduleCount: number;
    capabilities?: Record<string, boolean | string | null>;
  };
  process: { pid: number; platform: string; uptimeSeconds: number };
  settings: {
    streamInterval: number;
    readOnly: boolean;
  };
}

// --------------------------------------------------------------------------- logs

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'critical';

export interface LogEntry {
  /** Monotonic within a run; used to fetch only what has not been seen. */
  seq: number;
  at: number;
  level: LogLevel;
  /** `viewer` is this backend's own logging, `sdk` is openDAQ's. */
  source: 'viewer' | 'sdk';
  origin: string;
  message: string;
}

export interface LogResponse {
  entries: LogEntry[];
  levels: LogLevel[];
  captured: number;
  viewerLevel: LogLevel;
  sdkLevel: LogLevel;
  sdkLogPath: string | null;
}

export interface LogLevelResult {
  viewerLevel: LogLevel;
  sdkLevel: LogLevel;
  /** openDAQ fixes its component levels at start-up, so its change waits. */
  restartRequired: boolean;
}

// --------------------------------------------------------------------------- topology graph

/** What a node in the topology diagram is. Input ports are not nodes: they are
 *  ports drawn on the function block that owns them. */
export type GraphNodeKind =
  | 'instance'
  | 'device'
  | 'channel'
  | 'functionBlock'
  | 'recorder'
  | 'signal'
  | 'server'
  /** The diagram's stand-in block for the signals a device produces itself. */
  | 'deviceSignals';

/**
 * The relations openDAQ actually reports, each drawn differently:
 * `produces` who owns an output signal, `signal` a connection into an input
 * port, `domain` what timestamps a signal, `contains`/`publishes` hierarchy.
 */
export type GraphEdgeKind = 'signal' | 'produces' | 'domain' | 'contains' | 'publishes';

export interface GraphPort {
  id: string;
  name: string;
  requiresSignal: boolean;
  signalId: string | null;
}

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  name: string;
  groupId: string | null;
  active: boolean;
  status: { level: StatusLevel; statuses: Record<string, StatusEntry> } | null;
  /** Input ports, on function blocks and channels. */
  ports?: GraphPort[];
  detail: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  /** The input port's name, on a `signal` edge. */
  label: string;
}

export interface GraphGroup {
  id: string;
  name: string;
  parentId: string | null;
  kind: 'instance' | 'device';
}

export interface TopologyGraph {
  instanceId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
  stats: {
    nodes: number;
    edges: number;
    byKind: Record<string, number>;
    connections: number;
  };
}

// --------------------------------------------------------------------------- realtime

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface ViewerEvent<P = Record<string, unknown>> {
  type: string;
  seq: number;
  at: number;
  payload: P;
}

export interface NotificationPayload {
  level: NotificationLevel;
  message: string;
  detail: string | null;
  source: string;
  componentId: string | null;
}

export interface StreamMetaWire {
  signalId: string;
  name: string;
  unit: string | null;
  sampleType: string | null;
  sampleRate: number | null;
  tickResolution: Ratio;
  epochOffset: number;
  valueRange: ValueRange | null;
  timeDomain: boolean;
}

export type SampleBlockMode = 'raw' | 'minmax' | 'reset';

export interface SampleBlock {
  signalId: string;
  mode: SampleBlockMode;
  reset: boolean;
  epoch: number;
  /** Absolute epoch seconds of the first sample. Absent on a bare reset block. */
  startTime?: number;
  /** Seconds between samples, in `raw` mode. */
  sampleInterval?: number;
  /** Seconds covered by one min/max pair, in `minmax` mode. */
  bucketSeconds?: number;
  buckets?: number;
  count: number;
  byteOffset: number;
  byteLength: number;
  ended: boolean;
}

export interface SampleFrame {
  type: 'samples';
  sentAt: number;
  blocks: SampleBlock[];
}

// --------------------------------------------------------------------------- errors

export interface ApiErrorPayload {
  code: string;
  message: string;
  detail?: string;
  [extra: string]: unknown;
}

// --------------------------------------------------------------------------- function block fit

/** `GET /api/signals/function-block-fit`: whether each block type works on a signal. */
export interface FunctionBlockFit {
  id: string;
  name: string;
  description: string;
  works: boolean;
  /** The block's own status message when it does not work. */
  reason: string | null;
  outputs: { name: string; shape: 'scalar' | 'array' | 'other' }[];
}
