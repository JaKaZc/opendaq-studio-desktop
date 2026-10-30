import {
  Activity,
  Antenna,
  Blocks,
  Boxes,
  Circle,
  CircleDot,
  Folder,
  FolderOpen,
  Gauge,
  HardDrive,
  Link2,
  LogIn,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ComponentKind } from '../../lib/types';

/**
 * Icons for the component kinds, colour-coded by role.
 *
 * The colours are deliberately restrained: the tree already carries status colour
 * on badges, and a rainbow of icons would compete with it.  Devices and channels
 * — the things you navigate by — get the brand accent; everything structural
 * stays muted.
 */
const ICONS: Record<ComponentKind, { Icon: typeof Circle; tone: string; label: string }> = {
  instance: { Icon: Boxes, tone: 'text-accent', label: 'Instance' },
  device: { Icon: HardDrive, tone: 'text-accent', label: 'Device' },
  channel: { Icon: Gauge, tone: 'text-brand', label: 'Channel' },
  functionBlock: { Icon: Blocks, tone: 'text-text-muted', label: 'Function block' },
  recorder: { Icon: CircleDot, tone: 'text-brand', label: 'Recorder' },
  signal: { Icon: Activity, tone: 'text-ok', label: 'Signal' },
  inputPort: { Icon: LogIn, tone: 'text-text-faint', label: 'Input port' },
  server: { Icon: Antenna, tone: 'text-info', label: 'Server' },
  syncComponent: { Icon: Link2, tone: 'text-text-muted', label: 'Synchronization' },
  folder: { Icon: Folder, tone: 'text-text-faint', label: 'Folder' },
  component: { Icon: Circle, tone: 'text-text-faint', label: 'Component' },
};

export function NodeIcon({
  kind,
  open,
  size = 14,
  className,
}: {
  kind: ComponentKind;
  /** Folders show an open variant so expansion is visible at a glance. */
  open?: boolean;
  size?: number;
  className?: string;
}) {
  const entry = ICONS[kind] ?? ICONS.component;
  const Icon = kind === 'folder' && open ? FolderOpen : entry.Icon;
  return (
    <Icon
      size={size}
      strokeWidth={1.9}
      aria-label={entry.label}
      role="img"
      className={cn('shrink-0', entry.tone, className)}
    />
  );
}

export function kindLabel(kind: ComponentKind): string {
  return (ICONS[kind] ?? ICONS.component).label;
}
