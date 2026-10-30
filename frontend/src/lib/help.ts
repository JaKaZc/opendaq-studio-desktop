/**
 * What each mode is for and how to begin, for the help panel.
 *
 * Written for someone who opens openDAQ Studio for the first time: what the mode
 * shows of openDAQ, the first steps in order, and the tips that save time later.
 */

import type { Workspace } from './workspaces';

export interface WorkspaceHelp {
  purpose: string;
  steps: string[];
  tips: string[];
}

export const HELP: Record<Workspace, WorkspaceHelp> = {
  signals: {
    purpose:
      'Signals shows the signals of the openDAQ instance as live tracks on one time axis. Click a track to see its data descriptor, the function block that produces it and the function blocks it can be processed with.',
    steps: [
      'Connect a device with Add in the header. Its signals appear as tracks.',
      'Click a track and add a function block, such as Statistics or FFT, to process it. Its output signals become tracks under it.',
      'Add a CSV or Parquet recorder, connect the tracks to it and press Record.',
    ],
    tips: [
      'Hover over the tracks to read every signal at the same moment.',
      'Press Space to pause and scroll sideways to look back in time.',
      'Hold ⌘ or Ctrl while scrolling to show more or less time.',
      'A recorder writes where its Path property says. Open it with the gear beside it.',
    ],
  },
  scope: {
    purpose:
      'The Scope plots live traces like an oscilloscope. It has a trigger, two cursors, measurements over the visible window and a spectrum.',
    steps: [
      'Add signals from the list on the left, or with the Scope button on a track.',
      'Drag to pan the time axis and scroll to zoom.',
      'Turn on the trigger to hold a repeating waveform still.',
      'Open a trace\'s channel and device settings with the gear in its row, and watch the effect while you change them.',
    ],
    tips: [
      'If the plot stops moving, the strip above it says why. Press L or Live to jump back to the newest samples.',
      'Dragging or zooming freezes the view; Space pauses and resumes the stream.',
      'If a signal stops delivering samples, for example after its device was reconfigured, use Restart the stream.',
      'Hold Shift and drag to measure the time and value between two points.',
      'Single trigger captures one event and stops.',
    ],
  },
  devices: {
    purpose:
      'Devices shows the component tree of the instance: devices, channels, function blocks, signals and servers. Select a component to see and change the properties, attributes and statuses openDAQ gives it.',
    steps: [
      'Pick a device, channel or function block in the navigator on the left.',
      'Change a property on its card. The change is written to the component at once.',
      'Use Reset to return a property to its default value.',
    ],
    tips: ['Right-click a row for more actions, such as adding a function block to a device.', 'Function and procedure properties can be called from their card.'],
  },
  flow: {
    purpose: 'Flow draws the instance as the dataflow it is: channels and their signals, function blocks reading them through input ports, and the servers publishing them.',
    steps: ['Drag to move around the diagram and scroll to zoom.', 'Select a component to see its details, then open it in Devices.'],
    tips: [
      'Every signal shows its current reading.',
      'The Time band above shows where each device takes its time from, and Align devices lines up devices whose clocks differ.',
    ],
  },
  fleet: {
    purpose:
      'Fleet shows every connected device at a glance: its connection, operation mode, status, active channels and time, and for a phone its battery, temperature, processor, Wi-Fi and Dashboard.',
    steps: [
      'Connect devices with Add in the header. Each gets a card.',
      'Press Run all or Idle all to set every device\'s operation mode at once, or a mode on one card.',
      'Click a device\'s name to open it in Devices.',
    ],
    tips: ['A reading turns amber when it needs attention: a low battery, a hot phone or a weak Wi-Fi signal.', 'Hover over Dashboard to see its PIN.'],
  },
  modules: {
    purpose: 'Modules lists the openDAQ modules the instance has loaded, with the device, function block, server and streaming types each one provides and their default configuration.',
    steps: ['Open a module to see its component types.', 'Load another module from disk with Load module in the File menu.'],
    tips: ['The default configuration of a type is what Add uses when nothing is changed.'],
  },
};
