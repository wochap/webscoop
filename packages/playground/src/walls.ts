import { escapeHtml } from './render';

/** Walls the catalog can put up for the guards: a login form, a bot check, or a short interstitial. */
export const WALL_KINDS = ['login', 'captcha', 'interstitial'] as const;
export type WallKind = (typeof WALL_KINDS)[number];

/** Session cookie `POST /login` sets. */
export const SESSION_COOKIE = 'ws_sess';
/** Cookie `POST /challenge` sets; it clears the captcha and interstitial walls. */
export const HUMAN_COOKIE = 'ws_human';

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; }
form { display: flex; flex-direction: column; gap: 0.5rem; max-width: 320px; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** `next` when it is a path on this origin, else `/`. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}

export function loginPage(next: string): string {
  return page(
    'Sign in',
    `<main>
<h1>Sign in</h1>
<p>Log in to see the catalog. Any username and password work.</p>
<form id="login-form" method="post" action="/login">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label>Username <input name="username" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button>
</form>
</main>`,
  );
}

/** Posts to `/challenge`, which sets the cookie, then reloads the page it is on. */
const PASS_SCRIPT = (button: string) => `<script>
document.getElementById(${JSON.stringify(button)}).addEventListener('click', function () {
  fetch('/challenge', { method: 'POST' }).then(function () { location.reload(); });
});
</script>`;

export function challengePage(): string {
  return page(
    'Just a moment...',
    `<main>
<h1>Verify you are human</h1>
<p>We need to make sure you are not a robot before showing the catalog.</p>
<div id="challenge-form">
<iframe src="/challenge/turnstile" title="Widget containing a turnstile security challenge" width="300" height="65"></iframe>
<button type="button" id="human-button">I am human</button>
</div>
</main>
${PASS_SCRIPT('human-button')}`,
  );
}

/** What the fake vendor iframe shows. */
export function turnstileFrame(): string {
  return page('turnstile', '<p>Checking…</p>');
}

/** Under 200 visible characters and no product. */
export function interstitialPage(): string {
  return page('One moment', `<p>Checking your browser before you reach the catalog.</p>\n<button type="button" id="pass-button">Continue</button>\n${PASS_SCRIPT('pass-button')}`);
}
