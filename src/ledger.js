'use strict';
// What each device's Dendrite meant a card to hold, shared through the
// vault so a device can tell a sync's old copy from a change another
// device made on purpose. Each device writes only its own file, in
// _dendrite/devices beside the manuscript's index, out of the way of the
// manuscript's own notes, so a sync never has two writers for one file.
// 0.34.0 wrote them in devices beside the index: they are read there
// too, and this device's own is moved. For each card it records the
// last text Dendrite wrote there and the last text kept in the compare
// dialog, as hashes, each with when.
//
// A text arriving from outside that matches an older version here is a
// version going back unless another device wrote or kept that text after
// this device's newest version: then it is that device's change, and a
// flag raised before its record arrived is settled by it.

const FLUSH_MS = 3000;
// The folder beside the index for what Dendrite keeps for itself.
const HOME = '_dendrite';

/** A device's name for its file: letters, digits, dot, dash, underscore. */
function fileName(device) {
    return String(device).replace(/[^\w.-]+/g, '_') || 'device';
}

class Ledger {
    /**
     * `vault` is Obsidian's, `device` this device's name, `now` the
     * clock, and `delay` how long writes gather before the file is saved.
     */
    constructor(vault, device, now = () => Date.now(), delay = FLUSH_MS) {
        this.vault = vault;
        this.device = device;
        this.now = now;
        this.delay = delay;
        // Each devices folder: this device's record, and the others'
        // records as last read, or null to read again.
        this.mine = new Map();
        this.theirs = new Map();
        this.dirty = new Set();
        this.timer = null;
    }

    /** The devices folder of the manuscript whose index is `index`. */
    dirOf(index) {
        const parent = index.parent ? index.parent.path : '';
        return (parent && parent !== '/' ? parent + '/' : '') +
            `${HOME}/devices`;
    }

    /** Where 0.34.0 kept the devices folder `dir` now is. */
    oldDirOf(dir) {
        return dir.slice(0, -`${HOME}/devices`.length) + 'devices';
    }

    pathOf(dir) {
        return `${dir}/${fileName(this.device)}.json`;
    }

    async own(dir) {
        if (!this.mine.has(dir)) {
            let rec = null;
            for (const d of [dir, this.oldDirOf(dir)]) {
                try {
                    const f = this.vault.getAbstractFileByPath(
                        this.pathOf(d));
                    if (f) rec = JSON.parse(await this.vault.read(f));
                } catch (err) {
                    rec = null;
                }
                if (rec) break;
            }
            this.mine.set(dir, rec && rec.cards ? rec :
                { device: this.device, cards: {} });
        }
        return this.mine.get(dir);
    }

    async note(index, key, what, h) {
        const dir = this.dirOf(index);
        const rec = await this.own(dir);
        const card = rec.cards[key] = rec.cards[key] || {};
        card[what] = { h, at: this.now() };
        this.dirty.add(dir);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), this.delay);
    }

    /** Dendrite on this device wrote text hashed `h` to card `key`. */
    wrote(index, key, h) {
        return this.note(index, key, 'wrote', h);
    }

    /** The text hashed `h` was kept for card `key` in the compare dialog. */
    kept(index, key, h) {
        return this.note(index, key, 'kept', h);
    }

    /** This device's records saved, each in its folder. */
    async flush() {
        clearTimeout(this.timer);
        this.timer = null;
        const dirs = [...this.dirty];
        this.dirty.clear();
        for (const dir of dirs) {
            const rec = this.mine.get(dir);
            if (!rec) continue;
            const path = this.pathOf(dir);
            const text = JSON.stringify(rec, null, 1) + '\n';
            const f = this.vault.getAbstractFileByPath(path);
            if (f) {
                await this.vault.modify(f, text);
            } else {
                await makeFolders(this.vault, dir);
                await this.vault.create(path, text);
            }
            // Saved here: the copy where 0.34.0 kept it goes, and its
            // folder once empty.
            await moveDone(this.vault, this.pathOf(this.oldDirOf(dir)));
        }
    }

    /** This device's record moved from where 0.34.0 kept it, if there. */
    async tidy(index) {
        const dir = this.dirOf(index);
        if (!this.vault.getAbstractFileByPath(this.pathOf(
            this.oldDirOf(dir)))) return;
        await this.own(dir);
        this.dirty.add(dir);
        await this.flush();
    }

    /** The other devices' records in `dir`, read once until one changes. */
    async others(dir) {
        if (this.theirs.has(dir)) return this.theirs.get(dir);
        const out = [];
        const old = this.oldDirOf(dir);
        const mine = new Set([this.pathOf(dir), this.pathOf(old)]);
        // By path: a folder made by a sync may not be listed as one yet.
        const within = (d) => (f) => f.path.startsWith(d + '/') &&
            !f.path.slice(d.length + 1).includes('/');
        const here = this.vault.getFiles().filter((f) =>
            within(dir)(f) || within(old)(f));
        for (const f of here) {
            if (mine.has(f.path) || !f.path.endsWith('.json')) continue;
            try {
                const rec = JSON.parse(await this.vault.read(f));
                if (rec && rec.cards) out.push(rec);
            } catch (err) {
                // Half arrived: read again when it changes.
            }
        }
        this.theirs.set(dir, out);
        return out;
    }

    /**
     * Whether another device wrote or kept the text hashed `h` for card
     * `key` after `since`, this device's newest version of it.
     */
    async vouches(index, key, h, since) {
        for (const rec of await this.others(this.dirOf(index))) {
            const c = rec.cards[key];
            if (!c) continue;
            for (const x of [c.wrote, c.kept]) {
                if (x && x.h === h && x.at > since) return true;
            }
        }
        return false;
    }

    /**
     * A file changed in the vault: if it is another device's record, it
     * is read again; answers whether it was one.
     */
    changed(path) {
        const m = /^(.*?\/)?(?:_dendrite\/)?devices\/[^/]+\.json$/
            .exec(path);
        if (!m) return false;
        const dir = (m[1] || '') + `${HOME}/devices`;
        if (path === this.pathOf(dir) ||
            path === this.pathOf(this.oldDirOf(dir))) return false;
        this.theirs.delete(dir);
        return true;
    }
}

/** Folder `dir` made, with the folders above it it needs. */
async function makeFolders(vault, dir) {
    const parts = dir.split('/');
    for (let k = 1; k <= parts.length; k++) {
        const d = parts.slice(0, k).join('/');
        if (vault.getAbstractFileByPath(d)) continue;
        try {
            await vault.createFolder(d);
        } catch (err) {
            // Made meanwhile, or by a sync.
        }
    }
}

/**
 * A file at `path` that now has a copy elsewhere taken out, and its
 * folder with it once nothing is left in it.
 */
async function moveDone(vault, path) {
    const f = vault.getAbstractFileByPath(path);
    if (!f) return;
    await vault.delete(f);
    const dir = path.slice(0, path.lastIndexOf('/'));
    const left = vault.getFiles().some((x) => x.path.startsWith(dir + '/'));
    const folder = vault.getAbstractFileByPath(dir);
    if (!left && folder) {
        try {
            await vault.delete(folder, true);
        } catch (err) {
            // Something arrived in it meanwhile: it stays.
        }
    }
}

module.exports = { Ledger, fileName, makeFolders, moveDone, HOME,
                   FLUSH_MS };
