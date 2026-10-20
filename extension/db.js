// IndexedDB storage. Everything stays in the user's own browser; nothing is sent anywhere.
// Stores: scripts (one per tracked NetSuite file) and versions (full content of each saved version).
const DB = (() => {
  const NAME = 'ssvg';
  const VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('scripts', { keyPath: 'key' });
        const v = db.createObjectStore('versions', { keyPath: 'id', autoIncrement: true });
        v.createIndex('byScript', 'scriptKey');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbPromise;
  }

  const req = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

  async function tx(stores, mode, fn) {
    const db = await open();
    const t = db.transaction(stores, mode);
    const done = new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    });
    const out = await fn(...stores.map((s) => t.objectStore(s)));
    await done;
    return out;
  }

  return {
    getScript: (key) => tx(['scripts'], 'readonly', (s) => req(s.get(key))),
    putScript: (obj) => tx(['scripts'], 'readwrite', (s) => req(s.put(obj))),
    allScripts: () => tx(['scripts'], 'readonly', (s) => req(s.getAll())),
    addVersion: (ver) => tx(['versions'], 'readwrite', (s) => req(s.add(ver))),
    getVersion: (id) => tx(['versions'], 'readonly', (s) => req(s.get(id))),
    async versionsOf(scriptKey) {
      const all = await tx(['versions'], 'readonly', (s) => req(s.index('byScript').getAll(scriptKey)));
      return all.sort((a, b) => b.no - a.no);
    },
    deleteScript: (key) =>
      tx(['scripts', 'versions'], 'readwrite', async (sc, ve) => {
        sc.delete(key);
        const keys = await req(ve.index('byScript').getAllKeys(key));
        for (const k of keys) ve.delete(k);
      }),
    async exportAll() {
      const scripts = await this.allScripts();
      const versions = await tx(['versions'], 'readonly', (s) => req(s.getAll()));
      return { app: 'suitescript-version-guard', format: 1, exportedAt: new Date().toISOString(), scripts, versions };
    },
  };
})();

if (typeof self !== 'undefined') self.DB = DB;
