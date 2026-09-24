import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { RecipeInput } from '@webscoop/core';
import { findBrowserPid } from '@webscoop/cli';
import { expect, hasDisplay, PAGED_RECIPE, referenceRecipe, test } from './fixtures';

// Moves real windows on the desktop; opt in on a Hyprland session.
test.skip(!hasDisplay || process.env.WEBSCOOP_E2E_HYPRLAND !== '1' || !process.env.HYPRLAND_INSTANCE_SIGNATURE, 'set WEBSCOOP_E2E_HYPRLAND=1 in a Hyprland session');

const hyprctl = <T>(...args: string[]): T => JSON.parse(execFileSync('hyprctl', [...args, '-j'], { encoding: 'utf8' })) as T;

interface Client {
  pid: number;
  class: string;
  workspace: { name: string };
}

const clientOf = (pid: number) => hyprctl<Client[]>('clients').find((c) => c.pid === pid) ?? null;

/** Workspace name of the window owned by the process, or null while it has none. */
const workspaceOf = (pid: number): string | null => clientOf(pid)?.workspace.name ?? null;

const activeWorkspace = () => hyprctl<{ name: string }>('activeworkspace').name;

test('the window hides after opening, comes back on a guard, and hides again after the login', async ({ scoop }) => {
  const recipe: RecipeInput = referenceRecipe(scoop.playground.port, PAGED_RECIPE);
  recipe.name = 'window-hyprland';
  recipe.vars = recipe.vars!.map((v) => (v.name === 'mode' ? { ...v, default: 'url' } : v));
  recipe.url += '&wall=login&wallAfterPage=2';
  const name = await scoop.writeRecipe(recipe);

  // The delay keeps page 1 on screen long enough to look at the window.
  const g = await scoop.guardedRun([name, '--jsonl', '--delay', '1500']);
  const pid = await findBrowserPid(join(scoop.home, 'profiles', name));
  expect(pid).not.toBeNull();

  // The class rule places the window as it maps: the first time it is seen, it is already away.
  let first: Client | null = null;
  await expect.poll(() => (first = clientOf(pid!)), { intervals: [20] }).not.toBeNull();
  expect(first!.class).toBe('webscoop');
  expect(first!.workspace.name).toBe('special:webscoop');

  await expect.poll(() => g.run.err()).toContain('page 1 loaded');
  await expect.poll(() => workspaceOf(pid!)).toBe('special:webscoop');

  await g.raised();
  await expect.poll(() => workspaceOf(pid!)).toBe(activeWorkspace());
  expect(workspaceOf(pid!)).not.toMatch(/^special:/);

  await g.login('ada', 'secret');
  await expect.poll(() => workspaceOf(pid!)).toBe('special:webscoop');

  const result = await g.run.done;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).not.toContain('window provider');
});
