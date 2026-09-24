import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scoop } from './fixtures';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const TSX = join(root, 'node_modules/.bin/tsx');

/** Interpreter for exported Python scripts; `WEBSCOOP_E2E_PYTHON` points at one with Playwright installed. */
export const PYTHON = process.env.WEBSCOOP_E2E_PYTHON?.trim() || 'python3';

/** Whether the Python interpreter can import Playwright, so the Python cases can run. */
export const hasPythonPlaywright = (() => {
  try {
    execFileSync(PYTHON, ['-c', 'import playwright'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

export type ExportFormat = 'ts' | 'py';

export interface ExportedRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Rows parsed from stdout: a JSON array, or JSONL with `--jsonl`; empty when stdout is. */
  rows: Record<string, unknown>[];
  /** Temporary directories the script left behind in its TMPDIR (its profile should be gone). */
  leftovers: string[];
  /** Directory that held the exported file; removed before this returns. */
  scratch: string;
}

/**
 * Export a recipe with the built CLI to a file inside the repository (so the
 * `playwright` package resolves), run it headless with `npx tsx` or Python
 * against the playground, and remove the file and the script's temporary
 * directory afterwards.
 */
export async function exportAndRun(scoop: Scoop, recipe: string, format: ExportFormat, args: string[] = []): Promise<ExportedRun> {
  await mkdir(join(root, 'test-results'), { recursive: true });
  const dir = await mkdtemp(join(root, 'test-results', 'export-e2e-'));
  let tmp: string | undefined;
  try {
    const file = join(dir, `${recipe.replace(/-/g, '_')}.${format}`);
    const exported = await scoop.run(['export', recipe, '--format', format, '--out', file, '--headless']);
    if (exported.code !== 0) throw new Error(`webscoop export failed (${exported.code}): ${exported.stderr}`);

    // The script's temporary profile lands here, so the test can see that it was removed. Kept
    // under the system temporary directory: Chromium puts sockets in TMPDIR, and their paths are short.
    tmp = await mkdtemp(join(tmpdir(), 'ws-export-e2e-'));
    const [command, first] = format === 'ts' ? [TSX, file] : [PYTHON, file];
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(command, [first, ...args], { cwd: root, env: { ...process.env, TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      child.on('close', (code) => done({ code, stdout, stderr }));
    });
    const leftovers = (await readdir(tmp)).filter((name) => name.startsWith('webscoop-export-'));
    const text = result.stdout.trim();
    const rows = text === '' ? [] : args.includes('--jsonl') ? text.split('\n').map((line) => JSON.parse(line)) : JSON.parse(text);
    return { ...result, rows, leftovers, scratch: dir };
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}
