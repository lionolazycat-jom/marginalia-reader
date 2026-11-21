// IndexedDB persistence. Book files live in their own store so library listing never loads blobs.
// Falls back to an in-memory store (with a visible warning) when IndexedDB is unavailable.

const DB_NAME = 'marginalia';
const DB_VERSION = 1;
const STORES = {
  books: { keyPath: 'id' },
  files: { keyPath: 'id' },
  covers: { keyPath: 'id' },
  texts: { keyPath: 'id' },          // plain text per book for library content search
  annotations: { keyPath: 'id', indexes: ['bookId'] },
  bookmarks: { keyPath: 'id', indexes: ['bookId'] },
  notes: { keyPath: 'id' },
  collections: { keyPath: 'id' },
  days: { keyPath: 'date' },          // reading log: {date, seconds, books:{id:seconds}}
  kv: { keyPath: 'key' },
};

let dbp = null;
export let persistent = true;
const mem = Object.fromEntries(Object.keys(STORES).map((k) => [k, new Map()]));

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch { persistent = false; return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const s = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const ix of def.indexes || []) s.createIndex(ix, ix);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { persistent = false; resolve(null); };
    req.onblocked = () => { persistent = false; resolve(null); };
  });
  return dbp;
}

function wrap(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  const t = db.transaction(store, mode);
  const s = t.objectStore(store);
  const out = await fn(s);
  if (mode === 'readwrite') await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Transaction aborted')); });
  return out;
}

export const db = {
  async get(store, key) {
    return tx(store, 'readonly', (s) => (s ? wrap(s.get(key)) : structuredCloneSafe(mem[store].get(key))));
  },
  async all(store) {
    return tx(store, 'readonly', (s) => (s ? wrap(s.getAll()) : [...mem[store].values()].map(structuredCloneSafe)));
  },
  async byIndex(store, index, value) {
    return tx(store, 'readonly', (s) => (s ? wrap(s.index(index).getAll(value)) : [...mem[store].values()].filter((v) => v[index] === value)));
  },
  async put(store, value) {
    return tx(store, 'readwrite', (s) => {
      if (!s) { mem[store].set(value[STORES[store].keyPath], value); return value; }
      s.put(value);
      return value;
    });
  },
  async putMany(store, values) {
    return tx(store, 'readwrite', (s) => {
      for (const v of values) s ? s.put(v) : mem[store].set(v[STORES[store].keyPath], v);
    });
  },
  async del(store, key) {
    return tx(store, 'readwrite', (s) => (s ? s.delete(key) : mem[store].delete(key)));
  },
  async delWhere(store, index, value) {
    const rows = await this.byIndex(store, index, value);
    await tx(store, 'readwrite', (s) => { for (const r of rows) s ? s.delete(r.id) : mem[store].delete(r.id); });
    return rows.length;
  },
  async clear(store) {
    return tx(store, 'readwrite', (s) => (s ? s.clear() : mem[store].clear()));
  },
  async kvGet(key, fallback = null) {
    const r = await this.get('kv', key);
    return r ? r.value : fallback;
  },
  async kvSet(key, value) {
    return this.put('kv', { key, value });
  },
  async ready() { await open(); return persistent; },
};

function structuredCloneSafe(v) {
  if (v == null) return v;
  try { return structuredClone(v); } catch { return v; }
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { usage: e.usage || 0, quota: e.quota || 0, persisted };
  } catch { return null; }
}
export async function requestPersistence() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
