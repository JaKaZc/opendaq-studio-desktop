/**
 * Every mutating operation the UI can perform, in one place.
 *
 * Each action funnels through `session.mutate`, which reports failures as a
 * toast and refreshes whatever the change could have affected.  Destructive
 * actions route through the confirmation dialog unless the user turned that off.
 * Keeping them here rather than inside components means the tree's context menu,
 * the detail panel and the command palette all behave identically.
 */

import { api } from './api';
import type { DaqValue, DeviceUpdateMode, OperationMode } from './types';
import { useDialogs } from '../store/useDialogs';
import { useSession } from '../store/useSession';
import { useSettings } from '../store/useSettings';
import { downloadText } from './utils';

function session() {
  return useSession.getState();
}

/** Run `perform` behind a confirmation, unless confirmations are disabled. */
function guarded(
  request: { title: string; message: string; confirmLabel?: string; destructive?: boolean },
  perform: () => Promise<unknown>,
): void {
  if (!useSettings.getState().confirmDestructive) {
    void perform();
    return;
  }
  useDialogs.getState().requestConfirm({
    title: request.title,
    message: request.message,
    confirmLabel: request.confirmLabel,
    destructive: request.destructive ?? true,
    onConfirm: async () => {
      await perform();
    },
  });
}

export const actions = {
  // ------------------------------------------------------------------ components

  setActive(componentId: string, active: boolean) {
    return session().mutate(() => api.components.setActive(componentId, active), {
      context: 'Could not change the active state',
      refresh: 'both',
    });
  },

  setAttribute(componentId: string, key: string, value: DaqValue) {
    return session().mutate(() => api.components.setAttribute(componentId, key, value), {
      context: `Could not set ${key}`,
      refresh: 'both',
    });
  },

  beginUpdate(componentId: string) {
    return session().mutate(() => api.components.beginUpdate(componentId), {
      context: 'Could not begin the update block',
      refresh: 'both',
    });
  },

  endUpdate(componentId: string) {
    return session().mutate(() => api.components.endUpdate(componentId), {
      context: 'Could not commit the update block',
      refresh: 'both',
    });
  },

  clearProperties(componentId: string, name: string) {
    guarded(
      {
        title: 'Reset all properties?',
        message: `Every property on ${name} goes back to its default value. This cannot be undone.`,
        confirmLabel: 'Reset properties',
      },
      () =>
        session().mutate(() => api.components.clearProperties(componentId), {
          success: `Reset the properties of ${name}`,
          context: 'Could not reset properties',
          refresh: 'both',
        }),
    );
  },

  // ------------------------------------------------------------------ properties

  setProperty(componentId: string, path: string[], value: DaqValue) {
    return session().mutate(() => api.properties.setValue(componentId, path, value), {
      context: `Could not set ${path.join('.')}`,
      refresh: 'detail',
    });
  },

  setStructField(componentId: string, path: string[], field: string, value: DaqValue) {
    return session().mutate(() => api.properties.setStructField(componentId, path, field, value), {
      context: `Could not set ${path.join('.')}.${field}`,
      refresh: 'detail',
    });
  },

  setContainer(componentId: string, path: string[], items: DaqValue) {
    return session().mutate(() => api.properties.setContainer(componentId, path, items), {
      context: `Could not set ${path.join('.')}`,
      refresh: 'detail',
    });
  },

  clearProperty(componentId: string, path: string[]) {
    return session().mutate(() => api.properties.clear(componentId, path), {
      context: `Could not reset ${path.join('.')}`,
      refresh: 'detail',
    });
  },

  // ------------------------------------------------------------------ devices

  async addDevice(connectionString: string, parentId: string | null, config?: Record<string, DaqValue>) {
    const result = await session().mutate(
      () => api.topology.addDevice(connectionString, parentId ?? undefined, config),
      { context: `Could not connect ${connectionString}`, refresh: 'tree' },
    );
    return result;
  },

  removeDevice(componentId: string, name: string) {
    guarded(
      {
        title: 'Disconnect device?',
        message: `${name} and everything under it will be removed from this instance.`,
        confirmLabel: 'Disconnect',
      },
      () =>
        session().mutate(() => api.topology.removeDevice(componentId), {
          success: `Disconnected ${name}`,
          context: 'Could not disconnect the device',
          refresh: 'tree',
        }),
    );
  },

  setLock(componentId: string, locked: boolean) {
    return session().mutate(() => api.topology.setLock(componentId, locked), {
      success: locked ? 'Device locked' : 'Device unlocked',
      context: locked ? 'Could not lock the device' : 'Could not unlock the device',
      refresh: 'both',
    });
  },

  /**
   * Force-unlock a device whose owning client is gone.
   *
   * Always confirmed, regardless of the confirmation preference: taking a lock
   * away from another client can interrupt someone else's measurement.
   */
  forceUnlock(componentId: string, name: string) {
    useDialogs.getState().requestConfirm({
      title: 'Force unlock?',
      message: `${name} is locked by another client. Forcing the unlock takes control away from whoever holds it, which can interrupt an active measurement.`,
      confirmLabel: 'Force unlock',
      destructive: true,
      onConfirm: async () => {
        await session().mutate(() => api.topology.setLock(componentId, false, true), {
          success: `Force-unlocked ${name}`,
          context: 'Could not force-unlock the device',
          refresh: 'both',
        });
      },
    });
  },

  setOperationMode(componentId: string, mode: OperationMode, recursive = false) {
    return session().mutate(() => api.topology.setOperationMode(componentId, mode, recursive), {
      context: 'Could not change the operation mode',
      refresh: 'both',
    });
  },

  // ------------------------------------------------------------------ function blocks

  addFunctionBlock(typeId: string, parentId: string | null, config?: Record<string, DaqValue>) {
    return session().mutate(() => api.topology.addFunctionBlock(typeId, parentId ?? undefined, config), {
      context: `Could not add ${typeId}`,
      refresh: 'tree',
    });
  },

  removeFunctionBlock(componentId: string, name: string) {
    guarded(
      {
        title: 'Remove function block?',
        message: `${name} will be removed, along with any signal connections into it.`,
        confirmLabel: 'Remove',
      },
      () =>
        session().mutate(() => api.topology.removeFunctionBlock(componentId), {
          success: `Removed ${name}`,
          context: 'Could not remove the function block',
          refresh: 'tree',
        }),
    );
  },

  setRecording(componentId: string, recording: boolean) {
    return session().mutate(() => api.topology.setRecording(componentId, recording), {
      success: recording ? 'Recording started' : 'Recording stopped',
      context: recording ? 'Could not start recording' : 'Could not stop recording',
      refresh: 'both',
    });
  },

  // ------------------------------------------------------------------ servers

  addServer(typeId: string, config?: Record<string, DaqValue>) {
    return session().mutate(() => api.topology.addServer(typeId, config), {
      context: `Could not start ${typeId}`,
      refresh: 'tree',
    });
  },

  removeServer(componentId: string, name: string) {
    guarded(
      {
        title: 'Stop server?',
        message: `${name} will stop, and any client connected through it will be disconnected.`,
        confirmLabel: 'Stop server',
      },
      () =>
        session().mutate(() => api.topology.removeServer(componentId), {
          success: `Stopped ${name}`,
          context: 'Could not stop the server',
          refresh: 'tree',
        }),
    );
  },

  setServerDiscovery(componentId: string, enabled: boolean) {
    return session().mutate(() => api.topology.setServerDiscovery(componentId, enabled), {
      success: enabled ? 'Discovery enabled' : 'Discovery disabled',
      context: 'Could not change discovery',
      refresh: 'detail',
    });
  },

  // ------------------------------------------------------------------ input ports

  connectPort(portId: string, signalId: string | null) {
    return session().mutate(() => api.topology.connectPort(portId, signalId), {
      context: signalId ? 'Could not connect the signal' : 'Could not disconnect the port',
      refresh: 'both',
    });
  },

  // ------------------------------------------------------------------ configuration

  async saveConfiguration() {
    const result = await session().mutate(() => api.configuration.save(), {
      context: 'Could not save the configuration',
      refresh: 'none',
    });
    if (!result) return null;
    downloadText(result.suggestedFilename, result.content, 'application/json');
    session().notify('success', `Saved ${result.suggestedFilename}`);
    return result;
  },

  loadConfiguration(
    content: string,
    parameters?: Record<string, DaqValue>,
    deviceOptions?: Record<string, { updateMode?: DeviceUpdateMode; newConnectionString?: string }>,
  ) {
    return session().mutate(() => api.configuration.load(content, parameters, deviceOptions), {
      success: 'Configuration applied',
      context: 'Could not load the configuration',
      refresh: 'tree',
    });
  },

  loadModule(path: string) {
    return session().mutate(() => api.modules.load(path), {
      success: 'Module loaded',
      context: 'Could not load the module',
      refresh: 'tree',
    });
  },

  // ------------------------------------------------------------------ misc

};
