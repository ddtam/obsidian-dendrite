'use strict';
// Review comments in the card editor. A comment's syntax is drawn in
// place rather than shown as text: a start marker hidden, a note and its
// replies a small number in the reviewer's colour, a passage held between
// markers tinted, so the card reads as text while it is typed in. What
// each says stays in view, as on the board: a suggestion's new text after
// its passage, struck through, and every comment under its paragraph. The
// cursor steps over a hidden piece as one, and typing or deleting leaves
// the pieces whole; they are changed only through the board's Resolve,
// Apply and replies. Which pieces are where is review.editorRanges.
//
// CodeMirror comes from Obsidian, which lends it to plugins, so it is
// asked for only here, when Obsidian's editor is in use.

const review = require('./review.js');

/**
 * The editor extension; `colourOf(author)` a reviewer's colour name or
 * null, `nameOf(author)` the person a name is linked to, `onLost(list)`
 * told of comments an edit left marking no text (review.passagesLost).
 */
function reviewExtension(colourOf = () => null, nameOf = (x) => x,
                         onLost = () => {}) {
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
            const doc = view.dom.ownerDocument;
            const el = doc.createElement('sup');
            const tint = colourOf(c.author);
            el.className = 'dendrite-review-n dendrite-cm-chip' +
                (c.kind === 'suggest' ? ' is-suggest' : '') +
                (tint ? ` is-c-${tint}` : '');
            el.textContent = String(c.n);
            const said = c.kind === 'suggest' ?
                (c.text.trim() ? `suggests: ${c.text.trim()}` :
                    'suggests deleting this') : c.text;
            el.title = `${nameOf(c.author) || 'Reviewer'}: ${said}`;
            if (c.kind !== 'suggest' || !c.text.trim()) return el;
            // A suggestion's new text, after its passage, before its number.
            const wrap = doc.createElement('span');
            wrap.className = 'dendrite-cm-suggestion';
            const lead = /^\s*/.exec(c.text)[0];
            if (lead) wrap.append(lead);
            const added = doc.createElement('span');
            added.className = 'dendrite-review-new' +
                (tint ? ` is-c-${tint}` : '');
            added.textContent = c.text.slice(lead.length);
            wrap.append(added, el);
            return wrap;
        }

        ignoreEvent() {
            return false;
        }
    }

    // The comments of a paragraph, under it, as the board shows them, to
    // read while writing; they are changed from the board.
    class Notes extends WidgetType {
        constructor(list) {
            super();
            this.list = list;
            this.key = JSON.stringify(list);
        }

        eq(other) {
            return this.key === other.key;
        }

        toDOM(view) {
            const doc = view.dom.ownerDocument;
            const div = (cls, parent) => {
                const el = doc.createElement('div');
                el.className = cls;
                if (parent) parent.append(el);
                return el;
            };
            const box = div('dendrite-review-notes dendrite-cm-notes');
            for (const c of this.list) {
                const tint = colourOf(c.author);
                const note = div('dendrite-review-note' +
                    (c.kind === 'suggest' ? ' is-suggest' : '') +
                    (tint ? ` is-c-${tint}` : ''), box);
                const n = doc.createElement('span');
                n.className = 'dendrite-review-n';
                n.textContent = String(c.n);
                note.append(n);
                const main = div('dendrite-review-main', note);
                const meta = div('dendrite-review-meta', main);
                const who = doc.createElement('b');
                review.shownAs(who, c.author || 'Reviewer', nameOf);
                meta.append(who, ` · ${review.shortDate(c.date)}`);
                const { text: said } = review.noteLink(c.text);
                const shown = div('dendrite-review-text', main);
                if (c.kind !== 'suggest') {
                    review.fillAddressed(shown, said, colourOf);
                } else {
                    shown.textContent = !c.text.trim() ?
                        'Suggests deleting this.' :
                        c.passage ? `Suggests: ${c.text.trim()}` :
                        `Suggests adding: ${c.text.trim()}`;
                }
                for (const r of c.replies || []) {
                    main.append(review.replyRow(doc, r, nameOf, colourOf));
                }
            }
            return box;
        }

        ignoreEvent() {
            return true;
        }
    }

    const build = (state) => {
        const r = review.editorRanges(state.doc.toString());
        const atomic = [];
        const all = [];
        // Each paragraph's comments, under its last line.
        const under = new Map();
        for (const c of r.chips) {
            if (!c.first) continue;
            const end = state.doc.lineAt(c.to).to;
            if (!under.has(end)) under.set(end, []);
            under.get(end).push(c);
        }
        for (const [end, list] of under) {
            all.push(Decoration.widget({ widget: new Notes(list),
                                         block: true, side: 1 }).range(end));
        }
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

    // An edit typed that leaves a comment marking no text is said, since
    // the passage is the writer's text and so is not held like the note.
    const watch = EditorView.updateListener.of((u) => {
        if (!u.docChanged || !u.transactions.some(user)) return;
        const lost = review.passagesLost(u.startState.doc.toString(),
                                         u.state.doc.toString());
        if (lost.length) onLost(lost);
    });

    return [field, step, keep, watch];
}

module.exports = { reviewExtension };
