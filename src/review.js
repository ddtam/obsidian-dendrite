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
                para = { text: '', changes: [] };
            }
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
                     when: note.when,
                     text: note.text, quote,
                     before: sp.slice(Math.max(0, r.start.o - CONTEXT),
                                      r.start.o),
                     after: ep.slice(end.o, end.o + CONTEXT),
                     at: [r.start.p, r.start.o],
                     ...(paras[r.start.p].heading ? { heading: true } :
                         {}) });
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
 * after the text before it. One on a heading is looked for only in the
 * cards' headings, so it is not taken for the same words in a table.
 */
function locate(item, cards) {
    if (item.card) {
        const k = item.card;
        cards = cards.filter((c) => c.id === k || c.id.endsWith('-' + k));
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

// A comment or suggested change, its passage, and the replies to it,
// each written straight after it: %%[!reply] Author, date: text%%.
const ITEM = new RegExp('(?:==([^=\\n]+?)==)?%%\\[!(review|suggest)\\]' +
    '\\s*([\\s\\S]*?)%%((?:%%\\[!reply\\][\\s\\S]*?%%)*)', 'g');
const REPLY = /%%\[!reply\]\s*([\s\S]*?)%%/g;
const HEAD = /^(.*?),\s*(\d{4}-\d{2}-\d{2}):\s?([\s\S]*)$/;

/** The replies written after a comment: [{ author, date, text }]. */
function readReplies(chunk) {
    const out = [];
    REPLY.lastIndex = 0;
    let m;
    while ((m = REPLY.exec(chunk || ''))) {
        const h = HEAD.exec(m[1].replace(/^\s+/, ''));
        out.push({ author: h ? h[1] : '', date: h ? h[2] : '',
                   text: (h ? h[3] : m[1]).trim() });
    }
    return out;
}

/**
 * The review comments in a card's markdown, in order: { kind: 'review'
 * or 'suggest', passage, author, date, text, replies, start, end }, with
 * the offsets of the whole of it, highlight and replies included.
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
                   replies: readReplies(m[4]),
                   start: m.index, end: m.index + m[0].length });
    }
    return out;
}

/**
 * A card's markdown with a reply { author, date, text } to its `n`th
 * review comment, after the replies it has.
 */
function addReply(md, n, reply) {
    const it = reviewItems(md)[n];
    if (!it) return md;
    const note = `%%[!reply] ${clean(reply.author) || 'Me'}, ` +
        `${reply.date}: ${clean(reply.text)}%%`;
    return md.slice(0, it.end) + note + md.slice(it.end);
}

/** A card's markdown with the `k`th reply to its `n`th comment taken out. */
function removeReply(md, n, k) {
    const it = reviewItems(md)[n];
    if (!it) return md;
    const whole = md.slice(it.start, it.end);
    REPLY.lastIndex = 0;
    let m;
    let i = 0;
    while ((m = REPLY.exec(whole))) {
        if (whole.slice(0, m.index).endsWith('%%') && i++ === k) {
            return md.slice(0, it.start + m.index) +
                md.slice(it.start + m.index + m[0].length);
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
    const hash = (s) => docx.crc32(Buffer.from(s, 'utf8')).toString(16);
    if (it.kind === 'change' || it.kind === 'suggest') {
        const out = it.kind === 'change' ? it.quote : it.passage;
        const put = it.kind === 'change' ? it.insert : it.text;
        keys.push('s:' + hash(`${author}\u0000${flat(out)}\u0000` +
                              `${flat(put)}`));
        return keys;
    }
    const { text, url } = noteLink(it.text);
    const gid = it.gid || (/[?&]disco=([\w.-]+)/.exec(url || it.link || '') ||
                           [])[1];
    if (gid) keys.push(`g:${gid}`);
    const bare = flat(text).replace(/^On “[^”]*”(?:, in an earlier version)?: /,
                                    '');
    keys.push('c:' + hash(`${author}\u0000${bare}`));
    return keys;
}

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
            return x.kind === 'suggest' &&
                x.text === clean(item.insert, true);
        }
        const text = flat(item.text);
        const had = flat(noteLink(x.text).text);
        return had === text || had.endsWith(`: ${text}`) ||
            reviewKeys(x).some((k) => keys.includes(k));
    });
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

function renderMarkdown(md, colourOf = null) {
    let n = 0;
    // A Google comment on several passages keeps one number for them.
    const numbers = new Map();
    ITEM.lastIndex = 0;
    return md.replace(ITEM, (m, passage, kind, body) => {
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
        const c = colourOf && h ? colourOf(h[1]) : null;
        const tint = c ? ` is-c-${c}` : '';
        const cls = (kind === 'suggest' ? ' is-suggest' : '') + tint;
        const sup = `<sup class="dendrite-review-n${cls}">${num}</sup>`;
        if (kind === 'suggest' && !passage) {
            // An insertion's leading space is the text's, not the mark's.
            const lead = /^\s*/.exec(text)[0];
            return `${lead}<span class="dendrite-review-new${tint}">` +
                `${text.slice(lead.length)}</span>${sup}`;
        }
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

// ---- a colour per reviewer -------------------------------------------

/**
 * The theme's colours a reviewer can take, in the order they are given
 * out; Obsidian's --color-<name>.
 */
const REVIEWER_COLOURS = ['blue', 'green', 'purple', 'orange', 'cyan',
                          'pink', 'yellow', 'red'];

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
        out.set(name, REVIEWER_COLOURS.find((c) => !taken.has(c)) ||
            REVIEWER_COLOURS[out.size % REVIEWER_COLOURS.length]);
        added = true;
    }
    return { map: out, added };
}

/**
 * A review item's buttons, as [action, label, tooltip]: a suggestion
 * applied or dismissed; a comment resolved, dealt with and remembered so
 * a pull does not bring it back.
 */
function commentActions(it) {
    return it.kind === 'suggest' ?
        [['apply', 'Apply…', ''], ['dismiss', 'Dismiss', '']] :
        [['resolve', 'Resolve', 'Dealt with: taken out, and not brought ' +
          'back by a pull']];
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

/**
 * A box under a comment to write a reply in, sent with Send or Ctrl+Enter
 * and put away with Cancel or Escape; `send(text)` is given what was
 * written. `typing(el)`, if given, is told of the box, so the keys typed
 * in it stay in it.
 */
function replyBox(parent, send, typing = null) {
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
    const row = doc.createElement('div');
    row.className = 'dendrite-review-reply-btns';
    const go = doc.createElement('button');
    go.className = 'dendrite-review-btn mod-cta';
    go.textContent = 'Send';
    const no = doc.createElement('button');
    no.className = 'dendrite-review-btn';
    no.textContent = 'Cancel';
    const done = () => form.remove();
    go.onclick = async (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const t = box.value.trim();
        if (!t) return;
        done();
        await send(t);
    };
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
            done();
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
    box.focus();
    return form;
}

/**
 * Under each paragraph of a rendered card, a callout for each review
 * comment in it, numbered as in the text. `act(n, what)` is called with
 * the comment's index and 'resolve' or, for a suggestion, 'apply' or
 * 'dismiss'.
 */
function decorate(root, items, act, onMenu = null, colourOf = null,
                  typing = null) {
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
            who.textContent = it.author || 'Reviewer';
            meta.append(who, ` · ${shortDate(it.date)}`);
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
                a.addEventListener('click', (e) => e.stopPropagation());
                meta.append(' ', a);
            }
            text.textContent = it.kind !== 'suggest' ? said :
                !it.text.trim() ? 'Suggests deleting this.' :
                it.passage ? `Suggests: ${it.text.trim()}` :
                `Suggests adding: ${it.text.trim()}`;
            main.append(meta, text);
            // Its replies, under it, each with its own right-click menu.
            (it.replies || []).forEach((r, k) => {
                const el = doc.createElement('div');
                el.className = 'dendrite-review-reply';
                const by = doc.createElement('div');
                by.className = 'dendrite-review-meta';
                const b = doc.createElement('b');
                b.textContent = r.author || 'Me';
                by.append(b, ` · ${shortDate(r.date)}`);
                const said = doc.createElement('div');
                said.className = 'dendrite-review-text';
                said.textContent = r.text;
                el.append(by, said);
                if (onMenu) {
                    el.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onMenu(i, e, k);
                    });
                }
                main.append(el);
            });
            note.append(n, main);
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
            for (const [what, label, tip] of buttons) {
                const btn = doc.createElement('button');
                btn.className = 'dendrite-review-btn';
                btn.textContent = label;
                if (tip) btn.title = tip;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (what === 'reply') replyBox(main, (t) =>
                        act(i, 'reply', t), typing);
                    else act(i, what);
                });
                note.append(btn);
            }
            box.append(note);
        }
        if (b) b.after(box);
        else root.append(box);
    }
}

module.exports = { readReview, readReviewJson, readBody, readComments,
                   plainMap, normalise, locate, reviewItems, alreadyIn,
                   noteLink, reviewKeys, needsLink, addLink,
                   commentActions, commentMenu, googleData, googleOf,
                   REVIEWER_COLOURS, reviewerColours, colourList,
                   assignColours, reviewerEntries, entryList,
                   addReply, removeReply, replyBox,
                   firstOfComment, countComments,
                   itemText,
                   addItems, removeItem,
                   stripReview, canHighlight, renderMarkdown, decorate,
                   shortDate };
