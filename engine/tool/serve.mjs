// A development server for the engine: its API over HTTP and its live data
// and events over a /api/ws WebSocket, through the engine's Node addon. It
// serves the engine's API tests (tests/api), and the UI in a browser while
// developing. The desktop app does not use it: there the engine host carries
// the same messages over message ports.
//
//   node tool/serve.mjs --port 8420 [--device daqref://device0 ...] [--ui frontend/dist]

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { WebSocketServer } = require(join(here, '..', 'node', 'node_modules', 'ws'));

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const devices = args.flatMap((arg, i) => (arg === '--device' ? [args[i + 1]] : []));
const port = Number(option('port', '8420'));
const machine = process.arch === 'x64' ? 'x86_64' : process.arch;
const system = process.platform === 'win32' ? 'windows' : process.platform;
const engineDir = option('engine', join(here, '..', 'dist', `${system}-${machine}`));
const ui = option('ui', null);
const streamInterval = Number(option('stream-interval', '0.05'));
const maxPoints = 4000;

const engine = require(join(engineDir, 'studio_engine.node'));
const started = engine.start(JSON.stringify({ moduleDirectory: join(engineDir, 'modules'), devices, streamInterval, maxPoints }));
if (!started.ok) {
  console.error(`the engine did not start: ${started.error}`);
  process.exit(1);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

/** The media type of a picture, from its first bytes, or null. */
function pictureType(data) {
  const head = Buffer.from(data.slice(0, 8));
  if (head.subarray(0, 4).toString() === 'ODPL') return 'application/x-opendaq-plot';
  if (head[0] === 0x89 && head.subarray(1, 4).toString() === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.subarray(0, 2).toString() === 'BM') return 'image/bmp';
  return null;
}

/** The query as the engine takes it: each value a string, a repeated one a list. */
function queryOf(url) {
  const query = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length > 1 ? values : values[0];
  }
  return query;
}

/** The media type each image signal's format names, from the picture route's checks. */
const pictureTypes = new Map();

/** How long a request for a newer picture waits for one, in milliseconds. */
const PICTURE_WAIT = 50;

/**
 * GET /api/signals/picture: the newest picture of an image signal, or 204
 * until a newer one than `after` arrives. A caller that has a picture already
 * waits up to PICTURE_WAIT for a newer one, as in the desktop app. When the
 * engine has none, its picture route says why.
 */
async function servePicture(url, response) {
  const id = url.searchParams.get('id') ?? '';
  const afterText = url.searchParams.get('after') ?? '0';
  const after = /^\s*[+-]?\d+\s*$/.test(afterText) ? Number(afterText) : null;
  let answer = after === null ? { data: null, sequence: 0 } : engine.picture(id, after);
  if (after > 0 && answer.sequence === after) {
    const deadline = performance.now() + PICTURE_WAIT;
    while (answer.sequence === after && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      answer = engine.picture(id, after);
    }
  }
  if (!answer.data && answer.sequence === 0) {
    const check = await engine.request('GET', url.pathname, JSON.stringify(queryOf(url)), '');
    if (check.status !== 200) {
      response.writeHead(check.status, { 'Content-Type': 'application/json' }).end(check.body);
      return;
    }
    pictureTypes.set(id, JSON.parse(check.body).mediaType);
  }
  const headers = { 'X-Picture-Sequence': String(answer.sequence), 'Cache-Control': 'no-store' };
  if (!answer.data || answer.sequence === after) {
    response.writeHead(204, headers).end();
    return;
  }
  const type = pictureType(answer.data) ?? pictureTypes.get(id) ?? 'application/octet-stream';
  response.writeHead(200, { ...headers, 'Content-Type': type }).end(Buffer.from(answer.data));
}

/** The saved configuration comes as a file, named with the moment it was saved. */
function downloadHeaders(method, path, status) {
  if (method !== 'GET' || path !== '/api/configuration/download' || status !== 200) return {};
  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return { 'Content-Disposition': `attachment; filename="opendaq-config-${stamp}.json"` };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    if (request.method === 'GET' && url.pathname === '/api/signals/picture') {
      await servePicture(url, response);
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const answer = await engine.request(request.method, url.pathname, JSON.stringify(queryOf(url)), Buffer.concat(chunks).toString());
    response.writeHead(answer.status, { 'Content-Type': 'application/json', ...downloadHeaders(request.method, url.pathname, answer.status) }).end(answer.body);
    return;
  }
  if (!ui) {
    response.writeHead(404).end();
    return;
  }
  let file = join(ui, normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, ''));
  if (!file.startsWith(ui) || !existsSync(file) || statSync(file).isDirectory()) file = join(ui, 'index.html');
  response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
});

// ------------------------------------------------------------------ realtime, as engine-host.ts

/** How many recent notifications a freshly connected client is given. */
const replayEvents = 40;

/** Whether a message member is set: missing, null, false, 0, "" and empty lists and objects are not. */
function truthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** A message member as a number, or `fallback` when it is not set. */
function number(value, fallback) {
  if (!truthy(value)) return fallback;
  if (typeof value === 'number') return value;
  if (value === true) return 1;
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) return Number(value);
  if (typeof value === 'string') throw new Error(`'${value}' is not a number`);
  throw new Error(`a number was expected, not ${Array.isArray(value) ? 'a list' : 'an object'}`);
}

function error(code, message, extra = {}) {
  return { type: 'error', payload: { code, message, ...extra } };
}

const sockets = new Set();
const wss = new WebSocketServer({ server, path: '/api/ws' });

wss.on('connection', (socket) => {
  // `signals` are the client's subscriptions, in the order they were made.
  const window = { socket, client: engine.clientOpen(), signals: [] };
  sockets.add(window);
  const send = (message) => socket.send(JSON.stringify(message));
  send({
    type: 'hello',
    payload: {
      clientId: `socket-${window.client}`,
      appVersion: '1.0.0',
      apiVersion: '1.0',
      frameIntervalSeconds: streamInterval,
      maxPointsPerFrame: maxPoints,
      readOnly: false,
    },
  });
  // The engine keeps the recent notifications for clients that connect later.
  void engine.request('GET', '/api/system/events', JSON.stringify({ limit: String(replayEvents) }), '').then((answer) => {
    if (answer.status === 200) for (const event of JSON.parse(answer.body).events) send(event);
  });
  socket.on('close', () => {
    sockets.delete(window);
    engine.clientClose(window.client);
  });
  socket.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      send(error('bad_request', 'message is not valid JSON'));
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      send(error('bad_request', 'message must be an object'));
      return;
    }
    const request = message.type ?? undefined;
    try {
      await handle(window, message, send);
    } catch (cause) {
      // One bad message must not drop the socket.
      send(error('internal_error', cause instanceof Error ? cause.message : String(cause), { request }));
    }
  });
});

/** One control message from a client. */
async function handle(window, message, send) {
  const kind = truthy(message.type) ? String(message.type) : '';
  if (kind === 'ping') {
    send({ type: 'pong', payload: { echo: message.payload ?? null } });
    return;
  }
  if (kind === 'subscribe') {
    const ids = Array.isArray(message.signalIds) ? message.signalIds.map(String) : [];
    const pointsPerSecond = number(message.pointsPerSecond, 4000);
    const primeSeconds = number(message.primeSeconds, 1);
    const answer = await engine.clientSubscribe(window.client, JSON.stringify(ids), pointsPerSecond, primeSeconds);
    const body = JSON.parse(answer.body);
    if (answer.status !== 200) {
      const detail = body.detail ? { detail: body.detail } : {};
      send(error(body.code, body.message, { ...detail, request: message.type }));
      return;
    }
    for (const meta of body.signals) if (!window.signals.includes(meta.signalId)) window.signals.push(meta.signalId);
    // The engine's own text, which keeps numbers such as 1000.0 as it wrote them.
    window.socket.send(`{"type":"subscribed","payload":${answer.body}}`);
    return;
  }
  if (kind === 'unsubscribe') {
    const ids = message.signalIds == null ? null : Array.isArray(message.signalIds) ? message.signalIds.map(String) : [];
    engine.clientUnsubscribe(window.client, ids === null ? null : JSON.stringify(ids));
    window.signals = ids === null ? [] : window.signals.filter((id) => !ids.includes(id));
    send({ type: 'unsubscribed', payload: { signals: window.signals } });
    return;
  }
  if (kind === 'resolution') {
    engine.clientResolution(window.client, number(message.pointsPerSecond, 4000));
    return;
  }
  if (kind === 'pause') {
    engine.clientPause(window.client, truthy(message.paused));
    return;
  }
  send(error('bad_request', `unknown message type: ${kind || '(missing)'}`));
}

setInterval(() => {
  for (const window of sockets) {
    const frame = engine.clientPoll(window.client);
    if (frame) window.socket.send(Buffer.from(frame));
  }
}, Math.max(10, streamInterval * 1000));

// The engine numbers and stamps the events. They are drained even with no
// client connected, so a client that connects later does not get a backlog.
setInterval(() => {
  for (const event of JSON.parse(engine.events())) {
    const text = JSON.stringify(event);
    for (const window of sockets) window.socket.send(text);
  }
}, 100);

const stop = () => {
  engine.stop();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

server.listen(port, '127.0.0.1', () => console.log(`openDAQ engine serving on http://127.0.0.1:${port}`));
