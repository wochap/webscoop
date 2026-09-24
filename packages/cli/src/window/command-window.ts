import { execFile } from 'node:child_process';
import type { WindowPort } from '@webscoop/core';
import type { Env } from '../paths';
import type { Exec, ProviderDef } from './types';

/** How long one provider command may take before it counts as failed. */
export const WINDOW_COMMAND_TIMEOUT_MS = 2000;

export const execShell: Exec = (line, opts) =>
  new Promise((resolve, reject) => {
    execFile('sh', ['-c', line], { timeout: opts.timeoutMs, env: opts.env as NodeJS.ProcessEnv }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if (error.killed) return reject(new Error(`timed out after ${opts.timeoutMs} ms`));
      const detail = stderr.trim().split('\n').pop() || stdout.trim().split('\n').pop();
      reject(new Error(`exited with ${error.code ?? 'an error'}${detail ? ` (${detail})` : ''}`));
    });
  });

/** Values a template may contain; anything else in braces is left alone. */
export interface TemplateVars {
  pid?: number;
  workspace?: string;
}

/** Replace `{pid}` and `{workspace}`; a placeholder without a value is an error. */
export function substitute(template: string, vars: TemplateVars): string {
  return template.replace(/\{(pid|workspace)\}/g, (_, name: keyof TemplateVars) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`no value for {${name}}`);
    return String(value);
  });
}

/** Workspace from a `workspace` command's output: a JSON object's `id` or `name`, else the trimmed text. */
export function parseWorkspace(stdout: string): string {
  const text = stdout.trim();
  let value: unknown = text;
  try {
    const json = JSON.parse(text) as unknown;
    if (json && typeof json === 'object') {
      const { id, name } = json as { id?: unknown; name?: unknown };
      value = id ?? name;
    }
  } catch {
    // Plain text output.
  }
  const workspace = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  // It lands in a shell line; allow only what workspace names look like.
  if (!/^[\w:+-]+$/.test(workspace)) throw new Error(`unexpected workspace ${JSON.stringify(text.slice(0, 60))}`);
  return workspace;
}

export interface CommandWindowOptions {
  /** Provider name, for warnings. */
  name: string;
  def: ProviderDef;
  /** Browser main process id, looked up once on first use; null when not found. */
  pid: () => Promise<number | null>;
  env: Env;
  /** One line to stderr. */
  warn: (message: string) => void;
  exec?: Exec;
  timeoutMs?: number;
}

type Kind = 'prepare' | 'hide' | 'show' | 'focus' | 'workspace';

/**
 * Window port driven by a provider's command templates. Every command is best
 * effort: a failure is reported once per command kind and the run goes on.
 */
export class CommandWindow implements WindowPort {
  private pidLookup: Promise<number | null> | undefined;
  private readonly warned = new Set<Kind | 'pid'>();

  readonly launchArgs: readonly string[];

  constructor(private readonly opts: CommandWindowOptions) {
    this.launchArgs = opts.def.args ?? [];
  }

  async prepare(): Promise<void> {
    if (this.opts.def.prepare) await this.run('prepare', this.opts.def.prepare, {});
  }

  async hide(): Promise<void> {
    const pid = await this.pid();
    if (pid !== null) await this.run('hide', this.opts.def.hide, { pid });
  }

  async show(): Promise<void> {
    const pid = await this.pid();
    if (pid === null) return;
    const vars: TemplateVars = { pid };
    if (this.opts.def.workspace) {
      const out = await this.run('workspace', this.opts.def.workspace, vars);
      if (out === null) return;
      try {
        vars.workspace = parseWorkspace(out);
      } catch (error) {
        this.fail('workspace', error);
        return;
      }
    }
    await this.run('show', this.opts.def.show, vars);
  }

  async focus(): Promise<void> {
    if (!this.opts.def.focus) return;
    const pid = await this.pid();
    if (pid !== null) await this.run('focus', this.opts.def.focus, { pid });
  }

  private async pid(): Promise<number | null> {
    this.pidLookup ??= this.opts.pid().catch(() => null);
    const pid = await this.pidLookup;
    if (pid === null && !this.warned.has('pid')) {
      this.warned.add('pid');
      this.opts.warn(`window provider ${this.opts.name}: the browser process was not found; the window stays visible`);
    }
    return pid;
  }

  /** Run one command; resolves its stdout, or null after reporting the failure. */
  private async run(kind: Kind, template: string, vars: TemplateVars): Promise<string | null> {
    const timeoutMs = this.opts.timeoutMs ?? WINDOW_COMMAND_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      const line = substitute(template, vars);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      return await Promise.race([(this.opts.exec ?? execShell)(line, { timeoutMs, env: this.opts.env }), timeout]);
    } catch (error) {
      this.fail(kind, error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(kind: Kind, error: unknown): void {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    this.opts.warn(`window provider ${this.opts.name}: ${kind} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
