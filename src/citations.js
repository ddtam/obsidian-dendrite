'use strict';
// Citations written in the text, [@key] or [see @a, p. 3; @b], drawn
// where the board and the preview show a card, which Obsidian leaves as
// their raw keys. The board labels each by its keys' first author and
// year. The preview prints them as the manuscript's citation style
// would: numbered in order of first citation for a numeric style, as
// author and year for an author-date one, and as footnotes for a note
// style. Labels come from the keys, as Better BibTeX writes them, since
// the papers' own records are not read: names past the first author,
// and the formatted reference list, are export's.

const core = require('./core.js');

// A bracket holding a citation, not a link's text nor a reference's.
const GROUP = /\[([^\[\]]*@[^\[\]]*)\](?![(\[:])/g;
const KEY = /^(.*?)(-?)@([\w][\w:.#$%&+?<>~/-]*?)([.:]*)((?:[,\s].*)?)$/s;

/**
 * A citation's inside, `see @a, p. 3; -@b`, as its items, each
 * { prefix, key, locator, suppress }, or null where any item is not a
 * citation, as in `[write to me @ home]`.
 */
function parseCitation(inner) {
    const items = [];
    for (const part of String(inner).split(';')) {
        const m = KEY.exec(part.trim());
        if (!m) return null;
        if (m[1] && !/\s$/.test(m[1])) return null;
        items.push({ prefix: m[1].trim(), key: m[3],
                     suppress: m[2] === '-',
                     locator: (m[4] + m[5]).replace(/^[.:]+/, '').trim() });
    }
    return items.length ? items : null;
}

/** Offsets in `text` of fenced and inline code, which hold no citation. */
function codeRanges(text) {
    const out = [];
    const re = new RegExp('^(\\s*)(`{3,}|~{3,})[^\\n]*\\n[\\s\\S]*?' +
        '(?:^\\s*\\2[^\\n]*$|(?![\\s\\S]))|(`+)[^`\\n][\\s\\S]*?\\3', 'gm');
    for (const m of text.matchAll(re)) {
        out.push([m.index, m.index + m[0].length]);
    }
    return out;
}

/**
 * Each citation in `text`, { from, to, items, inNote }, in reading
 * order; inNote where it sits in an inline footnote, ^[...].
 */
function citationsIn(text) {
    const t = String(text || '');
    const code = codeRanges(t);
    const notes = core.inlineFootnotes(t);
    const out = [];
    for (const m of t.matchAll(GROUP)) {
        const at = m.index;
        if (code.some(([a, b]) => a <= at && at < b)) continue;
        // An image's alt text, or a footnote's own bracket.
        if (t[at - 1] === '!' || t[at - 1] === '^') continue;
        const items = parseCitation(m[1]);
        if (!items) continue;
        const inNote = notes.some((n) => n.from < at && at < n.to);
        out.push({ from: at, to: at + m[0].length, items, inNote });
    }
    return out;
}

/**
 * A citation style read from its CSL: { format, sup, prefix, suffix,
 * delimiter }. format is the style's citation-format, numeric,
 * author-date, note, label or author; sup whether its numbers are
 * superscript. With no CSL, Pandoc's own default, Chicago author-date.
 */
function citationStyle(csl) {
    if (!csl) {
        return { format: 'author-date', sup: false, prefix: '(',
                 suffix: ')', delimiter: '; ' };
    }
    const xml = String(csl);
    const format = (/citation-format="([\w-]+)"/.exec(xml) || [])[1] ||
        'author-date';
    const cite = (/<citation\b[\s\S]*?<\/citation>/.exec(xml) || [''])[0];
    const layout = (/<layout\b[^>]*>/.exec(cite) || [''])[0];
    const attr = (name) => {
        const m = new RegExp(`\\b${name}="([^"]*)"`).exec(layout);
        return m ? m[1].replace(/&amp;/g, '&') : null;
    };
    const sup = /vertical-align="sup"/.test(cite);
    const numeric = format === 'numeric';
    return {
        format,
        sup,
        prefix: attr('prefix') ?? (numeric && !sup ? '[' : numeric ? '' :
            '('),
        suffix: attr('suffix') ?? (numeric && !sup ? ']' : numeric ? '' :
            ')'),
        delimiter: attr('delimiter') ?? (numeric ? ',' : '; '),
    };
}

/**
 * Each cited key's number, in order of first citation through `texts`,
 * as a numeric style numbers them: Map(key, n).
 */
function citationNumbers(texts) {
    const nums = new Map();
    for (const t of texts) {
        for (const c of citationsIn(t)) {
            for (const it of c.items) {
                if (!nums.has(it.key)) nums.set(it.key, nums.size + 1);
            }
        }
    }
    return nums;
}

/** Numbers as a numeric style collapses them: 1, 3-5, 9. */
function collapse(ns, delimiter = ',') {
    const s = [...new Set(ns)].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < s.length;) {
        let j = i;
        while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
        if (j - i >= 2) {
            out.push(`${s[i]}–${s[j]}`);
        } else {
            for (let k = i; k <= j; k++) out.push(String(s[k]));
        }
        i = j + 1;
    }
    return out.join(delimiter);
}

/**
 * A citation's printed text, given its items, the style, and for a
 * numeric style each key's number. With no style, the board's label:
 * first author and year of each key.
 */
function citationText(items, style, nums) {
    if (style && style.format === 'numeric') {
        const ns = items.map((it) => nums && nums.get(it.key))
            .filter((n) => n);
        if (!ns.length) return null;
        const loc = items.length === 1 && items[0].locator ?
            `, ${items[0].locator.replace(/^,\s*/, '')}` : '';
        return style.prefix + collapse(ns, style.delimiter) + loc +
            style.suffix;
    }
    const one = (it) => {
        const name = core.citeName(it.key);
        const year = (/\d{4}$/.exec(name) || [''])[0];
        const label = it.suppress && year ? year : name;
        const loc = it.locator ?
            (/^,/.test(it.locator) ? it.locator : `, ${it.locator}`) : '';
        return [it.prefix, label + loc].filter((x) => x).join(' ');
    };
    const body = items.map(one).join('; ');
    return style ? style.prefix + body + style.suffix : body;
}

/**
 * `text` with each citation outside a footnote made a footnote of its
 * own, ^[[@a]], set after the punctuation that followed it, as a note
 * style prints them.
 */
function asFootnotes(text) {
    const t = String(text || '');
    let out = '';
    let at = 0;
    for (const c of citationsIn(t)) {
        if (c.inNote) continue;
        const before = t.slice(at, c.from).replace(/[ \t]+$/, '');
        const punct = /^[.,;:!?]*/.exec(t.slice(c.to))[0];
        out += before + punct + `^[${t.slice(c.from, c.to)}]`;
        at = c.to + punct.length;
    }
    return out + t.slice(at);
}

/**
 * Draw each citation left as text in `el`, a rendered card: a span,
 * .dendrite-cite, its text the style's (the preview) or the keys'
 * labels (the board, style null), its keys in its title. Where `links`,
 * a zotero.PdfLinks, knows the first key's PDF, the span opens it.
 */
function drawCitations(el, { style = null, nums = null, links = null } =
                       {}) {
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    const walker = doc.createTreeWalker(el, win.NodeFilter.SHOW_TEXT);
    const texts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement &&
            n.parentElement.closest('code, pre, .dendrite-cite')) continue;
        if (/\[[^\]]*@/.test(n.nodeValue)) texts.push(n);
    }
    const drawn = [];
    for (const node of texts) {
        const t = node.nodeValue;
        const found = citationsIn(t);
        if (!found.length) continue;
        const frag = doc.createDocumentFragment();
        let at = 0;
        for (const c of found) {
            const shown = citationText(c.items, style, nums);
            if (!shown) continue;
            frag.append(doc.createTextNode(t.slice(at, c.from)));
            const sup = style && style.sup;
            const span = doc.createElement(sup ? 'sup' : 'span');
            span.className = 'dendrite-cite' + (style ? '' : ' is-label');
            span.textContent = shown;
            span.setAttribute('title', c.items.map((it) =>
                '@' + it.key).join('; '));
            span.dataset.keys = c.items.map((it) => it.key).join(' ');
            frag.append(span);
            drawn.push([span, c.items[0].key]);
            at = c.to;
        }
        frag.append(doc.createTextNode(t.slice(at)));
        node.replaceWith(frag);
    }
    if (links && drawn.length) {
        links.load(drawn.map(([, k]) => k)).then(() => {
            for (const [span, key] of drawn) {
                const href = links.get(key);
                if (!href) continue;
                span.classList.add('dendrite-cite-pdf');
                span.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    win.open(href);
                });
            }
        }).catch(() => {});
    }
    return drawn.length;
}

module.exports = {
    parseCitation, citationsIn, citationStyle, citationNumbers, collapse,
    citationText, asFootnotes, drawCitations,
};
