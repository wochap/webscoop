import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliError, loadConfig, resolvePaths } from '../src';
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
    expect(config).toEqual({ llm: {}, browser: {}, window: { provider: 'auto', providers: {} } });
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
});
