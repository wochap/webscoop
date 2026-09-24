import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRecipe, NoopWindow, saveRecipe, type RecipeInput } from '@webscoop/core';
import { FakeBrowser, h } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import {
  CommandWindow,
  ConfigSchema,
  createWindowPort,
  ExitCode,
  execShell,
  findBrowserPid,
  HYPRLAND,
  HYPRLAND_RULE,
  main,
  parseWorkspace,
  selectProvider,
  substitute,
  windowMode,
  type Exec,
  type FindBinary,
  type ProviderDef,
} from '../src';
import { doctorCommand } from '../src/commands/doctor';
import { tempDir, testIo } from './helpers';

const SWAY: ProviderDef = {
  detect: { env: 'SWAYSOCK', binary: 'swaymsg' },
  hide: "swaymsg '[pid={pid}] move scratchpad'",
  show: "swaymsg '[pid={pid}] scratchpad show'",
};

const HYPR_ENV = { HYPRLAND_INSTANCE_SIGNATURE: 'abc', PATH: '/usr/bin' };
const binaries =
  (...names: string[]): FindBinary =>
  (name) =>
    names.includes(name) ? `/usr/bin/${name}` : null;

/** An exec that records every line and answers from a table of prefixes. */
function recordingExec(answers: Record<string, string> = {}): Exec & { lines: string[] } {
  const lines: string[] = [];
  const exec: Exec = async (line) => {
    lines.push(line);
    const hit = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    return hit ? answers[hit]! : 'ok\n';
  };
  return Object.assign(exec, { lines });
}

function stderr() {
  let text = '';
  return { write: (s: string) => (text += s), text: () => text };
}

describe('command templates', () => {
  it('substitutes {pid} and {workspace} and rejects a placeholder without a value', () => {
    expect(substitute('move {workspace},pid:{pid} {other}', { pid: 42, workspace: '6' })).toBe('move 6,pid:42 {other}');
    expect(() => substitute('move {workspace}', { pid: 1 })).toThrow('no value for {workspace}');
  });

  it('reads a workspace from JSON or plain text and refuses shell characters', () => {
    expect(parseWorkspace('{"id": 6, "name": "6"}')).toBe('6');
    expect(parseWorkspace('{"name": "web"}')).toBe('web');
    expect(parseWorkspace('special:scratch\n')).toBe('special:scratch');
    expect(() => parseWorkspace("6'; rm -rf ~")).toThrow('unexpected workspace');
  });

  it('runs the hide template with the pid through the injected exec', async () => {
    const exec = recordingExec();
    const port = new CommandWindow({ name: 'sway', def: SWAY, pid: async () => 42, env: {}, warn: () => {}, exec });
    await port.hide();
    await port.focus();
    expect(exec.lines).toEqual(["swaymsg '[pid=42] move scratchpad'"]);
  });

  it('warns once per command kind and never throws', async () => {
    const warnings: string[] = [];
    const exec: Exec = async () => {
      throw new Error('exited with 1');
    };
    const port = new CommandWindow({ name: 'sway', def: SWAY, pid: async () => 42, env: {}, warn: (m) => warnings.push(m), exec });
    await port.hide();
    await port.hide();
    await port.show();
    expect(warnings).toEqual(['window provider sway: hide failed: exited with 1', 'window provider sway: show failed: exited with 1']);
  });

  it('gives up on a command that hangs past the timeout', async () => {
    const warnings: string[] = [];
    const exec: Exec = () => new Promise(() => {});
    const port = new CommandWindow({ name: 'sway', def: SWAY, pid: async () => 42, env: {}, warn: (m) => warnings.push(m), exec, timeoutMs: 20 });
    await port.hide();
    expect(warnings).toEqual(['window provider sway: hide failed: timed out after 20 ms']);
  });

  it('kills a real command at the timeout', async () => {
    await expect(execShell('sleep 5', { timeoutMs: 50, env: { PATH: process.env.PATH } })).rejects.toThrow('timed out after 50 ms');
    await expect(execShell('echo hi', { timeoutMs: 2000, env: { PATH: process.env.PATH } })).resolves.toBe('hi\n');
  });

  it('skips every command with one warning when the browser pid is not found', async () => {
    const warnings: string[] = [];
    const exec = recordingExec();
    const port = new CommandWindow({ name: 'hyprland', def: HYPRLAND, pid: async () => null, env: {}, warn: (m) => warnings.push(m), exec });
    await port.hide();
    await port.show();
    expect(exec.lines).toEqual([]);
    expect(warnings).toEqual(['window provider hyprland: the browser process was not found; the window stays visible']);
  });
});

describe('hyprland preset', () => {
  it('hides on special:webscoop silently', async () => {
    const exec = recordingExec();
    await new CommandWindow({ name: 'hyprland', def: HYPRLAND, pid: async () => 42, env: {}, warn: () => {}, exec }).hide();
    expect(exec.lines).toHaveLength(1);
    expect(exec.lines[0]).toContain('movetoworkspacesilent special:webscoop,pid:42');
    expect(exec.lines[0]).toContain('hl.dsp.window.move({ workspace = "special:webscoop", follow = false, window = "pid:42" })');
  });

  it('launches Chromium with --class=webscoop and installs the class rule once per Lua session before launch', async () => {
    const exec = recordingExec();
    const port = new CommandWindow({ name: 'hyprland', def: HYPRLAND, pid: async () => 42, env: {}, warn: () => {}, exec });
    expect(port.launchArgs).toEqual(['--class=webscoop']);
    await port.prepare();
    expect(exec.lines).toEqual([
      `hyprctl eval 'if not _G.__webscoop_rule then _G.__webscoop_rule = hl.window_rule({ match = { class = "^(webscoop)$" }, workspace = "special:webscoop silent" }) end' >/dev/null 2>&1 || true`,
    ]);
  });

  it('prepares without a warning when hyprctl eval fails (classic config)', async () => {
    const warnings: string[] = [];
    const dir = await tempDir();
    await writeFile(join(dir, 'hyprctl'), '#!/bin/sh\necho "unknown request"; exit 1\n');
    await chmod(join(dir, 'hyprctl'), 0o755);
    const env = { PATH: `${dir}:${process.env.PATH}` };
    const port = new CommandWindow({ name: 'hyprland', def: HYPRLAND, pid: async () => 42, env, warn: (m) => warnings.push(m) });
    await port.prepare();
    expect(warnings).toEqual([]);
  });

  it('looks up the active workspace, then moves the window there and focuses it', async () => {
    const exec = recordingExec({ 'hyprctl activeworkspace -j': '{"id": 6, "name": "6", "monitor": "HDMI-A-1"}' });
    const port = new CommandWindow({ name: 'hyprland', def: HYPRLAND, pid: async () => 42, env: {}, warn: () => {}, exec });
    await port.show();
    await port.focus();
    expect(exec.lines[0]).toBe('hyprctl activeworkspace -j');
    expect(exec.lines[1]).toContain('movetoworkspace 6,pid:42');
    expect(exec.lines[1]).toContain('workspace = "6"');
    expect(exec.lines[2]).toContain('focuswindow pid:42');
    expect(exec.lines).toHaveLength(3);
  });

  /** A fake `hyprctl` on PATH that logs its arguments and answers like a Lua or a classic config. */
  async function fakeHyprctl(lua: boolean) {
    const dir = await tempDir();
    const log = join(dir, 'log');
    const script = [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$2" in',
      `  hl.*) ${lua ? 'echo ok' : 'echo "Invalid dispatcher"'} ;;`,
      `  *) ${lua ? 'echo "dispatch in lua is a shorthand"; exit 7' : 'echo ok'} ;;`,
      'esac',
    ].join('\n');
    await writeFile(join(dir, 'hyprctl'), script);
    await chmod(join(dir, 'hyprctl'), 0o755);
    const env = { PATH: `${dir}:${process.env.PATH}` };
    const warnings: string[] = [];
    const port = new CommandWindow({ name: 'hyprland', def: HYPRLAND, pid: async () => 42, env, warn: (m) => warnings.push(m) });
    return { port, warnings, calls: async () => (await readFile(log, 'utf8')).trim().split('\n') };
  }

  it('dispatches in Lua syntax on a Lua config', async () => {
    const t = await fakeHyprctl(true);
    await t.port.hide();
    expect(await t.calls()).toEqual(['dispatch hl.dsp.window.move({ workspace = "special:webscoop", follow = false, window = "pid:42" })']);
    expect(t.warnings).toEqual([]);
  });

  it('falls back to the classic dispatcher on a classic config', async () => {
    const t = await fakeHyprctl(false);
    await t.port.hide();
    expect((await t.calls())[1]).toBe('dispatch movetoworkspacesilent special:webscoop,pid:42');
    expect(t.warnings).toEqual([]);
  });
});

describe('findBrowserPid', () => {
  async function procTree(processes: Record<number, string[]>) {
    const dir = await tempDir();
    for (const [pid, args] of Object.entries(processes)) {
      await mkdir(join(dir, pid), { recursive: true });
      await writeFile(join(dir, pid, 'cmdline'), `${args.join('\0')}\0`);
    }
    await mkdir(join(dir, 'self'), { recursive: true });
    return dir;
  }

  const PROFILE = '/home/u/.local/share/webscoop/profiles/shop';

  it('finds the main process and skips renderers and other profiles', async () => {
    const procDir = await procTree({
      100: ['/opt/chrome', `--user-data-dir=${PROFILE}`, '--type=renderer'],
      200: ['/opt/chrome', `--user-data-dir=${PROFILE}-other`],
      300: ['/opt/chrome', '--no-sandbox', `--user-data-dir=${PROFILE}`, 'about:blank'],
      400: ['/opt/chrome', `--user-data-dir=${PROFILE}`, '--type=gpu-process'],
    });
    expect(await findBrowserPid(PROFILE, { procDir, deadlineMs: 0 })).toBe(300);
  });

  it('matches command lines Chromium rewrote into one space-separated string', async () => {
    const procDir = await procTree({
      100: [`/opt/chrome --type=zygote --user-data-dir=${PROFILE} --no-sandbox`],
      200: [`/opt/chrome --no-sandbox --user-data-dir=${PROFILE} --remote-debugging-pipe about:blank`],
    });
    expect(await findBrowserPid(PROFILE, { procDir, deadlineMs: 0 })).toBe(200);
    expect(await findBrowserPid(`${PROFILE}/nested`, { procDir, deadlineMs: 0 })).toBeNull();
  });

  it('polls until the process appears', async () => {
    const procDir = await procTree({});
    setTimeout(async () => {
      await mkdir(join(procDir, '500'));
      await writeFile(join(procDir, '500', 'cmdline'), `/opt/chrome\0--user-data-dir=${PROFILE}\0`);
    }, 30);
    expect(await findBrowserPid(PROFILE, { procDir, deadlineMs: 2000, pollMs: 10 })).toBe(500);
  });

  it('returns null after the deadline', async () => {
    const procDir = await procTree({ 100: ['/opt/chrome', `--user-data-dir=${PROFILE}`, '--type=renderer'] });
    const started = Date.now();
    expect(await findBrowserPid(PROFILE, { procDir, deadlineMs: 50, pollMs: 10 })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });
});

describe('selectProvider', () => {
  const config = (provider: string, providers: Record<string, ProviderDef> = {}) => ({ provider, providers });

  it('picks hyprland under auto when the variable is set and hyprctl is found', () => {
    expect(selectProvider(config('auto', { sway: SWAY }), { ...HYPR_ENV, SWAYSOCK: '/run/sway' }, { findBinary: binaries('hyprctl', 'swaymsg'), platform: 'linux' })).toMatchObject({
      name: 'hyprland',
      binaryPath: '/usr/bin/hyprctl',
    });
  });

  it('tries user providers after the built-in ones, in declaration order', () => {
    const other: ProviderDef = { ...SWAY, detect: { env: 'OTHER', binary: 'other' } };
    const selection = selectProvider(config('auto', { other, sway: SWAY }), { SWAYSOCK: '/run/sway', OTHER: '1' }, { findBinary: binaries('swaymsg', 'other'), platform: 'linux' });
    expect(selection.name).toBe('other');
    expect(selectProvider(config('auto', { other, sway: SWAY }), { SWAYSOCK: '/run/sway' }, { findBinary: binaries('swaymsg', 'other'), platform: 'linux' }).name).toBe('sway');
  });

  it('selects none when nothing detects, and on other platforms', () => {
    expect(selectProvider(config('auto'), {}, { findBinary: binaries('hyprctl'), platform: 'linux' })).toEqual({ name: 'none', def: null });
    expect(selectProvider(config('auto'), HYPR_ENV, { findBinary: binaries('hyprctl'), platform: 'darwin' })).toEqual({ name: 'none', def: null });
  });

  it('warns about a named provider whose binary is missing and falls back to none', () => {
    const selection = selectProvider(config('hyprland'), HYPR_ENV, { findBinary: binaries(), platform: 'linux' });
    expect(selection).toMatchObject({ name: 'none', def: null, warning: expect.stringContaining('hyprctl is not on the PATH') });
  });

  it('warns about an unknown provider name', () => {
    expect(selectProvider(config('kwin'), HYPR_ENV, { findBinary: binaries('hyprctl'), platform: 'linux' })).toMatchObject({ name: 'none', warning: expect.stringContaining('unknown window provider kwin') });
  });

  it('lets a user provider named hyprland replace the preset', () => {
    const custom: ProviderDef = { ...HYPRLAND, hide: 'hyprctl dispatch movetoworkspacesilent special:mine,pid:{pid}' };
    expect(selectProvider(config('auto', { hyprland: custom }), HYPR_ENV, { findBinary: binaries('hyprctl'), platform: 'linux' })).toMatchObject({ name: 'hyprland', def: custom });
  });
});

describe('window config', () => {
  it('defaults to auto without providers', () => {
    expect(ConfigSchema.parse({}).window).toEqual({ provider: 'auto', providers: {} });
  });

  it('parses a custom sway provider and uses it with the pid substituted', async () => {
    const config = ConfigSchema.parse({ window: { provider: 'sway', providers: { sway: SWAY } } });
    expect(config.window.providers.sway).toEqual(SWAY);
    const exec = recordingExec();
    const port = createWindowPort(config, { SWAYSOCK: '/run/sway' }, {
      profileDir: '/p/shop',
      mode: 'auto',
      stderr: stderr(),
      findBinary: binaries('swaymsg'),
      platform: 'linux',
      exec,
      findPid: async () => 77,
    });
    await port.hide();
    expect(exec.lines).toEqual(["swaymsg '[pid=77] move scratchpad'"]);
  });

  it('parses prepare and args of a user provider', () => {
    const def = { ...SWAY, prepare: 'swaymsg for_window [app_id=webscoop] move scratchpad', args: ['--class=webscoop'] };
    expect(ConfigSchema.parse({ window: { providers: { sway: def } } }).window.providers.sway).toEqual(def);
    const plain = new CommandWindow({ name: 'sway', def: SWAY, pid: async () => 1, env: {}, warn: () => {}, exec: recordingExec() });
    expect(plain.launchArgs).toEqual([]);
  });

  it('rejects a provider without templates and the reserved names', () => {
    expect(ConfigSchema.safeParse({ window: { providers: { sway: { detect: SWAY.detect, hide: 'x' } } } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ window: { providers: { none: SWAY } } }).success).toBe(false);
  });
});

describe('window mode', () => {
  it('keeps interactive runs and --show visible, forces with --hide, else follows config', () => {
    expect(windowMode({})).toBe('auto');
    expect(windowMode({ show: true })).toBe('show');
    expect(windowMode({ hide: true })).toBe('hide');
    expect(windowMode({ interactive: true, hide: true })).toBe('show');
  });

  const make = (provider: string, mode: 'auto' | 'hide' | 'show', env: Record<string, string> = HYPR_ENV) => {
    const err = stderr();
    const exec = recordingExec();
    const port = createWindowPort(ConfigSchema.parse({ window: { provider } }), env, {
      profileDir: 'relative/shop',
      mode,
      stderr: err,
      findBinary: binaries('hyprctl'),
      platform: 'linux',
      exec,
      findPid: async (dir) => (dir.startsWith('/') ? 42 : null),
    });
    return { port, err, exec };
  };

  it('returns a NoopWindow for show whatever the config says', () => {
    expect(make('hyprland', 'show').port).toBeInstanceOf(NoopWindow);
  });

  it('hides with the detected provider under auto, looking up the pid by absolute profile path', async () => {
    const t = make('auto', 'auto');
    expect(t.port).toBeInstanceOf(CommandWindow);
    await t.port.hide();
    expect(t.exec.lines[0]).toContain('pid:42');
  });

  it('stays visible when config says none, unless --hide forces a detected provider', async () => {
    expect(make('none', 'auto').port).toBeInstanceOf(NoopWindow);
    const forced = make('none', 'hide');
    expect(forced.port).toBeInstanceOf(CommandWindow);
    const nothing = make('none', 'hide', {});
    expect(nothing.port).toBeInstanceOf(NoopWindow);
    expect(nothing.err.text()).toBe('webscoop: --hide: no window provider detected; the window stays visible\n');
  });

  it('reports a named provider that does not detect on stderr', () => {
    const t = make('hyprland', 'auto', { PATH: '/usr/bin' });
    expect(t.port).toBeInstanceOf(NoopWindow);
    expect(t.err.text()).toContain('window provider hyprland not usable: HYPRLAND_INSTANCE_SIGNATURE is not set');
  });
});

describe('run and test wiring', () => {
  const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
  const PAGE = 'https://shop.test/c/shoes';
  const recipe: RecipeInput = {
    schemaVersion: 1,
    name: 'shop',
    url: PAGE,
    item: { selectors: [{ strategy: 'testid', value: 'card', stability: 'stable' }] },
    fields: [{ name: 'title', type: 'text', scope: 'item', selectors: [{ strategy: 'css', value: 'h2', stability: 'medium' }] }],
  };
  const page = h('html', {}, h('body', {}, h('div', { 'data-testid': 'card' }, h('h2', {}, 'Shoe'))));

  async function setup() {
    const dir = await tempDir();
    await mkdir(join(dir, 'recipes'), { recursive: true });
    await writeFile(join(dir, 'recipes', 'shop.json'), saveRecipe(loadRecipe(recipe)));
    const calls: string[] = [];
    const t = testIo({
      env: { ...DISPLAY, WEBSCOOP_HOME: dir },
      browser: new FakeBrowser({ [PAGE]: page }),
      window: { show: async () => void calls.push('show'), hide: async () => void calls.push('hide') },
    });
    return { t, calls, dir };
  }

  it('passes the mode from the flags and hides through the port', async () => {
    const { t, calls, dir } = await setup();
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Ok);
    expect(await main(['run', 'shop', '--show'], t)).toBe(ExitCode.Ok);
    expect(await main(['run', 'shop', '--hide'], t)).toBe(ExitCode.Ok);
    expect(await main(['run', 'shop', '--interactive', '--hide'], t)).toBe(ExitCode.Ok);
    expect(await main(['test', 'shop', '--hide'], t)).toBe(ExitCode.Ok);
    expect(await main(['test', 'shop'], t)).toBe(ExitCode.Ok);
    const profileDir = join(dir, 'profiles', 'shop');
    expect(t.windows).toEqual([
      { profileDir, mode: 'auto' },
      { profileDir, mode: 'show' },
      { profileDir, mode: 'hide' },
      { profileDir, mode: 'show' },
      { profileDir, mode: 'hide' },
      { profileDir, mode: 'auto' },
    ]);
    expect(calls).toEqual(Array(6).fill('hide'));
  });

  it('rejects --show with --hide', async () => {
    const { t } = await setup();
    expect(await main(['run', 'shop', '--show', '--hide'], t)).toBe(ExitCode.Error);
    expect(t.err()).toContain("option '--show' cannot be used with option '--hide'");
  });

  it('lists both flags in run and test help', async () => {
    for (const command of ['run', 'test']) {
      const t = testIo({});
      await main([command, '--help'], t);
      expect(t.out()).toContain('--show');
      expect(t.out()).toContain('--hide');
    }
  });
});

describe('doctor window lines', () => {
  const line = (out: string, key: string) => out.split('\n').find((l) => l.startsWith(`${key} `)) ?? '';

  async function doctor(env: Record<string, string>, findBinary: FindBinary, config: object = {}) {
    const dir = await tempDir();
    await writeFile(join(dir, 'config.json'), JSON.stringify(config));
    const io = testIo({ env: { WAYLAND_DISPLAY: 'wayland-1', WEBSCOOP_HOME: dir, ...env } });
    expect(await doctorCommand(io, { findBinary, platform: 'linux' })).toBe(ExitCode.Ok);
    return io.out();
  }

  it('prints the Hyprland provider, its binary, and the rule', async () => {
    const out = await doctor({ HYPRLAND_INSTANCE_SIGNATURE: 'abc' }, binaries('hyprctl'));
    expect(line(out, 'window')).toMatch(/^window +hyprland \(hyprctl at \/usr\/bin\/hyprctl\)$/);
    expect(line(out, 'window rule')).toContain(HYPRLAND_RULE);
    expect(line(out, 'window rule')).toContain('windowrulev2 = workspace special:webscoop silent, class:^(webscoop)$');
    expect(line(out, 'window rule (lua)')).toContain('hl.window_rule({ match = { class = "^(webscoop)$" }');
    expect(line(out, 'window note')).toContain('--class=webscoop');
  });

  it('warns when Hyprland is detected but hyprctl is missing', async () => {
    const out = await doctor({ HYPRLAND_INSTANCE_SIGNATURE: 'abc' }, binaries());
    expect(line(out, 'window')).toContain('none (warning: HYPRLAND_INSTANCE_SIGNATURE is set but hyprctl is not on the PATH');
    expect(line(out, 'window rule')).toBe('');
  });

  it('warns about a named provider whose binary is missing', async () => {
    const out = await doctor({ HYPRLAND_INSTANCE_SIGNATURE: 'abc' }, binaries(), { window: { provider: 'hyprland' } });
    expect(line(out, 'window')).toContain('warning: window provider hyprland not usable: hyprctl is not on the PATH');
  });

  it('reports none when nothing is detected', async () => {
    const out = await doctor({}, binaries('hyprctl'));
    expect(line(out, 'window')).toMatch(/^window +none \(no provider detected; the window stays visible\)$/);
  });
});

describe.skipIf(!(process.env.WAYLAND_DISPLAY || process.env.DISPLAY) || process.platform !== 'linux')('findBrowserPid (integration)', () => {
  it('finds the live main process of a launched profile', async () => {
    const { PlaywrightBrowser } = await import('@webscoop/browser');
    const profileDir = await tempDir('webscoop-pid-');
    const session = await new PlaywrightBrowser({ executablePath: process.env.WEBSCOOP_CHROMIUM || undefined }).open(profileDir);
    try {
      const pid = await findBrowserPid(profileDir);
      expect(pid).not.toBeNull();
      const cmdline = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ');
      expect(cmdline).toContain(`--user-data-dir=${profileDir}`);
      expect(cmdline).not.toContain('--type=');
    } finally {
      await session.close();
    }
  });
});
