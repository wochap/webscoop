import { spawn } from 'node:child_process';
import { access, constants, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { FilePort, RecipeVar } from '@webscoop/core';
import { configDirOf, expandPath, type Config, type VarBinding } from './config';
import { CliError } from './exit';

/** Longest a `--var-command` or config `command` source may run. */
export const VAR_COMMAND_TIMEOUT_MS = 30_000;

/** The `--var`, `--var-file`, and `--var-command` flags, each `name=...`. */
export interface VarSources {
  var: readonly string[];
  varFile?: readonly string[];
  varCommand?: readonly string[];
}

/** Where a variable's value came from. */
export type VarOrigin = 'cli' | 'config';

/** Values resolved before the browser opens; defaults are left to the recipe. */
export interface ResolvedVars {
  values: Record<string, string>;
  /** Names of the recipe's secret variables. */
  secrets: string[];
  origins: Record<string, VarOrigin>;
}

/** Run `command` with `/bin/sh -c`; its stdout, or a rejection that never holds the output. */
export type VarCommandRunner = (command: string, cwd: string, timeoutMs: number) => Promise<string>;

export const runVarCommand: VarCommandRunner = (command, cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(`cannot start (${error.code ?? 'error'})`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(code !== null ? `exit status ${code}` : `killed by ${signal}`));
    });
  });

type Source = { kind: 'value'; value: string } | { kind: 'file'; path: string } | { kind: 'command'; command: string; cwd: string };

function split(flag: string, pair: string): [string, string] {
  const eq = pair.indexOf('=');
  if (eq <= 0) throw new CliError(`invalid ${flag} "${pair}", expected name=${flag === '--var' ? 'value' : flag === '--var-file' ? 'PATH' : 'CMD'}`);
  return [pair.slice(0, eq), pair.slice(eq + 1)];
}

/** Command line sources per variable; two for one variable is an error naming it. */
export function cliSources(sources: VarSources, cwd: string): Map<string, Source> {
  const out = new Map<string, Source>();
  const add = (name: string, source: Source) => {
    if (out.has(name)) throw new CliError(`variable "${name}" is given more than once on the command line; pass one of --var, --var-file, --var-command`);
    out.set(name, source);
  };
  for (const pair of sources.var) {
    const [name, value] = split('--var', pair);
    add(name, { kind: 'value', value });
  }
  for (const pair of sources.varFile ?? []) {
    const [name, path] = split('--var-file', pair);
    add(name, { kind: 'file', path: expandPath(path, cwd, homedir()) });
  }
  for (const pair of sources.varCommand ?? []) {
    const [name, command] = split('--var-command', pair);
    add(name, { kind: 'command', command, cwd });
  }
  return out;
}

function bindingSource(binding: VarBinding, configDir: string): Source {
  if (binding.value !== undefined) return { kind: 'value', value: binding.value };
  if (binding.file !== undefined) return { kind: 'file', path: binding.file };
  return { kind: 'command', command: binding.command!, cwd: configDir };
}

async function read(name: string, origin: VarOrigin, source: Source, run: VarCommandRunner): Promise<string> {
  const where = origin === 'cli' ? 'command line' : 'config';
  if (source.kind === 'value') return source.value;
  if (source.kind === 'file') {
    try {
      return (await readFile(source.path, 'utf8')).replace(/\r?\n$/, '');
    } catch (error) {
      throw new CliError(`variable "${name}": cannot read the ${where} file source ${source.path} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
  try {
    return (await run(source.command, source.cwd, VAR_COMMAND_TIMEOUT_MS)).trim();
  } catch (error) {
    throw new CliError(`variable "${name}": the ${where} command source failed: ${(error as Error).message}`);
  }
}

/**
 * Values for a recipe's variables from the command line, then the config's
 * `vars.<recipe>` bindings; defaults stay with the recipe. With a recipe, only
 * its declared variables are read; without one (a new recording), every
 * command line source is.
 */
export async function resolveVars(
  recipe: { name: string; vars: readonly RecipeVar[] } | undefined,
  sources: VarSources,
  config: Config,
  cwd: string,
  run: VarCommandRunner = runVarCommand,
): Promise<ResolvedVars> {
  const cli = cliSources(sources, cwd);
  const declared = recipe ? new Set(recipe.vars.map((v) => v.name)) : undefined;
  const bindings = recipe ? (config.vars?.[recipe.name] ?? {}) : {};
  const configDir = configDirOf(config) ?? cwd;
  const out: ResolvedVars = { values: {}, secrets: recipe ? recipe.vars.filter((v) => v.secret).map((v) => v.name) : [], origins: {} };
  const names = declared ? [...declared] : [...cli.keys()];
  for (const name of names) {
    const fromCli = cli.get(name);
    const binding = bindings[name];
    if (fromCli) {
      out.values[name] = await read(name, 'cli', fromCli, run);
      out.origins[name] = 'cli';
    } else if (binding) {
      out.values[name] = await read(name, 'config', bindingSource(binding, configDir), run);
      out.origins[name] = 'config';
    }
  }
  // Literal `--var` values for names the recipe does not declare keep today's behavior: later checks name them.
  if (declared) for (const [name, source] of cli) if (!declared.has(name) && source.kind === 'value') out.values[name] = source.value;
  return out;
}

/** Host files for `path` variables: relative paths resolve against `cwd`, the submitting command's directory. */
export function hostFiles(cwd: string): FilePort {
  return {
    resolve: (path) => expandPath(path, cwd, homedir()),
    readable: async (path) => {
      try {
        await access(path, constants.R_OK);
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
  };
}
