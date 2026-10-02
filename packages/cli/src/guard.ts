import {
  draftFromRecipe,
  isInteractiveSession,
  RecorderController,
  type GuardBannerHandler,
  type Recipe,
  type StoragePort,
} from '@webscoop/core';
import { log, type CliIo } from './context';
import { CliError } from './exit';

/**
 * The guard banner: the recorder bundle in guard mode, shown in the window
 * that needs the user (the run's own tab, or a popup for an await-user step)
 * while the run holds attention, and taken out of the page once attention
 * resolves.
 */
export function guardBanner(
  io: CliIo,
  opts: { storage: StoragePort; bundle: string; recipe: Recipe; vars: Readonly<Record<string, string>>; timeoutMs: number },
): GuardBannerHandler {
  let controller: RecorderController | null = null;
  return {
    async show(session, info) {
      if (!isInteractiveSession(session)) throw new CliError('this browser adapter cannot show the guard banner');
      const next = new RecorderController({
        session,
        storage: opts.storage,
        bundle: opts.bundle,
        draft: draftFromRecipe(opts.recipe, opts.vars),
        mode: { kind: 'guard' },
        timeoutMs: opts.timeoutMs,
        abortOnClose: !info.popup,
      });
      controller = next;
      // Set before attaching, so the page gets the banner with its first state.
      const { popup: _popup, ...context } = info;
      const hooks = await next.showGuard(context);
      await next.attach();
      log(io, `the page shows the ${info.kind === 'await-user' ? `banner for "${info.label ?? 'await-user'}"` : 'guard banner'}: Continue checks again now, Abort stops the run`);
      return hooks;
    },
    async hide() {
      const current = controller;
      controller = null;
      if (!current) return;
      await current.hideGuard();
      await current.detach();
    },
  };
}
