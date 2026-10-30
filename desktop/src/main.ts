/**
 * The openDAQ Studio desktop shell.
 *
 * It is deliberately thin: it starts openDAQ, points a window at the UI, and
 * adds the native menu and lifecycle handling a desktop application is
 * expected to have.
 *
 * openDAQ is the native engine (engine/ in this repository) in a utility
 * process. The UI is served from the `studio://app/` scheme, its `/api/...`
 * requests are answered by the engine, and each window gets a message port
 * for live data and events. No network port is opened for either.
 */

import { app, BrowserWindow, dialog, Menu, net, protocol, shell, type MenuItemConstructorOptions } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startEngine, type RunningEngine } from './engine';

const DEVELOPMENT = process.argv.includes('--dev') || !app.isPackaged;

/** The scheme the UI is served from. */
const SCHEME = 'studio';
const APP_URL = `${SCHEME}://app`;

// The scheme has to be known before the app is ready. It behaves like https:
// a secure origin with fetch, so the UI runs unchanged.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let mainWindow: BrowserWindow | null = null;
let engine: RunningEngine | null = null;
let quitting = false;
const logLines: string[] = [];

function log(line: string): void {
  // Kept in memory so a start-up failure can show the user what went wrong,
  // rather than a bare "something failed".
  for (const entry of line.split('\n')) {
    if (entry.trim()) logLines.push(entry);
  }
  if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
  if (DEVELOPMENT) console.log(line);
}

function projectRoot(): string {
  // In development the shell runs from `desktop/`, so the repo is one level up.
  return DEVELOPMENT ? join(app.getAppPath(), '..') : app.getAppPath();
}

/**
 * The openDAQ icon for a run from source. A package carries it in its
 * executable and bundle; `electron .` would otherwise show Electron's own.
 */
function developmentIcon(): string | undefined {
  const icon = join(projectRoot(), 'desktop', 'build', 'icon.png');
  return DEVELOPMENT && existsSync(icon) ? icon : undefined;
}

async function createWindow(url: string): Promise<void> {
  mainWindow = new BrowserWindow({
    icon: developmentIcon(),
    width: 1500,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    title: 'openDAQ Studio',
    // The light theme's surface: the window shows this until the page paints.
    backgroundColor: '#eef2f6',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      // The page is our own UI, but it still gets the standard hardening:
      // no Node in the renderer, context isolated.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Anything that is not our own UI opens in the user's real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(url)) return { action: 'allow' };
    void shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(url);
}

function buildMenu(): void {
  const send = (channel: string) => () => mainWindow?.webContents.send(channel);

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Save configuration…',
          accelerator: 'CmdOrCtrl+S',
          click: send('menu:save-configuration'),
        },
        {
          label: 'Load configuration…',
          accelerator: 'CmdOrCtrl+O',
          click: send('menu:load-configuration'),
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'openDAQ documentation',
          click: () => void shell.openExternal('https://docs.opendaq.com'),
        },
        { type: 'separator' },
        {
          label: 'Show engine log',
          click: () => {
            void dialog.showMessageBox(mainWindow ?? undefined!, {
              type: 'info',
              title: 'Engine log',
              message: 'The openDAQ engine',
              detail: logLines.slice(-40).join('\n') || 'No output yet.',
              buttons: ['Close'],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Where the built UI is: beside the app when packaged, frontend/dist in development. */
function uiRoot(): string {
  const packaged = join(process.resourcesPath, 'ui');
  return existsSync(packaged) ? packaged : join(projectRoot(), 'frontend', 'dist');
}

/**
 * Serves `studio://app/`: files of the built UI, with index.html for the
 * single-page app's own routes, and the API, answered by the engine.
 */
function serveNative(running: RunningEngine): void {
  const root = uiRoot();
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return answerApi(running, request, url);

    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    let file = join(root, relative);
    if (!file.startsWith(root + sep) && file !== root) return new Response('Not found', { status: 404 });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });
}

/** The media type of a picture, from its first bytes, or `fallback`. */
function pictureType(data: ArrayBuffer, fallback: string): string {
  const head = new Uint8Array(data.slice(0, 8));
  if (head[0] === 0x4f && head[1] === 0x44 && head[2] === 0x50 && head[3] === 0x4c) return 'application/x-opendaq-plot';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp';
  return fallback;
}

async function answerApi(running: RunningEngine, request: Request, url: URL): Promise<Response> {
  if (request.method === 'GET' && url.pathname === '/api/signals/picture') {
    const after = Number(url.searchParams.get('after') ?? 0);
    const answer = await running.picture(url.searchParams.get('id') ?? '', after);
    if (answer.status !== undefined) {
      return new Response(answer.body ?? '{}', { status: answer.status, headers: { 'Content-Type': 'application/json' } });
    }
    const headers = { 'X-Picture-Sequence': String(answer.sequence), 'Cache-Control': 'no-store' };
    if (!answer.data || answer.sequence === after) return new Response(null, { status: 204, headers });
    const type = pictureType(answer.data, answer.mediaType ?? 'application/octet-stream');
    return new Response(answer.data, { status: 200, headers: { ...headers, 'Content-Type': type } });
  }

  // A repeated query parameter becomes a list, which the engine's routes read.
  const query: Record<string, unknown> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length > 1 ? values : values[0];
  }
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  const answer = await running.request(request.method, url.pathname, query, body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (request.method === 'GET' && url.pathname === '/api/configuration/download' && answer.status === 200) {
    // The saved configuration comes as a file, named with the moment it was saved.
    const now = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    headers['Content-Disposition'] = `attachment; filename="opendaq-config-${stamp}.json"`;
  }
  return new Response(answer.body, { status: answer.status, headers });
}

async function startup(): Promise<void> {
  const icon = developmentIcon();
  if (icon && process.platform === 'darwin') app.dock?.setIcon(icon);
  let running: RunningEngine;
  try {
    running = await startEngine({
      resourcesPath: process.resourcesPath,
      projectRoot: projectRoot(),
      development: DEVELOPMENT,
      onLog: log,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(message);
    // A window would show nothing useful, so report the failure directly.
    await dialog.showMessageBox({
      type: 'error',
      title: 'openDAQ Studio could not start',
      message: 'The openDAQ engine did not start.',
      detail: `${message}\n\nRecent output:\n${logLines.slice(-15).join('\n')}`,
      buttons: ['Quit'],
    });
    app.exit(1);
    return;
  }

  engine = running;
  serveNative(running);
  // Every window, the main one and the picture windows the UI opens, gets its
  // own port for live data each time its page loads.
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('did-finish-load', () => engine?.attach(window.webContents));
  });
  buildMenu();
  await createWindow(`${APP_URL}/`);
}

// One instance owns the engine; a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(startup);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && engine) void createWindow(`${APP_URL}/`);
  });

  // Stopping openDAQ is asynchronous, so the quit is deferred until it is done.
  app.on('before-quit', (event) => {
    if (quitting || !engine) return;
    event.preventDefault();
    quitting = true;
    void engine.stop().finally(() => {
      engine = null;
      app.quit();
    });
  });
}
