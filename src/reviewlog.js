'use strict';
// The manuscript's record of review comments dealt with: resolved, a
// suggestion applied or dismissed. Taking one out of its card leaves no
// trace in the cards, so this is what lets a reviewer reading the
// threads see what was settled, and what keeps a pull or a review sent
// again from bringing it back. One JSON object per line, appended, in
// review-log.jsonl beside the index, so it goes where the manuscript
// goes and a line is never rewritten.

const review = require('./review.js');

const NAME = 'review-log.jsonl';

/** The log's path for the index at `indexPath`. */
function logPath(indexPath) {
    const i = indexPath.lastIndexOf('/');
    return i < 0 ? NAME : indexPath.slice(0, i + 1) + NAME;
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

module.exports = { NAME, logPath, entry, line, parse, keysOf, settled };
