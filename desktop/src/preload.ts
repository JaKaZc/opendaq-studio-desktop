/**
 * Preload bridge.
 *
 * The renderer is the same web UI a browser loads, so it must not gain any
 * privilege here. What is exposed: the native menu's commands, and with the
 * native engine the window's message port for live data and events - no
 * filesystem, no shell, no Node APIs.
 */

import { contextBridge, ipcRenderer } from 'electron';

interface RealtimeHandlers {
  onOpen: () => void;
  onMessage: (data: string | ArrayBuffer) => void;
}

// The engine host's port for this window. It can arrive before the UI asks
// for it, so what it sends meanwhile, such as the hello, is kept.
let port: MessagePort | null = null;
let handlers: RealtimeHandlers | null = null;
const early: Array<string | ArrayBuffer> = [];

ipcRenderer.on('realtime-port', (event) => {
  const received = event.ports[0];
  if (!received) return;
  port?.close();
  port = received;
  port.onmessage = (message: MessageEvent) => {
    const data = message.data as string | ArrayBuffer;
    if (handlers) handlers.onMessage(data);
    else early.push(data);
  };
  port.start();
  handlers?.onOpen();
});

const MENU_CHANNELS = ['menu:save-configuration', 'menu:load-configuration'] as const;

type MenuChannel = (typeof MENU_CHANNELS)[number];

contextBridge.exposeInMainWorld('openDaqDesktop', {
  /** True when the UI is running inside the desktop shell rather than a browser. */
  isDesktop: true,

  /**
   * Subscribe to a native menu command. Returns an unsubscribe function.
   * Unknown channels are rejected so the renderer cannot reach arbitrary IPC.
   */
  onMenuCommand(channel: MenuChannel, handler: () => void): () => void {
    if (!MENU_CHANNELS.includes(channel)) {
      throw new Error(`unknown menu channel: ${channel}`);
    }
    const listener = () => handler();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  /**
   * Live data and events from the engine, in place of a WebSocket: JSON
   * text messages and binary ODQV frames. Present on the app's own `studio:`
   * pages only.
   */
  realtime:
    location.protocol !== 'studio:'
      ? undefined
      : {
          connect(next: RealtimeHandlers): void {
            handlers = next;
            if (!port) return;
            next.onOpen();
            for (const data of early.splice(0)) next.onMessage(data);
          },
          send(text: string): void {
            port?.postMessage(text);
          },
          close(): void {
            handlers = null;
          },
        },
});
