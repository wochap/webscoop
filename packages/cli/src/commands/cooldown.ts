import { log, type CliIo } from '../context';
import { clockTime, cooldownsPath, CooldownStore } from '../cooldown';
import { connectRunning, nextMessage } from '../daemon/client';
import { CliError, ExitCode, type ExitCode as Code } from '../exit';

function storeOf(io: CliIo): CooldownStore {
  return new CooldownStore(cooldownsPath(io.env, io.homedir), (message) => log(io, `warning: ${message}`));
}

/** `webscoop cooldown list`: one line (or JSON object) per cold recipe. */
export async function cooldownListCommand(io: CliIo, opts: { json?: boolean }): Promise<Code> {
  const cold = storeOf(io).coldAll(Date.now());
  if (opts.json) {
    const list = cold.map(([recipe, e]) => ({ recipe, kind: e.kind, page: e.page, url: e.url, since: new Date(e.since).toISOString(), until: new Date(e.until).toISOString(), streak: e.streak }));
    io.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return ExitCode.Ok;
  }
  for (const [recipe, e] of cold) io.stdout.write(`${recipe}  ${e.kind} on page ${e.page}  cold until ${clockTime(e.until)}  streak ${e.streak}  ${e.url}\n`);
  return ExitCode.Ok;
}

/** `webscoop cooldown clear <recipe> | --all`: warm recipes up, and have a running daemon close their cold tabs. */
export async function cooldownClearCommand(io: CliIo, recipe: string | undefined, opts: { all?: boolean }): Promise<Code> {
  if ((recipe === undefined) === (opts.all !== true)) throw new CliError('pass a recipe or --all, not both');
  const store = storeOf(io);
  const now = Date.now();
  const names = opts.all ? store.coldAll(now).map(([name]) => name) : [recipe!];
  const warmed = names.filter((name) => store.warm(name, now));
  if (recipe !== undefined && warmed.length === 0) log(io, `${recipe} is not cold`);
  for (const name of warmed) log(io, `${name} is warm`);
  if (warmed.length > 0 && io.daemon) {
    const link = await connectRunning(io);
    if (link) {
      try {
        const reply = nextMessage(link, (m) => m.type === 'result');
        link.send({ type: 'cooldown-clear', recipes: warmed });
        await reply;
      } finally {
        link.close();
      }
    }
  }
  return ExitCode.Ok;
}
