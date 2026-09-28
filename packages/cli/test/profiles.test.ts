import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config';
import { hostOf, profileSourceLabel, resolveProfile } from '../src/profiles';

function config(profiles: unknown = {}): Config {
  return ConfigSchema.parse({ profiles });
}

describe('resolveProfile', () => {
  const rules = config({
    default: 'main',
    rules: [
      { name: '^acme-admin-', profile: 'acme-admin' },
      { host: 'acme\\.com$', profile: 'acme' },
      { host: 'acme\\.com$', name: '^report-', profile: 'reports' },
    ],
  });

  it('follows flag, recipe pin, rule, default, then name', () => {
    expect(resolveProfile({ flag: 'scratch', recipePin: 'personal', name: 'shop', host: 'acme.com', config: rules })).toEqual({ profile: 'scratch', source: 'flag' });
    expect(resolveProfile({ recipePin: 'personal', name: 'shop', host: 'acme.com', config: rules })).toEqual({ profile: 'personal', source: 'recipe' });
    expect(resolveProfile({ name: 'shop', host: 'www.acme.com', config: rules })).toEqual({ profile: 'acme', source: { rule: 2 } });
    expect(resolveProfile({ name: 'shop', host: 'other.org', config: rules })).toEqual({ profile: 'main', source: 'default' });
    expect(resolveProfile({ name: 'shop', host: 'other.org', config: config() })).toEqual({ profile: 'shop', source: 'name' });
  });

  it('takes the first matching rule', () => {
    expect(resolveProfile({ name: 'acme-admin-orders', host: 'acme.com', config: rules })).toEqual({ profile: 'acme-admin', source: { rule: 1 } });
  });

  it('needs both host and name when a rule declares both', () => {
    const both = config({ rules: [{ host: 'acme\\.com$', name: '^admin-', profile: 'admin' }] });
    expect(resolveProfile({ name: 'shop', host: 'acme.com', config: both }).source).toBe('name');
    expect(resolveProfile({ name: 'admin-x', host: 'other.org', config: both }).source).toBe('name');
    expect(resolveProfile({ name: 'admin-x', host: 'acme.com', config: both })).toEqual({ profile: 'admin', source: { rule: 1 } });
  });

  it('skips host rules when the host is unknown', () => {
    expect(resolveProfile({ name: 'shop', config: rules })).toEqual({ profile: 'main', source: 'default' });
    expect(resolveProfile({ name: 'acme-admin-x', config: rules }).source).toEqual({ rule: 1 });
  });

  it('labels each source', () => {
    expect(['flag', 'recipe', { rule: 2 }, 'default', 'name'].map((s) => profileSourceLabel(s as never))).toEqual(['flag', 'recipe', 'config rule 2', 'config default', 'recipe name']);
  });
});

describe('hostOf', () => {
  it('fills the template and returns the host name without port', () => {
    expect(hostOf('https://{site}:8080/list', { site: 'shop.acme.com' })).toBe('shop.acme.com');
    expect(hostOf('https://{site}/list', {}, [{ name: 'site', type: 'string', default: 'x.org' }])).toBe('x.org');
  });

  it('returns undefined when a variable is missing', () => {
    expect(hostOf('https://{site}/list')).toBeUndefined();
  });
});
