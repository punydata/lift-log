// On-device storage (IndexedDB). Nothing here ever leaves the phone.
import { normalizeExercise, normalizeWorkout, SCHEMA_VERSION, uid as makeId } from './model.js';

const DB_NAME = (self.LIFTLOG_ENV && self.LIFTLOG_ENV.DB_NAME) || 'liftlog';
const DB_VERSION = 2;
export const STORES = ['exercises', 'workouts', 'activities', 'merges', 'meta'];
let dbPromise;

// Version 1 → 2 (app v0.6.0). Runs once, inside the browser's upgrade transaction:
// if anything fails, the whole upgrade is rolled back and the old data stays as it was.
function upgrade(d, tx, oldVersion) {
  if (!d.objectStoreNames.contains('exercises')) d.createObjectStore('exercises', { keyPath: 'id' });
  if (!d.objectStoreNames.contains('workouts')) d.createObjectStore('workouts', { keyPath: 'id' });
  if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
  if (!d.objectStoreNames.contains('activities')) d.createObjectStore('activities', { keyPath: 'id' });
  if (!d.objectStoreNames.contains('merges')) d.createObjectStore('merges', { keyPath: 'id' });
  if (oldVersion >= 1 && oldVersion < 2) {
    // Safety copy of every record exactly as it was, kept until a later update removes it.
    const snap = d.objectStoreNames.contains('pre_v2_snapshot') ? tx.objectStore('pre_v2_snapshot') : d.createObjectStore('pre_v2_snapshot', { keyPath: 'key' });
    const at = new Date().toISOString();
    const each = (name, fn) => { tx.objectStore(name).openCursor().onsuccess = (ev) => { const c = ev.target.result; if (c) { fn(c); c.continue(); } }; };
    each('exercises', (c) => { snap.put({ key: 'exercises:' + c.value.id, store: 'exercises', at, value: c.value }); c.update(normalizeExercise(c.value)); });
    each('workouts', (c) => { snap.put({ key: 'workouts:' + c.value.id, store: 'workouts', at, value: c.value }); c.update(normalizeWorkout(c.value)); });
    each('meta', (c) => { if (c.value.key !== 'schema') snap.put({ key: 'meta:' + c.value.key, store: 'meta', at, value: c.value }); });
  }
  tx.objectStore('meta').put({ key: 'schema', value: { version: SCHEMA_VERSION, upgradedAt: new Date().toISOString(), from: oldVersion } });
}

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = (ev) => upgrade(r.result, r.transaction, ev.oldVersion);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('Close other open copies of Lift Log, then reopen the app.'));
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const clone = (v) => JSON.parse(JSON.stringify(v));
export const getAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const get = (store, id) => run(store, 'readonly', (s) => s.get(id));
// Values are cloned before saving so in-memory objects can keep changing safely.
export const put = (store, value) => run(store, 'readwrite', (s) => s.put(clone(value)));
export const remove = (store, id) => run(store, 'readwrite', (s) => s.delete(id));

// Several writes that must all happen or none at all (merge, undo, import).
// ops: [{ store, put: value } | { store, del: id } | { store, clear: true }]
export function batch(ops) {
  const stores = [...new Set(ops.map((o) => o.store))];
  if (!stores.length) return Promise.resolve();
  return open().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(stores, 'readwrite');
    for (const o of ops) {
      const s = t.objectStore(o.store);
      if (o.clear) s.clear();
      else if (o.del !== undefined) s.delete(o.del);
      else s.put(clone(o.put));
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Save was cancelled'));
  }));
}

export const uid = makeId;

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (e) { /* not critical */ }
}
