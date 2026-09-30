import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliError, hookCommands, loadConfig, resolvePaths, WINDOW_CONFIG_WARNING } from '../src';
import { tempDir } from './helpers';

describe('resolvePaths', () => {
  it('uses ~/.local/share and ~/.config by default', () => {
    const p = resolvePaths({}, '/home/u');
    expect(p).toMatchObject({
      recipesDir: '/home/u/.local/share/webscoop/recipes',
      profilesDir: '/home/u/.local/share/webscoop/profiles',
      configFile: '/home/u/.config/webscoop/config.json',
      source: 'default',
    });
  });

  it('uses XDG_DATA_HOME and XDG_CONFIG_HOME when set', () => {
    const p = resolvePaths({ XDG_DATA_HOME: '/xdg/data', XDG_CONFIG_HOME: '/xdg/config' }, '/home/u');
    expect(p).toMatchObject({
      recipesDir: '/xdg/data/webscoop/recipes',
      profilesDir: '/xdg/data/webscoop/profiles',
      configFile: '/xdg/config/webscoop/config.json',
      source: 'XDG',
    });
  });

  it('mixes one XDG variable with the other default', () => {
    const p = resolvePaths({ XDG_CONFIG_HOME: '/xdg/config' }, '/home/u');
    expect(p.recipesDir).toBe('/home/u/.local/share/webscoop/recipes');
    expect(p.configFile).toBe('/xdg/config/webscoop/config.json');
  });

  it('lets WEBSCOOP_HOME override both roots', () => {
    const p = resolvePaths({ WEBSCOOP_HOME: '/tmp/x', XDG_DATA_HOME: '/xdg/data', XDG_CONFIG_HOME: '/xdg/c' }, '/home/u');
    expect(p).toMatchObject({
      recipesDir: '/tmp/x/recipes',
      profilesDir: '/tmp/x/profiles',
      configFile: '/tmp/x/config.json',
      source: 'WEBSCOOP_HOME',
    });
  });

  it('ignores empty variables', () => {
    expect(resolvePaths({ WEBSCOOP_HOME: '', XDG_DATA_HOME: ' ' }, '/h').source).toBe('default');
  });
});

describe('loadConfig', () => {
  it('returns defaults when the file is missing', async () => {
    const home = await tempDir();
    const config = await loadConfig(resolvePaths({ WEBSCOOP_HOME: home }, '/h'));
    expect(config).toEqual({ llm: {}, browser: { driver: 'playwright' }, daemon: { concurrency: 1, idleMs: 60_000 }, profiles: { rules: [] } });
  });

  it('accepts the LLM fields', async () => {
    const home = await tempDir();
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({ llm: { endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen3.5:9b', contextTokens: 32768 } }),
    );
    const config = await loadConfig(resolvePaths({ WEBSCOOP_HOME: home }, '/h'));
    expect(config.llm).toEqual({ endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen3.5:9b', contextTokens: 32768 });
  });

  it('rejects an invalid config with the file and path', async () => {
    const home = await tempDir();
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify({ llm: { endpoint: 'not a url' } }));
    const error = await loadConfig(resolvePaths({ WEBSCOOP_HOME: home }, '/h')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toContain('config.json');
    expect((error as Error).message).toContain('llm.endpoint');
  });

  async function configError(json: unknown): Promise<string> {
    const home = await tempDir();
    await writeFile(join(home, 'config.json'), JSON.stringify(json));
    const error = await loadConfig(resolvePaths({ WEBSCOOP_HOME: home }, '/h')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    return (error as Error).message;
  }

  it('accepts hooks as a command line or a list, and hookTimeoutMs', async () => {
    const home = await tempDir();
    const hooks = { 'attention.needed': 'notify-send hi', 'browser.started': ['a', 'b'] };
    await writeFile(join(home, 'config.json'), JSON.stringify({ hooks, hookTimeoutMs: 2000, browser: { args: ['--class=webscoop'] } }));
    const config = await loadConfig(resolvePaths({ WEBSCOOP_HOME: home }, '/h'));
    expect(config.hooks).toEqual(hooks);
    expect(config.hookTimeoutMs).toBe(2000);
    expect(config.browser.args).toEqual(['--class=webscoop']);
    expect(hookCommands(config, 'attention.needed')).toEqual(['notify-send hi']);
    expect(hookCommands(config, 'browser.started')).toEqual(['a', 'b']);
    expect(hookCommands(config, 'run.done')).toEqual([]);
  });

  it('rejects an unknown hook event, naming it', async () => {
    expect(await configError({ hooks: { 'attention.maybe': 'true' } })).toContain('attention.maybe');
    expect(await configError({ hooks: { 'run.done': [] } })).toContain('$.hooks.run.done');
  });

  it('loads a leftover window block with one warning and ignores it', async () => {
    const home = await tempDir();
    await writeFile(join(home, 'config.json'), JSON.stringify({ window: { provider: 'hyprland' } }));
    const warnings: string[] = [];
    await loadConfig(resolvePaths({ WEBSCOOP_HOME: home }, '/h'), (m) => warnings.push(m));
    expect(warnings).toEqual([WINDOW_CONFIG_WARNING]);
    expect(WINDOW_CONFIG_WARNING).toContain('hooks');
  });

  it('accepts a profiles block', async () => {
    const home = await tempDir();
    const profiles = { default: 'main', rules: [{ name: '^acme-admin-', profile: 'acme-admin' }, { host: '(^|\\.)acme\\.com$', profile: 'acme' }] };
    await writeFile(join(home, 'config.json'), JSON.stringify({ profiles }));
    const config = await loadConfig(resolvePaths({ WEBSCOOP_HOME: home }, '/h'));
    expect(config.profiles).toEqual(profiles);
  });

  it('rejects an invalid profile rule pattern, naming its path', async () => {
    expect(await configError({ profiles: { rules: [{ host: 'acme(', profile: 'acme' }] } })).toContain('$.profiles.rules.0.host');
    expect(await configError({ profiles: { rules: [{ host: 'a', profile: 'a' }, { name: '[', profile: 'b' }] } })).toContain('$.profiles.rules.1.name');
  });

  it('rejects a profile rule with neither host nor name, naming the rule', async () => {
    expect(await configError({ profiles: { rules: [{ profile: 'acme' }] } })).toMatch(/\$\.profiles\.rules\.0: /);
  });

  it('rejects invalid profile names, naming their paths', async () => {
    expect(await configError({ profiles: { default: '../x' } })).toContain('$.profiles.default');
    expect(await configError({ profiles: { rules: [{ host: 'a', profile: 'a/b' }] } })).toContain('$.profiles.rules.0.profile');
  });
});
