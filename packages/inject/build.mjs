import { build } from 'esbuild';
import { bundleOptions } from './bundle.config.mjs';

/**
 * Two IIFE bundles: `recorder.js` for users, and `recorder.e2e.js` with the
 * test hook compiled in. The CLI embeds only the first.
 */
await build(bundleOptions({ e2e: false, outfile: 'dist/recorder.js' }));
await build(bundleOptions({ e2e: true, outfile: 'dist/recorder.e2e.js' }));
