import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE, shortcutFor, workspaceEntry, workspaceForKey, WORKSPACES } from './workspaces';

describe('workspaces', () => {
  it('opens on the signals', () => {
    expect(DEFAULT_WORKSPACE).toBe('signals');
  });

  it('gives every mode a number key in header order', () => {
    expect(WORKSPACES.map((entry) => shortcutFor(entry.id))).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(workspaceForKey('2')).toBe('scope');
    expect(workspaceForKey('5')).toBe('fleet');
    expect(workspaceForKey('6')).toBe('modules');
    expect(workspaceForKey('7')).toBeNull();
    expect(workspaceForKey('x')).toBeNull();
  });

  it('describes each mode in one sentence', () => {
    for (const entry of WORKSPACES) expect(workspaceEntry(entry.id).hint).toMatch(/^[A-Z].*\.$/);
  });
});
