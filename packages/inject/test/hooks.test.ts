import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');
const NAME = /^(panel|footer|section|recipe|var|steps?|flows?|trigger|sequence|block|paginate|bar|sheet|tabs?|table|rows|pick|list|fields?|chip|stack|input|results|repick|guard|frame)(-[a-z0-9]+)*$/;

function files(dir: string, ext: RegExp): string[] {
  // The nix package build copies only `packages/`, so `e2e/` may be absent.
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

/** A hook as written: a static name, or the fixed start of a template literal. */
type Hook = { name: string; prefix: boolean; at: string };

/** The literal (or template start) right after `pre`, with where it sits. */
function literals(text: string, file: string, pre: string): Hook[] {
  const re = new RegExp(pre + String.raw`\\?(["'\x60])([^"'\x60$]*)(\$\{)?`, 'g');
  const out: Hook[] = [];
  for (const m of text.matchAll(re)) {
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ name: m[2]!, prefix: m[3] !== undefined, at: `${relative(root, file)}:${line}` });
  }
  return out;
}

/** Hooks the panel sets: data-ws values, hook props and defaults, and the table menu items. */
function sourceHooks() {
  const hooks: Hook[] = [];
  const suffixes = new Set<string>();
  const propHooks: Hook[] = [];
  for (const file of files(join(root, 'packages/inject/src/ui'), /\.tsx$/)) {
    const text = readFileSync(file, 'utf8');
    hooks.push(...literals(text, file, String.raw`data-ws=\{?`));
    const props = literals(text, file, String.raw`(?<![-\w])(?:ws|testId|pickTestId|candidatesTestId|errorTestId)(?:=\{?|\s*[:=]\s*)`);
    hooks.push(...props);
    propHooks.push(...props);
    hooks.push(...literals(text, file, String.raw`\bitem\(\s*'[^']*',\s*`));
    // Hooks a shared component derives from its `testId`, such as `${testId}-go`.
    for (const m of text.matchAll(/data-ws=\{`\$\{testId\}(-[a-z-]+)`\}/g)) suffixes.add(m[1]!);
    for (const m of text.matchAll(/TestId = `\$\{testId\}(-[a-z-]+)`/g)) suffixes.add(m[1]!);
    // A shared component that appends a value, such as `${testId}-${o.value}`, makes every testId a prefix.
    if (/data-ws=\{`\$\{testId\}-\$\{/.test(text)) suffixes.add('-');
  }
  for (const h of propHooks) {
    if (h.prefix || !h.name) continue;
    for (const s of suffixes) hooks.push(s === '-' ? { ...h, name: `${h.name}-`, prefix: true } : { ...h, name: h.name + s });
  }
  return hooks.filter((h) => h.name !== '' || !h.prefix);
}

/** Hooks the tests target: data-ws selectors and the q, qa and ws helper arguments. */
function testHooks() {
  const tests = [...files(join(root, 'e2e'), /\.ts$/), ...files(join(root, 'packages/inject/test'), /\.tsx?$/)].filter((f) => !f.endsWith('hooks.test.ts'));
  return tests.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...literals(text, file, 'data-ws='), ...literals(text, file, String.raw`\b(?:qa?|ws)\(`)].filter((h) => h.name !== '');
  });
}

describe('data-ws hooks', () => {
  const source = sourceHooks();

  it('finds the panel hooks', () => {
    expect(source.length).toBeGreaterThan(200);
    expect(source.some((h) => h.name === 'list-accept')).toBe(true);
    expect(source.some((h) => h.name === 'list-row-' && h.prefix)).toBe(true);
    expect(source.some((h) => h.name === 'pick-selector-go')).toBe(true);
  });

  it('name each hook <section>-<element>', () => {
    const bad = source.filter((h) => !NAME.test(h.prefix ? `${h.name}x` : h.name)).map((h) => `${h.at} ${h.name}`);
    expect(bad).toEqual([]);
  });

  it('exist in the panel for every hook a test targets', () => {
    const exact = new Set(source.filter((h) => !h.prefix).map((h) => h.name));
    const prefixes = source.filter((h) => h.prefix).map((h) => h.name);
    const exists = (h: Hook) =>
      h.prefix ? exact.has(h.name) || [...exact].some((n) => n.startsWith(h.name)) || prefixes.some((p) => p.startsWith(h.name) || h.name.startsWith(p)) : exact.has(h.name) || prefixes.some((p) => h.name.startsWith(p));
    const missing = testHooks().filter((h) => !exists(h)).map((h) => `${h.at} ${h.name}`);
    expect(missing).toEqual([]);
  });
});
