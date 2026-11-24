import * as db from './db.js';
import { findNameMatches, normalizeWorkout, startOfWeek, dayKey, addDays, weeklyStreak, nameKey, nowIso } from './model.js';
import { buildExportZip, readImportFile, planImport } from './backup.js';

// ============================================================
// State: everything is loaded into memory at start; every change is
// written straight back to on-device storage.
// ============================================================
const S = { ex: new Map(), wo: new Map(), act: new Map(), merges: new Map() };
const app = document.getElementById('app');
const APP_VERSION = 'v0.6.0-dev.1';
const ENV = (self.LIFTLOG_ENV && self.LIFTLOG_ENV.ENV) || 'live';
const SET_TYPES = ['Warmup', 'Drop Set', 'Superset', 'Myo-rep Match', 'Force Reps'];

// Which optional fields are shown. Saved on the phone; turning one off only hides it.
const DEFAULT_SETTINGS = { variant: true, setTypes: true, rom: true, rpe: true, notes: true, history: true };
const SETTING_LABELS = [
  ['variant', 'Exercise variants', 'Barbell, Dumbbell, Cable… Off: the variant step is skipped when adding exercises.'],
  ['setTypes', 'Set types', 'Warmup, Drop Set, Superset, Myo-rep Match, Force Reps'],
  ['rom', 'ROM (range of motion)', '1–5 scale on each set'],
  ['rpe', 'RPE (effort)', '1–10 scale on each set'],
  ['notes', 'Notes', 'Free-text notes on each exercise and cardio entry'],
  ['history', 'Last 3 sessions panel', 'Your recent sets for the exercise you are logging']
];
const THEMES = [
  ['chalk', 'Chalk', 'Clean light gray', '#F2F3F5', '#FFFFFF', '#2563EB', '#14B8A6'],
  ['oat-milk', 'Oat Milk', 'Creamy warm white', '#F5EFE4', '#FFFCF6', '#B5562F', '#5E8C6A'],
  ['sage', 'Sage', 'Soft green light', '#EBF0EA', '#FAFCF9', '#3F7A55', '#C4823A'],
  ['varsity', 'Varsity', 'Retro light', '#F1E2B8', '#FBF2D8', '#9E2F2A', '#1F5C73'],
  ['iron', 'Iron', 'Graphite dark', '#141618', '#1E2124', '#F2A541', '#5BC0BE'],
  ['blackout', 'Blackout', 'True black (OLED)', '#000000', '#111111', '#C6F432', '#38BDF8'],
  ['ember', 'Ember', 'Warm dark', '#1A1411', '#251C18', '#FF7A45', '#E9C46A'],
  ['deep-end', 'Deep End', 'Navy dark', '#0E1A28', '#16263A', '#4FC3F7', '#F78FB3'],
  ['afterhours', 'Afterhours', 'Synthwave dark', '#160F29', '#221A3D', '#FF4FA3', '#3DDBD9']
];
let SETTINGS = { ...DEFAULT_SETTINGS };
let META = { lastBackup: null, progressKey: null, chartMode: 'heaviest', theme: 'chalk', weekStart: 'mon', showStreak: true, calView: 'month', libTab: 'exercises' };
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
const parsePos = (v) => { const n = parseWeight(v); return n === null || n < 0 ? null : n; };
const shortDate = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const longDate = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const localTimeValue = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const localDateValue = (iso) => dayKey(new Date(iso));
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const activeVariants = (ex) => (ex ? ex.variants.filter((v) => !v.hidden) : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clone = (v) => JSON.parse(JSON.stringify(v));
const isLift = (e) => e.kind !== 'cardio';
const liftEntries = (w) => w.entries.filter(isLift);
const withBack = (hash, back) => `${hash}?back=${encodeURIComponent(back)}`;

function exLabel(entry) {
  const ex = S.ex.get(entry.exerciseId);
  const v = ex && entry.variantId ? ex.variants.find((x) => x.id === entry.variantId) : null;
  return { name: ex ? ex.name : '(deleted exercise)', variant: v && SETTINGS.variant ? v.name : '' };
}
const actName = (entry) => { const a = S.act.get(entry.activityId); return a ? a.name : '(deleted activity)'; };
const entryName = (e) => (isLift(e) ? exLabel(e).name : actName(e));
const isWarmup = (set) => set.types.includes('Warmup');
const isBlank = (set) => set.weight === null && set.reps === null;
function sortedWorkouts() { return [...S.wo.values()].sort((a, b) => b.date.localeCompare(a.date)); }
function inProgress() { return sortedWorkouts().find((w) => !w.endedAt); }

const touch = (o) => { o.updatedAt = nowIso(); return o; };
const saveWorkout = (w) => db.put('workouts', touch(w));
const saveExercise = (ex) => db.put('exercises', touch(ex));
const saveActivity = (a) => db.put('activities', touch(a));

// ============================================================
// Theme
// ============================================================
function applyTheme(id) {
  const t = THEMES.find((x) => x[0] === id) || THEMES[0];
  document.documentElement.dataset.theme = t[0];
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t[3]);
  try { localStorage.setItem('liftlog-theme-' + ENV, t[0]); } catch (e) { /* optional */ }
}

// ============================================================
// Sheets (popups from the bottom of the screen)
// ============================================================
let sheetClose = null;
function openSheet(html, onClick, onInput, onDismiss) {
  closeSheet();
  const back = document.createElement('div');
  back.className = 'backdrop';
  back.innerHTML = `<div class="sheet" role="dialog">${html}</div>`;
  document.body.appendChild(back);
  back.addEventListener('click', (e) => {
    if (e.target === back) { closeSheet(); if (onDismiss) onDismiss(); return; }
    const nav = e.target.closest('[data-nav]');
    if (nav) { closeSheet(); go(nav.dataset.nav); return; }
    if (onClick) onClick(e, back.firstElementChild);
  });
  if (onInput) back.addEventListener('input', (e) => onInput(e, back.firstElementChild));
  sheetClose = () => back.remove();
  return back.firstElementChild;
}
function closeSheet() { if (sheetClose) { sheetClose(); sheetClose = null; } }

function choiceSheet(title, body, buttons) {
  // buttons: [{ label, value, kind: 'primary'|'danger'|'' }] — resolves the tapped value, or null if dismissed
  return new Promise((resolve) => {
    openSheet(`<h3>${esc(title)}</h3>${body ? `<p class="muted sheet-body">${body}</p>` : ''}
      <div class="stack">${buttons.map((b, i) => `<button class="${b.kind || ''} block" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`,
    (e) => { const b = e.target.closest('[data-i]'); if (!b) return; closeSheet(); resolve(buttons[+b.dataset.i].value); }, null, () => resolve(null));
  });
}
function confirmSheet(message, okLabel = 'Delete') {
  return choiceSheet(message, '', [{ label: okLabel, value: true, kind: 'primary' }, { label: 'Cancel', value: false }]).then((v) => !!v);
}

function showScale(kind) {
  const rows = (kind === 'rom' ? ROM_SCALE : RPE_SCALE).map(([n, l, d]) => `<tr><td>${n}</td><td><b>${esc(l)}</b><br><span class="muted">${esc(d)}</span></td></tr>`).join('');
  const title = kind === 'rom' ? 'ROM — Range of Motion (1–5)' : 'RPE — Rate of Perceived Exertion';
  openSheet(`<h3>${title}</h3><table>${rows}</table><div class="actions"><button data-a="close">Close</button></div>`,
    (e) => { if (e.target.closest('[data-a]')) closeSheet(); });
}

// ============================================================
// Duplicate check (adding or renaming exercises, variants and activities)
// ============================================================
const KIND_WORD = { exercise: 'exercise', variant: 'variant', activity: 'activity' };
// Returns { action: 'use', item } | { action: 'create' } | { action: 'cancel' }
async function vetName(kind, name, { scope = null, selfId = null, mode = 'add' } = {}) {
  const pool = kind === 'exercise' ? [...S.ex.values()] : kind === 'variant' ? scope.variants : [...S.act.values()];
  const { exact, close } = findNameMatches(pool, name, selfId);
  const q = (s) => `“${s}”`;
  if (exact) {
    if (mode === 'rename') {
      await choiceSheet(`You already have ${q(exact.name)}`, `Pick a different name. If they're the same ${KIND_WORD[kind]}, use <b>Merge</b> to combine their history.`, [{ label: 'OK', value: true, kind: 'primary' }]);
      return { action: 'cancel' };
    }
    const v = await choiceSheet(exact.hidden ? `${q(exact.name)} is hidden` : `You already have ${q(exact.name)}`,
      exact.hidden ? 'It was hidden from your lists. Unhide it instead of making a duplicate?' : 'Use it instead of making a duplicate, so your history stays in one place.',
      [{ label: exact.hidden ? `Unhide and use ${q(exact.name)}` : `Use ${q(exact.name)}`, value: 'use', kind: 'primary' }, { label: 'Cancel', value: null }]);
    return v === 'use' ? { action: 'use', item: exact } : { action: 'cancel' };
  }
  if (close.length) {
    if (mode === 'rename') {
      const v = await choiceSheet(`${q(name)} looks like ${q(close[0].name)}`, `Keep the new name anyway? If they're the same ${KIND_WORD[kind]}, use Merge instead.`,
        [{ label: `Keep ${q(name)}`, value: 'create', kind: 'primary' }, { label: 'Undo rename', value: null }]);
      return v === 'create' ? { action: 'create' } : { action: 'cancel' };
    }
    const v = await choiceSheet('Did you mean…?', `You already have something similar to ${esc(q(name))}.`,
      [...close.map((c) => ({ label: `Use ${q(c.name)}${c.hidden ? ' (hidden)' : ''}`, value: c.id, kind: '' })),
        { label: `Create ${q(name)} anyway`, value: 'create', kind: 'primary' }, { label: 'Cancel', value: null }]);
    if (v === 'create') return { action: 'create' };
    if (v) return { action: 'use', item: close.find((c) => c.id === v) };
    return { action: 'cancel' };
  }
  return { action: 'create' };
}

// ============================================================
// Router  (#/view/id?back=<hash to return to>)
// ============================================================
let BACK = null;
function route() {
  closeSheet();
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  BACK = new URLSearchParams(query || '').get('back');
  const [view, id] = (path || '').split('/');
  if (view === 'workouts') return renderWorkouts();
  if (view === 'workout' && S.wo.has(id)) return renderWorkout(id);
  if (view === 'library') return renderLibrary();
  if (view === 'exercise' && S.ex.has(id)) return renderExerciseEdit(id);
  if (view === 'activity' && S.act.has(id)) return renderActivityEdit(id);
  if (view === 'progress') return renderProgress();
  if (view === 'settings') return renderSettings();
  return renderHome();
}
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
const onView = (prefix) => location.hash.startsWith(prefix);
window.addEventListener('hashchange', route);
let rzT; window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { if (onView('#/progress')) renderProgress(); }, 150); });

function backTo(defHash, defLabel) {
  if (!BACK) return [defHash, defLabel];
  const h = BACK;
  const label = h === '#/' || h === '' ? 'Home' : h.startsWith('#/progress') ? 'Progress' : h.startsWith('#/workouts') ? 'Workouts'
    : h.startsWith('#/workout/') ? 'Workout' : h.startsWith('#/library') ? 'Library' : 'Back';
  return [h || '#/', label];
}
function topbar(title, backHash, backLabel = 'Back', right = '') {
  return `<header class="topbar"><div class="side">${backHash ? `<button class="ghost" data-nav="${esc(backHash)}">‹ ${esc(backLabel)}</button>` : ''}</div>
    <h1>${esc(title)}</h1><div class="side right">${right}</div></header>`;
}

// ============================================================
// Home
// ============================================================
let calOffset = 0;
function workoutsByDay() {
  const m = new Map();
  for (const w of [...S.wo.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const k = localDateValue(w.date);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(w);
  }
  return m;
}
const dotClass = (w) => (w.type === 'cardio' ? 'd2' : 'd1');
function dots(list) {
  if (!list || !list.length) return '<span class="dots"></span>';
  const shown = list.slice(0, 3).map((w) => `<i class="dot ${dotClass(w)}"></i>`).join('');
  return `<span class="dots">${shown}${list.length > 3 ? '<b class="more-dots">+</b>' : ''}</span>`;
}
function weekLetters() {
  const base = META.weekStart === 'sun' ? ['S', 'M', 'T', 'W', 'T', 'F', 'S'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  return base.map((l) => `<span class="cal-dow">${l}</span>`).join('');
}
function dayCell(d, byDay, today, extraClass = '') {
  const k = dayKey(d);
  const isToday = k === dayKey(today);
  const future = d > today && !isToday;
  return `<button class="cal-day${isToday ? ' today' : ''}${future ? ' future' : ''}${extraClass}" data-day="${k}"${future ? ' disabled' : ''} aria-label="${esc(d.toDateString())}">
    <span class="cal-num">${d.getDate()}</span>${dots(byDay.get(k))}</button>`;
}
function renderCalendar() {
  const today = new Date();
  const byDay = workoutsByDay();
  const view = ['week', 'month', 'year'].includes(META.calView) ? META.calView : 'month';
  let label = '', body = '';
  if (view === 'week') {
    const start = addDays(startOfWeek(today, META.weekStart), calOffset * 7);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const yr = end.getFullYear() !== today.getFullYear() ? `, ${end.getFullYear()}` : '';
    label = `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}${yr}`;
    body = `<div class="cal-grid">${weekLetters()}${[0, 1, 2, 3, 4, 5, 6].map((i) => dayCell(addDays(start, i), byDay, today)).join('')}</div>`;
  } else if (view === 'month') {
    const first = new Date(today.getFullYear(), today.getMonth() + calOffset, 1);
    label = first.toLocaleDateString([], { month: 'long', ...(first.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
    const lead = Math.round((first - startOfWeek(first, META.weekStart)) / 86400000);
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span></span>';
    for (let d = 1; d <= days; d++) cells += dayCell(new Date(first.getFullYear(), first.getMonth(), d), byDay, today);
    body = `<div class="cal-grid">${weekLetters()}${cells}</div>`;
  } else {
    const year = today.getFullYear() + calOffset;
    label = String(year);
    const jan1 = new Date(year, 0, 1), dec31 = new Date(year, 11, 31);
    let col = startOfWeek(jan1, META.weekStart);
    let cols = '', months = '', lastMonth = -1, ci = 0;
    while (col <= dec31) {
      let tiles = '';
      for (let i = 0; i < 7; i++) {
        const d = addDays(col, i);
        if (d.getFullYear() !== year) { tiles += '<span class="yt out"></span>'; continue; }
        const list = byDay.get(dayKey(d));
        const cls = list ? (list.some((w) => w.type !== 'cardio') ? ' f1' : ' f2') : '';
        const isToday = dayKey(d) === dayKey(today);
        const future = d > today && !isToday;
        tiles += future ? '<span class="yt future"></span>' : `<button class="yt${cls}${isToday ? ' today' : ''}" data-day="${dayKey(d)}" aria-label="${esc(d.toDateString())}"></button>`;
      }
      const m = addDays(col, 6).getFullYear() === year ? addDays(col, 6).getMonth() : 11;
      if (m !== lastMonth && (ci === 0 || addDays(col, 6).getDate() <= 7)) { months += `<span class="ym" style="grid-column:${ci + 1}">${esc(new Date(year, m, 1).toLocaleDateString([], { month: 'short' }))}</span>`; lastMonth = m; }
      cols += `<div class="ycol">${tiles}</div>`;
      col = addDays(col, 7); ci++;
    }
    body = `<div class="year-scroll" id="year-scroll"><div class="ymonths" style="grid-template-columns:repeat(${ci}, 13px)">${months}</div><div class="ygrid">${cols}</div></div>
      <div class="ylegend"><span><i class="yt f1"></i>Weights</span><span><i class="yt f2"></i>Cardio only</span></div>`;
  }
  return `<section class="card cal">
    <div class="cal-head"><button class="ghost cal-arrow" data-act="cal-prev" aria-label="Previous">‹</button>
      <div class="cal-label">${esc(label)}</div>
      <button class="ghost cal-arrow" data-act="cal-next" aria-label="Next"${calOffset >= 0 ? ' disabled' : ''}>›</button></div>
    <div class="seg seg3 cal-seg" role="group" aria-label="Calendar view">
      ${['week', 'month', 'year'].map((v) => `<button data-act="cal-view" data-view="${v}" class="${view === v ? 'on' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}
    </div>${body}</section>`;
}
function streakBadge() {
  if (!META.showStreak) return '';
  const dates = [...S.wo.values()].filter((w) => w.entries.length).map((w) => w.date);
  const { weeks, thisWeekDone } = weeklyStreak(dates, META.weekStart);
  const sub = weeks === 0 ? 'Log one workout this week to start one' : thisWeekDone ? 'This week is done ✓' : 'Log a workout this week to keep it going';
  return `<button class="streak" data-act="streak"><span class="streak-n">${weeks}</span><span class="grow"><b>week streak</b><small>${esc(sub)}</small></span><span class="chev">›</span></button>`;
}
function renderHome() {
  const cur = inProgress();
  const scrollYear = META.calView === 'year';
  app.innerHTML = `
    <div class="home-head"><h1>Lift Log</h1><span>${esc(new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))}</span></div>
    ${needsBackup() ? `<button class="backup-nudge" data-nav="#/settings">${esc(backupText())} · <u>Back up now</u></button>` : ''}
    <main class="home">
      ${renderCalendar()}
      ${streakBadge()}
      ${cur ? `<button class="banner" data-nav="${esc(withBack('#/workout/' + cur.id, '#/'))}">Continue workout<small>${esc(cur.name || (cur.type === 'cardio' ? 'Cardio' : 'Workout'))} · ${plural(cur.entries.length, cur.type === 'cardio' ? 'entry' : 'exercise').replace('entrys', 'entries')}</small></button>` : ''}
      <button class="primary block start-btn" data-act="start-workout">Start workout</button>
      <nav class="nav-row">
        <button class="nav-tile" data-nav="#/progress"><span class="glyph" aria-hidden="true">📈</span>Progress</button>
        <button class="nav-tile" data-nav="#/workouts"><span class="glyph" aria-hidden="true">🗓️</span>Workouts</button>
        <button class="nav-tile" data-nav="#/library"><span class="glyph" aria-hidden="true">📚</span>Library</button>
        <button class="nav-tile" data-nav="#/settings"><span class="glyph" aria-hidden="true">⚙️</span>Settings</button>
      </nav>
    </main>`;
  if (scrollYear) {
    // open on the newest week: today's column for this year, December for past years
    const ys = document.getElementById('year-scroll');
    const t = ys && ys.querySelector('.yt.today');
    if (ys) ys.scrollLeft = t ? Math.max(0, t.parentElement.offsetLeft - ys.clientWidth + 48) : ys.scrollWidth;
  }
}
function openDaySheet(key) {
  const list = (workoutsByDay().get(key) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const title = date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  const row = (w) => `<button class="list-item" data-nav="${esc(withBack('#/workout/' + w.id, '#/'))}"><i class="dot ${dotClass(w)}"></i><div class="grow"><div class="title">${esc(w.name || (w.type === 'cardio' ? 'Cardio' : 'Workout'))}${w.endedAt ? '' : ' <span class="pill">In progress</span>'}</div>
    <div class="sub">${esc(timeOf(w.date))}${w.entries.length ? ' · ' + esc(w.entries.map(entryName).join(', ')) : ''}</div></div><span class="chev">›</span></button>`;
  openSheet(`<h3>${esc(title)}</h3>${list.length ? list.map(row).join('') : '<p class="muted">No workouts this day.</p>'}
    <div class="actions"><button data-a="log">+ Log a workout on this day</button></div>`,
  (e) => { if (e.target.closest('[data-a="log"]')) openStartSheet(date); });
}
function openStartSheet(onDate) {
  const cur = inProgress();
  if (cur) {
    return choiceSheet('You have a workout in progress', 'Finish it before starting another, so nothing gets mixed up.',
      [{ label: 'Continue it', value: 'go', kind: 'primary' }, { label: 'Cancel', value: null }]).then((v) => { if (v) go(withBack('#/workout/' + cur.id, '#/')); });
  }
  const when = onDate ? onDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '';
  return choiceSheet(onDate ? `New workout · ${when}` : 'New workout', 'What kind of workout?',
    [{ label: '🏋️  Weights', value: 'weights', kind: 'primary' }, { label: '🏃  Cardio', value: 'cardio', kind: 'primary alt' }, { label: 'Cancel', value: null }])
    .then((type) => { if (type) startWorkout(type, onDate); });
}

// ============================================================
// Workouts list
// ============================================================
function renderWorkouts() {
  const cur = inProgress();
  const past = sortedWorkouts().filter((w) => w.endedAt);
  const item = (w) => `<button class="list-item" data-nav="#/workout/${esc(w.id)}"><i class="dot ${dotClass(w)}"></i><div class="grow"><div class="title">${esc(w.name || (w.type === 'cardio' ? 'Cardio' : 'Workout'))}</div>
      <div class="sub">${esc(longDate(w.date))} · ${esc(timeOf(w.date))}${w.entries.length ? ' · ' + esc(w.entries.map(entryName).join(', ')) : ''}</div></div><span class="chev">›</span></button>`;
  app.innerHTML = topbar('Workouts', '#/', 'Home') + `<main>
    ${cur ? `<button class="banner" style="margin:0 0 12px;width:100%" data-nav="#/workout/${esc(cur.id)}">Continue workout<small>${esc(cur.name || 'Workout')} · started ${esc(longDate(cur.date))} at ${esc(timeOf(cur.date))}</small></button>`
          : `<button class="primary block" data-act="start-workout" style="padding:14px;margin-bottom:12px">Start workout</button>`}
    <div class="section-label">History</div>
    ${past.length ? past.map(item).join('') : '<div class="empty">No finished workouts yet.</div>'}
  </main>`;
}

async function startWorkout(type, onDate) {
  let date = new Date();
  if (onDate && dayKey(onDate) !== dayKey(date)) { const d = new Date(onDate); d.setHours(date.getHours(), date.getMinutes(), 0, 0); date = d; }
  const w = normalizeWorkout({ id: db.uid(), type, name: '', date: date.toISOString(), endedAt: null, entries: [] });
  S.wo.set(w.id, w);
  await saveWorkout(w);
  go(withBack('#/workout/' + w.id, '#/'));
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
  const [bh, bl] = backTo('#/workouts', 'Workouts');
  const cardio = w.type === 'cardio';
  app.innerHTML = topbar(w.endedAt ? (cardio ? 'Cardio' : 'Workout') : 'In progress', bh, bl) + `<main>
    <div class="wo-head">
      <input class="wo-name" data-wfield="name" value="${esc(w.name)}" placeholder="${cardio ? 'Name (optional)' : 'Workout name (optional)'}" autocomplete="off">
      <label class="wo-when">Date<input data-wfield="date" type="date" value="${localDateValue(w.date)}"></label>
      <label class="wo-when">Start time<input data-wfield="time" type="time" value="${localTimeValue(w.date)}"></label>
    </div>
    ${w.entries.map((e, i) => (isLift(e) ? entryCard(w, e, i) : cardioCard(w, e))).join('')}
    ${cardio ? '<button class="block" data-act="add-cardio" style="padding:14px">+ Add cardio</button>'
      : `<button class="block" data-act="add-exercise" style="padding:14px">+ Add exercise</button>
         <button class="block ghost-outline" data-act="add-cardio" style="margin-top:8px">+ Add cardio</button>`}
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
  const e = w.entries[idx];
  tmp.innerHTML = isLift(e) ? entryCard(w, e, idx) : cardioCard(w, e);
  old.replaceWith(tmp.firstElementChild);
  if (focusSel) { const el = app.querySelector(focusSel); if (el) el.focus(); }
}

function entryCard(w, e) {
  const { name, variant } = exLabel(e);
  let workNo = 0;
  const sets = e.sets.map((s) => setRow(e, s, isWarmup(s) ? 'W' : String(++workNo))).join('');
  return `<section class="card entry" data-entry="${esc(e.id)}">
    <div class="entry-head"><h2>${esc(name)}${variant ? ` <span class="variant">· ${esc(variant)}</span>` : ''}</h2>
      <button data-act="entry-menu" aria-label="Exercise options">⋯</button></div>
    ${SETTINGS.history ? historyPanel(w, e) : ''}
    ${SETTINGS.rom || SETTINGS.rpe ? `<div class="legend">${SETTINGS.rom ? '<button data-act="scale" data-kind="rom">ROM ⓘ</button>' : ''}${SETTINGS.rpe ? '<button data-act="scale" data-kind="rpe">RPE ⓘ</button>' : ''}</div>` : ''}
    ${sets || '<div class="faint small" style="padding:6px 0">No sets yet.</div>'}
    <button class="block add-set" data-act="add-set">+ Add set</button>
    ${SETTINGS.notes ? `<textarea class="note" data-field="note" rows="1" placeholder="Notes">${esc(e.note)}</textarea>` : ''}
  </section>`;
}

function cardioCard(w, e) {
  return `<section class="card entry cardio" data-entry="${esc(e.id)}">
    <div class="entry-head"><h2><i class="dot d2"></i> ${esc(actName(e))}</h2><button data-act="entry-menu" aria-label="Cardio options">⋯</button></div>
    <div class="cardio-grid">
      <label>Minutes *<input class="num" data-field="minutes" inputmode="numeric" pattern="[0-9]*" value="${fmtNum(e.minutes)}" placeholder="min" autocomplete="off"></label>
      <label>Miles<input class="num" data-field="miles" inputmode="decimal" value="${fmtNum(e.miles)}" placeholder="mi" autocomplete="off"></label>
      <label>Calories<input class="num" data-field="calories" inputmode="numeric" pattern="[0-9]*" value="${fmtNum(e.calories)}" placeholder="cal" autocomplete="off"></label>
    </div>
    <div class="faint small" style="margin-top:6px">* required</div>
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
      <div class="minis">${s.myo.minis.map((m, i) => `<span class="mini" data-mini="${i}">+<input data-field="mini-reps" inputmode="numeric" pattern="[0-9]*" value="${fmtNum(m.reps)}" placeholder="reps" autocomplete="off"><button class="rm" data-act="rm-mini" aria-label="Remove mini-set">✕</button></span>`).join('')}
        <button class="sub-add" data-act="add-mini">+ Add mini-set</button></div></div>`;
  }
  if (SETTINGS.setTypes && s.types.includes('Force Reps')) {
    sub += `<div class="sub-rows"><div class="myo-line">+ forced reps <input data-field="force-reps" inputmode="numeric" pattern="[0-9]*" value="${fmtNum(s.force ? s.force.reps : null)}" placeholder="reps" autocomplete="off">
      <span class="faint small">same weight, with a spotter</span></div></div>`;
  }
  return `<div class="set" data-set="${esc(s.id)}">
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
  const minis = s.myo.minis.map((m) => m.reps ?? 0);
  const total = base + minis.reduce((a, b) => a + b, 0);
  const expr = [base, ...minis].join(' + ');
  return `${expr} = ${total}${s.myo.target ? ' / ' + s.myo.target : ''}`;
}
function updateMyoTotal(setEl, s) {
  const el = setEl.querySelector('[data-myo-total]');
  if (!el) return;
  el.textContent = myoSummary(s);
  const total = (s.reps ?? 0) + s.myo.minis.reduce((a, b) => a + (b.reps ?? 0), 0);
  el.classList.toggle('hit', !!s.myo.target && total >= s.myo.target);
}

// "Last 3 sessions" for this exercise + variant (working sets only, plus notes)
function formatSet(s) {
  const wr = (w, r) => `${w === null ? '–' : fmtNum(w) + ' lb'} × ${r === null ? '–' : fmtNum(r)}`;
  let t = wr(s.weight, s.reps);
  if (SETTINGS.setTypes && s.types.includes('Drop Set')) s.drops.forEach((d) => { if (d.weight !== null || d.reps !== null) t += ` → ${wr(d.weight, d.reps)}`; });
  if (SETTINGS.setTypes && s.types.includes('Myo-rep Match')) { const m = s.myo.minis.map((x) => x.reps).filter((x) => x !== null); if (m.length) t += ' +' + m.join('+'); }
  if (SETTINGS.setTypes && s.types.includes('Force Reps') && s.force && s.force.reps) t += ` +${s.force.reps}F`;
  if (SETTINGS.rpe && s.rpe) t += ` @${s.rpe}`;
  return t;
}
function historyFor(exerciseId, variantId, excludeId, beforeIso, limit = 3) {
  const out = [];
  for (const w of sortedWorkouts()) {
    if (w.id === excludeId || (beforeIso && w.date > beforeIso)) continue;
    const entries = liftEntries(w).filter((e) => e.exerciseId === exerciseId && (e.variantId || null) === (variantId || null));
    if (!entries.length) continue;
    const sets = entries.flatMap((e) => e.sets).filter((s) => !isWarmup(s) && !isBlank(s));
    const notes = SETTINGS.notes ? entries.map((e) => e.note).filter(Boolean) : [];
    if (!sets.length && !notes.length) continue;
    out.push({ id: w.id, date: w.date, sets, notes });
    if (out.length >= limit) break;
  }
  return out;
}
function historyPanel(w, e) {
  const h = historyFor(e.exerciseId, e.variantId, w.id, w.date);
  if (!h.length) return `<div class="history faint">No previous sessions yet.</div>`;
  const back = '#/workout/' + w.id;
  return `<div class="history">${h.map((x) => `<button class="h-row" data-nav="${esc(withBack('#/workout/' + x.id, back))}"><span class="h-date">${esc(shortDate(x.date))}</span> ${esc(x.sets.map(formatSet).join(', ') || '—')}
    ${x.notes.map((n) => `<span class="h-note">“${esc(n)}”</span>`).join('')}</button>`).join('')}</div>`;
}

// ---------- finding what was tapped ----------
function ctx(el) {
  const w = curWorkout();
  const entryEl = el.closest('[data-entry]');
  const entry = entryEl ? w.entries.find((x) => x.id === entryEl.dataset.entry) : null;
  const setEl = el.closest('[data-set]');
  const set = entry && entry.sets && setEl ? entry.sets.find((x) => x.id === setEl.dataset.set) : null;
  const dropEl = el.closest('[data-drop]');
  const miniEl = el.closest('[data-mini]');
  return { w, entry, set, setEl, drop: dropEl ? +dropEl.dataset.drop : null, mini: miniEl ? +miniEl.dataset.mini : null };
}

function newSet() { return { id: db.uid(), weight: null, reps: null, types: [], rom: null, rpe: null, drops: [], myo: { target: null, minis: [] }, force: null }; }

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
  else if (f === 'note' && c.entry) { c.entry.note = v; }
  else if (c.entry && !isLift(c.entry)) {
    if (f === 'minutes') c.entry.minutes = parsePos(v) === null ? null : Math.round(parsePos(v));
    else if (f === 'miles') c.entry.miles = parsePos(v);
    else if (f === 'calories') c.entry.calories = parsePos(v) === null ? null : Math.round(parsePos(v));
    else return;
    el.classList.remove('missing');
  }
  else if (c.set) {
    const s = c.set;
    if (f === 'weight') s.weight = parseWeight(v);
    else if (f === 'reps') s.reps = parseInt10(v);
    else if (f === 'rom') s.rom = parseInt10(v);
    else if (f === 'rpe') s.rpe = parseInt10(v);
    else if (f === 'drop-weight') s.drops[c.drop].weight = parseWeight(v);
    else if (f === 'drop-reps') s.drops[c.drop].reps = parseInt10(v);
    else if (f === 'myo-target') s.myo.target = parseInt10(v);
    else if (f === 'mini-reps') s.myo.minis[c.mini].reps = parseInt10(v);
    else if (f === 'force-reps') { s.force = s.force || { id: db.uid(), reps: null }; s.force.reps = parseInt10(v); }
    if (s.types.includes('Myo-rep Match')) updateMyoTotal(c.setEl, s);
  } else return;
  saveWorkout(c.w);
}

async function onWorkoutAction(act, el) {
  const c = ctx(el);
  const w = c.w;
  switch (act) {
    case 'add-exercise': return openPicker('exercise');
    case 'add-cardio': return openPicker('activity');
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
    case 'add-drop': c.set.drops.push({ id: db.uid(), weight: null, reps: null }); await saveWorkout(w);
      return rerenderEntry(c.entry.id, `[data-set="${c.set.id}"] [data-drop="${c.set.drops.length - 1}"] [data-field="drop-weight"]`);
    case 'rm-drop': c.set.drops.splice(c.drop, 1); await saveWorkout(w); return rerenderEntry(c.entry.id);
    case 'add-mini': c.set.myo.minis.push({ id: db.uid(), reps: null }); await saveWorkout(w);
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
  openSheet(html(), (e, sh) => {
    const b = e.target.closest('[data-t]');
    if (b) {
      const t = b.dataset.t;
      if (set.types.includes(t)) set.types = set.types.filter((x) => x !== t);
      else {
        set.types = SET_TYPES.filter((x) => x === t || set.types.includes(x));
        if (t === 'Drop Set' && !set.drops.length) set.drops.push({ id: db.uid(), weight: null, reps: null });
        if (t === 'Myo-rep Match') {
          if (set.myo.target === null) set.myo.target = autoMyoTarget(entry, set);
          if (!set.myo.minis.length) set.myo.minis.push({ id: db.uid(), reps: null });
        }
        if (t === 'Force Reps' && !set.force) set.force = { id: db.uid(), reps: null };
      }
      saveWorkout(curWorkout());
      sh.innerHTML = html();
      return;
    }
    if (e.target.closest('[data-a="done"]')) { closeSheet(); rerenderEntry(entry.id); }
  }, null, () => rerenderEntry(entry.id));
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
  openSheet(`<h3>${esc(entryName(entry))}</h3>
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
        const hasData = isLift(entry) ? entry.sets.some((s) => !isBlank(s)) || entry.note : entry.minutes !== null || entry.miles !== null || entry.calories !== null || entry.note;
        if (hasData && !(await confirmSheet(`Remove ${isLift(entry) ? 'this exercise and its sets' : 'this cardio entry'} from the workout?`, 'Remove'))) return;
        w.entries = w.entries.filter((x) => x !== entry);
        await saveWorkout(w); renderWorkout(w.id);
      }
    });
}

// Clears data left behind by set types that were switched off, so exports match what's shown.
function tidySet(s) {
  if (!s.types.includes('Drop Set')) s.drops = [];
  s.drops = s.drops.filter((d) => d.weight !== null || d.reps !== null);
  if (!s.types.includes('Myo-rep Match')) s.myo = { target: null, minis: [] };
  s.myo.minis = s.myo.minis.filter((m) => m.reps !== null);
  if (!s.types.includes('Force Reps') || !s.force || s.force.reps === null) s.force = null;
}
async function finishWorkout(w) {
  const blankCardio = (e) => e.minutes === null && e.miles === null && e.calories === null && !e.note;
  const missing = w.entries.find((e) => !isLift(e) && !blankCardio(e) && e.minutes === null);
  if (missing) {
    await choiceSheet(`Add minutes for ${actName(missing)}`, 'Minutes are required for cardio. Fill them in, or remove the entry.', [{ label: 'OK', value: true, kind: 'primary' }]);
    const el = app.querySelector(`[data-entry="${missing.id}"] [data-field="minutes"]`);
    if (el) { el.classList.add('missing'); el.focus(); el.scrollIntoView({ block: 'center' }); }
    return;
  }
  // tidy up: drop completely empty sets and empty entries
  w.entries.forEach((e) => {
    if (!isLift(e)) return;
    e.sets = e.sets.filter((s) => !isBlank(s));
    e.sets.forEach(tidySet);
  });
  w.entries = w.entries.filter((e) => (isLift(e) ? e.sets.length || e.note : !blankCardio(e)));
  w.endedAt = nowIso();
  await saveWorkout(w);
  go('#/workouts');
}

// ============================================================
// Picker: adding an exercise or a cardio activity to a workout
// ============================================================
function pickerHtml(kind) {
  return `<h3>${kind === 'activity' ? 'Add cardio' : 'Add exercise'}</h3>
    <input id="pick-q" placeholder="${kind === 'activity' ? 'Search or type a new activity (e.g. Run)' : 'Search or type a new exercise'}" autocomplete="off" autocapitalize="words">
    <div class="pick-list" id="pick-list"></div>`;
}
function openPicker(kind) {
  const sheet = openSheet(pickerHtml(kind), onPickClick, (e, sh) => { if (e.target.id === 'pick-q') drawPickList(sh); });
  sheet.dataset.picker = kind;
  drawPickList(sheet);
  sheet.querySelector('#pick-q').focus();
  return sheet;
}
const pickerPool = (kind) => (kind === 'activity' ? [...S.act.values()] : [...S.ex.values()]);

function drawPickList(sheet) {
  const kind = sheet.dataset.picker;
  const q = sheet.querySelector('#pick-q').value.trim();
  const ql = q.toLowerCase();
  const pool = pickerPool(kind);
  const all = pool.filter((x) => !x.hidden);
  const match = all.filter((x) => !ql || x.name.toLowerCase().includes(ql) || (q && nameKey(x.name).includes(nameKey(q))));
  const btn = (x) => `<button data-pick="${esc(x.id)}">${esc(x.name)}</button>`;
  let html = '';
  const exact = q ? pool.find((x) => nameKey(x.name) === nameKey(q)) : null;
  if (exact && exact.hidden) html += `<button data-pick="${esc(exact.id)}" class="hidden-pick">Unhide “${esc(exact.name)}” and add it</button>`;
  else if (q && !exact) html += `<button class="primary" data-create="1">+ Add “${esc(q)}” to library</button>`;
  if (!all.length) html += `<div class="faint small" style="padding:8px 2px">${kind === 'activity' ? 'No cardio activities yet. Type one above (Walk, Run, Bike…).' : 'Your library is empty. Type a name above to add your first exercise.'}</div>`;
  else html += match.sort(byName).map(btn).join('');
  sheet.querySelector('#pick-list').innerHTML = html;
}

async function useItem(kind, item) {
  if (item.hidden) { item.hidden = false; if (kind === 'activity') await saveActivity(item); else await saveExercise(item); }
}
async function onPickClick(e, sheet) {
  const kind = sheet.dataset.picker || 'exercise';
  const pick = e.target.closest('[data-pick]');
  const create = e.target.closest('[data-create]');
  const vpick = e.target.closest('[data-vpick]');
  if (create) {
    const name = sheet.querySelector('#pick-q').value.trim();
    if (!name) return;
    const r = await vetName(kind, name);
    if (r.action === 'cancel') { openPicker(kind); return; }
    if (r.action === 'use') { await useItem(kind, r.item); return pickItem(kind, r.item); }
    if (kind === 'activity') {
      const a = { id: db.uid(), name, hidden: false, createdAt: nowIso(), updatedAt: nowIso() };
      S.act.set(a.id, a); await saveActivity(a);
      return addCardioEntry(a);
    }
    const ex = { id: db.uid(), name, variants: [], hidden: false, createdAt: nowIso(), updatedAt: nowIso(), lastUsed: null };
    S.ex.set(ex.id, ex); await saveExercise(ex);
    if (!SETTINGS.variant) return addEntry(ex, null);
    return drawVariantStep(currentPicker(kind), ex, true);
  }
  if (pick) {
    const item = (kind === 'activity' ? S.act : S.ex).get(pick.dataset.pick);
    await useItem(kind, item);
    return pickItem(kind, item);
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
    const r = await vetName('variant', name, { scope: ex });
    if (r.action === 'cancel') return drawVariantStep(currentPicker('exercise'), ex, false);
    let v = r.action === 'use' ? r.item : null;
    if (!v) { v = { id: db.uid(), name, hidden: false, createdAt: nowIso(), updatedAt: nowIso() }; ex.variants.push(v); }
    v.hidden = false;
    await saveExercise(ex);
    return addEntry(ex, v.id);
  }
  if (e.target.closest('[data-back]')) {
    sheet.innerHTML = pickerHtml(kind);
    drawPickList(sheet);
  }
}
function currentPicker(kind) {
  const open = document.querySelector('.sheet[data-picker]');
  return open || openPicker(kind);
}
function pickItem(kind, item) {
  if (kind === 'activity') return addCardioEntry(item);
  const vs = activeVariants(item);
  if (!SETTINGS.variant) return addEntry(item, null);
  if (vs.length <= 1) return addEntry(item, vs[0] ? vs[0].id : null);
  return drawVariantStep(currentPicker('exercise'), item, false);
}

function drawVariantStep(sheet, ex, isNew) {
  sheet.dataset.ex = ex.id;
  const vs = activeVariants(ex);
  sheet.innerHTML = `<h3>${esc(ex.name)}</h3>
    <p class="muted small" style="margin:-6px 0 12px">${isNew ? 'Added to your library. Pick a variant, add one, or skip.' : 'Which variant?'}</p>
    <div class="variant-grid">${vs.map((v) => `<button data-vpick="${esc(v.id)}">${esc(v.name)}</button>`).join('')}</div>
    <div class="row" style="margin-top:10px"><input id="newvar" class="grow" placeholder="New variant (e.g. Dumbbell)" autocomplete="off" autocapitalize="words"><button data-newvar="1">Add</button></div>
    <div class="actions">${isNew ? '<button data-vpick="">No variant</button>' : '<button data-back="1">‹ Back</button>'}</div>`;
}

async function addEntry(ex, variantId) {
  const w = curWorkout();
  const entry = { id: db.uid(), kind: 'lift', exerciseId: ex.id, variantId: variantId || null, note: '', sets: [newSet()] };
  w.entries.push(entry);
  ex.lastUsed = nowIso();
  await Promise.all([saveWorkout(w), saveExercise(ex)]);
  closeSheet();
  renderWorkout(w.id, `[data-entry="${entry.id}"] [data-field="weight"]`);
}
async function addCardioEntry(a) {
  const w = curWorkout();
  const entry = { id: db.uid(), kind: 'cardio', activityId: a.id, minutes: null, miles: null, calories: null, note: '' };
  w.entries.push(entry);
  await saveWorkout(w);
  closeSheet();
  renderWorkout(w.id, `[data-entry="${entry.id}"] [data-field="minutes"]`);
}

// ============================================================
// Library: exercises and cardio activities
// ============================================================
function usage(exId, varId) {
  let n = 0;
  for (const w of S.wo.values()) for (const e of liftEntries(w)) if (e.exerciseId === exId && (varId === undefined || e.variantId === varId)) n++;
  return n;
}
function actUsage(actId) {
  let n = 0;
  for (const w of S.wo.values()) for (const e of w.entries) if (!isLift(e) && e.activityId === actId) n++;
  return n;
}

function renderLibrary() {
  const tab = META.libTab === 'activities' ? 'activities' : 'exercises';
  const isAct = tab === 'activities';
  const all = (isAct ? [...S.act.values()] : [...S.ex.values()]).sort(byName);
  const active = all.filter((x) => !x.hidden);
  const hidden = all.filter((x) => x.hidden);
  const item = (x) => {
    if (isAct) return `<button class="list-item" data-nav="#/activity/${esc(x.id)}"><div class="grow"><div class="title">${esc(x.name)}</div><div class="sub">${plural(actUsage(x.id), 'entry').replace('entrys', 'entries')}</div></div><span class="chev">›</span></button>`;
    const vs = activeVariants(x);
    return `<button class="list-item" data-nav="#/exercise/${esc(x.id)}"><div class="grow"><div class="title">${esc(x.name)}</div>
      ${SETTINGS.variant ? `<div class="sub">${vs.length ? esc(vs.map((v) => v.name).join(' · ')) : 'No variants'}</div>` : ''}</div><span class="chev">›</span></button>`;
  };
  app.innerHTML = topbar('Library', '#/', 'Home') + `<main>
    <div class="seg" role="group" aria-label="Library section">
      <button data-act="lib-tab" data-tab="exercises" class="${!isAct ? 'on' : ''}">Exercises</button>
      <button data-act="lib-tab" data-tab="activities" class="${isAct ? 'on' : ''}">Cardio activities</button>
    </div>
    <div class="row" style="margin-bottom:12px"><input id="new-ex" class="grow" placeholder="${isAct ? 'New activity (e.g. Run)' : 'New exercise name'}" autocomplete="off" autocapitalize="words"><button class="primary" data-act="lib-add">Add</button></div>
    ${active.length ? active.map(item).join('') : `<div class="empty">${isAct ? 'No cardio activities yet. Add one above, or while logging cardio.' : 'Your library is empty. Add your first exercise above, or add exercises on the fly while logging a workout.'}</div>`}
    ${hidden.length ? `<div class="section-label">Hidden</div>${hidden.map(item).join('')}` : ''}
  </main>`;
}

async function libraryAdd() {
  const isAct = META.libTab === 'activities';
  const input = document.getElementById('new-ex');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const kind = isAct ? 'activity' : 'exercise';
  const r = await vetName(kind, name);
  if (r.action === 'cancel') return;
  if (r.action === 'use') { await useItem(kind, r.item); go(`#/${kind}/${r.item.id}`); return; }
  if (isAct) {
    const a = { id: db.uid(), name, hidden: false, createdAt: nowIso(), updatedAt: nowIso() };
    S.act.set(a.id, a); await saveActivity(a); go('#/activity/' + a.id); return;
  }
  const ex = { id: db.uid(), name, variants: [], hidden: false, createdAt: nowIso(), updatedAt: nowIso(), lastUsed: null };
  S.ex.set(ex.id, ex); await saveExercise(ex);
  go('#/exercise/' + ex.id);
}

const fmtWhen = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
function undoCard(targetId, level) {
  const m = lastMerge(targetId, level);
  if (!m) return '';
  return `<div class="card undo-card"><div class="small">Merged <b>${esc(m.sourceName)}</b> into this on ${esc(fmtWhen(m.at))}.</div>
    <button class="block" data-act="undo-merge" data-merge="${esc(m.id)}" style="margin-top:8px">Undo merge</button></div>`;
}

let curExId = null;
function renderExerciseEdit(id) {
  curExId = id;
  const ex = S.ex.get(id);
  const uses = usage(ex.id);
  const vrow = (v) => `<div class="var-row" data-var="${esc(v.id)}"><input data-vfield="name" value="${esc(v.name)}" autocomplete="off" autocapitalize="words">
    <button data-act="var-menu" aria-label="Variant options">⋯</button></div>`;
  const live = ex.variants.filter((v) => !v.hidden);
  const hid = ex.variants.filter((v) => v.hidden);
  const variantsCard = !SETTINGS.variant ? '' : `<div class="card"><div class="card-title">Variants</div>
      ${live.map(vrow).join('') || '<div class="faint small" style="margin-bottom:8px">No variants yet.</div>'}
      <div class="row"><input id="new-var" class="grow" placeholder="Add variant (e.g. Barbell)" autocomplete="off" autocapitalize="words"><button data-act="var-add">Add</button></div>
      ${hid.length ? `<div class="section-label">Hidden variants</div>${hid.map(vrow).join('')}` : ''}
    </div>`;
  const others = [...S.ex.values()].filter((x) => x.id !== ex.id).length;
  app.innerHTML = topbar(ex.name, '#/library', 'Library') + `<main>
    <div class="card"><label class="muted small">Exercise name</label><input data-exfield="name" value="${esc(ex.name)}" autocomplete="off" autocapitalize="words" style="margin-top:4px">
      <div class="faint small" style="margin-top:6px">Logged in ${plural(uses, 'workout')}</div></div>
    ${undoCard(ex.id, 'exercise')}${undoCard(ex.id, 'variant')}
    ${variantsCard}
    ${others ? '<button class="block" data-act="merge-start" style="margin-bottom:8px">Merge into another exercise…</button>' : ''}
    ${ex.hidden ? '<button class="block" data-act="ex-unhide">Unhide exercise</button>'
      : `<button class="ghost danger block" data-act="ex-remove">${uses ? 'Hide exercise' : 'Delete exercise'}</button>
         ${uses ? '<p class="faint small" style="text-align:center">Hiding removes it from the picker but keeps all its history.</p>' : ''}`}
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
    const r = await vetName('variant', name, { scope: ex });
    if (r.action === 'cancel') return;
    if (r.action === 'use') r.item.hidden = false;
    else ex.variants.push({ id: db.uid(), name, hidden: false, createdAt: nowIso(), updatedAt: nowIso() });
    await saveExercise(ex); renderExerciseEdit(ex.id);
    document.getElementById('new-var').focus();
  } else if (act === 'var-menu') {
    const used = usage(ex.id, v.id);
    const otherVars = ex.variants.filter((x) => x.id !== v.id);
    const choice = await choiceSheet(v.name, used ? `Used in ${plural(used, 'workout')}.` : 'Not used in any workout yet.', [
      v.hidden ? { label: 'Unhide variant', value: 'unhide', kind: 'primary' } : used ? { label: 'Hide variant', value: 'hide' } : { label: 'Delete variant', value: 'delete', kind: 'danger' },
      ...(otherVars.length ? [{ label: 'Merge into another variant…', value: 'merge' }] : []),
      { label: 'Cancel', value: null }]);
    if (choice === 'hide') v.hidden = true;
    else if (choice === 'unhide') v.hidden = false;
    else if (choice === 'delete') ex.variants = ex.variants.filter((x) => x !== v);
    else if (choice === 'merge') return openMergeTarget('variant', v, ex);
    else return;
    await saveExercise(ex); renderExerciseEdit(ex.id);
  } else if (act === 'merge-start') {
    return openMergeTarget('exercise', ex);
  } else if (act === 'undo-merge') {
    return askUndo(el.dataset.merge);
  } else if (act === 'ex-remove') {
    if (usage(ex.id)) { ex.hidden = true; await saveExercise(ex); go('#/library'); }
    else if (await confirmSheet(`Delete “${ex.name}”?`)) { S.ex.delete(ex.id); await db.remove('exercises', ex.id); go('#/library'); }
  } else if (act === 'ex-unhide') {
    ex.hidden = false; await saveExercise(ex); renderExerciseEdit(ex.id);
  }
}

// Renames are checked for duplicates when the field is left (not on every keystroke).
function onExerciseInput(el) {
  if (el.dataset.exfield === 'name') document.querySelector('.topbar h1').textContent = el.value.trim() || ' ';
}
async function onExerciseChange(el) {
  const ex = S.ex.get(curExId);
  if (!ex) return;
  if (el.dataset.exfield === 'name') {
    const name = el.value.trim();
    if (!name || name === ex.name) { el.value = ex.name; document.querySelector('.topbar h1').textContent = ex.name; return; }
    const caseOnly = nameKey(name) === nameKey(ex.name);
    const r = caseOnly ? { action: 'create' } : await vetName('exercise', name, { selfId: ex.id, mode: 'rename' });
    if (r.action !== 'create') { el.value = ex.name; const h = document.querySelector('.topbar h1'); if (h) h.textContent = ex.name; return; }
    ex.name = name; await saveExercise(ex);
  } else if (el.dataset.vfield === 'name') {
    const v = ex.variants.find((x) => x.id === el.closest('[data-var]').dataset.var);
    const name = el.value.trim();
    if (!name || name === v.name) { el.value = v.name; return; }
    const caseOnly = nameKey(name) === nameKey(v.name);
    const r = caseOnly ? { action: 'create' } : await vetName('variant', name, { scope: ex, selfId: v.id, mode: 'rename' });
    if (r.action !== 'create') { el.value = v.name; return; }
    v.name = name; touch(v); await saveExercise(ex);
  }
}

let curActId = null;
function renderActivityEdit(id) {
  curActId = id;
  const a = S.act.get(id);
  const uses = actUsage(a.id);
  const others = [...S.act.values()].filter((x) => x.id !== a.id).length;
  app.innerHTML = topbar(a.name, '#/library', 'Library') + `<main>
    <div class="card"><label class="muted small">Cardio activity name</label><input data-actfield="name" value="${esc(a.name)}" autocomplete="off" autocapitalize="words" style="margin-top:4px">
      <div class="faint small" style="margin-top:6px">Logged ${plural(uses, 'time')}</div></div>
    ${undoCard(a.id, 'activity')}
    ${others ? '<button class="block" data-act="merge-start" style="margin-bottom:8px">Merge into another activity…</button>' : ''}
    ${a.hidden ? '<button class="block" data-act="act-unhide">Unhide activity</button>'
      : `<button class="ghost danger block" data-act="act-remove">${uses ? 'Hide activity' : 'Delete activity'}</button>`}
  </main>`;
}
async function onActivityAction(act, el) {
  const a = S.act.get(curActId);
  if (act === 'merge-start') return openMergeTarget('activity', a);
  if (act === 'undo-merge') return askUndo(el.dataset.merge);
  if (act === 'act-remove') {
    if (actUsage(a.id)) { a.hidden = true; await saveActivity(a); go('#/library'); }
    else if (await confirmSheet(`Delete “${a.name}”?`)) { S.act.delete(a.id); await db.remove('activities', a.id); go('#/library'); }
  } else if (act === 'act-unhide') { a.hidden = false; await saveActivity(a); renderActivityEdit(a.id); }
}
async function onActivityChange(el) {
  const a = S.act.get(curActId);
  if (!a || el.dataset.actfield !== 'name') return;
  const name = el.value.trim();
  if (!name || name === a.name) { el.value = a.name; return; }
  const r = nameKey(name) === nameKey(a.name) ? { action: 'create' } : await vetName('activity', name, { selfId: a.id, mode: 'rename' });
  if (r.action !== 'create') { el.value = a.name; const h = document.querySelector('.topbar h1'); if (h) h.textContent = a.name; return; }
  a.name = name; await saveActivity(a);
}

// ============================================================
// Merge (and undo)
// ============================================================
const LEVEL_WORD = { exercise: 'exercise', variant: 'variant', activity: 'activity' };
function mergeCandidates(level, source, ex) {
  if (level === 'variant') return ex.variants.filter((v) => v.id !== source.id);
  if (level === 'activity') return [...S.act.values()].filter((x) => x.id !== source.id);
  return [...S.ex.values()].filter((x) => x.id !== source.id);
}
function openMergeTarget(level, source, ex) {
  const list = (q) => mergeCandidates(level, source, ex).filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase())).sort(byName)
    .map((x) => `<button data-target="${esc(x.id)}">${esc(x.name)}${x.hidden ? ' <span class="faint">(hidden)</span>' : ''}</button>`).join('') || '<p class="faint small">No matches.</p>';
  const sheet = openSheet(`<h3>Merge “${esc(source.name)}” into…</h3>
    <p class="muted small" style="margin:-6px 0 10px">Pick the ${LEVEL_WORD[level]} to keep. “${esc(source.name)}” and its history move into it.</p>
    <input id="merge-q" placeholder="Search" autocomplete="off"><div class="pick-list" id="merge-list">${list('')}</div>`,
  (e) => {
    const b = e.target.closest('[data-target]'); if (!b) return;
    const target = mergeCandidates(level, source, ex).find((x) => x.id === b.dataset.target);
    openMergeConfirm(level, source, target, ex);
  }, (e, sh) => { if (e.target.id === 'merge-q') sh.querySelector('#merge-list').innerHTML = list(e.target.value.trim()); });
  return sheet;
}
function mergeImpact(level, source, ex) {
  const workouts = new Set(); let sets = 0, entries = 0;
  for (const w of S.wo.values()) for (const e of w.entries) {
    const hit = level === 'activity' ? (!isLift(e) && e.activityId === source.id)
      : level === 'variant' ? (isLift(e) && e.exerciseId === ex.id && e.variantId === source.id)
        : (isLift(e) && e.exerciseId === source.id);
    if (hit) { workouts.add(w.id); entries++; if (isLift(e)) sets += e.sets.length; }
  }
  return { workouts: workouts.size, sets, entries };
}
function openMergeConfirm(level, source, target, ex) {
  const imp = mergeImpact(level, source, ex);
  const what = level === 'activity' ? `${plural(imp.entries, 'cardio entry').replace('entrys', 'entries')} in ${plural(imp.workouts, 'workout')}` : `${plural(imp.workouts, 'workout')} and ${plural(imp.sets, 'set')}`;
  const chartLine = level === 'activity' ? '' : '<li>Their charts, PRs and last-3 history will combine.</li>';
  let n = 5;
  const sheet = openSheet(`<h3 class="danger-title">⚠️ Merge “${esc(source.name)}” into “${esc(target.name)}”?</h3>
    <ul class="warn-list">
      <li><b>${esc(what)}</b> move from “${esc(source.name)}” to “${esc(target.name)}”.</li>
      ${chartLine}
      <li>“${esc(source.name)}” is removed from your ${level === 'variant' ? 'variants' : 'library'}.</li>
      <li>Double-check these really are the same ${LEVEL_WORD[level]}. You can undo the most recent merge from “${esc(target.name)}”, but don't count on it as a safety net.</li>
    </ul>
    <button class="block" data-a="backup">Export a backup first</button>
    <div class="actions"><button data-a="cancel">Cancel</button><button class="danger-fill" data-a="go" disabled>Merge (${n})</button></div>`,
  async (e) => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    if (a.dataset.a === 'cancel') { closeSheet(); return; }
    if (a.dataset.a === 'backup') { await exportBackup(); a.textContent = 'Backup exported ✓'; return; }
    if (a.dataset.a === 'go' && !a.disabled) {
      closeSheet();
      await doMerge(level, source.id, target.id, ex ? ex.id : null);
      go(level === 'activity' ? '#/activity/' + target.id : '#/exercise/' + (level === 'variant' ? ex.id : target.id));
    }
  });
  const btn = sheet.querySelector('[data-a="go"]');
  const t = setInterval(() => {
    if (!btn.isConnected) { clearInterval(t); return; }
    n--;
    if (n <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = 'Merge'; } else btn.textContent = `Merge (${n})`;
  }, 1000);
}

async function doMerge(level, sourceId, targetId, exId) {
  const at = nowIso();
  const m = { id: db.uid(), at, level, sourceId, targetId, exerciseId: exId, moved: [], variantMap: {}, addedVariantIds: [], undoneAt: null };
  const ops = [];
  const changedW = new Set();
  if (level === 'exercise') {
    const src = S.ex.get(sourceId), tgt = S.ex.get(targetId);
    m.sourceName = src.name; m.targetName = tgt.name; m.sourceSnapshot = clone(src); m.targetWasHidden = !!tgt.hidden;
    for (const sv of src.variants) {
      const match = tgt.variants.find((tv) => nameKey(tv.name) === nameKey(sv.name));
      if (match) m.variantMap[sv.id] = match.id;
      else { tgt.variants.push(clone(sv)); m.variantMap[sv.id] = sv.id; m.addedVariantIds.push(sv.id); }
    }
    for (const w of S.wo.values()) for (const e of liftEntries(w)) if (e.exerciseId === sourceId) {
      m.moved.push({ workoutId: w.id, entryId: e.id, fromExerciseId: sourceId, fromVariantId: e.variantId });
      e.exerciseId = targetId; e.variantId = e.variantId ? m.variantMap[e.variantId] || null : null; changedW.add(w);
    }
    tgt.hidden = false; tgt.lastUsed = [tgt.lastUsed, src.lastUsed].filter(Boolean).sort().pop() || null; touch(tgt);
    S.ex.delete(sourceId);
    ops.push({ store: 'exercises', put: tgt }, { store: 'exercises', del: sourceId });
    if (META.progressKey && META.progressKey.startsWith(sourceId + '|')) META.progressKey = null;
  } else if (level === 'variant') {
    const ex = S.ex.get(exId);
    const src = ex.variants.find((v) => v.id === sourceId), tgt = ex.variants.find((v) => v.id === targetId);
    m.sourceName = src.name; m.targetName = tgt.name; m.sourceSnapshot = clone(src); m.targetWasHidden = !!tgt.hidden;
    for (const w of S.wo.values()) for (const e of liftEntries(w)) if (e.exerciseId === exId && e.variantId === sourceId) {
      m.moved.push({ workoutId: w.id, entryId: e.id, fromExerciseId: exId, fromVariantId: sourceId });
      e.variantId = targetId; changedW.add(w);
    }
    tgt.hidden = false;
    ex.variants = ex.variants.filter((v) => v.id !== sourceId); touch(ex);
    ops.push({ store: 'exercises', put: ex });
  } else {
    const src = S.act.get(sourceId), tgt = S.act.get(targetId);
    m.sourceName = src.name; m.targetName = tgt.name; m.sourceSnapshot = clone(src); m.targetWasHidden = !!tgt.hidden;
    for (const w of S.wo.values()) for (const e of w.entries) if (!isLift(e) && e.activityId === sourceId) {
      m.moved.push({ workoutId: w.id, entryId: e.id, fromActivityId: sourceId });
      e.activityId = targetId; changedW.add(w);
    }
    tgt.hidden = false; touch(tgt);
    S.act.delete(sourceId);
    ops.push({ store: 'activities', put: tgt }, { store: 'activities', del: sourceId });
  }
  for (const w of changedW) ops.push({ store: 'workouts', put: touch(w) });
  ops.push({ store: 'merges', put: m });
  S.merges.set(m.id, m);
  await db.batch(ops);
  return m;
}

// The most recent merge into this item that hasn't been undone (only that one can be undone).
function lastMerge(targetId, level) {
  const list = [...S.merges.values()].filter((m) => !m.undoneAt && m.level === level && (level === 'variant' ? m.exerciseId === targetId : m.targetId === targetId));
  list.sort((a, b) => b.at.localeCompare(a.at));
  const m = list[0];
  if (!m) return null;
  if (level === 'exercise' && (S.ex.has(m.sourceId) || !S.ex.has(m.targetId))) return null;
  if (level === 'activity' && (S.act.has(m.sourceId) || !S.act.has(m.targetId))) return null;
  if (level === 'variant') { const ex = S.ex.get(m.exerciseId); if (!ex || ex.variants.some((v) => v.id === m.sourceId) || !ex.variants.some((v) => v.id === m.targetId)) return null; }
  return m;
}
async function askUndo(mergeId) {
  const m = S.merges.get(mergeId);
  if (!m) return;
  const ok = await confirmSheet(`Undo merging “${m.sourceName}” into “${m.targetName}”?`, 'Undo merge');
  if (!ok) return;
  await undoMerge(m);
  go(m.level === 'activity' ? '#/activity/' + m.sourceId : '#/exercise/' + (m.level === 'variant' ? m.exerciseId : m.sourceId));
}
async function undoMerge(m) {
  const ops = [];
  const changedW = new Set();
  const movedIds = new Set(m.moved.map((x) => x.entryId));
  const findEntry = (mv) => { const w = S.wo.get(mv.workoutId); const e = w && w.entries.find((x) => x.id === mv.entryId); return e ? { w, e } : null; };
  if (m.level === 'exercise') {
    const src = clone(m.sourceSnapshot), tgt = S.ex.get(m.targetId);
    // variants that came over from the source go back; if the target has since used one, it keeps its own copy
    for (const vid of m.addedVariantIds || []) {
      const v = tgt.variants.find((x) => x.id === vid);
      if (!v) continue;
      const users = [];
      for (const w of S.wo.values()) for (const e of liftEntries(w)) if (e.exerciseId === tgt.id && e.variantId === vid && !movedIds.has(e.id)) users.push([w, e]);
      tgt.variants = tgt.variants.filter((x) => x.id !== vid);
      if (users.length) {
        const copy = { ...clone(v), id: db.uid() };
        tgt.variants.push(copy);
        users.forEach(([w, e]) => { e.variantId = copy.id; changedW.add(w); });
      }
    }
    for (const mv of m.moved) {
      const f = findEntry(mv);
      if (f && isLift(f.e) && f.e.exerciseId === m.targetId) { f.e.exerciseId = mv.fromExerciseId; f.e.variantId = mv.fromVariantId; changedW.add(f.w); }
    }
    tgt.hidden = !!m.targetWasHidden; touch(tgt);
    S.ex.set(src.id, src);
    ops.push({ store: 'exercises', put: tgt }, { store: 'exercises', put: touch(src) });
  } else if (m.level === 'variant') {
    const ex = S.ex.get(m.exerciseId);
    ex.variants.push(clone(m.sourceSnapshot));
    for (const mv of m.moved) {
      const f = findEntry(mv);
      if (f && isLift(f.e) && f.e.exerciseId === m.exerciseId && f.e.variantId === m.targetId) { f.e.variantId = mv.fromVariantId; changedW.add(f.w); }
    }
    const tv = ex.variants.find((v) => v.id === m.targetId); if (tv) tv.hidden = !!m.targetWasHidden;
    ops.push({ store: 'exercises', put: touch(ex) });
  } else {
    const src = clone(m.sourceSnapshot), tgt = S.act.get(m.targetId);
    for (const mv of m.moved) {
      const f = findEntry(mv);
      if (f && !isLift(f.e) && f.e.activityId === m.targetId) { f.e.activityId = mv.fromActivityId; changedW.add(f.w); }
    }
    tgt.hidden = !!m.targetWasHidden; touch(tgt);
    S.act.set(src.id, src);
    ops.push({ store: 'activities', put: tgt }, { store: 'activities', put: touch(src) });
  }
  for (const w of changedW) ops.push({ store: 'workouts', put: touch(w) });
  m.undoneAt = nowIso();
  ops.push({ store: 'merges', put: m });
  await db.batch(ops);
}

// ============================================================
// Progress dashboard (weights only)
// ============================================================
const comboKey = (exerciseId, variantId) => `${exerciseId}|${variantId || ''}`;
const e1rm = (s) => s.weight * (1 + s.reps / 30);
const usable = (s) => !isWarmup(s) && s.weight !== null && s.reps !== null;

function progressCombos() {
  const seen = new Map();
  for (const w of sortedWorkouts()) {
    for (const e of liftEntries(w)) {
      if (!e.sets.some(usable)) continue;
      const k = comboKey(e.exerciseId, e.variantId);
      if (seen.has(k)) continue;
      const ex = S.ex.get(e.exerciseId);
      const v = ex && e.variantId ? ex.variants.find((x) => x.id === e.variantId) : null;
      seen.set(k, { key: k, label: (ex ? ex.name : '(deleted)') + (v ? ' · ' + v.name : '') + (ex && ex.hidden ? ' (hidden)' : '') });
    }
  }
  return [...seen.values()];
}

// One point per workout. Only working sets, only base reps.
function progressPoints(key, mode) {
  const pts = [];
  const workouts = [...S.wo.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const w of workouts) {
    const sets = liftEntries(w).filter((e) => comboKey(e.exerciseId, e.variantId) === key).flatMap((e) => e.sets).filter(usable);
    if (!sets.length) continue;
    const heaviest = sets.reduce((best, s) => (!best || s.weight > best.weight || (s.weight === best.weight && s.reps > best.reps) ? s : best), null);
    let pick = heaviest;
    if (mode === 'e1rm' && heaviest.weight > 0) {
      pick = sets.filter((s) => s.weight > 0).reduce((best, s) => (!best || e1rm(s) > e1rm(best) ? s : best), null);
    }
    pts.push({ id: w.id, date: w.date, weight: pick.weight, reps: pick.reps });
  }
  return pts;
}

function repPRs(key) {
  const best = new Map();
  const workouts = [...S.wo.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const w of workouts) {
    for (const e of liftEntries(w)) {
      if (comboKey(e.exerciseId, e.variantId) !== key) continue;
      for (const s of e.sets.filter(usable)) {
        if (s.reps < 1) continue;
        const cur = best.get(s.reps);
        if (!cur || s.weight > cur.weight) best.set(s.reps, { reps: s.reps, weight: s.weight, date: w.date, id: w.id });
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
      <div class="chart-legend"><span><i class="lg-line"></i>Weight (lb)</span><span><i class="lg-bar"></i>Reps</span><span class="faint">Tap a point to open it</span></div>
      <div class="chart" id="chart"></div>
    </div>
    <div class="section-label">Rep PRs</div>
    <div class="card" style="padding:4px 12px">
      <table class="pr-table"><thead><tr><th>Reps</th><th>Best weight</th><th>Date</th></tr></thead>
      <tbody>${prs.map((r) => `<tr data-nav="${esc(withBack('#/workout/' + r.id, '#/progress'))}"><td>${r.reps}</td><td>${fmtNum(r.weight)} lb</td><td>${esc(fmtWhen(r.date))} <span class="chev">›</span></td></tr>`).join('')}</tbody></table>
    </div>
    <p class="faint small" style="text-align:center">Working sets only · base reps only (drops, myo-rep mini-sets and forced reps don't count)</p>
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
  const bars = pts.map((p, i) => { const y = yR(p.reps); return `<path class="c-bar" d="M${xs[i] - bw / 2},${top + plotH} V${y + 4} q0,-4 4,-4 H${xs[i] + bw / 2 - 4} q4,0 4,4 V${top + plotH} Z"/>
    <text class="c-rep" x="${xs[i]}" y="${top + plotH - 6}">${p.reps}</text>`; }).join('');
  const line = pts.length > 1 ? `<polyline class="c-line" points="${pts.map((p, i) => `${xs[i]},${yW(p.weight)}`).join(' ')}"/>` : '';
  const dots = pts.map((p, i) => `<g class="c-hit" data-nav="${esc(withBack('#/workout/' + p.id, '#/progress'))}"><rect x="${xs[i] - SP / 2}" y="0" width="${SP}" height="${H}" fill="transparent"/>
    <circle class="c-dot" cx="${xs[i]}" cy="${yW(p.weight)}" r="4.5"/><text class="c-wlabel" x="${xs[i]}" y="${yW(p.weight) - 10}">${fmtNum(p.weight)}</text></g>`).join('');
  const dates = pts.map((p, i) => `<text class="c-date" x="${xs[i]}" y="${H - 10}">${esc(shortDate(p.date))}</text>`).join('');
  const left = `<svg width="${AX_L}" height="${H}" class="c-axis">${ticks.map((t) => `<text x="${AX_L - 6}" y="${yW(t) + 4}" text-anchor="end">${fmtNum(t)}</text>`).join('')}<text x="4" y="${top + 2}" class="c-unit" text-anchor="start" dominant-baseline="hanging">lb</text></svg>`;
  const right = `<svg width="${AX_R}" height="${H}" class="c-axis">${rTicks.map((t) => `<text x="6" y="${yR(t) + 4}">${fmtNum(t)}</text>`).join('')}</svg>`;
  box.innerHTML = `${left}<div class="c-scroll" id="c-scroll"><svg width="${W}" height="${H}" role="img" aria-label="Weight and reps per workout">
    <line class="c-base" x1="0" x2="${W}" y1="${top + plotH}" y2="${top + plotH}"/>${grid}${bars}${line}${dates}${dots}</svg></div>${right}`;
  const sc = document.getElementById('c-scroll');
  sc.scrollLeft = sc.scrollWidth; // newest on screen
  if (W > avail + 1) box.insertAdjacentHTML('afterend', `<div class="faint small" style="text-align:center;padding:2px 0 6px">‹ swipe the chart for older workouts · ${pts.length} total</div>`);
}

async function onProgressAction(act, el) {
  if (act === 'mode') { META.chartMode = el.dataset.mode; await saveMeta(); renderProgress(); }
}

// ============================================================
// Settings, backup and import
// ============================================================
function daysSince(iso) { return iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null; }
function backupText() {
  const d = daysSince(META.lastBackup);
  if (d === null) return 'Never backed up';
  if (d === 0) return 'Backed up today';
  return `Last backup ${d} day${d === 1 ? '' : 's'} ago`;
}
const needsBackup = () => S.wo.size > 0 && (META.lastBackup === null || daysSince(META.lastBackup) >= 14);

function renderSettings(msg) {
  const swatch = ([id, name, desc, bg, card, a1, a2]) => `<button class="swatch${META.theme === id ? ' on' : ''}" data-act="theme" data-theme-id="${id}" style="background:${bg};border-color:${META.theme === id ? a1 : 'transparent'}">
      <span class="sw-card" style="background:${card}"><i style="background:${a1}"></i><i style="background:${a2}"></i></span>
      <span class="sw-name" style="color:${['#000000', '#141618', '#1A1411', '#0E1A28', '#160F29'].includes(bg) ? '#F5F5F5' : '#1B1F24'}">${esc(name)}</span></button>`;
  app.innerHTML = topbar('Settings', '#/', 'Home') + `<main>
    <div class="section-label">Theme</div>
    <div class="swatches">${THEMES.map(swatch).join('')}</div>
    <div class="section-label">Calendar</div>
    <div class="card">
      <div class="toggle-row"><span class="grow"><span class="t-label">Week starts on</span></span>
        <div class="seg seg-inline" role="group" aria-label="Week starts on">
          <button data-act="week-start" data-ws="mon" class="${META.weekStart !== 'sun' ? 'on' : ''}">Monday</button>
          <button data-act="week-start" data-ws="sun" class="${META.weekStart === 'sun' ? 'on' : ''}">Sunday</button></div></div>
      <label class="toggle-row"><span class="grow"><span class="t-label">Weekly streak</span><span class="t-hint">Weeks in a row with at least one workout, shown on the home screen</span></span>
        <input type="checkbox" class="switch" data-pref="showStreak"${META.showStreak ? ' checked' : ''}></label>
    </div>
    <div class="section-label">Fields to show</div>
    <div class="card">
      ${SETTING_LABELS.map(([k, label, hint]) => `<label class="toggle-row"><span class="grow"><span class="t-label">${esc(label)}</span><span class="t-hint">${esc(hint)}</span></span>
        <input type="checkbox" class="switch" data-setting="${k}"${SETTINGS[k] ? ' checked' : ''}></label>`).join('')}
      <p class="faint small" style="margin:10px 0 0">Exercise, weight and reps are always shown. Turning a field off only hides it; anything already logged is kept.</p>
    </div>
    <div class="section-label">Data</div>
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:10px"><span>${plural(S.wo.size, 'workout')} on this phone</span>
        <span class="small ${needsBackup() ? 'warn' : 'muted'}">${esc(backupText())}</span></div>
      <button class="primary block" data-act="export">Export backup</button>
      <p class="faint small" style="margin:10px 0 0">Saves one .zip file. Choose “Save to Files” to keep a copy. Inside are spreadsheet (CSV) tables linked by ID, which open in Numbers, Excel or Google Sheets. Your data only lives on this phone, so a backup every couple of weeks is a good habit.</p>
      <button class="block" data-act="import" style="margin-top:12px">Import backup</button>
      <input type="file" id="import-file" accept=".zip,.csv,application/zip,text/csv" hidden>
      <p class="faint small" style="margin:8px 0 0">Reads a Lift Log backup (.zip) or an older CSV export. Nothing on the phone is deleted; you'll see what changes before anything is saved.</p>
      <div id="export-msg" class="small muted" style="margin-top:8px">${msg ? esc(msg) : ''}</div>
    </div>
    <p class="faint small" style="text-align:center;margin-top:24px">Lift Log ${esc(APP_VERSION)}${ENV === 'dev' ? ' · DEV copy (separate data from the real app)' : ''}</p>
  </main>`;
}

const backupState = () => ({
  exercises: [...S.ex.values()], workouts: [...S.wo.values()], activities: [...S.act.values()], merges: [...S.merges.values()],
  settings: SETTINGS, prefs: { theme: META.theme, weekStart: META.weekStart, showStreak: META.showStreak }, appVersion: APP_VERSION
});

async function exportBackup() {
  const name = `lift-log-${ENV === 'dev' ? 'DEV-' : ''}${localDateValue(nowIso())}.zip`;
  const { blob } = buildExportZip(backupState());
  const file = new File([blob], name, { type: 'application/zip' });
  let done = false;
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); done = true; }
  } catch (err) {
    if (err && err.name === 'AbortError') return 'Export cancelled.';
  }
  if (!done) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  META.lastBackup = nowIso();
  await saveMeta();
  return `Exported ${name}.`;
}

async function importFromFile(file) {
  let incoming, plan;
  try {
    incoming = await readImportFile(file, backupState());
    plan = planImport(backupState(), incoming);
  } catch (err) {
    await choiceSheet('Couldn\'t import that file', esc(err.message || String(err)), [{ label: 'OK', value: true, kind: 'primary' }]);
    return;
  }
  const s = plan.summary;
  const row = (label, c) => `<tr><td>${label}</td><td>${c.new}</td><td>${c.updated}</td><td>${c.unchanged}</td></tr>`;
  const notes = [];
  if (incoming.format === 'csv') notes.push('Older CSV file: exercises and variants are matched by name. Workouts already on the phone are skipped.');
  if (plan.skippedRows) notes.push(`${plan.skippedRows} rows belong to workouts already on this phone and were skipped.`);
  if (plan.possibleDuplicates.length) notes.push(`Possible duplicates (same name, different record): ${plan.possibleDuplicates.slice(0, 5).join(', ')}${plan.possibleDuplicates.length > 5 ? '…' : ''}. You can combine them with Merge afterwards.`);
  const nothing = !plan.ops.length;
  const go2 = await choiceSheet('Import backup?', `<table class="imp-table"><tr><th></th><th>New</th><th>Updated</th><th>Same</th></tr>
      ${row('Workouts', s.workouts)}${row('Exercises', s.exercises)}${row('Cardio activities', s.activities)}</table>
      ${notes.map((n) => `<span class="imp-note">${esc(n)}</span>`).join('')}${nothing ? '<span class="imp-note">Everything in this file is already on the phone.</span>' : ''}`,
  nothing ? [{ label: 'OK', value: null, kind: 'primary' }] : [{ label: 'Import', value: true, kind: 'primary' }, { label: 'Cancel', value: null }]);
  if (!go2) return;
  await db.batch(plan.ops);
  await loadAll();
  if (onView('#/settings')) renderSettings(`Imported: ${s.workouts.new} new and ${s.workouts.updated} updated workouts.`);
}

// ============================================================
// Event wiring (one listener for the whole app)
// ============================================================
app.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { go(nav.dataset.nav); return; }
  const day = e.target.closest('[data-day]');
  if (day && !day.disabled) { openDaySheet(day.dataset.day); return; }
  const a = e.target.closest('[data-act]');
  if (!a || a.disabled) return;
  const act = a.dataset.act;
  if (act === 'start-workout') return openStartSheet();
  if (act === 'cal-prev') { calOffset--; return renderHome(); }
  if (act === 'cal-next') { calOffset = Math.min(0, calOffset + 1); return renderHome(); }
  // preference taps: update the screen first, then save in the background
  if (act === 'cal-view') { META.calView = a.dataset.view; calOffset = 0; renderHome(); return saveMeta(); }
  if (act === 'streak') { META.calView = 'year'; calOffset = 0; renderHome(); window.scrollTo(0, 0); return saveMeta(); }
  if (act === 'lib-tab') { META.libTab = a.dataset.tab; renderLibrary(); return saveMeta(); }
  if (act === 'lib-add') return libraryAdd();
  if (act === 'export') { const m = await exportBackup(); if (onView('#/settings')) renderSettings(m); return; }
  if (act === 'import') return document.getElementById('import-file').click();
  if (act === 'theme') { META.theme = a.dataset.themeId; applyTheme(META.theme); renderSettings(); return saveMeta(); }
  if (act === 'week-start') { META.weekStart = a.dataset.ws; renderSettings(); return saveMeta(); }
  if (onView('#/progress')) return onProgressAction(act, a);
  if (onView('#/exercise/')) return onExerciseAction(act, a);
  if (onView('#/activity/')) return onActivityAction(act, a);
  if (onView('#/workout/')) return onWorkoutAction(act, a);
});

function onAnyInput(e) {
  const el = e.target;
  if (onView('#/workout/')) return onWorkoutInput(el);
  if (onView('#/exercise/')) return onExerciseInput(el);
  if (onView('#/activity/') && el.dataset.actfield === 'name') document.querySelector('.topbar h1').textContent = el.value.trim() || ' ';
}
app.addEventListener('input', onAnyInput);
app.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'prog-ex') { META.progressKey = el.value; await saveMeta(); renderProgress(); return; }
  if (el.id === 'import-file') { const f = el.files && el.files[0]; el.value = ''; if (f) await importFromFile(f); return; }
  const k = el.dataset.setting;
  if (k) { SETTINGS[k] = el.checked; await saveSettings(); return; }
  const p = el.dataset.pref;
  if (p) { META[p] = el.checked; await saveMeta(); return; }
  if (onView('#/exercise/') && (el.dataset.exfield || el.dataset.vfield)) return onExerciseChange(el);
  if (onView('#/activity/') && el.dataset.actfield) return onActivityChange(el);
  if (el.tagName === 'SELECT' || el.type === 'date' || el.type === 'time') onAnyInput(e);
});

app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'new-ex') { e.preventDefault(); libraryAdd(); }
  if (e.target.id === 'new-var') { e.preventDefault(); onExerciseAction('var-add', e.target); }
  if (e.target.dataset.exfield || e.target.dataset.vfield || e.target.dataset.actfield) { e.preventDefault(); e.target.blur(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'newvar') { e.preventDefault(); e.target.parentElement.querySelector('[data-newvar]').click(); }
  if (e.key === 'Enter' && e.target.id === 'pick-q') {
    e.preventDefault();
    const first = document.querySelector('#pick-list button');
    if (first) first.click();
  }
});
// lets :active (the pressed look) work on iPhone
document.addEventListener('touchstart', () => {}, { passive: true });

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

async function loadAll() {
  const [exs, wos, acts, merges, st, mt] = await Promise.all([db.getAll('exercises'), db.getAll('workouts'), db.getAll('activities'), db.getAll('merges'), db.get('meta', 'settings'), db.get('meta', 'meta')]);
  if (st) SETTINGS = { ...DEFAULT_SETTINGS, ...st.value };
  if (mt) META = { ...META, ...mt.value };
  S.ex.clear(); S.wo.clear(); S.act.clear(); S.merges.clear();
  exs.forEach((x) => S.ex.set(x.id, x));
  wos.forEach((x) => S.wo.set(x.id, x));
  acts.forEach((x) => S.act.set(x.id, x));
  merges.forEach((x) => S.merges.set(x.id, x));
}

async function boot() {
  await loadAll();
  applyTheme(META.theme);
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
window.__liftlog = {
  S, get SETTINGS() { return SETTINGS; }, get META() { return META; }, progressPoints, repPRs, doMerge, undoMerge, loadAll,
  backupState, vetName, route, APP_VERSION
};
