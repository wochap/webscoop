import type { BuildOptions } from 'esbuild';
export declare const SIZE_BUDGET: number;
export declare function bundleOptions(opts: { e2e: boolean; outfile: string }): BuildOptions;
