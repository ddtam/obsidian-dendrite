'use strict';
// Inline footnotes in the card editor. A footnote, ^[[@key]] and the
// like, is drawn as a small chip: a footnote of citations only as its
// first author and year, any other as its number among the card's inline
// footnotes. In a narrow card a long citation key cannot break, so the
// text wrapped around it badly. The footnote's text shows on hover, and
// opens to be edited when the cursor reaches it, as Obsidian's live
// preview opens its own syntax. Which are where is core.inlineFootnotes.
//
// CodeMirror comes from Obsidian, which lends it to plugins, so it is
// asked for only here, when Obsidian's editor is in use.

const core = require('./core.js');
const review = require('./review.js');

/** The editor extension drawing a card's inline footnotes as chips. */
function footnoteExtension() {
    const { Decoration, EditorView, WidgetType } =
        require('@codemirror/view');
    const { StateField } = require('@codemirror/state');

    class Chip extends WidgetType {
        constructor(label, note) {
            super();
            this.label = label;
            this.note = note;
        }

        eq(other) {
            return this.label === other.label && this.note === other.note;
        }

        toDOM(view) {
            const el = view.dom.ownerDocument.createElement('sup');
            el.className = 'dendrite-cm-footnote';
            el.textContent = this.label;
            el.title = this.note;
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
        core.inlineFootnotes(md).forEach((n, k) => {
            if (held.some(([a, b]) => a < n.to && n.from < b)) return;
            // Open where the cursor or a selection reaches it.
            if (sel.some((r) => r.from <= n.to && n.from <= r.to)) return;
            const label = core.footnoteLabel(n.note) || String(k + 1);
            out.push(Decoration.replace({ widget: new Chip(label, n.note) })
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
