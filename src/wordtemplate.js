'use strict';
// A manuscript exported into a Word template a funder or journal gives:
// the template keeps its page, header, footer, headings and tables, and
// the manuscript's text fills it. Pandoc writes the manuscript with the
// template as its reference document, so that file already holds the
// template's styles, lists, headers and footers, and the manuscript's
// notes and images; only its body is rebuilt here, from the template's
// body and the manuscript's.
//
// The template's instructions are its italic text and the boxes of it;
// what is left are its headings, matched to the manuscript's by section
// number, then by title, and its tables, matched to the manuscript's by
// their header rows. A template section the manuscript does not fill is
// left out with its heading.

const docx = require('./docx.js');

// Node's Buffer, which Obsidian's desktop app has.
const B = typeof Buffer !== 'undefined' ? Buffer : require('buffer').Buffer;

/** The top-level elements of a body's XML, in order. */
function bodyBlocks(body) {
    const out = [];
    const open = /<(w:p|w:tbl|w:sectPr|w:bookmarkStart|w:bookmarkEnd|w:sdt)\b/g;
    let i = 0;
    while (i < body.length) {
        open.lastIndex = i;
        const m = open.exec(body);
        if (!m) break;
        const tag = m[1];
        const gt = body.indexOf('>', m.index);
        if (body[gt - 1] === '/') {
            out.push(body.slice(m.index, gt + 1));
            i = gt + 1;
            continue;
        }
        const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'g');
        re.lastIndex = m.index;
        let depth = 0;
        let end = body.length;
        for (let t = re.exec(body); t; t = re.exec(body)) {
            if (!t[1] && !t[2]) depth++;
            else if (t[1]) depth--;
            if (depth === 0) {
                end = t.index + t[0].length;
                break;
            }
        }
        out.push(body.slice(m.index, end));
        i = end;
    }
    return out;
}

/** A document's XML split into what is before the body, its blocks, and
 * its last section's properties. */
function splitDocument(xml) {
    const a = xml.indexOf('<w:body>') + '<w:body>'.length;
    const b = xml.lastIndexOf('</w:body>');
    const blocks = bodyBlocks(xml.slice(a, b));
    const last = blocks.length && blocks[blocks.length - 1]
        .startsWith('<w:sectPr') ? blocks.pop() : '';
    return { head: xml.slice(0, a), blocks, sectPr: last,
             tail: xml.slice(b) };
}

const isPara = (x) => x.startsWith('<w:p>') || x.startsWith('<w:p ');
const isTable = (x) => x.startsWith('<w:tbl');

/**
 * A part's XML with its tracked changes taken as made: the record of
 * earlier properties gone, deletions gone, insertions kept as text.
 */
function settled(xml) {
    return xml
        .replace(/<w:(\w+Change)\b[^>]*\/>/g, '')
        .replace(/<w:(\w+Change)\b[^>]*>[^]*?<\/w:\1>/g, '')
        .replace(/<w:del\b[^>]*>[^]*?<\/w:del>/g, '')
        .replace(/<w:ins\b[^>]*>|<\/w:ins>/g, '');
}

/** Whether a run is set in italic. */
function italicRun(r) {
    const p = /<w:rPr>([^]*?)<\/w:rPr>/.exec(r);
    if (!p) return false;
    const m = /<w:i(?:\s+w:val="([^"]*)")?\s*\/>/.exec(p[1]);
    return !!m && !/^(0|false|off)$/.test(m[1] || '');
}

/** The text of a run, a paragraph or a cell. */
function textOf(x) {
    let out = '';
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>/g;
    for (let m = re.exec(x); m; m = re.exec(x)) {
        out += m[1] === undefined ? '\t' : m[1];
    }
    return unescape(out);
}

function unescape(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
        .replace(/&amp;/g, '&');
}

function escape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Text compared without case, spacing or punctuation. */
function norm(s) {
    return String(s || '').toLowerCase().replace(/[­]/g, '')
        .replace(/[^\p{L}\p{N}/]+/gu, ' ').trim();
}

/**
 * A paragraph with its italic runs taken out, links left holding none
 * taken out with them: the template's instructions gone, a heading's
 * roman words kept.
 */
function stripItalic(p) {
    let out = p.replace(/<w:r\b[^>]*>[^]*?<\/w:r>/g,
                        (r) => (italicRun(r) ? '' : r));
    out = out.replace(/<w:hyperlink\b[^>]*>(?:(?!<w:r\b)[^])*?<\/w:hyperlink>/g,
                      '');
    return out;
}

/** Whether a paragraph holds nothing to keep: no text, image or break. */
function emptyPara(p) {
    if (textOf(p).trim()) return false;
    return !/<w:drawing|<w:pict|<w:sectPr|<w:br w:type="page"|<w:object/
        .test(p);
}

/** "4.2.1 Cluster selection": { num, title }, else null. */
function numbered(text) {
    const m = /^\s*(\d+(?:\.\d+)*)\.?\s+(\S[^]*?)\s*$/.exec(text);
    return m ? { num: m[1], title: m[2] } : null;
}

/**
 * A table's rows, each with its cells' XML, text, and roman text: what
 * is not an example or an instruction, set in italic.
 */
function tableRows(tbl) {
    const rows = [];
    for (const r of bodyBlocksOf(tbl, 'w:tr')) {
        rows.push({ xml: r, cells: bodyBlocksOf(r, 'w:tc')
            .map((c) => ({ xml: c, text: textOf(c),
                           roman: textOf(stripItalic(c)) })) });
    }
    return rows;
}

/** The direct children of `xml` named `tag`, nested ones left inside. */
function bodyBlocksOf(xml, tag) {
    const out = [];
    const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'g');
    let depth = 0;
    let start = -1;
    // Skip the element's own opening tag.
    const inner = xml.indexOf('>') + 1;
    re.lastIndex = inner;
    for (let t = re.exec(xml); t; t = re.exec(xml)) {
        if (!t[1] && !t[2]) {
            if (depth === 0) start = t.index;
            depth++;
        } else if (t[1]) {
            depth--;
            if (depth === 0 && start >= 0) {
                out.push(xml.slice(start, t.index + t[0].length));
                start = -1;
            }
        } else if (depth === 0) {
            out.push(t[0]);
        }
    }
    return out;
}

/**
 * The template's body as items: { kind: 'heading', num, title, xml },
 * { kind: 'part', title, xml }, { kind: 'table', xml, header } and
 * { kind: 'p', xml }, its instructions out: a plain paragraph of words
 * just before a top-level heading heads a part. `startAt`, a paragraph's
 * text, drops all before it; one-row boxes all in italic are
 * instructions too.
 */
function templateItems(blocks, { startAt = null } = {}) {
    let from = 0;
    if (startAt) {
        const k = blocks.findIndex((b) => isPara(b) &&
            norm(textOf(b)) === norm(startAt));
        if (k >= 0) from = k;
    }
    const items = [];
    for (const b of blocks.slice(from)) {
        if (isPara(b)) {
            // A blank line the template sets between its parts, kept
            // once; one left blank by its instructions going is not.
            if (emptyPara(b) && !/<w:sectPr/.test(b)) {
                const last = items[items.length - 1];
                if (last && last.kind !== 'gap') {
                    items.push({ kind: 'gap', xml: b });
                }
                continue;
            }
            const p = stripItalic(b);
            if (emptyPara(p)) continue;
            const n = numbered(textOf(p));
            items.push(n ? { kind: 'heading', num: n.num, title: n.title,
                             xml: p } : { kind: 'p', xml: p });
        } else if (isTable(b)) {
            const rows = tableRows(b);
            const runs = b.match(/<w:r\b[^>]*>[^]*?<\/w:r>/g) || [];
            const roman = runs.some((r) => !italicRun(r) &&
                textOf(r).trim());
            if (rows.length < 2 && !roman) continue;
            items.push({ kind: 'table', xml: b,
                         header: rows.length ? rows[0].cells
                             .map((c) => c.text) : [] });
        }
    }
    // A plain paragraph just before a heading heads a part of them.
    items.forEach((it, k) => {
        const next = items.slice(k + 1).find((x) => x.kind !== 'gap');
        // Words, as a title is, not a line left of an example's code.
        const words = /^\p{L}/u.test(textOf(it.xml).trim()) &&
            !/[#{}=;$<>]/.test(textOf(it.xml));
        if (it.kind === 'p' && words && next && next.kind === 'heading' &&
            !next.num.includes('.')) {
            it.kind = 'part';
            it.title = textOf(it.xml).trim();
        }
    });
    return { items, dropped: from > 0 };
}

/**
 * Pandoc's body as sections: { pre, sections: [{ num, title, level,
 * blocks }], refs }, each section's blocks its heading's and those after
 * it, a bookmark opening before a heading going with that heading; the
 * reference list, styled Bibliography, apart.
 */
function manuscriptSections(blocks) {
    const out = { pre: [], sections: [], refs: [] };
    let cur = null;
    let pending = [];
    for (const b of blocks) {
        const style = /<w:pStyle w:val="([^"]+)"/.exec(b);
        if (isPara(b) && style && style[1] === 'Bibliography') {
            out.refs.push(b);
            continue;
        }
        if (b.startsWith('<w:bookmarkStart')) {
            pending.push(b);
            continue;
        }
        const h = isPara(b) && style && /^Heading(\d)$/.exec(style[1]);
        if (h) {
            const text = textOf(b).trim();
            const n = numbered(text);
            cur = { num: n ? n.num : null, title: n ? n.title : text,
                    level: Number(h[1]), heading: b, blocks: [...pending] };
            pending = [];
            out.sections.push(cur);
            continue;
        }
        const into = cur ? cur.blocks : out.pre;
        into.push(...pending, b);
        pending = [];
    }
    (cur ? cur.blocks : out.pre).push(...pending);
    // Pandoc's own heading over the reference list, a last section with
    // nothing but the list under it: the list's heading, not a section.
    const last = out.sections[out.sections.length - 1];
    if (last && out.refs.length && !last.blocks.some((b) => isTable(b) ||
        (isPara(b) && !emptyPara(b)))) {
        out.sections.pop();
        out.refsTitle = last.title;
    }
    return out;
}

/** Whether template heading `h` is manuscript section `s`. */
function sameSection(h, s) {
    if (s.num && h.num) return s.num === h.num;
    return norm(h.title) === norm(s.title);
}

// ---- tables ------------------------------------------------------------

/** The first run's properties in `xml`, italic and all, or ''. */
function firstRunProps(xml) {
    const r = /<w:r\b[^>]*>\s*(<w:rPr>[^]*?<\/w:rPr>)/.exec(xml);
    if (r) return r[1];
    const mark = /<w:pPr>[^]*?(<w:rPr>[^]*?<\/w:rPr>)[^]*?<\/w:pPr>/
        .exec(xml);
    return mark ? mark[1] : '';
}

/**
 * Cell `tc` of the template holding the paragraphs of manuscript cell
 * `from`: the template's cell and paragraph properties and its first
 * run's look, with the manuscript's bold, superscript and character
 * style on each run.
 */
function fillCell(tc, from) {
    const tcPr = (/<w:tcPr>[^]*?<\/w:tcPr>/.exec(tc) || [''])[0];
    const p0 = bodyBlocksOf(tc, 'w:p')[0] || '<w:p></w:p>';
    const pPr = (/<w:pPr>[^]*?<\/w:pPr>/.exec(p0) || [''])[0];
    // The template's look for the cell, less what marks an example:
    // italic and a colour.
    const base = firstRunProps(p0).replace(/<w:rPr>|<\/w:rPr>/g, '')
        .replace(/<w:(?:i|iCs|color)(?:\s[^>]*)?\/>/g, '');
    const paras = bodyBlocksOf(from, 'w:p');
    const out = (paras.length ? paras : ['<w:p></w:p>']).map((p) => {
        const runs = p.replace(/^<w:p\b[^>]*>/, '').replace(/<\/w:p>$/, '')
            .replace(/<w:pPr>[^]*?<\/w:pPr>/, '')
            .replace(/<w:r\b([^>]*)>(?:\s*<w:rPr>([^]*?)<\/w:rPr>)?/g,
                (m, attrs, rp) => {
                    const own = (rp || '').match(
                        /<w:(?:b|bCs|vertAlign|rStyle)\b[^>]*\/>/g) || [];
                    const props = own.join('') + base.replace(
                        /<w:(?:b|bCs|vertAlign|rStyle)\b[^>]*\/>/g, '');
                    return `<w:r${attrs}>` +
                        (props ? `<w:rPr>${props}</w:rPr>` : '');
                });
        return `<w:p>${pPr}${runs}</w:p>`;
    });
    return `<w:tc>${tcPr}${out.join('')}</w:tc>`;
}

/** Cell `tc` holding plain `text`, in its first run's look. */
function cellText(tc, text) {
    return fillCell(tc, `<w:tc><w:p><w:r><w:t xml:space="preserve">` +
                    `${escape(text)}</w:t></w:r></w:p></w:tc>`);
}

/**
 * Template table `tbl` filled from manuscript table `src`: columns
 * matched by header, a manuscript column with no header in the template
 * taking a template column left over, in order, under the manuscript's
 * header; rows matched by their first cell, in the manuscript's order,
 * one with no row in the template made like the template's first. What
 * neither uses, the template's columns and rows left over and empty,
 * goes. Null when the two share no header.
 */
function fillTable(tbl, src) {
    const t = tableRows(tbl);
    const m = tableRows(src);
    if (t.length < 1 || m.length < 1) return null;
    const th = t[0].cells.map((c) => norm(c.text));
    const mh = m[0].cells.map((c) => norm(c.text));
    const col = mh.map((h) => th.indexOf(h));
    if (!col.some((k) => k >= 0)) return null;
    const free = th.map((h, k) => k).filter((k) => !col.includes(k));
    for (let j = 0; j < col.length; j++) {
        if (col[j] < 0 && free.length) col[j] = free.shift();
    }
    // Template columns the manuscript does not fill, empty in its body.
    const used = new Set(col.filter((k) => k >= 0));
    const keepCol = th.map((h, k) => used.has(k) ||
        t.slice(1).some((r) => r.cells[k] && r.cells[k].roman.trim()));
    const label = (r) => norm(r.cells[0] ? r.cells[0].text : '');
    const body = t.slice(1);
    const pattern = body[0] || t[0];
    const rows = [];
    const take = (tr, cells) => {
        let k = 0;
        const out = tr.xml.replace(/<w:tc\b[^>]*>[^]*?<\/w:tc>/g,
                                   () => '\u0000');
        const parts = [];
        cells.forEach((c, i) => {
            if (keepCol[i]) parts.push(c);
        });
        return out.replace(/\u0000/g, () => parts[k++] || '');
    };
    // The header, renamed where a manuscript column took a template one.
    rows.push(take(t[0], t[0].cells.map((c, k) => {
        const j = col.indexOf(k);
        return j >= 0 && norm(m[0].cells[j].text) !== th[k] ?
            cellText(c.xml, m[0].cells[j].text.trim()) : c.xml;
    })));
    const usedRows = new Set();
    for (const mr of m.slice(1)) {
        let tr = body.find((r) => !usedRows.has(r) && label(r) &&
            label(r) === label(mr));
        const matched = !!tr;
        if (matched) usedRows.add(tr);
        else tr = pattern;
        rows.push(take(tr, tr.cells.map((c, k) => {
            const j = col.indexOf(k);
            if (j >= 0 && mr.cells[j]) return fillCell(c.xml, mr.cells[j].xml);
            return matched && c.roman.trim() ? c.xml : cellText(c.xml, '');
        })));
    }
    // A template row with content of its own, not in the manuscript.
    for (const r of body) {
        if (usedRows.has(r)) continue;
        if (r.cells.slice(1).some((c) => c.roman.trim())) {
            rows.push(take(r, r.cells.map((c) => c.xml)));
        }
    }
    const head = tbl.slice(0, tbl.indexOf('<w:tr'));
    // The columns kept widened in proportion to the template's width.
    const all = (/<w:tblGrid>([^]*?)<\/w:tblGrid>/.exec(head) || ['', ''])[1]
        .match(/w:w="([\d.]+)"/g) || [];
    const cols = all.map((w) => Number(/[\d.]+/.exec(w)[0]));
    const kept = cols.filter((c, k) => keepCol[k] !== false);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const widths = kept.length && sum(kept) ? kept.map((c) =>
        Math.round(c * sum(cols) / sum(kept))) : null;
    return tidyTable(head + rows.join('') + '</w:tbl>', widths);
}

// What comes after spacing in a paragraph's properties, which Word
// reads in a fixed order.
const AFTER_SPACING = new RegExp('<w:(?:' + ['ind', 'contextualSpacing',
    'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection',
    'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle',
    'rPr', 'sectPr', 'pPrChange'].join('|') + ')\\b|</w:pPr>');

// What comes after an indent in a paragraph's properties.
const AFTER_IND = new RegExp('<w:(?:' + ['contextualSpacing',
    'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection',
    'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle',
    'rPr', 'sectPr', 'pPrChange'].join('|') + ')\\b|</w:pPr>');

/** A heading's left indent in twips, 0 for none or a sliver. */
function indentOf(p) {
    const m = /<w:ind\b[^>]*\bw:(?:left|start)="(-?[\d.]+)"/.exec(p);
    const v = m ? Math.round(Number(m[1])) : 0;
    return v >= 200 ? v : 0;
}

/**
 * Paragraph `p` set `left` twips further in, as the text under an
 * indented heading is; a list's own indent kept on top of it.
 */
function indentPara(p, left) {
    if (!left) return p;
    const add = (tag) => tag.replace(/\bw:(left|start)="(-?[\d.]+)"/,
        (m, k, v) => `w:${k}="${Math.round(Number(v)) + left}"`);
    if (/<w:pPr>/.test(p)) {
        return p.replace(/<w:pPr>[^]*?<\/w:pPr>/, (pPr) => {
            const ind = /<w:ind\b[^>]*\/>/.exec(pPr);
            if (ind) {
                return pPr.replace(ind[0], /\bw:(?:left|start)="/.test(ind[0]) ?
                    add(ind[0]) : ind[0].replace('<w:ind',
                                                 `<w:ind w:left="${left}"`));
            }
            const at = pPr.search(AFTER_IND);
            return pPr.slice(0, at) + `<w:ind w:left="${left}"/>` +
                pPr.slice(at);
        });
    }
    return p.replace(/^<w:p\b([^>]*)>/,
                     `<w:p$1><w:pPr><w:ind w:left="${left}"/></w:pPr>`);
}

// Up to this many rows, a table is kept on one page, as in Dendrite's
// other Word export (docx.keepTables).
const KEEP_ROWS = 30;

/**
 * A table kept together: no row split across pages, so a wrapped cell
 * stays whole; its first row a header repeated on each page; and every
 * row but the last kept with the next, so a short table stays on one
 * page, a long one at least its header with its first row.
 */
function keepTogether(tbl) {
    const count = (tbl.match(/<w:tr\b/g) || []).length;
    let k = 0;
    return tbl.replace(/<w:tr\b[^>]*>[^]*?<\/w:tr>/g, (tr) => {
        const i = k++;
        const flags = '<w:cantSplit/>' + (i === 0 ? '<w:tblHeader/>' : '');
        let out = tr.replace(/<w:(?:cantSplit|tblHeader)\b[^>]*\/>/g, '');
        if (/<w:trPr>/.test(out)) {
            out = out.replace(/<w:trPr>[^]*?<\/w:trPr>/, (pr) => {
                const at = pr.search(
                    /<w:(?:tblCellSpacing|jc|hidden)\b|<\/w:trPr>/);
                return pr.slice(0, at) + flags + pr.slice(at);
            });
        } else {
            out = out.replace(/^(<w:tr\b[^>]*>)/,
                              `$1<w:trPr>${flags}</w:trPr>`);
        }
        const keep = i < count - 1 && (count <= KEEP_ROWS || i === 0);
        return keep ? out.replace(/<w:p\b[^>]*>(?:<w:pPr>[^]*?<\/w:pPr>)?/g,
                                  (p) => keepNext(p + '</w:p>')
                                      .slice(0, -'</w:p>'.length)) : out;
    });
}

/**
 * A table laid out evenly: rows as tall as their text, not the
 * template's fixed heights, each cell's paragraphs single spaced with a
 * little room above and below, and its columns, `widths` when given,
 * in its grid and each cell.
 */
function tidyTable(tbl, widths = null) {
    let out = keepTogether(tbl.replace(/<w:trHeight\b[^>]*\/>/g, ''));
    const spacing = '<w:spacing w:before="30" w:after="30" w:line="240" ' +
        'w:lineRule="auto"/>';
    out = out.replace(/<w:p\b([^>]*)>(<w:pPr>[^]*?<\/w:pPr>)?/g,
        (m, attrs, pPr) => {
            let props = (pPr || '<w:pPr></w:pPr>')
                .replace(/<w:spacing\b[^>]*\/>/g, '');
            const at = props.search(AFTER_SPACING);
            props = props.slice(0, at) + spacing + props.slice(at);
            return `<w:p${attrs}>${props}`;
        });
    if (widths) {
        out = out.replace(/<w:tblGrid>[^]*?<\/w:tblGrid>/, '<w:tblGrid>' +
            widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('') +
            '</w:tblGrid>');
        out = out.replace(/<w:tr\b[^>]*>[^]*?<\/w:tr>/g, (tr) => {
            let k = 0;
            return tr.replace(/<w:tc>(<w:tcPr>[^]*?<\/w:tcPr>|<w:tcPr\s*\/>)?/g,
                (m, tcPr) => {
                    const w = `<w:tcW w:w="${widths[k++] || 0}" ` +
                        'w:type="dxa"/>';
                    if (!tcPr || /^<w:tcPr\s*\/>$/.test(tcPr)) {
                        return `<w:tc><w:tcPr>${w}</w:tcPr>`;
                    }
                    return '<w:tc>' + (/<w:tcW\b/.test(tcPr) ?
                        tcPr.replace(/<w:tcW\b[^>]*\/>/, w) :
                        tcPr.replace('<w:tcPr>', `<w:tcPr>${w}`));
                });
        });
    }
    return out;
}

/**
 * Manuscript table `src` in the template's table look: `model`'s table
 * properties, borders and all, with the manuscript's width.
 */
function restyleTable(src, model) {
    const tp = /<w:tblPr>[^]*?<\/w:tblPr>/.exec(model);
    if (!tp) return src;
    const width = /<w:tblW\b[^>]*\/>/.exec(src);
    let props = tp[0];
    if (width) props = props.replace(/<w:tblW\b[^>]*\/>/, width[0]);
    return tidyTable(src.replace(/<w:tblPr>[^]*?<\/w:tblPr>/, props));
}

/**
 * Paragraph `model` holding `text` instead, in its first roman run's
 * look, italic and colour out: a heading made like the template's.
 */
function likeHeading(model, text) {
    const pPr = (/<w:pPr>[^]*?<\/w:pPr>/.exec(model) || [''])[0];
    const runs = model.match(/<w:r\b[^>]*>[^]*?<\/w:r>/g) || [];
    const first = runs.find((r) => !italicRun(r) && textOf(r).trim()) ||
        runs[0] || '';
    const rPr = ((/<w:rPr>([^]*?)<\/w:rPr>/.exec(first) || [])[1] || '')
        .replace(/<w:(?:i|iCs|color)(?:\s[^>]*)?\/>/g, '');
    return `<w:p>${pPr}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}` +
        `<w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`;
}

/**
 * Paragraph `p` kept on the page with the one after it, as a heading
 * is, so none is left alone at a page's foot.
 */
function keepNext(p) {
    if (/<w:keepNext\b/.test(p)) return p;
    if (/<w:pPr>/.test(p)) {
        return /<w:pStyle\b[^>]*\/>/.test(p) ?
            p.replace(/(<w:pPr>\s*<w:pStyle\b[^>]*\/>)/, '$1<w:keepNext/>') :
            p.replace('<w:pPr>', '<w:pPr><w:keepNext/>');
    }
    return p.replace(/^<w:p\b([^>]*)>/, '<w:p$1><w:pPr><w:keepNext/></w:pPr>');
}

/** A section number's depth: 1 for "4", 2 for "4.1". */
const depthOf = (num) => (num ? num.split('.').length : 1);

// ---- the document --------------------------------------------------------

/**
 * The filled template's body: the template's items, the sections the
 * manuscript fills in its order of headings, each section's text after
 * its heading and its tables in the template's where one matches.
 * `opts`: references ('inline' or 'none'), referencesTitle.
 * Returns { blocks, report }.
 */
function fillBody(tItems, ms, opts = {}) {
    const report = { filled: [], dropped: [], unplaced: [], tables: [] };
    const heads = tItems.filter((x) => x.kind === 'heading');
    const matchOf = new Map();
    for (const h of heads) {
        const s = ms.sections.find((x) => !x.placed && sameSection(h, x));
        if (s) {
            s.placed = true;
            matchOf.set(h, s);
        }
    }
    // A heading is kept when it or a heading under it is filled.
    const kept = new Set();
    for (const h of heads) {
        if (matchOf.has(h) || heads.some((x) => matchOf.has(x) && x.num &&
            h.num && x.num.startsWith(h.num + '.'))) kept.add(h);
    }
    const model = opts.restyleTables === false ? null :
        tItems.find((x) => x.kind === 'table');
    // A manuscript heading with no template one, made like the
    // template's heading at its depth, or the deepest it has.
    const ownHeading = (x) => {
        const d = x.num ? depthOf(x.num) : x.level;
        const like = heads.find((h) => depthOf(h.num) === d) ||
            [...heads].reverse().find((h) => depthOf(h.num) < d);
        if (!like) return x.heading;
        return likeHeading(like.xml, x.num ? `${x.num} ${x.title}` :
            x.title);
    };
    // Every part heading made like the first.
    const firstPart = tItems.find((x) => x.kind === 'part');
    const out = [...ms.pre];
    // The template's blank line before a heading, where it has one:
    // after the text above it, or between two headings.
    const gapAt = (k) => tItems[k] && tItems[k].kind === 'gap' ?
        tItems[k].xml : null;
    const firstGap = (tItems.find((x) => x.kind === 'gap') || {}).xml;
    const gap = (xml, beforeHeading = false) => {
        // The last paragraph or table, past bookmarks, which are neither.
        const k = out.map((b) => isPara(b) || isTable(b)).lastIndexOf(true);
        const last = out[k];
        if (last && isPara(last) && emptyPara(last)) {
            // One there already: kept with the heading after it.
            if (beforeHeading) out[k] = keepNext(last);
            return;
        }
        if (xml && last) out.push(beforeHeading ? keepNext(xml) : xml);
    };
    // A table set off by a blank line above, over its caption when it
    // has one, and below, as the template sets its own.
    const isCaption = (b) => isPara(b) &&
        /<w:pStyle w:val="(?:Table|Image)?Caption"/.test(b);
    const pushTable = (into, t) => {
        if (firstGap) {
            const k = into.length - 1;
            if (k >= 0 && isCaption(into[k])) {
                into[k] = keepNext(into[k]);
                const before = into[k - 1];
                if (before && !(isPara(before) && emptyPara(before))) {
                    into.splice(k, 0, firstGap);
                }
            } else if (into === out) {
                gap(firstGap);
            } else if (into.length) {
                into.push(firstGap);
            }
        }
        into.push(t);
        if (firstGap) into.push(firstGap);
    };
    const unplacedAfter = (s) => {
        // Manuscript sections with no template heading go after the
        // nearest one before them that has one.
        const i = ms.sections.indexOf(s);
        const extra = [];
        for (let k = i + 1; k < ms.sections.length &&
             !ms.sections[k].placed; k++) {
            const x = ms.sections[k];
            x.placed = true;
            report.unplaced.push(x.num ? `${x.num} ${x.title}` : x.title);
            if (firstGap) extra.push(keepNext(firstGap));
            const h = keepNext(ownHeading(x));
            const left = indentOf(h);
            extra.push(h);
            for (const b of x.blocks) {
                if (isTable(b)) {
                    pushTable(extra, model ? restyleTable(b, model.xml) : b);
                } else {
                    extra.push(isPara(b) ? indentPara(b, left) : b);
                }
            }
        }
        return extra;
    };
    for (let k = 0; k < tItems.length; k++) {
        const it = tItems[k];
        if (it.kind === 'part') {
            const until = tItems.findIndex((x, j) => j > k &&
                x.kind === 'part');
            const span = tItems.slice(k + 1, until < 0 ? undefined : until);
            if (span.some((x) => kept.has(x))) {
                gap(gapAt(k - 1), true);
                out.push(keepNext(it === firstPart ? it.xml :
                    likeHeading(firstPart.xml, it.title)));
            }
            continue;
        }
        if (it.kind !== 'heading') continue;
        if (!kept.has(it)) {
            report.dropped.push(`${it.num} ${norm(it.title)}`);
            continue;
        }
        gap(gapAt(k - 1), true);
        out.push(keepNext(it.xml));
        const s = matchOf.get(it);
        if (!s) continue;
        report.filled.push(`${it.num} ${s.title}`);
        // This heading's own tables, up to the next heading.
        const own = [];
        for (let j = k + 1; j < tItems.length &&
             tItems[j].kind !== 'heading' && tItems[j].kind !== 'part'; j++) {
            if (tItems[j].kind === 'table') own.push(tItems[j]);
        }
        // Text under an indented heading starts where the heading does.
        const left = indentOf(it.xml);
        for (const b of s.blocks) {
            if (!isTable(b)) {
                out.push(isPara(b) ? indentPara(b, left) : b);
                continue;
            }
            let done = null;
            for (const t of own) {
                if (t.used) continue;
                done = fillTable(t.xml, b);
                if (done) {
                    t.used = true;
                    report.tables.push(`${it.num}: ${t.header.join(' | ')}`);
                    break;
                }
            }
            pushTable(out, done || (model ? restyleTable(b, model.xml) : b));
        }
        out.push(...unplacedAfter(s));
    }
    // Sections before the first placed one, as when the template has no
    // heading for any of them.
    for (const s of ms.sections) {
        if (s.placed) continue;
        s.placed = true;
        report.unplaced.push(s.num ? `${s.num} ${s.title}` : s.title);
        out.push(ownHeading(s), ...s.blocks);
    }
    if (ms.refs.length && opts.references !== 'none') {
        // One heading over the list, in the look of the template's top
        // headings.
        const title = ms.refsTitle || opts.referencesTitle || 'References';
        const top = heads.find((h) => depthOf(h.num) === 1);
        gap(firstGap, true);
        out.push(keepNext(top ? likeHeading(top.xml, title) :
            '<w:p><w:r><w:rPr><w:b /></w:rPr><w:t xml:space="preserve">' +
            `${escape(title)}</w:t></w:r></w:p>`), ...ms.refs);
    }
    return { blocks: out, report };
}

/**
 * Text placeholders in a part's paragraphs replaced: `fields` maps a
 * placeholder's text to what goes in its place. A placeholder may be
 * split across runs: its paragraph's text then goes in its first run.
 */
function fillFields(xml, fields) {
    const keys = Object.keys(fields || {}).filter(Boolean);
    if (!keys.length) return xml;
    return xml.replace(/<w:p\b[^>]*>[^]*?<\/w:p>/g, (p) => {
        const text = textOf(p);
        if (!keys.some((k) => text.includes(k))) return p;
        let next = text;
        for (const k of keys) next = next.split(k).join(String(fields[k]));
        let first = true;
        // In roman: italic is the template's mark of what to replace.
        return p.replace(/<w:r\b[^>]*>[^]*?<\/w:r>/g, (r) => {
            if (!/<w:t[\s>]/.test(r)) return r;
            const out = r.replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/,
                (m, a, t, b) => (first ?
                    `<w:t xml:space="preserve">${escape(next)}${b}` :
                    `${a}${b}`));
            first = false;
            return out.replace(/<w:(?:i|iCs)(?:\s[^>]*)?\/>/g, '');
        });
    });
}

/**
 * Styles.xml `styles` with each style the parts `parts` name and it lacks
 * taken from `defaults`, Pandoc's own styles.xml, with those they are
 * based on. Pandoc, writing with a reference document, names its body,
 * table and footnote styles without adding them when the reference has
 * none, and a table whose cells name a missing style is laid out as
 * loose paragraphs by some programs.
 */
function withStyles(styles, parts, defaults) {
    if (!defaults) return styles;
    const have = new Set([...styles.matchAll(/w:styleId="([^"]+)"/g)]
        .map((m) => m[1]));
    const want = [];
    for (const x of parts) {
        for (const m of x.matchAll(
            /w:(?:pStyle|rStyle|tblStyle) w:val="([^"]+)"/g)) want.push(m[1]);
    }
    const add = [];
    while (want.length) {
        const id = want.shift();
        if (have.has(id)) continue;
        const re = new RegExp(`<w:style\\b[^>]*w:styleId="${id.replace(
            /[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[^]*?</w:style>`);
        const m = re.exec(defaults);
        if (!m) continue;
        have.add(id);
        add.push(m[0].replace(/\s+w:default="1"/, ''));
        const base = /<w:basedOn w:val="([^"]+)"/.exec(m[0]);
        if (base) want.push(base[1]);
        const link = /<w:link w:val="([^"]+)"/.exec(m[0]);
        if (link) want.push(link[1]);
    }
    return add.length ? styles.replace('</w:styles>',
                                        add.join('') + '</w:styles>') : styles;
}

/**
 * A part's XML with widow and orphan control on everywhere: a template
 * may turn it off, and its paragraphs and Pandoc's that inherit that
 * leave a single line alone at the top or foot of a page.
 */
function widowControl(xml) {
    let out = xml.replace(/<w:widowControl\s+w:val="(?:0|false|off)"\s*\/>/g,
                          '<w:widowControl/>');
    // A default that sets none takes it on.
    out = out.replace(/(<w:pPrDefault>\s*<w:pPr>)(?![^]*?<w:widowControl)/,
                      '$1<w:widowControl/>');
    return out;
}

/**
 * A part's XML in one typeface at `pt` points or more: every font named
 * is `font`, theme fonts included, and every size below `pt` raised to
 * it, larger ones, as headings', kept. A part with no size of its own
 * takes the defaults from styles.xml, given `pt` there.
 */
function oneFont(xml, font, pt) {
    let out = xml;
    if (font) {
        const f = escape(font);
        const fonts = `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" ` +
            `w:eastAsia="${f}" w:cs="${f}" />`;
        out = out.replace(/<w:rFonts\b[^>]*\/>/g, fonts);
        // Defaults that name no font of their own take it too.
        out = out.replace(/(<w:rPrDefault>\s*<w:rPr>)(?![^]*?<w:rFonts)/,
                          `$1${fonts}`);
    }
    if (pt) {
        const half = Math.round(pt * 2);
        out = out.replace(/(<w:sz(?:Cs)? w:val=")(\d+)(")/g,
            (m, a, n, b) => a + Math.max(Number(n), half) + b);
        out = out.replace(/(<w:rPrDefault>\s*<w:rPr>)(?![^]*?<w:sz\b)/,
                          `$1<w:sz w:val="${half}" />` +
                          `<w:szCs w:val="${half}" />`);
    }
    return out;
}

/**
 * A section's properties for a template whose first pages were taken
 * out: no first page of its own, and pages counted from 1.
 */
function firstPageGone(sectPr) {
    return sectPr.replace(/<w:titlePg\b[^>]*\/>/g, '')
        .replace(/(<w:pgNumType\b[^>]*?)\s+w:start="\d+"/, '$1');
}

/**
 * Pandoc's .docx `outBuf`, written with template `tplBuf` as its
 * reference, rebuilt as the template filled. `opts`: startAt, fields
 * (placeholder to text), references ('inline' or 'none'), font and
 * fontSize, defaultStyles (Pandoc's styles.xml, for the styles it names
 * but does not add) and restyleTables. Returns { buf, report }.
 */
function fillDocx(outBuf, tplBuf, opts, zlib) {
    const files = docx.readZip(outBuf, zlib);
    const tfiles = docx.readZip(tplBuf, zlib);
    const read = (list, name) => {
        const f = list.find((x) => x.name === name);
        return f ? f.data.toString('utf8') : null;
    };
    const tdoc = splitDocument(settled(read(tfiles, 'word/document.xml')));
    const mdoc = splitDocument(read(files, 'word/document.xml'));
    const { items, dropped } = templateItems(tdoc.blocks, opts);
    const ms = manuscriptSections(mdoc.blocks);
    const { blocks, report } = fillBody(items, ms, opts);
    report.refs = ms.refs.length;
    const sect = dropped ? firstPageGone(mdoc.sectPr) : mdoc.sectPr;
    const xml = fillFields(withNamespaces(mdoc.head, tdoc.head) +
        blocks.join('') + sect + mdoc.tail, opts.fields);
    let out = files.map((f) => {
        if (f.name === 'word/document.xml') {
            return { name: f.name, data: B.from(xml, 'utf8') };
        }
        if (/^word\/(header|footer)\d*\.xml$/.test(f.name)) {
            return { name: f.name, data: B.from(fillFields(
                f.data.toString('utf8'), opts.fields), 'utf8') };
        }
        return f;
    });
    // No line left alone at the top or foot of a page.
    out = out.map((f) => (/^word\/(document|styles)\.xml$/.test(f.name) ?
        { name: f.name, data: B.from(widowControl(f.data.toString('utf8')),
                                     'utf8') } : f));
    // Styles Pandoc names but did not add, from its own.
    if (opts.defaultStyles) {
        const named = out.filter((f) => /^word\/(document|footnotes)\.xml$/
            .test(f.name)).map((f) => f.data.toString('utf8'));
        out = out.map((f) => (f.name === 'word/styles.xml' ? { name: f.name,
            data: B.from(withStyles(f.data.toString('utf8'), named,
                                    opts.defaultStyles), 'utf8') } : f));
    }
    // The manuscript's typeface and least size, when it sets them, in
    // every part that names a font or a size.
    const typed = new RegExp('^word/(document|styles|numbering|' +
                             'footnotes|header\\d*|footer\\d*)\\.xml$');
    if (opts.font || opts.fontSize) {
        out = out.map((f) => (typed.test(f.name) ? { name: f.name,
            data: B.from(oneFont(f.data.toString('utf8'), opts.font,
                                 opts.fontSize), 'utf8') } : f));
    }
    out = withLinked(out, tfiles);
    return { buf: docx.writeZip(out, zlib), report };
}

/**
 * A document's head with the namespaces the template's root declares
 * and it does not, so the template's paragraphs, which carry Word's own
 * attributes such as w14:paraId, stay valid in it.
 */
function withNamespaces(head, thead) {
    const root = /<w:document\b[^>]*>/.exec(head);
    const troot = /<w:document\b[^>]*>/.exec(thead);
    if (!root || !troot) return head;
    const have = new Set((root[0].match(/xmlns:[\w]+/g) || []));
    const add = (troot[0].match(/\sxmlns:[\w]+="[^"]*"/g) || [])
        .filter((d) => !have.has(d.trim().split('=')[0]));
    if (!add.length) return head;
    return head.replace(root[0], root[0].replace(/>$/, add.join('') + '>'));
}

/**
 * Files `files` with what their links point to that only the template
 * holds, as the fonts it embeds, which Pandoc's reference document
 * links to but does not copy; a link to a missing file stops some
 * programs opening the document. Their file types registered too.
 */
function withLinked(files, tfiles) {
    const have = new Set(files.map((f) => f.name));
    const add = [];
    for (const f of files) {
        const m = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(f.name);
        if (!m) continue;
        const dir = m[1] || '';
        const xml = f.data.toString('utf8');
        const re = /<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*>/g;
        for (let r = re.exec(xml); r; r = re.exec(xml)) {
            if (/TargetMode="External"/.test(r[0])) continue;
            const name = r[1].startsWith('/') ? r[1].slice(1) : dir + r[1];
            if (have.has(name)) continue;
            const t = tfiles.find((x) => x.name === name);
            if (t) {
                add.push(t);
                have.add(name);
            }
        }
    }
    if (!add.length) return files;
    const types = files.find((f) => f.name === '[Content_Types].xml');
    const ttypes = tfiles.find((f) => f.name === '[Content_Types].xml');
    if (types && ttypes) {
        let xml = types.data.toString('utf8');
        const txml = ttypes.data.toString('utf8');
        for (const f of add) {
            const ext = f.name.slice(f.name.lastIndexOf('.') + 1);
            if (new RegExp(`Extension="${ext}"`, 'i').test(xml)) continue;
            const d = new RegExp(`<Default\\b[^>]*Extension="${ext}"[^>]*/>`,
                                 'i').exec(txml);
            if (d) xml = xml.replace('</Types>', d[0] + '</Types>');
        }
        files = files.map((f) => (f === types ?
            { name: f.name, data: B.from(xml, 'utf8') } : f));
    }
    return [...files, ...add];
}

/**
 * A .docx holding only the manuscript's reference list, under its
 * heading, in Pandoc's file `outBuf` as written with the template's
 * styles; null when it has none.
 */
function referencesDocx(outBuf, opts, zlib) {
    const files = docx.readZip(outBuf, zlib);
    const f = files.find((x) => x.name === 'word/document.xml');
    const doc = splitDocument(f.data.toString('utf8'));
    const ms = manuscriptSections(doc.blocks);
    if (!ms.refs.length) return null;
    const title = '<w:p><w:pPr><w:keepNext /></w:pPr><w:r><w:rPr><w:b />' +
        '</w:rPr><w:t xml:space="preserve">' + escape(ms.refsTitle ||
            opts.referencesTitle || 'References') + '</w:t></w:r></w:p>';
    const xml = fillFields(doc.head + title + ms.refs.join('') +
        firstPageGone(doc.sectPr) + doc.tail, opts.fields);
    return docx.writeZip(files.map((x) => (x === f ?
        { name: x.name, data: B.from(xml, 'utf8') } : x)), zlib);
}

/**
 * Pages of each part of a PDF's text, `pages` its pages' text in order:
 * for each of `parts` (its heading's text), the pages from the one its
 * heading is first found on to the page before the next part's, the last
 * running to `end`, the page the body ends on.
 */
function partPages(pages, parts, end = pages.length) {
    const at = parts.map((p) => {
        const want = norm(p);
        const k = pages.findIndex((t) => norm(t).includes(want));
        return k < 0 ? null : k + 1;
    });
    return parts.map((p, i) => {
        if (at[i] === null) return { part: p, pages: null };
        const next = at.slice(i + 1).find((x) => x !== null);
        const last = next ? next - 1 : end;
        return { part: p, from: at[i], to: last,
                 pages: Math.max(1, last - at[i] + 1) };
    });
}

/**
 * Markdown with simple inline math, `$1\\text{ TB} = 10^{12}$`, as text,
 * in the body's font: words, numbers, signs, superscripts and
 * subscripts. Other math is left, and listed in `left`.
 */
function plainMath(md) {
    const left = [];
    const SIGNS = { '\\times': '×', '\\cdot': '·', '\\pm': '±',
                    '\\leq': '≤', '\\geq': '≥', '\\le': '≤',
                    '\\ge': '≥', '\\approx': '≈', '\\sim': '~',
                    '\\%': '%', '\\,': ' ', '\\ ': ' ' };
    const out = md.replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\d)/g, (all, pre, m) => {
        let t = m.replace(/\\text\{([^{}]*)\}|\\mathrm\{([^{}]*)\}/g,
                          (x, a, b) => a ?? b);
        for (const [k, v] of Object.entries(SIGNS)) t = t.split(k).join(v);
        t = t.replace(/\^\{([^{}]*)\}|\^(\w)/g, (x, a, b) => `^${a ?? b}^`)
            .replace(/_\{([^{}]*)\}|_(\w)/g, (x, a, b) => `~${a ?? b}~`);
        if (/[\\{}]/.test(t)) {
            left.push(m);
            return all;
        }
        return pre + t.replace(/\s*([=<>≤≥≈×±])\s*/g, ' $1 ')
            .replace(/ {2,}/g, ' ').trim();
    });
    return { md: out, left };
}

module.exports = { bodyBlocks, splitDocument, stripItalic, textOf, norm,
                   numbered, tableRows, templateItems, manuscriptSections,
                   fillTable, restyleTable, fillBody, fillFields,
                   firstPageGone, fillDocx, referencesDocx, partPages,
                   italicRun, emptyPara, settled, oneFont,
                   withStyles, likeHeading, plainMath, tidyTable,
                   indentPara, keepNext, widowControl };
