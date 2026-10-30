'use strict';
// The manuscript's record of review comments dealt with: resolved, a
// suggestion applied or dismissed. Taking one out of its card leaves no
// trace in the cards, so this is what lets a reviewer reading the
// threads see what was settled, and what keeps a pull or a review sent
// again from bringing it back. One JSON object per line, appended, so a
// line is never rewritten, beside the index, so it goes where the
// manuscript goes.

const review = require('./review.js');

const NAME = 'review-log.jsonl';

// Each device appends to its own file in this folder beside the index,
// so two devices never write one file and a sync has nothing to merge;
// the log is all of them read together. The single file older versions
// wrote beside the index is moved in as shared.jsonl, and 0.34.0's
// review-log folder beside the index is read too, until it is moved.
const DIR = '_dendrite/review-log';
const OLD_DIR = 'review-log';
const SHARED = 'shared.jsonl';

/** The log's path for the index at `indexPath`, as one file. */
function logPath(indexPath) {
    const i = indexPath.lastIndexOf('/');
    return i < 0 ? NAME : indexPath.slice(0, i + 1) + NAME;
}

/** The folder of the devices' logs for the index at `indexPath`. */
function logDir(indexPath, dir = DIR) {
    const i = indexPath.lastIndexOf('/');
    return i < 0 ? dir : indexPath.slice(0, i + 1) + dir;
}

/** Each folder a log file of the index at `indexPath` may be in. */
function logDirs(indexPath) {
    return [logDir(indexPath), logDir(indexPath, OLD_DIR)];
}

/** Device `device`'s log for the index at `indexPath`. */
function devicePath(indexPath, device, dir = DIR) {
    const name = String(device).replace(/[^\w.-]+/g, '_') || 'device';
    return `${logDir(indexPath, dir)}/${name}.jsonl`;
}

/**
 * Entries from several logs as one, in time order, an entry in two of
 * them, as when a file was copied, once.
 */
function merge(lists) {
    const seen = new Set();
    const out = [];
    for (const e of lists.flat()) {
        const k = JSON.stringify(e);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(e);
    }
    return out.sort((a, b) => String(a.at || '').localeCompare(
        String(b.at || '')));
}

/**
 * A log entry for review item `it` of card `card`, dealt with by
 * `action`: resolve, apply or dismiss, at `at`, an ISO time.
 */
function entry(it, action, card, at) {
    const { text, url } = review.noteLink(it.text || '');
    return { at, action, card,
             kind: it.kind === 'suggest' ? 'suggestion' : 'comment',
             author: it.author || '', date: it.date || '',
             passage: it.passage || '',
             text: it.kind === 'suggest' ? it.text : text.trim(),
             link: it.kind === 'suggest' ? null : url || null,
             replies: it.replies || [], keys: review.reviewKeys(it) };
}

/** One entry as its line. */
function line(e) {
    return JSON.stringify(e) + '\n';
}

/** The log's entries, a line that is not one left out. */
function parse(text) {
    const out = [];
    for (const l of (text || '').split('\n')) {
        if (!l.trim()) continue;
        try {
            const e = JSON.parse(l);
            if (e && typeof e === 'object') out.push(e);
        } catch (err) {
            // A line cut short, as by a sync mid-write: the rest stand.
        }
    }
    return out;
}

/** Every key the log's entries hold. */
function keysOf(entries) {
    const keys = new Set();
    for (const e of entries) {
        for (const k of Array.isArray(e.keys) ? e.keys : []) keys.add(k);
    }
    return keys;
}

/**
 * The entries a reader is shown: those with a text, the newest for each
 * comment, and not one open again in `openKeys`, as after an undo.
 */
function settled(entries, openKeys = new Set()) {
    const out = new Map();
    for (const e of entries) {
        if (!e.action || e.text === undefined) continue;
        const keys = Array.isArray(e.keys) ? e.keys : [];
        if (keys.some((k) => openKeys.has(k))) continue;
        out.delete(keys[0]);
        out.set(keys[0], e);
    }
    return [...out.values()];
}

module.exports = { NAME, DIR, OLD_DIR, SHARED, logPath, logDir, logDirs,
                   devicePath, merge, entry, line, parse, keysOf,
                   settled };
