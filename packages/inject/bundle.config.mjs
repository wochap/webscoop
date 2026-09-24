import { fileURLToPath, URL } from 'node:url';

/** esbuild options for the injected recorder, shared by the build and the size test. */
export const SIZE_BUDGET = 450 * 1024;

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
