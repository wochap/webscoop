/** True only in the e2e bundle, which carries the `window.__webscoopTest` hook. */
declare const __WEBSCOOP_E2E__: boolean;

declare module '*.css' {
  const css: string;
  export default css;
}

declare module '*.woff2' {
  const bytes: Uint8Array;
  export default bytes;
}
