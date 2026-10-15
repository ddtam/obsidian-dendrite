'use strict';
/*
 * The card editor, in two kinds behind one interface:
 *
 *   { kind, el, value, focus(atStart), selection(), replace(text, at),
 *     focusAt(at, to), rangeAt(start, end), destroy() }
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
            // Ctrl+Z in a new, empty card takes the card back; otherwise
            // it is the text's own undo.
            if (opts.onUndo) {
                this.scope.register(['Mod'], 'z', () => !opts.onUndo());
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
            const patched = function (...args) {
                if (self.editor && self.editor.cm && self.editor.cm.hasFocus) {
                    return undefined;
                }
                return original.apply(this, args);
            };
            ws.setActiveLeaf = patched;
            this.register(() => {
                if (ws.setActiveLeaf === patched) ws.setActiveLeaf = original;
            });
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
        // A text box's text is not in the page's text, so nothing in it
        // can be painted; find selects its match instead.
        rangeAt() { return null; },
        destroy() { ta.remove(); },
    };
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
