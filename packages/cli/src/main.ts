import { openSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ReadStream, WriteStream } from 'node:tty';
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { benchCommand, type BenchCommandOptions } from './commands/bench';
import { browserCommand, type BrowserCommandOptions } from './commands/browser';
import { attentionCommand, daemonStatusCommand, daemonStopCommand } from './commands/daemon';
import { doctorCommand } from './commands/doctor';
import { exportCommand, type ExportCommandOptions } from './commands/export';
import { recipesCommand } from './commands/recipes';
import { recordCommand, type RecordCommandOptions } from './commands/record';
import { runCommand, testCommand, type RunCommandOptions, type TestCommandOptions } from './commands/run';
import { loadRecorderBundle } from './bundle';
import { probeVersion, resolveBrowser } from './browser';
import type { CliIo, TtyPort } from './context';
import { daemonLogPath, socketPath } from './daemon/paths';
import { connectSocket, serveDaemon, spawnDaemon } from './daemon/socket';
import { NotifySend } from './notify';
import { findBrowserPid } from './browser-pid';
import { CliError, ExitCode, reportError, type ExitCode as Code } from './exit';
import { VERSION } from './version';

export { VERSION };

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

/** `--proxy <url>` and `--no-proxy`, which share the `proxy` value and may not be passed together. */
function proxyOptions(command: Command): Command {
  const seen = new Set<string>();
  const note = (flag: string) => () => {
    seen.add(flag);
    if (seen.size === 2) command.error('error: option --proxy <url> cannot be used with option --no-proxy');
  };
  return command
    .option('--proxy <url>', 'route the browser through this proxy (http, https, or socks5 URL), replacing the recipe and config proxy')
    .option('--no-proxy', 'connect directly, whatever the recipe and config say')
    .on('option:proxy', note('proxy'))
    .on('option:no-proxy', note('no-proxy'));
}

/** `--humanize` and `--no-humanize`, which share the `humanize` value and may not be passed together. */
function humanizeOptions(command: Command): Command {
  const seen = new Set<string>();
  const note = (flag: string) => () => {
    seen.add(flag);
    if (seen.size === 2) command.error('error: option --humanize cannot be used with option --no-humanize');
  };
  return command
    .option('--humanize', 'move, type, and scroll like a person (slower), whatever the recipe and config say')
    .option('--no-humanize', 'act at full speed, whatever the recipe and config say')
    .on('option:humanize', note('humanize'))
    .on('option:no-humanize', note('no-humanize'));
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

/** In-browser keys, shared by `record` and `edit`. */
const RECORD_KEYS_HELP = `
In the browser: p picks an element, Esc cancels, Enter confirms the found items,
Left and Right walk the element's ancestors, Alt+Up and Alt+Down reorder fields,
Ctrl+S saves. Close the window or press Ctrl+C here to end the session.
With --repick: click the field's new location, then "Use and save"; S skips, Esc aborts.`;

export function buildProgram(io: CliIo, setCode: (code: Code) => void): Command {
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

  humanizeOptions(proxyOptions(program.command('run')))
    .description('run a recipe and print the extracted rows')
    .argument('<recipe>', 'recipe name in the recipes directory, or a path to a recipe file')
    .option('--var <name=value>', 'set a URL template variable (repeatable)', collect, [])
    .option('--jsonl', 'print one JSON object per line as rows become available')
    .option('--out <path>', 'write the output to a file instead of stdout; a directory (existing, or ending with /) gets one file per table')
    .option('--table <name>', 'print only this table of a multi-table recipe, as a plain array (or plain JSONL rows)')
    .option('--profile <name>', 'browser profile name (default: resolved from recipe and config)')
    .addOption(new Option('--timeout <ms>', 'navigation timeout').argParser(positiveInt).default(30_000))
    .addOption(new Option('--queue-timeout <ms>', 'give up (exit 1) when the job has not started within this time (default: wait until it starts)').argParser(positiveInt))
    .option('--report', 'print the full run report to stderr')
    .option('-q, --quiet', 'print only errors and prompts to act on stderr')
    .option('--no-heal', 'try only the first stored selector per target; never heal or rewrite the recipe')
    .option('--no-save', 'heal, but do not write the healed selectors back to the recipe file')
    .option('--interactive', 'when a required field cannot be healed, show the re-pick panel and wait for you instead of exiting 3')
    .option('--no-llm', 'never ask the language model to locate a field, whatever the config and recipe say')
    .addOption(new Option('--pages <1|N|all>', 'pages to walk, replacing the recipe limit').argParser(pagesArg))
    .addOption(new Option('--max-pages <n>', 'most pages "all" walks').argParser(maxPagesArg).default(500))
    .addOption(new Option('--delay <ms>', 'wait between pages, replacing the recipe delay').argParser(positiveInt))
    .addOption(new Option('--guard-timeout <ms>', 'longest total wait for you to clear login walls and bot checks before exiting 2 (default: 600000)').argParser(positiveInt))
    .option('--no-guards', 'never pause on login walls, bot checks, or interstitials; treat them like any other page')
    .option('--notify', 'send a desktop notification when a guard pauses the run, whatever the config says')
    .option('--no-notify', 'do not send a desktop notification when a guard pauses the run')
    .option('--skip-flows', "run none of the recipe's flows, called or reactive; only extract and paginate, for debugging")
    .addHelpText(
      'after',
      `
Hooks: commands in the config "hooks" block run on lifecycle events, such as
attention.needed when a guard or a re-pick needs you in the browser; use them
to hide and show the window with your window manager.

Daemon: run and test execute in a background daemon that keeps one browser
per profile warm and runs each job in its own tab. daemon.concurrency in the
config sets how many jobs a browser runs at once (default 1); the others wait
in order. --queue-timeout gives up on a job that has not started in time.

Guards: when a page asks for a human (a login redirect, a bot check, or a
short or errored page where nothing resolves), the run waits until no other
run of its browser needs you, reloads to check whether the guard is still
there, then brings its tab to the front, sends a desktop notification, and
shows a banner over the page with a countdown, Continue, and Abort
(guards.banner: false turns it off). Answer in the page, at the Solved?
[Y/n/a] prompt on the terminal, or with webscoop attention continue|abort.
Nobody within --guard-timeout: exit 2.

Flows: named lists of steps recorded in the recipe (accept a cookie banner,
fill a search, open a tab). The recipe's sequence says where each called flow
runs: before an extract, or inside the paginate block on every page. A
reactive flow runs whenever its trigger element appears, in any window. A step
whose element is gone is skipped when it is optional and fails the run with
exit 3 when it is not. An await-user step waits for you in the browser like a
guard.

Pagination: the recipe says how to reach the next page (a page number in the
URL, a next link, a load-more button, or infinite scroll) and how many pages
to walk. Rows repeated from an earlier page are dropped. With --jsonl, rows
are printed as each page completes.

Tables: a recipe with several tables prints one JSON object keyed by table
name, each holding that table's rows; with --jsonl every row carries _table.
--table <name> prints one table in the plain shapes. --out ./dir/ writes
<table>.json (or <table>.jsonl) per table; a path that does not exist and
does not end with / is a file.

Healing: when stored selectors stop matching, the run tries the other stored
selectors, then the element that best matches the field's fingerprint, then
(when an LLM endpoint is configured and the recipe allows it) asks the model
to pick the element from a short list. Fields resolved that way are reported
as "healed", and after a successful run the recipe file is rewritten with the
working selector first (unless --no-save).`,
    )
    .action(async (recipe: string, opts: RunCommandOptions) => setCode(await runCommand(io, recipe, opts)));

  humanizeOptions(proxyOptions(program.command('test')))
    .description('check a recipe on its first page: heal without saving and print each field\'s status')
    .argument('<recipe>', 'recipe name in the recipes directory, or a path to a recipe file')
    .option('--var <name=value>', 'set a URL template variable (repeatable)', collect, [])
    .option('--profile <name>', 'browser profile name (default: resolved from recipe and config)')
    .addOption(new Option('--timeout <ms>', 'navigation timeout').argParser(positiveInt).default(30_000))
    .addOption(new Option('--queue-timeout <ms>', 'give up (exit 1) when the job has not started within this time (default: wait until it starts)').argParser(positiveInt))
    .option('--json', 'print the field table as a JSON array')
    .option('--no-llm', 'never ask the language model to locate a field')
    .addOption(new Option('--pages <1|N|all>', 'pages to walk (default: the first page only)').argParser(pagesArg))
    .addOption(new Option('--max-pages <n>', 'most pages "all" walks').argParser(maxPagesArg).default(500))
    .addOption(new Option('--delay <ms>', 'wait between pages, replacing the recipe delay').argParser(positiveInt))
    .addOption(new Option('--guard-timeout <ms>', 'how long to wait for you to clear a login wall or bot check (default: 0, exit 2 at once)').argParser(positiveInt))
    .option('--no-guards', 'never pause on login walls, bot checks, or interstitials')
    .option('--notify', 'send a desktop notification when a guard is raised, whatever the config says')
    .option('--no-notify', 'do not send a desktop notification when a guard is raised')
    .option('--skip-flows', "run none of the recipe's flows, which test runs like a run by default")
    .addHelpText('after', '\nPrints no rows. Exits 0 when every required field resolved, 3 when one did not, 2 on an uncleared guard, 1 on error.')
    .action(async (recipe: string, opts: TestCommandOptions) => setCode(await testCommand(io, recipe, opts)));

  proxyOptions(program.command('record'))
    .description('record a recipe by clicking in a browser window')
    .argument('[url-template]', 'page to record; {name} marks a variable, e.g. "https://shop.test/c/{category}"')
    .option('--name <recipe>', 'recipe name (default: proposed from the URL host and path)')
    .option('--var <name=value>', 'set a URL template variable (repeatable); missing ones are asked for', collect, [])
    .option('--profile <name>', 'browser profile name (default: resolved from recipe and config)')
    .option('--edit <recipe>', 'edit an existing recipe, by name or path, instead of starting from a URL')
    .option('--repick <field>', 'with --edit: pick a new location for one field (table.field, or a name one table has), save, and exit')
    .addOption(new Option('--timeout <ms>', 'navigation timeout').argParser(positiveInt).default(30_000))
    .addOption(new Option('--lock-timeout <ms>', 'how long to wait for a busy profile').argParser(positiveInt).default(30_000))
    .option('--force', 'stop the daemon browser on the profile, and its jobs, without asking')
    .addHelpText(
      'after',
      RECORD_KEYS_HELP,
    )
    .action(async (template: string | undefined, opts: RecordCommandOptions) => setCode(await recordCommand(io, template, opts)));

  proxyOptions(program.command('edit'))
    .description('edit an existing recipe in a browser window (same as record --edit)')
    .argument('<recipe>', 'recipe name in the recipes directory, or a path to a recipe file')
    .option('--repick <field>', 'pick a new location for one field (table.field, or a name one table has), save, and exit')
    .option('--var <name=value>', 'set a URL template variable (repeatable); missing ones are asked for', collect, [])
    .option('--profile <name>', 'browser profile name (default: resolved from recipe and config)')
    .addOption(new Option('--timeout <ms>', 'navigation timeout').argParser(positiveInt).default(30_000))
    .addOption(new Option('--lock-timeout <ms>', 'how long to wait for a busy profile').argParser(positiveInt).default(30_000))
    .option('--force', 'stop the daemon browser on the profile, and its jobs, without asking')
    .addHelpText('after', RECORD_KEYS_HELP)
    .action(async (recipe: string, opts: Omit<RecordCommandOptions, 'edit'>) => setCode(await recordCommand(io, undefined, { ...opts, edit: recipe })));

  program
    .command('recipes')
    .description('list saved recipes')
    .option('--json', 'print a JSON array')
    .action(async (opts: { json?: boolean }) => setCode(await recipesCommand(io, opts)));

  program
    .command('export')
    .description('write a standalone Playwright script (TypeScript or Python) that runs the recipe without webscoop')
    .argument('<recipe>', 'recipe name in the recipes directory, or a path to a recipe file')
    .option('--format <ts|py>', 'script language: ts (Node, run with npx tsx) or py (Python sync API)', 'ts')
    .option('--out <path>', 'write the script to a file instead of stdout')
    .option('--headless', 'make the script run without a browser window unless it is given --headed')
    .addHelpText(
      'after',
      `
The script takes --var name=value (or WEBSCOOP_VAR_<NAME>), --jsonl, --out,
--table <name>, --pages <1|N|all>, --headless, --headed, and --profile <dir>,
prints rows like webscoop run (a recipe with several tables prints one JSON
object keyed by table name, JSONL rows carry _table, and --out ./dir/ writes
one file per table), and exits 0, 1, or 3 like it. It tries the stored selector
candidates in order and nothing more: no fingerprint or model healing, no
guards, no notifications, no hooks, no recipe write-back. Re-record
and export again when the site changes. Needs no display.`,
    )
    .action(async (recipe: string, opts: ExportCommandOptions) => setCode(await exportCommand(io, recipe, opts, VERSION)));

  humanizeOptions(proxyOptions(program.command('bench')))
    .description('run a playground recipe on every playground tier and report which rung resolved each field')
    .argument('<recipe>', 'recipe with a {port} variable, e.g. the playground-catalog fixture')
    .option('--tiers <range>', 'tiers to run, e.g. 0-4, 3, or 0,3-4', '0-4')
    .addOption(new Option('--seed <n>', 'playground seed').argParser(seedInt).default(1))
    .option('--json', 'print the results as JSON')
    .option('--profile <name>', 'browser profile name (default: resolved from recipe and config)')
    .option('--no-llm', 'never ask the language model to locate a field')
    .addOption(new Option('--timeout <ms>', 'navigation timeout').argParser(positiveInt).default(30_000))
    .addOption(new Option('--lock-timeout <ms>', 'how long to wait for a busy profile').argParser(positiveInt).default(30_000))
    .option('--force', 'stop the daemon browser on the profile, and its jobs, without asking')
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
    .command('browser')
    .description('fire the browser.show or browser.hide hooks for the browser running on a profile')
    .addArgument(new Argument('<action>', 'show or hide').choices(['show', 'hide']))
    .option('--profile <name>', 'browser profile name (default: profiles.default from the config, else default)')
    .addHelpText(
      'after',
      `
Finds the running browser of the profile and runs the configured hooks for
browser.show or browser.hide with WEBSCOOP_BROWSER_PID set, for example to
bring a hidden browser back from a key binding. Exits 1 when no browser runs
on the profile.`,
    )
    .action(async (action: 'show' | 'hide', opts: BrowserCommandOptions) => setCode(await browserCommand(io, action, opts)));

  const daemon = program
    .command('daemon')
    .description('show or stop the background daemon that runs run and test jobs')
    .addHelpText(
      'after',
      `
status prints whether a daemon runs, its pid and version, and per browser the
profile, the browser process id, the running and queued runs, and the run
holding attention; it exits 0 either way. stop makes the daemon refuse new
jobs, waits for the others (or cancels them with --force), closes every
browser, and exits.`,
    );
  daemon
    .command('status')
    .description('print whether a daemon runs, and its browsers and jobs')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => setCode(await daemonStatusCommand(io, opts)));
  daemon
    .command('stop')
    .description('stop the daemon after its jobs end, closing every browser')
    .option('--force', 'cancel running and queued jobs instead of waiting for them')
    .action(async (opts: { force?: boolean }) => setCode(await daemonStopCommand(io, opts)));
  daemon
    .command('serve', { hidden: true })
    .description('run the daemon in the foreground; started by run and test')
    .action(async () => {
      if (!io.serveDaemon) throw new CliError('cannot serve a daemon here');
      setCode(await io.serveDaemon());
    });

  program
    .command('attention')
    .description('answer the run waiting for you in the browser: continue re-checks its guard now, abort ends it')
    .addArgument(new Argument('<action>', 'continue or abort').choices(['continue', 'abort']))
    .argument('[run-id]', 'the run to answer (default: the only run holding attention)')
    .addHelpText('after', '\nExits 1 listing the run ids when none or several runs hold attention and no run id is given.')
    .action(async (action: 'continue' | 'abort', runId: string | undefined) => setCode(await attentionCommand(io, action, runId)));

  program
    .command('doctor')
    .description('check paths, display, browser, proxy, profiles, hooks, and LLM configuration')
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
    return reportError(io, error);
  }
}

/** The controlling terminal, opened for the attention prompt when standard error is one. */
function openTty(): TtyPort | null {
  if (!process.stderr.isTTY) return null;
  let input: ReadStream;
  let output: WriteStream;
  try {
    input = new ReadStream(openSync('/dev/tty', 'r'));
    output = new WriteStream(openSync('/dev/tty', 'w'));
  } catch {
    return null;
  }
  const rl = createInterface({ input, terminal: false });
  return {
    write: (text) => void output.write(text),
    onLine(cb) {
      rl.on('line', cb);
      return () => void rl.off('line', cb);
    },
    close() {
      rl.close();
      input.destroy();
      output.destroy();
    },
  };
}

/** The real world: process streams, environment, Playwright. */
export function defaultIo(): CliIo {
  const programPath = resolve(process.argv[1] ?? 'webscoop');
  const socket = () => socketPath(process.env, process.getuid?.() ?? 0);
  const logPath = () => daemonLogPath(process.env, homedir());
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    homedir: homedir(),
    async createBrowser(_config, _env, browser) {
      const { PlaywrightBrowser } = await import('@webscoop/browser');
      return new PlaywrightBrowser({ driver: browser.driver, ...(browser.executablePath ? { executablePath: browser.executablePath } : {}) });
    },
    async chromium(config, env) {
      const { expectedChromiumPath } = await import('@webscoop/browser');
      const choice = await resolveBrowser(config, env, { expectedPath: expectedChromiumPath });
      if (!choice.path) return { ...choice, installed: false, error: 'not found' };
      const probe = await probeVersion(choice.path);
      return { ...choice, installed: probe.version !== undefined, ...probe };
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
    createNotify: (env, stderr) => new NotifySend({ stderr: stderr ?? process.stderr, env }),
    findBrowserPid: (profileDir, deadlineMs) => findBrowserPid(profileDir, { deadlineMs }),
    terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    tty: openTty,
    async launchBrowser(_config, _env, browser, profileDir, opts) {
      const { SharedBrowser } = await import('@webscoop/browser');
      return SharedBrowser.launch({ driver: browser.driver, ...(browser.executablePath ? { executablePath: browser.executablePath } : {}) }, profileDir, opts);
    },
    daemon: {
      programPath,
      connect: () => connectSocket(socket()),
      spawn: async () => spawnDaemon(programPath, process.env, logPath()),
    },
    async serveDaemon() {
      await serveDaemon({ socketPath: socket(), logPath: logPath(), base: defaultIo(), version: VERSION, programPath });
      return ExitCode.Ok;
    },
  };
}
