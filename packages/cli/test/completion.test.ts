import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/main';
import { testIo } from './helpers';

const FILE = fileURLToPath(new URL('../completions/_webscoop', import.meta.url));

/** The text of each `# command: <name>` block, keyed by name; `''` holds everything before the first marker. */
function sections(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const parts = text.split(/^\s*# command: (\S+)\s*$/m);
  map.set('', parts[0] ?? '');
  for (let i = 1; i < parts.length; i += 2) map.set(parts[i]!, parts[i + 1] ?? '');
  return map;
}

function hasZsh(): boolean {
  return spawnSync('zsh', ['-c', 'true']).status === 0;
}

describe('zsh completion', () => {
  const text = readFileSync(FILE, 'utf8');

  it('covers every command and option of the CLI', () => {
    const program = buildProgram(testIo({}), () => {});
    const blocks = sections(text);
    const arrays = new Map([...text.matchAll(/^\s*(\w+_opts)=\(([\s\S]*?)^\s*\)$/gm)].map((m) => [m[1]!, m[2]!]));
    const missing: string[] = [];
    for (const command of program.commands) {
      const name = command.name();
      if (!blocks.get('')!.includes(`'${name}:`)) missing.push(`command ${name} (top-level list)`);
      const block = blocks.get(name);
      if (block === undefined) {
        missing.push(`command ${name} (no "# command: ${name}" block)`);
        continue;
      }
      // Shared option arrays are defined once; a block counts the ones it expands.
      const scope = [block, ...[...block.matchAll(/\$(\w+_opts)\b/g)].map((m) => arrays.get(m[1]!) ?? '')].join('\n');
      for (const option of command.options) {
        for (const flag of [option.long, option.short]) {
          if (flag && !new RegExp(`[\\s'"(){},*]${flag}[\\[,}]`).test(scope)) missing.push(`${name} ${flag}`);
        }
      }
    }
    expect(missing, `missing from ${FILE}:\n${missing.join('\n')}`).toEqual([]);
  });

  it('offers show and hide for browser, and no window flags', () => {
    const block = sections(text).get('browser') ?? '';
    expect(block).toMatch(/show\\:/);
    expect(block).toMatch(/hide\\:/);
    expect(text).not.toMatch(/--(show|hide)\[/);
  });

  it.skipIf(!hasZsh())('parses with zsh -n', () => {
    execFileSync('zsh', ['-n', FILE]);
  });
});
