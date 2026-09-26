import {
  draftFromRecipe,
  isInteractiveSession,
  RecorderController,
  type RepickHandler,
  type StoragePort,
} from '@webscoop/core';
import { log, type CliIo } from './context';
import { CliError } from './exit';

/**
 * Re-pick inside a run: show the recorder's focused mode in the run's own
 * browser window, wait for the user without a timeout, then take the
 * recorder out of the page so extraction continues on a clean page.
 */
export function interactiveRepick(
  io: CliIo,
  opts: { storage: StoragePort; bundle: string; vars: Readonly<Record<string, string>>; timeoutMs: number },
): RepickHandler {
  return async (request) => {
    const { session, target } = request;
    if (!isInteractiveSession(session)) throw new CliError('this browser adapter cannot show the re-pick panel');
    if (target.kind !== 'field') throw new CliError(`cannot re-pick the ${target.kind}`);
    const controller = new RecorderController({
      session,
      storage: opts.storage,
      bundle: opts.bundle,
      draft: draftFromRecipe(request.recipe, opts.vars),
      mode: { kind: 'repick', fieldIndex: target.index, reason: 'run', sample: request.sample, table: target.table },
      timeoutMs: opts.timeoutMs,
    });
    log(io, `field ${request.name} could not be healed; pick its new location in the browser window (S skips, Esc aborts)`);
    await controller.attach();
    try {
      const outcome = await controller.awaitRepick();
      if (outcome.kind === 'picked') {
        const primary = outcome.selectors[0];
        log(io, `re-picked ${request.name}: ${primary ? `${primary.strategy}=${primary.value}` : 'no selector'}`);
      } else {
        log(io, `re-pick of ${request.name}: ${outcome.kind}`);
      }
      return outcome;
    } finally {
      await controller.detach();
    }
  };
}
