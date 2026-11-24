// Data shapes, upgrades from older shapes, and name matching.
// Pure functions only (no screen or storage code), so they can be shared by
// the database upgrade, the import, and the app itself.

export const SCHEMA_VERSION = 2;

export function uid() {
  if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
export const nowIso = () => new Date().toISOString();

// IDs we accept from imported files: letters, digits, "-" and "_" only.
export const isSafeId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);

const numOrNull = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
const intOrNull = (v) => { const n = numOrNull(v); return n === null ? null : Math.round(n); };

// ---------- normalizers: accept the v1 (v0.5.x) shape or the v2 shape, return v2 ----------
export function normalizeExercise(x) {
  const created = x.createdAt || nowIso();
  return {
    id: x.id || uid(),
    name: String(x.name ?? '').trim() || 'Unnamed',
    hidden: x.hidden !== undefined ? !!x.hidden : !!x.archived,
    createdAt: created,
    updatedAt: x.updatedAt || created,
    lastUsed: x.lastUsed || null,
    variants: (x.variants || []).map((v) => normalizeVariant(v, created))
  };
}
export function normalizeVariant(v, fallbackDate) {
  const created = v.createdAt || fallbackDate || nowIso();
  return {
    id: v.id || uid(),
    name: String(v.name ?? '').trim() || 'Unnamed',
    hidden: v.hidden !== undefined ? !!v.hidden : !!v.archived,
    createdAt: created,
    updatedAt: v.updatedAt || created
  };
}
export function normalizeActivity(a) {
  const created = a.createdAt || nowIso();
  return { id: a.id || uid(), name: String(a.name ?? '').trim() || 'Unnamed', hidden: !!a.hidden, createdAt: created, updatedAt: a.updatedAt || created };
}
export function normalizeSet(s) {
  const minis = ((s.myo && s.myo.minis) || []).map((m) => (m && typeof m === 'object' ? { id: m.id || uid(), reps: intOrNull(m.reps) } : { id: uid(), reps: intOrNull(m) }));
  const f = s.force;
  return {
    id: s.id || uid(),
    weight: numOrNull(s.weight),
    reps: intOrNull(s.reps),
    types: Array.isArray(s.types) ? s.types.map(String) : [],
    rom: intOrNull(s.rom),
    rpe: intOrNull(s.rpe),
    drops: (s.drops || []).map((d) => ({ id: d.id || uid(), weight: numOrNull(d.weight), reps: intOrNull(d.reps) })),
    myo: { target: intOrNull(s.myo && s.myo.target), minis },
    force: f && typeof f === 'object' ? { id: f.id || uid(), reps: intOrNull(f.reps) } : null
  };
}
export function normalizeEntry(e) {
  if (e.kind === 'cardio') {
    return { id: e.id || uid(), kind: 'cardio', activityId: e.activityId || null, minutes: intOrNull(e.minutes), miles: numOrNull(e.miles), calories: intOrNull(e.calories), note: String(e.note ?? '') };
  }
  return { id: e.id || uid(), kind: 'lift', exerciseId: e.exerciseId || null, variantId: e.variantId || null, note: String(e.note ?? ''), sets: (e.sets || []).map(normalizeSet) };
}
export function normalizeWorkout(w) {
  const created = w.createdAt || w.date || nowIso();
  return {
    id: w.id || uid(),
    type: w.type === 'cardio' ? 'cardio' : 'weights',
    name: String(w.name ?? ''),
    date: w.date || created,
    endedAt: w.endedAt || null,
    createdAt: created,
    updatedAt: w.updatedAt || created,
    entries: (w.entries || []).map(normalizeEntry)
  };
}

// ---------- name matching (duplicate check) ----------
function singular(word) {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (/(sses|ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}
// "Pull-Ups", "pull ups", "Pullup" → "pullup". Words are kept for order-insensitive checks.
export function nameWords(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(singular);
}
export const nameKey = (s) => singular(nameWords(s).join('')); // "Pull Ups" → "pullup"

// Optimal string alignment distance (Levenshtein + swapped neighbours).
function osa(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}
// Close (but not exact) match: a typo-level difference, or the same words in another order.
export function isClose(a, b) {
  const ka = nameKey(a), kb = nameKey(b);
  if (!ka || !kb || ka === kb) return false;
  const wa = nameWords(a).slice().sort().join(' '), wb = nameWords(b).slice().sort().join(' ');
  if (wa === wb) return true;
  const len = Math.max(ka.length, kb.length);
  if (len < 5) return false;
  return 1 - osa(ka, kb) / len >= 0.85;
}
// items: [{id, name, hidden}]. Returns the exact match (if any) and up to 3 close ones.
export function findNameMatches(items, name, selfId) {
  const key = nameKey(name);
  const pool = items.filter((x) => x.id !== selfId);
  const exact = pool.find((x) => nameKey(x.name) === key) || null;
  const close = exact ? [] : pool.filter((x) => isClose(x.name, name)).slice(0, 3);
  return { exact, close };
}

// ---------- weeks (calendar + streak) ----------
export function startOfWeek(d, weekStart) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = weekStart === 'sun' ? x.getDay() : (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - offset);
  return x;
}
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// Consecutive weeks (ending this week or last week) that have at least one workout.
export function weeklyStreak(workoutDates, weekStart, today = new Date()) {
  const weeks = new Set(workoutDates.map((iso) => dayKey(startOfWeek(new Date(iso), weekStart))));
  let wk = startOfWeek(today, weekStart);
  const thisWeekDone = weeks.has(dayKey(wk));
  if (!thisWeekDone) wk = addDays(wk, -7); // an empty current week doesn't break the streak until it ends
  let n = 0;
  while (weeks.has(dayKey(wk))) { n++; wk = addDays(wk, -7); }
  return { weeks: n, thisWeekDone };
}
