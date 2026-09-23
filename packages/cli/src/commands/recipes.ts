import type { CliIo } from '../context';
import { log } from '../context';
import { ExitCode, type ExitCode as Code } from '../exit';
import { resolvePaths } from '../paths';
import { FsStorage } from '../storage';

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => r[col]!.length)));
  return rows.map((r) => r.map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col]!))).join('  ')).join('\n');
}

export async function recipesCommand(io: CliIo, opts: { json?: boolean }): Promise<Code> {
  const paths = resolvePaths(io.env, io.homedir);
  const storage = new FsStorage(paths.recipesDir, io.cwd);
  const recipes = await storage.list();
  for (const warning of storage.warnings) log(io, `warning: skipping ${warning.split('\n')[0]}`);
  if (opts.json) {
    const out = recipes.map((r) => ({
      name: r.name,
      url: r.url,
      fields: r.fieldCount,
      modified: r.modified.toISOString(),
      path: r.path,
    }));
    if (out.length > 0) io.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return ExitCode.Ok;
  }
  if (recipes.length === 0) return ExitCode.Ok;
  const rows = [
    ['NAME', 'FIELDS', 'MODIFIED', 'URL'],
    ...recipes.map((r) => [r.name, String(r.fieldCount), r.modified.toISOString().replace(/\.\d+Z$/, 'Z'), r.url]),
  ];
  io.stdout.write(`${table(rows)}\n`);
  return ExitCode.Ok;
}
