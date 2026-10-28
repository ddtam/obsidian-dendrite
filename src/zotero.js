'use strict';
// Citations as links to their PDF in Zotero, so a reader can preview the
// paper on hover where the Zotero Mirror plugin is installed: it previews
// any zotero://open-pdf link. A citation's key is looked up in the vault's
// literature notes, by their citekey property, and the note's first link
// to its PDF is taken, without its page or highlight, so the link opens
// the paper itself. Only what is drawn changes: a card's text keeps its
// [@key], and export reads it as before.

const core = require('./core.js');

const PDF = /zotero:\/\/open-pdf\/library\/items\/([A-Z0-9]+)/i;

/** The citekeys of a footnote made only of citations, else none. */
function citekeys(note) {
    if (!core.footnoteLabel(note)) return [];
    return [...note.matchAll(/@([\w:.#$%&+?<>~/-]+)/g)].map((m) => m[1]);
}

/**
 * Each footnote of a card's markdown `md` by the number a renderer draws
 * it with, as core.footnoteNumbers numbers them: Map(number, note text).
 */
function notesByNumber(md) {
    const out = new Map();
    const inline = core.inlineFootnotes(md);
    core.footnoteNumbers(md).forEach((n, k) => {
        if (n && inline[k]) out.set(n, inline[k].note);
    });
    // A reference's number is its first use among all the card's notes.
    const defs = new Map();
    for (const m of (md || '').matchAll(/^\[\^([^\]\s]+)\]:[ \t]*(.*)$/gm)) {
        defs.set(m[1], m[2]);
    }
    if (!defs.size) return out;
    const marks = inline.map((x) => ({ at: x.from }));
    for (const m of md.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
        if (!inline.some((x) => x.from <= m.index && m.index < x.to)) {
            marks.push({ at: m.index, id: m[1] });
        }
    }
    marks.sort((a, b) => a.at - b.at);
    const seen = new Set();
    let n = 0;
    for (const x of marks) {
        if (x.id === undefined) {
            n++;
        } else if (!seen.has(x.id)) {
            seen.add(x.id);
            n++;
            if (defs.has(x.id)) out.set(n, defs.get(x.id));
        }
    }
    return out;
}

/**
 * The PDF links of the vault's literature notes. `get(key)` answers at
 * once, from what is known, and looks up a key not yet known, calling
 * `onFound` when it learns one; `load(keys)` waits for them.
 */
class PdfLinks {
    constructor(app, property = () => 'citekey') {
        this.app = app;
        this.property = property;
        this.notes = null;
        this.links = new Map();
        this.pending = new Map();
        this.onFound = () => {};
    }

    /** The note for each citekey, from the properties Obsidian holds. */
    index() {
        if (this.notes) return this.notes;
        this.notes = new Map();
        const prop = this.property();
        for (const f of this.app.vault.getMarkdownFiles()) {
            const fm = (this.app.metadataCache.getFileCache(f) || {})
                .frontmatter;
            const key = fm && fm[prop];
            if (typeof key === 'string' && key.trim()) {
                this.notes.set(key.trim().replace(/^@/, ''), f);
            }
        }
        return this.notes;
    }

    /** A note changed, was renamed or deleted: looked up afresh. */
    forget() {
        this.notes = null;
        this.links.clear();
    }

    /** Note `f` changed: looked up afresh if it is a literature note. */
    changed(f, cache) {
        if (!this.notes) return;
        const fm = cache && cache.frontmatter;
        if ((fm && fm[this.property()]) ||
            [...this.notes.values()].includes(f)) this.forget();
    }

    get(key) {
        if (this.links.has(key)) return this.links.get(key);
        this.load([key]);
        return null;
    }

    async load(keys) {
        await Promise.all(keys.map((key) => {
            if (this.links.has(key)) return null;
            if (!this.pending.has(key)) {
                this.pending.set(key, this.find(key).then((link) => {
                    this.pending.delete(key);
                    this.links.set(key, link);
                    if (link) this.onFound(key);
                }));
            }
            return this.pending.get(key);
        }));
    }

    async find(key) {
        const f = this.index().get(key);
        if (!f) return null;
        try {
            const m = PDF.exec(await this.app.vault.cachedRead(f));
            return m ? `zotero://open-pdf/library/items/${m[1]}` : null;
        } catch (e) {
            return null;
        }
    }
}

/**
 * Make each footnote reference in `el`, a card rendered from `md`, that
 * cites only papers with a PDF, a link to the first one's PDF. Run before
 * the references are renumbered for the document.
 */
async function linkCitations(el, md, links) {
    if (!links || !/@/.test(md || '')) return;
    const notes = notesByNumber(md);
    const want = [];
    const refs = [];
    for (const a of el.querySelectorAll('.footnote-ref a, a.footnote-ref')) {
        const n = Number((/\d+/.exec(a.textContent) || [])[0]);
        const key = citekeys(notes.get(n) || '')[0];
        if (!key) continue;
        refs.push([a, key]);
        want.push(key);
    }
    if (!refs.length) return;
    await links.load(want);
    for (const [a, key] of refs) {
        const href = links.links.get(key);
        if (!href) continue;
        a.setAttribute('href', href);
        // No longer a jump to the footnote, which Obsidian would make.
        a.classList.remove('footnote-link');
        a.classList.add('dendrite-cite-pdf');
        a.removeAttribute('target');
        a.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            a.ownerDocument.defaultView.open(href);
        });
    }
}

module.exports = { PdfLinks, citekeys, notesByNumber, linkCitations };
