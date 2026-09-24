import { readFile } from 'node:fs/promises';
import { CliError } from './exit';

/** Set by `build.mjs`: the recorder bundle embedded into the single-file CLI. */
declare const __WEBSCOOP_RECORDER__: string | undefined;

/**
 * The recorder bundle. The built CLI carries it inline; running from source
 * (tests, `tsx`) and the e2e variant read it from the inject package's
 * build output next to this package.
 */
export async function loadRecorderBundle(variant: 'default' | 'e2e'): Promise<string> {
  if (variant === 'default' && typeof __WEBSCOOP_RECORDER__ === 'string') return __WEBSCOOP_RECORDER__;
  const file = variant === 'e2e' ? 'recorder.e2e.js' : 'recorder.js';
  const url = new URL(`../../inject/dist/${file}`, import.meta.url);
  try {
    return await readFile(url, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(`recorder bundle not found at ${url.pathname}; run npm run build`);
    }
    throw error;
  }
}
