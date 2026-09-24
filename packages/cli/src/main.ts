import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { benchCommand, type BenchCommandOptions } from './commands/bench';
import { doctorCommand } from './commands/doctor';
import { recipesCommand } from './commands/recipes';
import { recordCommand, type RecordCommandOptions } from './commands/record';
import { runCommand, testCommand, type RunCommandOptions, type TestCommandOptions } from './commands/run';
import { loadRecorderBundle } from './bundle';
import { chromiumOverride, type ChromiumInfo, type CliIo } from './context';
import { NotifySend } from './notify';
import { CliError, ExitCode, type ExitCode as Code } from './exit';

export const VERSION = '0.1.0';

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('expected a non-negative integer (milliseconds)');
  return n;
}

/** `--pages`: `all` or a positive integer. */
export function pagesArg(value: string): number | 'all' {
  if (value === 'all') return 'all';
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < 1) throw new InvalidArgumentError('expected "all" or a positive integer');
  return n;
}

/** `--max-pages`: a positive integer. */
export function maxPagesArg(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1) throw new InvalidArgumentError('expected a positive integer');
  return n;
}

function seedInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('expected a non-negative integer');
  return n;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const EXIT_HELP = `
Healing:
  run heals selectors that stopped matching and rewrites the recipe after a
  successful run. --no-save keeps the file, --no-heal tries only the first
  selector, --no-llm skips the language model rung, --interactive asks you to
  re-pick a field nothing else could find.
  test <recipe> checks a recipe without saving; record --edit <recipe>
  --repick <field> picks one field again.

Exit codes:
  0  success
  1  error to fix or unexpected failure (bad arguments, invalid recipe, no display, browser crash)
  2  run paused on a login wall, bot check, or interstitial and nobody cleared it
     within --guard-timeout (retry later; rows of completed pages are kept)
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
    .option('--no-heal', 'try only the first stored selector per target; never heal or rewrite the recipe')
    .option('--no-save', 'heal, but do not write the healed selectors back to the recipe file')
    .option('--interactive', 'when a required field cannot be healed, show the re-pick panel and wait for you instead of exiting 3')
    .option('--no-llm', 'never ask the language model to locate a field, whatever the config and recipe say')
    .addOption(new Option('--pages <1|N|all>', 'pages to walk, replacing the recipe limit').argParser(pagesArg))
    .addOption(new Option('--max-pages <n>', 'most pages "all" walks').argParser(maxPagesArg).default(500))
    .addOption(new Option('--delay <ms>', 'wait between pages, replacing the recipe delay').argParser(positiveInt))
    .addOption(new Option('--guard-timeout <ms>', 'longest total wait for you to clear login walls and bot checks before exiting 2 (default: 600000)').argParser(positiveInt))
    .option('--no-guards', 'never pause on login walls, bot checks, or interstitials; treat them like any other page')
    .option('--no-notify', 'do not send a desktop notification when a guard pauses the run')
    .option('--skip-steps', "replay none of the recipe's steps (clicks, typing) before extracting, for debugging")
    .addHelpText(
      'after',
      `
Guards: when a page asks for a human (a login redirect, a bot check, or a
short or errored page where nothing resolves), the run brings the browser
window to the front, sends a desktop notification, and waits for you to clear
it, then resumes on the same page. With --interactive a banner over the page
shows a countdown with Continue and Abort. Nobody within --guard-timeout: exit 2.

Steps: actions recorded in the recipe (accept a cookie banner, type a search,
open a tab) are replayed after the first page loads, and after every page for
steps marked every-page. A step whose element is gone is skipped when it is
optional and fails the run with exit 3 when it is not.

Pagination: the recipe says how to reach the next page (a page number in the
URL, a next link, a load-more button, or infinite scroll) and how many pages
to walk. Rows repeated from an earlier page are dropped. With --jsonl, rows
are printed as each page completes.

Healing: when stored selectors stop matching, the run tries the other stored
selectors, then the element that best matches the field's fingerprint, then
(when an LLM endpoint is configured and the recipe allows it) asks the model
to pick the element from a short list. Fields resolved that way are reported
as "healed", and after a successful run the recipe file is rewritten with the
working selector first (unless --no-save).`,
    )
    .action(async (recipe: string, opts: RunCommandOptions) => setCode(await runCommand(io, recipe, opts)));

  program
    .command('test')
    .description('check a recipe on its first page: heal without saving and print each field\'s status')
    .argument('<recipe>', 'recipe name in the recipes directory, or a path to a recipe file')
    .option('--var <name=value>', 'set a URL template variable (repeatable)', collect, [])
    .option('--profile <name>', 'browser profile name (default: the recipe name)')
    .addOption(new Option('--timeout <ms>', 'navigation timeout').argParser(positiveInt).default(30_000))
    .addOption(new Option('--lock-timeout <ms>', 'how long to wait for a busy profile').argParser(positiveInt).default(30_000))
    .option('--json', 'print the field table as a JSON array')
    .option('--no-llm', 'never ask the language model to locate a field')
    .addOption(new Option('--pages <1|N|all>', 'pages to walk (default: the first page only)').argParser(pagesArg))
    .addOption(new Option('--max-pages <n>', 'most pages "all" walks').argParser(maxPagesArg).default(500))
    .addOption(new Option('--delay <ms>', 'wait between pages, replacing the recipe delay').argParser(positiveInt))
    .addOption(new Option('--guard-timeout <ms>', 'how long to wait for you to clear a login wall or bot check (default: 0, exit 2 at once)').argParser(positiveInt))
    .option('--no-guards', 'never pause on login walls, bot checks, or interstitials')
    .option('--no-notify', 'do not send a desktop notification when a guard is raised')
    .option('--skip-steps', "replay none of the recipe's steps, which test replays like a run by default")
    .addHelpText('after', '\nPrints no rows. Exits 0 when every required field resolved, 3 when one did not, 2 on an uncleared guard, 1 on error.')
    .action(async (recipe: string, opts: TestCommandOptions) => setCode(await testCommand(io, recipe, opts)));

  program
    .command('record')
    .description('record a recipe by clicking in a browser window')
    .argument('[url-template]', 'page to record; {name} marks a variable, e.g. "https://shop.test/c/{category}"')
    .option('--name <recipe>', 'recipe name (default: proposed from the URL host and path)')
    .option('--var <name=value>', 'set a URL template variable (repeatable); missing ones are asked for', collect, [])
    .option('--profile <name>', 'browser profile name (default: the recipe name)')
    .option('--edit <recipe>', 'edit an existing recipe, by name or path, instead of starting from a URL')
    .option('--repick <field>', 'with --edit: pick a new location for one field, save, and exit')
    .addOption(new Option('--timeout <ms>', 'navigation timeout').argParser(positiveInt).default(30_000))
    .addOption(new Option('--lock-timeout <ms>', 'how long to wait for a busy profile').argParser(positiveInt).default(30_000))
    .addHelpText(
      'after',
      `
In the browser: p picks an element, Esc cancels, Enter confirms the found items,
Left and Right walk the element's ancestors, Alt+Up and Alt+Down reorder fields,
Ctrl+S saves. Close the window or press Ctrl+C here to end the session.
With --repick: click the field's new location, then "Use and save"; S skips, Esc aborts.`,
    )
    .action(async (template: string | undefined, opts: RecordCommandOptions) => setCode(await recordCommand(io, template, opts)));

  program
    .command('recipes')
    .description('list saved recipes')
    .option('--json', 'print a JSON array')
    .action(async (opts: { json?: boolean }) => setCode(await recipesCommand(io, opts)));

  program
    .command('bench')
    .description('run a playground recipe on every playground tier and report which rung resolved each field')
    .argument('<recipe>', 'recipe with a {port} variable, e.g. the playground-catalog fixture')
    .option('--tiers <range>', 'tiers to run, e.g. 0-4, 3, or 0,3-4', '0-4')
    .addOption(new Option('--seed <n>', 'playground seed').argParser(seedInt).default(1))
    .option('--json', 'print the results as JSON')
    .option('--profile <name>', 'browser profile name (default: the recipe name)')
    .option('--no-llm', 'never ask the language model to locate a field')
    .addOption(new Option('--timeout <ms>', 'navigation timeout').argParser(positiveInt).default(30_000))
    .addOption(new Option('--lock-timeout <ms>', 'how long to wait for a busy profile').argParser(positiveInt).default(30_000))
    .addHelpText(
      'after',
      `
Starts the playground on a free port, fills the recipe's {port} (and {tier}
and {seed}, when the recipe has them) and runs it once per tier without
writing anything back. Rungs: candidate, fuzzy, model, user, unresolved.
Exits 0 whatever healed, 1 when a run broke. Needs a development checkout.`,
    )
    .action(async (recipe: string, opts: BenchCommandOptions) => setCode(await benchCommand(io, recipe, opts)));

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
    async prompt(question) {
      if (!process.stdin.readable) return null;
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
      const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
      try {
        return await Promise.race([rl.question(question), closed]);
      } finally {
        rl.close();
      }
    },
    recorderBundle: loadRecorderBundle,
    createNotify: (env) => new NotifySend({ stderr: process.stderr, env }),
  };
}
