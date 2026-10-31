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

// A heading's section number, as an export writes it before its text.
const SECTION_NUMBER = /^\s*\d+(?:\.\d+)*\.?\s+/;

/**
 * Word's body as paragraphs of the text the reviewer was sent: deleted
 * text kept, inserted text left out, so it can be looked for in the
 * cards. Each paragraph records its tracked changes as offsets into that
 * text, and comments as positions { p, o }. A heading is marked, its
 * section number left out, since the number is the export's and not in
 * the card.
 */
function readBody(xml) {
    const paras = [];
    const ranges = new Map();
    let para = null;
    let ins = null;
    let del = null;
    let inText = false;
    let cells = 0;
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
    // A heading's number taken off its text, what is placed in it moved
    // back by as much.
    const unnumber = (p, k) => {
        const m = SECTION_NUMBER.exec(p.text);
        if (!m) return;
        const n = m[0].length;
        const back = (o) => Math.max(0, o - n);
        p.text = p.text.slice(n);
        for (const c of p.changes) {
            c.start = back(c.start);
            c.end = back(c.end);
        }
        for (const r of ranges.values()) {
            for (const at of [r.start, r.end]) {
                if (at && at.p === k) at.o = back(at.o);
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
                if (para && para.heading) unnumber(para, paras.length);
                if (para) paras.push(para);
                para = null;
            } else if (!empty) {
                para = { text: '', changes: [], ...(cells ? { cell: true } :
                                                    {}) };
            }
        } else if (name === 'w:tc' && !empty) {
            cells += close ? -1 : 1;
        } else if (name === 'w:pStyle' && para) {
            if (/^(heading\s*\d|title)$/i.test(attr(attrs, 'w:val'))) {
                para.heading = true;
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
                                  when: cur.when,
                                  text: paras.map((x) => x.trim())
                                      .filter(Boolean).join(' ') });
                cur = null;
            } else {
                cur = { id: attr(tk.attrs, 'w:id'),
                        author: attr(tk.attrs, 'w:author'),
                        date: day(attr(tk.attrs, 'w:date')),
                        when: attr(tk.attrs, 'w:date') || '' };
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
    // The text before offset `s` of paragraph `p` and after offset `e` of
    // paragraph `q`. A table cell is often a lone number, so its context
    // runs on through the cells beside it, as the card's table row reads.
    const around = (p, s, q, e) => {
        let before = paras[p].text.slice(0, s);
        let after = paras[q].text.slice(e);
        for (let k = p - 1; paras[p].cell && k >= 0 && paras[k].cell &&
             before.length < CONTEXT; k--) {
            before = `${paras[k].text} ${before}`;
        }
        for (let k = q + 1; paras[q].cell && k < paras.length &&
             paras[k].cell && after.length < CONTEXT; k++) {
            after = `${after} ${paras[k].text}`;
        }
        return { before: tail(before, CONTEXT),
                 after: after.slice(0, CONTEXT) };
    };
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
        items.push({ kind: 'comment', author: note.author, date: note.date,
                     when: note.when,
                     text: note.text, quote,
                     ...around(r.start.p, r.start.o, end.p, end.o),
                     at: [r.start.p, r.start.o],
                     ...(paras[r.start.p].heading ? { heading: true } :
                         {}) });
    }
    paras.forEach((p, k) => {
        for (const c of p.changes) {
            items.push({ kind: 'change', author: c.author, date: c.date,
                         quote: p.text.slice(c.start, c.end),
                         insert: c.insert,
                         ...around(k, c.start, k, c.end),
                         at: [k, c.start] });
        }
    });
    items.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
    linkGoogle(items, googleData(files));
    return items;
}

// ---- a Word file saved by Google Docs --------------------------------

/** Protocol buffer fields, [field, value], a length-delimited one bytes. */
function protoFields(buf) {
    const out = [];
    let i = 0;
    const varint = () => {
        let v = 0;
        let scale = 1;
        for (;;) {
            const c = buf[i++];
            if (c === undefined) throw new Error('truncated');
            v += (c & 0x7f) * scale;
            scale *= 128;
            if (c < 0x80) return v;
        }
    };
    while (i < buf.length) {
        const key = varint();
        const field = Math.floor(key / 8);
        const type = key % 8;
        if (type === 0) out.push([field, varint()]);
        else if (type === 2) {
            const n = varint();
            out.push([field, buf.subarray(i, i + n)]);
            i += n;
        } else if (type === 1) i += 8;
        else if (type === 5) i += 4;
        else throw new Error('unknown wire type');
    }
    return out;
}

/**
 * Google Docs' own record of its comments, kept in a custom XML part of
 * a Word file it saves: the doc's id and, for each comment, its id
 * (doco....), its text and when it was made, in milliseconds. Null for a
 * Word file Docs did not save. Fields as read from such a file: the doc
 * id 14; a comment 4, holding its id 1 and a body 2 with its text 4 (plain)
 * or 3 (HTML), each { 1: type, 2: text }, and its time 6.
 */
function googleData(files) {
    for (const [name, xml] of files) {
        if (!/^customxml\//i.test(name)) continue;
        const m = /<go:docsCustomData[^>]*>([^<]+)</.exec(xml);
        if (!m) continue;
        try {
            const top = protoFields(Buffer.from(m[1], 'base64'));
            const get = (fields, n) => (fields.find((f) => f[0] === n) ||
                                        [])[1];
            const str = (b) => (b ? Buffer.from(b).toString('utf8') : '');
            const comments = [];
            for (const [f, v] of top) {
                if (f !== 4 || typeof v === 'number') continue;
                const rec = protoFields(v);
                const body = get(rec, 2);
                if (!body) continue;
                const b = protoFields(body);
                const text = (k) => {
                    const part = get(b, k);
                    return part ? str(get(protoFields(part), 2)) : '';
                };
                comments.push({ id: str(get(rec, 1)),
                                text: text(4) || text(3)
                                    .replace(/<[^>]+>/g, ''),
                                ms: get(b, 6) || 0 });
            }
            return { docId: str(get(top, 14)), comments };
        } catch (err) {
            return null;
        }
    }
    return null;
}

/**
 * Each comment read from a Word file Docs saved, given its Google id and
 * link: matched to Docs' record by its text and, among those alike, the
 * time it was made. A comment Docs had on several passages comes out of
 * Word as one comment per passage, alike in author, text and time; each
 * takes the one comment's id.
 */
function linkGoogle(items, g) {
    if (!g || !g.docId) return;
    const flatText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const groups = new Map();
    for (const it of items) {
        if (it.kind !== 'comment') continue;
        const key = `${it.author}\u0000${flatText(it.text)}\u0000` +
            (it.when || it.date);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
    }
    const used = new Set();
    for (const group of groups.values()) {
        const it = group[0];
        // The time to the second, which a comment's date, its day, lacks.
        const when = Date.parse(it.when || '');
        const near = g.comments.filter((c) => !used.has(c.id) &&
            flatText(c.text) === flatText(it.text) &&
            (!when || !c.ms || Math.abs(c.ms - when) < 120000))
            .sort((a, b) => Math.abs(a.ms - when) - Math.abs(b.ms - when));
        if (!near.length) continue;
        used.add(near[0].id);
        const link = 'https://docs.google.com/document/d/' +
            `${g.docId}/edit?disco=${near[0].id}`;
        for (const x of group) Object.assign(x, { gid: near[0].id, link });
    }
}

/**
 * Review comments from a JSON file, a list or { items: [...] }, each
 * { quote, text, author?, date?, card? }: `card` a card's id or its
 * part after the prefix, to search only that card. With no date, today.
 */
function readReviewJson(text, today = new Date()) {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data :
        data && Array.isArray(data.items) ? data.items : null;
    if (!list) throw new Error('not a list of items');
    const str = (v) => (v == null ? '' : String(v));
    return list.map((x, k) => {
        if (!x || typeof x !== 'object' || !str(x.text).trim()) {
            throw new Error(`item ${k + 1} has no text`);
        }
        const item = { kind: 'comment' };
        if (x.card) item.card = str(x.card);
        return Object.assign(item, { quote: str(x.quote),
            before: str(x.before), after: str(x.after),
            text: str(x.text), author: str(x.author),
            date: str(x.date) || today.toISOString().slice(0, 10) });
    });
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

/**
 * Where a point in a card's drawn text falls in its markdown `md`, given
 * the drawn text just `before` and `after` the point: the offset whose
 * printed text (plainMap) has the most of both around it, whitespace
 * taken as one space. Null where too little of either is found.
 */
function offsetAt(md, before, after) {
    const { text, map } = plainMap(md);
    const squash = (t) => t.replace(/\s+/g, ' ');
    // The printed text squashed, each character's index in `text`.
    let flat = '';
    const at = [];
    for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i]) && /\s/.test(text[i - 1] || '')) continue;
        flat += /\s/.test(text[i]) ? ' ' : text[i];
        at.push(i);
    }
    const b = squash(before).slice(-60);
    const a = squash(after).slice(0, 60);
    let best = -1;
    let score = 0;
    for (let p = 0; p <= flat.length; p++) {
        let n = 0;
        while (n < b.length && n < p &&
               flat[p - 1 - n] === b[b.length - 1 - n]) n++;
        let m = 0;
        while (m < a.length && p + m < flat.length &&
               flat[p + m] === a[m]) m++;
        if (n + m > score) {
            score = n + m;
            best = p;
        }
    }
    if (best < 0 || score < Math.min(4, b.length + a.length)) return null;
    if (best < flat.length) return map[at[best]];
    return text.length ? map[text.length - 1] + 1 : md.length;
}

/**
 * The drawn text of `root` before and after a point in it, `node` and
 * `offset` as a DOM range gives them, for offsetAt: what the card adds
 * to its text, such as comment numbers, comments and suggested text, left
 * out, and a space between blocks.
 */
function textAround(root, node, offset) {
    const doc = root.ownerDocument;
    const SKIP = 'sup, .dendrite-review-notes, .dendrite-review-new, ' +
        '.dendrite-review-lead, .dendrite-cm-suggestion, mjx-container, ' +
        'button, .dendrite-placeholder';
    const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, ' +
        'pre, div';
    const blockOf = (t) => t.parentElement && t.parentElement.closest(BLOCK);
    const walk = doc.createTreeWalker(root, 4);
    let before = '';
    let after = '';
    let past = false;
    let last = null;
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        if (t.parentElement && t.parentElement.closest(SKIP)) {
            if (t === node) past = true;
            continue;
        }
        const b = blockOf(t);
        const gap = last && b !== last ? ' ' : '';
        last = b;
        if (t === node) {
            before += gap + t.data.slice(0, offset);
            after += t.data.slice(offset);
            past = true;
        } else if (past) {
            after += gap + t.data;
        } else {
            before += gap + t.data;
        }
        if (after.length > 80) break;
    }
    if (!past) return null;
    return { before: before.slice(-80), after: after.slice(0, 80) };
}

/**
 * Where the paragraph holding offset `at` of `md` ends, as markdown runs
 * one on: through the lines after it until a blank one or one that
 * starts a block of its own, such as a heading, a list item, a quote, a
 * table row or a code fence. A list item or table row is its own block.
 */
function paragraphEnd(md, at) {
    const BLOCK = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)/;
    let end = md.indexOf('\n', at);
    if (end < 0) return md.length;
    const start = md.lastIndexOf('\n', at - 1) + 1;
    if (/^\s*\|/.test(md.slice(start, end))) return end;
    for (;;) {
        const next = md.indexOf('\n', end + 1);
        const line = md.slice(end + 1, next < 0 ? md.length : next);
        if (!line.trim() || BLOCK.test(line)) return end;
        if (next < 0) return md.length;
        end = next;
    }
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

/**
 * Two texts' words lined up, an earlier version of a card and the card
 * that replaced it: { was, now, match }, `match[i]` the index in `now` of
 * the word `was[i]`, or -1 where it has gone. Compared without case.
 */
function alignWords(wasText, nowText) {
    const was = words(wasText);
    const now = words(nowText);
    const low = (l) => l.map((x) => x.w.toLowerCase());
    return { was, now, match: lcs(low(was), low(now)).match };
}

/**
 * A place in an earlier version carried to the card that replaced it,
 * `al` the two lined up (alignWords): { start, end } in `nowText`, or
 * null. A point goes before the next word that is still there, or after
 * the last; a passage only where every one of its words is still there,
 * side by side, so the same text is marked.
 */
function mapThrough(al, wasText, nowText, start, end) {
    const { was, now, match } = al;
    if (start === end) {
        for (let i = 0; i < was.length; i++) {
            if (was[i].at + was[i].w.length > start && match[i] >= 0 &&
                was[i].at >= start) {
                return { start: now[match[i]].at, end: now[match[i]].at };
            }
        }
        for (let i = was.length - 1; i >= 0; i--) {
            if (was[i].at < start && match[i] >= 0) {
                const k = now[match[i]].at + now[match[i]].w.length;
                return { start: k, end: k };
            }
        }
        return null;
    }
    const inside = [];
    for (let i = 0; i < was.length; i++) {
        if (was[i].at < end && was[i].at + was[i].w.length > start) {
            inside.push(i);
        }
    }
    if (!inside.length) return null;
    for (let k = 0; k < inside.length; k++) {
        const j = match[inside[k]];
        if (j < 0 || (k && j !== match[inside[k - 1]] + 1)) return null;
    }
    const first = was[inside[0]];
    const last = was[inside[inside.length - 1]];
    const a = now[match[inside[0]]].at + Math.max(0, start - first.at);
    const lastNow = now[match[inside[inside.length - 1]]];
    const b = lastNow.at + Math.min(lastNow.w.length,
                                    end - last.at);
    const same = (x) => normalise(x).text;
    if (b <= a || same(nowText.slice(a, b)) !==
        same(wasText.slice(start, end))) return null;
    return { start: a, end: b };
}

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
 * after the text before it. One on a heading is looked for only in the
 * cards' headings, so it is not taken for the same words in a table.
 */
function locate(item, cards) {
    const at = locateAs(item, cards);
    if (at || item.heading) return at;
    // A heading as exported carries its section number, which the card's
    // heading line does not: found by its words, only where they are a
    // card's whole heading line and only one card's, as a short heading
    // is likely in body text too.
    const m = /^\s*\d+(?:\.\d+)*\.?\s+(\S[^]*)$/.exec(item.quote || '');
    if (!m) return null;
    const want = normalise(m[1]).text;
    const own = cards.filter((c) => String(c.text).split('\n').some((l) =>
        /^#{1,6}\s/.test(l) &&
        normalise(l.replace(/^#+\s*/, '')).text === want));
    if (own.length !== 1) return null;
    return locateAs({ ...item, quote: m[1], before: '', after: '',
                      heading: true }, own);
}

function locateAs(item, cards) {
    if (item.card) {
        // By its short id, which a rename keeps, so a card named as it
        // was before one is still found.
        const short = (x) => String(x).slice(String(x).lastIndexOf('-') + 1);
        const k = short(item.card);
        cards = cards.filter((c) => short(c.id) === k);
    }
    if (item.heading && item.quote) {
        const want = normalise(item.quote).text;
        cards = cards.filter((c) => String(c.text).split('\n').some((l) =>
            /^#{1,6}\s/.test(l) &&
            normalise(l.replace(/^#+\s*/, '')).text.includes(want)));
        if (!cards.length) return null;
    }
    const prepared = cards.map((c) => {
        const plain = plainMap(c.text);
        const norm = normalise(plain.text);
        return { id: c.id, plain, norm,
                 src: (k) => plain.map[norm.map[k]] };
    });
    const quote = normalise(item.quote || '').text;
    const before = normalise(item.before || '').text;
    const after = normalise(item.after || '').text;
    // A point after text ending in a space goes after the space, where
    // the reviewer put it; the normalised text before it has lost that
    // space, and the point fell against the word before.
    const gap = !quote && /\s$/.test(item.before || '');
    const past = (c, k) => {
        while (gap && c.norm.text[k] === ' ') k++;
        return k;
    };
    // A suggested deletion that took a space with it takes the card's
    // space there too, so applying it leaves one space, not two.
    const wide = item.kind === 'suggest' && quote;
    const grow = (c, s, e) => {
        if (wide && /\s$/.test(item.quote) && c.norm.text[e] === ' ') e++;
        else if (wide && /^\s/.test(item.quote) &&
                 c.norm.text[s - 1] === ' ') s--;
        return [s, e];
    };
    // Exact: the passage as sent, the context deciding between copies.
    const found = [];
    // A point with no text before it, as a paragraph added above another,
    // is found by the text after it.
    const head = !quote && !before ? after.slice(0, 30) : '';
    const probe = quote || head || tail(before, 30);
    // A passage under three characters, as a number in a table cell,
    // is taken only where the text around it agrees too.
    const least = probe.length >= 3 ? 0 : 8;
    if (probe.length >= 3 || (quote && (before || after))) {
        for (const c of prepared) {
            let k = c.norm.text.indexOf(probe);
            while (k >= 0) {
                const s = quote || head ? k : k + probe.length;
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
                if (score + sa >= least) {
                    found.push({ c, s, e, score: score + sa });
                }
                k = c.norm.text.indexOf(probe, k + 1);
            }
        }
    }
    if (found.length) {
        found.sort((x, y) => y.score - x.score);
        const best = found[0];
        if (found.length === 1 || best.score > found[1].score) {
            if (!quote && !head) {
                const k = past(best.c, best.s);
                return place(best.c, k, k, 'exact');
            }
            return place(best.c, ...grow(best.c, best.s, best.e), 'exact');
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
        return place(best.c, ...grow(best.c, first.at,
                                     last.at + last.w.length), 'close');
    }
    // The passage is gone: after the last word of the text before it.
    const pre = best.r.match.slice(0, bw.length).filter((j) => j >= 0);
    if (!pre.length) {
        // Or before the first word of the text after it.
        const post = best.r.match.slice(bw.length + qw.length)
            .filter((j) => j >= 0);
        if (!post.length || bw.length) return null;
        const w = best.cw[post[0]];
        return place(best.c, w.at, w.at, 'close');
    }
    const w = best.cw[pre[pre.length - 1]];
    const k = past(best.c, w.at + w.w.length);
    return place(best.c, k, k, 'close');
}

function place(c, s, e, how) {
    // Offsets in the normalised text back to the card's markdown.
    const start = s < c.norm.map.length ? c.src(s) :
        c.plain.map[c.plain.map.length - 1] + 1;
    const end = e > s ? c.src(e - 1) + 1 : start;
    return { id: c.id, start, end: e > s ? end : start, how };
}

// ---- Review comments in a card's text ----------------------------------

// A comment or suggested change, its passage, and the replies to it,
// each written straight after it: %%[!reply] Author, date: text%%. The
// passage is highlighted, ==passage==%%[!review] …%%, or, where it
// cannot be, as where it overlaps another's, held between a start marker
// and its note, matched by id so they may interleave:
// %%{1%%passage%%}1 [!review] …%%.
const SCAN = new RegExp('%%\\{([a-z0-9]+)%%|' +
    '(?:==([^=\\n]+?)==)?%%(?:\\}([a-z0-9]+)\\s+)?' +
    '\\[!(review|suggest)(?:\\s*\\\\?\\|\\s*p[123])?\\s*\\]' +
    '\\s*([\\s\\S]*?)%%' +
    '((?:%%\\[!reply\\][\\s\\S]*?%%)*)', 'g');

// A comment's triage priority, for the writer to work through: a tag on
// its marker, [!review|p1], kept by Dendrite and never exported. In a
// table row its pipe is escaped, [!review\|p1], as a cell's must be; one
// a table editor took for a cell's edge, [!review   | p1], is read too.
const PRIORITY = /\[!(review|suggest)(?:\s*\\?\|\s*(p[123]))?\s*\]/;

/** A priority's tag for a marker at `at` in md: escaped in a table row. */
function priorityTag(md, at, p) {
    if (!PRIORITIES.includes(p)) return '';
    const line = md.slice(md.lastIndexOf('\n', at - 1) + 1, at);
    return (/^\s*\|/.test(line) ? '\\|' : '|') + p;
}
const PRIORITIES = ['p1', 'p2', 'p3'];

/**
 * A card's comments as found, in order, with the ranges of their syntax
 * (markers, highlight marks, notes and replies) for leaving out: an item
 * is { kind, old (a highlighted passage), id, open (its start marker's
 * range), start, noteStart, end, body, replies }.
 */
function scan(md) {
    const opens = new Map();
    const items = [];
    const syntax = [];
    SCAN.lastIndex = 0;
    let m;
    while ((m = SCAN.exec(md))) {
        const at = m.index;
        const end = at + m[0].length;
        if (m[1] !== undefined) {
            opens.set(m[1], { start: at, end });
            syntax.push([at, end]);
            continue;
        }
        const [, , old, id, kind, body, replies] = m;
        const noteStart = old !== undefined ? at + old.length + 4 : at;
        if (old !== undefined) syntax.push([at, at + 2]);
        syntax.push([old !== undefined ? noteStart - 2 : noteStart, end]);
        const open = id !== undefined && opens.get(id) || null;
        const tag = PRIORITY.exec(md.slice(noteStart, end));
        items.push({ kind, old, id: open ? id : undefined, open,
                     start: open ? open.start : at, noteStart, end, body,
                     replies, priority: tag && tag[2] || null });
    }
    return { items, syntax };
}

/** The text of md from `s` to `e`, the ranges in `syntax` left out. */
function without(md, s, e, syntax) {
    let out = '';
    let at = s;
    for (const [a, b] of syntax) {
        if (b <= at || a >= e) continue;
        if (a > at) out += md.slice(at, a);
        at = Math.max(at, b);
    }
    return out + md.slice(at, Math.max(at, e));
}
const REPLY = /%%\[!reply\]\s*([\s\S]*?)%%/g;
const HEAD = /^(.*?),\s*(\d{4}-\d{2}-\d{2}):\s?([\s\S]*)$/;
// A reply opening so suggests the writer resolve the comment.
const RESOLVE = /^\[resolve\]\s*/;

/**
 * The replies written after a comment: [{ author, date, text }], and
 * `resolve: true` on one suggesting the comment be resolved.
 */
function readReplies(chunk) {
    const out = [];
    REPLY.lastIndex = 0;
    let m;
    while ((m = REPLY.exec(chunk || ''))) {
        const h = HEAD.exec(m[1].replace(/^\s+/, ''));
        const text = (h ? h[3] : m[1]).trim();
        const r = { author: h ? h[1] : '', date: h ? h[2] : '',
                    text: text.replace(RESOLVE, '') };
        if (RESOLVE.test(text)) r.resolve = true;
        out.push(r);
    }
    return out;
}

/**
 * Whether a comment's last reply suggests it be resolved: its reviewer
 * or Claude thinks the edits answer it, and nobody has replied since.
 */
function readyToResolve(it) {
    const rs = (it && it.kind !== 'suggest' && it.replies) || [];
    return !!(rs.length && rs[rs.length - 1].resolve);
}

/**
 * The review comments in a card's markdown, in order: { kind: 'review'
 * or 'suggest', passage, author, date, text, replies, start, end }, with
 * the offsets of the whole of it, highlight and replies included.
 */
function reviewItems(md) {
    const { items, syntax } = scan(md);
    return items.map((x) => {
        const h = HEAD.exec(x.body.replace(/^\s+/, ''));
        return { kind: x.kind,
                 passage: x.open ?
                     without(md, x.open.end, x.noteStart, syntax) :
                     x.old || '',
                 author: h ? h[1] : '', date: h ? h[2] : '',
                 text: h ? (x.kind === 'suggest' ? h[3] : h[3].trim()) :
                     x.body.trim(),
                 replies: readReplies(x.replies), priority: x.priority,
                 start: x.start, end: x.end, noteStart: x.noteStart,
                 ...(x.open ? { id: x.id, open: x.open } : {}) };
    });
}

/**
 * A card's markdown with its tables mended where a table editor took a
 * priority's pipe, written unescaped in a row, for a cell's edge: each
 * such tag rejoined and escaped, [!review\|p3], and the empty last
 * column the editor then gave the table taken off, where it is empty
 * in the header and every row that has it, and some row is without it.
 * A table's own last column, named or filled, is left; so is a tag's
 * plain pipe outside a table.
 */
function mendSplitTags(md) {
    const lines = md.split('\n');
    const isRow = (l) => /^\s*\|/.test(l);
    const cells = (l) => (l.match(/(?<!\\)\|/g) || []).length - 1;
    const SPLIT = /\[!(review|suggest)\s*\|\s*(p[123])\s*\]/g;
    for (let i = 0; i < lines.length; i++) {
        if (!isRow(lines[i])) continue;
        let j = i;
        while (j < lines.length && isRow(lines[j])) {
            lines[j] = lines[j].replace(SPLIT, '[!$1\\|$2]');
            j++;
        }
        const [head, rule, ...rows] = lines.slice(i, j);
        const last = /\|([^|]*)\|\s*$/;
        const n = cells(head);
        // Each row without the column, or with it empty.
        const without = (r) => cells(r) === n - 1 ||
            (cells(r) === n && !last.exec(r)[1].trim());
        if (rule && /^[\s|:-]+$/.test(rule) && rows.length &&
            !last.exec(head)[1].trim() && cells(rule) === n &&
            rows.some((r) => cells(r) === n - 1) && rows.every(without)) {
            for (let k = i; k < j; k++) {
                if (cells(lines[k]) === n) {
                    lines[k] = lines[k].replace(last, '|');
                }
            }
        }
        i = j;
    }
    return lines.join('\n');
}

/**
 * A card's markdown with its `n`th comment's priority set to `p`, one of
 * p1 to p3, or taken off for null; as it was where there is no such
 * comment.
 */
function setPriority(md, n, p) {
    const it = reviewItems(md)[n];
    if (!it) return md;
    const m = PRIORITY.exec(md.slice(it.noteStart, it.end));
    if (!m) return md;
    const at = it.noteStart + m.index;
    const tag = priorityTag(md, at, p);
    return md.slice(0, at) + `[!${m[1]}${tag}]` +
        md.slice(at + m[0].length);
}

/**
 * A card's markdown with a reply { author, date, text } to its `n`th
 * review comment, after the replies it has.
 */
function addReply(md, n, reply) {
    const it = reviewItems(md)[n];
    if (!it) return md;
    const said = reply.resolve ?
        `[resolve] ${clean(reply.text)}`.trim() : clean(reply.text);
    const note = `%%[!reply] ${clean(reply.author) || 'Me'}, ` +
        `${reply.date}: ${said}%%`;
    return md.slice(0, it.end) + note + md.slice(it.end);
}

/**
 * A comment's identity in its card, for a program to name it by: its
 * kind, reviewer, date, passage and text, and not its replies, so it
 * stays the same as it is answered.
 */
function threadId(it) {
    return docx.crc32(docx.utf8([it.kind, it.author, it.date,
        flat(it.passage || ''), flat(it.text || '')].join('\u0000')))
        .toString(16);
}

/**
 * Each of a card's comments' ids, in order: threadId, and where two are
 * the same in every part, the second and on numbered after it.
 */
function threadIds(items) {
    const seen = new Map();
    return items.map((it) => {
        const id = threadId(it);
        const k = (seen.get(id) || 0) + 1;
        seen.set(id, k);
        return k === 1 ? id : `${id}.${k}`;
    });
}

// A reply addressed to one reader, `@Claude text`: for them, so it
// does not go back to the reviewer.
const TO = /^@(\S+)\s+([\s\S]*)$/;

/** Whom a reply is addressed to, or null, and its text without that. */
function addressed(r) {
    const m = TO.exec(r.text || '');
    return m ? { to: m[1], text: m[2] } : { to: null, text: r.text || '' };
}

/**
 * Whether a comment waits for `name`'s answer. A reviewer's: until they
 * answer it, and again when a reviewer replies or someone replies to
 * them. The writer's own, in `self`, only when it or a reply in it is
 * addressed to them, and then as a thread of theirs, followed up by
 * any reply. The writer answering a reviewer does not count.
 */
function awaits(it, name, self) {
    const rs = it.replies || [];
    const to = (x) => addressed(x).to === name;
    const mine = self.has(it.author);
    const asked = it.author === name || (mine && to(it));
    if (mine && !asked && !rs.some(to)) return false;
    let j = rs.length - 1;
    while (j >= 0 && rs[j].author !== name) j--;
    if (j < 0 && it.author !== name) return true;
    return rs.slice(j + 1).some((r) => asked || !self.has(r.author) ||
        to(r));
}

/**
 * Whether a comment passes the comment list's filter, whose parts are
 * each '' for any: `author`, a name or 'me' for any name in `self`;
 * `waiting`, 'me' where someone else has the last word, 'Claude' where
 * Claude was asked, with @Claude, and has not answered since, or
 * 'resolve' where the last reply suggests resolving it; `kind`,
 * 'comment' or 'suggest'; and `priority`, p1 to p3, or 'none' for those
 * with none.
 */
function passesFilter(it, f, self) {
    if (!f) return true;
    const suggest = it.kind === 'suggest';
    if (f.priority === 'none' ? it.priority :
        f.priority && it.priority !== f.priority) return false;
    if (f.kind === 'comment' && suggest) return false;
    if (f.kind === 'suggest' && !suggest) return false;
    if (f.author === 'me' ? !self.has(it.author) :
        f.author && it.author !== f.author) return false;
    const rs = it.replies || [];
    if (f.waiting === 'me') {
        return !self.has(rs.length ? rs[rs.length - 1].author : it.author);
    }
    if (f.waiting === 'Claude') {
        const asked = [it, ...rs].some((x) => addressed(x).to === 'Claude');
        return asked && awaits(it, 'Claude', self);
    }
    if (f.waiting === 'resolve') return readyToResolve(it);
    return true;
}

// A link in a comment, [[o5yps]] or [[o5yps|its text]].
const WIKILINK = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;

/**
 * `text` appended to `el`, each [[link]] in it as the element
 * `linkOf(doc, target, alias)` makes, or as written where it makes none.
 */
function fillLinked(el, text, linkOf = null) {
    const doc = el.ownerDocument;
    let at = 0;
    WIKILINK.lastIndex = 0;
    let m;
    while (linkOf && (m = WIKILINK.exec(text))) {
        const a = linkOf(doc, m[1].trim(), m[2] && m[2].trim());
        if (!a) continue;
        if (m.index > at) el.append(text.slice(at, m.index));
        el.append(a);
        at = m.index + m[0].length;
    }
    if (at < text.length) el.append(text.slice(at));
}

/**
 * `text` into `el`, a reader it opens by addressing, `@Claude`, in bold
 * and no reviewer's colour, so it is not read as that reader's own; its
 * [[links]] made by `linkOf`, as fillLinked.
 */
function fillAddressed(el, text, colourOf = null, linkOf = null) {
    const { to, text: rest } = addressed({ text });
    el.textContent = '';
    if (!to) {
        fillLinked(el, text, linkOf);
        return;
    }
    const doc = el.ownerDocument;
    const at = doc.createElement('span');
    at.className = 'dendrite-review-to';
    at.textContent = `@${to}`;
    el.append(at, ' ');
    fillLinked(el, rest, linkOf);
}

/**
 * A comment's triage priority as a chip, p1 to p3 in its colour, or a
 * faint p– where none is set; its menu is the caller's to add.
 */
function priorityChip(doc, p) {
    const b = doc.createElement('button');
    b.className = 'dendrite-prio' + (p ? ` is-${p}` : ' is-none');
    b.textContent = p || 'p–';
    b.setAttribute('aria-label', p ? `Priority ${p}` : 'Set a priority');
    // Its own, not the card's or the comment's under it.
    for (const ev of ['mousedown', 'pointerdown', 'dblclick']) {
        b.addEventListener(ev, (e) => e.stopPropagation());
    }
    return b;
}

// Whether comments are folded until clicked and fold again when left,
// the setting's; off, they are open and folded only by hand.
let foldUntilClicked = true;

function setFoldUntilClicked(on) {
    foldUntilClicked = !!on;
}

/**
 * Let comment `it`'s callout `note` fold to the first line of its text,
 * a count of the replies before the latest, and the latest in full, the
 * one usually to act on. It is folded at first, opened by a click on it,
 * and folded again when a press or the focus goes anywhere outside it,
 * so only the comment being read is open, unless that setting is off,
 * when it is open; a toggle at the start of `meta`, its name line, folds
 * and opens it by hand. Call it once the
 * replies are drawn. A thread with nothing to hide has no toggle.
 * `onToggle(folded)` is told of each change, as for a redraw.
 */
function foldable(note, meta, it, onToggle = null) {
    const earlier = Math.max(0, (it.replies || []).length - 1);
    if (!earlier && String(it.text || '').length <= 140) return;
    const rows = note.querySelectorAll('.dendrite-review-reply');
    if (rows.length) rows[rows.length - 1].classList.add('is-latest');
    const doc = note.ownerDocument;
    const btn = doc.createElement('span');
    btn.className = 'dendrite-review-fold';
    btn.setAttribute('role', 'button');
    btn.title = 'Fold or unfold this thread';
    const count = doc.createElement('span');
    count.className = 'dendrite-review-count';
    count.textContent = earlier ?
        ` · ${earlier} earlier repl${earlier === 1 ? 'y' : 'ies'}` : '';
    meta.prepend(btn);
    meta.append(count);
    const auto = foldUntilClicked;
    let heard = null;
    // Open, it listens for a press elsewhere in its window to fold.
    const away = (e) => {
        if (!note.isConnected || !note.contains(e.target)) set(true, true);
    };
    const set = (f, told = false) => {
        if (note.classList.contains('is-folded') === f &&
            btn.textContent) return;
        note.classList.toggle('is-folded', f);
        btn.textContent = f ? '▸' : '▾';
        // The end of a press, or a click without one, as a keyboard's or
        // a program's, in the document it is in when opened: it may be
        // drawn in another before it is placed. Not the press's start:
        // folding then moves a comment below it from under the pointer
        // before the press ends, and its click is lost.
        for (const ev of heard ? ['pointerup', 'click'] : []) {
            heard.removeEventListener(ev, away, true);
        }
        heard = !f && auto ? note.ownerDocument : null;
        for (const ev of heard ? ['pointerup', 'click'] : []) {
            heard.addEventListener(ev, away, true);
        }
        if (told && onToggle) onToggle(f);
    };
    set(auto);
    note.addEventListener('click', () => {
        if (auto && note.classList.contains('is-folded')) set(false, true);
    });
    // The focus moved on to something else; a press elsewhere, which
    // may leave no element focused, is told by `away`.
    note.addEventListener('focusout', (e) => {
        if (auto && e.relatedTarget && !note.contains(e.relatedTarget)) {
            set(true, true);
        }
    });
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        set(!note.classList.contains('is-folded'), true);
    });
    for (const ev of ['mousedown', 'pointerdown', 'dblclick']) {
        btn.addEventListener(ev, (e) => e.stopPropagation());
    }
}

/**
 * A reply as drawn under its comment, in its writer's colour: their
 * name over its text. One with no text is a read mark, a row saying
 * its writer read the comment and had nothing to add.
 */
function replyRow(doc, r, nameOf = null, colourOf = null, linkOf = null) {
    const el = doc.createElement('div');
    const rc = colourOf && colourOf(r.author || 'Me');
    const seen = !r.resolve && !String(r.text || '').trim();
    el.className = 'dendrite-review-reply' + (seen ? ' is-seen' : '') +
        (r.resolve ? ' is-resolve' : '') + (rc ? ` is-c-${rc}` : '');
    const by = doc.createElement('div');
    by.className = 'dendrite-review-meta';
    const b = doc.createElement('b');
    shownAs(b, r.author || 'Me', nameOf);
    if (seen) {
        const tick = doc.createElement('span');
        tick.className = 'dendrite-review-check';
        // Its space inside it: the check sits where a reply's rule is,
        // and the name where a reply's name is.
        tick.textContent = '✓ ';
        by.append(tick);
    }
    by.append(b, r.resolve ? ' suggests resolving' : '',
              ` · ${shortDate(r.date)}`);
    el.append(by);
    if (r.resolve) {
        el.title = `${b.textContent} thinks the edits answer this ` +
            'comment; Resolve it if you agree';
        if (!String(r.text || '').trim()) return el;
    }
    if (seen) {
        el.title = `${b.textContent} read this on ${shortDate(r.date)} ` +
            'and had nothing to add';
        return el;
    }
    const said = doc.createElement('div');
    said.className = 'dendrite-review-text';
    fillAddressed(said, r.text, colourOf, linkOf);
    el.append(said);
    return el;
}

/**
 * A card's comments as they may go back to their reviewers: each
 * reviewer's comment with the writer's replies to it, which are meant
 * for that reviewer. Comments of the writer's own, any name in `self`,
 * are questions for Claude, and Claude's comments and replies are for
 * the writer, so none of those goes.
 */
function forReviewers(items, self) {
    const mine = (who) => self.has(who) || who === 'Claude';
    return items.filter((it) => !mine(it.author)).map((it) => ({ ...it,
        replies: (it.replies || []).filter((r) => r.author !== 'Claude' &&
            addressed(r).to !== 'Claude') }));
}

/**
 * A card's markdown with `name`'s replies at the end of its `n`th
 * comment's thread replaced by `reply`; null where someone else has
 * replied since, or there are none, so a thread is never changed under
 * an answer to it.
 */
function replaceReplies(md, n, name, reply) {
    const it = reviewItems(md)[n];
    const rs = it ? it.replies : [];
    let k = rs.length;
    while (k > 0 && rs[k - 1].author === name) k--;
    if (k === rs.length) return null;
    let out = md;
    for (let x = rs.length - 1; x >= k; x--) out = removeReply(out, n, x);
    return addReply(out, n, reply);
}

/** A card's markdown with the `k`th reply to its `n`th comment taken out. */
function removeReply(md, n, k) {
    const it = reviewItems(md)[n];
    if (!it) return md;
    const whole = md.slice(it.noteStart, it.end);
    REPLY.lastIndex = 0;
    let m;
    let i = 0;
    while ((m = REPLY.exec(whole))) {
        if (whole.slice(0, m.index).endsWith('%%') && i++ === k) {
            return md.slice(0, it.noteStart + m.index) +
                md.slice(it.noteStart + m.index + m[0].length);
        }
    }
    return md;
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

/** A suggestion kept as a comment, saying what it would replace. */
const looseText = (passage, text) =>
    `replace "${clean(passage)}" with "${clean(text)}"`;

// A Google Docs link at the end of a comment's text, to its thread.
const LINK = /\s+(https:\/\/docs\.google\.com\/\S+)$/;

/** A comment's text and the Google Docs link it ends with, if any. */
function noteLink(text) {
    const m = LINK.exec(String(text || ''));
    return m ? { text: text.slice(0, m.index), url: m[1] } :
        { text: String(text || ''), url: '' };
}

const flat = (t) => clean(t).replace(/\s+/g, ' ');

/**
 * The keys a comment or change is known by, the same for an item being
 * imported and for the note it became in a card: its Google comment id
 * where it has one, and its reviewer with what it says. A comment's
 * text is taken without its link, or the quoted passage a comment
 * placed away from its passage begins with.
 */
function reviewKeys(it) {
    const author = clean(it.author) || 'Reviewer';
    const keys = [];
    const hash = (s) => docx.crc32(docx.utf8(s)).toString(16);
    const change = (out, put) => 's:' + hash(`${author}\u0000${flat(out)}` +
                                             `\u0000${flat(put)}`);
    const comment = (text) => 'c:' + hash(`${author}\u0000${flat(text)
        .replace(/^On “[^”]*”(?:, in an earlier version)?: /, '')}`);
    if (it.kind === 'change' || it.kind === 'suggest') {
        const out = it.kind === 'change' ? it.quote : it.passage;
        const put = it.kind === 'change' ? it.insert : it.text;
        keys.push(change(out, put));
        // Known too as the comment it goes in as where its text has
        // changed, which may have been resolved as that.
        if (it.kind === 'change') keys.push(comment(changeAsComment(it)));
        return keys;
    }
    const { text, url } = noteLink(it.text);
    const gid = it.gid || (/[?&]disco=([\w.-]+)/.exec(url || it.link || '') ||
                           [])[1];
    if (gid) keys.push(`g:${gid}`);
    keys.push(comment(text));
    // A suggestion that went in as a comment is known as that suggestion
    // too, so resolving the comment resolves the suggestion.
    const bare = flat(text).replace(/^On “[^”]*”(?:, in an earlier version)?: /,
                                    '');
    const was = WENT_IN.map((re) => re.exec(bare)).find(Boolean);
    if (was) keys.push(change(was[2] === undefined ? '' : was[1],
                              was[2] === undefined ? was[1] : was[2]));
    return keys;
}

/**
 * The comment a suggested change goes in as where the text it was made
 * on has changed since, so it cannot be applied: what it suggested, said.
 */
function changeAsComment(it) {
    return (it.quote ? `Suggested replacing “${it.quote}” with ` +
        `“${String(it.insert || '').trim()}”` :
        `Suggested adding “${String(it.insert || '').trim()}”`) +
        '. The text has changed here since it was sent.';
}

/**
 * The texts of comments that a suggested change went in as: one whose
 * text had changed (changeAsComment), and one that could not be held
 * between markers (looseText). The first group is what it would replace,
 * or for an addition what it adds; the second, when there, what it adds.
 */
const CHANGED = '\\. The text has changed here since it was sent\\.$';
const WENT_IN = [
    new RegExp(`^Suggested adding “(.*)”${CHANGED}`),
    new RegExp(`^Suggested replacing “(.*)” with “(.*)”${CHANGED}`),
    /^replace "(.*)" with "(.*)"$/,
];

/**
 * The note in a card's markdown that an imported comment is, when it has
 * no Google Docs link and the comment brings one; null otherwise.
 */
function linkless(md, item) {
    if (!item.link || item.kind === 'change') return null;
    const author = clean(item.author) || 'Reviewer';
    const text = flat(item.text);
    return reviewItems(md).find((x) => {
        if (x.kind === 'suggest' || x.author !== author) return false;
        const { text: said, url } = noteLink(x.text);
        if (url) return false;
        const had = flat(said);
        return had === text || had.endsWith(`: ${text}`);
    }) || null;
}

/** Whether a comment already in `md` would gain its Google Docs link. */
function needsLink(md, item) {
    return !!linkless(md, item);
}

/** `md` with an imported comment's Google Docs link on its note. */
function addLink(md, item) {
    const x = linkless(md, item);
    if (!x) return md;
    const seg = md.slice(x.start, x.end);
    return md.slice(0, x.start) + seg.slice(0, -2) + ` ${item.link}%%` +
        md.slice(x.end);
}

/**
 * Whether an imported item, a comment or change, is already in a card's
 * markdown `md`: one by the same reviewer saying the same, as it would
 * have been written, a comment with its passage quoted included.
 */
function alreadyIn(md, item) {
    const author = clean(item.author) || 'Reviewer';
    const keys = reviewKeys(item);
    return reviewItems(md).some((x) => {
        if (item.gid && reviewKeys(x).includes(`g:${item.gid}`)) {
            return true;
        }
        if (x.author !== author) return false;
        if (item.kind === 'change') {
            // Or as the comment it became where it could not be marked.
            return x.kind === 'suggest' ?
                x.text === clean(item.insert, true) :
                x.text === looseText(item.quote, item.insert);
        }
        const text = flat(item.text);
        const had = flat(noteLink(x.text).text);
        return had === text || had.endsWith(`: ${text}`) ||
            reviewKeys(x).some((k) => keys.includes(k));
    });
}

/**
 * A card's markdown with a suggested change from a program in it, `s`
 * { quote, replace, before?, after?, author?, date }: { md }, or
 * { reason } it was not added. Only where the quote is found exactly,
 * and once, or once given the text around it, since nobody checks where
 * it goes before it is in the card.
 */
function suggestInto(md, id, s) {
    if (Array.isArray(s.row)) return suggestRow(md, s);
    if (s.row !== undefined && s.column !== undefined) {
        return suggestCell(md, s);
    }
    const author = clean(s.author) || 'Claude';
    if (typeof s.replace !== 'string') {
        return { reason: 'no replace: the new text, or "" to delete' };
    }
    const quote = String(s.quote || '');
    if (!quote.trim()) return { reason: 'no quote' };
    const at = locate({ kind: 'suggest', quote, before: s.before,
                        after: s.after }, [{ id, text: md }]);
    // The same change by the same reviewer is refused only where it
    // already is: the same new text may be wanted in two places.
    const text = clean(s.replace, true);
    if (at && at.how === 'exact' && reviewItems(md).some((x) =>
        x.kind === 'suggest' && x.author === author && x.text === text &&
        x.start <= at.start && at.end <= x.end)) {
        return { reason: 'already suggested' };
    }
    if (!at || at.how !== 'exact') {
        if (alreadyIn(md, { kind: 'change', author, quote,
                            insert: s.replace })) {
            return { reason: 'already suggested' };
        }
        const hay = normalise(plainMap(md).text).text;
        const want = normalise(quote).text;
        let n = 0;
        for (let k = hay.indexOf(want); k >= 0;
             k = hay.indexOf(want, k + 1)) n++;
        // In a table cell, a short quote has too little around it to
        // place: say so, and how to name the cell instead.
        if (tableRowsIn(md).some((r) => r.cells.some((c) =>
            normalise(printedCell(c.text)).text.includes(want)))) {
            return { reason: 'found in a table cell, where the text ' +
                'around it cannot place it; send row (its first cell), ' +
                'column (its header, or its number from 1) and was ' +
                'instead of quote' };
        }
        return { reason: n > 1 ? `found ${n} times, so more than once; ` +
            'send before or after to say which' :
            'not found exactly in the card' };
    }
    return { md: addItems(md, [{ kind: 'suggest', start: at.start,
        end: at.end, author, date: s.date, text: s.replace }]) };
}

/**
 * A reviewer's own pending suggestion in a card's markdown, `sel` {
 * quote, the passage it is on; was?, what it suggests; before?, after?;
 * author }: { n, it }, or { reason } there is none to change. One that
 * anyone has replied to is not changed, since the reply is about it.
 */
function findSuggestion(md, sel) {
    const author = clean(sel.author) || 'Claude';
    const quote = String(sel.quote || '');
    const was = sel.was === undefined || sel.was === null ? null :
        flat(String(sel.was));
    let list = reviewItems(md).map((x, n) => ({ x, n })).filter(({ x }) =>
        x.kind === 'suggest' && x.author === author &&
        flat(x.passage || '') === flat(quote) &&
        (was === null || flat(x.text || '') === was));
    if (list.length > 1 && (sel.before || sel.after)) {
        const at = locate({ kind: 'suggest', quote, before: sel.before,
                            after: sel.after }, [{ id: 'card', text: md }]);
        if (at && at.how === 'exact') {
            list = list.filter(({ x }) => x.start <= at.start &&
                at.end <= x.end);
        }
    }
    if (!list.length) {
        return { reason: `no pending suggestion by ${author} on ` +
                         `"${quote}"` };
    }
    if (list.length > 1) {
        return { reason: `${list.length} pending suggestions by ${author} ` +
                         `on "${quote}"; send was, what it suggests, or ` +
                         'before or after' };
    }
    const { x, n } = list[0];
    if ((x.replies || []).length) {
        return { reason: 'someone has replied to it since; reply instead' };
    }
    return { n, it: x };
}

/**
 * A card's markdown with its `n`th review item, a suggestion, now
 * suggesting `text`, dated `date`; its passage and place as they were.
 */
function reviseSuggestion(md, n, text, date) {
    const it = reviewItems(md)[n];
    if (!it || it.kind !== 'suggest') return md;
    const seg = md.slice(it.start, it.end);
    const h = seg.search(PRIORITY);
    const close = h < 0 ? -1 : seg.indexOf('%%', h);
    if (close < 0) return md;
    const tag = priorityTag(md, it.start + h, it.priority);
    const head = `[!suggest${tag}] ${clean(it.author) || 'Reviewer'}, ` +
        `${date}: ` +
        clean(text, true);
    return md.slice(0, it.start + h) + head + md.slice(it.start + close);
}

// A suggested table row: a suggestion with no passage at the end of the
// row it goes beside, its cells after this, between escaped pipes, so
// the table stays whole until it is applied as a line of its own.
const ROW = /^\[row (above|below)\]\s*/;

/** A suggested row's { where, cells }, or null for any other item. */
function rowSuggestion(it) {
    if (!it || it.kind !== 'suggest' || it.passage) return null;
    const m = ROW.exec(it.text || '');
    if (!m) return null;
    return { where: m[1], cells: it.text.slice(m[0].length)
        .split(/\s*\\\|\s*/).map((c) => c.trim()) };
}

/** What a suggestion would do, as its note says it. */
function suggestionText(it) {
    const row = rowSuggestion(it);
    if (row) {
        return `Suggests adding a row ${row.where}: ` +
            row.cells.join(' | ');
    }
    const t = String(it.text || '').trim();
    return !t ? 'Suggests deleting this.' :
        it.passage ? `Suggests: ${t}` : `Suggests adding: ${t}`;
}

/** A cell as it prints: its comments, marks and emphasis left out. */
const printedCell = (t) => t.replace(/%%[\s\S]*?%%/g, '')
    .replace(/==|[*_`~]/g, '').replace(/\s+/g, ' ').trim();

/**
 * The table rows in `md`, the delimiter rows left out: each { start,
 * end } of its line, and its cells { start, end } of their text, which
 * an escaped pipe, `\|`, does not split.
 */
function tableRowsIn(md) {
    const rows = [];
    let at = 0;
    for (const line of md.split('\n')) {
        const lead = /^[ \t]*/.exec(line)[0].length;
        if (line[lead] === '|' && !/^\s*\|?[\s:|-]+$/.test(line)) {
            const cells = [];
            let start = lead + 1;
            for (let i = start; i <= line.length; i++) {
                if (line[i] === '\\') {
                    i++;
                } else if (line[i] === '|' || i === line.length) {
                    const raw = line.slice(start, i);
                    if (i < line.length || raw.trim()) {
                        const a = start + /^\s*/.exec(raw)[0].length;
                        const b = start + raw.replace(/\s+$/, '').length;
                        cells.push({ start: at + a, end: at + Math.max(a, b),
                                     text: line.slice(a, Math.max(a, b)) });
                    }
                    start = i + 1;
                }
            }
            rows.push({ start: at, end: at + line.length, cells });
        }
        at += line.length + 1;
    }
    return rows;
}

/**
 * A card's markdown with a suggested table row in it, `s` { row: [cells],
 * after_row or before_row, author?, date }: { md }, or { reason }. The
 * row it goes beside is named by its first cell or its whole printed
 * text, and must be the only one so named.
 */
function suggestRow(md, s) {
    const author = clean(s.author) || 'Claude';
    const cells = s.row.map((c) => String(c === null || c === undefined ?
        '' : c).trim());
    if (!cells.length) return { reason: 'no cells in row' };
    if (cells.some((c) => /[|\n]|%%/.test(c))) {
        return { reason: 'a cell holds a pipe, a line break or %%' };
    }
    const named = s.after_row !== undefined ? s.after_row : s.before_row;
    if (named === undefined || named === null) {
        return { reason: 'say after_row or before_row: the row it goes ' +
                         'beside, by its first cell or its whole text' };
    }
    const where = s.after_row !== undefined ? 'below' : 'above';
    const want = printedCell(String(named).replace(/^\s*\||\|\s*$/g, ''));
    const found = tableRowsIn(md).filter((r) => {
        const p = r.cells.map((c) => printedCell(c.text));
        return p[0] === want || p.join(' | ') === want;
    });
    if (!found.length) return { reason: `no table row "${want}" in the card` };
    if (found.length > 1) {
        return { reason: `${found.length} table rows match "${want}"; ` +
                         'give the whole row' };
    }
    const row = found[0];
    if (row.cells.length !== cells.length) {
        return { reason: `the row has ${cells.length} cells; the table ` +
                         `has ${row.cells.length} columns` };
    }
    const text = `[row ${where}] ${cells.join(' \\| ')}`;
    if (reviewItems(md).some((x) => x.kind === 'suggest' &&
        x.author === author && x.text === text)) {
        return { reason: 'already suggested' };
    }
    const pos = row.cells[row.cells.length - 1].end;
    return { md: md.slice(0, pos) + itemText('suggest', '', author, s.date,
        text) + md.slice(pos) };
}

/**
 * A card's markdown with a suggested change to one table cell, `s`
 * { row, column, was?, replace, author?, date }: { md }, or { reason }.
 * The row is named by its first cell's printed text, the column by its
 * header's or by its number from 1, and `was` is the part of the cell to
 * change, the whole cell without it. Each must name exactly one.
 */
function suggestCell(md, s) {
    const author = clean(s.author) || 'Claude';
    if (typeof s.replace !== 'string') {
        return { reason: 'no replace: the new text, or "" to delete' };
    }
    if (/\n/.test(s.replace)) {
        return { reason: 'a table cell cannot hold a line break' };
    }
    // Rows grouped into their tables: the next line, or the one after a
    // delimiter row, continues one.
    const tables = [];
    let prev = null;
    for (const row of tableRowsIn(md)) {
        const gap = prev ? md.slice(prev.end, row.start) : null;
        if (!prev || !/^\n(?:[ \t]*\|?[\s:|-]+\n)?$/.test(gap)) {
            tables.push([]);
        }
        tables[tables.length - 1].push(row);
        prev = row;
    }
    const want = normalise(printedCell(String(s.row))).text;
    const hits = [];
    for (const t of tables) {
        for (const row of t.slice(1)) {
            const first = row.cells[0] ? row.cells[0].text : '';
            if (normalise(printedCell(first)).text === want) {
                hits.push({ t, row });
            }
        }
    }
    if (!hits.length) {
        return { reason: `no table row whose first cell is "${s.row}"` };
    }
    if (hits.length > 1) {
        return { reason: `${hits.length} table rows begin "${s.row}"` };
    }
    const { t, row } = hits[0];
    const head = t[0].cells.map((c) => normalise(printedCell(c.text)).text);
    let k = -1;
    if (/^\d+$/.test(String(s.column))) {
        k = Number(s.column) - 1;
    } else {
        const name = normalise(printedCell(String(s.column))).text;
        k = head.indexOf(name);
        if (k < 0 || head.indexOf(name, k + 1) >= 0) {
            return { reason: k < 0 ? `no column "${s.column}"; the ` +
                `headers are ${head.map((h) => `"${h}"`).join(', ')}` :
                `two columns are "${s.column}"; give its number` };
        }
    }
    const cell = row.cells[k];
    if (!cell) {
        return { reason: `the row has ${row.cells.length} cells, not ` +
                         `${k + 1}` };
    }
    // The part of the cell to change, found in its printed text.
    const src = md.slice(cell.start, cell.end);
    const plain = plainMap(src);
    const norm = normalise(plain.text);
    const shown = norm.text;
    const was = s.was !== undefined && s.was !== null ?
        normalise(String(s.was)).text : shown;
    const at = shown.indexOf(was);
    if (!was || at < 0) {
        return { reason: `the cell reads "${printedCell(src)}"` +
            (was ? `, not "${s.was}"` : '; it is empty') };
    }
    if (shown.indexOf(was, at + 1) >= 0) {
        return { reason: `"${s.was}" is in the cell more than once` };
    }
    const start = cell.start + plain.map[norm.map[at]];
    const end = cell.start + plain.map[norm.map[at + was.length - 1]] + 1;
    // A pipe in the new text would end the cell.
    const text = s.replace.replace(/(^|[^\\])\|/g, '$1\\|');
    if (reviewItems(md).some((x) => x.kind === 'suggest' &&
        x.author === author && x.text === clean(text, true) &&
        x.start <= start && end <= x.end)) {
        return { reason: 'already suggested' };
    }
    return { md: addItems(md, [{ kind: 'suggest', start, end, author,
        date: s.date, text }]) };
}

/** `md` with a suggested row's line put beside the line holding `at`. */
function withRow(md, at, row) {
    const start = md.lastIndexOf('\n', at - 1) + 1;
    const nl = md.indexOf('\n', at);
    const end = nl < 0 ? md.length : nl;
    const indent = /^[ \t]*/.exec(md.slice(start))[0];
    const line = `${indent}| ${row.cells.join(' | ')} |`;
    return row.where === 'below' ?
        md.slice(0, end) + '\n' + line + md.slice(end) :
        md.slice(0, start) + line + '\n' + md.slice(start);
}

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
 * A card's markdown with comments added: `adds` is [{ kind, start, end,
 * author, date, text }] at offsets in `md`. A passage is held between
 * markers, its ends moved out of a link or another comment's syntax, and
 * a comment in the old form that it overlaps is converted too; a
 * suggestion whose passage would leave half of some markup behind is
 * kept as a comment after it, quoting what it would replace.
 */
function addItems(md, adds) {
    const pending = [...adds].map((a) => ({ ...a }))
        .sort((a, b) => b.end - a.end || b.start - a.start);
    let out = md;
    // One change to the text, every offset still to use moved with it.
    const edit = (pos, del, ins) => {
        out = out.slice(0, pos) + ins + out.slice(pos + del);
        const move = (p) => (p <= pos ? p : p >= pos + del ?
            p + ins.length - del : pos + ins.length);
        for (const a of pending) {
            a.start = move(a.start);
            a.end = move(a.end);
        }
    };
    while (pending.length) {
        const a = pending[0];
        const point = a.end === a.start;
        const items = reviewItems(out);
        // A comment the passage overlaps, or that a point falls inside.
        const over = items.filter((x) => (point ?
            x.start < a.end && a.end < x.end :
            a.start < x.end && x.start < a.end));
        const markable = !point && (a.kind !== 'suggest' ||
            balanced(stripReview(out.slice(a.start, a.end))));
        let text = a.text;
        let kind = a.kind;
        if (markable) {
            // The comments it overlaps held between markers as well, so
            // each keeps its own text.
            for (const x of over.filter((y) => !y.open)
                .sort((p, q) => q.start - p.start)) {
                const id = nextId(out);
                edit(x.noteStart - 2, 4, `%%}${id} `);
                edit(x.start, 2, `%%{${id}%%`);
            }
            snapOut(out, a);
            const id = nextId(out);
            edit(a.end, 0, itemText(kind, '', a.author, a.date, text)
                .replace(/^%%/, `%%}${id} `));
            edit(a.start, 0, `%%{${id}%%`);
            pending.shift();
            continue;
        }
        // A suggestion that cannot be marked, as on half of some bold,
        // can no longer be applied safely, so it is kept as a comment
        // saying what it was; an insertion needs no mark.
        const loose = kind === 'suggest' && !point;
        if (loose) {
            text = looseText(a.quote || out.slice(a.start, a.end), a.text);
            kind = 'review';
        }
        // Not inside another comment: after it.
        const inside = items.filter((x) => (x.open ?
            x.noteStart < a.end && a.end < x.end :
            x.start < a.end && a.end < x.end));
        const at = Math.max(a.end, ...inside.map((x) => x.end));
        edit(at, 0, itemText(kind, '', a.author, a.date, text));
        pending.shift();
    }
    return out;
}

/** How many of a card's comments are in the old, highlighted form. */
function oldComments(md) {
    return scan(md).items.filter((x) => x.old !== undefined).length;
}

/**
 * A card's markdown with each comment in the old form, ==passage== then
 * its note, held between markers instead; the text is unchanged.
 */
function convertOld(md) {
    const olds = scan(md).items.filter((x) => x.old !== undefined);
    const first = Number(nextId(md));
    let out = md;
    for (let k = olds.length - 1; k >= 0; k--) {
        const x = olds[k];
        const id = String(first + k);
        out = out.slice(0, x.noteStart - 2) + `%%}${id} ` +
            out.slice(x.noteStart + 2);
        out = out.slice(0, x.start) + `%%{${id}%%` + out.slice(x.start + 2);
    }
    return out;
}

/** The next free marker id in a card's markdown. */
function nextId(md) {
    let n = 0;
    for (const m of md.matchAll(/%%[{}](\d+)/g)) n = Math.max(n, +m[1]);
    return String(n + 1);
}

/** Whether a passage's own markup opens and closes within it. */
function balanced(t) {
    const count = (re) => (t.match(re) || []).length;
    return count(/\*\*/g) % 2 === 0 && count(/`/g) % 2 === 0 &&
        count(/\[\[/g) === count(/\]\]/g) && count(/\[/g) === count(/\]/g);
}

/**
 * A passage's ends moved out of anything a marker would break, a link,
 * code, a citation or footnote, a tag, or a comment's own syntax: its
 * start to before it, its end to after.
 */
function snapOut(md, a) {
    const spans = scan(md).syntax.slice();
    const re = /\[\[[^\]\n]*\]\]|`[^`\n]*`|\^?\[[@^-][^\]\n]*\]|<[^>\n]+>/g;
    let m;
    while ((m = re.exec(md))) spans.push([m.index, m.index + m[0].length]);
    for (const [s, e] of spans) {
        if (s < a.start && a.start < e) a.start = s;
        if (s < a.end && a.end < e) a.end = e;
    }
}

/**
 * A card's markdown with its `n`th review comment (from 0) taken out,
 * its passage left as it was; with `apply`, a suggestion's new text put
 * in place of the passage instead.
 */
function removeItem(md, n, apply = false) {
    const it = reviewItems(md)[n];
    if (!it) return md;
    if (apply && it.kind === 'suggest') {
        const row = rowSuggestion(it);
        return row ? withRow(removeItem(md, n), it.start, row) :
            applied(md, it).out;
    }
    if (!it.open) return md.slice(0, it.start) + it.passage +
        md.slice(it.end);
    // Between its markers: other comments' markers and notes are kept.
    return md.slice(0, it.open.start) +
        md.slice(it.open.end, it.noteStart) + md.slice(it.end);
}

/**
 * A suggestion applied, its note and replies gone: { out, start, end },
 * `start` to `end` its new text in `out`, with any other comments'
 * markers and notes that were inside its passage after it.
 */
function applied(md, it) {
    if (!it.open) {
        const out = md.slice(0, it.start) + it.text + md.slice(it.end);
        return tidySpan(out, it.start, it.start + it.text.length);
    }
    const { syntax } = scan(md);
    const kept = syntax.filter(([a, b]) => a >= it.open.end &&
        b <= it.noteStart).map(([a, b]) => md.slice(a, b)).join('');
    const out = md.slice(0, it.open.start) + it.text + kept +
        md.slice(it.end);
    const s = it.open.start;
    return tidySpan(out, s, s + it.text.length + kept.length);
}

/** A comment's replies that say something: not seen marks. */
function keptReplies(it) {
    return (it.replies || []).filter((x) => x.text);
}

/**
 * A card's markdown with its `n`th review comment, a suggestion, applied
 * and, where it has replies that say something, kept open as a comment
 * by its reviewer on the new text, saying what it replaced, with those
 * replies under it. Seen marks are left out.
 */
function applyKeeping(md, n) {
    const it = reviewItems(md)[n];
    if (!it || it.kind !== 'suggest' || !keptReplies(it).length ||
        rowSuggestion(it)) {
        return removeItem(md, n, true);
    }
    let { out, start, end } = applied(md, it);
    while (start < end && /\s/.test(out[start])) start++;
    while (end > start && /\s/.test(out[end - 1])) end--;
    const text = it.passage.trim() ?
        `Applied. Was “${clean(it.passage)}”.` : 'Applied, as an addition.';
    out = addItems(out, [{ kind: 'review', start, end, author: it.author,
                           date: it.date, text }]);
    const k = reviewItems(out).findIndex((x) => x.kind === 'review' &&
        x.author === (clean(it.author) || 'Reviewer') &&
        x.text === text && x.start >= start - 2);
    for (const x of keptReplies(it)) out = addReply(out, k, x);
    return out;
}

/**
 * Text a change was applied to, `start` to `end` its new text, with no
 * doubled space or space before punctuation where it joins the rest: a
 * reviewer's deletion or a passage placed without the space beside it
 * leaves one, and Apply is to be relied on to give clean text. Returned
 * as { out, start, end }, the new text's span moved with it.
 */
function tidySpan(out, start, end) {
    if (out[end - 1] === ' ' && /^[ .,;:!?)]/.test(out.slice(end))) {
        out = out.slice(0, end - 1) + out.slice(end);
        if (start >= end) start--;
        end--;
    }
    if (out[start - 1] === ' ' && out[start] === ' ') {
        out = out.slice(0, start - 1) + out.slice(start);
        start--;
        end--;
    }
    return { out, start, end };
}

/**
 * What the card editor draws in place of a card's comment syntax, as
 * offsets: `hide` each start marker, `chips` each note with its replies
 * ({ from, to, n, author, date, kind, text, passage, replies, first },
 * numbered as on the board; `passage` whether it marks one, `first`
 * false for a Google comment's later passages, shown under the first),
 * `marks` each passage held between markers ({ from, to, author, kind }),
 * and `protect`, every range typing must not change.
 */
function editorRanges(md) {
    const items = reviewItems(md);
    const hide = items.filter((x) => x.open)
        .map((x) => [x.open.start, x.open.end]).sort((a, b) => a[0] - b[0]);
    const numbers = new Map();
    let n = 0;
    const firsts = firstOfComment(items);
    const chips = items.map((x, i) => {
        const g = googleOf(x);
        let num = g && numbers.get(g);
        if (!num) {
            num = ++n;
            if (g) numbers.set(g, num);
        }
        return { from: x.noteStart, to: x.end, n: num, author: x.author,
                 date: x.date, kind: x.kind, text: x.text,
                 passage: !!x.passage, replies: x.replies,
                 priority: x.priority, first: firsts[i] === i };
    });
    const marks = items.filter((x) => x.open).map((x) => ({
        from: x.open.end, to: x.noteStart, author: x.author,
        kind: x.kind }));
    // A table's rows are left alone, though their comments are counted:
    // Obsidian draws a table as one piece and edits each cell in an
    // editor of its own, which draws and holds the cell's comments
    // (editor.js). Drawn or held here as well, a cell's change copied
    // back was split around the held pieces, doubling its comment, and
    // the table was drawn again under the cell being typed in.
    const rows = tableRowsIn(md).map((t) => [t.start, t.end]);
    const out = ([a, b]) => !rows.some(([s, e]) => a <= e && b >= s);
    const keep = { hide: hide.filter(out),
                   chips: chips.filter((c) => out([c.from, c.to])),
                   marks: marks.filter((m) => out([m.from, m.to])) };
    const protect = [...keep.hide, ...keep.chips.map((c) => [c.from, c.to])]
        .sort((a, b) => a[0] - b[0]);
    return { ...keep, protect };
}

/**
 * The comments an edit left marking no text, that marked some before:
 * [{ n, author, text }], `n` its number in the card after. A comment is
 * matched across the edit by its note, which typing cannot change.
 */
function passagesLost(before, after) {
    const key = (x) => `${x.kind}\u0000${x.author}\u0000${x.date}\u0000` +
        x.text;
    const had = new Map();
    for (const x of reviewItems(before)) {
        if (!x.passage.trim()) continue;
        had.set(key(x), (had.get(key(x)) || 0) + 1);
    }
    const lost = [];
    reviewItems(after).forEach((x, i) => {
        const k = key(x);
        if (x.passage.trim() || !had.get(k)) return;
        had.set(k, had.get(k) - 1);
        lost.push({ n: i + 1, author: x.author, text: x.text });
    });
    return lost;
}

/** Markdown for export: review comments out, their passages kept. */
function stripReview(md) {
    return without(md, 0, md.length, scan(md).syntax);
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
/** A review comment's Google comment, 'g:' and its id, or null. */
function googleOf(it) {
    if (it.kind === 'suggest' || it.kind === 'change') return null;
    return reviewKeys(it).find((k) => k.startsWith('g:')) || null;
}

/**
 * For each of a card's review items, the index of the first one that is
 * the same Google comment, itself where it is the first or has none: a
 * Google comment on several passages comes in as one per passage.
 */
function firstOfComment(items) {
    const seen = new Map();
    return items.map((it, i) => {
        const g = googleOf(it);
        if (!g) return i;
        if (!seen.has(g)) seen.set(g, i);
        return seen.get(g);
    });
}

/** How many comments and changes, a Google comment counted once. */
function countComments(items) {
    return firstOfComment(items).filter((f, i) => f === i).length;
}

function renderMarkdown(md, colourOf = null, keep = null) {
    let n = 0;
    // A Google comment on several passages keeps one number for them.
    const numbers = new Map();
    const { items } = scan(md);
    // A start marker is drawn knowing whose comment it opens.
    const byId = new Map(items.filter((x) => x.id).map((x) => [x.id, x]));
    // Which comments are drawn, by their index, as reviewItems counts
    // them; the rest are left as their text, unmarked and unnumbered.
    const kept = (k) => !keep || keep(k);
    const tintOf = (body) => {
        const h = HEAD.exec(body.replace(/^\s+/, ''));
        const c = colourOf && h ? colourOf(h[1]) : null;
        return c ? ` is-c-${c}` : '';
    };
    SCAN.lastIndex = 0;
    // Which comment each number is, as reviewItems counts them: a Google
    // comment's passages share one number, so the number cannot say.
    let item = -1;
    return md.replace(SCAN, (m, openId, passage, id, kind, body) => {
        if (openId !== undefined) {
            const it = byId.get(openId);
            if (!it || !kept(items.indexOf(it))) return '';
            return '<span class="dendrite-review-from dendrite-rid-' +
                `${openId}${it.kind === 'suggest' ? ' is-suggest' : ''}` +
                `${tintOf(it.body)}"></span>`;
        }
        item++;
        const marked = id !== undefined && byId.has(id);
        if (!kept(item)) return marked ? '' : passage || '';
        const g = kind === 'review' ? googleOf({ kind, text:
            (HEAD.exec(body.replace(/^\s+/, '')) || [])[3] || body }) : null;
        let num;
        if (g && numbers.has(g)) num = numbers.get(g);
        else {
            num = ++n;
            if (g) numbers.set(g, num);
        }
        const h = HEAD.exec(body.replace(/^\s+/, ''));
        const text = h ? h[3] : body.trim();
        // The reviewer's colour, where the manuscript gives them one.
        const tint = tintOf(body);
        const rid = marked ? ` dendrite-rid-${id}` : '';
        const cls = (kind === 'suggest' ? ' is-suggest' : '') + tint;
        const sup = `<sup class="dendrite-review-n${cls}${rid} ` +
            `dendrite-item-${item}">${num}</sup>`;
        // Between markers: the end of its passage, which is marked once
        // drawn (wrapPassages), then what it adds and its number.
        const upto = marked ?
            `<span class="dendrite-review-upto${rid}"></span>` : '';
        if (kind === 'suggest' && (marked || !passage)) {
            if (marked && !text) return upto + sup;
            // A row to add is drawn by its number alone: its cells are
            // said in its note, since in a cell they would read as text.
            if (!marked && ROW.test(text)) return sup;
            // An insertion's leading space is the text's, not the mark's.
            const lead = /^\s*/.exec(text)[0];
            // Within another's passage, the space is held apart so it is
            // not marked as that passage's text.
            const gap = lead && marked ?
                `<span class="dendrite-review-lead">${lead}</span>` : lead;
            return `${upto}${gap}<span class="dendrite-review-new` +
                `${tint}${rid}">${text.slice(lead.length)}</span>${sup}`;
        }
        if (marked) return upto + sup;
        if (!passage) return sup;
        if (kind === 'suggest') {
            const added = text ?
                `<span class="dendrite-review-new${tint}">${text}</span>` : '';
            return `<span class="dendrite-review-old${tint}">${passage}` +
                '</span>' + added + sup;
        }
        return `<mark class="dendrite-review-mark${tint}">${passage}</mark>` +
            sup;
    });
}

/**
 * The elements a card's `n`th comment marks once drawn (renderMarkdown,
 * wrapPassages): its passage, every piece of it where it is held between
 * markers, a suggestion's old and new text, and its number; none if it
 * is not drawn.
 */
function passageEls(root, n) {
    const sup = root.querySelector(`sup.dendrite-item-${n}`);
    if (!sup) return [];
    // Held between markers: every piece drawn for it, by its id.
    const rid = [...sup.classList].find((c) => c.startsWith('dendrite-rid-'));
    if (rid) {
        return [...root.querySelectorAll(`.${rid}`)].filter((x) =>
            !/\bdendrite-review-(from|upto)\b/.test(x.className));
    }
    const out = [sup];
    for (let p = sup.previousElementSibling; p &&
         /\bdendrite-review-(mark|old|new)\b/.test(p.className);
         p = p.previousElementSibling) out.unshift(p);
    return out;
}

/**
 * Mark each passage held between markers, once its card is rendered:
 * every piece of text from its start marker to its end, in its
 * reviewer's colour, so it may run through bold or a link and nest
 * inside another comment's where the two overlap.
 */
function wrapPassages(root) {
    const doc = root.ownerDocument;
    const SHOW_TEXT = 4;
    for (const from of root.querySelectorAll('span.dendrite-review-from')) {
        const rid = [...from.classList].find((c) =>
            c.startsWith('dendrite-rid-'));
        const upto = rid && root.querySelector(
            `span.dendrite-review-upto.${rid}`);
        if (!upto) continue;
        const texts = [];
        const walk = doc.createTreeWalker(root, SHOW_TEXT);
        for (let t = walk.nextNode(); t; t = walk.nextNode()) {
            if (!(from.compareDocumentPosition(t) & 4) ||
                !(upto.compareDocumentPosition(t) & 2)) continue;
            // Not another comment's number or added text, nor the space
            // between blocks.
            if (t.parentElement.closest('sup.dendrite-review-n, ' +
                '.dendrite-review-new, .dendrite-review-lead')) continue;
            if (!t.nodeValue.trim() && t.nodeValue.includes('\n')) continue;
            texts.push(t);
        }
        const suggest = from.classList.contains('is-suggest');
        const tint = [...from.classList].filter((c) => c.startsWith('is-c-'));
        for (const t of texts) {
            const w = doc.createElement(suggest ? 'span' : 'mark');
            w.className = [suggest ? 'dendrite-review-old' :
                'dendrite-review-mark', ...tint, rid].join(' ');
            t.parentNode.insertBefore(w, t);
            w.appendChild(t);
        }
    }
}

// ---- a colour per reviewer -------------------------------------------

/**
 * The theme's colours a reviewer can take, in the order they are given
 * out; Obsidian's --color-<name>.
 */
const REVIEWER_COLOURS = ['blue', 'green', 'purple', 'orange', 'cyan',
                          'pink', 'yellow', 'red', 'grey'];

/**
 * The colours given out to reviewers not yet given one: all but grey,
 * which is there to choose, as for your own comments, to quieten them.
 */
const GIVEN_COLOURS = REVIEWER_COLOURS.filter((c) => c !== 'grey');

/** A reviewer colour as CSS: the theme's colour, or its muted text. */
function colourCss(c) {
    return c === 'grey' ? 'var(--text-muted)' : `var(--color-${c})`;
}

/**
 * A manuscript's reviewer colours from its property, a list of
 * "Name: colour"; entries not of that form, or naming no theme colour,
 * are passed over. A name may be a link to the person's note, [[Name]],
 * read as the note's name.
 */
function reviewerColours(list) {
    const out = new Map();
    for (const [name, , c] of colourEntries(list)) {
        if (REVIEWER_COLOURS.includes(c)) out.set(name, c);
    }
    return out;
}

/**
 * The property's entries as [name, the name as written, colour, note]:
 * `note` the path of the person's note it links to, or null.
 */
function colourEntries(list) {
    const out = [];
    for (const x of Array.isArray(list) ? list : []) {
        const m = /^(.+):\s*([a-z]+)\s*$/.exec(String(x).trim());
        if (!m) continue;
        const written = m[1].trim();
        const link = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/
            .exec(written);
        const note = link ? link[1].trim() : null;
        const name = link ? (link[2] || '').trim() ||
            note.split('/').pop() : written;
        out.push([name, written, m[2], note]);
    }
    return out;
}

/**
 * Who each reviewer name linked to a person's note is, by the note's
 * name: "Aly Karsan 2" linked to [[Aly Karsan]] is Aly Karsan.
 */
function reviewerNames(list) {
    const out = new Map();
    for (const [name, , , note] of colourEntries(list)) {
        if (note) out.set(name, note.split('/').pop());
    }
    return out;
}

/** Reviewers as the property keeps them: [{ name, note, colour }]. */
function reviewerEntries(list) {
    return colourEntries(list).filter(([, , c]) =>
        REVIEWER_COLOURS.includes(c)).map(([name, , colour, note]) =>
        ({ name, note, colour }));
}

/**
 * The property from reviewers [{ name, note, colour }]: one with a note
 * as a link to it, aliased with their name where the note's differs.
 */
function entryList(entries) {
    return entries.map(({ name, note, colour }) => {
        if (!note) return `${name}: ${colour}`;
        const base = note.split('/').pop();
        return `[[${note}${base === name ? '' : `|${name}`}]]: ${colour}`;
    });
}

/**
 * The property from reviewer colours; a name written as a link in
 * `prior`, the property as it was, kept as written.
 */
function colourList(map, prior = []) {
    const written = new Map(colourEntries(prior).map(([n, w]) => [n, w]));
    return [...map].map(([name, c]) => `${written.get(name) || name}: ${c}`);
}

/**
 * Colours for reviewers without one: each the first not yet taken, in
 * the order given, or once all are taken, the next in turn. One given a
 * colour keeps it, so a reviewer added later moves no one. Answers
 * { map, added }.
 */
function assignColours(map, names) {
    const out = new Map(map);
    let added = false;
    for (const name of names) {
        if (!name || out.has(name)) continue;
        const taken = new Set(out.values());
        out.set(name, GIVEN_COLOURS.find((c) => !taken.has(c)) ||
            GIVEN_COLOURS[out.size % GIVEN_COLOURS.length]);
        added = true;
    }
    return { map: out, added };
}

/**
 * A review item's buttons, as [action, label, tooltip, by?]: `by` the
 * name of whoever suggests resolving the comment, lit in their colour; a
 * suggestion
 * applied or dismissed; a comment resolved, dealt with and remembered so
 * a pull does not bring it back.
 */
function commentActions(it) {
    if (it.kind === 'suggest') {
        return [['apply', 'Apply…', ''], ['dismiss', 'Dismiss', '']];
    }
    if (readyToResolve(it)) {
        const r = it.replies[it.replies.length - 1];
        const who = r.author || 'Claude';
        return [['resolve', 'Resolve', `${who} thinks this is done. ` +
                 'Dealt with: taken out, and not brought back by a pull',
                 who]];
    }
    return [['resolve', 'Resolve', 'Dealt with: taken out, and not ' +
             'brought back by a pull']];
}

/**
 * A review item's right-click menu, as [action, label, warning]: what
 * its buttons do, and Delete from Dendrite, which takes it out of the
 * card only, as one misplaced, not remembered, so a pull offers it
 * again; a deletion, so shown as a warning.
 */
function commentMenu(it) {
    return [...commentActions(it).map(([what, label]) =>
        [what, label, false]), ['delete', 'Delete from Dendrite', true]];
}

// Replies being written, by `card/thread`, so a card drawn again, as
// after a sync, puts its box back with what was typed.
const drafts = new Map();
// The draft whose box had the keys, to give them back after a redraw.
let typingIn = null;

/** A comment's key among the drafts: its card and its thread id. */
function draftKey(place, it) {
    return place ? `${place}/${threadId(it)}` : null;
}

/**
 * A box under a comment to write a reply in, sent with Send or Ctrl+Enter
 * and thrown away with Cancel; `send(text)` is given what was written.
 * Escape closes an empty box and only leaves one written in, so nothing
 * typed is lost to it. `typing(el)`, if given, is told of the box, so the
 * keys typed in it stay in it. With `key`, what is typed is kept as a
 * draft until it is sent or cancelled; `focus` false opens it without
 * taking the keys, as when a draft is put back.
 */
function replyBox(parent, send, typing = null, start = '', key = null,
                  focus = true) {
    const doc = parent.ownerDocument;
    const old = parent.querySelector(':scope > .dendrite-review-reply-form');
    if (old) {
        old.querySelector('textarea').focus();
        return old;
    }
    const form = doc.createElement('div');
    form.className = 'dendrite-review-reply-form';
    const box = doc.createElement('textarea');
    box.className = 'dendrite-review-reply-box';
    box.rows = 2;
    box.placeholder = 'Reply';
    box.value = key && drafts.has(key) ? drafts.get(key) : start;
    if (key) {
        box.addEventListener('input', () => drafts.set(key, box.value));
        box.addEventListener('focus', () => { typingIn = key; });
        box.addEventListener('blur', () => {
            if (typingIn === key) typingIn = null;
        });
    }
    const row = doc.createElement('div');
    row.className = 'dendrite-review-reply-btns';
    const go = doc.createElement('button');
    go.className = 'dendrite-review-btn mod-cta';
    go.textContent = 'Send';
    const no = doc.createElement('button');
    no.className = 'dendrite-review-btn';
    no.textContent = 'Cancel';
    // Blurred first, so whatever held the keys for it lets them go.
    const done = () => {
        if (key) drafts.delete(key);
        box.blur();
        form.remove();
    };
    // Sent once, though Ctrl+Enter may reach it both as the hotkey the
    // box holds and as the key itself.
    let sent = false;
    go.onclick = async (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const t = box.value.trim();
        if (!t || sent) return;
        sent = true;
        done();
        await send(t);
    };
    box.dendriteSend = () => go.onclick();
    no.onclick = (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        done();
    };
    box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            go.onclick();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            if (box.value.trim() && box.value !== start) box.blur();
            else done();
        }
        e.stopPropagation();
    });
    for (const ev of ['click', 'dblclick', 'pointerdown']) {
        form.addEventListener(ev, (e) => e.stopPropagation());
    }
    row.append(go, no);
    form.append(box, row);
    parent.append(form);
    if (typing) typing(box);
    if (focus) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
    }
    return form;
}

/**
 * Put back the reply box of comment `it`, under `parent`, where a draft
 * of it is kept; with the keys, if they were in it when it was redrawn.
 */
function restoreDraft(parent, it, place, send, typing = null) {
    const key = draftKey(place, it);
    if (!key || !drafts.has(key)) return;
    const had = typingIn === key;
    const form = replyBox(parent, send, typing, '', key, false);
    const box = form.querySelector('textarea');
    if (had && box.isConnected) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
    }
}

/**
 * Under each paragraph of a rendered card, a callout for each review
 * comment in it, numbered as in the text. `act(n, what)` is called with
 * the comment's index and 'resolve' or, for a suggestion, 'apply' or
 * 'dismiss'.
 */
/**
 * A reviewer's name in `el`: the person it is linked to, the name as
 * the review wrote it on hover when that differs.
 */
function shownAs(el, name, nameOf) {
    const shown = (nameOf && nameOf(name)) || name;
    el.textContent = shown;
    if (shown !== name) el.title = `As written: ${name}`;
}

function decorate(root, items, act, onMenu = null, colourOf = null,
                  typing = null, nameOf = null, place = null,
                  linkOf = null) {
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
    // One callout for a Google comment on several passages: at its first.
    const first = firstOfComment(items);
    const passages = (i) => first.filter((f) => f === i).length;
    items.forEach((it, i) => {
        if (first[i] !== i) return;
        const sup = nums[i];
        const b = sup ? blockOf(sup) : null;
        if (!blocks.has(b)) blocks.set(b, []);
        blocks.get(b).push(i);
    });
    const noteOf = new Map();
    for (const [b, list] of blocks) {
        const box = doc.createElement('div');
        box.className = 'dendrite-review-notes';
        for (const i of list) {
            const it = items[i];
            const note = doc.createElement('div');
            const c = colourOf && colourOf(it.author || 'Reviewer');
            note.className = 'dendrite-review-note' +
                (it.kind === 'suggest' ? ' is-suggest' : '') +
                (c ? ` is-c-${c}` : '');
            const n = doc.createElement('span');
            n.className = 'dendrite-review-n';
            n.textContent = nums[i] ? nums[i].textContent : String(i + 1);
            const main = doc.createElement('div');
            main.className = 'dendrite-review-main';
            const meta = doc.createElement('div');
            meta.className = 'dendrite-review-meta';
            const who = doc.createElement('b');
            shownAs(who, it.author || 'Reviewer', nameOf);
            // Its priority, set from a menu the board shows.
            const chip = priorityChip(doc, it.priority);
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                act(i, 'priority-menu', e);
            });
            meta.append(chip, who, ` · ${shortDate(it.date)}`);
            if (passages(i) > 1) meta.append(` · ${passages(i)} passages`);
            const text = doc.createElement('div');
            text.className = 'dendrite-review-text';
            const { text: said, url } = noteLink(it.text);
            if (url && it.kind !== 'suggest') {
                const a = doc.createElement('a');
                a.className = 'dendrite-review-link';
                a.href = url;
                a.textContent = '↗';
                a.title = 'Open this comment in Google Docs';
                // Opened outside Obsidian, never in the window it is in.
                a.target = '_blank';
                a.rel = 'noopener nofollow';
                a.addEventListener('click', (e) => e.stopPropagation());
                meta.append(' ', a);
            }
            if (it.kind !== 'suggest') {
                fillAddressed(text, said, colourOf, linkOf);
            } else text.textContent = suggestionText(it);
            main.append(meta, text);
            // Its replies, under it, each with its own right-click menu,
            // a seen mark among them; Claude's with a reply to Claude.
            (it.replies || []).forEach((r, k) => {
                const el = replyRow(doc, r, nameOf, colourOf, linkOf);
                if (onMenu) {
                    el.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onMenu(i, e, k);
                    });
                }
                if (r.author === 'Claude') {
                    const btn = doc.createElement('button');
                    btn.className = 'dendrite-review-btn';
                    btn.textContent = 'Reply to Claude';
                    btn.title = 'For Claude only: not sent to the reviewer';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        replyBox(main, (t) => act(i, 'reply', t), typing,
                                 '@Claude ', draftKey(place, it));
                    });
                    const bar = doc.createElement('span');
                    bar.className = 'dendrite-review-acts';
                    bar.append(btn);
                    el.prepend(bar);
                }
                main.append(el);
            });
            note.append(n, main);
            foldable(note, meta, it);
            const buttons = [...commentActions(it),
                             ['reply', 'Reply', 'Answer this comment']];
            // Its menu on a right-click, its own, not the card's.
            if (onMenu) {
                note.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onMenu(i, e);
                });
            }
            // At the right of the name line, so the text under it runs
            // the full width of the card.
            const bar = doc.createElement('span');
            bar.className = 'dendrite-review-acts';
            main.prepend(bar);
            for (const [what, label, tip, by] of buttons) {
                const btn = doc.createElement('button');
                const bc = by && colourOf && colourOf(by);
                btn.className = 'dendrite-review-btn' +
                    (by ? ' is-suggested' : '') + (bc ? ` is-c-${bc}` : '');
                btn.textContent = label;
                if (tip) btn.title = tip;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (what === 'reply') replyBox(main, (t) =>
                        act(i, 'reply', t), typing, '', draftKey(place, it));
                    else act(i, what);
                });
                bar.append(btn);
            }
            restoreDraft(main, it, place, (t) => act(i, 'reply', t), typing);
            box.append(note);
            noteOf.set(i, note);
        }
        if (b) b.after(box);
        else root.append(box);
    }
    // Pointing at a comment marks its passages, all of a Google comment's,
    // and pointing at a passage or its number marks its comment; the other
    // comments are dimmed meanwhile. Shown in the selected card only.
    const hover = (i, on) => {
        root.classList.toggle('has-hover', on);
        const note = noteOf.get(i);
        if (note) note.classList.toggle('is-hover', on);
        items.forEach((_, j) => {
            if (first[j] !== i) return;
            for (const el of passageEls(root, j)) {
                el.classList.toggle('is-hover', on);
            }
        });
    };
    for (const [i, note] of noteOf) {
        note.addEventListener('mouseenter', () => hover(i, true));
        note.addEventListener('mouseleave', () => hover(i, false));
    }
    items.forEach((_, j) => {
        for (const el of passageEls(root, j)) {
            el.addEventListener('mouseenter', () => hover(first[j], true));
            el.addEventListener('mouseleave', () => hover(first[j], false));
        }
    });
}

module.exports = { readReview, readReviewJson, readBody, readComments,
                   reviewerNames, shownAs, wrapPassages, editorRanges,
                   passagesLost, changeAsComment, alignWords, mapThrough,
                   passageEls,
                   oldComments, convertOld,
                   plainMap, offsetAt, textAround, paragraphEnd,
                   normalise, locate, reviewItems, alreadyIn,
                   noteLink, reviewKeys, needsLink, addLink,
                   commentActions, commentMenu, googleData, googleOf,
                   REVIEWER_COLOURS, colourCss, reviewerColours, colourList,
                   assignColours, reviewerEntries, entryList,
                   addReply, removeReply, replyBox, threadId,
                   readyToResolve, draftKey, restoreDraft, foldable,
                   fillLinked, rowSuggestion, suggestionText,
                   findSuggestion, reviseSuggestion,
                   threadIds, forReviewers, replyRow,
                   addressed, awaits, passesFilter, setPriority, PRIORITIES,
                   setFoldUntilClicked, priorityChip, mendSplitTags,
                   replaceReplies, fillAddressed,
                   suggestInto,
                   firstOfComment, countComments,
                   itemText,
                   addItems, removeItem, applyKeeping, keptReplies,
                   stripReview, renderMarkdown, decorate,
                   shortDate };
