'use strict';
// Review comments in the card editor. A comment's syntax is drawn in
// place rather than shown as text: a start marker hidden, a note and its
// replies a small number in the reviewer's colour, a passage held between
// markers tinted, so the card reads as text while it is typed in. The
// cursor steps over a hidden piece as one, and typing or deleting leaves
// the pieces whole; they are changed only through the board's Resolve,
// Apply and replies. Which pieces are where is review.editorRanges.
//
// CodeMirror comes from Obsidian, which lends it to plugins, so it is
// asked for only here, when Obsidian's editor is in use.

const review = require('./review.js');

/**
 * The editor extension; `colourOf(author)` a reviewer's colour name or
 * null, `nameOf(author)` the person a name is linked to.
 */
function reviewExtension(colourOf = () => null, nameOf = (x) => x) {
    const { Decoration, EditorView, WidgetType } =
        require('@codemirror/view');
    const { StateField, EditorState } = require('@codemirror/state');

    class Chip extends WidgetType {
        constructor(c) {
            super();
            this.c = c;
        }

        eq(other) {
            const a = this.c;
            const b = other.c;
            return a.n === b.n && a.author === b.author &&
                a.kind === b.kind && a.text === b.text;
        }

        toDOM(view) {
            const c = this.c;
            // The editor's own document, which may be a popout window's.
            const el = view.dom.ownerDocument.createElement('sup');
            const tint = colourOf(c.author);
            el.className = 'dendrite-review-n dendrite-cm-chip' +
                (c.kind === 'suggest' ? ' is-suggest' : '') +
                (tint ? ` is-c-${tint}` : '');
            el.textContent = String(c.n);
            const said = c.kind === 'suggest' ?
                (c.text.trim() ? `suggests: ${c.text.trim()}` :
                    'suggests deleting this') : c.text;
            el.title = `${nameOf(c.author) || 'Reviewer'}: ${said}`;
            return el;
        }

        ignoreEvent() {
            return false;
        }
    }

    const build = (state) => {
        const r = review.editorRanges(state.doc.toString());
        const atomic = [];
        const all = [];
        for (const [from, to] of r.hide) {
            atomic.push(Decoration.replace({}).range(from, to));
        }
        for (const c of r.chips) {
            atomic.push(Decoration.replace({ widget: new Chip(c) })
                .range(c.from, c.to));
        }
        for (const m of r.marks) {
            if (m.to <= m.from) continue;
            const tint = colourOf(m.author);
            all.push(Decoration.mark({ class: 'dendrite-cm-passage' +
                (m.kind === 'suggest' ? ' is-suggest' : '') +
                (tint ? ` is-c-${tint}` : '') }).range(m.from, m.to));
        }
        const hidden = Decoration.set(atomic, true);
        return { hidden, all: Decoration.set([...atomic, ...all], true),
                 protect: r.protect };
    };

    const field = StateField.define({
        create: build,
        update: (value, tr) => (tr.docChanged ? build(tr.state) : value),
        provide: (f) => [
            EditorView.decorations.from(f, (v) => v.all),
            EditorView.atomicRanges.of((view) => view.state.field(f).hidden),
        ],
    });

    const user = (tr) => ['input', 'delete', 'move'].some((e) =>
        tr.isUserEvent(e));

    // Backspace or Delete reaching a piece, with nothing selected, steps
    // over it instead: the caret goes to its far side and nothing is
    // deleted, so the next press deletes the text beyond it.
    const step = EditorState.transactionFilter.of((tr) => {
        const sel = tr.startState.selection.main;
        if (!tr.isUserEvent('delete') || !sel.empty) return tr;
        const { protect } = tr.startState.field(field);
        let to = null;
        tr.changes.iterChangedRanges((from, end) => {
            for (const [s, e] of protect) {
                if (to === null && s < end && from < e) {
                    to = from < sel.head ? s : e;
                }
            }
        });
        return to === null ? tr : { selection: { anchor: to } };
    });

    // Otherwise typing, deleting, pasting or dragging leaves the pieces
    // as they are; undo and Dendrite's own changes are not held back.
    const keep = EditorState.changeFilter.of((tr) => {
        if (!user(tr)) return true;
        const { protect } = tr.startState.field(field);
        return protect.length ? protect.flat() : true;
    });

    return [field, step, keep];
}

module.exports = { reviewExtension };
