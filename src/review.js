'use strict';
// Review comments brought back from a returned Word file. A comment or a
// suggested change is written into the card it falls in, after the
// passage it is on:
//
//   ==passage==%%[!review] Author, 2026-10-23: the comment%%
//   ==old text==%%[!suggest] Author, 2026-10-23: new text%%
//
// so it travels with the card's text, is hidden by Obsidian as a
// comment, and is left out of export. Nothing here touches Obsidian or
// the file system: the .docx arrives as a Buffer, cards as text.

const docx = require('./docx.js');

// ---- Reading a .docx ---------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

function decode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
        if (e[0] === '#') {
            const n = e[1] === 'x' || e[1] === 'X' ?
                parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return String.fromCodePoint(n);
        }
        return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
    });
}

function attr(attrs, name) {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
    return m ? decode(m[1]) : null;
}

/** Each tag and run of text in an XML string, in order. */
function* tokens(xml) {
    const re = /<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(xml))) {
        if (m[5] !== undefined) yield { text: m[5] };
        else {
            yield { close: !!m[1], name: m[2], attrs: m[3],
                    empty: !!m[4] };
        }
    }
}

const day = (iso) => (iso ? iso.slice(0, 10) : '');

/**
 * Word's body as paragraphs of the text the reviewer was sent: deleted
 * text kept, inserted text left out, so it can be looked for in the
 * cards. Each paragraph records its tracked changes as offsets into that
 * text, and comments as positions { p, o }.
 */
function readBody(xml) {
    const paras = [];
    const ranges = new Map();
    let para = null;
    let ins = null;
    let del = null;
    let inText = false;
    const pos = () => ({ p: paras.length, o: para ? para.text.length : 0 });
    const addText = (t) => {
        if (!para) return;
        if (ins) {
            const last = para.changes[para.changes.length - 1];
            const at = para.text.length;
            if (last && last.author === ins.author && last.end === at) {
                last.insert += t;
            } else {
                para.changes.push({ start: at, end: at, insert: t,
                                    author: ins.author, date: ins.date });
            }
            return;
        }
        const start = para.text.length;
        para.text += t;
        if (del) {
            const last = para.changes[para.changes.length - 1];
            if (last && last.author === del.author && last.end === start &&
                !last.insert) {
                last.end = para.text.length;
            } else {
                para.changes.push({ start, end: para.text.length,
                                    insert: '', author: del.author,
                                    date: del.date });
            }
        }
    };
    for (const tk of tokens(xml)) {
        if (tk.text !== undefined) {
            if (inText) addText(decode(tk.text));
            continue;
        }
        const { name, close, empty, attrs } = tk;
        if (name === 'w:p') {
            if (close) {
                if (para) paras.push(para);
                para = null;
            } else if (!empty) {
                para = { text: '', changes: [] };
            }
        } else if (name === 'w:ins' || name === 'w:moveTo') {
            if (!empty) {
                ins = close ? null : { author: attr(attrs, 'w:author'),
                                       date: day(attr(attrs, 'w:date')) };
            }
        } else if (name === 'w:del' || name === 'w:moveFrom') {
            if (!empty) {
                del = close ? null : { author: attr(attrs, 'w:author'),
                                       date: day(attr(attrs, 'w:date')) };
            }
        } else if (name === 'w:t' || name === 'w:delText') {
            inText = !close && !empty;
        } else if ((name === 'w:tab' || name === 'w:br') && !close) {
            addText(name === 'w:tab' ? '\t' : ' ');
        } else if (name === 'w:commentRangeStart' ||
                   name === 'w:commentRangeEnd') {
            const id = attr(attrs, 'w:id');
            const r = ranges.get(id) || {};
            r[name === 'w:commentRangeStart' ? 'start' : 'end'] = pos();
            ranges.set(id, r);
        } else if (name === 'w:commentReference') {
            const id = attr(attrs, 'w:id');
            const r = ranges.get(id) || {};
            if (!r.start) r.start = pos();
            if (!r.end) r.end = pos();
            ranges.set(id, r);
        }
    }
    // A deletion straight before an insertion by the same reviewer is
    // one replacement.
    for (const p of paras) {
        const out = [];
        for (const c of p.changes) {
            const last = out[out.length - 1];
            if (last && !last.insert && c.start === c.end &&
                c.start === last.end && c.author === last.author) {
                last.insert = c.insert;
            } else {
                out.push(c);
            }
        }
        p.changes = out;
    }
    return { paras, ranges };
}

/** Word's comments, by id: { author, date, text }. */
function readComments(xml) {
    const out = new Map();
    let cur = null;
    let inText = false;
    let paras = [];
    for (const tk of tokens(xml || '')) {
        if (tk.text !== undefined) {
            if (cur && inText) {
                paras[paras.length - 1] += decode(tk.text);
            }
            continue;
        }
        if (tk.name === 'w:comment') {
            if (tk.close) {
                out.set(cur.id, { author: cur.author, date: cur.date,
                                  text: paras.map((x) => x.trim())
                                      .filter(Boolean).join(' ') });
                cur = null;
            } else {
                cur = { id: attr(tk.attrs, 'w:id'),
                        author: attr(tk.attrs, 'w:author'),
                        date: day(attr(tk.attrs, 'w:date')) };
                paras = [];
            }
        } else if (tk.name === 'w:p' && cur && !tk.close) {
            paras.push('');
        } else if (tk.name === 'w:t') {
            inText = !tk.close && !tk.empty;
        }
    }
    return out;
}

const CONTEXT = 60;

/**
 * Everything a returned .docx says about its text, in reading order:
 * comments { kind: 'comment', author, date, text, quote, before, after }
 * and tracked changes { kind: 'change', author, date, quote, insert,
 * before, after }, where `quote` is the passage as the reviewer was sent
 * it and `before` and `after` the text around it in its paragraph.
 */
function readReview(buf, zlib) {
    const files = new Map(docx.readZip(buf, zlib)
        .map((f) => [f.name, f.data.toString('utf8')]));
    const body = files.get('word/document.xml');
    if (!body) throw new Error('not a Word document');
    const { paras, ranges } = readBody(body);
    const notes = readComments(files.get('word/comments.xml'));
    const items = [];
    for (const [id, note] of notes) {
        const r = ranges.get(id);
        if (!r || !r.start || !paras[r.start.p]) continue;
        const end = r.end && paras[r.end.p] ? r.end : r.start;
        let quote = '';
        if (end.p === r.start.p) {
            quote = paras[r.start.p].text.slice(r.start.o, end.o);
        } else {
            const parts = [paras[r.start.p].text.slice(r.start.o)];
            for (let k = r.start.p + 1; k < end.p; k++) {
                parts.push(paras[k].text);
            }
            parts.push(paras[end.p].text.slice(0, end.o));
            quote = parts.join('\n');
        }
        const sp = paras[r.start.p].text;
        const ep = paras[end.p].text;
        items.push({ kind: 'comment', author: note.author, date: note.date,
                     text: note.text, quote,
                     before: sp.slice(Math.max(0, r.start.o - CONTEXT),
                                      r.start.o),
                     after: ep.slice(end.o, end.o + CONTEXT),
                     at: [r.start.p, r.start.o] });
    }
    paras.forEach((p, k) => {
        for (const c of p.changes) {
            items.push({ kind: 'change', author: c.author, date: c.date,
                         quote: p.text.slice(c.start, c.end),
                         insert: c.insert,
                         before: p.text.slice(Math.max(0, c.start - CONTEXT),
                                              c.start),
                         after: p.text.slice(c.end, c.end + CONTEXT),
                         at: [k, c.start] });
        }
    });
    items.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
    return items;
}

// ---- The printed text of a card ----------------------------------------

/**
 * A card's text as it prints, roughly, with each character's offset in
 * the card's markdown: markup, comments, citations and footnote marks
 * left out, links as their text. Only for finding a passage; export
 * itself does not use it.
 */
function plainMap(md) {
    let text = '';
    const map = [];
    const keep = (from, to) => {
        for (let k = from; k < to; k++) {
            text += md[k];
            map.push(k);
        }
    };
    const skipBracket = (i) => {
        // From an opening [, past its matching ].
        let depth = 0;
        for (let k = i; k < md.length; k++) {
            if (md[k] === '[') depth++;
            else if (md[k] === ']' && --depth === 0) return k + 1;
        }
        return md.length;
    };
    let i = 0;
    let lineStart = true;
    while (i < md.length) {
        if (lineStart) {
            const rest = md.slice(i);
            const line = /^[^\n]*/.exec(rest)[0];
            if (/^\s*\|?\s*:?-{3,}/.test(line) && /\|/.test(line) ||
                /^\[\^[^\]]+\]:/.test(line)) {
                i += line.length;
                continue;
            }
            // Heading, quote, list and task markers.
            const lead = new RegExp('^(\\s*(?:#{1,6}\\s+|>\\s?|' +
                '[-*+]\\s+(?:\\[.\\]\\s+)?|\\d+[.)]\\s+))+').exec(line);
            if (lead) i += lead[0].length;
            lineStart = false;
            continue;
        }
        const c = md[i];
        if (c === '\n') {
            keep(i, i + 1);
            i++;
            lineStart = true;
            continue;
        }
        if (md.startsWith('%%', i)) {
            const end = md.indexOf('%%', i + 2);
            i = end < 0 ? md.length : end + 2;
            continue;
        }
        if (md.startsWith('[[', i)) {
            const end = md.indexOf(']]', i);
            if (end > 0) {
                const inner = md.slice(i + 2, end);
                const bar = inner.lastIndexOf('|');
                const shown = bar >= 0 ? i + 2 + bar + 1 : i + 2;
                const hash = bar >= 0 ? -1 : inner.indexOf('#');
                keep(shown, hash >= 0 ? i + 2 + hash : end);
                i = end + 2;
                continue;
            }
        }
        if (md.startsWith('^[', i)) {
            i = skipBracket(i + 1);
            continue;
        }
        if (c === '[' && (md[i + 1] === '@' || md[i + 1] === '^' ||
                          /^\[-?@/.test(md.slice(i, i + 3)))) {
            i = skipBracket(i);
            continue;
        }
        if (c === '[') {
            const close = skipBracket(i);
            if (md[close] === '(') {
                const end = md.indexOf(')', close);
                const inner = plainMap(md.slice(i + 1, close - 1));
                for (let k = 0; k < inner.text.length; k++) {
                    text += inner.text[k];
                    map.push(i + 1 + inner.map[k]);
                }
                i = end < 0 ? md.length : end + 1;
                continue;
            }
        }
        if (c === '\\' && i + 1 < md.length) {
            keep(i + 1, i + 2);
            i += 2;
            continue;
        }
        if (c === '<') {
            const end = md.indexOf('>', i);
            if (end > 0 && /^<\/?[a-z]/i.test(md.slice(i, i + 3))) {
                i = end + 1;
                continue;
            }
        }
        if ('*`~='.includes(c)) {
            i++;
            continue;
        }
        if (c === '_' && !(/\w/.test(md[i - 1] || '') &&
                           /\w/.test(md[i + 1] || ''))) {
            i++;
            continue;
        }
        if (c === '|') {
            text += ' ';
            map.push(i);
            i++;
            continue;
        }
        keep(i, i + 1);
        i++;
    }
    return { text, map };
}

// ---- Finding a passage in the cards ------------------------------------

const QUOTES = { '‘': '\'', '’': '\'', '“': '"', '”': '"', '–': '-',
                 '—': '-', ' ': ' ' };

/** Text for comparing, with each character's offset in the original. */
function normalise(s) {
    let out = '';
    const map = [];
    let space = true;
    for (let k = 0; k < s.length; k++) {
        let c = QUOTES[s[k]] || s[k];
        if (/\s/.test(c)) {
            if (space) continue;
            c = ' ';
            space = true;
        } else {
            space = false;
        }
        out += c.toLowerCase();
        map.push(k);
    }
    if (out.endsWith(' ')) {
        out = out.slice(0, -1);
        map.pop();
    }
    return { text: out, map };
}

const words = (s) => {
    const out = [];
    const re = /[\p{L}\p{N}]+/gu;
    let m;
    while ((m = re.exec(s))) out.push({ w: m[0], at: m.index });
    return out;
};

/** Common words in order: the length, and which `b` index matched each `a`. */
function lcs(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 :
                Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const match = new Array(n).fill(-1);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            match[i] = j;
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return { length: dp[0][0], match };
}

const tail = (s, n) => s.slice(Math.max(0, s.length - n));

/**
 * Where a passage is in the cards: { id, start, end, how } with offsets
 * into the card's markdown, `how` 'exact' when the passage was found as
 * it was sent and 'close' when only most of its words were; or null.
 * `cards` is [{ id, text }]. A point comment (no passage) is placed
 * after the text before it.
 */
function locate(item, cards) {
    const prepared = cards.map((c) => {
        const plain = plainMap(c.text);
        const norm = normalise(plain.text);
        return { id: c.id, plain, norm,
                 src: (k) => plain.map[norm.map[k]] };
    });
    const quote = normalise(item.quote || '').text;
    const before = normalise(item.before || '').text;
    const after = normalise(item.after || '').text;
    // Exact: the passage as sent, the context deciding between copies.
    const found = [];
    const probe = quote || tail(before, 30);
    if (probe.length >= 3) {
        for (const c of prepared) {
            let k = c.norm.text.indexOf(probe);
            while (k >= 0) {
                const s = quote ? k : k + probe.length;
                const e = quote ? k + probe.length : s;
                let score = 0;
                const pre = c.norm.text.slice(0, s);
                const post = c.norm.text.slice(e);
                const b = before.trimEnd();
                const a = after.trimStart();
                while (score < b.length &&
                       pre.trimEnd()[pre.trimEnd().length - 1 - score] ===
                       b[b.length - 1 - score]) score++;
                let sa = 0;
                while (sa < a.length && post.trimStart()[sa] === a[sa]) sa++;
                found.push({ c, s, e, score: score + sa });
                k = c.norm.text.indexOf(probe, k + 1);
            }
        }
    }
    if (found.length) {
        found.sort((x, y) => y.score - x.score);
        const best = found[0];
        if (found.length === 1 || best.score > found[1].score) {
            return place(best.c, best.s, best.e, 'exact');
        }
    }
    // Close: most of the words of the passage and its context, in order.
    const qw = words(quote);
    const bw = words(before).slice(-8);
    const aw = words(after).slice(0, 8);
    const query = [...bw, ...qw, ...aw].map((x) => x.w);
    if (query.length < 3) return null;
    const scored = prepared.map((c) => {
        const cw = words(c.norm.text);
        const r = lcs(query, cw.map((x) => x.w));
        return { c, cw, r, score: r.length / query.length };
    }).sort((x, y) => y.score - x.score);
    const best = scored[0];
    const next = scored[1];
    if (!best || best.score < 0.6 ||
        (next && best.score - next.score < 0.15)) {
        return null;
    }
    const inQuote = best.r.match.slice(bw.length, bw.length + qw.length)
        .filter((j) => j >= 0);
    if (qw.length && inQuote.length >= Math.ceil(qw.length / 2)) {
        const first = best.cw[inQuote[0]];
        const last = best.cw[inQuote[inQuote.length - 1]];
        return place(best.c, first.at, last.at + last.w.length, 'close');
    }
    // The passage is gone: after the last word of the text before it.
    const pre = best.r.match.slice(0, bw.length).filter((j) => j >= 0);
    if (!pre.length) return null;
    const w = best.cw[pre[pre.length - 1]];
    return place(best.c, w.at + w.w.length, w.at + w.w.length, 'close');
}

function place(c, s, e, how) {
    // Offsets in the normalised text back to the card's markdown.
    const start = s < c.norm.map.length ? c.src(s) :
        c.plain.map[c.plain.map.length - 1] + 1;
    const end = e > s ? c.src(e - 1) + 1 : start;
    return { id: c.id, start, end: e > s ? end : start, how };
}

// ---- Review comments in a card's text ----------------------------------

const ITEM = /(?:==([^=\n]+?)==)?%%\[!(review|suggest)\]\s*([\s\S]*?)%%/g;
const HEAD = /^(.*?),\s*(\d{4}-\d{2}-\d{2}):\s?([\s\S]*)$/;

/**
 * The review comments in a card's markdown, in order: { kind: 'review'
 * or 'suggest', passage, author, date, text, start, end }, with the
 * offsets of the whole of it, highlight included.
 */
function reviewItems(md) {
    const out = [];
    ITEM.lastIndex = 0;
    let m;
    while ((m = ITEM.exec(md))) {
        const h = HEAD.exec(m[3].replace(/^\s+/, ''));
        out.push({ kind: m[2], passage: m[1] || '',
                   author: h ? h[1] : '', date: h ? h[2] : '',
                   text: h ? (m[2] === 'suggest' ? h[3] : h[3].trim()) :
                       m[3].trim(),
                   start: m.index, end: m.index + m[0].length });
    }
    return out;
}

/**
 * A comment's text for inside %% %%: one line, no %%. A suggestion's
 * text keeps the spaces at its ends, which are part of what it puts in.
 */
const clean = (s, edges = false) => {
    const t = String(s || '').replace(/%%/g, '%')
        .replace(/\s*\n\s*/g, ' ');
    return edges ? t : t.trim();
};

/**
 * A comment or suggestion as card markdown, on `passage` if one is
 * given. A suggestion's text is the new text for the passage.
 */
function itemText(kind, passage, author, date, text) {
    const note = `%%[!${kind}] ${clean(author) || 'Reviewer'}, ${date}: ` +
        `${clean(text, kind === 'suggest')}%%`;
    return passage ? `==${passage}==${note}` : note;
}

/**
 * Whether markdown between two offsets can be highlighted as it is: on
 * one line, with no highlight, comment or unbalanced markup in it.
 */
function canHighlight(md, s, e) {
    const t = md.slice(s, e);
    if (!t || /\n|==|%%/.test(t)) return false;
    const count = (re) => (t.match(re) || []).length;
    return count(/\*\*/g) % 2 === 0 && count(/`/g) % 2 === 0 &&
        count(/\[\[/g) === count(/\]\]/g) && count(/\[/g) === count(/\]/g);
}

/**
 * A card's markdown with comments added: `adds` is [{ kind, start, end,
 * author, date, text }] at offsets in `md`. Where the passage cannot be
 * highlighted as it is, the comment goes after it with no highlight, and
 * a suggestion quotes the passage it was on.
 */
function addItems(md, adds) {
    const sorted = [...adds].sort((a, b) => b.end - a.end ||
                                            b.start - a.start);
    let out = md;
    for (const a of sorted) {
        const lit = a.end > a.start && canHighlight(out, a.start, a.end);
        // A suggestion on a passage that cannot be marked can no longer
        // be applied safely, so it is kept as a comment saying what it
        // was; one at a point, an insertion, needs no mark.
        const loose = a.kind === 'suggest' && a.end > a.start && !lit;
        let text = a.text;
        if (loose) {
            text = `replace "${clean(a.quote || out.slice(a.start, a.end))}" ` +
                `with "${clean(a.text)}"`;
        }
        const kind = loose ? 'review' : a.kind;
        const piece = itemText(kind, lit ? out.slice(a.start, a.end) : '',
                               a.author, a.date, text);
        out = lit ? out.slice(0, a.start) + piece + out.slice(a.end) :
            out.slice(0, a.end) + piece + out.slice(a.end);
    }
    return out;
}

/**
 * A card's markdown with its `n`th review comment (from 0) taken out,
 * its passage left as it was; with `apply`, a suggestion's new text put
 * in place of the passage instead.
 */
function removeItem(md, n, apply = false) {
    const it = reviewItems(md)[n];
    if (!it) return md;
    const keep = apply && it.kind === 'suggest' ? it.text : it.passage;
    return md.slice(0, it.start) + keep + md.slice(it.end);
}

/** Markdown for export: review comments out, their passages kept. */
function stripReview(md) {
    return md.replace(ITEM, (m, passage) => passage || '');
}

// ---- Drawing them on a card -------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
                'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-10-23 as 23 Oct. */
function shortDate(iso) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1]}` : iso || '';
}

/**
 * A card's markdown to render, each review comment replaced by inline
 * HTML Obsidian renders as it is: the passage marked, a suggestion's old
 * and new text side by side, and a number to find its callout by.
 */
function renderMarkdown(md) {
    let n = 0;
    ITEM.lastIndex = 0;
    return md.replace(ITEM, (m, passage, kind, body) => {
        n++;
        const h = HEAD.exec(body.replace(/^\s+/, ''));
        const text = h ? h[3] : body.trim();
        const cls = kind === 'suggest' ? ' is-suggest' : '';
        const num = `<sup class="dendrite-review-n${cls}">${n}</sup>`;
        if (kind === 'suggest' && !passage) {
            // An insertion's leading space is the text's, not the tint's.
            const lead = /^\s*/.exec(text)[0];
            return `${lead}<span class="dendrite-review-new">` +
                `${text.slice(lead.length)}</span>${num}`;
        }
        if (!passage) return num;
        if (kind === 'suggest') {
            return `<span class="dendrite-review-old">${passage}</span>` +
                (text ? `<span class="dendrite-review-new">${text}</span>`
                    : '') + num;
        }
        return `<mark class="dendrite-review-mark">${passage}</mark>${num}`;
    });
}

/**
 * Under each paragraph of a rendered card, a callout for each review
 * comment in it, numbered as in the text. `act(n, what)` is called with
 * the comment's index and 'resolve' or, for a suggestion, 'apply' or
 * 'dismiss'.
 */
function decorate(root, items, act) {
    const nums = [...root.querySelectorAll('sup.dendrite-review-n')];
    const doc = root.ownerDocument;
    const blocks = new Map();
    const blockOf = (el) => {
        let b = el;
        while (b.parentElement && b.parentElement !== root) {
            b = b.parentElement;
        }
        return b.parentElement === root ? b : null;
    };
    items.forEach((it, i) => {
        const sup = nums[i];
        const b = sup ? blockOf(sup) : null;
        if (!blocks.has(b)) blocks.set(b, []);
        blocks.get(b).push(i);
    });
    for (const [b, list] of blocks) {
        const box = doc.createElement('div');
        box.className = 'dendrite-review-notes';
        for (const i of list) {
            const it = items[i];
            const note = doc.createElement('div');
            note.className = 'dendrite-review-note' +
                (it.kind === 'suggest' ? ' is-suggest' : '');
            const n = doc.createElement('span');
            n.className = 'dendrite-review-n';
            n.textContent = String(i + 1);
            const main = doc.createElement('div');
            main.className = 'dendrite-review-main';
            const meta = doc.createElement('div');
            meta.className = 'dendrite-review-meta';
            const who = doc.createElement('b');
            who.textContent = it.author || 'Reviewer';
            meta.append(who, ` · ${shortDate(it.date)}`);
            const text = doc.createElement('div');
            text.className = 'dendrite-review-text';
            text.textContent = it.kind !== 'suggest' ? it.text :
                !it.text.trim() ? 'Suggests deleting this.' :
                it.passage ? `Suggests: ${it.text.trim()}` :
                `Suggests adding: ${it.text.trim()}`;
            main.append(meta, text);
            note.append(n, main);
            const buttons = it.kind === 'suggest' ?
                [['apply', 'Apply…'], ['dismiss', 'Dismiss']] :
                [['resolve', 'Resolve']];
            for (const [what, label] of buttons) {
                const btn = doc.createElement('button');
                btn.className = 'dendrite-review-btn';
                btn.textContent = label;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    act(i, what);
                });
                note.append(btn);
            }
            box.append(note);
        }
        if (b) b.after(box);
        else root.append(box);
    }
}

module.exports = { readReview, readBody, readComments, plainMap, normalise,
                   locate, reviewItems, itemText, addItems, removeItem,
                   stripReview, canHighlight, renderMarkdown, decorate,
                   shortDate };
