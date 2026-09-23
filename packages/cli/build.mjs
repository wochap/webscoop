import { build } from 'esbuild';

await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/webscoop.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Playwright ships its own driver and browsers registry; load it from node_modules.
  external: ['playwright', 'playwright-core'],
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
