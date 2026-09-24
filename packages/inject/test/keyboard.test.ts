import { describe, expect, it } from 'vitest';
import { shortcutFor, walkTrail, type ShortcutContext } from '../src/keyboard';

const ctx = (extra: Partial<ShortcutContext> = {}): ShortcutContext => ({
  typing: false,
  picking: false,
  menuOpen: false,
  hasProposal: false,
  hasSelection: false,
  focusedField: null,
  ...extra,
});
const key = (k: string, mods: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => ({
  key: k,
  altKey: mods.alt ?? false,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
});

describe('shortcuts', () => {
  it('maps every panel shortcut', () => {
    expect(shortcutFor(key('p'), ctx())).toBe('pick');
    expect(shortcutFor(key('Escape'), ctx({ picking: true }))).toBe('cancel');
    expect(shortcutFor(key('Escape'), ctx({ picking: true, menuOpen: true }))).toBe('closeMenu');
    expect(shortcutFor(key('Enter'), ctx({ hasProposal: true }))).toBe('confirm');
    expect(shortcutFor(key('ArrowLeft'), ctx({ hasSelection: true }))).toBe('walkUp');
    expect(shortcutFor(key('ArrowRight'), ctx({ hasSelection: true }))).toBe('walkDown');
    expect(shortcutFor(key('ArrowUp', { alt: true }), ctx({ focusedField: 1 }))).toBe('moveUp');
    expect(shortcutFor(key('ArrowDown', { alt: true }), ctx({ focusedField: 1 }))).toBe('moveDown');
    expect(shortcutFor(key('s', { ctrl: true }), ctx())).toBe('save');
    expect(shortcutFor(key('S', { meta: true }), ctx())).toBe('save');
  });

  it('suppresses every shortcut while typing', () => {
    const typing = ctx({ typing: true, hasProposal: true, hasSelection: true, focusedField: 0, picking: true });
    for (const k of [key('p'), key('Escape'), key('Enter'), key('ArrowLeft'), key('ArrowUp', { alt: true }), key('s', { ctrl: true })]) {
      expect(shortcutFor(k, typing), k.key).toBeNull();
    }
  });

  it('ignores keys that do not apply in the current state', () => {
    expect(shortcutFor(key('Enter'), ctx())).toBeNull();
    expect(shortcutFor(key('ArrowLeft'), ctx())).toBeNull();
    expect(shortcutFor(key('ArrowUp', { alt: true }), ctx())).toBeNull();
    expect(shortcutFor(key('p'), ctx({ picking: true }))).toBeNull();
    expect(shortcutFor(key('p', { ctrl: true }), ctx())).toBeNull();
    expect(shortcutFor(key('Escape'), ctx())).toBeNull();
  });

  it('walks a breadcrumb trail', () => {
    const trail = [{ path: [1] }, { path: [1, 0] }, { path: [1, 0, 3] }];
    expect(walkTrail(trail, [1, 0, 3], -1)).toEqual({ path: [1, 0] });
    expect(walkTrail(trail, [1], -1)).toBeNull();
    expect(walkTrail(trail, [1], 1)).toEqual({ path: [1, 0] });
    expect(walkTrail(trail, [9], 1)).toBeNull();
  });
});
