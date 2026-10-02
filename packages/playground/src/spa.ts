import type { Product } from './dataset';
import { escapeHtml, renderCards } from './render';

/** Cookie holding the SPA session: `never` or the epoch milliseconds it expires at. */
export const SPA_COOKIE = 'ws_spa';
/** Cards per page of the SPA catalog. */
export const SPA_PAGE_SIZE = 8;
/** How often the SPA asks whether its session still holds, in milliseconds: under a second, with room for network idle in between. */
export const SPA_POLL_MS = 900;

/** Whether the SPA session cookie holds at `now`. */
export function spaLoggedIn(cookie: string | undefined, now = Date.now()): boolean {
  if (!cookie) return false;
  if (cookie === 'never') return true;
  const expires = Number(cookie);
  return Number.isFinite(expires) && expires > now;
}

/** The cookie value for a login now: `never`, or the expiry `ttl` seconds from now. */
export function spaSession(ttl: number | null, now = Date.now()): string {
  return ttl === null ? 'never' : String(now + ttl * 1000);
}

const STYLE = `
body { font: 15px/1.5 system-ui, sans-serif; margin: 0; color: #1d2030; background: #f6f7f9; }
header { display: flex; align-items: center; gap: 12px; padding: 14px 24px; background: #fff; border-bottom: 1px solid #e3e5ea; }
header h1 { font-size: 18px; margin: 0; flex: 1; }
main { padding: 24px; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #3b5bdb; background: #fff; color: #3b5bdb; cursor: pointer; }
button[disabled] { opacity: .45; cursor: default; }
nav.menu { display: flex; gap: 8px; margin-bottom: 16px; }
ul.product-list { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
table { border-collapse: collapse; background: #fff; }
td, th { border: 1px solid #e3e5ea; padding: 6px 10px; text-align: left; }
`;

/**
 * The SPA: logged out it shows a "Log in" button that opens the login popup;
 * logged in it shows a menu of Catalog and Report, whose content swaps in
 * without changing the URL. The page polls `/spa/session` and shows the
 * "Log in" button again once the session ends.
 */
export function spaPage(products: readonly Product[], opts: { loggedIn: boolean; ttl: number | null; seed: number }): string {
  const pages: string[] = [];
  for (let i = 0; i < products.length; i += SPA_PAGE_SIZE) pages.push(renderCards(products.slice(i, i + SPA_PAGE_SIZE), { tier: 0, seed: opts.seed }));
  const total = products.reduce((sum, p) => sum + p.price, 0).toFixed(2);
  const loginUrl = `/spa/login${opts.ttl !== null ? `?ttl=${opts.ttl}` : ''}`;
  const data = JSON.stringify({ pages, total, loginUrl, poll: SPA_POLL_MS }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Example Portal</title><style>${STYLE}</style></head>
<body>
<header><h1>Example Portal</h1><span id="spa-user"></span></header>
<main id="spa-root"></main>
<script>
(() => {
  const data = ${data};
  const root = document.getElementById('spa-root');
  let loggedIn = ${opts.loggedIn ? 'true' : 'false'};
  let section = null;
  let page = 0;
  const loginView = () => {
    root.innerHTML = '<p id="spa-logged-out">Monthly reports are for members.</p><button type="button" id="spa-login">Log in</button>';
    document.getElementById('spa-login').addEventListener('click', () => window.open(data.loginUrl, 'spa-login', 'width=500,height=600'));
  };
  const catalogView = () => {
    const last = page >= data.pages.length - 1;
    return '<h2 id="spa-catalog-heading">Catalog</h2><ul class="product-list">' + data.pages[page] + '</ul>' +
      '<p class="pager"><span id="spa-page">Page ' + (page + 1) + ' of ' + data.pages.length + '</span> <button type="button" id="spa-next"' + (last ? ' disabled aria-disabled="true"' : '') + '>Next</button></p>';
  };
  const reportView = () =>
    '<h2 id="spa-report-heading">Monthly report</h2><table id="spa-report"><tr><th>Products</th><td id="spa-report-count">' + data.pages.reduce((n, p) => n + (p.match(/data-testid="product-card"/g) || []).length, 0) + '</td></tr><tr><th>Total</th><td id="spa-report-total">' + data.total + '</td></tr></table>';
  const menuView = () => {
    root.innerHTML = '<nav class="menu"><button type="button" id="spa-catalog">Catalog</button><button type="button" id="spa-report-open">Report</button></nav><section id="spa-content">' +
      (section === 'catalog' ? catalogView() : section === 'report' ? reportView() : '<p id="spa-pick">Choose a section.</p>') + '</section>';
    document.getElementById('spa-catalog').addEventListener('click', () => { section = 'catalog'; page = 0; menuView(); });
    document.getElementById('spa-report-open').addEventListener('click', () => { section = 'report'; menuView(); });
    const next = document.getElementById('spa-next');
    if (next) next.addEventListener('click', () => { if (page < data.pages.length - 1) { page++; menuView(); } });
  };
  const show = () => (loggedIn ? menuView() : loginView());
  show();
  setInterval(async () => {
    try {
      const res = await fetch('/spa/session', { cache: 'no-store' });
      const now = (await res.json()).loggedIn === true;
      if (now === loggedIn) return;
      loggedIn = now;
      section = null;
      page = 0;
      show();
    } catch {}
  }, data.poll);
})();
</script>
</body></html>`;
}

/** The login popup: user and password, and "Sign in", which logs in and closes the window. */
export function spaLoginPage(ttl: number | null): string {
  const action = `/spa/login${ttl !== null ? `?ttl=${ttl}` : ''}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in</title><style>${STYLE} form { display: flex; flex-direction: column; gap: 10px; max-width: 360px; margin: 40px auto; } input { font: inherit; padding: 8px; }</style></head>
<body>
<form id="spa-login-form" method="post" action="${escapeHtml(action)}">
  <h1>Sign in to Example Portal</h1>
  <label>User <input id="spa-user-input" name="user" autocomplete="off"></label>
  <label>Password <input id="spa-password-input" name="password" type="password" autocomplete="off"></label>
  <p id="spa-login-error" hidden>Enter a user and a password.</p>
  <button type="submit" id="spa-sign-in">Sign in</button>
</form>
<script>
document.getElementById('spa-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const res = await fetch(e.target.action, { method: 'POST', body: new URLSearchParams(form) });
  if (res.ok) window.close();
  else document.getElementById('spa-login-error').hidden = false;
});
</script>
</body></html>`;
}
