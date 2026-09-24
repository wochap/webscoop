import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { build } from 'esbuild';

// The recorder UI injected into pages, embedded so the installed CLI stays one file.
const recorder = await readFile(new URL('../inject/dist/recorder.js', import.meta.url), 'utf8');

await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/webscoop.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Playwright ships its own driver and browsers registry; load it from node_modules.
  external: ['playwright', 'playwright-core'],
  define: { __WEBSCOOP_RECORDER__: JSON.stringify(recorder) },
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __webscoopCreateRequire } from 'node:module';",
      'const require = __webscoopCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  sourcemap: 'linked',
  logLevel: 'warning',
});
