'use strict';
// Each card's recent versions on this device, so that a sync putting back
// one of them can be noticed. Kept in the browser's IndexedDB, which sync
// plugins do not copy, rather than in the vault or the plugin's data.json,
// which LiveSync does; and only hashes, with the full text of the newest
// version alone, to offer back.
//
// A version is recorded at most once per window: saves while typing
// replace the window's entry, so the list spans days rather than seconds.
// A text arriving from outside Dendrite whose hash is an older entry, and
// not the newest, is a version going back. Each entry also says when it
// was last seen and whether it came from outside, so the choice offered
// can say where each side came from.

const KEEP = 20;
const WINDOW_MS = 10 * 60 * 1000;

/** cyrb53: a quick 53-bit string hash; collisions do not matter here. */
function hash(s) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
        Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
        Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function memoryStore() {
    const m = new Map();
    return {
        async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; },
        async set(k, v) { m.set(k, structuredClone(v)); },
    };
}

/** A key-value store in IndexedDB, or in memory where there is none. */
function idbStore(name = 'dendrite-history') {
    const idb = typeof indexedDB !== 'undefined' ? indexedDB : null;
    if (!idb) return memoryStore();
    let db = null;
    const open = () => db || (db = new Promise((resolve, reject) => {
        const req = idb.open(name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('cards');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    }));
    const run = async (mode, fn) => {
        const d = await open();
        return new Promise((resolve, reject) => {
            const tx = d.transaction('cards', mode);
            const req = fn(tx.objectStore('cards'));
            tx.oncomplete = () => resolve(req.result);
            tx.onerror = () => reject(tx.error);
        });
    };
    return {
        async get(k) {
            const v = await run('readonly', (s) => s.get(k));
            return v === undefined ? null : v;
        },
        async set(k, v) { await run('readwrite', (s) => s.put(v, k)); },
    };
}

class History {
    constructor(store = memoryStore(), now = () => Date.now()) {
        this.store = store;
        this.now = now;
        // One record at a time per key: events for one card can overlap.
        this.queue = new Map();
    }

    serial(key, fn) {
        const prev = this.queue.get(key) || Promise.resolve();
        const next = prev.then(fn, fn);
        this.queue.set(key, next.catch(() => {}));
        return next;
    }

    /**
     * Record a card's text, compared by `compared` (its body, so a status
     * change alone is not a version). `outside` means Dendrite did not
     * write it. Returns 'reverted' when an outside text matches an older
     * version, else null.
     */
    observe(key, text, compared, outside) {
        return this.serial(key, async () => {
            const h = hash(compared);
            const rec = (await this.store.get(key)) ||
                { versions: [], text: null, reverted: null };
            const v = rec.versions;
            const last = v[v.length - 1];
            if (rec.reverted) {
                // Back to the newest text, by any route: settled.
                if (last && last.h === h) {
                    rec.reverted = null;
                    rec.text = text;
                    await this.store.set(key, rec);
                }
                return rec.reverted ? 'reverted' : null;
            }
            if (last && last.h === h) {
                if (rec.text !== text) {
                    rec.text = text;
                    await this.store.set(key, rec);
                }
                return null;
            }
            if (outside && v.slice(0, -1).some((x) => x.h === h)) {
                rec.reverted = { h, at: this.now() };
                await this.store.set(key, rec);
                return 'reverted';
            }
            const t = this.now();
            const o = !!outside;
            if (last && t - last.t < WINDOW_MS) {
                Object.assign(last, { h, s: t, o });
            }
            else v.push({ h, t, s: t, o });
            if (v.length > KEEP) v.splice(0, v.length - KEEP);
            rec.text = text;
            await this.store.set(key, rec);
            return null;
        });
    }

    /** The newest text recorded for a card gone back, else null. */
    async newer(key) {
        const rec = await this.store.get(key);
        return rec && rec.reverted ? rec.text : null;
    }

    /**
     * For a card gone back: the newest text recorded, with where and when
     * the newest version and the matched earlier one were seen. Null
     * when the card has not gone back.
     */
    async detail(key) {
        const rec = await this.store.get(key);
        if (!rec || !rec.reverted) return null;
        const v = rec.versions;
        const seen = (x) => x && { at: x.s || x.t, outside: x.o };
        const match = [...v].reverse().find((x) => x.h === rec.reverted.h);
        return { text: rec.text, before: seen(v[v.length - 1]),
                 now: seen(match) };
    }

    /**
     * A note renamed: its versions follow it to `key` from `from`, unless
     * `key` has its own already.
     */
    adopt(key, from) {
        return this.serial(key, async () => {
            if (key === from || await this.store.get(key)) return;
            const rec = await this.store.get(from);
            if (rec) await this.store.set(key, rec);
        });
    }

    /** Accept the card's current text as its newest version. */
    keep(key, text, compared) {
        return this.serial(key, async () => {
            const rec = await this.store.get(key);
            if (!rec) return;
            rec.reverted = null;
            const t = this.now();
            rec.versions.push({ h: hash(compared), t, s: t, o: true });
            if (rec.versions.length > KEEP) {
                rec.versions.splice(0, rec.versions.length - KEEP);
            }
            rec.text = text;
            await this.store.set(key, rec);
        });
    }
}

module.exports = { History, hash, memoryStore, idbStore, KEEP, WINDOW_MS };
