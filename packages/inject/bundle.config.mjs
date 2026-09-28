import { fileURLToPath, URL } from 'node:url';

/** esbuild options for the injected recorder, shared by the build and the size test. */
/** Raised from 470 KiB for the sidebar shell (inline icons, tabs, sections, selector chips), then from 520 KiB for the pick helpers, then from 530 KiB for the recipe URL editor, then from 540 KiB for the panel dropdown menus. */
export const SIZE_BUDGET = 548 * 1024;

export function bundleOptions({ e2e, outfile }) {
  return {
    entryPoints: [fileURLToPath(new URL('./src/index.tsx', import.meta.url))],
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    minify: true,
    legalComments: 'none',
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': '"production"',
      __WEBSCOOP_E2E__: String(e2e),
    },
    loader: { '.css': 'text', '.woff2': 'binary' },
    logLevel: 'warning',
  };
}
