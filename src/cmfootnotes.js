'use strict';
// Inline footnotes in the card editor. A footnote, ^[[@key]] and the
// like, is drawn as a small chip, its number as the rendered card draws
// it, [1], so the text wraps the same way in both and does not move when
// the card is opened to be written in; a long citation key cannot break
// either. On hover a chip shows its footnote's text, with the first
// author and year of a footnote of citations; it opens to be edited when
// the cursor reaches it, as Obsidian's live preview opens its own syntax.
// Which are where is core.inlineFootnotes.
//
// CodeMirror comes from Obsidian, which lends it to plugins, so it is
// asked for only here, when Obsidian's editor is in use.

const core = require('./core.js');
const review = require('./review.js');
const zotero = require('./zotero.js');

/**
 * The editor extension drawing a card's inline footnotes as chips;
 * `pdfOf(key)` a cited paper's PDF link, or null (zotero.js).
 */
function footnoteExtension(pdfOf = () => null) {
    const { Decoration, EditorView, WidgetType } =
        require('@codemirror/view');
    const { StateField } = require('@codemirror/state');

    class Chip extends WidgetType {
        constructor(label, note, href) {
            super();
            this.label = label;
            this.note = note;
            this.href = href;
        }

        eq(other) {
            return this.label === other.label && this.note === other.note &&
                this.href === other.href;
        }

        toDOM(view) {
            const doc = view.dom.ownerDocument;
            const el = doc.createElement('sup');
            el.className = 'dendrite-cm-footnote';
            el.title = this.note;
            if (!this.href) {
                el.textContent = this.label;
                return el;
            }
            // A link to the paper's PDF, for a hover to preview; a click
            // opens the citation to be edited, as on any chip.
            const a = doc.createElement('a');
            a.className = 'dendrite-cite-pdf';
            a.href = this.href;
            a.textContent = this.label;
            a.addEventListener('click', (e) => e.preventDefault());
            el.append(a);
            return el;
        }

        // A click goes through, so the cursor lands at the footnote and
        // opens it.
        ignoreEvent() {
            return false;
        }
    }

    const build = (state) => {
        const md = state.doc.toString();
        // Inside a review comment's syntax, its chip draws it already.
        const held = review.editorRanges(md).protect;
        const sel = state.selection.ranges;
        const out = [];
        const numbers = core.footnoteNumbers(md);
        core.inlineFootnotes(md).forEach((n, k) => {
            if (held.some(([a, b]) => a < n.to && n.from < b)) return;
            // Open where the cursor or a selection reaches it.
            if (sel.some((r) => r.from <= n.to && n.from <= r.to)) return;
            const label = `[${numbers[k] || k + 1}]`;
            const who = core.footnoteLabel(n.note);
            const note = who ? `${who}: ${n.note}` : n.note;
            const key = zotero.citekeys(n.note)[0];
            const href = key ? pdfOf(key) : null;
            out.push(Decoration.replace({
                widget: new Chip(label, note, href) })
                .range(n.from, n.to));
        });
        return Decoration.set(out);
    };

    return StateField.define({
        create: build,
        update: (value, tr) => (tr.docChanged || tr.selection ?
            build(tr.state) : value),
        provide: (f) => EditorView.decorations.from(f),
    });
}

module.exports = { footnoteExtension };
