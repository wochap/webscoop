import type { RecipeInput } from '@webscoop/core';
import { expect, hasDisplay, test } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

interface LoggedEvent {
  type: string;
  x: number;
  y: number;
  key?: string;
  inButton: boolean;
}

/** Type a query, click the button, and extract the result and the page's event log. */
function eventsRecipe(port: number): RecipeInput {
  const css = (value: string) => ({ selectors: [{ strategy: 'css' as const, value, stability: 'medium' as const }] });
  return {
    schemaVersion: 1,
    name: 'input-events',
    url: `http://127.0.0.1:${port}/input-events`,
    steps: [
      { kind: 'type', target: css('#q'), value: 'shoes', when: 'first-page', optional: false },
      { kind: 'click', target: css('#go'), when: 'first-page', optional: false },
    ],
    fields: [
      { name: 'result', type: 'text', scope: 'page', ...css('#result') },
      { name: 'events', type: 'text', scope: 'page', ...css('#events') },
    ],
  };
}

/** Largest distance of a point from the straight line between the first and last points. */
function deviation(points: { x: number; y: number }[]): number {
  const a = points[0]!;
  const b = points.at(-1)!;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return Math.max(...points.map((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len));
}

test('humanized input curves the pointer, types key by key, dwells, and extracts the same rows', async ({ scoop }) => {
  await scoop.writeRecipe(eventsRecipe(scoop.playground.port));
  const env = { WEBSCOOP_HUMANIZE_SPEED: '20' };

  const human = await scoop.run(['run', 'input-events', '--humanize'], env);
  expect(human.code, human.stderr).toBe(0);
  expect(human.stderr).toContain('humanized input');
  const [row] = JSON.parse(human.stdout) as { result: string; events: string }[];
  const events = JSON.parse(row!.events) as LoggedEvent[];

  const keys = events.filter((e) => e.type === 'keydown');
  expect(keys.map((e) => e.key)).toEqual(['s', 'h', 'o', 'e', 's']);

  const down = events.findIndex((e) => e.type === 'mousedown' && e.inButton);
  expect(down).toBeGreaterThan(-1);
  // Moves after the last key, up to the button press: the path to the button.
  const lastKey = events.lastIndexOf(keys.at(-1)!);
  const path = events.slice(lastKey + 1, down).filter((e) => e.type === 'mousemove');
  expect(path.length).toBeGreaterThanOrEqual(5);
  expect(deviation(path)).toBeGreaterThan(2);

  // The page dwell moves or scrolls before the first action.
  const firstKey = events.indexOf(keys[0]!);
  expect(events.slice(0, firstKey).some((e) => e.type === 'mousemove' || e.type === 'wheel')).toBe(true);

  const plain = await scoop.run(['run', 'input-events', '--profile', 'plain']);
  expect(plain.code, plain.stderr).toBe(0);
  expect(plain.stderr).not.toContain('humanized input');
  const [plainRow] = JSON.parse(plain.stdout) as { result: string }[];
  expect(row!.result).toBe('searched shoes');
  expect(plainRow!.result).toBe(row!.result);
});
