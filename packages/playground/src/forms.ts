/** Options of the forms page's custom combobox. */
export const FORM_CITIES = ['Lima', 'Cusco', 'Arequipa', 'Lambayeque', 'Loreto'] as const;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * One form with a labeled instance of every input kind a `fill` step sets.
 * Submitting posts every value as JSON in one `payload` field to
 * `/forms/submit`; files are posted as their names and sizes, and the
 * controlled input from its script state.
 */
export function formsPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Forms</title>
<style>
body{font-family:sans-serif;margin:24px}label,.row{display:block;margin:8px 0}
#combobox-list{list-style:none;margin:0;padding:0;border:1px solid #888;width:200px}#combobox-list[hidden]{display:none}
#combobox-list li{padding:2px 6px;cursor:pointer}.otp input{width:24px;text-align:center}
[role=switch]{display:inline-block;width:40px;height:20px;border:1px solid #444;cursor:pointer}[role=switch][aria-checked=true]{background:#2a2}
#dropzone{border:2px dashed #888;padding:16px;width:240px}#notes{border:1px solid #888;min-height:24px;width:240px}
</style></head>
<body>
<h1>Forms</h1>
<form id="form" action="/forms/submit" method="post">
<label>Name <input id="text" name="text"></label>
<label>Email <input id="email" name="email" type="email"></label>
<label>Password <input id="password" name="password" type="password"></label>
<label>Bio <textarea id="textarea" name="textarea"></textarea></label>
<label>Country <select id="select" name="select"><option value="">Choose</option><option value="PE">Peru</option><option value="CL">Chile</option><option value="AR">Argentina</option></select></label>
<label>Languages <select id="multiselect" name="multiselect" multiple><option value="es">Spanish</option><option value="en">English</option><option value="qu">Quechua</option></select></label>
<label><input id="checkbox" name="checkbox" type="checkbox"> Accept terms</label>
<fieldset><legend>Plan</legend>
<label><input type="radio" name="radio" value="free" id="radio-free" checked> Free</label>
<label><input type="radio" name="radio" value="pro" id="radio-pro"> Pro</label>
</fieldset>
<div class="row"><span id="switch-label">Newsletter</span> <span id="switch" role="switch" aria-checked="false" aria-labelledby="switch-label" tabindex="0"></span></div>
<label>Birthday <input id="date" name="date" type="date"></label>
<label>Nickname <input id="controlled" autocomplete="off"></label>
<div class="row"><label for="combobox">City</label>
<input id="combobox" role="combobox" aria-autocomplete="list" aria-controls="combobox-list" aria-expanded="false" autocomplete="off">
<ul id="combobox-list" role="listbox" hidden></ul></div>
<div class="row otp" role="group" aria-label="Code">${Array.from({ length: 6 }, (_, i) => `<input class="otp-box" id="otp-${i}" maxlength="1" inputmode="numeric" aria-label="Digit ${i + 1}">`).join('')}</div>
<div class="row"><span id="notes-label">Notes</span> <div id="notes" contenteditable="true" role="textbox" aria-labelledby="notes-label"></div></div>
<div class="row">Shadow <shadow-field id="shadow-host"></shadow-field></div>
<label>Resume <input id="file" name="file" type="file" multiple></label>
<div class="row"><input id="chooser" type="file" hidden> <button type="button" id="chooser-button">Select file</button> <span id="chooser-name"></span></div>
<div class="row"><div id="dropzone">Drop files here or click to browse</div><input id="dropzone-input" type="file" multiple hidden> <span id="dropzone-name"></span></div>
<button id="submit" type="submit">Submit</button>
</form>
<form id="post" action="/forms/submit" method="post" hidden><input name="payload" id="payload"></form>
<script>
customElements.define('shadow-field', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<label>Shadow text <input id="shadow" name="shadow"></label>'; }
});
// The controlled input: script state is the truth, written back on every render.
let nickname = '';
const controlled = document.getElementById('controlled');
controlled.addEventListener('input', (e) => { nickname = e.target.value; render(); });
function render() { if (controlled.value !== nickname) controlled.value = nickname; }
setInterval(render, 50);

const sw = document.getElementById('switch');
const flip = () => sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true'));
sw.addEventListener('click', flip);
sw.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });

const cities = ${JSON.stringify(FORM_CITIES)};
const combo = document.getElementById('combobox');
const list = document.getElementById('combobox-list');
function showOptions() {
  const typed = combo.value.trim().toLowerCase();
  const hits = typed ? cities.filter((c) => c.toLowerCase().startsWith(typed)) : [];
  list.innerHTML = hits.map((c, i) => '<li role="option" id="city-' + i + '">' + c + '</li>').join('');
  list.hidden = hits.length === 0;
  combo.setAttribute('aria-expanded', String(!list.hidden));
}
combo.addEventListener('input', showOptions);
list.addEventListener('click', (e) => {
  const li = e.target.closest('[role=option]');
  if (!li) return;
  combo.value = li.textContent;
  list.hidden = true;
  combo.setAttribute('aria-expanded', 'false');
});

const boxes = Array.from(document.querySelectorAll('.otp-box'));
boxes.forEach((box, i) => box.addEventListener('input', () => { if (box.value && boxes[i + 1]) boxes[i + 1].focus(); }));

const chooser = document.getElementById('chooser');
document.getElementById('chooser-button').addEventListener('click', () => chooser.click());
chooser.addEventListener('change', () => { document.getElementById('chooser-name').textContent = Array.from(chooser.files).map((f) => f.name).join(', '); });
const dropInput = document.getElementById('dropzone-input');
const dropzone = document.getElementById('dropzone');
let dropped = [];
dropzone.addEventListener('click', () => dropInput.click());
dropzone.addEventListener('dragover', (e) => e.preventDefault());
dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropped = Array.from(e.dataTransfer.files); showDropped(); });
dropInput.addEventListener('change', () => { dropped = Array.from(dropInput.files); showDropped(); });
function showDropped() { document.getElementById('dropzone-name').textContent = dropped.map((f) => f.name).join(', '); }

const filesOf = (list) => Array.from(list).map((f) => ({ name: f.name, size: f.size }));
document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = (id) => document.getElementById(id).value;
  const payload = {
    text: v('text'),
    email: v('email'),
    password: v('password'),
    textarea: v('textarea'),
    select: v('select'),
    multiselect: Array.from(document.getElementById('multiselect').selectedOptions).map((o) => o.value),
    checkbox: document.getElementById('checkbox').checked,
    radio: (document.querySelector('input[name=radio]:checked') || {}).value || '',
    switch: sw.getAttribute('aria-checked') === 'true',
    date: v('date'),
    controlled: nickname,
    combobox: combo.value,
    otp: boxes.map((b) => b.value).join(''),
    contenteditable: document.getElementById('notes').textContent,
    shadow: document.getElementById('shadow-host').shadowRoot.getElementById('shadow').value,
    file: filesOf(document.getElementById('file').files),
    chooser: filesOf(chooser.files),
    dropzone: filesOf(dropped),
  };
  document.getElementById('payload').value = JSON.stringify(payload);
  document.getElementById('post').submit();
});
</script>
</body></html>`;
}

/** The echo of a submitted form: every received value as JSON in `#echo`. */
export function formsSubmitPage(payload: string): string {
  let values: unknown;
  try {
    values = JSON.parse(payload);
  } catch {
    values = { error: 'invalid payload' };
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Submitted</title></head>
<body><h1>Submitted</h1><pre id="echo">${escapeHtml(JSON.stringify(values, null, 2))}</pre></body></html>`;
}
