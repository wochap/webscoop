import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { doctorCommand } from './commands/doctor';
import { recipesCommand } from './commands/recipes';
import { runCommand, type RunCommandOptions } from './commands/run';
import { chromiumOverride, type ChromiumInfo, type CliIo } from './context';
import { CliError, ExitCode, type ExitCode as Code } from './exit';

export const VERSION = '0.1.0';

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('expected a non-negative integer (milliseconds)');
  return n;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const EXIT_HELP = `
Exit codes:
  0  success
  1  error to fix or unexpected failure (bad arguments, invalid recipe, no display, browser crash)
  2  run paused for user input and the wait timed out (retry later)
  3  a required field could not be resolved (alert a human)
`;

function buildProgram(io: CliIo, setCode: (code: Code) => void): Command {
  const program = new Command('webscoop')
    .description('Record scrapers by clicking, run them unattended from the command line.')
    .version(VERSION)
    .addHelpText('after', EXIT_HELP)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    })
    .showHelpAfterError('(run webscoop --help for usage)');

  program
    .command('run')
    .description('run a recipe and print the extracted rows')
    .argument('<recipe>', 'recipe name in the recipes directory, or a path to a recipe file')
    .option('--var <name=value>', 'set a URL template variable (repeatable)', collect, [])
    .option('--jsonl', 'print one JSON object per line as rows become available')
    .option('--out <path>', 'write the output to a file instead of stdout')
    .option('--profile <name>', 'browser profile name (default: the recipe name)')
    .addOption(new Option('--timeout <ms>', 'navigation timeout').argParser(positiveInt).default(30_000))
    .addOption(new Option('--lock-timeout <ms>', 'how long to wait for a busy profile').argParser(positiveInt).default(30_000))
    .option('--report', 'print the full run report to stderr')
    .action(async (recipe: string, opts: RunCommandOptions) => setCode(await runCommand(io, recipe, opts)));

  program
    .command('recipes')
    .description('list saved recipes')
    .option('--json', 'print a JSON array')
    .action(async (opts: { json?: boolean }) => setCode(await recipesCommand(io, opts)));

  program
    .command('doctor')
    .description('check paths, display, Chromium, and LLM configuration')
    .action(async () => setCode(await doctorCommand(io)));

  return program;
}

/** Run the CLI with the given arguments (without the node and script entries). Returns the exit code. */
export async function main(args: readonly string[], io: CliIo): Promise<Code> {
  let code: Code = ExitCode.Ok;
  const program = buildProgram(io, (c) => (code = c));
  try {
    await program.parseAsync(args, { from: 'user' });
    return code;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? ExitCode.Ok : ExitCode.Error;
    }
    if (error instanceof CliError) {
      io.stderr.write(`webscoop: ${error.message}\n`);
      return error.exitCode;
    }
    io.stderr.write(`webscoop: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return ExitCode.Error;
  }
}

const execFileAsync = promisify(execFile);

async function probeChromium(path: string, source: ChromiumInfo['source']): Promise<ChromiumInfo> {
  if (!existsSync(path)) return { path, source, installed: false, error: 'not found' };
  try {
    const { stdout } = await execFileAsync(path, ['--version'], { timeout: 15_000 });
    return { path, source, installed: true, version: stdout.trim() };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().split('\n').pop();
    return { path, source, installed: false, error: stderr || (error as Error).message };
  }
}

/** The real world: process streams, environment, Playwright. */
export function defaultIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    homedir: homedir(),
    async createBrowser(config, env) {
      const { PlaywrightBrowser } = await import('@webscoop/browser');
      const executablePath = chromiumOverride(config, env);
      return new PlaywrightBrowser(executablePath ? { executablePath } : {});
    },
    async chromium(config, env) {
      const override = chromiumOverride(config, env);
      if (override) return probeChromium(override, 'override');
      const { expectedChromiumPath } = await import('@webscoop/browser');
      return probeChromium(expectedChromiumPath(), 'playwright');
    },
    onInterrupt(handler) {
      process.on('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    },
  };
}
