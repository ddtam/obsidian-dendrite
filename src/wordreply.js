'use strict';
// A reply in the reviewer's own Word file: the file they sent back, with
// the writer's replies under their comments, the comments dealt with
// marked resolved, and the text brought up to date with the cards, each
// change tracked under the writer's name or written directly. Everything
// else in the file stays as the reviewer's Word wrote it: styles, table
// widths, spacing, their own edits. Nothing here touches Obsidian; the
// files arrive as Buffers.

const docx = require('./docx.js');

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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function attr(attrs, name) {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
    return m ? decode(m[1]) : null;
}

/** Each tag and run of text in `xml`, with where it starts and ends. */
function* tokens(xml) {
    const re = /<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(xml))) {
        const at = { s: m.index, e: re.lastIndex };
        if (m[5] !== undefined) yield { ...at, text: m[5] };
        else {
            yield { ...at, close: !!m[1], name: m[2], attrs: m[3],
                    empty: !!m[4] };
        }
    }
}

// What a run may hold and still be rewritten: its formatting, text,
// tabs and breaks. A run holding anything else, a field's code, a
// note's number, a picture, is left as it is, and so is its text.
const PLAIN = new Set(['w:rPr', 'w:t', 'w:tab', 'w:br', 'w:cr',
                       'w:lastRenderedPageBreak']);
const TRACKED = /^w:(ins|del|moveFrom|moveTo)$/;

/**
 * The body's paragraphs, in order: { s, e } where each is in `xml`,
 * its text, `pPr`, `cell` when in a table, `tracked` when it holds
 * tracked changes, `nested` when it holds another paragraph, as a text
 * box does, and `runs` [{ s, e, rPr, items, plain }], each item
 * { ch, xml } of one character, a tab '\t', a break '\n'.
 */
function paragraphs(xml) {
    const out = [];
    let para = null;
    let run = null;
    let depth = 0;
    let cells = 0;
    let inText = false;
    let rPrAt = -1;
    let pPrAt = -1;
    let inPPr = false;
    for (const tk of tokens(xml)) {
        if (tk.text !== undefined) {
            if (run && inText) {
                for (const ch of decode(tk.text).split('')) {
                    run.items.push({ ch, xml: null });
                }
            }
            continue;
        }
        const { name, close, empty } = tk;
        if (name === 'w:tc' && !empty) {
            cells += close ? -1 : 1;
            continue;
        }
        if (name === 'w:p') {
            if (empty) continue;
            if (!close) {
                depth++;
                if (depth === 1) {
                    para = { s: tk.s, e: -1, runs: [], pPr: '',
                             cell: cells > 0, tracked: false,
                             nested: false };
                } else if (para) {
                    para.nested = true;
                }
            } else {
                depth--;
                if (depth === 0 && para) {
                    para.e = tk.e;
                    para.text = para.runs.map((r) =>
                        r.items.map((x) => x.ch).join('')).join('');
                    out.push(para);
                    para = null;
                }
            }
            continue;
        }
        if (!para || depth !== 1) continue;
        if (name === 'w:pPr' && !run) {
            if (empty) para.pPr = xml.slice(tk.s, tk.e);
            else if (!close) {
                pPrAt = tk.s;
                inPPr = true;
            } else {
                para.pPr = xml.slice(pPrAt, tk.e);
                inPPr = false;
            }
            continue;
        }
        if (inPPr) {
            if (TRACKED.test(name)) para.tracked = true;
            continue;
        }
        if (TRACKED.test(name)) {
            para.tracked = true;
            continue;
        }
        if (name === 'w:r') {
            if (empty) continue;
            if (!close) {
                run = { s: tk.s, e: -1, rPr: '', items: [], plain: true };
            } else if (run) {
                run.e = tk.e;
                para.runs.push(run);
                run = null;
            }
            continue;
        }
        if (!run) continue;
        if (name === 'w:rPr') {
            if (empty) run.rPr = xml.slice(tk.s, tk.e);
            else if (!close) rPrAt = tk.s;
            else {
                run.rPr = xml.slice(rPrAt, tk.e);
                rPrAt = -1;
            }
            continue;
        }
        if (rPrAt >= 0) continue;
        if (name === 'w:t') {
            inText = !close && !empty;
        } else if (name === 'w:tab' && !close) {
            run.items.push({ ch: '\t', xml: '<w:tab/>' });
        } else if ((name === 'w:br' || name === 'w:cr') && !close) {
            run.items.push({ ch: '\n', xml: xml.slice(tk.s, tk.e) });
        } else if (!PLAIN.has(name) && !close) {
            run.plain = false;
        }
    }
    return out;
}

// ---- Lining texts up ---------------------------------------------------

/**
 * The text between spaces, and the spaces, each with where it is: a
 * change is made a word at a time, its punctuation with it, as one
 * reads "project(s)" replacing "projects (CAD)".
 */
function pieces(s) {
    const out = [];
    const re = /\S+|\s+/gu;
    let m;
    while ((m = re.exec(s))) out.push({ t: m[0], at: m.index });
    return out;
}

/** The longest common subsequence of `a` and `b`: a's match in b. */
function lcs(a, b, same = (x, y) => x === y) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = same(a[i], b[j]) ? dp[i + 1][j + 1] + 1 :
                Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const match = new Array(n).fill(-1);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (same(a[i], b[j])) {
            match[i] = j;
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return match;
}

/**
 * What turns text `was` into `now`, as edits { s, e, insert } on `was`,
 * in order, whole words at a time.
 */
function edits(was, now) {
    const a = pieces(was);
    const b = pieces(now);
    const match = lcs(a.map((x) => x.t), b.map((x) => x.t));
    const out = [];
    let i = 0;
    let j = 0;
    const flush = (i2, j2) => {
        if (i2 === i && j2 === j) return;
        const s = i < a.length ? a[i].at : was.length;
        const e = i2 < a.length ? a[i2].at : was.length;
        const bs = j < b.length ? b[j].at : now.length;
        const be = j2 < b.length ? b[j2].at : now.length;
        out.push({ s, e, insert: now.slice(bs, be) });
    };
    for (let k = 0; k <= a.length; k++) {
        if (k < a.length && match[k] < 0) continue;
        const j2 = k < a.length ? match[k] : b.length;
        flush(k, j2);
        i = k + 1;
        j = j2 + 1;
    }
    // Two edits with only a space between are one, as a reader takes
    // "data." becoming "data (#)." to be.
    const merged = [];
    for (const x of out) {
        const last = merged[merged.length - 1];
        if (last && /^\s*$/.test(was.slice(last.e, x.s))) {
            last.insert += was.slice(last.e, x.s) + x.insert;
            last.e = x.e;
        } else {
            merged.push({ ...x });
        }
    }
    return merged;
}

const key = (t) => t.replace(/\s+/g, ' ').trim();

/** How alike two paragraphs' texts are, 0 to 1, by their words. */
function likeness(x, y) {
    const w = (t) => t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const a = w(x);
    const b = w(y);
    if (!a.length || !b.length) return 0;
    const m = lcs(a, b).filter((k) => k >= 0).length;
    return 2 * m / (a.length + b.length);
}

// Two paragraphs are one changed where at least this share of their
// words line up.
const ALIKE = 0.5;

/**
 * The reviewer's paragraphs `was` and the new export's `now`, paired:
 * [{ was, now }], either missing for one added or taken out. Equal text
 * first, in order; then, between those, paragraphs alike enough; then a
 * paragraph moved, as a float moves one past a table, by its equal text
 * anywhere, so it stays where the reviewer has it.
 */
function pairParagraphs(was, now) {
    const kw = was.map((p) => key(p.text));
    const kn = now.map((p) => key(p.text));
    const match = lcs(kw, kn);
    const wasTo = match.slice();
    const nowFrom = new Array(now.length).fill(-1);
    match.forEach((j, i) => {
        if (j >= 0) nowFrom[j] = i;
    });
    // Between equal pairs: alike ones, in order.
    let i = 0;
    let j = 0;
    while (i <= was.length && j <= now.length) {
        let i2 = i;
        while (i2 < was.length && wasTo[i2] < 0) i2++;
        const j2 = i2 < was.length ? wasTo[i2] : now.length;
        let from = j;
        for (let x = i; x < i2; x++) {
            let best = -1;
            let score = ALIKE;
            for (let y = from; y < j2; y++) {
                if (nowFrom[y] >= 0) continue;
                const l = likeness(kw[x], kn[y]);
                // The first of equals, as two like cells side by side.
                if (best < 0 ? l >= score : l > score) {
                    score = l;
                    best = y;
                }
            }
            if (best >= 0) {
                wasTo[x] = best;
                nowFrom[best] = x;
                from = best + 1;
            }
        }
        i = i2 + 1;
        j = j2 + 1;
    }
    // Moved: equal text, anywhere.
    for (let x = 0; x < was.length; x++) {
        if (wasTo[x] >= 0 || !kw[x]) continue;
        const y = kn.findIndex((t, k) => nowFrom[k] < 0 && t === kw[x]);
        if (y >= 0) {
            wasTo[x] = y;
            nowFrom[y] = x;
        }
    }
    const out = [];
    let y = 0;
    for (let x = 0; x < was.length; x++) {
        if (wasTo[x] >= 0 && wasTo[x] >= y) {
            for (; y < wasTo[x]; y++) {
                if (nowFrom[y] < 0) out.push({ was: null, now: y });
            }
            y = wasTo[x] + 1;
        }
        out.push({ was: x, now: wasTo[x] >= 0 ? wasTo[x] : null });
    }
    for (; y < now.length; y++) {
        if (nowFrom[y] < 0) out.push({ was: null, now: y });
    }
    return out;
}

/**
 * Of `pairs` (pairParagraphs), those that are one paragraph of `now`
 * split in two or more in `was`, as a line break saved as a new
 * paragraph, with the same words: the pairs' places, to be left.
 */
function splitPairs(pairs, was, now) {
    const squash = (t) => t.replace(/\s+/g, '');
    const same = new Set();
    pairs.forEach((pr, k) => {
        if (pr.was === null || pr.now === null) return;
        let text = was[pr.was].text;
        for (let b = k + 1; b < pairs.length && pairs[b].now === null &&
             pairs[b].was !== null; b++) {
            text += was[pairs[b].was].text;
            if (squash(text) === squash(now[pr.now].text)) {
                for (let c = k; c <= b; c++) same.add(c);
                break;
            }
        }
    });
    return same;
}

// ---- Edits made without tracking --------------------------------------

/**
 * Word's document `xml` as one reader of it sees it: tracked changes by
 * an author in `accept` taken as made, and everyone else's as not.
 */
function viewOf(xml, accept) {
    const by = (attrs) => accept.has(attr(attrs, 'w:author'));
    return xml
        .replace(/<w:(ins|moveTo)\b([^>]*?)(?<!\/)>([\s\S]*?)<\/w:\1>/g,
                 (m, tag, attrs, inner) => (by(attrs) ? inner : ''))
        .replace(/<w:(del|moveFrom)\b([^>]*?)(?<!\/)>([\s\S]*?)<\/w:\1>/g,
                 (m, tag, attrs, inner) => (by(attrs) ? '' : inner
                     .replace(/<w:delText\b/g, '<w:t')
                     .replace(/<\/w:delText>/g, '</w:t>')));
}

/**
 * What was sent in the Word file `buf`, to compare a returned one with:
 * { authors, paras: [{ t, c }] }, each paragraph with text, its text and
 * whether it is in a table, tracked changes by `authors` taken as made.
 */
function sentText(buf, authors, zlib) {
    const doc = docx.readZip(buf, zlib)
        .find((f) => f.name === 'word/document.xml');
    if (!doc) throw new Error('not a Word document');
    const paras = paragraphs(viewOf(doc.data.toString('utf8'),
                                    new Set(authors)))
        .filter((p) => key(p.text))
        .map((p) => (p.cell ? { t: p.text, c: true } : { t: p.text }));
    return { authors: [...authors], paras };
}

/** How much two sent texts share: the paragraphs found in both. */
function overlap(a, b) {
    const have = new Set(a.paras.map((p) => key(p.t)));
    return b.paras.filter((p) => have.has(key(p.t))).length;
}

// A suggestion that adds a paragraph of its own starts with this, as an
// import writes one (review.js).
const NEW_PARAGRAPH = '¶ ';
const CONTEXT = 60;

/**
 * The edits made in the returned Word file `buf` without tracking, as
 * review items: what differs from `sent` (sentText) once the tracked
 * changes are set aside, those of `sent.authors` taken as made and the
 * reviewer's as not, since the import reads theirs already. Each is
 * { kind: 'change', author, date, quote, insert, before, after,
 * untracked: true }, by whoever last saved the file, `quote` and its
 * context as sent, so it is found in the cards as a tracked one is.
 */
function untrackedItems(buf, sent, zlib) {
    const files = new Map(docx.readZip(buf, zlib)
        .map((f) => [f.name, f.data.toString('utf8')]));
    const back = sentText(buf, sent.authors, zlib).paras;
    const core = files.get('docProps/core.xml') || '';
    const author = decode((/<cp:lastModifiedBy>([^<]*)</.exec(core) ||
        [])[1] || '') || 'Reviewer';
    const date = ((/<dcterms:modified[^>]*>([^<]*)</.exec(core) || [])[1] ||
        '').slice(0, 10);
    const was = sent.paras.map((p) => ({ text: p.t, cell: !!p.c }));
    const now = back.map((p) => ({ text: p.t, cell: !!p.c }));
    // Lined up as a reply lines the reviewer's file with the cards, the
    // returned file first, so a paragraph it split is seen the same way.
    const pairs = pairParagraphs(now, was).map((x) => ({ was: x.now,
                                                         now: x.was }));
    const same = splitPairs(pairs.map((x) => ({ was: x.now, now: x.was })),
                            now, was);
    // The text around a place in sent paragraph `i`, running on through
    // the cells beside it, as the import gives a cell its context.
    const around = (i, s, e) => {
        let before = was[i].text.slice(0, s);
        let after = was[i].text.slice(e);
        for (let k = i - 1; was[i].cell && k >= 0 && was[k].cell &&
             before.length < CONTEXT; k--) before = `${was[k].text} ${before}`;
        for (let k = i + 1; was[i].cell && k < was.length && was[k].cell &&
             after.length < CONTEXT; k++) after = `${after} ${was[k].text}`;
        return { before: before.slice(-CONTEXT),
                 after: after.slice(0, CONTEXT) };
    };
    const items = [];
    const item = (quote, insert, ctx) => items.push({ kind: 'change',
        author, date, quote, insert, ...ctx, untracked: true });
    let last = -1;
    pairs.forEach((pr, k) => {
        if (same.has(k)) {
            if (pr.was !== null) last = pr.was;
            return;
        }
        if (pr.was !== null && pr.now !== null) {
            last = pr.was;
            const a = was[pr.was].text;
            for (const x of edits(a, now[pr.now].text)) {
                item(a.slice(x.s, x.e), x.insert, around(pr.was, x.s, x.e));
            }
        } else if (pr.was !== null) {
            last = pr.was;
            item(was[pr.was].text, '', around(pr.was, 0,
                                              was[pr.was].text.length));
        } else if (!now[pr.now].cell) {
            item('', NEW_PARAGRAPH + now[pr.now].text, { before: last >= 0 ?
                was[last].text.slice(-CONTEXT) : '', after: '' });
        }
    });
    return items;
}

// ---- Writing changes ---------------------------------------------------

/**
 * Makes tracked-change marks: `next()` a fresh id for each, `mark(tag)`
 * a change's opening tag with the writer and the time.
 */
function reviser(firstId, author, date) {
    let id = firstId;
    const next = () => id++;
    const mark = (tag, empty = false) => `<w:${tag} w:id="${next()}" ` +
        `w:author="${esc(author)}" w:date="${date}"${empty ? '/' : ''}>`;
    return { next, mark };
}

const textXml = (s) => {
    let out = '';
    let buf = '';
    const flush = () => {
        if (buf) out += `<w:t xml:space="preserve">${esc(buf)}</w:t>`;
        buf = '';
    };
    for (const ch of s) {
        if (ch === '\t') {
            flush();
            out += '<w:tab/>';
        } else if (ch === '\n') {
            flush();
            out += '<w:br/>';
        } else {
            buf += ch;
        }
    }
    flush();
    return out;
};

/** A run's items as XML, deleted text as w:delText. */
function itemsXml(items, deleted) {
    let out = '';
    let buf = '';
    const tag = deleted ? 'w:delText' : 'w:t';
    const flush = () => {
        if (buf) out += `<${tag} xml:space="preserve">${esc(buf)}</${tag}>`;
        buf = '';
    };
    for (const it of items) {
        if (it.xml === null) buf += it.ch;
        else {
            flush();
            out += it.xml;
        }
    }
    flush();
    return out;
}

/**
 * Paragraph `p`'s XML, from `xml`, with `changes` made: edits on its
 * text (edits()), tracked as `rev` marks them, or written directly where
 * `rev` is null. Null where a change falls in text that cannot be
 * rewritten: a field's, a note number's, a tracked change's.
 */
function editParagraph(xml, p, changes, rev) {
    if (p.tracked || p.nested) return null;
    // Each character's run and place in it.
    const at = [];
    p.runs.forEach((r, ri) => r.items.forEach((x, k) => at.push([ri, k])));
    const state = at.map(() => 'keep');
    const adds = new Map();
    for (const c of changes) {
        for (let k = c.s; k < c.e; k++) {
            if (!p.runs[at[k][0]].plain) return null;
            state[k] = 'del';
        }
        if (!c.insert) continue;
        // After the text taken out, or the character before; at the
        // start, before the first.
        let anchor = c.e > 0 ? { k: c.e - 1, after: true } :
            { k: 0, after: false };
        if (at.length && !p.runs[at[anchor.k][0]].plain) {
            const other = anchor.after ? { k: c.e, after: false } : null;
            if (other && other.k < at.length &&
                p.runs[at[other.k][0]].plain) anchor = other;
            else return null;
        }
        const id = at.length ? `${anchor.k}${anchor.after ? '>' : '<'}` :
            'empty';
        adds.set(id, (adds.get(id) || '') + c.insert);
    }
    const insRun = (rPr, text) => {
        const r = `<w:r>${rPr}${textXml(text)}</w:r>`;
        return rev ? `${rev.mark('ins')}${r}</w:ins>` : r;
    };
    if (!at.length) {
        const text = adds.get('empty');
        if (!text) return xml.slice(p.s, p.e);
        const close = xml.lastIndexOf('</w:p>', p.e);
        return xml.slice(p.s, close) + insRun('', text) + '</w:p>';
    }
    let out = '';
    let pos = p.s;
    let g = 0;
    p.runs.forEach((r) => {
        const n = r.items.length;
        const here = state.slice(g, g + n);
        const touched = here.some((x) => x !== 'keep') ||
            [...Array(n).keys()].some((k) => adds.has(`${g + k}>`) ||
                                       adds.has(`${g + k}<`));
        if (!touched) {
            g += n;
            return;
        }
        out += xml.slice(pos, r.s);
        let seg = [];
        let segState = null;
        const emit = () => {
            if (!seg.length) return;
            if (segState === 'keep') {
                out += `<w:r>${r.rPr}${itemsXml(seg, false)}</w:r>`;
            } else if (rev) {
                out += `${rev.mark('del')}<w:r>${r.rPr}` +
                    `${itemsXml(seg, true)}</w:r></w:del>`;
            }
            seg = [];
        };
        for (let k = 0; k < n; k++) {
            const before = adds.get(`${g + k}<`);
            if (before) {
                emit();
                out += insRun(r.rPr, before);
            }
            if (state[g + k] !== segState) {
                emit();
                segState = state[g + k];
            }
            seg.push(r.items[k]);
            const after = adds.get(`${g + k}>`);
            if (after) {
                emit();
                out += insRun(r.rPr, after);
            }
        }
        emit();
        pos = r.e;
        g += n;
    });
    return out + xml.slice(pos, p.e);
}

/** A paragraph's runs taken out: tracked as deleted, or gone. */
function deleteParagraph(xml, p, rev) {
    if (p.tracked || p.nested || p.runs.some((r) => !r.plain)) return null;
    if (!rev && !p.cell) return '';
    let out = '';
    let pos = p.s;
    for (const r of p.runs) {
        out += xml.slice(pos, r.s);
        if (rev && r.items.length) {
            out += `${rev.mark('del')}<w:r>${r.rPr}` +
                `${itemsXml(r.items, true)}</w:r></w:del>`;
        }
        pos = r.e;
    }
    out += xml.slice(pos, p.e);
    // Its mark too, so the paragraph goes when the change is accepted;
    // not in a table cell, which must keep one.
    return rev && !p.cell ? markParagraph(out, rev.mark('del', true)) : out;
}

/** A paragraph's XML with its mark carrying a tracked-change `tag`. */
function markParagraph(px, tag) {
    const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>|<w:pPr\/>/.exec(px);
    if (!pPr) {
        const open = /^<w:p\b[^>]*>/.exec(px)[0];
        return open + `<w:pPr><w:rPr>${tag}</w:rPr></w:pPr>` +
            px.slice(open.length);
    }
    const inner = pPr[1] || '';
    const withMark = /<w:rPr>/.test(inner) ?
        inner.replace(/<w:rPr>/, `<w:rPr>${tag}`) :
        inner.replace(/(<w:sectPr\b|$)/, `<w:rPr>${tag}</w:rPr>$1`);
    return px.slice(0, pPr.index) + `<w:pPr>${withMark}</w:pPr>` +
        px.slice(pPr.index + pPr[0].length);
}

/**
 * A new paragraph, paragraph `np` of the new export's `nxml`, set as
 * the reviewer's paragraph `like` is set: its runs, their formatting
 * kept where the reviewer's file has the styles it names, inside
 * `like`'s paragraph settings. Links are given to `link(target)`,
 * which returns their id in the reviewer's file. Null where it holds
 * what cannot be carried, a picture or a note.
 */
function newParagraph(nxml, np, like, rev, styles, link) {
    if (np.nested || np.runs.some((r) => !r.plain)) return null;
    let body = nxml.slice(np.s, np.e)
        .replace(/^<w:p\b[^>]*>/, '').replace(/<\/w:p>$/, '')
        .replace(/<w:pPr>[\s\S]*?<\/w:pPr>|<w:pPr\/>/, '')
        .replace(/<w:bookmark(Start|End)\b[^>]*\/>/g, '')
        .replace(/<w:rStyle w:val="([^"]*)"\/>/g, (m, s) =>
            (styles.has(s) ? m : ''));
    let bad = false;
    body = body.replace(/(<w:hyperlink\b[^>]*?)r:id="([^"]*)"/g,
                        (m, open, id) => {
        const next = link(id);
        if (!next) bad = true;
        return `${open}r:id="${next}"`;
    });
    if (bad) return null;
    if (rev) {
        body = body.replace(/<w:r\b[\s\S]*?<\/w:r>/g,
                            (r) => `${rev.mark('ins')}${r}</w:ins>`);
    }
    const pPr = (like && like.pPr) || '';
    let px = `<w:p>${pPr}${body}</w:p>`;
    if (rev) px = markParagraph(px, rev.mark('ins', true));
    return px;
}

// ---- Comments ----------------------------------------------------------

const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';
const EXT_TYPE = 'application/vnd.openxmlformats-officedocument.' +
    'wordprocessingml.commentsExtended+xml';
const EXT_REL = 'http://schemas.microsoft.com/office/2011/relationships/' +
    'commentsExtended';
const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/' +
    'relationships/hyperlink';

/**
 * The file's comments, in order: { id, author, date, text, paraId,
 * parent }, `paraId` that of its last paragraph, `parent` the id of the
 * comment it replies to, `done` when resolved.
 */
function comments(files) {
    const xml = files.get('word/comments.xml') || '';
    const ext = files.get('word/commentsExtended.xml') || '';
    const byPara = new Map();
    for (const m of ext.matchAll(/<w15:commentEx\b([^>]*)\/>/g)) {
        byPara.set(attr(m[1], 'w15:paraId'), {
            parent: attr(m[1], 'w15:paraIdParent'),
            done: attr(m[1], 'w15:done') === '1' });
    }
    const out = [];
    const COMMENT = /<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g;
    for (const m of xml.matchAll(COMMENT)) {
        const paras = [...m[2].matchAll(/<w:p\b([^>]*)>([\s\S]*?)<\/w:p>/g)];
        const last = paras[paras.length - 1];
        const paraId = last ? attr(last[1], 'w14:paraId') : null;
        const text = paras.map((p) => [...p[2].matchAll(
            /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => decode(t[1]))
            .join('').trim()).filter(Boolean).join(' ');
        const x = byPara.get(paraId) || {};
        out.push({ id: attr(m[1], 'w:id'), author: attr(m[1], 'w:author'),
                   date: attr(m[1], 'w:date'), text, paraId,
                   parentPara: x.parent || null, done: !!x.done });
    }
    const idOf = new Map(out.map((c) => [c.paraId, c.id]));
    for (const c of out) {
        c.parent = c.parentPara ? idOf.get(c.parentPara) || null : null;
    }
    return out;
}

/** A new paragraph id for Word, not one of `used`. */
function newParaId(used) {
    let id;
    do {
        id = Math.floor(Math.random() * 0x7fffffff).toString(16)
            .toUpperCase().padStart(8, '0');
    } while (used.has(id));
    used.add(id);
    return id;
}

/** `root`'s opening tag with namespace `prefix` declared, if missing. */
function declare(xml, root, prefix, uri) {
    const re = new RegExp(`<${root}\\b[^>]*>`);
    const m = re.exec(xml);
    if (!m || m[0].includes(`xmlns:${prefix}=`)) return xml;
    const open = m[0].replace(/\s*\/?>$/, (end) =>
        ` xmlns:${prefix}="${uri}"${end.trim()}`);
    return xml.slice(0, m.index) + open + xml.slice(m.index + m[0].length);
}

/**
 * The reviewer's files with `answers` written in: a Map of a comment's
 * id to { replies: [{ author, date, text }], done }. A reply goes in
 * under the comment, after the replies it has, as Word threads one; one
 * already there, by the same writer saying the same, is not added
 * again. Returns the count of replies added and of comments resolved.
 */
function writeAnswers(files, answers) {
    let cxml = files.get('word/comments.xml');
    let doc = files.get('word/document.xml');
    if (!cxml || !answers.size) return { replies: 0, resolved: 0 };
    const list = comments(files);
    const flat = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const used = new Set();
    for (const m of (cxml + doc).matchAll(/w14:paraId="([0-9A-F]+)"/gi)) {
        used.add(m[1].toUpperCase());
    }
    let nextId = Math.max(0, ...list.map((c) => Number(c.id) || 0)) + 1;
    cxml = declare(cxml, 'w:comments', 'w14', W14);
    // A paragraph id on each comment answered that lacks one.
    for (const c of list) {
        if (c.paraId || !answers.has(c.id)) continue;
        c.paraId = newParaId(used);
        const re = new RegExp(`(<w:comment\\b[^>]*w:id="${c.id}"[^>]*>` +
            '[\\s\\S]*?)(<w:p\\b)((?:(?!<w:p\\b)[\\s\\S])*?</w:comment>)');
        cxml = cxml.replace(re, `$1<w:p w14:paraId="${c.paraId}" ` +
                            'w14:textId="77777777"$3');
    }
    const ext = [];
    const done = new Set();
    let replies = 0;
    for (const c of list) {
        const a = answers.get(c.id);
        if (!a || c.parent) continue;
        const thread = list.filter((x) => x.parent === c.id);
        const last = thread.length ? thread[thread.length - 1] : c;
        let lastId = last.id;
        for (const r of a.replies || []) {
            if (thread.some((x) => x.author === r.author &&
                            flat(x.text) === flat(r.text))) continue;
            const id = String(nextId++);
            const paraId = newParaId(used);
            const date = /T/.test(r.date || '') ? r.date :
                `${r.date || new Date().toISOString().slice(0, 10)}` +
                'T00:00:00Z';
            const paras = String(r.text).split(/\n+/).filter(Boolean);
            const body = (paras.length ? paras : ['']).map((t, k, all) =>
                `<w:p${k === all.length - 1 ?
                    ` w14:paraId="${paraId}" w14:textId="77777777"` : ''}>` +
                '<w:pPr><w:pStyle w:val="CommentText"/></w:pPr>' +
                (k === 0 ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/>' +
                    '</w:rPr><w:annotationRef/></w:r>' : '') +
                `<w:r>${textXml(t)}</w:r></w:p>`).join('');
            const initials = String(r.author).split(/\s+/)
                .map((w) => w[0] || '').join('').toUpperCase();
            cxml = cxml.replace(/<\/w:comments>\s*$/,
                                `<w:comment w:id="${id}" ` +
                `w:author="${esc(r.author)}" w:date="${date}" ` +
                `w:initials="${esc(initials)}">${body}</w:comment>` +
                '</w:comments>');
            ext.push(`<w15:commentEx w15:paraId="${paraId}" ` +
                     `w15:paraIdParent="${c.paraId}" w15:done="0"/>`);
            // Its marks beside the comment's own in the text.
            const after = (re, add) => {
                const m = re.exec(doc);
                if (m) {
                    const k = m.index + m[0].length;
                    doc = doc.slice(0, k) + add + doc.slice(k);
                }
            };
            after(new RegExp(`<w:commentRangeStart\\b[^>]*w:id="${lastId}"` +
                             '[^>]*/>'), `<w:commentRangeStart w:id="${id}"/>`);
            after(new RegExp(`<w:commentRangeEnd\\b[^>]*w:id="${lastId}"` +
                             '[^>]*/>'), `<w:commentRangeEnd w:id="${id}"/>`);
            after(new RegExp('<w:r\\b(?:(?!</w:r>)[\\s\\S])*?' +
                             `<w:commentReference\\b[^>]*w:id="${lastId}"` +
                             '[^>]*/>(?:(?!</w:r>)[\\s\\S])*?</w:r>'),
                  '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>' +
                  `<w:commentReference w:id="${id}"/></w:r>`);
            lastId = id;
            replies++;
        }
        if (a.done && !c.done) done.add(c.paraId);
    }
    // Threads and resolved marks, in commentsExtended.
    let exml = files.get('word/commentsExtended.xml');
    if (!exml) {
        exml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            `<w15:commentsEx xmlns:w15="${W15}" ` +
            'xmlns:mc="http://schemas.openxmlformats.org/' +
            'markup-compatibility/2006" mc:Ignorable="w15"></w15:commentsEx>';
        let types = files.get('[Content_Types].xml');
        types = types.replace('</Types>', '<Override PartName="/word/' +
            `commentsExtended.xml" ContentType="${EXT_TYPE}"/></Types>`);
        files.set('[Content_Types].xml', types);
        const rels = 'word/_rels/document.xml.rels';
        files.set(rels, files.get(rels).replace('</Relationships>',
            `<Relationship Id="rIdDendriteExt" Type="${EXT_REL}" ` +
            'Target="commentsExtended.xml"/></Relationships>'));
    }
    for (const c of list) {
        if (!c.paraId || exml.includes(`w15:paraId="${c.paraId}"`)) continue;
        if (!answers.has(c.id) && !done.has(c.paraId)) continue;
        exml = exml.replace('</w15:commentsEx>', `<w15:commentEx ` +
            `w15:paraId="${c.paraId}" w15:done="0"/></w15:commentsEx>`);
    }
    for (const p of done) {
        exml = exml.replace(new RegExp(`(<w15:commentEx\\b[^>]*` +
            `w15:paraId="${p}")([^>]*)/>`), (m, head, rest) =>
            `${head}${rest.replace(/\s*w15:done="[^"]*"/, '')} ` +
            'w15:done="1"/>');
    }
    exml = exml.replace('</w15:commentsEx>', ext.join('') +
                        '</w15:commentsEx>');
    files.set('word/commentsExtended.xml', exml);
    files.set('word/comments.xml', cxml);
    files.set('word/document.xml', doc);
    // The writers, known to Word, where it keeps a list of them.
    const people = files.get('word/people.xml');
    if (people) {
        let px = people;
        const names = new Set([...answers.values()].flatMap((a) =>
            (a.replies || []).map((r) => r.author)));
        for (const n of names) {
            if (px.includes(`w15:author="${esc(n)}"`)) continue;
            px = px.replace('</w15:people>', `<w15:person ` +
                `w15:author="${esc(n)}"><w15:presenceInfo ` +
                `w15:providerId="None" w15:userId="${esc(n)}"/>` +
                '</w15:person></w15:people>');
        }
        files.set('word/people.xml', px);
    }
    return { replies, resolved: done.size };
}

// ---- The whole reply ---------------------------------------------------

/**
 * The reviewer's file `theirs` (Buffer), answered: `answers` as
 * writeAnswers takes them, and its text brought to that of `fresh`, a
 * new export of the cards, each change tracked under `author` when
 * `tracked`, else written directly. Returns { buf, report }, the report
 * { replies, resolved, changed, added, removed, left: [{ text, why }],
 * changes: [{ kind, was, now, edits }] }, where `left` is what could
 * not be carried and is said, and `changes` each paragraph changed,
 * added or taken out, in the reviewer's order, with its edits().
 */
function replyDocx(theirs, fresh, answers, opts, zlib) {
    const read = (b) => new Map(docx.readZip(b, zlib)
        .map((f) => [f.name, f.data.toString('utf8')]));
    const files = read(theirs);
    if (!files.get('word/document.xml')) {
        throw new Error('not a Word document');
    }
    const report = { replies: 0, resolved: 0, changed: 0, added: 0,
                     removed: 0, left: [], changes: [] };
    Object.assign(report, writeAnswers(files, answers || new Map()));
    if (fresh) carryText(files, read(fresh), opts, report);
    const out = docx.readZip(theirs, zlib).map((f) => ({ name: f.name,
        data: files.has(f.name) ? Buffer.from(files.get(f.name), 'utf8') :
            f.data }));
    for (const [name, text] of files) {
        if (!out.some((f) => f.name === name)) {
            out.push({ name, data: Buffer.from(text, 'utf8') });
        }
    }
    return { buf: docx.writeZip(out, zlib), report };
}

const short = (t) => {
    const s = key(t);
    return s.length > 70 ? `${s.slice(0, 67)}…` : s;
};

/** The reviewer's text brought to the new export's, in `files`. */
function carryText(files, nfiles, opts, report) {
    let doc = files.get('word/document.xml');
    const ndoc = nfiles.get('word/document.xml');
    const was = paragraphs(doc).filter((p) => key(p.text));
    const now = paragraphs(ndoc).filter((p) => key(p.text));
    const ids = [...(doc + (files.get('word/comments.xml') || ''))
        .matchAll(/\bw:id="(\d+)"/g)].map((m) => Number(m[1]));
    const rev = opts.tracked ?
        reviser(Math.max(0, ...ids) + 1, opts.author || 'Author',
                opts.date || new Date().toISOString()
                    .replace(/\.\d+Z$/, 'Z')) : null;
    const styles = new Set([...(files.get('word/styles.xml') || '')
        .matchAll(/<w:style\b[^>]*w:styleId="([^"]*)"/g)].map((m) => m[1]));
    // Links in new paragraphs, given the same target in this file.
    const nrels = nfiles.get('word/_rels/document.xml.rels') || '';
    const relsName = 'word/_rels/document.xml.rels';
    let rels = files.get(relsName) || '';
    let relN = 0;
    const link = (id) => {
        const m = new RegExp(`<Relationship\\b[^>]*Id="${id}"[^>]*/>`)
            .exec(nrels);
        if (!m || attr(m[0], 'Type') !== HYPERLINK) return null;
        const target = attr(m[0], 'Target');
        const have = [...rels.matchAll(/<Relationship\b[^>]*\/>/g)]
            .find((r) => attr(r[0], 'Type') === HYPERLINK &&
                  attr(r[0], 'Target') === target);
        if (have) return attr(have[0], 'Id');
        const nid = `rIdDendriteLink${++relN}`;
        rels = rels.replace('</Relationships>', `<Relationship Id="${nid}" ` +
            `Type="${HYPERLINK}" Target="${esc(target)}" ` +
            'TargetMode="External"/></Relationships>');
        return nid;
    };
    // Each replacement as [s, e, xml, order] in the reviewer's document.
    const swaps = [];
    const pairs = pairParagraphs(was, now);
    const same = splitPairs(pairs, was, now);
    pairs.forEach((pr, k) => {
        if (same.has(k)) return;
        const p = pr.was !== null ? was[pr.was] : null;
        const n = pr.now !== null ? now[pr.now] : null;
        if (p && n) {
            if (p.text === n.text) return;
            const px = editParagraph(doc, p, edits(p.text, n.text), rev);
            if (px === null) {
                report.left.push({ text: short(p.text), why: p.tracked ?
                    'it holds tracked changes not yet accepted' :
                    'the change falls in a field, a note or a picture' });
                return;
            }
            swaps.push([p.s, p.e, px, k]);
            report.changed++;
            report.changes.push({ kind: 'changed', was: p.text, now: n.text,
                                  edits: edits(p.text, n.text) });
        } else if (p) {
            const px = deleteParagraph(doc, p, rev);
            if (px === null) {
                report.left.push({ text: short(p.text), why: 'to be ' +
                    'taken out, but it holds tracked changes, a field or ' +
                    'a picture' });
                return;
            }
            swaps.push([p.s, p.e, px, k]);
            report.removed++;
            report.changes.push({ kind: 'removed', was: p.text, now: '',
                                  edits: [{ s: 0, e: p.text.length,
                                            insert: '' }] });
        } else {
            // Added after the reviewer's paragraph before it, or before
            // the next, set as that one is.
            let prev = null;
            for (let b = k - 1; b >= 0 && !prev; b--) {
                if (pairs[b].was !== null) prev = was[pairs[b].was];
            }
            let next = null;
            for (let b = k + 1; b < pairs.length && !next; b++) {
                if (pairs[b].was !== null) next = was[pairs[b].was];
            }
            const like = prev || next;
            if (n.cell || (like && like.cell)) {
                report.left.push({ text: short(n.text), why: 'new text in ' +
                    'a table, whose rows and cells are left as they are' });
                return;
            }
            const px = like && newParagraph(ndoc, n, like, rev, styles, link);
            if (!px) {
                report.left.push({ text: short(n.text),
                                   why: 'a new paragraph holding a ' +
                                       'picture, a note or a field' });
                return;
            }
            const at = prev ? prev.e : next.s;
            swaps.push([at, at, px, k]);
            report.added++;
            report.changes.push({ kind: 'added', was: '', now: n.text,
                                  edits: [{ s: 0, e: 0, insert: n.text }] });
        }
    });
    // From the end, so each place is still where it was found; two
    // paragraphs added at one place, the later first, so they keep order.
    swaps.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[3] - a[3]);
    for (const [s, e, x] of swaps) doc = doc.slice(0, s) + x + doc.slice(e);
    files.set('word/document.xml', doc);
    files.set(relsName, rels);
}

module.exports = { sentText, untrackedItems, overlap, viewOf,
                   paragraphs, edits, pairParagraphs, editParagraph,
                   deleteParagraph, newParagraph, comments, writeAnswers,
                   replyDocx, likeness };
