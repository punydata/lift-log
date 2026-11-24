// Backup export (one zip of ID-linked CSV tables) and import (that zip, or a v0.5 flat CSV).
import { makeZip, readZip } from './zip.js';
import {
  SCHEMA_VERSION, uid, isSafeId, nameKey, normalizeExercise, normalizeVariant, normalizeActivity, normalizeWorkout
} from './model.js';

export const MAX_ROWS = 200000;

// ---------- CSV ----------
const cell = (v) => {
  const t = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(t) || /^\s|\s$/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
export function toCsv(cols, rows) {
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}
export function parseCsv(text, maxRows = MAX_ROWS) {
  text = String(text).replace(/^﻿/, '');
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"' && f === '') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (rows.length > maxRows + 1) throw new Error('That file has too many rows to import.');
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const iso = (v) => (v ? String(v) : null);
const num = (v) => (v === '' || v === undefined || v === null || !isFinite(Number(v)) ? null : Number(v));
const int = (v) => { const n = num(v); return n === null ? null : Math.round(n); };
const bool = (v) => String(v).toLowerCase() === 'true';
function localStamp(isoStr) {
  const d = new Date(isoStr);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const activeDrops = (s) => (s.types.includes('Drop Set') ? s.drops : []);
const activeMinis = (s) => (s.types.includes('Myo-rep Match') ? s.myo.minis : []);
const activeForce = (s) => (s.types.includes('Force Reps') && s.force && s.force.reps !== null ? s.force : null);

// ---------- export ----------
const COLS = {
  exercises: ['exercise_id', 'name', 'hidden', 'created_at', 'updated_at', 'last_used'],
  variants: ['variant_id', 'exercise_id', 'name', 'hidden', 'created_at', 'updated_at'],
  activities: ['activity_id', 'name', 'hidden', 'created_at', 'updated_at'],
  workouts: ['workout_id', 'type', 'name', 'start_time', 'start_local', 'ended_at', 'created_at', 'updated_at'],
  entries: ['entry_id', 'workout_id', 'position', 'kind', 'exercise_id', 'variant_id', 'activity_id', 'minutes', 'miles', 'calories', 'note'],
  sets: ['set_id', 'entry_id', 'workout_id', 'position', 'weight', 'reps', 'set_types', 'rom', 'rpe', 'myo_target'],
  segments: ['segment_id', 'set_id', 'entry_id', 'workout_id', 'segment_kind', 'segment_number', 'weight', 'reps'],
  merges: ['merge_id', 'at', 'level', 'source_id', 'target_id', 'undone_at', 'detail_json']
};
const FLAT_COLS = ['workout_id', 'workout_date', 'workout_name', 'exercise', 'variant', 'set_number', 'segment_number', 'segment_kind',
  'weight', 'reps', 'set_types', 'myo_target', 'rom', 'rpe', 'exercise_note', 'exercise_id', 'variant_id', 'entry_id', 'set_id', 'segment_id'];

// state: { exercises, workouts, activities, merges, settings, prefs, appVersion }
export function buildExportFiles(state, when = new Date()) {
  const T = Object.fromEntries(Object.keys(COLS).map((k) => [k, []]));
  const flat = [];
  const exById = new Map(state.exercises.map((x) => [x.id, x]));
  for (const x of state.exercises) {
    T.exercises.push({ exercise_id: x.id, name: x.name, hidden: x.hidden, created_at: x.createdAt, updated_at: x.updatedAt, last_used: x.lastUsed });
    for (const v of x.variants) T.variants.push({ variant_id: v.id, exercise_id: x.id, name: v.name, hidden: v.hidden, created_at: v.createdAt, updated_at: v.updatedAt });
  }
  for (const a of state.activities) T.activities.push({ activity_id: a.id, name: a.name, hidden: a.hidden, created_at: a.createdAt, updated_at: a.updatedAt });
  const workouts = [...state.workouts].sort((a, b) => a.date.localeCompare(b.date));
  for (const w of workouts) {
    T.workouts.push({ workout_id: w.id, type: w.type, name: w.name, start_time: w.date, start_local: localStamp(w.date), ended_at: w.endedAt, created_at: w.createdAt, updated_at: w.updatedAt });
    w.entries.forEach((e, ei) => {
      if (e.kind === 'cardio') {
        T.entries.push({ entry_id: e.id, workout_id: w.id, position: ei + 1, kind: 'cardio', activity_id: e.activityId, minutes: e.minutes, miles: e.miles, calories: e.calories, note: e.note });
        return;
      }
      T.entries.push({ entry_id: e.id, workout_id: w.id, position: ei + 1, kind: 'lift', exercise_id: e.exerciseId, variant_id: e.variantId, note: e.note });
      const ex = exById.get(e.exerciseId);
      const v = ex && e.variantId ? ex.variants.find((x) => x.id === e.variantId) : null;
      const fbase = { workout_id: w.id, workout_date: localStamp(w.date), workout_name: w.name, exercise: ex ? ex.name : '', variant: v ? v.name : '',
        exercise_note: e.note, exercise_id: e.exerciseId, variant_id: e.variantId, entry_id: e.id };
      const sets = e.sets.filter((s) => s.weight !== null || s.reps !== null);
      if (!sets.length && e.note) flat.push(fbase);
      sets.forEach((s, si) => {
        const types = s.types.join('|');
        const myoT = s.types.includes('Myo-rep Match') ? s.myo.target : null;
        T.sets.push({ set_id: s.id, entry_id: e.id, workout_id: w.id, position: si + 1, weight: s.weight, reps: s.reps, set_types: types, rom: s.rom, rpe: s.rpe, myo_target: myoT });
        const seg = (id, kind, n, weight, reps) => {
          T.segments.push({ segment_id: id, set_id: s.id, entry_id: e.id, workout_id: w.id, segment_kind: kind, segment_number: n, weight, reps });
          flat.push({ ...fbase, set_number: si + 1, segment_number: n, segment_kind: kind, weight, reps, set_types: types, set_id: s.id, segment_id: id,
            ...(kind === 'base' ? { myo_target: myoT, rom: s.rom, rpe: s.rpe } : {}) });
        };
        seg(s.id, 'base', 0, s.weight, s.reps);
        activeDrops(s).forEach((d, j) => seg(d.id, 'drop', j + 1, d.weight, d.reps));
        activeMinis(s).forEach((m, j) => seg(m.id, 'myo', j + 1, s.weight, m.reps));
        const f = activeForce(s);
        if (f) seg(f.id, 'force', 1, s.weight, f.reps);
      });
    });
  }
  for (const m of state.merges) {
    const { id, at, level, sourceId, targetId, undoneAt, ...detail } = m;
    T.merges.push({ merge_id: id, at, level, source_id: sourceId, target_id: targetId, undone_at: undoneAt, detail_json: JSON.stringify(detail) });
  }
  const counts = Object.fromEntries(Object.entries(T).map(([k, rows]) => [k, rows.length]));
  const manifest = {
    app: 'Lift Log', app_version: state.appVersion, schema_version: SCHEMA_VERSION, exported_at: when.toISOString(),
    files: Object.keys(COLS).map((k) => k + '.csv').concat(['all_sets_flat.csv', 'settings.json']), row_counts: counts,
    notes: 'Tables join on their *_id columns. segments.csv has one row per base set, drop, myo-rep mini-set and forced-reps segment. all_sets_flat.csv is the same set data in one spreadsheet-friendly table.'
  };
  const files = [{ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) }];
  for (const k of Object.keys(COLS)) files.push({ name: k + '.csv', data: toCsv(COLS[k], T[k]) });
  files.push({ name: 'all_sets_flat.csv', data: toCsv(FLAT_COLS, flat) });
  files.push({ name: 'settings.json', data: JSON.stringify({ settings: state.settings, prefs: state.prefs }, null, 2) });
  return { files, counts };
}
export function buildExportZip(state, when = new Date()) {
  const { files, counts } = buildExportFiles(state, when);
  return { blob: makeZip(files, when), counts };
}

// ---------- import ----------
function need(id, where) {
  if (!isSafeId(id)) throw new Error(`${where} has a missing or invalid ID, so the file can't be imported.`);
  return id;
}
function optId(id, where) { return id ? need(id, where) : null; }

// Returns { exercises, activities, workouts, merges, settings, prefs } in the app's v2 shape.
export function fromZipFiles(files) {
  const dec = new TextDecoder();
  const text = (n) => (files[n] ? dec.decode(files[n]) : null);
  if (!files['manifest.json']) throw new Error('This zip is not a Lift Log backup (manifest.json is missing).');
  let manifest;
  try { manifest = JSON.parse(text('manifest.json')); } catch (e) { throw new Error('This backup\'s manifest.json is unreadable.'); }
  if (manifest.app !== 'Lift Log') throw new Error('This zip is not a Lift Log backup.');
  if (Number(manifest.schema_version) > SCHEMA_VERSION) throw new Error(`This backup was made by a newer version of Lift Log (data version ${manifest.schema_version}). Update the app, then import it.`);
  const table = (n) => (files[n + '.csv'] ? parseCsv(text(n + '.csv')) : []);
  const ex = new Map();
  table('exercises').forEach((r, i) => {
    const id = need(r.exercise_id, `exercises.csv row ${i + 2}`);
    ex.set(id, normalizeExercise({ id, name: r.name, hidden: bool(r.hidden), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), lastUsed: iso(r.last_used), variants: [] }));
  });
  table('variants').forEach((r, i) => {
    const where = `variants.csv row ${i + 2}`;
    const x = ex.get(need(r.exercise_id, where));
    if (!x) throw new Error(`${where} points to an exercise that isn't in the backup.`);
    x.variants.push(normalizeVariant({ id: need(r.variant_id, where), name: r.name, hidden: bool(r.hidden), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }));
  });
  const activities = table('activities').map((r, i) => normalizeActivity({ id: need(r.activity_id, `activities.csv row ${i + 2}`), name: r.name, hidden: bool(r.hidden), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }));
  const wo = new Map();
  table('workouts').forEach((r, i) => {
    const id = need(r.workout_id, `workouts.csv row ${i + 2}`);
    if (!r.start_time || isNaN(new Date(r.start_time))) throw new Error(`workouts.csv row ${i + 2} has no valid start time.`);
    wo.set(id, { id, type: r.type, name: r.name, date: r.start_time, endedAt: iso(r.ended_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), entries: [] });
  });
  const entries = new Map();
  table('entries').forEach((r, i) => {
    const where = `entries.csv row ${i + 2}`;
    const w = wo.get(need(r.workout_id, where));
    if (!w) throw new Error(`${where} points to a workout that isn't in the backup.`);
    const e = r.kind === 'cardio'
      ? { id: need(r.entry_id, where), kind: 'cardio', activityId: optId(r.activity_id, where), minutes: int(r.minutes), miles: num(r.miles), calories: int(r.calories), note: r.note, _pos: int(r.position) }
      : { id: need(r.entry_id, where), kind: 'lift', exerciseId: optId(r.exercise_id, where), variantId: optId(r.variant_id, where), note: r.note, sets: [], _pos: int(r.position) };
    w.entries.push(e); entries.set(e.id, e);
  });
  const sets = new Map();
  table('sets').forEach((r, i) => {
    const where = `sets.csv row ${i + 2}`;
    const e = entries.get(need(r.entry_id, where));
    if (!e || e.kind !== 'lift') throw new Error(`${where} points to an exercise entry that isn't in the backup.`);
    const s = { id: need(r.set_id, where), weight: num(r.weight), reps: int(r.reps), types: r.set_types ? r.set_types.split('|') : [], rom: int(r.rom), rpe: int(r.rpe),
      drops: [], myo: { target: int(r.myo_target), minis: [] }, force: null, _pos: int(r.position) };
    e.sets.push(s); sets.set(s.id, s);
  });
  table('segments').forEach((r, i) => {
    const where = `segments.csv row ${i + 2}`;
    if (r.segment_kind === 'base') return;
    const s = sets.get(need(r.set_id, where));
    if (!s) throw new Error(`${where} points to a set that isn't in the backup.`);
    const id = need(r.segment_id, where), n = int(r.segment_number);
    if (r.segment_kind === 'drop') s.drops.push({ id, weight: num(r.weight), reps: int(r.reps), _pos: n });
    else if (r.segment_kind === 'myo') s.myo.minis.push({ id, reps: int(r.reps), _pos: n });
    else if (r.segment_kind === 'force') s.force = { id, reps: int(r.reps) };
  });
  const byPos = (a, b) => (a._pos ?? 0) - (b._pos ?? 0);
  const strip = (o) => { delete o._pos; return o; };
  const workouts = [...wo.values()].map((w) => {
    w.entries.sort(byPos).forEach((e) => { strip(e); if (e.sets) e.sets.sort(byPos).forEach((s) => { strip(s); s.drops.sort(byPos).forEach(strip); s.myo.minis.sort(byPos).forEach(strip); }); });
    return normalizeWorkout(w);
  });
  const merges = table('merges').map((r, i) => {
    let detail = {};
    try { detail = r.detail_json ? JSON.parse(r.detail_json) : {}; } catch (e) { /* keep empty */ }
    return { ...detail, id: need(r.merge_id, `merges.csv row ${i + 2}`), at: iso(r.at), level: r.level, sourceId: r.source_id, targetId: r.target_id, undoneAt: iso(r.undone_at) };
  });
  let settings = null, prefs = null;
  if (files['settings.json']) { try { const s = JSON.parse(text('settings.json')); settings = s.settings || null; prefs = s.prefs || null; } catch (e) { /* ignore */ } }
  return { format: 'zip', exportedAt: manifest.exported_at, exercises: [...ex.values()], activities, workouts, merges, settings, prefs };
}

// v0.5.x flat CSV (names only, no IDs except workout_id). Matches exercises/variants by name.
export function fromLegacyCsv(text, local) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('That CSV file is empty.');
  const cols = Object.keys(rows[0]);
  if (cols.includes('set_id')) throw new Error('This is the spreadsheet copy from a v0.6 backup. Import the whole .zip backup file instead.');
  for (const c of ['workout_id', 'workout_date', 'exercise', 'weight', 'reps']) if (!cols.includes(c)) throw new Error('This CSV is not a Lift Log export (column “' + c + '” is missing).');
  const exByKey = new Map(local.exercises.map((x) => [nameKey(x.name), normalizeExercise(JSON.parse(JSON.stringify(x)))]));
  const touched = new Set();
  const localWorkoutIds = new Set(local.workouts.map((w) => w.id));
  const workouts = new Map();
  const toIso = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s || ''); if (!m) return null; return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).toISOString(); };
  let skipped = 0;
  const entryKey = new Map();
  rows.forEach((r, i) => {
    const wid = isSafeId(r.workout_id) ? r.workout_id : null;
    if (!wid) throw new Error(`CSV row ${i + 2} has a missing or invalid workout_id.`);
    if (localWorkoutIds.has(wid)) { skipped++; return; }
    const date = toIso(r.workout_date);
    if (!date) throw new Error(`CSV row ${i + 2} has no valid workout_date.`);
    let w = workouts.get(wid);
    if (!w) { w = { id: wid, type: 'weights', name: r.workout_name || '', date, endedAt: date, createdAt: date, updatedAt: date, entries: [] }; workouts.set(wid, w); }
    const exName = (r.exercise || '').trim();
    if (!exName) return;
    let x = exByKey.get(nameKey(exName));
    if (!x) { x = normalizeExercise({ name: exName, createdAt: date }); exByKey.set(nameKey(exName), x); }
    let vId = null;
    if ((r.variant || '').trim()) {
      let v = x.variants.find((y) => nameKey(y.name) === nameKey(r.variant));
      if (!v) { v = normalizeVariant({ name: r.variant.trim(), createdAt: date }); x.variants.push(v); }
      vId = v.id;
    }
    touched.add(x.id);
    const ek = `${wid}|${x.id}|${vId}|${r.exercise_note || ''}`;
    let e = entryKey.get(ek);
    if (!e) { e = { id: uid(), kind: 'lift', exerciseId: x.id, variantId: vId, note: r.exercise_note || '', sets: [], _sets: new Map() }; entryKey.set(ek, e); w.entries.push(e); }
    if (r.set_number === '' || r.set_number === undefined) return;
    let s = e._sets.get(r.set_number);
    if (!s) { s = { id: uid(), weight: null, reps: null, types: [], rom: null, rpe: null, drops: [], myo: { target: null, minis: [] }, force: null }; e._sets.set(r.set_number, s); e.sets.push(s); }
    const kind = r.segment_kind || 'base';
    if (kind === 'base') {
      Object.assign(s, { weight: num(r.weight), reps: int(r.reps), types: r.set_types ? r.set_types.split('|') : [], rom: int(r.rom), rpe: int(r.rpe) });
      s.myo.target = int(r.myo_target);
    } else if (kind === 'drop') s.drops.push({ id: uid(), weight: num(r.weight), reps: int(r.reps) });
    else if (kind === 'myo') s.myo.minis.push({ id: uid(), reps: int(r.reps) });
  });
  for (const w of workouts.values()) w.entries.forEach((e) => delete e._sets);
  return {
    format: 'csv', exercises: [...exByKey.values()].filter((x) => touched.has(x.id)),
    activities: [], workouts: [...workouts.values()].map(normalizeWorkout), merges: [], settings: null, prefs: null, skippedRows: skipped
  };
}

export async function readImportFile(file, local) {
  if (file.size > 20 * 1024 * 1024) throw new Error('That file is too large to be a Lift Log backup.');
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4));
  if (head[0] === 0x50 && head[1] === 0x4b) return fromZipFiles(readZip(buf));
  return fromLegacyCsv(new TextDecoder().decode(buf), local);
}

// Compares incoming data with what's on the phone. Nothing is deleted; IDs decide what's "the same record".
export function planImport(local, incoming) {
  // compares content, not field order (records built in the app and from a file list fields differently)
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  const ops = [];
  const summary = { exercises: { new: 0, updated: 0, unchanged: 0 }, activities: { new: 0, updated: 0, unchanged: 0 }, workouts: { new: 0, updated: 0, unchanged: 0 } };
  const tally = (kind, cur, next) => { if (!cur) summary[kind].new++; else if (same(cur, next)) summary[kind].unchanged++; else summary[kind].updated++; };
  const exLocal = new Map(local.exercises.map((x) => [x.id, x]));
  for (const inc of incoming.exercises) {
    const cur = exLocal.get(inc.id);
    let next = inc;
    if (cur) { // keep variants that only exist on the phone
      const ids = new Set(inc.variants.map((v) => v.id));
      next = { ...inc, variants: [...inc.variants, ...cur.variants.filter((v) => !ids.has(v.id))] };
    }
    tally('exercises', cur, next);
    if (!cur || !same(cur, next)) ops.push({ store: 'exercises', put: next });
  }
  const actLocal = new Map(local.activities.map((x) => [x.id, x]));
  for (const inc of incoming.activities) { const cur = actLocal.get(inc.id); tally('activities', cur, inc); if (!cur || !same(cur, inc)) ops.push({ store: 'activities', put: inc }); }
  const woLocal = new Map(local.workouts.map((x) => [x.id, x]));
  for (const inc of incoming.workouts) { const cur = woLocal.get(inc.id); tally('workouts', cur, inc); if (!cur || !same(cur, inc)) ops.push({ store: 'workouts', put: inc }); }
  const mLocal = new Set(local.merges.map((m) => m.id));
  for (const m of incoming.merges) if (!mLocal.has(m.id)) ops.push({ store: 'merges', put: m });
  // possible duplicates: different IDs, same name
  const keys = new Map(local.exercises.map((x) => [nameKey(x.name), x.id]));
  const dupes = incoming.exercises.filter((x) => keys.has(nameKey(x.name)) && keys.get(nameKey(x.name)) !== x.id).map((x) => x.name);
  return { ops, summary, possibleDuplicates: dupes, skippedRows: incoming.skippedRows || 0 };
}
