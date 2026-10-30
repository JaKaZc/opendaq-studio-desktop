/**
 * The native openDAQ engine, from the main process's side.
 *
 * The engine itself runs in a utility process (`engine-host.ts`). Here it is
 * started, its answers are matched to the requests that asked, and each
 * window is given a message port of its own for live data and events.
 */

import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HostReply, HostRequest } from './engine-host';

export interface EngineOptions {
  /** Directory holding the packaged application's resources. */
  resourcesPath: string;
  /** Repository root, used only in development. */
  projectRoot: string;
  development: boolean;
  onLog?: (line: string) => void;
}

export interface ApiAnswer {
  status: number;
  body: string;
}

export interface PictureAnswer {
  data: ArrayBuffer | null;
  sequence: number;
  /** The type the signal's format names, for pictures whose bytes do not tell. */
  mediaType?: string;
  /** A refusal, with its status and JSON body. */
  status?: number;
  body?: string;
}

export interface RunningEngine {
  /** One API request: the route, its query as JSON, and the body's text. */
  request: (method: string, path: string, query: Record<string, unknown>, body: string) => Promise<ApiAnswer>;
  /** The newest picture of an image signal, if newer than `after`. */
  picture: (signalId: string, after: number) => Promise<PictureAnswer>;
  /** Gives a window its port for live data and events. */
  attach: (contents: WebContents) => void;
  stop: () => Promise<void>;
}

/** The folder name the engine's build gives this platform. */
function platformFolder(): string {
  const machine = process.arch === 'x64' ? 'x86_64' : process.arch;
  const system = process.platform === 'win32' ? 'windows' : process.platform;
  return `${system}-${machine}`;
}

/** Where the engine, its addon, the SDK and the modules are. */
export function findEngine(resourcesPath: string, projectRoot: string): string | null {
  const packaged = join(resourcesPath, 'engine');
  if (existsSync(join(packaged, 'studio_engine.node'))) return packaged;
  const built = join(projectRoot, 'engine', 'dist', platformFolder());
  if (existsSync(join(built, 'studio_engine.node'))) return built;
  return null;
}

export async function startEngine(options: EngineOptions): Promise<RunningEngine> {
  const { resourcesPath, projectRoot, onLog } = options;
  const engineDir = findEngine(resourcesPath, projectRoot);
  if (!engineDir) {
    throw new Error(
      'The openDAQ engine is missing from this installation. ' +
        'Build it with engine/tool/build_desktop.sh, or reinstall the application.',
    );
  }

  const host: UtilityProcess = utilityProcess.fork(join(__dirname, 'engine-host.js'), [], {
    serviceName: 'openDAQ engine',
    stdio: 'pipe',
  });
  host.stdout?.on('data', (chunk: Buffer) => onLog?.(chunk.toString().trimEnd()));
  host.stderr?.on('data', (chunk: Buffer) => onLog?.(chunk.toString().trimEnd()));

  let nextId = 1;
  const pending = new Map<number, (reply: HostReply) => void>();
  let started: ((reply: HostReply) => void) | null = null;
  let stopped: (() => void) | null = null;
  let exited = false;

  host.on('message', (reply: HostReply) => {
    if (reply.type === 'started') {
      started?.(reply);
      return;
    }
    if (reply.type === 'stopped') {
      stopped?.();
      return;
    }
    const resolve = pending.get(reply.id);
    if (resolve) {
      pending.delete(reply.id);
      resolve(reply);
    }
  });

  const failAll = (status: number, message: string) => {
    for (const [id, resolve] of pending) {
      resolve({ type: 'response', id, status, body: JSON.stringify({ code: 'offline', message }) });
    }
    pending.clear();
  };

  host.once('exit', (code) => {
    exited = true;
    onLog?.(`the openDAQ engine stopped (code ${code})`);
    failAll(503, 'The openDAQ engine stopped');
    started?.({ type: 'started', ok: false, error: `the engine process exited (code ${code})` });
    stopped?.();
  });

  const send = (message: HostRequest, transfer: Electron.MessagePortMain[] = []) => {
    if (!exited) host.postMessage(message, transfer);
  };

  await new Promise<void>((resolve) => host.once('spawn', () => resolve()));
  onLog?.(`starting the openDAQ engine from ${engineDir}`);
  const result = await new Promise<HostReply>((resolve) => {
    started = resolve;
    send({
      type: 'start',
      engineDir,
      options: { moduleDirectory: join(engineDir, 'modules'), streamInterval: 0.05, maxPoints: 4000 },
      streamInterval: 0.05,
      maxPoints: 4000,
    });
  });
  started = null;
  if (result.type !== 'started' || !result.ok) {
    host.kill();
    throw new Error(`the openDAQ engine did not start: ${result.type === 'started' ? result.error : 'no answer'}`);
  }

  const request = (method: string, path: string, query: Record<string, unknown>, body: string) =>
    new Promise<ApiAnswer>((resolve) => {
      if (exited) {
        resolve({ status: 503, body: JSON.stringify({ code: 'offline', message: 'The openDAQ engine stopped' }) });
        return;
      }
      const id = nextId++;
      pending.set(id, (reply) => resolve(reply.type === 'response' ? { status: reply.status, body: reply.body } : { status: 500, body: '{}' }));
      send({ type: 'request', id, method, path, query, body });
    });

  const picture = (signalId: string, after: number) =>
    new Promise<PictureAnswer>((resolve) => {
      if (exited) {
        resolve({ data: null, sequence: after });
        return;
      }
      const id = nextId++;
      pending.set(id, (reply) =>
        resolve(
          reply.type === 'picture'
            ? { data: reply.data, sequence: reply.sequence, mediaType: reply.mediaType, status: reply.status, body: reply.body }
            : { data: null, sequence: after },
        ),
      );
      send({ type: 'picture', id, signalId, after });
    });

  const attach = (contents: WebContents) => {
    const { port1, port2 } = new MessageChannelMain();
    send({ type: 'window' }, [port2]);
    contents.postMessage('realtime-port', null, [port1]);
  };

  const stop = async () => {
    if (exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        host.kill();
        resolve();
      }, 5000);
      stopped = () => {
        clearTimeout(timer);
        resolve();
      };
      send({ type: 'stop' });
    });
    host.kill();
  };

  return { request, picture, attach, stop };
}
