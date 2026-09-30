import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/main';
import { testIo } from './helpers';

const FILE = fileURLToPath(new URL('../../../skills/webscoop-use-recipe/SKILL.md', import.meta.url));

/** The `key: value` lines of the YAML frontmatter. */
function frontmatter(text: string): Map<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  return new Map([...block.matchAll(/^(\w+):\s*(.*)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** The skill's code: fenced blocks and inline code spans, where commands are written. */
function code(text: string): string {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g)].map((m) => m[1] ?? m[2]).join('\n');
}

/** Every `webscoop <subcommand> [<subcommand>]` the skill's code mentions that is not defined by the program. */
export function unknownCommands(text: string, program: Command): string[] {
  const unknown = new Set<string>();
  for (const m of code(text).matchAll(/\bwebscoop ([a-z][\w-]*)(?: ([a-z][\w-]*))?/g)) {
    const command = program.commands.find((c) => c.name() === m[1]);
    if (!command) {
      unknown.add(m[1]!);
      continue;
    }
    const sub = m[2];
    if (sub && command.commands.length > 0 && !command.commands.some((c) => c.name() === sub)) unknown.add(`${m[1]} ${sub}`);
  }
  return [...unknown];
}

/** Every `--flag` the skill's code mentions that neither `run` nor `recipes` defines. */
export function unknownFlags(text: string, program: Command): string[] {
  const known = new Set(
    program.commands.filter((c) => c.name() === 'run' || c.name() === 'recipes').flatMap((c) => c.options.map((o) => o.long)),
  );
  return [...new Set([...code(text).matchAll(/(?<![\w-])--[a-z][\w-]*/g)].map((m) => m[0]))].filter((f) => !known.has(f));
}

describe('webscoop-use-recipe skill', () => {
  const text = readFileSync(FILE, 'utf8');
  const program = buildProgram(testIo({}), () => {});

  it('has the required frontmatter', () => {
    const meta = frontmatter(text);
    expect(meta.get('name')).toBe('webscoop-use-recipe');
    expect(meta.get('description')).toBeTruthy();
  });

  it('mentions only commands the CLI defines', () => {
    expect(unknownCommands(text, program)).toEqual([]);
  });

  it('mentions only run and recipes flags the CLI defines', () => {
    expect(unknownFlags(text, program)).toEqual([]);
  });

  it('names a flag the CLI does not define', () => {
    expect(unknownFlags(`${text}\n\`webscoop run x --jsonlines\``, program)).toEqual(['--jsonlines']);
    expect(unknownCommands(`${text}\n\`webscoop scrape x\` \`webscoop daemon kill\``, program)).toEqual(['scrape', 'daemon kill']);
  });
});
