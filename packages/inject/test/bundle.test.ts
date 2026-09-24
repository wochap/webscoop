import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { bundleOptions, SIZE_BUDGET } from '../bundle.config.mjs';

async function bundle(e2e: boolean): Promise<string> {
  const result = await build({ ...bundleOptions({ e2e, outfile: e2e ? 'recorder.e2e.js' : 'recorder.js' }), write: false });
  return result.outputFiles[0]!.text;
}

describe('recorder bundle', () => {
  it('stays under the size budget', async () => {
    const code = await bundle(false);
    expect(code.length).toBeGreaterThan(100_000);
    expect(code.length).toBeLessThan(SIZE_BUDGET);
  });

  it('carries the test hook only in the e2e variant', async () => {
    expect(await bundle(false)).not.toContain('__webscoopTest');
    expect(await bundle(true)).toContain('__webscoopTest');
  });
});
