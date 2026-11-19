import * as db from './db.js';

// ============================================================
// State: everything is loaded into memory at start; every change is
// written straight back to on-device storage.
// ============================================================
const S = { ex: new Map(), wo: new Map() };
const app = document.getElementById('app');
const APP_VERSION = 'v0.5.3';
const SET_TYPES = ['Warmup', 'Drop Set', 'Superset', 'Myo-rep Match'];

// Which optional fields are shown. Saved on the phone; turning one off only hides it.
const DEFAULT_SETTINGS = { variant: true, setTypes: true, rom: true, rpe: true, notes: true, history: true };
const SETTING_LABELS = [
  ['variant', 'Exercise variants', 'Barbell, Dumbbell, Cable… Off: the variant step is skipped when adding exercises.'],
  ['setTypes', 'Set types', 'Warmup, Drop Set, Superset, Myo-rep Match'],
  ['rom', 'ROM (range of motion)', '1–5 scale on each set'],
  ['rpe', 'RPE (effort)', '1–10 scale on each set'],
  ['notes', 'Notes', 'Free-text notes on each exercise'],
  ['history', 'Last 3 sessions panel', 'Your recent sets for the exercise you are logging']
];
let SETTINGS = { ...DEFAULT_SETTINGS };
let META = { lastBackup: null, progressKey: null, chartMode: 'heaviest' };
async function saveSettings() { await db.put('meta', { key: 'settings', value: SETTINGS }); }
async function saveMeta() { await db.put('meta', { key: 'meta', value: META }); }

const ROM_SCALE = [
  [1, 'Partial', 'Quarter reps or top-end only'],
  [2, 'Shortened', 'Roughly half reps; clearly short of full range at one end'],
  [3, 'Full', 'Textbook full range for that exercise'],
  [4, 'Extended', 'Past standard into a deeper stretch (deficits, extra-deep bottom position)'],
  [5, 'Maximal', 'As far as the joint allows; deepest stretch you can get']
];
const RPE_SCALE = [
  [10, 'Max effort', 'Nothing left. Could not do another rep.'],
  [9, 'Very hard', '1 rep left in the tank'],
  [8, 'Hard', '2 reps left'],
  [7, 'Challenging', '3 reps left'],
  [6, 'Moderate', '4 or more reps left'],
  ['1–5', 'Light', 'Warmup or easy effort']
];

// ---------- small helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n === null || n === undefined || n === '' ? '' : String(Math.round(n * 100) / 100));
const parseWeight = (v) => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
const parseInt10 = (v) => { const n = parseInt(v, 10); return isFinite(n) ? n : null; };
const shortDate = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const longDate = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const localTimeValue = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const localDateValue = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const activeVariants = (ex) => (ex ? ex.variants.filter((v) => !v.archived) : []);

function exLabel(entry) {
  const ex = S.ex.get(entry.exerciseId);
  const v = ex && entry.variantId ? ex.variants.find((x) => x.id === entry.variantId) : null;
  return { name: ex ? ex.name : '(deleted exercise)', variant: v && SETTINGS.variant ? v.name : '' };
}
const isWarmup = (set) => set.types.includes('Warmup');
const isBlank = (set) => set.weight === null && set.reps === null;
function sortedWorkouts() { return [...S.wo.values()].sort((a, b) => b.date.localeCompare(a.date)); }
function inProgress() { return sortedWorkouts().find((w) => !w.endedAt); }

const saveWorkout = (w) => db.put('workouts', w);
const saveExercise = (ex) => db.put('exercises', ex);

// ============================================================
// Sheets (popups from the bottom of the screen)
// ============================================================
let sheetClose = null;
function openSheet(html, onClick, onInput) {
  closeSheet();
  const back = document.createElement('div');
  back.className = 'backdrop';
  back.innerHTML = `<div class="sheet" role="dialog">${html}</div>`;
  document.body.appendChild(back);
  back.addEventListener('click', (e) => {
    if (e.target === back) { closeSheet(); return; }
    if (onClick) onClick(e, back.firstElementChild);
  });
  if (onInput) back.addEventListener('input', (e) => onInput(e, back.firstElementChild));
  sheetClose = () => back.remove();
  return back.firstElementChild;
}
function closeSheet() { if (sheetClose) { sheetClose(); sheetClose = null; } }

function confirmSheet(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    openSheet(`<h3>${esc(message)}</h3><div class="actions"><button data-a="no">Cancel</button><button class="primary" data-a="yes">${esc(okLabel)}</button></div>`,
      (e) => { const a = e.target.closest('[data-a]'); if (!a) return; closeSheet(); resolve(a.dataset.a === 'yes'); });
  });
}

function showScale(kind) {
  const rows = (kind === 'rom' ? ROM_SCALE : RPE_SCALE).map(([n, l, d]) => `<tr><td>${n}</td><td><b>${esc(l)}</b><br><span class="muted">${esc(d)}</span></td></tr>`).join('');
  const title = kind === 'rom' ? 'ROM — Range of Motion (1–5)' : 'RPE — Rate of Perceived Exertion';
  openSheet(`<h3>${title}</h3><table>${rows}</table><div class="actions"><button data-a="close">Close</button></div>`,
    (e) => { if (e.target.closest('[data-a]')) closeSheet(); });
}

// ============================================================
// Router
// ============================================================
function route() {
  closeSheet();
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
  const [view, id] = parts;
  if (view === 'workouts') return renderWorkouts();
  if (view === 'workout' && S.wo.has(id)) return renderWorkout(id);
  if (view === 'library') return renderLibrary();
  if (view === 'exercise' && S.ex.has(id)) return renderExerciseEdit(id);
  if (view === 'progress') return renderProgress();
  if (view === 'settings') return renderSettings();
  return renderHome();
}
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
window.addEventListener('hashchange', route);
let rzT; window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { if (location.hash.startsWith('#/progress')) renderProgress(); }, 150); });

function topbar(title, backHash, backLabel = 'Back', right = '') {
  return `<header class="topbar"><div class="side">${backHash ? `<button class="ghost" data-nav="${backHash}">‹ ${esc(backLabel)}</button>` : ''}</div>
    <h1>${esc(title)}</h1><div class="side right">${right}</div></header>`;
}

// ============================================================
// Home
// ============================================================
function renderHome() {
  const cur = inProgress();
  app.innerHTML = `
    <div class="home-title"><h1>Lift Log</h1><p>${esc(new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))}</p></div>
    ${needsBackup() ? `<button class="backup-nudge" data-nav="#/settings">${esc(backupText())} · <u>Back up now</u></button>` : ''}
    ${cur ? `<button class="banner" data-nav="#/workout/${cur.id}">Continue workout<small>${esc(cur.name || 'Workout')} · ${cur.entries.length} exercise${cur.entries.length === 1 ? '' : 's'}</small></button>` : ''}
    <nav class="home-grid">
      <button class="tile" data-nav="#/progress"><span class="glyph" aria-hidden="true">📈</span>Progress<small>Charts &amp; PRs</small></button>
      <button class="tile" data-nav="#/workouts"><span class="glyph" aria-hidden="true">🏋️</span>Workouts<small>${S.wo.size} logged</small></button>
      <button class="tile" data-nav="#/library"><span class="glyph" aria-hidden="true">📚</span>Exercise Library<small>${[...S.ex.values()].filter((e) => !e.archived).length} exercises</small></button>
      <button class="tile" data-nav="#/settings"><span class="glyph" aria-hidden="true">⚙️</span>Settings<small>Fields &amp; backup</small></button>
    </nav>`;
}

function renderPlaceholder(title, text) {
  app.innerHTML = topbar(title, '#/', 'Home') + `<main><div class="empty">${esc(text)}</div></main>`;
}

// ============================================================
// Workouts list
// ============================================================
function renderWorkouts() {
  const cur = inProgress();
  const past = sortedWorkouts().filter((w) => w.endedAt);
  const item = (w) => {
    const names = w.entries.map((e) => exLabel(e).name);
    return `<button class="list-item" data-nav="#/workout/${w.id}"><div class="grow"><div class="title">${esc(w.name || 'Workout')}</div>
      <div class="sub">${esc(longDate(w.date))} · ${esc(timeOf(w.date))}${names.length ? ' · ' + esc(names.join(', ')) : ''}</div></div><span class="chev">›</span></button>`;
  };
  app.innerHTML = topbar('Workouts', '#/', 'Home') + `<main>
    ${cur ? `<button class="banner" style="margin:0 0 12px;width:100%" data-nav="#/workout/${cur.id}">Continue workout<small>${esc(cur.name || 'Workout')} · started ${esc(longDate(cur.date))} at ${esc(timeOf(cur.date))}</small></button>`
          : `<button class="primary block" data-act="start-workout" style="padding:14px;margin-bottom:12px">Start workout</button>`}
    <div class="section-label">History</div>
    ${past.length ? past.map(item).join('') : '<div class="empty">No finished workouts yet.</div>'}
  </main>`;
}

async function startWorkout() {
  const w = { id: db.uid(), name: '', date: new Date().toISOString(), endedAt: null, entries: [] };
  S.wo.set(w.id, w);
  await saveWorkout(w);
  go('#/workout/' + w.id);
}

// ============================================================
// Workout screen
// ============================================================
let curWorkoutId = null;
const curWorkout = () => S.wo.get(curWorkoutId);

function renderWorkout(id, focusSel) {
  curWorkoutId = id;
  const w = S.wo.get(id);
  const scroll = window.scrollY;
  app.innerHTML = topbar(w.endedAt ? 'Workout' : 'In progress', '#/workouts', 'Workouts') + `<main>
    <div class="wo-head">
      <input class="wo-name" data-wfield="name" value="${esc(w.name)}" placeholder="Workout name (optional)" autocomplete="off">
      <label class="wo-when">Date<input data-wfield="date" type="date" value="${localDateValue(w.date)}"></label>
      <label class="wo-when">Start time<input data-wfield="time" type="time" value="${localTimeValue(w.date)}"></label>
    </div>
    ${w.entries.map((e, i) => entryCard(w, e, i)).join('')}
    <button class="block" data-act="add-exercise" style="padding:14px">+ Add exercise</button>
    ${w.endedAt ? '' : `<button class="primary block" data-act="finish" style="padding:14px;margin-top:12px">Finish workout</button>`}
    <button class="ghost danger block" data-act="delete-workout" style="margin-top:20px">Delete workout</button>
  </main>`;
  if (focusSel) {
    const el = app.querySelector(focusSel);
    if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); return; }
  }
  window.scrollTo(0, scroll);
}

function rerenderEntry(entryId, focusSel) {
  const w = curWorkout();
  const idx = w.entries.findIndex((e) => e.id === entryId);
  const old = app.querySelector(`[data-entry="${entryId}"]`);
  if (idx < 0 || !old) return renderWorkout(w.id, focusSel);
  const tmp = document.createElement('div');
  tmp.innerHTML = entryCard(w, w.entries[idx], idx);
  old.replaceWith(tmp.firstElementChild);
  if (focusSel) { const el = app.querySelector(focusSel); if (el) el.focus(); }
}

function entryCard(w, e, idx) {
  const { name, variant } = exLabel(e);
  let workNo = 0;
  const sets = e.sets.map((s) => setRow(e, s, isWarmup(s) ? 'W' : String(++workNo))).join('');
  return `<section class="card entry" data-entry="${e.id}">
    <div class="entry-head"><h2>${esc(name)}${variant ? ` <span class="variant">· ${esc(variant)}</span>` : ''}</h2>
      <button data-act="entry-menu" aria-label="Exercise options">⋯</button></div>
    ${SETTINGS.history ? historyPanel(w, e) : ''}
    ${SETTINGS.rom || SETTINGS.rpe ? `<div class="legend">${SETTINGS.rom ? '<button data-act="scale" data-kind="rom">ROM ⓘ</button>' : ''}${SETTINGS.rpe ? '<button data-act="scale" data-kind="rpe">RPE ⓘ</button>' : ''}</div>` : ''}
    ${sets || '<div class="faint small" style="padding:6px 0">No sets yet.</div>'}
    <button class="block add-set" data-act="add-set">+ Add set</button>
    ${SETTINGS.notes ? `<textarea class="note" data-field="note" rows="1" placeholder="Notes">${esc(e.note)}</textarea>` : ''}
  </section>`;
}

function opts(max, val, start = 1) {
  let h = `<option value="">–</option>`;
  for (let i = start; i <= max; i++) h += `<option value="${i}"${val === i ? ' selected' : ''}>${i}</option>`;
  return h;
}

function setRow(e, s, label) {
  const types = s.types.length ? s.types.map((t) => `<span class="chip">${esc(t)}</span>`).join('') : 'Set type ▾';
  const metaParts = [];
  const cols = [];
  if (SETTINGS.setTypes) { metaParts.push(`<button class="type-btn${s.types.length ? '' : ' none'}" data-act="types">${types}</button>`); cols.push('minmax(0, 1fr)'); }
  else cols.push('minmax(0, 1fr)');
  if (SETTINGS.rom) { metaParts.push(`<label>ROM<select data-field="rom" aria-label="ROM">${opts(5, s.rom)}</select></label>`); cols.push('76px'); }
  if (SETTINGS.rpe) { metaParts.push(`<label>RPE<select data-field="rpe" aria-label="RPE">${opts(10, s.rpe)}</select></label>`); cols.push('76px'); }
  if (!SETTINGS.setTypes && metaParts.length) metaParts.unshift('<span></span>');
  const meta = metaParts.length ? `<div class="set-meta" style="grid-template-columns:${cols.join(' ')}">${metaParts.join('')}</div>` : '';
  let sub = '';
  if (SETTINGS.setTypes && s.types.includes('Drop Set')) {
    sub += `<div class="sub-rows">${s.drops.map((d, i) => `<div class="sub-row" data-drop="${i}">
        <span class="lbl">Drop ${i + 1}</span>
        <button class="pm" data-act="flip" aria-label="Plus or minus">±</button>
        <input class="num" data-field="drop-weight" inputmode="decimal" value="${fmtNum(d.weight)}" placeholder="lb" autocomplete="off">
        <span class="x">×</span>
        <input class="num" data-field="drop-reps" inputmode="numeric" pattern="[0-9]*" value="${fmtNum(d.reps)}" placeholder="reps" autocomplete="off">
        <button class="rm" data-act="rm-drop" aria-label="Remove drop">✕</button></div>`).join('')}
      <button class="sub-add" data-act="add-drop">+ Add drop</button></div>`;
  }
  if (SETTINGS.setTypes && s.types.includes('Myo-rep Match')) {
    sub += `<div class="sub-rows"><div class="myo-line">Target <input data-field="myo-target" inputmode="numeric" pattern="[0-9]*" value="${fmtNum(s.myo.target)}" placeholder="–" autocomplete="off">
        <span class="myo-total" data-myo-total>${esc(myoSummary(s))}</span></div>
      <div class="minis">${s.myo.minis.map((m, i) => `<span class="mini" data-mini="${i}">+<input data-field="mini-reps" inputmode="numeric" pattern="[0-9]*" value="${fmtNum(m)}" placeholder="reps" autocomplete="off"><button class="rm" data-act="rm-mini" aria-label="Remove mini-set">✕</button></span>`).join('')}
        <button class="sub-add" data-act="add-mini">+ Add mini-set</button></div></div>`;
  }
  return `<div class="set" data-set="${s.id}">
    <div class="set-main">
      <span class="set-no${label === 'W' ? ' warm' : ''}">${label}</span>
      <button class="pm" data-act="flip" aria-label="Plus or minus">±</button>
      <input class="num" data-field="weight" inputmode="decimal" value="${fmtNum(s.weight)}" placeholder="lb" autocomplete="off">
      <span class="x">×</span>
      <input class="num" data-field="reps" inputmode="numeric" pattern="[0-9]*" value="${fmtNum(s.reps)}" placeholder="reps" autocomplete="off">
      <button class="more" data-act="set-menu" aria-label="Set options">⋯</button>
    </div>
    ${meta}${sub}
  </div>`;
}

function myoSummary(s) {
  const base = s.reps ?? 0;
  const minis = s.myo.minis.map((m) => m ?? 0);
  const total = base + minis.reduce((a, b) => a + b, 0);
  const expr = [base, ...minis].join(' + ');
  return `${expr} = ${total}${s.myo.target ? ' / ' + s.myo.target : ''}`;
}
function updateMyoTotal(setEl, s) {
  const el = setEl.querySelector('[data-myo-total]');
  if (!el) return;
  el.textContent = myoSummary(s);
  const total = (s.reps ?? 0) + s.myo.minis.reduce((a, b) => a + (b ?? 0), 0);
  el.classList.toggle('hit', !!s.myo.target && total >= s.myo.target);
}

// "Last 3 sessions" for this exercise + variant (working sets only, plus notes)
function formatSet(s) {
  const wr = (w, r) => `${w === null ? '–' : fmtNum(w) + ' lb'} × ${r === null ? '–' : fmtNum(r)}`;
  let t = wr(s.weight, s.reps);
  if (SETTINGS.setTypes && s.types.includes('Drop Set')) s.drops.forEach((d) => { if (d.weight !== null || d.reps !== null) t += ` → ${wr(d.weight, d.reps)}`; });
  if (SETTINGS.setTypes && s.types.includes('Myo-rep Match')) { const m = s.myo.minis.filter((x) => x !== null); if (m.length) t += ' +' + m.join('+'); }
  if (SETTINGS.rpe && s.rpe) t += ` @${s.rpe}`;
  return t;
}
function historyFor(exerciseId, variantId, excludeId, beforeIso, limit = 3) {
  const out = [];
  for (const w of sortedWorkouts()) {
    if (w.id === excludeId || (beforeIso && w.date > beforeIso)) continue;
    const entries = w.entries.filter((e) => e.exerciseId === exerciseId && (e.variantId || null) === (variantId || null));
    if (!entries.length) continue;
    const sets = entries.flatMap((e) => e.sets).filter((s) => !isWarmup(s) && !isBlank(s));
    const notes = SETTINGS.notes ? entries.map((e) => e.note).filter(Boolean) : [];
    if (!sets.length && !notes.length) continue;
    out.push({ date: w.date, sets, notes });
    if (out.length >= limit) break;
  }
  return out;
}
function historyPanel(w, e) {
  const h = historyFor(e.exerciseId, e.variantId, w.id, w.date);
  if (!h.length) return `<div class="history faint">No previous sessions yet.</div>`;
  return `<div class="history">${h.map((x) => `<div class="h-row"><span class="h-date">${esc(shortDate(x.date))}</span> ${esc(x.sets.map(formatSet).join(', ') || '—')}</div>
    ${x.notes.map((n) => `<div class="h-note">“${esc(n)}”</div>`).join('')}`).join('')}</div>`;
}

// ---------- finding what was tapped ----------
function ctx(el) {
  const w = curWorkout();
  const entryEl = el.closest('[data-entry]');
  const entry = entryEl ? w.entries.find((x) => x.id === entryEl.dataset.entry) : null;
  const setEl = el.closest('[data-set]');
  const set = entry && setEl ? entry.sets.find((x) => x.id === setEl.dataset.set) : null;
  const dropEl = el.closest('[data-drop]');
  const miniEl = el.closest('[data-mini]');
  return { w, entry, set, setEl, drop: dropEl ? +dropEl.dataset.drop : null, mini: miniEl ? +miniEl.dataset.mini : null };
}

function newSet() { return { id: db.uid(), weight: null, reps: null, types: [], rom: null, rpe: null, drops: [], myo: { target: null, minis: [] } }; }

function autoMyoTarget(entry, set) {
  const i = entry.sets.indexOf(set);
  for (let j = i - 1; j >= 0; j--) {
    const p = entry.sets[j];
    if (!isWarmup(p) && p.reps !== null) return p.reps;
  }
  return null;
}

// typing in a field: update the data and save immediately (no Save button needed)
function onWorkoutInput(el) {
  const c = ctx(el);
  const f = el.dataset.field;
  const v = el.value;
  if (el.dataset.wfield === 'name') { c.w.name = v; }
  else if (el.dataset.wfield === 'date') {
    if (!v) return;
    const [y, m, d] = v.split('-').map(Number);
    const old = new Date(c.w.date);
    c.w.date = new Date(y, m - 1, d, old.getHours(), old.getMinutes()).toISOString();
  }
  else if (el.dataset.wfield === 'time') {
    if (!v) return;
    const [hh, mm] = v.split(':').map(Number);
    const d = new Date(c.w.date);
    d.setHours(hh, mm, 0, 0);
    c.w.date = d.toISOString();
  }
  else if (f === 'note') { c.entry.note = v; }
  else if (c.set) {
    const s = c.set;
    if (f === 'weight') s.weight = parseWeight(v);
    else if (f === 'reps') s.reps = parseInt10(v);
    else if (f === 'rom') s.rom = parseInt10(v);
    else if (f === 'rpe') s.rpe = parseInt10(v);
    else if (f === 'drop-weight') s.drops[c.drop].weight = parseWeight(v);
    else if (f === 'drop-reps') s.drops[c.drop].reps = parseInt10(v);
    else if (f === 'myo-target') s.myo.target = parseInt10(v);
    else if (f === 'mini-reps') s.myo.minis[c.mini] = parseInt10(v);
    if (s.types.includes('Myo-rep Match')) updateMyoTotal(c.setEl, s);
  } else return;
  saveWorkout(c.w);
}

async function onWorkoutAction(act, el) {
  const c = ctx(el);
  const w = c.w;
  switch (act) {
    case 'add-exercise': return openPicker();
    case 'add-set': {
      const s = newSet();
      c.entry.sets.push(s);
      await saveWorkout(w);
      return rerenderEntry(c.entry.id, `[data-set="${s.id}"] [data-field="weight"]`);
    }
    case 'flip': {
      const input = el.parentElement.querySelector('input[data-field$="weight"]');
      const v = input.value.trim();
      input.value = v.startsWith('-') ? v.slice(1) : '-' + v;
      input.focus();
      onWorkoutInput(input);
      return;
    }
    case 'scale': return showScale(el.dataset.kind);
    case 'types': return openTypes(c.entry, c.set);
    case 'add-drop': c.set.drops.push({ weight: null, reps: null }); await saveWorkout(w);
      return rerenderEntry(c.entry.id, `[data-set="${c.set.id}"] [data-drop="${c.set.drops.length - 1}"] [data-field="drop-weight"]`);
    case 'rm-drop': c.set.drops.splice(c.drop, 1); await saveWorkout(w); return rerenderEntry(c.entry.id);
    case 'add-mini': c.set.myo.minis.push(null); await saveWorkout(w);
      return rerenderEntry(c.entry.id, `[data-set="${c.set.id}"] [data-mini="${c.set.myo.minis.length - 1}"] input`);
    case 'rm-mini': c.set.myo.minis.splice(c.mini, 1); await saveWorkout(w); return rerenderEntry(c.entry.id);
    case 'set-menu': return openSetMenu(c.entry, c.set);
    case 'entry-menu': return openEntryMenu(c.entry);
    case 'finish': return finishWorkout(w);
    case 'delete-workout':
      if (await confirmSheet('Delete this whole workout? This cannot be undone.')) {
        S.wo.delete(w.id); await db.remove('workouts', w.id); go('#/workouts');
      }
      return;
  }
}

function openTypes(entry, set) {
  const html = () => `<h3>Set type</h3><p class="muted small" style="margin:-6px 0 12px">Pick any that apply.</p>
    ${SET_TYPES.map((t) => `<button class="opt${set.types.includes(t) ? ' on' : ''}" data-t="${esc(t)}"><span>${esc(t)}</span><span class="tick">${set.types.includes(t) ? '✓' : ''}</span></button>`).join('')}
    <div class="actions"><button class="primary" data-a="done">Done</button></div>`;
  const sheet = openSheet(html(), (e, sh) => {
    const b = e.target.closest('[data-t]');
    if (b) {
      const t = b.dataset.t;
      if (set.types.includes(t)) set.types = set.types.filter((x) => x !== t);
      else {
        set.types = SET_TYPES.filter((x) => x === t || set.types.includes(x));
        if (t === 'Drop Set' && !set.drops.length) set.drops.push({ weight: null, reps: null });
        if (t === 'Myo-rep Match') {
          if (set.myo.target === null) set.myo.target = autoMyoTarget(entry, set);
          if (!set.myo.minis.length) set.myo.minis.push(null);
        }
      }
      saveWorkout(curWorkout());
      sh.innerHTML = html();
      return;
    }
    if (e.target.closest('[data-a="done"]')) { closeSheet(); rerenderEntry(entry.id); }
  });
  // closing by tapping outside also refreshes the card
  const back = sheet.parentElement;
  back.addEventListener('click', (e) => { if (e.target === back) rerenderEntry(entry.id); });
}

function openSetMenu(entry, set) {
  openSheet(`<h3>Set options</h3><button class="opt danger" data-a="del">Delete set</button><div class="actions"><button data-a="close">Cancel</button></div>`,
    async (e) => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      closeSheet();
      if (a.dataset.a === 'del') { entry.sets = entry.sets.filter((s) => s !== set); await saveWorkout(curWorkout()); rerenderEntry(entry.id); }
    });
}

function openEntryMenu(entry) {
  const w = curWorkout();
  const i = w.entries.indexOf(entry);
  openSheet(`<h3>${esc(exLabel(entry).name)}</h3>
    ${i > 0 ? '<button class="opt" data-a="up">Move up</button>' : ''}
    ${i < w.entries.length - 1 ? '<button class="opt" data-a="down">Move down</button>' : ''}
    <button class="opt danger" data-a="remove">Remove from workout</button>
    <div class="actions"><button data-a="close">Cancel</button></div>`,
    async (e) => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      closeSheet();
      if (a.dataset.a === 'up' || a.dataset.a === 'down') {
        const j = a.dataset.a === 'up' ? i - 1 : i + 1;
        [w.entries[i], w.entries[j]] = [w.entries[j], w.entries[i]];
        await saveWorkout(w); renderWorkout(w.id);
      } else if (a.dataset.a === 'remove') {
        const hasData = entry.sets.some((s) => !isBlank(s)) || entry.note;
        if (hasData && !(await confirmSheet('Remove this exercise and its sets from the workout?', 'Remove'))) return;
        w.entries = w.entries.filter((x) => x !== entry);
        await saveWorkout(w); renderWorkout(w.id);
      }
    });
}

async function finishWorkout(w) {
  // tidy up: drop completely empty sets and empty exercises
  w.entries.forEach((e) => {
    e.sets = e.sets.filter((s) => !isBlank(s));
    e.sets.forEach((s) => {
      s.drops = s.drops.filter((d) => d.weight !== null || d.reps !== null);
      s.myo.minis = s.myo.minis.filter((m) => m !== null);
    });
  });
  w.entries = w.entries.filter((e) => e.sets.length || e.note);
  w.endedAt = new Date().toISOString();
  await saveWorkout(w);
  go('#/workouts');
}

// ============================================================
// Exercise picker (adding an exercise to a workout)
// ============================================================
function openPicker() {
  const sheet = openSheet(`<h3>Add exercise</h3>
    <input id="pick-q" placeholder="Search or type a new exercise" autocomplete="off" autocapitalize="words">
    <div class="pick-list" id="pick-list"></div>`, onPickClick, (e, sh) => { if (e.target.id === 'pick-q') drawPickList(sh); });
  drawPickList(sheet);
  const q = sheet.querySelector('#pick-q');
  q.focus();
}

function drawPickList(sheet) {
  const q = sheet.querySelector('#pick-q').value.trim();
  const ql = q.toLowerCase();
  const all = [...S.ex.values()].filter((x) => !x.archived);
  const match = all.filter((x) => !ql || x.name.toLowerCase().includes(ql));
  const btn = (x) => `<button data-pick="${x.id}">${esc(x.name)}</button>`;
  let html = '';
  const exact = all.find((x) => x.name.toLowerCase() === ql);
  if (q && !exact) html += `<button class="primary" data-create="1">+ Add “${esc(q)}” to library</button>`;
  if (!all.length) html += `<div class="faint small" style="padding:8px 2px">Your library is empty. Type a name above to add your first exercise.</div>`;
  else html += match.sort(byName).map(btn).join('');
  sheet.querySelector('#pick-list').innerHTML = html;
}

async function onPickClick(e, sheet) {
  const pick = e.target.closest('[data-pick]');
  const create = e.target.closest('[data-create]');
  const vpick = e.target.closest('[data-vpick]');
  if (create) {
    const name = sheet.querySelector('#pick-q').value.trim();
    if (!name) return;
    const ex = { id: db.uid(), name, variants: [], archived: false, createdAt: new Date().toISOString(), lastUsed: null };
    S.ex.set(ex.id, ex); await saveExercise(ex);
    if (!SETTINGS.variant) return addEntry(ex, null);
    return drawVariantStep(sheet, ex, true);
  }
  if (pick) {
    const ex = S.ex.get(pick.dataset.pick);
    const vs = activeVariants(ex);
    if (!SETTINGS.variant) return addEntry(ex, null);
    if (vs.length <= 1) return addEntry(ex, vs[0] ? vs[0].id : null);
    return drawVariantStep(sheet, ex, false);
  }
  if (vpick) {
    const ex = S.ex.get(sheet.dataset.ex);
    return addEntry(ex, vpick.dataset.vpick || null);
  }
  if (e.target.closest('[data-newvar]')) {
    const ex = S.ex.get(sheet.dataset.ex);
    const input = sheet.querySelector('#newvar');
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    let v = ex.variants.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!v) { v = { id: db.uid(), name, archived: false }; ex.variants.push(v); }
    v.archived = false;
    await saveExercise(ex);
    return addEntry(ex, v.id);
  }
  if (e.target.closest('[data-back]')) {
    sheet.innerHTML = `<h3>Add exercise</h3><input id="pick-q" placeholder="Search or type a new exercise" autocomplete="off" autocapitalize="words"><div class="pick-list" id="pick-list"></div>`;
    drawPickList(sheet);
  }
}

function drawVariantStep(sheet, ex, isNew) {
  sheet.dataset.ex = ex.id;
  const vs = activeVariants(ex);
  sheet.innerHTML = `<h3>${esc(ex.name)}</h3>
    <p class="muted small" style="margin:-6px 0 12px">${isNew ? 'Added to your library. Pick a variant, add one, or skip.' : 'Which variant?'}</p>
    <div class="variant-grid">${vs.map((v) => `<button data-vpick="${v.id}">${esc(v.name)}</button>`).join('')}</div>
    <div class="row" style="margin-top:10px"><input id="newvar" class="grow" placeholder="New variant (e.g. Dumbbell)" autocomplete="off" autocapitalize="words"><button data-newvar="1">Add</button></div>
    <div class="actions">${isNew ? '<button data-vpick="">No variant</button>' : '<button data-back="1">‹ Back</button>'}</div>`;
}

async function addEntry(ex, variantId) {
  const w = curWorkout();
  const entry = { id: db.uid(), exerciseId: ex.id, variantId: variantId || null, note: '', sets: [newSet()] };
  w.entries.push(entry);
  ex.lastUsed = new Date().toISOString();
  await Promise.all([saveWorkout(w), saveExercise(ex)]);
  closeSheet();
  renderWorkout(w.id, `[data-entry="${entry.id}"] [data-field="weight"]`);
}

// ============================================================
// Exercise Library
// ============================================================
function usage(exId, varId) {
  let n = 0;
  for (const w of S.wo.values()) for (const e of w.entries) if (e.exerciseId === exId && (varId === undefined || e.variantId === varId)) n++;
  return n;
}

function renderLibrary() {
  const all = [...S.ex.values()].sort(byName);
  const active = all.filter((x) => !x.archived);
  const archived = all.filter((x) => x.archived);
  const item = (x) => {
    const vs = activeVariants(x);
    return `<button class="list-item" data-nav="#/exercise/${x.id}"><div class="grow"><div class="title">${esc(x.name)}</div>
      ${SETTINGS.variant ? `<div class="sub">${vs.length ? esc(vs.map((v) => v.name).join(' · ')) : 'No variants'}</div>` : ''}</div><span class="chev">›</span></button>`;
  };
  app.innerHTML = topbar('Exercise Library', '#/', 'Home') + `<main>
    <div class="row" style="margin-bottom:12px"><input id="new-ex" class="grow" placeholder="New exercise name" autocomplete="off" autocapitalize="words"><button class="primary" data-act="lib-add">Add</button></div>
    ${active.length ? active.map(item).join('') : '<div class="empty">Your library is empty. Add your first exercise above, or add exercises on the fly while logging a workout.</div>'}
    ${archived.length ? `<div class="section-label">Archived</div>${archived.map(item).join('')}` : ''}
  </main>`;
}

async function libraryAdd() {
  const input = document.getElementById('new-ex');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const existing = [...S.ex.values()].find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (existing) { go('#/exercise/' + existing.id); return; }
  const ex = { id: db.uid(), name, variants: [], archived: false, createdAt: new Date().toISOString(), lastUsed: null };
  S.ex.set(ex.id, ex); await saveExercise(ex);
  go('#/exercise/' + ex.id);
}

let curExId = null;
function renderExerciseEdit(id) {
  curExId = id;
  const ex = S.ex.get(id);
  const uses = usage(ex.id);
  const vrow = (v) => `<div class="var-row" data-var="${v.id}"><input data-vfield="name" value="${esc(v.name)}" autocomplete="off" autocapitalize="words">
    <button data-act="${v.archived ? 'var-restore' : 'var-remove'}">${v.archived ? 'Restore' : (usage(ex.id, v.id) ? 'Archive' : 'Delete')}</button></div>`;
  const live = ex.variants.filter((v) => !v.archived);
  const arch = ex.variants.filter((v) => v.archived);
  const variantsCard = !SETTINGS.variant ? '' : `<div class="card"><div style="font-weight:600;margin-bottom:8px">Variants</div>
      ${live.map(vrow).join('') || '<div class="faint small" style="margin-bottom:8px">No variants yet.</div>'}
      <div class="row"><input id="new-var" class="grow" placeholder="Add variant (e.g. Barbell)" autocomplete="off" autocapitalize="words"><button data-act="var-add">Add</button></div>
      ${arch.length ? `<div class="section-label">Archived variants</div>${arch.map(vrow).join('')}` : ''}
    </div>`;
  app.innerHTML = topbar(ex.name, '#/library', 'Library') + `<main>
    <div class="card"><label class="muted small">Exercise name</label><input data-exfield="name" value="${esc(ex.name)}" autocomplete="off" autocapitalize="words" style="margin-top:4px">
      <div class="faint small" style="margin-top:6px">Logged in ${uses} workout${uses === 1 ? '' : 's'}</div></div>
    ${variantsCard}
    ${ex.archived ? '<button class="block" data-act="ex-restore">Restore exercise</button>'
      : `<button class="ghost danger block" data-act="ex-remove">${uses ? 'Archive exercise' : 'Delete exercise'}</button>
         ${uses ? '<p class="faint small" style="text-align:center">Archiving hides it from the picker but keeps all its history.</p>' : ''}`}
  </main>`;
}

async function onExerciseAction(act, el) {
  const ex = S.ex.get(curExId);
  const vEl = el.closest('[data-var]');
  const v = vEl ? ex.variants.find((x) => x.id === vEl.dataset.var) : null;
  if (act === 'var-add') {
    const input = document.getElementById('new-var');
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    if (!ex.variants.some((x) => x.name.toLowerCase() === name.toLowerCase())) ex.variants.push({ id: db.uid(), name, archived: false });
    await saveExercise(ex); renderExerciseEdit(ex.id);
    document.getElementById('new-var').focus();
  } else if (act === 'var-remove') {
    if (usage(ex.id, v.id)) v.archived = true; else ex.variants = ex.variants.filter((x) => x !== v);
    await saveExercise(ex); renderExerciseEdit(ex.id);
  } else if (act === 'var-restore') {
    v.archived = false; await saveExercise(ex); renderExerciseEdit(ex.id);
  } else if (act === 'ex-remove') {
    if (usage(ex.id)) { ex.archived = true; await saveExercise(ex); go('#/library'); }
    else if (await confirmSheet(`Delete “${ex.name}”?`)) { S.ex.delete(ex.id); await db.remove('exercises', ex.id); go('#/library'); }
  } else if (act === 'ex-restore') {
    ex.archived = false; await saveExercise(ex); renderExerciseEdit(ex.id);
  }
}

function onExerciseInput(el) {
  const ex = S.ex.get(curExId);
  if (el.dataset.exfield === 'name') {
    const name = el.value.trim();
    if (!name) return;
    ex.name = name;
    document.querySelector('.topbar h1').textContent = name;
  } else if (el.dataset.vfield === 'name') {
    const v = ex.variants.find((x) => x.id === el.closest('[data-var]').dataset.var);
    const name = el.value.trim();
    if (!name) return;
    v.name = name;
  } else return;
  saveExercise(ex);
}



// ============================================================
// Progress dashboard
// ============================================================
const comboKey = (exerciseId, variantId) => `${exerciseId}|${variantId || ''}`;
const e1rm = (s) => s.weight * (1 + s.reps / 30);
const usable = (s) => !isWarmup(s) && s.weight !== null && s.reps !== null;

function progressCombos() {
  const seen = new Map();
  for (const w of sortedWorkouts()) {
    for (const e of w.entries) {
      if (!e.sets.some(usable)) continue;
      const k = comboKey(e.exerciseId, e.variantId);
      if (seen.has(k)) continue;
      const ex = S.ex.get(e.exerciseId);
      const v = ex && e.variantId ? ex.variants.find((x) => x.id === e.variantId) : null;
      seen.set(k, { key: k, label: (ex ? ex.name : '(deleted)') + (v ? ' · ' + v.name : '') });
    }
  }
  return [...seen.values()];
}

// One point per workout. Only working sets, only base reps.
function progressPoints(key, mode) {
  const pts = [];
  const workouts = [...S.wo.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const w of workouts) {
    const sets = w.entries.filter((e) => comboKey(e.exerciseId, e.variantId) === key).flatMap((e) => e.sets).filter(usable);
    if (!sets.length) continue;
    const heaviest = sets.reduce((best, s) => (!best || s.weight > best.weight || (s.weight === best.weight && s.reps > best.reps) ? s : best), null);
    let pick = heaviest;
    if (mode === 'e1rm' && heaviest.weight > 0) {
      pick = sets.filter((s) => s.weight > 0).reduce((best, s) => (!best || e1rm(s) > e1rm(best) ? s : best), null);
    }
    pts.push({ date: w.date, weight: pick.weight, reps: pick.reps });
  }
  return pts;
}

function repPRs(key) {
  const best = new Map();
  const workouts = [...S.wo.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const w of workouts) {
    for (const e of w.entries) {
      if (comboKey(e.exerciseId, e.variantId) !== key) continue;
      for (const s of e.sets.filter(usable)) {
        if (s.reps < 1) continue;
        const cur = best.get(s.reps);
        if (!cur || s.weight > cur.weight) best.set(s.reps, { reps: s.reps, weight: s.weight, date: w.date });
      }
    }
  }
  return [...best.values()].sort((a, b) => a.reps - b.reps);
}

function niceStep(range, targetTicks) {
  const raw = range / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function renderProgress() {
  const combos = progressCombos();
  if (!combos.length) {
    app.innerHTML = topbar('Progress', '#/', 'Home') + `<main><div class="empty">Log some working sets and your progress charts will show up here.</div></main>`;
    return;
  }
  if (!combos.some((c) => c.key === META.progressKey)) META.progressKey = combos[0].key;
  const mode = META.chartMode === 'e1rm' ? 'e1rm' : 'heaviest';
  const sorted = [...combos].sort((a, b) => a.label.localeCompare(b.label));
  const prs = repPRs(META.progressKey);
  app.innerHTML = topbar('Progress', '#/', 'Home') + `<main>
    <select id="prog-ex" class="prog-select" aria-label="Exercise">${sorted.map((c) => `<option value="${esc(c.key)}"${c.key === META.progressKey ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
    <div class="seg-label">Chart workout progress by:</div>
    <div class="seg" role="group" aria-label="Chart workout progress by">
      <button data-act="mode" data-mode="heaviest" class="${mode === 'heaviest' ? 'on' : ''}">Heaviest set</button>
      <button data-act="mode" data-mode="e1rm" class="${mode === 'e1rm' ? 'on' : ''}">Best est. max</button>
    </div>
    <div class="card chart-card">
      <div class="chart-legend"><span><i class="lg-line"></i>Weight (lb)</span><span><i class="lg-bar"></i>Reps</span></div>
      <div class="chart" id="chart"></div>
    </div>
    <div class="section-label">Rep PRs</div>
    <div class="card" style="padding:4px 12px">
      <table class="pr-table"><thead><tr><th>Reps</th><th>Best weight</th><th>Date</th></tr></thead>
      <tbody>${prs.map((r) => `<tr><td>${r.reps}</td><td>${fmtNum(r.weight)} lb</td><td>${esc(new Date(r.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}</td></tr>`).join('')}</tbody></table>
    </div>
    <p class="faint small" style="text-align:center">Working sets only · base reps only (drops and myo-rep mini-sets don't count)</p>
  </main>`;
  drawChart(progressPoints(META.progressKey, mode));
}

function drawChart(pts) {
  const box = document.getElementById('chart');
  const H = 260, top = 8, bottom = 30, AX_L = 46, AX_R = 30, SP = 58;
  const plotH = H - top - bottom;
  const avail = box.clientWidth - AX_L - AX_R;
  const W = Math.max(avail, pts.length * SP);
  const xs = pts.map((_, i) => (pts.length === 1 ? W / 2 : SP / 2 + i * ((W - SP) / (pts.length - 1))));
  // weight sits in the upper part of the chart, reps bars in the lower third
  const ws = pts.map((p) => p.weight);
  let lo = Math.min(...ws), hi = Math.max(...ws);
  if (hi - lo < 1e-9) { const pad = Math.max(5, Math.abs(hi) * 0.1); lo -= pad; hi += pad; }
  const bandTop = 0.12, bandBot = 0.58;
  const span = (hi - lo) / (bandBot - bandTop);
  const dHi = hi + span * bandTop, dLo = dHi - span;
  const yW = (v) => top + (dHi - v) / (dHi - dLo) * plotH;
  const maxReps = Math.max(...pts.map((p) => p.reps), 1);
  const rTop = maxReps / 0.33;
  const yR = (v) => top + plotH - (v / rTop) * plotH;
  const step = niceStep(dHi - dLo, 4);
  const ticks = [];
  for (let t = Math.ceil(dLo / step) * step; t <= dHi + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100);
  const rStep = niceStep(rTop, 3);
  const rTicks = [];
  for (let t = 0; t <= rTop + 1e-9; t += rStep) rTicks.push(Math.round(t * 10) / 10);
  const grid = ticks.map((t) => `<line class="c-grid" x1="0" x2="${W}" y1="${yW(t)}" y2="${yW(t)}"/>`).join('');
  const bw = Math.min(26, SP * 0.45);
  const bars = pts.map((p, i) => { const y = yR(p.reps), h = top + plotH - y; return `<path class="c-bar" d="M${xs[i] - bw / 2},${top + plotH} V${y + 4} q0,-4 4,-4 H${xs[i] + bw / 2 - 4} q4,0 4,4 V${top + plotH} Z"/>
    <text class="c-rep" x="${xs[i]}" y="${top + plotH - 6}">${p.reps}</text>`; }).join('');
  const line = pts.length > 1 ? `<polyline class="c-line" points="${pts.map((p, i) => `${xs[i]},${yW(p.weight)}`).join(' ')}"/>` : '';
  const dots = pts.map((p, i) => `<circle class="c-dot" cx="${xs[i]}" cy="${yW(p.weight)}" r="4.5"/><text class="c-wlabel" x="${xs[i]}" y="${yW(p.weight) - 10}">${fmtNum(p.weight)}</text>`).join('');
  const dates = pts.map((p, i) => `<text class="c-date" x="${xs[i]}" y="${H - 10}">${esc(shortDate(p.date))}</text>`).join('');
  const left = `<svg width="${AX_L}" height="${H}" class="c-axis">${ticks.map((t) => `<text x="${AX_L - 6}" y="${yW(t) + 4}" text-anchor="end">${fmtNum(t)}</text>`).join('')}<text x="4" y="${top + 2}" class="c-unit" text-anchor="start" dominant-baseline="hanging">lb</text></svg>`;
  const right = `<svg width="${AX_R}" height="${H}" class="c-axis">${rTicks.map((t) => `<text x="6" y="${yR(t) + 4}">${fmtNum(t)}</text>`).join('')}</svg>`;
  box.innerHTML = `${left}<div class="c-scroll" id="c-scroll"><svg width="${W}" height="${H}" role="img" aria-label="Weight and reps per workout">
    <line class="c-base" x1="0" x2="${W}" y1="${top + plotH}" y2="${top + plotH}"/>${grid}${bars}${line}${dots}${dates}</svg></div>${right}`;
  const sc = document.getElementById('c-scroll');
  sc.scrollLeft = sc.scrollWidth; // newest on screen
  if (W > avail + 1) box.insertAdjacentHTML('afterend', `<div class="faint small" style="text-align:center;padding:2px 0 6px">‹ swipe the chart for older workouts · ${pts.length} total</div>`);
}

async function onProgressAction(act, el) {
  if (act === 'mode') { META.chartMode = el.dataset.mode; await saveMeta(); renderProgress(); }
}

// ============================================================
// Settings + CSV export
// ============================================================
function daysSince(iso) { return iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null; }
function backupText() {
  const d = daysSince(META.lastBackup);
  if (d === null) return 'Never backed up';
  if (d === 0) return 'Backed up today';
  return `Last backup ${d} day${d === 1 ? '' : 's'} ago`;
}
const needsBackup = () => S.wo.size > 0 && (META.lastBackup === null || daysSince(META.lastBackup) >= 14);

function renderSettings() {
  app.innerHTML = topbar('Settings', '#/', 'Home') + `<main>
    <div class="section-label">Fields to show</div>
    <div class="card">
      ${SETTING_LABELS.map(([k, label, hint]) => `<label class="toggle-row"><span class="grow"><span class="t-label">${esc(label)}</span><span class="t-hint">${esc(hint)}</span></span>
        <input type="checkbox" class="switch" data-setting="${k}"${SETTINGS[k] ? ' checked' : ''}></label>`).join('')}
      <p class="faint small" style="margin:10px 0 0">Exercise, weight and reps are always shown. Turning a field off only hides it; anything already logged is kept.</p>
    </div>
    <div class="section-label">Data</div>
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:10px"><span>${S.wo.size} workout${S.wo.size === 1 ? '' : 's'} on this phone</span>
        <span class="small ${needsBackup() ? 'warn' : 'muted'}">${esc(backupText())}</span></div>
      <button class="primary block" data-act="export">Export CSV backup</button>
      <p class="faint small" style="margin:10px 0 0">Choose “Save to Files” to keep a copy. The file opens in Numbers, Excel or Google Sheets. Your data only lives on this phone, so a backup every couple of weeks is a good habit.</p>
      <div id="export-msg" class="small muted" style="margin-top:8px"></div>
    </div>
    <p class="faint small" style="text-align:center;margin-top:24px">Lift Log ${esc(APP_VERSION)}</p>
  </main>`;
}

const CSV_COLS = ['workout_id', 'workout_date', 'workout_name', 'exercise', 'variant', 'set_number', 'segment_number', 'segment_kind',
  'weight', 'reps', 'set_types', 'myo_target', 'rom', 'rpe', 'exercise_note'];

function csvDate(iso) {
  const d = new Date(iso);
  return `${localDateValue(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function toCSV() {
  const q = (v) => { const t = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const lines = [CSV_COLS.join(',')];
  const workouts = [...S.wo.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const w of workouts) {
    for (const e of w.entries) {
      const ex = S.ex.get(e.exerciseId);
      const v = ex && e.variantId ? ex.variants.find((x) => x.id === e.variantId) : null;
      const base = { workout_id: w.id, workout_date: csvDate(w.date), workout_name: w.name, exercise: ex ? ex.name : '', variant: v ? v.name : '', exercise_note: e.note };
      const push = (row) => lines.push(CSV_COLS.map((c) => q({ ...base, ...row }[c])).join(','));
      const sets = e.sets.filter((st) => !isBlank(st));
      if (!sets.length) { if (e.note) push({}); continue; }
      sets.forEach((st, i) => {
        push({ set_number: i + 1, segment_number: 0, segment_kind: 'base', weight: st.weight, reps: st.reps, set_types: st.types.join('|'),
          myo_target: st.types.includes('Myo-rep Match') ? st.myo.target : null, rom: st.rom, rpe: st.rpe });
        if (st.types.includes('Drop Set')) st.drops.forEach((d, j) => push({ set_number: i + 1, segment_number: j + 1, segment_kind: 'drop', weight: d.weight, reps: d.reps, set_types: st.types.join('|') }));
        if (st.types.includes('Myo-rep Match')) st.myo.minis.forEach((m, j) => push({ set_number: i + 1, segment_number: j + 1, segment_kind: 'myo', weight: st.weight, reps: m, set_types: st.types.join('|') }));
      });
    }
  }
  return lines.join('\r\n') + '\r\n';
}

async function exportCSV() {
  const msg = document.getElementById('export-msg');
  const name = `lift-log-${localDateValue(new Date().toISOString())}.csv`;
  const file = new File([toCSV()], name, { type: 'text/csv' });
  let done = false;
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      done = true;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') { if (msg) msg.textContent = 'Export cancelled.'; return; }
  }
  if (!done) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  META.lastBackup = new Date().toISOString();
  await saveMeta();
  renderSettings();
  const m2 = document.getElementById('export-msg');
  if (m2) m2.textContent = `Exported ${name}.`;
}

// ============================================================
// Event wiring (one listener for the whole app)
// ============================================================
app.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { go(nav.dataset.nav); return; }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'start-workout') return startWorkout();
  if (act === 'lib-add') return libraryAdd();
  if (act === 'export') return exportCSV();
  if (location.hash.startsWith('#/progress')) return onProgressAction(act, a);
  if (location.hash.startsWith('#/exercise/')) return onExerciseAction(act, a);
  if (location.hash.startsWith('#/workout/')) return onWorkoutAction(act, a);
});

function onAnyInput(e) {
  const el = e.target;
  if (location.hash.startsWith('#/workout/')) return onWorkoutInput(el);
  if (location.hash.startsWith('#/exercise/')) return onExerciseInput(el);
}
app.addEventListener('input', onAnyInput);
app.addEventListener('change', async (e) => {
  if (e.target.id === 'prog-ex') { META.progressKey = e.target.value; await saveMeta(); renderProgress(); return; }
  const k = e.target.dataset.setting;
  if (k) { SETTINGS[k] = e.target.checked; await saveSettings(); return; }
  if (e.target.tagName === 'SELECT' || e.target.type === 'date' || e.target.type === 'time') onAnyInput(e);
});

app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'new-ex') { e.preventDefault(); libraryAdd(); }
  if (e.target.id === 'new-var') { e.preventDefault(); onExerciseAction('var-add', e.target); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'newvar') { e.preventDefault(); e.target.parentElement.querySelector('[data-newvar]').click(); }
  if (e.key === 'Enter' && e.target.id === 'pick-q') {
    e.preventDefault();
    const first = document.querySelector('#pick-list button');
    if (first) first.click();
  }
});

// ============================================================
// Start up
// ============================================================
function showUpdateBanner() {
  if (document.getElementById('update-banner')) return;
  const el = document.createElement('button');
  el.id = 'update-banner';
  el.className = 'update-banner';
  el.textContent = 'Lift Log was updated · Tap to refresh';
  el.addEventListener('click', () => location.reload());
  document.body.appendChild(el);
}

async function boot() {
  const [exs, wos, st, mt] = await Promise.all([db.getAll('exercises'), db.getAll('workouts'), db.get('meta', 'settings'), db.get('meta', 'meta')]);
  if (st) SETTINGS = { ...DEFAULT_SETTINGS, ...st.value };
  if (mt) META = { ...META, ...mt.value };
  exs.forEach((x) => S.ex.set(x.id, x));
  wos.forEach((x) => S.wo.set(x.id, x));
  route();
  db.requestPersistence();
  try { indexedDB.deleteDatabase('liftlog-test'); localStorage.removeItem('liftlog-test-checks'); } catch (e) { /* ignore */ }
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      // check for a new version whenever the app comes back to the screen
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) showUpdateBanner(); });
  }
}
boot().catch((err) => { app.innerHTML = `<div class="empty">Something went wrong loading your data: ${esc(err.message)}</div>`; });

// for automated testing
window.__liftlog = { S, get SETTINGS() { return SETTINGS; }, toCSV, progressPoints, repPRs };
