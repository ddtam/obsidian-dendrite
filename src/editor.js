'use strict';
/*
 * The card editor, in two kinds behind one interface:
 *
 *   { kind, el, value, focus(atStart), selection(), replace(text, at),
 *     focusAt(at, to), rangeAt(start, end), caretRect(), destroy() }
 *
 * `caretRect` gives the caret's top and bottom on the page, or null.
 *
 * `rangeAt` gives a DOM range over the text between two offsets, for
 * painting find's matches, or null where the text is not on the page.
 *
 * OBSIDIAN'S EDITOR is Obsidian's own markdown editor, so a card gets live
 * preview, [[ link and citation suggestions, editor commands such as
 * bold, and list wrapping. Obsidian has no public API for this: the class
 * is reached through the editor of an embedded note, the technique
 * several plugins share. If that fails, as an Obsidian update may make it,
 * THE TEXT BOX is used instead: a plain text area, which loses those
 * features but never text, since both kinds save the same way, through
 * the view.
 */
const { Scope } = require('obsidian');
const { reviewExtension } = require('./cmreview.js');

let EditorClass = null;
let resolveFailed = false;

/** Obsidian's MarkdownEditor class, found once from an embed's editor. */
function markdownEditorClass(app) {
    if (EditorClass || resolveFailed) return EditorClass;
    try {
        const embed = app.embedRegistry.embedByExtension.md(
            { app, containerEl: createDiv(), state: {} }, null, '');
        embed.editable = true;
        embed.showEditor();
        const proto = Object.getPrototypeOf(
            Object.getPrototypeOf(embed.editMode));
        embed.unload();
        EditorClass = proto && proto.constructor;
        if (typeof EditorClass !== 'function') throw new Error('no class');
    } catch (err) {
        resolveFailed = true;
        EditorClass = null;
        console.warn('Dendrite: Obsidian\'s editor is unavailable; cards ' +
                     'use the text box.', err);
    }
    return EditorClass;
}

/**
 * Obsidian's editor for one card. `parent` is the component that owns it;
 * `opts` holds value, file, onChange, onBlur and onEscape.
 */
function obsidianEditor(app, parent, opts) {
    const Base = markdownEditorClass(app);
    if (!Base) return null;
    class CardEditor extends Base {
        constructor(container) {
            super(app, container, {
                app,
                onMarkdownScroll: () => {},
                getMode: () => 'source',
            });
            this.cardOpts = opts;
            // The editor's keys: Escape leaves the card, unless a
            // suggestion list is open, whose own scope sits above this one
            // and closes first.
            this.scope = new Scope(app.scope);
            this.scope.register([], 'Escape', () => {
                opts.onEscape();
                return false;
            });
            // Ctrl+Z is the text's own undo until this visit's typing is
            // undone; then it steps back through the card's earlier
            // visits, and in a new, empty card takes the card back.
            if (opts.onUndo) {
                this.scope.register(['Mod'], 'z', () => !opts.onUndo());
            }
            // Redo steps a visit forward again after a step back.
            if (opts.onRedo) {
                for (const [mods, key] of [[['Mod', 'Shift'], 'z'],
                                           [['Mod'], 'y']]) {
                    this.scope.register(mods, key, () => !opts.onRedo());
                }
            }
            // Find searches the manuscript, not this one card.
            if (opts.onFind) {
                this.scope.register(['Mod'], 'f', () => {
                    opts.onFind();
                    return false;
                });
            }
            this.owner.editMode = this;
            this.owner.editor = this.editor;
            // Link suggestions and rendering resolve against the card.
            this.owner.file = opts.file;
            this.set(opts.value || '', false);
            const content = this.editor.cm.contentDOM;
            content.addEventListener('focusin', () => {
                app.keymap.pushScope(this.scope);
                app.workspace.activeEditor = this.owner;
            });
            content.addEventListener('blur', () => {
                app.keymap.popScope(this.scope);
                if (this._loaded) opts.onBlur();
            });
            // Clicking into the editor must not hand focus to another
            // pane while the card has it.
            const ws = app.workspace;
            const original = ws.setActiveLeaf;
            const self = this;
            // CodeMirror's hasFocus is also false while Obsidian's window
            // is not the focused one, when the card can still have it.
            const hasFocus = () => {
                const cm = self.editor && self.editor.cm;
                if (!cm) return false;
                const dom = cm.contentDOM;
                return !!cm.hasFocus ||
                    (!!dom && dom.contains(dom.ownerDocument.activeElement));
            };
            const patched = function (...args) {
                if (hasFocus()) return undefined;
                return original.apply(this, args);
            };
            ws.setActiveLeaf = patched;
            this.register(() => {
                if (ws.setActiveLeaf === patched) ws.setActiveLeaf = original;
            });
        }

        // Review comments drawn in place of their syntax; the editor as
        // Obsidian makes it should that fail.
        buildLocalExtensions() {
            const base = super.buildLocalExtensions();
            try {
                return [...base, reviewExtension(opts.colourOf,
                                                 opts.nameOf)];
            } catch (err) {
                console.warn('Dendrite: review comments are shown as ' +
                             'text in the editor.', err);
                return base;
            }
        }

        onUpdate(update, changed) {
            super.onUpdate(update, changed);
            if (changed) this.cardOpts.onChange();
            // The editor redraws its lines as text changes and as it
            // scrolls, which drops anything painted over the old ones.
            if (this.cardOpts.onRedraw) this.cardOpts.onRedraw();
        }

        onunload() {
            super.onunload();
            app.keymap.popScope(this.scope);
            if (app.workspace.activeEditor === this.owner) {
                app.workspace.activeEditor = null;
            }
        }
    }
    const el = createDiv({ cls: 'dendrite-cm' });
    let ed;
    try {
        ed = new CardEditor(el);
        parent.addChild(ed);
        if (!ed.editor || !ed.editor.cm) throw new Error('no CodeMirror');
    } catch (err) {
        console.warn('Dendrite: Obsidian\'s editor failed to start; using ' +
                     'the text box.', err);
        if (ed) {
            try { parent.removeChild(ed); } catch (e) { /* already gone */ }
        }
        return null;
    }
    return {
        kind: 'obsidian',
        el,
        get value() { return ed.editor.cm.state.doc.toString(); },
        focus(atStart) {
            const editor = ed.editor;
            editor.focus();
            if (atStart) {
                editor.setCursor({ line: 0, ch: 0 });
            } else {
                const last = editor.lastLine();
                editor.setCursor({ line: last,
                                   ch: editor.getLine(last).length });
            }
        },
        selection() {
            const editor = ed.editor;
            return [editor.posToOffset(editor.getCursor('from')),
                    editor.posToOffset(editor.getCursor('to'))];
        },
        replace(text, at) {
            ed.editor.setValue(text);
            this.focusAt(at);
        },
        focusAt(at, to = at) {
            const editor = ed.editor;
            editor.focus();
            editor.setSelection(editor.offsetToPos(at),
                                editor.offsetToPos(to));
        },
        caretRect() {
            const cm = ed.editor.cm;
            const r = cm.coordsAtPos(cm.state.selection.main.head);
            return r ? { top: r.top, bottom: r.bottom } : null;
        },
        rangeAt(start, end) {
            const cm = ed.editor.cm;
            const vp = cm.viewport;
            if (!cm.domAtPos || (vp && (start < vp.from || end > vp.to))) {
                return null;
            }
            try {
                const a = cm.domAtPos(start);
                const b = cm.domAtPos(end);
                const r = el.ownerDocument.createRange();
                r.setStart(a.node, a.offset);
                r.setEnd(b.node, b.offset);
                return r;
            } catch (err) {
                return null;
            }
        },
        destroy() { parent.removeChild(ed); },
    };
}

/** The plain text box, used when Obsidian's editor is unavailable. */
function textEditor(opts) {
    const ta = createEl('textarea', { cls: 'dendrite-editor' });
    ta.value = opts.value || '';
    const fit = () => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
    };
    ta.addEventListener('input', () => {
        fit();
        opts.onChange();
    });
    ta.addEventListener('blur', () => opts.onBlur());
    return {
        kind: 'text',
        el: ta,
        ta,
        get value() { return ta.value; },
        focus(atStart) {
            fit();
            ta.focus();
            const at = atStart ? 0 : ta.value.length;
            ta.setSelectionRange(at, at);
        },
        selection() { return [ta.selectionStart, ta.selectionEnd]; },
        replace(text, at) {
            ta.value = text;
            fit();
            this.focusAt(at);
        },
        focusAt(at, to = at) {
            ta.focus();
            ta.setSelectionRange(at, to);
        },
        caretRect() { return textCaret(ta); },
        // A text box's text is not in the page's text, so nothing in it
        // can be painted; find selects its match instead.
        rangeAt() { return null; },
        destroy() { ta.remove(); },
    };
}

/**
 * Where a text box's caret is on the page. A text box does not say, so
 * its text up to the caret is laid out in a hidden copy with the same
 * width and type, and a mark after it is measured.
 */
function textCaret(ta) {
    const doc = ta.ownerDocument;
    const cs = doc.defaultView.getComputedStyle(ta);
    const copy = doc.createElement('div');
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
                     'letterSpacing', 'tabSize', 'boxSizing', 'paddingTop',
                     'paddingLeft', 'paddingRight', 'borderTopWidth',
                     'borderLeftWidth', 'borderRightWidth']) {
        copy.style[p] = cs[p];
    }
    copy.style.position = 'absolute';
    copy.style.visibility = 'hidden';
    copy.style.whiteSpace = 'pre-wrap';
    copy.style.overflowWrap = 'break-word';
    copy.style.width = ta.offsetWidth + 'px';
    copy.textContent = ta.value.slice(0, ta.selectionEnd);
    const mark = doc.createElement('span');
    mark.textContent = '\u200b';
    copy.appendChild(mark);
    doc.body.appendChild(copy);
    const top = ta.getBoundingClientRect().top + mark.offsetTop -
        ta.scrollTop;
    const height = mark.offsetHeight;
    copy.remove();
    return { top, bottom: top + height };
}

/** Obsidian's editor when asked for and available, else the text box. */
function cardEditor(app, parent, opts, useObsidian) {
    return (useObsidian && obsidianEditor(app, parent, opts)) ||
        textEditor(opts);
}

/** For the tests, which swap Obsidian's editor in and out. */
function resetForTests() {
    EditorClass = null;
    resolveFailed = false;
}

module.exports = { cardEditor, textEditor, resetForTests };
