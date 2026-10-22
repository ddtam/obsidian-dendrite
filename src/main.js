'use strict';
/*
 * Dendrite: Gingko-style column writing over plain notes. See core.js for
 * the document model; this file wires it to Obsidian.
 *
 * PERFORMANCE. The cost in a view like this is the DOM and Obsidian's
 * markdown renderer, not the tree: a 2,646-card index parses in about
 * 1.4 ms. So a card is rendered only when it nears the screen, its
 * rendering is cached until its note changes, and moving between cards
 * changes classes and scroll positions without rebuilding anything.
 *
 * TEXT SAFETY. A card's text is written only to its own note, through
 * vault.process, autosaved while typing and saved again on every way out
 * of the editor. Escape saves; nothing in Dendrite discards an edit.
 *
 * WRITES AND SYNC. Dendrite writes a note only from something done on
 * this board: a key, a menu, a drag, or the card editor's saves. Nothing
 * that arrives from outside, a sync or another editor, and nothing done
 * on opening, writes anything. A change from outside updates the board
 * in memory, labels included, and the index catches up at the next write
 * made here. The index is written by reading it from disk and replacing
 * only its list, and not at all if its list changed since it was read.
 */
const {
    ItemView, MarkdownView, Plugin, PluginSettingTab, Setting,
    MarkdownRenderer,
    Component, Modal, Notice, TFile, TFolder, Scope, setIcon, Platform,
    normalizePath, Keymap,
} = require('obsidian');
const core = require('./core.js');
const textedit = require('./textedit.js');
const { cardEditor } = require('./editor.js');
const pandoc = require('./pandoc.js');
const { History, idbStore } = require('./history.js');

const VIEW = 'dendrite-view';

// What a card prints, as the card menu and its corner icon show it, with
// the number key that sets it in normal mode: most printed to least.
const ROLE_ITEMS = [
    ['section', 'Prints its heading only', 'heading', '1'],
    ['prose', 'Prints its full text', 'text', '2'],
    ['scaffolding', 'Scaffolding: prints its children only', 'layers', '3'],
    ['notes', 'Left out of the manuscript', 'eye-off', '4'],
];
// What kind of card it is, apart from what it prints: a table or figure
// that prints is numbered and printed with its caption.
const KIND_ITEMS = [
    [null, 'Text', 'text'],
    ['table', 'Table: numbered, caption above', 'table'],
    ['figure', 'Figure: numbered, caption below', 'image'],
];
// What a branch was set to, for the notice that says so.
const BRANCH_ROLE_NAMES = { '': 'print automatically',
    section: 'heading only', prose: 'full text',
    scaffolding: 'scaffolding', notes: 'left out' };
const ROLE_KEYS = new Map([['0', null],
                           ...ROLE_ITEMS.map((r) => [r[3], r[0]])]);

// A printing card's status, with the digit that sets it under Shift.
const STATUS_ITEMS = [
    ['draft', 'Status: draft', 'pencil-line', '1'],
    ['done', 'Status: done', 'check', '2'],
    ['revise', 'Status: revise', 'flag', '3'],
];
const PREVIEW = 'dendrite-preview';
// Where the preview shows footnotes, and the menu's words for each.
const NOTES_AT = {
    section: 'Footnotes collected under each section',
    end: 'Footnotes collected at the end',
    card: 'Footnotes under each card',
};
const DEFAULTS = {
    writingFolder: 'Writing',
    headingTop: 1,
    cardWidth: 480,
    autosaveMs: 600,
    openInDendrite: true,
    vimKeys: true,
    manageLinter: true,
    lintCards: true,
    obsidianEditor: true,
    typewriter: true,
    pandocPath: 'pandoc',
    pdfEngine: 'xelatex',
    zoteroPort: 23119,
    fallbackBib: '',
    // Values added to the type property of index notes and cards, so file
    // lists and colour rules can tell a manuscript from its cards. The
    // index's is a link, giving manuscripts a type page; a card's is plain
    // text, keeping hundreds of cards out of the vault's links. Empty
    // writes none.
    indexType: '[[dendrite index]]',
    cardType: 'dendrite card',
    // The Linter ignore entry Dendrite added itself, if any, so that only
    // that entry is ever removed again.
    linterAdded: null,
};
const LINTER_ID = 'obsidian-linter';
// Linter rules switched off when Dendrite lints a card. "File name
// heading" inserts the card's ID as its heading, which then becomes its
// label and an exported section heading; "Capitalize headings" rewrites
// the case of headings as they are written.
const CARD_UNSAFE_RULES = ['file-name-heading', 'capitalize-headings'];
// A card note is `<prefix>-<5 characters>.md` inside a `cards` folder.
const CARD_NAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-[a-z0-9]{5}$/;
const UNDO_DEPTH = 50;
// Space kept between the column's edge and the caret, or a tall card's top.
const CARD_MARGIN = 24;
// A card's label reaches the index once typing pauses this long, or when
// the card is left, so the index is not rewritten on every autosave.
const LABEL_IDLE_MS = 3000;

function prefixOf(app, file) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    const p = fm && fm.dendrite_prefix;
    return p ? String(p).trim() : null;
}

function isIndex(app, file) {
    return file instanceof TFile && file.extension === 'md' &&
        !!prefixOf(app, file);
}

function safeName(s) {
    return String(s).replace(/[\\/:*?"<>|#^[\]]/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

class DendriteView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.file = null;
        this.root = core.makeRoot();
        this.byId = new Map();
        this.active = null;
        this.lastChild = new Map();
        this.cardEls = new Map();
        this.rendered = new Map();
        this.editing = null;
        this.undo = [];
        this.redo = [];
        // Each card's own text history, visit by visit, apart from the
        // board's: id -> { undo, redo } of { before, after } bodies.
        this.texts = new Map();
        this.selfWrites = new Set();
        this.reloadTimer = null;
        // The index's list as last read or written here: a write over a
        // list that has changed since would drop someone else's change.
        this.indexList = null;
        // The index's text as last seen here, and, while an index from
        // outside leaves out cards whose notes still exist, the text
        // before it and those cards by id, with their labels.
        this.indexText = null;
        this.dropBase = null;
        this.dropped = new Map();
        this.indexReverted = false;
        // When each note was marked as gone back, by id or 'index'.
        this.revertedAt = new Map();
        // Typing not yet saved when a sync changed the card being edited:
        // by card, the note with that typing, to put back from its mark.
        this.held = new Map();
        // By card gone back, or 'index': the text before and where each
        // side was seen, read once when marked so the dialog need not.
        this.versionInfo = new Map();
        this.labelTimer = null;
        // Card bodies Dendrite is writing, by path, so their modify events
        // are known as its own; and the cards gone back to an earlier
        // version, by id, with 'index' for the index.
        this.ownBodies = new Map();
        this.reverted = new Set();
        this.history = plugin.history || new History();
        this.scope = new Scope(this.app.scope);
        this.registerKeys();
    }

    getViewType() { return VIEW; }
    getIcon() { return 'list-tree'; }
    getDisplayText() {
        return this.file ? this.file.basename : 'Dendrite';
    }

    getState() {
        return { file: this.file ? this.file.path : null };
    }

    async setState(state, result) {
        const f = state && state.file &&
            this.app.vault.getAbstractFileByPath(state.file);
        if (f instanceof TFile) {
            this.file = f;
            await this.reload();
            if (state.card && this.byId.has(state.card)) {
                this.active = state.card;
                this.applyActive(false);
            }
            // Normal-mode keys need the pane focused from the start.
            this.contentEl.focus();
        }
        return super.setState(state, result);
    }

    async onOpen() {
        this.contentEl.addClass('dendrite');
        this.contentEl.tabIndex = 0;
        this.observer = new IntersectionObserver(
            (entries) => this.onVisible(entries),
            { root: null, rootMargin: '600px 200px' });
        // A card changing height, as when it opens for editing or its text
        // renders, moves the flow's edges and the centre.
        this.resizer = new ResizeObserver(() => this.onResize());
        this.registerEvent(this.app.vault.on('modify',
            (f) => this.onModify(f)));
        this.registerEvent(this.app.vault.on('rename', (f, old) => {
            if (this.file && f === this.file) {
                this.leaf.updateHeader();
            } else if (f instanceof TFile) {
                this.onRenameCard(f, old);
            }
        }));
        this.registerEvent(this.app.vault.on('delete', (f) => {
            if (f === this.file) this.leaf.detach();
            else if (f instanceof TFile && this.dropped.has(f.basename)) {
                // A card left out of the index was deleted after all.
                this.dropped.delete(f.basename);
                if (!this.dropped.size) this.dropBase = null;
                this.flagIndex();
            } else if (f instanceof TFile && this.byId.has(f.basename)) {
                this.invalidate(f.basename);
                this.renderCard(f.basename);
            }
        }));
        this.registerEvent(this.app.metadataCache.on('changed',
            (f) => this.onMetadata(f)));
        this.registerDomEvent(this.contentEl, 'click',
            (e) => this.onClick(e));
        this.registerDomEvent(this.contentEl, 'keydown',
            (e) => this.onNavKey(e));
        // Dragging a card: mouse and pen. On a touch screen a long press
        // opens the card's menu, whose move items do the same.
        this.registerDomEvent(this.contentEl, 'pointerdown',
            (e) => this.onDragDown(e));
        // The rest of a drag is followed on the window the board is in,
        // from the press: a popout window has its own.
        this.dragMove = (e) => this.onDragMove(e);
        this.dragUp = (e) => this.onDragUp(e);
        this.dragCancel = () => this.cancelDrag();
        // Right-click, or a long-press on a phone, opens a card's menu at
        // the pointer; inside the editor the text keeps its own menu.
        this.registerDomEvent(this.contentEl, 'contextmenu', async (e) => {
            const card = e.target.closest('.dendrite-card');
            if (!card || e.target.closest('textarea, .dendrite-cm')) return;
            e.preventDefault();
            await this.select(card.dataset.id, false);
            this.cardMenu(card, e);
        });
        this.registerDomEvent(this.contentEl, 'dblclick', (e) => {
            const card = e.target.closest('.dendrite-card');
            if (card && !this.editing) this.startEdit(card.dataset.id);
        });
        this.registerDomEvent(window, 'beforeunload',
            () => { this.flush(); });
    }

    async onClose() {
        this.cancelDrag();
        this.hideQuotaTip();
        this.closeQuotaEditor();
        await this.flush();
        if (this.observer) this.observer.disconnect();
        if (this.resizer) this.resizer.disconnect();
        for (const r of this.rendered.values()) r.comp.unload();
        this.rendered.clear();
    }

    // ---- loading ---------------------------------------------------------

    async reload() {
        if (!this.file) return;
        const text = await this.app.vault.read(this.file);
        this.loadText(text);
        this.render();
        // Opening writes nothing: a printing card with no status shows as
        // draft and is given it at the next change made here. Versions
        // are checked behind the board, one card at a time.
        this.versionsChecked = this.checkVersions().catch((err) =>
            console.error('Dendrite: version check failed', err));
    }

    /**
     * Add the index's and every card's type value, where missing. Run
     * from a command, never on opening, since every device would make
     * the same writes at once.
     */
    async sweepTypes() {
        const s = this.plugin.settings;
        if (s.indexType && this.file) {
            await addType(this.app, this.file, s.indexType);
        }
        if (!s.cardType) return;
        for (const n of core.allNodes(this.root)) {
            const f = this.cardFile(n.id);
            if (f) await addType(this.app, f, s.cardType);
        }
    }

    loadText(text) {
        const { body } = core.splitFrontmatter(text);
        this.root = core.parseIndex(body).root;
        this.indexList = core.serialiseTree(this.root);
        if (!this.dropBase) this.indexText = text;
        this.reindex();
        if (!this.active || !this.byId.has(this.active)) {
            const first = this.root.children[0];
            this.active = first ? first.id : null;
        }
    }

    reindex() {
        this.byId.clear();
        for (const n of core.allNodes(this.root)) this.byId.set(n.id, n);
    }

    prefix() {
        return this.file ? prefixOf(this.app, this.file) : null;
    }

    /**
     * The document and window the board is in. Dendrite can sit in a
     * popout window, whose document is not the global one, so anything
     * placed on the page, or measured or listened for there, goes
     * through these.
     */
    pageDoc() {
        return this.contentEl.ownerDocument || document;
    }

    pageWin() {
        return this.pageDoc().defaultView || window;
    }

    cardsFolder() {
        const dir = this.file.parent ? this.file.parent.path : '';
        return normalizePath((dir && dir !== '/' ? dir + '/' : '') + 'cards');
    }

    cardFile(id) {
        const f = this.app.metadataCache.getFirstLinkpathDest(
            id, this.file ? this.file.path : '');
        return f instanceof TFile ? f : null;
    }

    // ---- rendering -------------------------------------------------------

    render() {
        // Rebuilding the board detaches the editor, which drops its focus;
        // the card being written gets it back with its selection, so
        // typing carries on through a reload such as a sync's.
        const ed = this.editing;
        const focused = this.pageDoc().activeElement;
        const keep = ed && ed.editor.el.contains(focused) &&
            ed.editor.selection();
        const f = this.find;
        const typing = f && f.input === focused &&
            [f.input.selectionStart, f.input.selectionEnd];
        this.drawBoard();
        if (keep && this.editing === ed && ed.editor.el.isConnected) {
            ed.editor.focusAt(keep[0], keep[1]);
        }
        // The find bar is drawn again with the board, and keeps its place.
        if (this.find) {
            this.renderFind();
            if (typing) {
                this.find.input.focus();
                this.find.input.setSelectionRange(typing[0], typing[1]);
            }
        }
    }

    drawBoard() {
        const el = this.contentEl;
        if (this.observer) this.observer.disconnect();
        if (this.resizer) this.resizer.disconnect();
        // Keep cached card renderings: they are re-attached below, so a
        // structural change rebuilds the frame, not the markdown.
        el.empty();
        this.cardEls.clear();
        el.style.setProperty('--dendrite-card-width',
                             this.plugin.settings.cardWidth + 'px');
        if (!this.file) {
            el.createDiv({ cls: 'dendrite-empty',
                           text: 'Open an index note in Dendrite.' });
            return;
        }
        this.renderBar(el);
        const stage = el.createDiv({ cls: 'dendrite-stage' });
        const board = stage.createDiv({ cls: 'dendrite-board' });
        this.board = board;
        // The flow is one SVG inside the board, behind the columns, so the
        // board's horizontal scroll carries it with them. Columns do not
        // scroll natively on the desktop: the browser scrolls off the main
        // thread, so anything redrawn from a scroll event trails the
        // content it follows. Dendrite moves each column's content itself
        // and redraws the flow in the same frame. On a phone native
        // scrolling is kept for its momentum.
        this.nativeScroll = !!Platform.isMobile;
        board.toggleClass('is-native-scroll', this.nativeScroll);
        const NS = 'http://www.w3.org/2000/svg';
        this.flowSvg = this.pageDoc().createElementNS(NS, 'svg');
        this.flowSvg.classList.add('dendrite-flow');
        board.appendChild(this.flowSvg);
        this.colInners = [];
        this.offsets = [];
        board.addEventListener('scroll', (e) => {
            if (e.target === board) return;
            // The editor can scroll a column itself to show its caret,
            // which on the desktop would stack on the view's own offset.
            // That scroll is moved into the offset instead.
            const col = e.target;
            if (!this.nativeScroll && col.scrollTop &&
                col.classList.contains('dendrite-col')) {
                const d = Number(col.dataset.depth);
                const by = col.scrollTop;
                col.scrollTop = 0;
                this.setColOffset(d, this.colOffset(d) + by);
            }
            this.scheduleFlow();
        }, true);
        // A copy or cut can be handled by another plugin that focuses a
        // hidden textarea, and the browser then scrolls the board to show
        // it, moving every column sideways. The board's position is held
        // for a moment after one.
        for (const t of ['copy', 'cut']) {
            board.addEventListener(t, () => this.holdBoardScroll(), true);
        }
        if (!this.nativeScroll) {
            board.addEventListener('wheel', (e) => this.onWheel(e),
                                   { passive: false });
        } else {
            // A phone scrolls natively: a touch is a hand scrolling.
            board.addEventListener('touchmove', () => {
                this.scrolledByHand = true;
            }, { passive: true });
        }
        this.renderOrphans(stage);
        const cols = core.columns(this.root);
        this.cols = cols;
        if (!cols.length) {
            const empty = board.createDiv({ cls: 'dendrite-empty' });
            empty.createSpan({ text: 'No cards yet. ' });
            const b = empty.createEl('button', { text: 'Add the first card' });
            b.onclick = () => this.insert('first');
            return;
        }
        cols.forEach((nodes, d) => {
            const col = board.createDiv({ cls: 'dendrite-col' });
            col.dataset.depth = String(d);
            const inner = col.createDiv({ cls: 'dendrite-col-inner' });
            this.colInners[d] = inner;
            this.offsets[d] = 0;
            inner.createDiv({ cls: 'dendrite-spacer' });
            let group = null;
            let parent;
            for (const n of nodes) {
                if (!group || n.parent !== parent) {
                    group = inner.createDiv({ cls: 'dendrite-group' });
                    parent = n.parent;
                }
                this.renderShell(group, n);
            }
            inner.createDiv({ cls: 'dendrite-spacer' });
        });
        this.applyActive(false);
        // The cards were rebuilt: anything floating over the old ones goes.
        this.announceScroll();
        this.updateNumbers();
        this.updateRoles();
        this.updateStatuses();
        this.updateCounts();
    }

    renderBar(el) {
        // Buttons from the left: the manuscript's settings and index note
        // as two icons, undo and redo, then preview and export. After
        // them, read-outs: the mode, the totals and the tally. The name
        // is the pane's own title. Nothing sits at the right, where other
        // plugins' overlays, such as LiveSync's status, are drawn.
        const bar = el.createDiv({ cls: 'dendrite-bar' });
        const btn = (icon, label, title, fn) => {
            const b = bar.createEl('button', { cls: 'dendrite-bar-btn' });
            setIcon(b.createSpan({ cls: 'dendrite-bar-icon' }), icon);
            if (label) b.createSpan({ text: label });
            b.setAttr('aria-label', title);
            b.onclick = fn;
            return b;
        };
        btn('settings', '', 'This manuscript\'s settings',
            () => new ManuscriptModal(this).open());
        btn('file-text', '', 'Open the index note as markdown',
            () => this.plugin.openAsMarkdown(this.file))
            .addClass('dendrite-bar-gap');
        btn('undo-2', 'Undo', 'Undo the last change to the tree: moves, ' +
            'new and deleted cards, roles and statuses (Ctrl+Z). A card\'s ' +
            'text is undone inside the card.', () => this.doUndo());
        btn('redo-2', 'Redo', 'Redo what was undone (Ctrl+Shift+Z or ' +
            'Ctrl+Y)', () => this.doRedo()).addClass('dendrite-bar-gap');
        btn('scroll-text', 'Preview', 'Show what export would print, ' +
            'beside the board', () => this.plugin.openPreview(this.file));
        btn('file-output', 'Export', 'Export the manuscript to markdown, ' +
            'PDF or Word', (e) => this.exportMenu(null, e));
        this.modeEl = bar.createDiv({ cls: 'dendrite-mode' });
        this.showMode();
        this.totalEl = bar.createDiv({ cls: 'dendrite-total' });
        this.statusEl = bar.createDiv({ cls: 'dendrite-tally' });
    }

    /**
     * Card notes in cards/ that the index does not link, in a panel
     * floating over the board's top right, each to add or to delete.
     */
    async renderOrphans(stage) {
        const files = this.unlinkedCards();
        if (!files.length) return;
        const panel = stage.createDiv({ cls: 'dendrite-orphans' });
        const head = panel.createDiv({ cls: 'dendrite-orphans-head' });
        head.createSpan({ text: `${files.length} card note(s) not in ` +
                          'the index' });
        const list = panel.createDiv({ cls: 'dendrite-orphans-list' });
        const empty = [];
        for (const f of files) {
            const body = core.splitFrontmatter(
                await this.app.vault.cachedRead(f)).body;
            if (!body.trim()) empty.push(f);
            const row = list.createDiv({ cls: 'dendrite-orphan' });
            row.createSpan({ cls: 'dendrite-orphan-label',
                             text: core.deriveLabel(body, null) || 'empty' });
            const add = row.createEl('button', { text: 'Add' });
            add.setAttr('aria-label', 'Add at the end of the index');
            add.onclick = () => this.adopt([f]);
            const del = row.createEl('button', { cls: 'mod-warning',
                                                 text: 'Delete' });
            del.setAttr('aria-label', 'Move the note to the trash');
            del.onclick = () => this.trashOrphans([f]);
        }
        const foot = panel.createDiv({ cls: 'dendrite-orphans-foot' });
        const all = foot.createEl('button', { text: 'Add all' });
        all.onclick = () => this.adopt(files);
        if (empty.length) {
            const b = foot.createEl('button', { cls: 'mod-warning',
                text: `Delete ${empty.length} empty` });
            b.onclick = () => this.trashOrphans(empty);
        }
    }

    async trashOrphans(files) {
        for (const f of files) await this.app.fileManager.trashFile(f);
        this.render();
    }

    renderShell(group, n) {
        const card = group.createDiv({ cls: 'dendrite-card' });
        card.dataset.id = n.id;
        if (n.children.length) card.addClass('has-children');
        // Top right: what the card prints, which turns into the handle
        // it is dragged by under the pointer; a click changes the role.
        const grip = card.createDiv({ cls: 'dendrite-grip' });
        grip.createSpan({ cls: 'dendrite-role-icon' });
        setIcon(grip.createSpan({ cls: 'dendrite-grip-icon' }),
                'grip-vertical');
        const body = card.createDiv({ cls: 'dendrite-card-body' });
        const cached = this.rendered.get(n.id);
        const f = this.cardFile(n.id);
        if (this.editing && this.editing.id === n.id) {
            body.appendChild(this.editing.editor.el);
            card.addClass('is-editing');
            card.toggleClass('has-obsidian-editor',
                             this.editing.editor.kind === 'obsidian');
        } else if (cached && f && cached.mtime === f.stat.mtime) {
            body.appendChild(cached.el);
        } else {
            body.createDiv({ cls: 'dendrite-placeholder',
                             text: n.label || n.id });
            card.addClass('is-pending');
        }
        // One footer row: the quota at the left, the active card's tools
        // at the right.
        const foot = card.createDiv({ cls: 'dendrite-card-foot' });
        this.renderQuotaWidget(foot, n.id);
        // The id's own part, a short name for the card that find knows; a
        // click copies it.
        const tag = foot.createSpan({ cls: 'dendrite-id',
                                      text: core.shortId(n.id) });
        tag.setAttr('aria-label', `${n.id}: click to copy ` +
                    `${core.shortId(n.id)}`);
        tag.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyId(n.id);
        });
        this.cardEls.set(n.id, card);
        if (this.observer) this.observer.observe(card);
        if (this.resizer) this.resizer.observe(card);
    }

    onVisible(entries) {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            const id = e.target.dataset.id;
            this.observer.unobserve(e.target);
            if (e.target.hasClass('is-pending')) this.renderCard(id);
        }
    }

    invalidate(id) {
        const r = this.rendered.get(id);
        if (r) {
            r.comp.unload();
            this.rendered.delete(id);
        }
    }

    async renderCard(id) {
        const card = this.cardEls.get(id);
        if (!card || (this.editing && this.editing.id === id)) return;
        const body = card.querySelector('.dendrite-card-body');
        const f = this.cardFile(id);
        if (!f) {
            card.removeClass('is-pending');
            card.addClass('is-missing');
            body.empty();
            body.createDiv({ cls: 'dendrite-placeholder',
                             text: `Missing note: ${id}` });
            return;
        }
        const cached = this.rendered.get(id);
        if (cached && cached.mtime === f.stat.mtime) {
            body.empty();
            body.appendChild(cached.el);
            card.removeClass('is-pending');
            return;
        }
        const text = core.splitFrontmatter(
            await this.app.vault.cachedRead(f)).body;
        const comp = new Component();
        comp.load();
        const out = createDiv({ cls: 'dendrite-md markdown-rendered' });
        if (text.trim()) {
            await MarkdownRenderer.render(this.app, text, out, f.path, comp);
        } else {
            out.createDiv({ cls: 'dendrite-placeholder',
                            text: 'Empty card' });
        }
        this.invalidate(id);
        this.rendered.set(id, { el: out, comp, mtime: f.stat.mtime });
        const now = this.cardEls.get(id);
        if (now && !(this.editing && this.editing.id === id)) {
            const b = now.querySelector('.dendrite-card-body');
            b.empty();
            b.appendChild(out);
            now.removeClass('is-pending');
            now.removeClass('is-missing');
            // Its rendered height replaces the placeholder's, which moves
            // the centre if the card is on the active card's lineage;
            // unless a column has been scrolled by hand since, as cards
            // are drawn when scrolled into view and would pull it back.
            if (this.lineage && this.lineage.has(id) && !this.scrolledByHand) {
                this.centre(false);
            }
            this.scheduleFlow();
            if (this.find) this.paintFind();
        }
    }

    /** Highlight the active card's lineage and bring it into view. */
    applyActive(smooth = true) {
        this.highlight();
        this.centre(smooth);
    }

    highlight() {
        if (!this.board) return;
        const node = this.active && this.byId.get(this.active);
        const lineage = new Set();
        if (node) {
            for (let n = node; n && n.id; n = n.parent) lineage.add(n.id);
            for (const d of core.descendants(node)) lineage.add(d.id);
        }
        this.lineage = lineage;
        if (this.plugin.previewActive) {
            this.plugin.previewActive(this.file, this.active);
        }
        this.board.toggleClass('has-active', !!node);
        for (const [id, el] of this.cardEls) {
            el.toggleClass('is-active', id === this.active);
            el.toggleClass('is-lineage', lineage.has(id));
        }
        this.renderToolbar();
        this.scheduleFlow();
    }

    onResize() {
        if (this.resizeFrame) return;
        this.resizeFrame = this.pageWin().requestAnimationFrame(() => {
            this.resizeFrame = null;
            // On the desktop, centring redraws the flow itself.
            this.centre(false);
            if (this.nativeScroll) this.drawFlow();
        });
    }

    scheduleFlow() {
        if (this.flowFrame) return;
        this.flowFrame = this.pageWin().requestAnimationFrame(() => {
            this.flowFrame = null;
            this.drawFlow();
        });
    }

    /**
     * Gingko's flow: a band from the right edge of each card on the active
     * path, from the root down to the active card, widening to the left
     * edge of the group holding its children in the next column.
     */
    drawFlow() {
        const svg = this.flowSvg;
        if (!svg || !this.board) return;
        while (svg.firstChild) svg.firstChild.remove();
        for (const g of this.board.querySelectorAll('.is-flow')) {
            g.classList.remove('is-flow');
        }
        const node = this.active && this.byId.get(this.active);
        if (!node) return;
        // In the board's content coordinates: the SVG spans the board's
        // full scroll width and moves with its horizontal scroll.
        svg.style.width = this.board.scrollWidth + 'px';
        svg.style.height = this.board.clientHeight + 'px';
        const box = this.board.getBoundingClientRect();
        const sx = this.board.scrollLeft;
        const rel = (el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left - box.left + sx,
                     right: r.right - box.left + sx,
                     top: r.top - box.top, bottom: r.bottom - box.top,
                     r: parseFloat(getComputedStyle(el).borderTopLeftRadius)
                        || 0 };
        };
        // Grey context: each card on the path opens into its whole group
        // of children. Purple thread: each card on the path leads to the
        // specific next card, ending at the active card.
        const pairs = [];
        const steps = [];
        for (let n = node; n && n.id; n = n.parent) {
            const card = this.cardEls.get(n.id);
            if (!card) continue;
            if (n.parent && n.parent.id) {
                const up = this.cardEls.get(n.parent.id);
                if (up) steps.push({ from: rel(up), to: rel(card) });
            }
            if (!n.children.length) continue;
            const child = this.cardEls.get(n.children[0].id);
            const group = child && child.parentElement;
            if (!group) continue;
            group.classList.add('is-flow');
            pairs.push({ card: rel(card), group: rel(group) });
        }
        const NS = 'http://www.w3.org/2000/svg';
        const draw = (cls, d) => {
            if (!d) return;
            const path = this.pageDoc().createElementNS(NS, 'path');
            path.setAttribute('class', cls);
            path.setAttribute('d', d);
            svg.appendChild(path);
        };
        draw('dendrite-flow-context', core.flowPath(pairs));
        draw('dendrite-flow-thread', core.threadPath(steps));
    }

    /**
     * Centre the active card, horizontally and vertically, and in every
     * other column the part of its lineage that column holds.
     */
    centre(smooth = true, typed = false) {
        if (!this.board) return;
        this.scrolledByHand = false;
        const node = this.active && this.byId.get(this.active);
        if (!node) return;
        const behavior = smooth ? 'smooth' : 'auto';
        const cols = this.board.querySelectorAll('.dendrite-col');
        const pos = (id) => {
            const el = this.cardEls.get(id);
            return el ? { top: el.offsetTop, height: el.offsetHeight } : null;
        };
        const heights = [...cols].map((c) => c.clientHeight);
        const own = this.ownOffset(node, pos(node.id), heights[node.depth],
                                   typed);
        this.placed = node.id;
        const targets = core.alignColumns(this.cols, node, pos, heights,
                                          own);
        if (this.nativeScroll) {
            cols.forEach((col, d) => {
                if (targets[d] !== null) {
                    col.scrollTo({ top: targets[d], behavior });
                }
            });
        } else {
            this.animateOffsets(targets, smooth);
        }
        const col = cols[node.depth];
        if (col) {
            const left = col.offsetLeft -
                (this.board.clientWidth - col.offsetWidth) / 2;
            this.board.scrollTo({ left, behavior });
        }
    }

    /**
     * Where the active card's own column goes, or null to centre the card.
     * While it is written in, only typing moves it, by the caret: to the
     * column's middle in typewriter mode, otherwise into view, with a
     * card that fits still centred. Anything else, such as a card beside
     * it redrawn, leaves it where it is, so text never moves under a
     * click. A card taller than its column shows its top when moved to,
     * and stays where it is after that.
     */
    ownOffset(node, box, height, typed) {
        if (!box || !height) return null;
        const d = node.depth;
        const ed = this.editing;
        const typewriter = this.plugin.settings.typewriter !== false;
        const tall = core.tallTop(box, height, CARD_MARGIN) !== null;
        if (ed && ed.id === node.id && !typed) return this.colOffset(d);
        if (ed && ed.id === node.id && (typewriter || tall) &&
            ed.editor.caretRect && this.colInners[d]) {
            const r = ed.editor.caretRect();
            if (r) {
                const base = this.colInners[d].getBoundingClientRect().top;
                const caret = { top: r.top - base, bottom: r.bottom - base };
                return core.caretOffset(caret, height, this.colOffset(d),
                                        CARD_MARGIN, typewriter);
            }
        }
        if (!tall) return null;
        if (this.placed === node.id) {
            const cur = this.colOffset(d);
            return Math.max(box.top - CARD_MARGIN, Math.min(cur,
                box.top + box.height + CARD_MARGIN - height));
        }
        return core.tallTop(box, height, CARD_MARGIN);
    }

    /** Move the active column to the caret once the editor has drawn. */
    followCaret() {
        if (this.caretFrame) return;
        const win = this.pageWin();
        this.caretFrame = win.requestAnimationFrame(() => {
            this.caretFrame = null;
            if (this.editing) this.centre(false, true);
        });
    }

    /** A column's scroll position, however it is scrolled. */
    colOffset(d) {
        const cols = this.board.querySelectorAll('.dendrite-col');
        if (this.nativeScroll) return cols[d] ? cols[d].scrollTop : 0;
        return this.offsets[d] || 0;
    }

    /** Scroll a column to `y`, clamped to its content. */
    setColOffset(d, y) {
        const col = this.board.querySelectorAll('.dendrite-col')[d];
        const inner = this.colInners[d];
        if (!col || !inner) return;
        const max = Math.max(0, inner.scrollHeight - col.clientHeight);
        const v = Math.max(0, Math.min(max, y));
        if (this.nativeScroll) {
            col.scrollTop = v;
            return;
        }
        this.offsets[d] = v;
        inner.style.transform = `translateY(${-v}px)`;
        this.announceScroll();
    }

    /**
     * Columns move by transform, which the browser does not count as a
     * scroll, so popups that close on scroll, such as another plugin's
     * citation tooltip, would stay behind. A scroll event says the
     * content moved; the board's own scroll listener ignores it.
     */
    announceScroll() {
        if (!this.board) return;
        const win = this.pageWin();
        this.board.dispatchEvent(new win.Event('scroll'));
    }

    /**
     * Move columns to their targets, easing over a few frames, with the
     * flow redrawn in each frame so it never trails the cards.
     */
    animateOffsets(targets, smooth) {
        if (this.anim) this.pageWin().cancelAnimationFrame(this.anim);
        this.anim = null;
        const from = targets.map((_, d) => this.colOffset(d));
        if (!smooth) {
            targets.forEach((y, d) => {
                if (y !== null) this.setColOffset(d, y);
            });
            this.drawFlow();
            return;
        }
        // Timed from the first frame's own timestamp: each window keeps
        // its own clock, so the global one is behind or ahead of a popout's.
        let start = null;
        const DURATION = 220;
        const step = (now) => {
            if (start === null) start = now;
            const k = Math.min(1, Math.max(0, (now - start) / DURATION));
            const e = 1 - Math.pow(1 - k, 3);
            targets.forEach((y, d) => {
                if (y !== null) {
                    this.setColOffset(d, from[d] + (y - from[d]) * e);
                }
            });
            this.drawFlow();
            this.anim = k < 1 ?
                this.pageWin().requestAnimationFrame(step) : null;
        };
        this.anim = this.pageWin().requestAnimationFrame(step);
    }

    /** Keep the board's horizontal scroll where it is for a moment. */
    holdBoardScroll() {
        const board = this.board;
        const x = board.scrollLeft;
        const hold = (e) => {
            if (e.target === board && board.scrollLeft !== x) {
                board.scrollLeft = x;
            }
        };
        board.addEventListener('scroll', hold);
        this.pageWin().setTimeout(
            () => board.removeEventListener('scroll', hold), 300);
    }

    /** The wheel scrolls the column under it, flow redrawn the same frame. */
    onWheel(e) {
        if (e.ctrlKey) return;
        const horizontal = e.shiftKey ||
            Math.abs(e.deltaX) > Math.abs(e.deltaY);
        if (horizontal) return;
        const col = e.target.closest && e.target.closest('.dendrite-col');
        if (!col) return;
        e.preventDefault();
        if (this.anim) {
            this.pageWin().cancelAnimationFrame(this.anim);
            this.anim = null;
        }
        const d = Number(col.dataset.depth);
        this.scrolledByHand = true;
        const unit = e.deltaMode === 1 ? 16 :
            (e.deltaMode === 2 ? col.clientHeight : 1);
        this.setColOffset(d, this.colOffset(d) + e.deltaY * unit);
        this.drawFlow();
    }

    /** A link to the card, to paste where a table or figure is cited. */
    async copyRef(id) {
        const ref = `[[${id}]]`;
        try {
            await this.pageWin().navigator.clipboard.writeText(ref);
            new Notice(`Copied ${ref}`);
        } catch (err) {
            new Notice(`Could not copy ${ref}`);
        }
    }

    async copyId(id) {
        const short = core.shortId(id);
        try {
            await this.pageWin().navigator.clipboard.writeText(short);
            new Notice(`Copied ${short}`);
        } catch (err) {
            new Notice(`Could not copy ${short}`);
        }
    }

    renderToolbar() {
        if (this.toolbar) this.toolbar.remove();
        this.toolbar = null;
        const card = this.active && this.cardEls.get(this.active);
        if (!card || this.editing) return;
        const foot = card.querySelector(':scope > .dendrite-card-foot') ||
            card.createDiv({ cls: 'dendrite-card-foot' });
        const t = foot.createDiv({ cls: 'dendrite-toolbar' });
        const btn = (icon, title, fn) => {
            const b = t.createEl('button', { cls: 'clickable-icon' });
            setIcon(b, icon);
            b.setAttr('aria-label', title);
            b.onclick = (e) => { e.stopPropagation(); fn(); };
        };
        btn('pencil', 'Edit (Enter)', () => this.startEdit(this.active));
        btn('arrow-down-to-line', 'New card below (Ctrl+↓)',
            () => this.insert('below'));
        btn('corner-down-right', 'New child card (Ctrl+→)',
            () => this.insert('child'));
        btn('sliders-horizontal', 'Card properties: label and limit',
            () => new CardModal(this, this.active).open());
        btn('more-horizontal', 'More', () => this.cardMenu(t));
        this.toolbar = t;
    }

    /** The role choices for a card, the current one checked. */
    addRoleItems(m, id) {
        const role = this.roleOf(id);
        const node = this.byId.get(id);
        const auto = node && node.children.length ? 'heading only' :
            'full text';
        for (const [value, title, icon, key] of
            [[null, `Prints automatically (${auto})`, 'wand', '0'],
             ...ROLE_ITEMS]) {
            m.addItem((i) => {
                i.setTitle(this.menuLabel(title, key)).setIcon(icon)
                    .onClick(() => this.setRole(id, value));
                if (typeof i.setChecked === 'function') {
                    i.setChecked(role === value);
                    tickBeforeKey(i);
                }
            });
        }
        m.addSeparator();
        const kind = this.kindOf(id);
        for (const [value, title, icon] of KIND_ITEMS) {
            m.addItem((i) => {
                i.setTitle(title).setIcon(icon)
                    .onClick(() => this.setKind(id, value));
                if (typeof i.setChecked === 'function') {
                    i.setChecked(kind === value);
                }
            });
        }
        if (node && node.children.length) this.addBranchItems(m, id);
    }

    /**
     * Roles and statuses for a card and everything below it, in a submenu
     * where Obsidian has them, else as items of their own.
     */
    addBranchItems(m, id) {
        let sub = null;
        m.addSeparator();
        m.addItem((i) => {
            i.setTitle('Whole branch').setIcon('list-tree');
            if (typeof i.setSubmenu === 'function') sub = i.setSubmenu();
        });
        const into = sub || m;
        const lead = sub ? '' : 'Whole branch: ';
        for (const [value, title, icon, key] of
            [[null, 'Prints automatically', 'wand', '0'], ...ROLE_ITEMS]) {
            into.addItem((i) => i.setTitle(this.menuLabel(lead + title,
                `Alt+${key}`)).setIcon(icon)
                .onClick(() => this.setBranch(id, 'role', value)));
        }
        into.addSeparator();
        for (const [value, title, icon, key] of STATUS_ITEMS) {
            into.addItem((i) => i.setTitle(this.menuLabel(lead + title,
                `Ctrl+Alt+${key}`)).setIcon(icon)
                .onClick(() => this.setBranch(id, 'status', value)));
        }
    }

    /**
     * Set a role on a card and every card below it, or a status on every
     * card there that prints its text, as one step to undo.
     */
    async setBranch(id, what, value) {
        const node = this.byId.get(id);
        if (!node) return;
        const roleOf = (x) => this.printRoleOf(x);
        const key = what === 'role' ? 'dendrite_role' : 'dendrite_status';
        const restores = [];
        for (const c of [node, ...core.descendants(node)]) {
            const f = this.cardFile(c.id);
            if (!f) continue;
            if (what === 'status' && core.roleFor(c, roleOf) !== 'prose') {
                continue;
            }
            const cur = what === 'role' ? this.roleOf(c.id) :
                this.statusOf(c.id);
            if ((cur || null) === (value || null)) continue;
            const data = await this.app.vault.read(f);
            restores.push({ path: f.path, text: data,
                            ifBody: core.splitFrontmatter(data).body });
            await writeProps(this.app, f, { [key]: value || null });
        }
        if (what === 'role') await this.sweepStatuses();
        const n = restores.length;
        if (n) {
            this.pushUndo({ active: this.active, files: [], created: [],
                            restores, text: false });
        }
        const name = what === 'role' ? (BRANCH_ROLE_NAMES[value || ''])
            : value;
        new Notice(n ? `Dendrite: ${n} card${n === 1 ? '' : 's'} in the ` +
            `branch set to ${name}.` : `Dendrite: the branch is already ` +
            `${name}.`);
    }

    /**
     * A menu item's title with its key as a chip at the right. The chip
     * draws its key from data-key, so the title's text stays the title.
     */
    menuLabel(title, key) {
        const doc = this.pageDoc();
        const label = doc.createDocumentFragment();
        const row = label.appendChild(doc.createElement('span'));
        row.className = 'dendrite-menu-row';
        row.appendChild(doc.createElement('span')).textContent = title;
        const chip = row.appendChild(doc.createElement('kbd'));
        chip.className = 'dendrite-menu-key';
        chip.dataset.key = key;
        return label;
    }

    /** The role choices alone, from a card's corner icon. */
    roleMenu(id, anchor) {
        const { Menu } = require('obsidian');
        const m = new Menu();
        this.addRoleItems(m, id);
        const r = anchor.getBoundingClientRect();
        m.showAtPosition({ x: r.left, y: r.bottom }, this.pageDoc());
    }

    cardMenu(anchor, event) {
        const { Menu } = require('obsidian');
        const m = new Menu();
        const item = (title, icon, fn) => m.addItem((i) =>
            i.setTitle(title).setIcon(icon).onClick(fn));
        item('New card above (Ctrl+↑)', 'arrow-up-to-line',
             () => this.insert('above'));
        item('Move up (Alt+↑)', 'arrow-up', () => this.structural('up'));
        item('Move down (Alt+↓)', 'arrow-down',
             () => this.structural('down'));
        item('Indent (Alt+→)', 'indent', () => this.structural('indent'));
        item('Outdent (Alt+←)', 'outdent', () => this.structural('outdent'));
        m.addSeparator();
        item('Card properties…', 'sliders-horizontal',
             () => new CardModal(this, this.active).open());
        item('Copy reference', 'link', () => this.copyRef(this.active));
        // Status, then what this card prints.
        const id = this.active;
        const info = this.statusInfo && this.statusInfo.get(id);
        if (info && info.prints) {
            m.addSeparator();
            for (const [value, title, icon, key] of STATUS_ITEMS) {
                m.addItem((i) => {
                    i.setTitle(this.menuLabel(title, `Ctrl+${key}`))
                        .setIcon(icon)
                        .onClick(() => this.setStatus(id, value));
                    if (typeof i.setChecked === 'function') {
                        i.setChecked(info.own === value);
                        tickBeforeKey(i);
                    }
                });
            }
        } else if (info && info.own === 'unsplit') {
            m.addSeparator();
            item('Keep the leftover text as notes', 'check',
                 () => this.setStatus(id, null));
        }
        m.addSeparator();
        this.addRoleItems(m, id);
        m.addSeparator();
        const branch = this.byId.get(this.active);
        item('Export this branch to markdown', 'file-output',
             () => this.exportTo(branch, 'md'));
        if (Platform.isDesktopApp) {
            item('Export this branch to PDF', 'file-output',
                 () => this.exportTo(branch, 'pdf'));
            item('Export this branch to Word', 'file-output',
                 () => this.exportTo(branch, 'docx'));
        }
        item('Open card note', 'file', () => {
            const f = this.cardFile(this.active);
            if (f) this.plugin.openAsMarkdown(f);
        });
        m.addSeparator();
        item('Merge into the card above', 'merge',
             () => this.merge('above'));
        item('Merge into the parent card', 'arrow-left-to-line',
             () => this.merge('parent'));
        m.addSeparator();
        item('Delete card and its children (Ctrl+Backspace)', 'trash-2',
             () => this.deleteActive());
        if (event) {
            m.showAtMouseEvent(event);
            return;
        }
        const r = anchor.getBoundingClientRect();
        m.showAtPosition({ x: r.left, y: r.bottom }, this.pageDoc());
    }

    // ---- interaction -----------------------------------------------------

    onClick(e) {
        // The click that ends a drag is not a click on a card.
        if (this.justDragged) {
            this.justDragged = false;
            return;
        }
        // A selection dragged out of a card ends with a click on what
        // holds both ends, the column or the board. Taking the focus for
        // the board then would leave the selection showing and the keys
        // going nowhere.
        if (this.pressInText) {
            this.pressInText = false;
            return;
        }
        const link = e.target.closest('a.internal-link');
        if (link) {
            e.preventDefault();
            const href = link.getAttr('data-href') || link.getAttr('href');
            this.app.workspace.openLinkText(href, this.file.path,
                                            Keymap.isModEvent(e));
            return;
        }
        if (e.target.closest('.dendrite-toolbar, textarea, .dendrite-cm, ' +
                             'button, .dendrite-quota, .dendrite-id')) {
            return;
        }
        const grip = e.target.closest('.dendrite-grip');
        if (grip) {
            const id = grip.parentElement.dataset.id;
            this.select(id, false).then(() => this.roleMenu(id, grip));
            return;
        }
        const card = e.target.closest('.dendrite-card');
        if (card) this.select(card.dataset.id);
        this.contentEl.focus();
    }

    /**
     * Make a card the active one. `move` false highlights it without
     * scrolling, so a menu opened on it stays beside it.
     */
    async select(id, move = true) {
        if (!id || id === this.active) return;
        if (this.editing) await this.endEdit();
        const node = this.byId.get(id);
        if (node && node.parent && node.parent.id) {
            this.lastChild.set(node.parent.id, id);
        }
        this.active = id;
        if (move) this.applyActive();
        else this.highlight();
    }

    navigate(dir) {
        const node = this.active && this.byId.get(this.active);
        if (!node) return;
        if (dir === 'left') {
            if (node.parent && node.parent.id) this.select(node.parent.id);
        } else if (dir === 'right') {
            if (!node.children.length) return;
            const last = this.lastChild.get(node.id);
            const pick = node.children.find((c) => c.id === last) ||
                node.children[0];
            this.select(pick.id);
        } else {
            const col = this.cols[node.depth];
            const i = col.indexOf(node) + (dir === 'up' ? -1 : 1);
            if (i >= 0 && i < col.length) this.select(col[i].id);
        }
    }

    registerKeys() {
        const s = this.scope;
        // A handler returning false has handled the key. While a card is
        // being edited, plain keys belong to the text area.
        const nav = (dir) => () => {
            if (this.editing) return true;
            this.navigate(dir);
            return false;
        };
        for (const [key, dir] of [['ArrowUp', 'up'], ['ArrowDown', 'down'],
                                  ['ArrowLeft', 'left'],
                                  ['ArrowRight', 'right']]) {
            s.register([], key, nav(dir));
        }
        s.register([], 'Enter', () => {
            if (this.editing) return this.editKey('enter');
            if (this.active) this.startEdit(this.active);
            return false;
        });
        // Text commands inside the editor. Without these, the keys reach
        // Obsidian's app scope, which handles them for its own editor or
        // moves focus out of the pane.
        s.register(['Mod'], 'b', () => this.editKey('bold'));
        s.register(['Mod'], 'i', () => this.editKey('italic'));
        // Ctrl and 1 to 3 set the selected card's status, with Alt on its
        // whole branch, ahead of Obsidian's own Ctrl+1 to 3, which go to a
        // tab. onNavKey reads them too, for when this scope is not active.
        for (const [value, , , key] of STATUS_ITEMS) {
            const set = (branch) => () => {
                if (this.editing || !this.active) return true;
                if (branch) this.setBranch(this.active, 'status', value);
                else this.setStatusByKey(value);
                return false;
            };
            s.register(['Mod'], key, set(false));
            s.register(['Mod', 'Alt'], key, set(true));
        }
        s.register([], 'Tab', () => this.editKey('indent'));
        s.register(['Shift'], 'Tab', () => this.editKey('outdent'));
        s.register([], 'Escape', () => {
            if (this.drag && this.drag.started) {
                this.cancelDrag();
                return false;
            }
            // Leaving a card comes first; with no card open, find closes.
            if (this.editing) {
                this.endEdit();
                return false;
            }
            if (this.find) {
                this.closeFind();
                return false;
            }
            // Nothing to close: the key stops here, since Obsidian's own
            // Escape takes a popout's focus back to the main window.
            return false;
        });
        // In edit mode every key belongs to the card's text, Ctrl+arrows
        // for moving by word included; Escape is the only way out. These
        // shortcuts therefore act in normal mode only.
        s.register(['Mod'], 'Enter', () => {
            if (this.editing) return true;
            if (this.active) this.startEdit(this.active);
            return false;
        });
        for (const [key, where] of [['ArrowDown', 'below'], ['j', 'below'],
                                    ['ArrowUp', 'above'], ['k', 'above'],
                                    ['ArrowRight', 'child'],
                                    ['l', 'child']]) {
            s.register(['Mod'], key, () => {
                if (this.editing) return true;
                this.insert(where);
                return false;
            });
        }
        for (const [key, op] of [['ArrowUp', 'up'], ['ArrowDown', 'down'],
                                 ['ArrowRight', 'indent'],
                                 ['ArrowLeft', 'outdent']]) {
            s.register(['Alt'], key, () => {
                if (this.editing) return true;
                this.structural(op);
                return false;
            });
        }
        s.register(['Mod'], 'Backspace', () => {
            if (this.editing) return true;
            this.deleteActive();
            return false;
        });
        // Find, in edit mode too: it searches the whole manuscript.
        s.register(['Mod'], 'f', () => {
            this.openFind();
            return false;
        });
        s.register(['Mod'], 'z', () => {
            if (this.undoInEditor()) return false;
            if (this.editing) return true;
            this.doUndo();
            return false;
        });
        // Redo: the board's in normal mode; in a card, the card's own
        // history after a step back through it, else the editor's.
        for (const [mods, key] of [[['Mod', 'Shift'], 'z'], [['Mod'], 'y']]) {
            s.register(mods, key, () => {
                if (this.redoInEditor()) return false;
                if (this.editing) return true;
                this.doRedo();
                return false;
            });
        }
    }

    // ---- dragging cards -------------------------------------------------

    onDragDown(e) {
        // A press in text, such as the start of a selection, makes its
        // click part of editing that text, wherever the release lands.
        this.pressInText = !!(e.target.closest &&
            e.target.closest('.dendrite-cm, textarea, input'));
        if (e.button !== 0 || e.pointerType === 'touch') return;
        const card = e.target.closest('.dendrite-card');
        if (!card) return;
        // Any card but the selected one drags from anywhere on it, for
        // rearranging broadly; the selected card only by its handle, so
        // its text can still be selected. Controls never start a drag.
        const grip = e.target.closest('.dendrite-grip');
        if (!grip) {
            if (card.dataset.id === this.active) return;
            if (e.target.closest('a, button, input, textarea, ' +
                                 '.dendrite-cm, .dendrite-quota, ' +
                                 '.dendrite-toolbar, .dendrite-id')) return;
        }
        // No text selection or focus change from the press.
        e.preventDefault();
        this.cancelDrag();
        const win = this.pageWin();
        this.drag = { id: card.dataset.id, x: e.clientX, y: e.clientY,
                      started: false, target: null, win };
        win.addEventListener('pointermove', this.dragMove);
        win.addEventListener('pointerup', this.dragUp);
        win.addEventListener('pointercancel', this.dragCancel);
    }

    onDragMove(e) {
        const d = this.drag;
        if (!d) return;
        if (!d.started) {
            // A press becomes a drag only once it moves a few pixels, so
            // an ordinary click still selects the card.
            if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
            d.started = true;
            const node = this.byId.get(d.id);
            d.ghost = this.pageDoc().body.createDiv({ cls: 'dendrite-ghost',
                text: node ? (node.label || node.id) : d.id });
            const src = this.cardEls.get(d.id);
            if (src) src.addClass('is-dragging');
            this.board.addClass('is-dragging-card');
            const sel = this.pageWin().getSelection();
            if (sel) sel.removeAllRanges();
        }
        e.preventDefault();
        d.ghost.style.left = (e.clientX + 12) + 'px';
        d.ghost.style.top = (e.clientY + 12) + 'px';
        this.showDropTarget(this.dropTargetAt(e.clientX, e.clientY));
        this.autoScroll(e.clientX, e.clientY);
    }

    async onDragUp(e) {
        const d = this.drag;
        if (!d) return;
        const target = d.started ? d.target : null;
        if (d.started) {
            e.preventDefault();
            this.justDragged = true;
            setTimeout(() => { this.justDragged = false; }, 0);
        }
        this.cancelDrag();
        if (target) await this.dropCard(d.id, target.id, target.where);
    }

    cancelDrag() {
        const d = this.drag;
        this.drag = null;
        if (!d) return;
        d.win.removeEventListener('pointermove', this.dragMove);
        d.win.removeEventListener('pointerup', this.dragUp);
        d.win.removeEventListener('pointercancel', this.dragCancel);
        if (d.ghost) d.ghost.remove();
        if (this.board) this.board.removeClass('is-dragging-card');
        this.showDropTarget(null);
        const src = this.cardEls.get(d.id);
        if (src) src.removeClass('is-dragging');
    }

    /**
     * Where a card dropped at a point would go: over a card's right edge,
     * its last child; over its top half, above it; else below it. Null
     * over nothing, or over the dragged card's own branch.
     */
    dropTargetAt(x, y) {
        const d = this.drag;
        const doc = this.pageDoc();
        const el = doc.elementFromPoint ? doc.elementFromPoint(x, y) : null;
        const card = el && el.closest && el.closest('.dendrite-card');
        if (!d || !card) return null;
        const node = this.byId.get(d.id);
        const target = this.byId.get(card.dataset.id);
        if (!node || !target) return null;
        for (let p = target; p; p = p.parent) if (p === node) return null;
        const r = card.getBoundingClientRect();
        const where = x > r.right - r.width * 0.25 ? 'child' :
            (y < r.top + r.height / 2 ? 'above' : 'below');
        return { id: target.id, where };
    }

    showDropTarget(t) {
        if (this.drag) this.drag.target = t;
        for (const el of this.cardEls.values()) {
            el.removeClass('drop-above');
            el.removeClass('drop-below');
            el.removeClass('drop-child');
        }
        const el = t && this.cardEls.get(t.id);
        if (el) el.addClass(`drop-${t.where}`);
    }

    /** Near a column's top or bottom, or the board's sides, scroll. */
    autoScroll(x, y) {
        const EDGE = 48;
        const STEP = 14;
        this.board.querySelectorAll('.dendrite-col').forEach((col, d) => {
            const r = col.getBoundingClientRect();
            if (x < r.left || x > r.right) return;
            if (y < r.top + EDGE) {
                this.setColOffset(d, this.colOffset(d) - STEP);
            } else if (y > r.bottom - EDGE) {
                this.setColOffset(d, this.colOffset(d) + STEP);
            }
        });
        this.drawFlow();
        const b = this.board.getBoundingClientRect();
        if (x < b.left + EDGE) this.board.scrollLeft -= STEP;
        else if (x > b.right - EDGE) this.board.scrollLeft += STEP;
    }

    /** Drop a card, with its branch, above, below or into another. */
    async dropCard(id, targetId, where) {
        if (this.editing) await this.endEdit();
        const node = this.byId.get(id);
        const target = this.byId.get(targetId);
        const before = core.serialiseTree(this.root);
        if (!core.moveNode(node, target, where)) return;
        this.pushUndo({ tree: before, active: id, files: [] });
        this.active = id;
        await this.writeIndex();
        await this.sweepStatuses();
        this.render();
    }

    // ---- editing ---------------------------------------------------------

    /** Run a text command in the editor; true lets the key through. */
    editKey(cmd) {
        const ed = this.editing;
        // Outside the editor, Tab is held so it cannot move focus out of
        // the pane; every other key goes through.
        if (!ed) return cmd !== 'indent' && cmd !== 'outdent';
        // Obsidian's editor handles its own keys.
        if (!ed.ta) return true;
        const ta = ed.ta;
        const v = ta.value;
        const s = ta.selectionStart;
        const e = ta.selectionEnd;
        const r = cmd === 'bold' ? textedit.wrap(v, s, e, '**') :
            cmd === 'italic' ? textedit.wrap(v, s, e, '*') :
            cmd === 'indent' ? textedit.shiftLines(v, s, e, false) :
            cmd === 'outdent' ? textedit.shiftLines(v, s, e, true) :
            textedit.enter(v, s, e);
        if (!r) return true;
        ta.focus();
        ta.setSelectionRange(r.start, r.end);
        // insertText keeps the text area's undo history; setRangeText is
        // the fallback where the command is unavailable.
        let done = false;
        try {
            done = r.text ?
                this.pageDoc().execCommand('insertText', false, r.text) :
                (r.start === r.end || this.pageDoc().execCommand('delete'));
        } catch (err) {
            done = false;
        }
        if (!done) {
            ta.setRangeText(r.text, r.start, r.end, 'end');
            ta.dispatchEvent(new Event('input'));
        }
        ta.setSelectionRange(r.selStart, r.selEnd);
        return false;
    }

    async startEdit(id, atStart = false) {
        if (this.editing) {
            if (this.editing.id === id) return;
            await this.endEdit();
        }
        if (id !== this.active) {
            this.active = id;
            this.applyActive();
        }
        let f = this.cardFile(id);
        if (!f) f = await this.createCardFile(id);
        const raw = await this.app.vault.read(f);
        // The text as it was before this visit, for undo once it is left.
        const ed = { id, file: f, dirty: false, timer: null,
                     saving: Promise.resolve(),
                     before: core.splitFrontmatter(raw).body };
        ed.saved = ed.before;
        const editor = cardEditor(this.app, this, {
            value: core.splitFrontmatter(raw).body,
            file: f,
            onChange: () => {
                ed.dirty = true;
                ed.changed = true;
                // Typed, not a step through the card's history: what could
                // be redone no longer follows.
                if (!ed.applying) ed.stepped = false;
                // Typed into, even if cleared again: Ctrl+Z is the text's.
                ed.fresh = false;
                // The column follows the caret as the card is typed in.
                // Only typing moves it: a click or a selection never does,
                // or the text would move under the pointer.
                this.followCaret();
                this.scheduleCounts();
                clearTimeout(ed.timer);
                ed.timer = setTimeout(() => this.save(ed),
                                      this.plugin.settings.autosaveMs);
            },
            onBlur: () => { this.save(ed); },
            onEscape: () => { this.endEdit(); },
            onFind: () => { this.openFind(); },
            onRedraw: () => { if (this.find) this.paintFind(); },
            onUndo: () => this.undoInEditor(),
            onRedo: () => this.redoInEditor(),
        }, this.plugin.settings.obsidianEditor !== false);
        ed.editor = editor;
        // The text box's own commands (bold, Tab, lists) are Dendrite's;
        // Obsidian's editor brings its own.
        ed.ta = editor.ta || null;
        this.editing = ed;
        const card = this.cardEls.get(id);
        if (card) {
            const body = card.querySelector('.dendrite-card-body');
            body.empty();
            body.appendChild(editor.el);
            card.addClass('is-editing');
            card.toggleClass('has-obsidian-editor', editor.kind === 'obsidian');
            card.removeClass('is-pending');
        }
        this.renderToolbar();
        editor.focus(atStart);
        this.showMode();
        // The rendered card it replaced took find's paint with it.
        if (this.find) this.paintFind();
    }

    /** Write the editor's text to its card, keeping the frontmatter. */
    save(ed) {
        clearTimeout(ed.timer);
        if (!ed.dirty) return ed.saving;
        ed.dirty = false;
        const text = ed.editor.value;
        ed.saved = text;
        ed.saving = ed.saving.then(() => this.writeCard(ed.file,
            (data) => core.splitFrontmatter(data).fm + text))
            .then(() => {
                if (this.noteLabel(ed.id, text)) this.scheduleLabels();
            })
            .catch((err) => {
                ed.dirty = true;
                console.error('Dendrite: save failed', err);
                new Notice('Dendrite could not save the card; the text ' +
                           'is still in the editor.');
            });
        return ed.saving;
    }

    async flush() {
        if (this.editing) await this.save(this.editing);
        await this.writeLabels();
    }

    async endEdit() {
        const ed = this.editing;
        if (!ed) return;
        await this.save(ed);
        this.editing = null;
        ed.editor.destroy();
        await this.writeLabels();
        if (ed.changed) await this.clearFinishedSplit(ed.file);
        // Text written here is a draft until said otherwise.
        const node = this.byId.get(ed.id);
        if (ed.changed && node && !this.statusOf(ed.id) &&
            core.roleFor(node, (x) => this.printRoleOf(x)) === 'prose') {
            await this.setStatus(ed.id, 'draft');
        }
        if (ed.changed) await this.plugin.lintCard(ed.file);
        // The editor's own history goes with it, so the visit becomes one
        // step in the card's text history, undone from inside the card.
        if (ed.changed && !ed.recorded) {
            const after = core.splitFrontmatter(
                await this.app.vault.read(ed.file)).body;
            this.recordVisit(ed.id, ed.before, after);
        }
        this.invalidate(ed.id);
        const card = this.cardEls.get(ed.id);
        if (card) {
            card.removeClass('is-editing');
            card.removeClass('has-obsidian-editor');
            card.addClass('is-pending');
        }
        await this.renderCard(ed.id);
        this.renderToolbar();
        this.showMode();
        this.contentEl.focus();
    }

    showMode() {
        if (!this.modeEl) return;
        this.modeEl.setText(this.editing ? 'INSERT' : 'NORMAL');
        this.modeEl.toggleClass('is-insert', !!this.editing);
    }

    /**
     * Vim-style keys in normal mode, when no card is being edited. Plain
     * letters are bound to nothing else here, so they are handled from
     * the pane's own keydown rather than registered in Obsidian's scope.
     */
    onNavKey(e) {
        if (this.editing || e.defaultPrevented) return;
        if (e.target.closest('input, textarea, select, .dendrite-cm')) return;
        // Arrows and Enter are bound in the view's scope too, but that
        // scope is not always the active one after Obsidian's editor
        // closes, so they are also read here; defaultPrevented means the
        // scope already handled the key.
        if (this.arrowKey(e)) return;
        // Escape closes find here too, for when that scope is not active,
        // and otherwise goes no further, as in the scope.
        if (e.key === 'Escape') {
            e.preventDefault();
            if (this.find) this.closeFind();
            return;
        }
        // The number row by its physical key, since what a digit key types
        // with a modifier depends on the keyboard layout; the key's own
        // text where no code is given.
        const code = /^(?:Digit|Numpad)(\d)$/.exec(e.code || '');
        const digit = code ? code[1] : (/^\d$/.test(e.key) ? e.key : null);
        // Ctrl and 1 to 3 set a printing card's status, with Alt on the
        // whole branch; also registered in the scope, as there.
        const mod = e.ctrlKey || e.metaKey;
        const status = mod && !e.shiftKey && digit &&
            STATUS_ITEMS.find((r) => r[3] === digit);
        if (status) {
            if (!this.active) return;
            e.preventDefault();
            if (e.altKey) this.setBranch(this.active, 'status', status[0]);
            else this.setStatusByKey(status[0]);
            return;
        }
        // Alt with 0 to 4 sets a role on the whole branch.
        if (e.altKey && !mod && !e.shiftKey && ROLE_KEYS.has(digit) &&
            this.active) {
            e.preventDefault();
            this.setBranch(this.active, 'role', ROLE_KEYS.get(digit));
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const statusKey = { ']': () => this.nextFlagged(1),
                            '[': () => this.nextFlagged(-1),
                            '+': () => this.stepStatus(true),
                            '=': () => this.stepStatus(true),
                            '-': () => this.stepStatus(false) }[e.key];
        if (statusKey) {
            e.preventDefault();
            statusKey();
            return;
        }
        // 0 to 4 set what the selected card prints, as its menus show.
        if (!e.shiftKey && ROLE_KEYS.has(digit) && this.active) {
            e.preventDefault();
            this.setRole(this.active, ROLE_KEYS.get(digit));
            return;
        }
        if (!this.plugin.settings.vimKeys) return;
        const prev = this.pendingKey;
        this.pendingKey = null;
        const k = e.key;
        const act = {
            '/': () => this.openFind(),
            h: () => this.navigate('left'),
            j: () => this.navigate('down'),
            k: () => this.navigate('up'),
            l: () => this.navigate('right'),
            i: () => this.active && this.startEdit(this.active, true),
            a: () => this.active && this.startEdit(this.active),
            o: () => this.insert('below'),
            O: () => this.insert('above'),
            n: () => this.insert(this.active ? 'child' : 'first'),
            J: () => this.structural('down'),
            K: () => this.structural('up'),
            '>': () => this.structural('indent'),
            '<': () => this.structural('outdent'),
            u: () => this.doUndo(),
            G: () => this.columnEnd(false),
        }[k];
        // Two-key commands: dd deletes, gg goes to the column's top.
        if (k === 'd' || k === 'g') {
            e.preventDefault();
            if (prev === k) {
                if (k === 'd') this.deleteActive();
                else this.columnEnd(true);
            } else {
                this.pendingKey = k;
            }
            return;
        }
        if (!act) return;
        e.preventDefault();
        act();
    }

    /** Arrows, Alt and Ctrl arrows, and Enter; true if handled. */
    arrowKey(e) {
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            if (this.active) this.startEdit(this.active);
            return true;
        }
        const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left',
                      ArrowRight: 'right' }[e.key];
        if (!dir || e.shiftKey) return false;
        let act = null;
        if (e.altKey && !mod) {
            const op = { up: 'up', down: 'down', left: 'outdent',
                         right: 'indent' }[dir];
            act = () => this.structural(op);
        } else if (mod && !e.altKey) {
            const where = { up: 'above', down: 'below', right: 'child' }[dir];
            if (where) act = () => this.insert(where);
        } else if (!mod && !e.altKey) {
            act = () => this.navigate(dir);
        }
        if (!act) return false;
        e.preventDefault();
        act();
        return true;
    }

    columnEnd(top) {
        const node = this.active && this.byId.get(this.active);
        const col = node ? this.cols[node.depth] : this.cols[0];
        if (!col || !col.length) return;
        this.select((top ? col[0] : col[col.length - 1]).id);
    }

    /** Follow a card's label in memory; true if it changed. */
    noteLabel(id, body) {
        const node = this.byId.get(id);
        if (!node) return false;
        const f = this.cardFile(id);
        const fm = f && this.app.metadataCache.getFileCache(f)?.frontmatter;
        const label = core.deriveLabel(body, fm && fm.aliases);
        if (label === node.label) return false;
        node.label = label;
        return true;
    }

    async syncLabel(id, body) {
        if (this.noteLabel(id, body)) await this.writeIndex();
    }

    /** Write labels once typing pauses. */
    scheduleLabels() {
        clearTimeout(this.labelTimer);
        this.labelTimer = setTimeout(() => this.writeLabels(),
                                     this.labelIdleMs || LABEL_IDLE_MS);
    }

    /** Write the index if a label in memory differs from it. */
    async writeLabels() {
        clearTimeout(this.labelTimer);
        this.labelTimer = null;
        if (!this.file || this.indexList === null) return;
        if (core.serialiseTree(this.root) !== this.indexList) {
            await this.writeIndex();
        }
    }

    // ---- structure -------------------------------------------------------

    /**
     * Record a step for undo. A new step ends any redo, since the steps
     * it would redo no longer follow from the current state.
     */
    pushUndo(entry) {
        this.undo.push(entry);
        if (this.undo.length > UNDO_DEPTH) this.undo.shift();
        this.redo = [];
    }

    snapshot(files = [], created = []) {
        this.pushUndo({ tree: core.serialiseTree(this.root),
                         active: this.active, files, created });
    }

    async writeIndex() {
        const root = this.root;
        clearTimeout(this.labelTimer);
        let stale = false;
        await this.app.vault.process(this.file, (data) => {
            // The list on disk is not the one this board last read or
            // wrote: it came from elsewhere, so it is not overwritten.
            const disk = core.serialiseTree(
                core.parseIndex(core.splitFrontmatter(data).body).root);
            if (this.indexList !== null && disk !== this.indexList) {
                stale = true;
                return data;
            }
            const out = core.writeIndexText(data, root);
            this.indexText = out;
            // Remembered so the modify event this write causes is not
            // mistaken for an outside edit; capped in case an event never
            // arrives, as when the text did not change.
            this.selfWrites.add(out);
            if (this.selfWrites.size > 20) {
                this.selfWrites.delete(this.selfWrites.values().next().value);
            }
            return out;
        });
        if (stale) {
            new Notice('Dendrite: the index changed outside this board ' +
                       'since it was read, from a sync or another editor. ' +
                       'It has been read again; the last change was not ' +
                       'written, so make it again.', 10000);
            await this.reload();
            return false;
        }
        this.indexList = core.serialiseTree(root);
        return true;
    }

    /** Write a card's note, known as Dendrite's own when it arrives. */
    async writeCard(f, fn) {
        let out = null;
        await this.app.vault.process(f, (data) => {
            out = fn(data);
            this.ownBodies.set(f.path, core.splitFrontmatter(out).body);
            return out;
        });
        return out;
    }

    async createCardFile(id, text = '') {
        const folder = this.cardsFolder();
        if (!this.app.vault.getAbstractFileByPath(folder)) {
            await this.app.vault.createFolder(folder);
        }
        const f = await this.app.vault.create(
            normalizePath(`${folder}/${id}.md`), text);
        if (this.plugin.settings.cardType) {
            await addType(this.app, f, this.plugin.settings.cardType);
        }
        return f;
    }

    /**
     * Move the selection, or everything after the cursor, out of the card
     * being edited into a new card below it or a new last child. The new
     * card is written and indexed before the text leaves the original, so
     * a failure part-way leaves the text twice, never nowhere.
     */
    async moveSelection(where) {
        const ed = this.editing;
        if (!ed) return;
        const prefix = this.prefix();
        if (!prefix || !core.validPrefix(prefix)) {
            new Notice('Dendrite: set a valid dendrite_prefix first.');
            return;
        }
        const original = ed.editor.value;
        const [s, e] = ed.editor.selection();
        const cut = core.splitText(original, s, e);
        if (!cut) {
            new Notice('Dendrite: nothing selected, and nothing after the ' +
                       'cursor, to move.');
            return;
        }
        const node = this.byId.get(ed.id);
        if (!node) return;
        const before = core.serialiseTree(this.root);
        // What was typed in this visit before the split is a step of its
        // own, before the split's, so undoing the split does not also
        // bring back text that now lives in the new card.
        await this.save(ed);
        this.recordVisit(ed.id, ed.before, original);
        const srcText = await this.app.vault.read(ed.file);
        // Read fresh, not from the board's last drawing: a status set a
        // moment ago may not have been drawn yet.
        const srcStatus = core.roleFor(node, (x) => this.printRoleOf(x)) ===
            'prose' ? this.statusOf(ed.id) : null;
        // A role set on the card goes with the text, so planning split
        // from a scaffolding card stays planning. Heading only is not
        // carried: it describes the card's own heading line.
        const set = this.roleOf(ed.id);
        const role = set && set !== 'section' ? set : null;
        const prints = !role || role === 'prose';
        const id = core.newId(prefix, (x) => this.taken(x));
        const made = await this.createCardFile(id, cut.moved);
        // The moved text is as mature as it was where it came from; a
        // card that prints nothing has no status.
        await writeProps(this.app, made, {
            dendrite_role: role,
            dendrite_status: prints ? srcStatus || 'draft' : null });
        const fresh = core.makeNode(id, core.deriveLabel(cut.moved, null),
                                    null);
        if (where === 'child') core.appendChild(node, fresh);
        else core.insertSibling(node, fresh, true);
        this.byId.set(id, fresh);
        await this.writeIndex();
        ed.editor.replace(cut.keep, cut.at);
        ed.dirty = true;
        ed.changed = true;
        await this.save(ed);
        ed.before = cut.keep;
        // A card that moved part of itself into a child and stopped
        // printing has a status only if text is left behind: unsplit,
        // until the split is finished or the rest is kept as notes.
        if (where === 'child' &&
            core.roleFor(node, (x) => this.printRoleOf(x)) !== 'prose') {
            await this.setStatus(ed.id,
                core.leftover(cut.keep) ? 'unsplit' : null);
        }
        this.pushUndo({
            tree: before, active: ed.id, files: [],
            created: [{ path: made.path, body: cut.moved }],
            restores: [{ path: ed.file.path, body: original,
                         ifBody: cut.keep, text: srcText }],
        });
        this.render();
        // Rebuilding the board moved the editor; put the cursor back at
        // the cut, ready to move the next piece.
        ed.editor.focusAt(cut.at);
    }

    /**
     * Merge the active card into the card above it, or into its parent.
     * The receiving card is written with both texts before the merged
     * card's note goes to the trash.
     */
    async merge(kind) {
        const node = this.active && this.byId.get(this.active);
        if (!node) return;
        if (this.editing) await this.endEdit();
        const i = node.parent.children.indexOf(node);
        const target = kind === 'above' ?
            (i > 0 ? node.parent.children[i - 1] : null) :
            (node.parent.id ? node.parent : null);
        if (!target) {
            new Notice(kind === 'above' ?
                'Dendrite: no card above this one to merge into.' :
                'Dendrite: a top-level card has no parent to merge into.');
            return;
        }
        const src = this.cardFile(node.id);
        const dst = this.cardFile(target.id);
        if (!src || !dst) {
            new Notice('Dendrite: a card note is missing; nothing merged.');
            return;
        }
        const srcText = await this.app.vault.read(src);
        const dstText = await this.app.vault.read(dst);
        const dstBody = core.splitFrontmatter(dstText).body;
        const mergedStatus = core.lowerStatus(this.statusOf(node.id),
                                              this.statusOf(target.id));
        const merged = core.mergeText(dstBody,
                                      core.splitFrontmatter(srcText).body);
        const before = core.serialiseTree(this.root);
        await this.writeCard(dst,
            (data) => core.splitFrontmatter(data).fm + merged);
        if (kind === 'above') core.mergeIntoAbove(node);
        else {
            core.mergeIntoParent(node);
            core.remove(node);
        }
        this.reindex();
        this.active = target.id;
        await this.writeIndex();
        this.invalidate(node.id);
        this.invalidate(target.id);
        await this.app.fileManager.trashFile(src);
        this.pushUndo({
            tree: before, active: node.id,
            files: [{ path: src.path, data: srcText }], created: [],
            restores: [{ path: dst.path, body: dstBody, ifBody: merged,
                         text: dstText }],
        });
        await this.syncLabel(target.id, merged);
        // Merged text is only as mature as the less mature of the two.
        if (core.roleFor(target, (x) => this.printRoleOf(x)) === 'prose') {
            await this.setStatus(target.id, mergedStatus);
        }
        await this.sweepStatuses();
        this.render();
    }

    taken(id) {
        return this.byId.has(id) ||
            !!this.app.metadataCache.getFirstLinkpathDest(id, '') ||
            !!this.app.vault.getAbstractFileByPath(
                normalizePath(`${this.cardsFolder()}/${id}.md`));
    }

    async insert(where) {
        const prefix = this.prefix();
        if (!prefix || !core.validPrefix(prefix)) {
            new Notice('Dendrite: set a valid dendrite_prefix in the ' +
                       'index note\'s properties first.');
            return;
        }
        if (this.editing) await this.endEdit();
        const node = this.active && this.byId.get(this.active);
        const id = core.newId(prefix, (x) => this.taken(x));
        const made = await this.createCardFile(id);
        // Undoing the insert also removes the new note, while it is empty.
        this.snapshot([], [made.path]);
        const fresh = core.makeNode(id, '', null);
        if (!node || where === 'first') {
            core.appendChild(this.root, fresh);
        } else if (where === 'child') {
            core.appendChild(node, fresh);
        } else {
            core.insertSibling(node, fresh, where === 'below');
        }
        this.byId.set(id, fresh);
        this.active = id;
        await this.writeIndex();
        await this.sweepStatuses();
        this.render();
        await this.startEdit(id);
        // Until something is typed, Ctrl+Z takes the new card back.
        if (this.editing && this.editing.id === id) this.editing.fresh = true;
    }

    /** A visit's change to a card's text, for its own history. */
    recordVisit(id, before, after) {
        if (after === before) return;
        let t = this.texts.get(id);
        if (!t) this.texts.set(id, t = { undo: [], redo: [] });
        t.undo.push({ before, after });
        if (t.undo.length > UNDO_DEPTH) t.undo.shift();
        t.redo = [];
    }

    /**
     * Ctrl+Z in a card once this visit's own typing is undone, or before
     * any: the card steps back a whole earlier visit, its text as it was
     * before that visit. A new card still empty is taken back instead.
     * False when the editor's own undo applies.
     */
    undoInEditor() {
        if (this.undoEmptyNew()) return true;
        const ed = this.editing;
        if (!ed || ed.editor.value.trim() !== ed.before.trim()) return false;
        const t = this.texts.get(ed.id);
        const top = t && t.undo[t.undo.length - 1];
        if (!top) return false;
        // Split, merged or changed outside Dendrite since: the history
        // before that is not this text's. The board's undo reverses a
        // split or merge, and the history then applies again.
        if (top.after.trim() !== ed.before.trim()) {
            new Notice('Dendrite: this card\'s text changed since its ' +
                       'last visit, by a split, merge or sync, so its ' +
                       'earlier text is not undone here.');
            return true;
        }
        t.undo.pop();
        t.redo.push(top);
        this.applyStep(ed, top.before);
        return true;
    }

    /**
     * Ctrl+Shift+Z or Ctrl+Y in a card right after stepping back through
     * its history: the visit comes back. False when the editor's own
     * redo applies.
     */
    redoInEditor() {
        const ed = this.editing;
        if (!ed || !ed.stepped) return false;
        const t = this.texts.get(ed.id);
        const top = t && t.redo[t.redo.length - 1];
        if (!top || top.before.trim() !== ed.editor.value.trim()) {
            return false;
        }
        t.redo.pop();
        t.undo.push(top);
        this.applyStep(ed, top.after);
        return true;
    }

    /** Put a step's text in the editor; this visit starts from it. */
    applyStep(ed, text) {
        ed.applying = true;
        try {
            ed.editor.replace(text, text.length);
        } finally {
            ed.applying = false;
        }
        ed.before = text;
        ed.dirty = true;
        ed.changed = true;
        ed.fresh = false;
        ed.stepped = true;
        this.save(ed);
    }

    /**
     * Ctrl+Z in a card just made and still empty: undo making it, since
     * the text has nothing of its own to undo. False otherwise.
     */
    undoEmptyNew() {
        const ed = this.editing;
        if (!ed || !ed.fresh || ed.editor.value.trim()) return false;
        (async () => {
            await this.endEdit();
            await this.doUndo();
        })();
        return true;
    }

    async structural(op) {
        const node = this.active && this.byId.get(this.active);
        if (!node) return;
        if (this.editing) await this.endEdit();
        const before = core.serialiseTree(this.root);
        const fn = { up: () => core.moveWithin(node, -1),
                     down: () => core.moveWithin(node, 1),
                     indent: () => core.indent(node),
                     outdent: () => core.outdent(node) }[op];
        if (!fn || !fn()) return;
        this.pushUndo({ tree: before, active: this.active, files: [] });
        await this.writeIndex();
        await this.sweepStatuses();
        this.render();
    }

    async deleteActive() {
        const node = this.active && this.byId.get(this.active);
        if (!node) return;
        if (this.editing) await this.endEdit();
        const doomed = [node, ...core.descendants(node)];
        const files = [];
        for (const n of doomed) {
            const f = this.cardFile(n.id);
            if (f) files.push({ path: f.path,
                                data: await this.app.vault.read(f) });
        }
        this.snapshot(files);
        const sibs = node.parent.children;
        const i = sibs.indexOf(node);
        const next = sibs[i + 1] || sibs[i - 1] ||
            (node.parent.id ? node.parent : null);
        core.remove(node);
        this.reindex();
        this.active = next ? next.id : null;
        await this.writeIndex();
        for (const n of doomed) {
            const f = this.cardFile(n.id);
            this.invalidate(n.id);
            if (f) await this.app.fileManager.trashFile(f);
        }
        await this.sweepStatuses();
        this.render();
        new Notice(`Dendrite: deleted ${doomed.length} card(s). ` +
                   'Ctrl+Z in the view restores them.');
    }

    // Leaving a card records its visit first, which is a new step and so
    // ends any redo; the histories are read only after that.
    async doUndo() {
        if (this.editing) await this.endEdit();
        await this.stepHistory(this.undo, this.redo, 'undo');
    }

    async doRedo() {
        if (this.editing) await this.endEdit();
        await this.stepHistory(this.redo, this.undo, 'redo');
    }

    /**
     * Take the latest step from one history and apply it, recording on
     * the other how to reverse what was done: undo feeds redo and redo
     * feeds undo. Only what was applied is recorded, so a card left alone
     * because it changed since is not touched by the reverse either.
     */
    async stepHistory(from, to, what) {
        const snap = from.pop();
        if (!snap) {
            new Notice(`Dendrite: nothing to ${what} on the board. A ` +
                       'card\'s text is undone and redone inside the card.');
            return;
        }
        const vault = this.app.vault;
        const bodyOf = (data) => core.splitFrontmatter(data).body;
        const inv = { active: this.active, files: [], created: [],
                      restores: [], text: snap.text };
        if (snap.tree !== undefined) {
            inv.tree = core.serialiseTree(this.root);
        }
        for (const { path, data } of snap.files || []) {
            if (!vault.getAbstractFileByPath(path)) {
                await vault.create(path, data);
                inv.created.push({ path, body: bodyOf(data) });
            }
        }
        // A card note the step created goes with it, but only while it
        // holds what the step put there: text written into it since is
        // never discarded.
        for (const entry of snap.created || []) {
            const path = typeof entry === 'string' ? entry : entry.path;
            const expect = typeof entry === 'string' ? '' : entry.body;
            const f = vault.getAbstractFileByPath(path);
            if (!(f instanceof TFile)) continue;
            const data = await vault.read(f);
            // Text typed into it on this board is in its own history,
            // and comes back with a redo, so it goes too.
            const t = this.texts.get(f.basename);
            const typed = t && t.undo.length &&
                t.undo[t.undo.length - 1].after.trim();
            const body = bodyOf(data).trim();
            if (body === expect.trim() || (typed && body === typed)) {
                this.invalidate(f.basename);
                await this.app.fileManager.trashFile(f);
                inv.files.push({ path, data });
            }
        }
        // A card note the step rewrote gets its text back, if it still
        // holds what the step left in it.
        for (const r of snap.restores || []) {
            const f = vault.getAbstractFileByPath(r.path);
            if (!(f instanceof TFile)) continue;
            const data = await vault.read(f);
            if (bodyOf(data).trim() !== r.ifBody.trim()) {
                if (snap.text) {
                    new Notice('Dendrite: the card changed since, so its ' +
                               `text was not ${what === 'undo' ? 'undone'
                                   : 'redone'}.`);
                }
                continue;
            }
            const next = await this.writeCard(f, (d) =>
                (r.text !== undefined ? r.text
                    : core.splitFrontmatter(d).fm + r.body));
            inv.restores.push({ path: r.path, text: data,
                                ifBody: bodyOf(next) });
            this.invalidate(f.basename);
        }
        // The whole index, put back from before a sync, if it still holds
        // what the step left in it; marked again if it leaves cards out.
        if (snap.index) {
            const data = await vault.read(this.file);
            if (data === snap.index.ifText) {
                this.selfWrites.add(snap.index.text);
                await vault.process(this.file, () => snap.index.text);
                inv.index = { text: data, ifText: snap.index.text };
                this.indexText = data;
                this.checkDropped(snap.index.text);
                this.loadText(snap.index.text);
            } else {
                new Notice('Dendrite: the index changed since, so it was ' +
                           `not ${what === 'undo' ? 'undone' : 'redone'}.`);
            }
        }
        // A text step leaves the tree as it stands.
        if (snap.tree !== undefined) {
            this.root = core.parseIndex(snap.tree + '\n').root;
            this.reindex();
        }
        if (this.byId.has(snap.active)) this.active = snap.active;
        if (snap.tree !== undefined) await this.writeIndex();
        to.push(inv);
        if (to.length > UNDO_DEPTH) to.shift();
        this.render();
    }

    unlinkedCards() {
        const folder = this.app.vault.getAbstractFileByPath(
            this.cardsFolder());
        if (!(folder instanceof TFolder)) return [];
        return folder.children.filter((f) => f instanceof TFile &&
            f.extension === 'md' && !this.byId.has(f.basename));
    }

    async adopt(files) {
        this.snapshot();
        for (const f of files) {
            const n = core.makeNode(f.basename, '', null);
            core.appendChild(this.root, n);
            const body = core.splitFrontmatter(
                await this.app.vault.cachedRead(f)).body;
            const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
            n.label = core.deriveLabel(body, fm && fm.aliases);
        }
        this.reindex();
        await this.writeIndex();
        this.render();
    }

    // ---- changes from outside the view -----------------------------------

    async onModify(f) {
        if (!(f instanceof TFile) || !this.file) return;
        if (f === this.file) {
            const text = await this.app.vault.cachedRead(f);
            if (this.selfWrites.delete(text)) {
                this.indexText = text;
                await this.checkVersion(null, text, true);
                return;
            }
            this.checkDropped(text);
            await this.checkVersion(null, text, false);
            // A sync can write the text back unchanged, after Dendrite's
            // own event was consumed: nothing to reload.
            if (this.root && core.writeIndexText(text, this.root) === text) {
                this.indexList = core.serialiseTree(this.root);
                return;
            }
            // The index changed outside Dendrite: re-read it, debounced so
            // a burst of edits or a sync reloads once.
            clearTimeout(this.reloadTimer);
            this.reloadTimer = setTimeout(() => this.reload(), 300);
            return;
        }
        const id = f.basename;
        if (!this.byId.has(id)) return;
        const text = await this.app.vault.cachedRead(f);
        const body = core.splitFrontmatter(text).body;
        const own = this.ownBodies.get(f.path) === body;
        if (own) this.ownBodies.delete(f.path);
        await this.checkVersion(id, text, own);
        if (this.find) this.scheduleFind(true);
        if (this.editing && this.editing.id === id) {
            if (!own) await this.syncedWhileEditing(this.editing, text);
            return;
        }
        this.invalidate(id);
        const card = this.cardEls.get(id);
        if (card) {
            card.addClass('is-pending');
            this.renderCard(id);
        }
    }

    /**
     * A sync changed the note of the card being edited. With no unsaved
     * typing the editor opens again on the new text, so a later save
     * cannot write the old text back over it. With unsaved typing nothing
     * is saved: the editor closes on the note as it came, and the card is
     * marked with the typing to put back.
     */
    async syncedWhileEditing(ed, text) {
        const { fm, body } = core.splitFrontmatter(text);
        if (ed.editor.value === body) return;
        clearTimeout(ed.timer);
        // This visit ends at what it saved; the sync is not part of it.
        if (ed.changed) this.recordVisit(ed.id, ed.before, ed.saved);
        ed.recorded = true;
        if (ed.dirty) {
            ed.dirty = false;
            this.held.set(ed.id, fm + ed.editor.value);
            await this.endEdit();
            this.reverted.add(ed.id);
            this.revertedAt.set(ed.id, Date.now());
            const node = this.byId.get(ed.id);
            new Notice(`Dendrite: Card ${core.shortId(ed.id)}` +
                       (node && node.label ? ` (${node.label})` : '') +
                       ' changed outside Dendrite while you were typing ' +
                       'in it, usually from a sync. Your typing was not ' +
                       'saved over it. Click "typing kept" on the card to ' +
                       'compare and choose.', 0);
            this.updateStatuses();
            return;
        }
        const at = Math.min(ed.editor.selection()[0], body.length);
        await this.endEdit();
        await this.startEdit(ed.id);
        if (this.editing && this.editing.id === ed.id) {
            this.editing.editor.focusAt(at);
        }
    }

    async onMetadata(f) {
        if (!(f instanceof TFile)) return;
        if (f === this.file) {
            // The manuscript's settings changed: numbering and limits.
            this.updateNumbers();
            this.updateCounts();
            return;
        }
        if (!this.byId.has(f.basename)) return;
        // A heading added or removed changes the numbering, and a limit
        // or role set in the card's properties changes what is counted.
        this.updateNumbers();
        this.updateRoles();
        this.updateStatuses();
        this.scheduleCounts();
        // A label can come from aliases, which only the metadata cache
        // knows once parsed, so labels follow here rather than on modify;
        // in memory only, since the change may have come from a sync.
        if (this.editing && this.editing.id === f.basename) return;
        const body = core.splitFrontmatter(
            await this.app.vault.cachedRead(f)).body;
        this.noteLabel(f.basename, body);
    }

    // ---- versions going back ---------------------------------------------

    historyKey(id) {
        const vault = this.app.appId ||
            (this.app.vault.getName && this.app.vault.getName()) || 'vault';
        return `${vault}/${id === null ? 'index:' + this.file.path : id}`;
    }

    /**
     * Record a note's text in this device's history and notice when a
     * text from outside matches an earlier version: a sync putting back
     * an old copy. A card is compared by its body, the index whole.
     */
    async checkVersion(id, text, own) {
        const compared = id === null ? text : core.splitFrontmatter(text).body;
        // Typed in Obsidian's own editor on this device: not a sync.
        const f = id === null ? this.file : this.cardFile(id);
        const active = this.app.workspace.activeEditor;
        const here = own || !!(active && f && active.file === f);
        let r;
        try {
            r = await this.history.observe(this.historyKey(id), text,
                                           compared, !here);
        } catch (err) {
            console.error('Dendrite: version history failed', err);
            return;
        }
        const key = id === null ? 'index' : id;
        if (id === null) this.indexReverted = r === 'reverted';
        const on = r === 'reverted' || this.held.has(id) ||
            (id === null && this.dropped.size > 0);
        if (r === 'reverted' && !this.versionInfo.has(key)) {
            try {
                const d = await this.history.detail(this.historyKey(id));
                if (d) this.versionInfo.set(key, d);
            } catch (err) {
                console.error('Dendrite: version history failed', err);
            }
        } else if (r !== 'reverted') {
            this.versionInfo.delete(key);
        }
        if (on === this.reverted.has(key)) return;
        if (!on) {
            this.reverted.delete(key);
        } else if (r !== 'reverted') {
            this.reverted.add(key);
            this.revertedAt.set(key, Date.now());
        } else {
            this.reverted.add(key);
            this.revertedAt.set(key, Date.now());
            const node = id && this.byId.get(id);
            const name = id === null ? 'The index' :
                `Card ${core.shortId(id)}` +
                (node && node.label ? ` (${node.label})` : '');
            new Notice(`Dendrite: ${name} changed outside Dendrite to ` +
                       'text this device had before, usually an old copy ' +
                       'from a sync. Nothing was written. Click "older ' +
                       `copy" on ${id === null ? 'the bar' : 'the card'} ` +
                       'to compare and choose.', 0);
        }
        this.updateStatuses();
    }

    /**
     * An index from outside that leaves out cards whose notes still
     * exist. Deleting a card on a board deletes its note, so this is a
     * sync merging or putting back an old copy, which this device may
     * never have seen and so cannot match in its history. Held as the
     * index going back, with the text before it to restore, until the
     * cards are listed again or their notes deleted.
     */
    checkDropped(text) {
        const active = this.app.workspace.activeEditor;
        const here = !!(active && active.file === this.file);
        const base = this.dropBase || this.indexText;
        const ids = (t) => core.allNodes(core.parseIndex(
            core.splitFrontmatter(t).body).root);
        const listed = new Set(ids(text).map((n) => n.id));
        const gone = here || !base ? [] : ids(base).filter((n) =>
            !listed.has(n.id) && this.cardFile(n.id));
        const was = this.dropped.size;
        this.dropped = new Map(gone.map((n) => [n.id, n.label]));
        if (gone.length) {
            this.dropBase = base;
        } else {
            this.dropBase = null;
            this.indexText = text;
        }
        if (gone.length && !was) {
            this.revertedAt.set('index', Date.now());
            const names = gone.slice(0, 5).map((n) => core.shortId(n.id) +
                (n.label ? ` (${n.label})` : '')).join(', ');
            const more = gone.length > 5 ?
                `, and ${gone.length - 5} more` : '';
            new Notice(`Dendrite: the index changed outside Dendrite and ` +
                       `no longer lists ${gone.length} ` +
                       `card${gone.length === 1 ? '' : 's'} whose notes ` +
                       `still exist: ${names}${more}. This is probably a ` +
                       'sync of an old copy. Nothing was written. Click ' +
                       '"older copy" on the bar to compare and choose.', 0);
        }
        this.flagIndex();
    }

    /** Show the index as gone back while either check says so. */
    flagIndex() {
        const on = this.indexReverted || this.dropped.size > 0;
        if (on === this.reverted.has('index')) return;
        if (on) this.reverted.add('index');
        else this.reverted.delete('index');
        this.updateStatuses();
    }

    /** Every note's version, on opening: a sync may have run meanwhile. */
    async checkVersions() {
        if (!this.file) return;
        await this.checkVersion(null,
            await this.app.vault.cachedRead(this.file), false);
        for (const n of core.allNodes(this.root)) {
            const f = this.cardFile(n.id);
            if (!f) continue;
            await this.checkVersion(n.id,
                await this.app.vault.cachedRead(f), false);
        }
    }

    /** What happened to a note marked as gone back, and the choices. */
    reviewVersion(id) {
        new VersionModal(this, id).open();
    }

    /**
     * The text a note marked as gone back held before: the index as this
     * board last saw it, or the newest version this device recorded.
     */
    async newerText(id) {
        if (id === null && this.dropBase) return this.dropBase;
        if (this.held.has(id)) return this.held.get(id);
        const info = this.versionInfo.get(id === null ? 'index' : id);
        if (info) return info.text;
        const text = await this.history.newer(this.historyKey(id));
        return text === undefined ? null : text;
    }

    /** Put back the text a note held before it was marked. */
    async restoreNewer(id) {
        const f = id === null ? this.file : this.cardFile(id);
        const text = f && await this.newerText(id);
        if (text === null || text === undefined) {
            new Notice('Dendrite: no newer version is recorded here.');
            return;
        }
        const now = await this.app.vault.read(f);
        if (id === null) {
            this.dropBase = null;
            this.dropped.clear();
            this.selfWrites.add(text);
            await this.app.vault.process(f, () => text);
            this.pushUndo({ active: this.active, files: [], text: true,
                            index: { text: now, ifText: text } });
            await this.checkVersion(null, text, true);
            await this.reload();
            return;
        }
        if (this.editing && this.editing.id === id) await this.endEdit();
        this.held.delete(id);
        await this.writeCard(f, () => text);
        this.pushUndo({ active: id, files: [], text: true,
            restores: [{ path: f.path, text: now,
                         ifBody: core.splitFrontmatter(text).body }] });
        await this.checkVersion(id, text, true);
        this.invalidate(id);
        await this.renderCard(id);
    }

    async keepVersion(id) {
        const f = id === null ? this.file : this.cardFile(id);
        if (!f) return;
        const text = await this.app.vault.read(f);
        await this.history.keep(this.historyKey(id), text,
            id === null ? text : core.splitFrontmatter(text).body);
        if (id === null) {
            this.dropBase = null;
            this.dropped.clear();
            this.indexText = text;
            this.indexReverted = false;
        }
        this.held.delete(id);
        this.versionInfo.delete(id === null ? 'index' : id);
        this.reverted.delete(id === null ? 'index' : id);
        this.updateStatuses();
    }

    onRenameCard(f, oldPath) {
        const old = oldPath.split('/').pop().replace(/\.md$/, '');
        const node = this.byId.get(old);
        if (!node || f.basename === old) return;
        // Obsidian rewrites the link in the index itself; follow it here.
        this.byId.delete(old);
        node.id = f.basename;
        this.byId.set(node.id, node);
        if (this.active === old) this.active = node.id;
        this.invalidate(old);
    }

    // ---- manuscript settings, numbering and counts ------------------------

    /** The manuscript's settings, from its index note's properties. */
    manuscript() {
        const fm = (this.file &&
            this.app.metadataCache.getFileCache(this.file)?.frontmatter) ||
            {};
        const top = Number(fm.dendrite_heading_top);
        const wpp = core.wordsPerPage(fm);
        const cpw = Number(fm.dendrite_chars_per_word);
        return {
            prefix: this.prefix(),
            limit: core.parseLimit(fm.dendrite_limit),
            limitRequired: fm.dendrite_limit_required === true,
            charsPerWord: cpw > 0 ? cpw : 6,
            countSpaces: fm.dendrite_count_spaces !== false,
            wordsPerPage: wpp.value,
            wordsPerPageMeasured: wpp.measured,
            headingTop: top >= 1 && top <= 6 ? top :
                this.plugin.settings.headingTop,
            number: fm.dendrite_number_sections === true,
            csl: typeof fm.dendrite_csl === 'string' &&
                fm.dendrite_csl.trim() ? fm.dendrite_csl.trim() : null,
            style: exportStyle(fm),
        };
    }

    cardProps(id) {
        const f = this.cardFile(id);
        return (f && this.app.metadataCache.getFileCache(f)?.frontmatter) ||
            {};
    }

    /** Whether a card's text opens with a heading, from Obsidian's cache. */
    hasHeading(id) {
        if (this.editing && this.editing.id === id) {
            return /^\s*#{1,6}\s/.test(this.editing.editor.value);
        }
        const f = this.cardFile(id);
        const sections = f && this.app.metadataCache.getFileCache(f)?.sections;
        const first = (sections || []).find((s) => s.type !== 'yaml');
        return !!first && first.type === 'heading';
    }

    numbers() {
        if (!this.manuscript().number) return new Map();
        return core.sectionNumbers(this.root.children,
                                   (id) => this.hasHeading(id),
                                   (id) => this.printRoleOf(id),
                                   (id) => this.kindOf(id));
    }

    /** Show each section card's number, updated in place. */
    updateNumbers() {
        const nums = this.numbers();
        for (const [id, card] of this.cardEls) {
            let badge = card.querySelector(':scope > .dendrite-num');
            const num = nums.get(id);
            if (!num) {
                if (badge) badge.remove();
                continue;
            }
            if (!badge) {
                badge = createDiv({ cls: 'dendrite-num' });
                card.prepend(badge);
            }
            badge.setText(num);
        }
    }

    scheduleCounts() {
        clearTimeout(this.countTimer);
        this.countTimer = setTimeout(() => this.updateCounts(), 400);
    }

    /**
     * Count what each limited card's branch would export, and the whole
     * manuscript, and show them against their limits. Card text is read
     * only when some limit is set, so a manuscript without limits pays
     * nothing for this.
     */
    /** A card's role, if set: section, prose or notes. */
    roleOf(id) {
        const r = this.cardProps(id).dendrite_role;
        return core.ROLES.includes(r) ? r : null;
    }

    /** A card's kind, if set: table or figure. */
    kindOf(id) {
        const k = this.cardProps(id).dendrite_kind;
        return core.KINDS.includes(k) ? k : null;
    }

    /** The role a card prints by, its kind applied. */
    printRoleOf(id) {
        return core.withKinds((x) => this.roleOf(x),
                              (x) => this.kindOf(x))(id);
    }

    /** What export needs to number tables and figures. */
    floatOpts(heights = false) {
        const kindOf = (x) => this.kindOf(x);
        const opts = { kindOf, floats: core.floatLabels(this.root.children,
            (x) => this.printRoleOf(x), kindOf) };
        if (heights) {
            opts.heightOf = (x) =>
                core.parseAmount(this.cardProps(x).dendrite_height);
        }
        return opts;
    }

    async setKind(id, kind) {
        const f = this.cardFile(id);
        if (f) await writeProps(this.app, f, { dendrite_kind: kind });
        await this.sweepStatuses();
    }

    async setRole(id, role) {
        const f = this.cardFile(id);
        if (f) await writeProps(this.app, f, { dendrite_role: role });
        await this.sweepStatuses();
    }

    // ---- card status ----------------------------------------------------

    /** A card's set status: draft, done, revise or unsplit. */
    statusOf(id) {
        const s = this.cardProps(id).dendrite_status;
        return core.STATUSES.includes(s) ? s : null;
    }

    /**
     * Write a status, draft included, so every printing card says what it
     * is without Dendrite; null removes it, from a card that does not
     * print.
     */
    /** A status from the keyboard, for a card whose text prints. */
    async setStatusByKey(status) {
        const node = this.byId.get(this.active);
        if (!node) return;
        if (core.roleFor(node, (x) => this.printRoleOf(x)) !== 'prose') {
            new Notice('Dendrite: a structural card takes its status from ' +
                       'the cards below it.');
            return;
        }
        await this.setStatus(this.active, status);
    }

    async setStatus(id, status) {
        const f = this.cardFile(id);
        if (!f) return;
        if ((this.statusOf(id) || null) === (status || null)) return;
        await writeProps(this.app, f, { dendrite_status: status || null });
    }

    /**
     * Show each card's status at its top right, beside the role icon,
     * and the counts in the bar.
     * A printing card shows its own status, a structural card the least
     * finished state below it and how many cards there are flagged.
     */
    updateStatuses() {
        if (!this.board) return;
        const report = core.statusReport(this.root,
            (id) => this.statusOf(id), (id) => this.printRoleOf(id));
        this.statusInfo = report.cards;
        for (const [id, card] of this.cardEls) {
            const old = card.querySelector(':scope > .dendrite-status');
            if (old) old.remove();
            card.removeClass('is-flagged');
            const info = report.cards.get(id) ||
                { prints: false, own: null, below: 0 };
            const chip = createDiv({ cls: 'dendrite-status' });
            const show = (status, text) => {
                const s = chip.createSpan({ cls: 'dendrite-status-chip ' +
                                                 `is-${status}`, text });
                const colour = this.plugin.statusColour(status);
                if (colour) s.style.setProperty('--dendrite-chip', colour);
                return s;
            };
            if (this.reverted.has(id)) {
                const held = this.held.has(id);
                const s = show('reverted', held ? 'typing kept ⟲' :
                               'older copy ⟲');
                s.setAttr('aria-label', held ?
                          'Changed outside Dendrite while you were typing ' +
                          'in it. Click to compare and choose; your ' +
                          'typing is not written until you do' :
                          'Changed outside Dendrite to text ' +
                          'this card had before. Click to compare and ' +
                          'choose; nothing is written until you do');
                s.onclick = (e) => {
                    e.stopPropagation();
                    this.reviewVersion(id);
                };
            }
            if (info.own === 'done') show('done', 'done ✓');
            else if (info.own === 'revise') show('revise', 'revise ⚑');
            else if (info.own === 'unsplit') show('unsplit', 'unsplit');
            if (!info.prints && info.below > 0) {
                show('revise', `${info.below} to revise ⚑`);
            } else if (!info.prints && info.derived === 'done' &&
                       !info.own) {
                show('done', 'done ✓');
            }
            if (core.isFlag(info.own)) card.addClass('is-flagged');
            if (!chip.childElementCount) continue;
            card.appendChild(chip);
        }
        if (this.statusEl) {
            const t = report.tally;
            const parts = [];
            if (t.revise) parts.push(`${t.revise} revise`);
            if (t.unsplit) parts.push(`${t.unsplit} unsplit`);
            parts.push(`${t.draft} draft`, `${t.done} done`);
            this.statusEl.setText(parts.join(' · '));
            this.statusEl.toggleClass('has-flags', t.revise + t.unsplit > 0);
            if (this.reverted.has('index')) {
                const s = this.statusEl.createSpan({ cls:
                    'dendrite-status-chip is-reverted',
                    text: 'index: older copy ⟲' });
                s.setAttr('aria-label', 'The index changed outside ' +
                          'Dendrite to an older copy. Click to compare and ' +
                          'choose; nothing is written until you do');
                s.onclick = () => this.reviewVersion(null);
            }
        }
        if (this.plugin.previewStatuses) {
            this.plugin.previewStatuses(this.file);
        }
    }

    /**
     * Status belongs to text that prints. A card that no longer prints
     * loses draft, done or revise; a card that prints again loses unsplit;
     * an unsplit card with nothing left behind loses unsplit.
     */
    async sweepStatuses() {
        for (const n of core.allNodes(this.root)) {
            if (!this.cardFile(n.id)) continue;
            const s = this.statusOf(n.id);
            const prints = core.roleFor(n, (id) => this.printRoleOf(id)) ===
                'prose';
            if (prints && (!s || s === 'unsplit')) {
                // Printing, with no status or a structural one: draft.
                await this.setStatus(n.id, 'draft');
            } else if (!prints && s && s !== 'unsplit') {
                await this.setStatus(n.id, null);
            }
        }
    }

    /** Clear unsplit once the card holds only its heading and comments. */
    async clearFinishedSplit(file) {
        if (!(file instanceof TFile)) return;
        if (this.statusOf(file.basename) !== 'unsplit') return;
        const body = core.splitFrontmatter(
            await this.app.vault.cachedRead(file)).body;
        if (!core.leftover(body)) await this.setStatus(file.basename, null);
    }

    /** The next or previous card in reading order that is flagged. */
    nextFlagged(dir, test = (info) => core.isFlag(info.own)) {
        const order = core.allNodes(this.root).filter((n) => {
            const info = this.statusInfo && this.statusInfo.get(n.id);
            return info && test(info);
        });
        if (!order.length) {
            new Notice('Dendrite: no cards to go to.');
            return;
        }
        const all = core.allNodes(this.root);
        const at = all.findIndex((n) => n.id === this.active);
        const pick = dir > 0 ?
            order.find((n) => all.indexOf(n) > at) || order[0] :
            [...order].reverse().find((n) => all.indexOf(n) < at) ||
                order[order.length - 1];
        this.select(pick.id);
    }

    /** + marks a printing card done; - sends it to revise. */
    async stepStatus(up) {
        const node = this.active && this.byId.get(this.active);
        if (!node) return;
        if (this.statusOf(node.id) === 'unsplit') {
            if (up) await this.setStatus(node.id, null);
            return;
        }
        if (core.roleFor(node, (x) => this.printRoleOf(x)) !== 'prose') {
            new Notice('Dendrite: a structural card takes its status from ' +
                       'the cards below it.');
            return;
        }
        await this.setStatus(this.active, up ? 'done' : 'revise');
    }

    /** Mark cards that print nothing, and where a role was set by hand. */
    updateRoles() {
        for (const [id, card] of this.cardEls) {
            const node = this.byId.get(id);
            if (!node) continue;
            let out = false;
            for (let n = node; n && n.id; n = n.parent) {
                if (core.roleFor(n, (x) => this.printRoleOf(x)) === 'notes') {
                    out = true;
                    break;
                }
            }
            card.toggleClass('is-left-out', out);
            card.toggleClass('is-heading-only',
                             this.roleOf(id) === 'section');
            // The corner icon: the role in effect, faint when it follows
            // from the tree rather than being set on the card.
            const set = this.roleOf(id);
            let role = out ? 'notes' :
                core.roleFor(node, (x) => this.printRoleOf(x));
            const auto = out ? set !== 'notes' : !set;
            // A table or figure that prints shows its kind instead.
            const kind = this.kindOf(id);
            if (kind && role === 'prose') role = kind;
            const grip = card.querySelector(':scope > .dendrite-grip');
            if (grip && grip.dataset.role !== role) {
                grip.dataset.role = role;
                const icon = grip.querySelector('.dendrite-role-icon');
                icon.empty();
                setIcon(icon, (ROLE_ITEMS.find((r) => r[0] === role) ||
                               KIND_ITEMS.find((r) => r[0] === role))[2]);
            }
            if (grip) {
                grip.toggleClass('is-auto', auto);
                const what = (ROLE_ITEMS.find((r) => r[0] === role) ||
                              KIND_ITEMS.find((r) => r[0] === role))[1];
                grip.setAttr('aria-label', what +
                    (auto && !kind ? ' (automatic)' : '') +
                    '. Click to change; drag to move the card.');
            }
            card.toggleClass('is-scaffolding',
                             this.roleOf(id) === 'scaffolding');
        }
    }

    /** A card's quota, with whether the call requires it. */
    quotaOf(id) {
        const fm = this.cardProps(id);
        const q = core.parseLimit(fm.dendrite_limit);
        return q ? Object.assign(q, {
            required: fm.dendrite_limit_required === true }) : null;
    }

    /**
     * Each card with a quota shows what it uses against it and what the
     * quotas below it allocate; the bar does the same for the manuscript
     * total. Over a hard limit is an error, over a soft limit a warning.
     * Card text is read only when some quota is set.
     */
    async updateCounts() {
        if (!this.file || !this.board) return;
        const ms = this.manuscript();
        this.quotaReports = new Map();
        if (this.totalEl) this.totalEl.empty();
        const any = ms.limit || core.allNodes(this.root).some(
            (n) => this.quotaOf(n.id));
        if (!any) {
            for (const [id, card] of this.cardEls) this.fillQuota(card, id);
            return;
        }
        const bodies = await this.loadBodies();
        const bodyOf = (id) => (this.editing && this.editing.id === id) ?
            this.editing.editor.value : bodies.get(id);
        const floats = this.floatOpts(true);
        const countOf = (nodes) => core.countManuscript(nodes, bodyOf,
            (id) => this.printRoleOf(id), ms.countSpaces, floats);
        const total = ms.limit ? Object.assign({}, ms.limit,
            { required: ms.limitRequired }) : null;
        const reports = core.quotas(this.root, (id) => this.quotaOf(id),
            countOf, { wordsPerPage: ms.wordsPerPage,
                       charsPerWord: ms.charsPerWord, total });
        this.quotaReports = reports;
        for (const [id, card] of this.cardEls) this.fillQuota(card, id);
        if (!this.totalEl) return;
        const top = reports.get(null);
        if (top) {
            this.showQuota(this.totalEl, top);
        } else {
            const n = countOf(this.root.children);
            this.totalEl.setText(`${n.words.toLocaleString()} words`);
        }
    }

    /**
     * A card's quota at its bottom left: a target and a bar filled to its
     * use. Details fade in on hover; a click edits the quota. A card
     * without one shows the target only on hover, to offer setting one.
     */
    renderQuotaWidget(foot, id) {
        const w = foot.createDiv({ cls: 'dendrite-quota is-empty' });
        setIcon(w.createSpan({ cls: 'dendrite-quota-icon' }), 'target');
        const bar = w.createDiv({ cls: 'dendrite-quota-bar' });
        bar.createDiv({ cls: 'dendrite-quota-fill' });
        w.addEventListener('mouseenter', () => this.showQuotaTip(id, w));
        w.addEventListener('mouseleave', () => this.hideQuotaTip());
        w.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hideQuotaTip();
            this.editQuota(id, w);
        });
        const r = this.quotaReports && this.quotaReports.get(id);
        if (r) this.fillQuota(foot.parentElement, id);
    }

    fillQuota(card, id) {
        const w = card.querySelector(
            ':scope > .dendrite-card-foot > .dendrite-quota');
        if (!w) return;
        const r = this.quotaReports && this.quotaReports.get(id);
        w.removeClass('is-over-required');
        w.removeClass('is-over-target');
        w.toggleClass('is-empty', !r);
        if (!r) return;
        const kind = r.quota.required ? 'required' : 'target';
        const share = r.used / r.quota.amount;
        const over = share > 1 ||
            (r.allocated !== null && r.allocated > r.quota.amount);
        if (over) w.addClass(`is-over-${kind}`);
        w.toggleClass('is-required', r.quota.required);
        w.querySelector('.dendrite-quota-fill').style.width =
            Math.min(100, Math.round(share * 100)) + '%';
    }

    showQuotaTip(id, anchor) {
        this.hideQuotaTip();
        const tip = this.pageDoc().body.createDiv(
            { cls: 'dendrite-quota-tip' });
        const r = this.quotaReports && this.quotaReports.get(id);
        if (r) this.showQuota(tip, r);
        const a = anchor.getBoundingClientRect();
        tip.style.left = a.left + 'px';
        tip.style.top = (a.top - 6) + 'px';
        this.quotaTip = tip;
        this.pageWin().requestAnimationFrame(() => tip.addClass('is-shown'));
        return this.showCounts(tip, id);
    }

    /**
     * What a card prints, then with the cards below it where that
     * differs, as characters, words and pages, quota or none.
     */
    async showCounts(tip, id) {
        const node = this.byId.get(id);
        if (!node) return;
        const ms = this.manuscript();
        const bodies = await this.loadBodies();
        if (this.quotaTip !== tip) return;
        const bodyOf = (x) => (this.editing && this.editing.id === x) ?
            this.editing.editor.value : bodies.get(x);
        const roleOf = (x) => this.printRoleOf(x);
        const floats = this.floatOpts();
        const own = core.exportSegments([node], bodyOf, 1, null, roleOf,
                                        floats).find((s) => s.id === id);
        const rows = [['This card',
                       core.countText(own ? own.text : '', ms.countSpaces)]];
        if (node.children.length) {
            rows.push(['With cards below', core.countText(
                core.exportMarkdown([node], bodyOf, 1, null, roleOf, floats),
                ms.countSpaces)]);
        }
        const table = tip.createEl('table', { cls: 'dendrite-count-table' });
        const head = table.createEl('tr');
        for (const h of ['', 'Chars', 'Words', 'Pages']) {
            head.createEl('th', { text: h });
        }
        for (const [label, n] of rows) {
            const tr = table.createEl('tr');
            const pages = Math.round(n.words / ms.wordsPerPage * 100) / 100;
            for (const v of [label, n.chars.toLocaleString(),
                             n.words.toLocaleString(),
                             '~' + core.fmtNum(pages)]) {
                tr.createEl('td', { text: v });
            }
        }
    }

    hideQuotaTip() {
        if (this.quotaTip) this.quotaTip.remove();
        this.quotaTip = null;
    }

    /** A small editor for a card's quota, beside its target. */
    editQuota(id, anchor) {
        this.closeQuotaEditor();
        const f = this.cardFile(id);
        if (!f) return;
        const fm = this.cardProps(id);
        const q = core.parseLimit(fm.dendrite_limit);
        const pop = this.pageDoc().body.createDiv(
            { cls: 'dendrite-quota-pop' });
        const amount = pop.createEl('input', { type: 'text' });
        amount.placeholder = '500, or 1/4';
        amount.value = q ? core.fmtNum(q.amount) : '';
        const unit = pop.createEl('select');
        for (const u of ['words', 'characters', 'pages']) {
            unit.createEl('option', { text: u, value: u });
        }
        unit.value = q ? q.unit : 'words';
        const label = pop.createEl('label', { cls: 'dendrite-quota-req' });
        const req = label.createEl('input', { type: 'checkbox' });
        req.checked = fm.dendrite_limit_required === true;
        label.createSpan({ text: 'hard limit' });
        const row = pop.createDiv({ cls: 'dendrite-quota-actions' });
        const save = row.createEl('button', { cls: 'mod-cta',
                                              text: 'Save' });
        const clear = row.createEl('button', { text: 'Remove' });
        const a = anchor.getBoundingClientRect();
        pop.style.left = a.left + 'px';
        pop.style.top = (a.bottom + 4) + 'px';
        const write = async (remove) => {
            const n = core.parseAmount(amount.value);
            const ok = !remove && amount.value.trim() && n > 0;
            await writeProps(this.app, f, {
                dendrite_limit: ok ?
                    core.formatLimit({ amount: n, unit: unit.value }) : null,
                dendrite_limit_required: ok && req.checked ? true : null,
            });
            this.closeQuotaEditor();
        };
        save.onclick = () => write(false);
        clear.onclick = () => write(true);
        // Its own key scope, so Enter and Escape reach it and not the
        // board behind it.
        const scope = new Scope(this.app.scope);
        scope.register([], 'Enter', () => { write(false); return false; });
        scope.register([], 'Escape', () => {
            this.closeQuotaEditor();
            return false;
        });
        if (this.app.keymap) this.app.keymap.pushScope(scope);
        const outside = (e) => {
            if (!pop.contains(e.target)) this.closeQuotaEditor();
        };
        const doc = this.pageDoc();
        setTimeout(() => doc.addEventListener('mousedown', outside), 0);
        this.quotaPop = { pop, scope, outside, doc };
        amount.focus();
        amount.select();
    }

    closeQuotaEditor() {
        const q = this.quotaPop;
        if (!q) return;
        this.quotaPop = null;
        if (this.app.keymap) this.app.keymap.popScope(q.scope);
        q.doc.removeEventListener('mousedown', q.outside);
        q.pop.remove();
        this.contentEl.focus();
    }

    showQuota(el, r) {
        const q = r.quota;
        const kind = q.required ? 'required' : 'target';
        const tilde = (est) => (est ? '~' : '');
        const used = el.createDiv({ cls: 'dendrite-quota-line' });
        used.setText(`${tilde(r.usedEstimated)}${core.fmtNum(r.used)} / ` +
                     `${core.formatLimit(q)}`);
        used.createSpan({ cls: 'dendrite-quota-kind',
                          text: q.required ? 'hard limit' : 'soft limit' });
        if (r.used > q.amount) used.addClass(`is-over-${kind}`);
        if (r.allocated === null) return;
        const alloc = el.createDiv({ cls: 'dendrite-quota-line ' +
                                         'dendrite-quota-alloc' });
        const left = q.amount - r.allocated;
        alloc.setText(left >= 0 ?
            `${tilde(r.allocatedEstimated)}${core.fmtNum(r.allocated)} ` +
                `allocated, ${core.fmtNum(left)} free` :
            `${tilde(r.allocatedEstimated)}${core.fmtNum(r.allocated)} ` +
                `allocated, ${core.fmtNum(-left)} over`);
        if (left < 0) alloc.addClass(`is-over-${kind}`);
        el.setAttr('aria-label', (r.usedEstimated || r.allocatedEstimated) ?
            'Figures marked ~ are estimates, from words per page or ' +
            'characters per word in the manuscript settings.' : '');
    }

    async loadBodies() {
        this.bodies = this.bodies || new Map();
        for (const n of core.allNodes(this.root)) {
            const f = this.cardFile(n.id);
            if (!f) continue;
            const had = this.bodies.get(n.id);
            if (had && had.mtime === f.stat.mtime) continue;
            const text = await this.app.vault.cachedRead(f);
            this.bodies.set(n.id, { mtime: f.stat.mtime,
                                    body: core.splitFrontmatter(text).body });
        }
        const out = new Map();
        for (const [id, b] of this.bodies) out.set(id, b.body);
        return out;
    }

    // ---- find ------------------------------------------------------------

    /**
     * Open the find bar, or focus it when open. Find searches the cards'
     * notes, not the page, since cards far from view are not rendered.
     */
    openFind() {
        if (!this.find) {
            const ed = this.editing;
            this.find = {
                query: '', matchCase: false, regex: false, branch: null,
                matches: [], index: -1, error: null, token: 0,
                returnTo: ed ? { id: ed.id, sel: ed.editor.selection() }
                    : null,
            };
            this.renderFind();
        }
        const input = this.find.input;
        input.focus();
        input.select();
    }

    /** The find bar, under the view's bar. */
    renderFind() {
        const f = this.find;
        const bar = this.contentEl.querySelector(':scope > .dendrite-bar');
        if (!f || !bar) return;
        if (f.el) f.el.remove();
        const row = createDiv({ cls: 'dendrite-find' });
        bar.insertAdjacentElement('afterend', row);
        f.el = row;
        const input = row.createEl('input', { type: 'text' });
        input.placeholder = 'Find in cards: words, "a phrase"';
        input.value = f.query;
        input.spellcheck = false;
        f.input = input;
        input.addEventListener('input', () => {
            f.query = input.value;
            this.scheduleFind(false);
        });
        const toggle = (key, icon, title, on) => {
            const b = row.createEl('button', { cls: 'dendrite-find-opt' });
            setIcon(b, icon);
            b.setAttr('aria-label', title);
            b.toggleClass('is-on', !!f[key]);
            b.onclick = () => {
                f[key] = on();
                b.toggleClass('is-on', !!f[key]);
                this.runFind(false);
                input.focus();
            };
        };
        toggle('matchCase', 'case-sensitive', 'Match case',
               () => !f.matchCase);
        toggle('regex', 'regex', 'Regular expression', () => !f.regex);
        toggle('branch', 'git-branch', 'Only the selected card\'s branch',
               () => (f.branch ? null : this.active));
        f.countEl = row.createSpan({ cls: 'dendrite-find-count' });
        const btn = (icon, title, fn) => {
            const b = row.createEl('button', { cls: 'dendrite-find-opt' });
            setIcon(b, icon);
            b.setAttr('aria-label', title);
            b.onclick = fn;
        };
        btn('chevron-up', 'Previous match (Shift+Enter)',
            () => this.findStep(-1));
        btn('chevron-down', 'Next match (Enter)', () => this.findStep(1));
        btn('x', 'Close (Escape)', () => this.closeFind());
        // Its own keys while typing in it, above the board's.
        const scope = new Scope(this.app.scope);
        scope.register([], 'Enter', () => { this.findStep(1); return false; });
        scope.register(['Shift'], 'Enter', () => {
            this.findStep(-1);
            return false;
        });
        scope.register(['Mod'], 'Enter', () => {
            this.editAtMatch();
            return false;
        });
        scope.register([], 'Escape', () => { this.closeFind(); return false; });
        scope.register(['Mod'], 'f', () => { input.select(); return false; });
        f.scope = scope;
        // The same keys on the box itself, for wherever Obsidian does not
        // hand a key to the scope above; a key it handled arrives with
        // its default prevented and is left alone.
        input.addEventListener('keydown', (e) => {
            if (e.defaultPrevented || e.isComposing) return;
            const mod = e.ctrlKey || e.metaKey;
            if (e.key === 'Escape') this.closeFind();
            else if (e.key === 'Enter' && mod) this.editAtMatch();
            else if (e.key === 'Enter') this.findStep(e.shiftKey ? -1 : 1);
            else return;
            e.preventDefault();
            e.stopPropagation();
        });
        input.addEventListener('focus', () => {
            if (this.app.keymap) this.app.keymap.pushScope(scope);
        });
        input.addEventListener('blur', () => {
            if (this.app.keymap) this.app.keymap.popScope(scope);
        });
        this.showFind();
    }

    scheduleFind(keep) {
        clearTimeout(this.findTimer);
        this.findTimer = setTimeout(() => this.runFind(keep), 80);
    }

    /**
     * Search every card, or the branch find was narrowed to. With `keep`
     * the current match stays where it is, as after an edit; otherwise
     * find goes to the first match at or after the selected card.
     */
    async runFind(keep) {
        const f = this.find;
        if (!f) return;
        const token = ++f.token;
        const bodies = await this.loadBodies();
        if (this.find !== f || token !== f.token) return;
        const ed = this.editing;
        const bodyOf = (id) => (ed && ed.id === id ? ed.editor.value
            : bodies.get(id));
        const top = f.branch && this.byId.get(f.branch);
        const nodes = top ? [top, ...core.descendants(top)]
            : core.allNodes(this.root);
        const ids = nodes.map((n) => n.id);
        const r = core.findMatches(ids, bodyOf, f.query, f);
        const was = f.matches[f.index];
        f.matches = r.matches;
        f.error = r.error || null;
        if (!f.matches.length) {
            f.index = -1;
        } else if (keep && was) {
            const k = f.matches.findIndex((m) => m.id === was.id &&
                m.start >= was.start);
            f.index = k >= 0 ? k : Math.min(f.index, f.matches.length - 1);
        } else {
            const order = new Map(ids.map((id, k) => [id, k]));
            const here = order.has(this.active) ? order.get(this.active) : 0;
            const k = f.matches.findIndex((m) => order.get(m.id) >= here);
            f.index = k >= 0 ? k : 0;
        }
        if (!keep && f.index >= 0) await this.goToMatch(f.index);
        else this.showFind();
    }

    /** Count, fading, the matches below each card, and highlights. */
    showFind() {
        const f = this.find;
        if (!f || !this.board) return;
        const n = f.matches.length;
        const per = new Map();
        for (const m of f.matches) per.set(m.id, (per.get(m.id) || 0) + 1);
        if (f.countEl) {
            const comments = f.matches.filter((m) => m.comment).length;
            f.countEl.setText(f.error ? 'Not a valid pattern' :
                !f.query.trim() ? '' :
                !n ? 'No matches' :
                `${f.index + 1} of ${n} in ${per.size} card` +
                (per.size === 1 ? '' : 's') +
                (comments ? `, ${comments} in comments` : ''));
            f.countEl.toggleClass('is-error', !!f.error);
        }
        const on = !!f.query.trim() && !f.error;
        this.board.toggleClass('is-finding', on);
        // What each card holds below it, so a branch shows its matches
        // before it is opened.
        const below = new Map();
        for (const [id, k] of per) {
            const node = this.byId.get(id);
            for (let p = node && node.parent; p && p.id; p = p.parent) {
                below.set(p.id, (below.get(p.id) || 0) + k);
            }
        }
        for (const [id, card] of this.cardEls) {
            card.toggleClass('is-match', on && per.has(id));
            const old = card.querySelector(':scope > .dendrite-find-below');
            if (old) old.remove();
            if (on && below.get(id)) {
                const chip = card.createDiv({ cls: 'dendrite-find-below',
                    text: `${below.get(id)} below` });
                chip.setAttr('aria-label', 'Matches in this card\'s branch');
            }
        }
        this.paintFind();
    }

    /** Step to the next match, or back with -1, wrapping round. */
    async findStep(dir) {
        const f = this.find;
        if (!f || !f.matches.length) return;
        const n = f.matches.length;
        await this.goToMatch((f.index + dir + n) % n);
    }

    async goToMatch(i) {
        const f = this.find;
        const m = f && f.matches[i];
        if (!m) return;
        f.index = i;
        if (this.editing && this.editing.id !== m.id) await this.endEdit();
        if (this.find !== f) return;
        if (this.active !== m.id) {
            const node = this.byId.get(m.id);
            if (node && node.parent && node.parent.id) {
                this.lastChild.set(node.parent.id, m.id);
            }
            this.active = m.id;
        }
        this.applyActive();
        this.showFind();
        // Ending an edit hands focus to the board; typing stays in find.
        if (f.input && f.input.isConnected) f.input.focus();
    }

    /** Edit the card holding the current match, with the match selected. */
    async editAtMatch() {
        const f = this.find;
        const m = f && f.matches[f.index];
        if (!m) return;
        await this.startEdit(m.id);
        if (this.editing && this.editing.id === m.id && !m.card) {
            this.editing.editor.focusAt(m.start, m.end);
        }
    }

    closeFind() {
        const f = this.find;
        if (!f) return;
        this.find = null;
        clearTimeout(this.findTimer);
        if (this.app.keymap && f.scope) this.app.keymap.popScope(f.scope);
        if (f.el) f.el.remove();
        if (this.board) this.board.removeClass('is-finding');
        for (const card of this.cardEls.values()) {
            card.removeClass('is-match');
            const chip = card.querySelector(':scope > .dendrite-find-below');
            if (chip) chip.remove();
        }
        this.paintFind();
        const back = f.returnTo;
        if (back && this.editing && this.editing.id === back.id) {
            this.editing.editor.focusAt(back.sel[0], back.sel[1]);
        } else {
            this.contentEl.focus();
        }
    }

    /**
     * Highlight matches in the rendered cards, without changing them:
     * the browser's highlight registry paints ranges over the text. The
     * query is run again over each card's rendered text, since markdown
     * syntax does not render; the current match is the same-numbered
     * match in its card.
     */
    paintFind() {
        const f = this.find;
        // A card found by its id: the id in its footer is marked.
        for (const [id, card] of this.cardEls) {
            const tag = card.querySelector('.dendrite-id');
            if (!tag) continue;
            const m = f && f.matches.find((x) => x.card && x.id === id);
            tag.toggleClass('is-match', !!m);
            tag.toggleClass('is-current', !!m && m === f.matches[f.index]);
        }
        const win = this.pageWin();
        const reg = win.CSS && win.CSS.highlights;
        if (!reg || typeof win.Highlight !== 'function') return;
        reg.delete('dendrite-find');
        reg.delete('dendrite-find-current');
        if (!f || !f.matches.length) return;
        const { patterns } = core.findPatterns(f.query, f);
        const cur = f.matches[f.index];
        const nth = cur && !cur.card ? f.matches.filter((m) =>
            m.id === cur.id && !m.card && m.start < cur.start).length : -1;
        const doc = this.pageDoc();
        const all = [];
        let current = null;
        const ids = new Set(f.matches.map((m) => m.id));
        for (const id of ids) {
            const card = this.cardEls.get(id);
            const ed = this.editing;
            if (ed && ed.id === id) {
                // The card being written: its matches from the text as it
                // now stands, placed by the editor itself.
                this.paintEditing(ed, patterns, id === (cur && cur.id) ?
                    nth : -1, all, (r) => { current = r; });
                continue;
            }
            const md = card && card.querySelector('.dendrite-md');
            if (!md) continue;
            const nodes = [];
            let text = '';
            const walker = doc.createTreeWalker(md, 4);
            for (let t = walker.nextNode(); t; t = walker.nextNode()) {
                nodes.push({ t, at: text.length });
                text += t.data;
            }
            const spans = [];
            for (const p of patterns) {
                p.lastIndex = 0;
                let m;
                while ((m = p.exec(text)) !== null) {
                    if (!m[0].length) { p.lastIndex += 1; continue; }
                    spans.push([m.index, m.index + m[0].length]);
                }
            }
            spans.sort((a, b) => a[0] - b[0]);
            const point = (k) => {
                let i = nodes.length - 1;
                while (i > 0 && nodes[i].at > k) i -= 1;
                return [nodes[i].t, k - nodes[i].at];
            };
            spans.forEach(([a, b], k) => {
                const r = doc.createRange();
                r.setStart(...point(a));
                r.setEnd(...point(b));
                if (id === (cur && cur.id) && k === nth) current = r;
                else all.push(r);
            });
        }
        reg.set('dendrite-find', new win.Highlight(...all));
        if (current) {
            reg.set('dendrite-find-current', new win.Highlight(current));
        }
    }

    /** Find's matches in the editor of the card being written. */
    paintEditing(ed, patterns, nth, all, setCurrent) {
        const text = ed.editor.value;
        const spans = [];
        for (const p of patterns) {
            p.lastIndex = 0;
            let m;
            while ((m = p.exec(text)) !== null) {
                if (!m[0].length) { p.lastIndex += 1; continue; }
                spans.push([m.index, m.index + m[0].length]);
            }
        }
        spans.sort((a, b) => a[0] - b[0]);
        spans.forEach(([a, b], k) => {
            const r = ed.editor.rangeAt(a, b);
            if (!r) return;
            if (k === nth) setCurrent(r);
            else all.push(r);
        });
    }

    // ---- export ----------------------------------------------------------

    /** Export, the whole manuscript or a branch, as chosen from a menu. */
    exportMenu(node, event) {
        const { Menu } = require('obsidian');
        const m = new Menu();
        m.addItem((i) => i.setTitle('Markdown').setIcon('file-text')
            .onClick(() => this.exportTo(node, 'md')));
        if (Platform.isDesktopApp) {
            m.addItem((i) => i.setTitle('PDF').setIcon('file-output')
                .onClick(() => this.exportTo(node, 'pdf')));
            m.addItem((i) => i.setTitle('Word').setIcon('file-output')
                .onClick(() => this.exportTo(node, 'docx')));
        }
        if (event) m.showAtMouseEvent(event);
    }

    /**
     * Export the manuscript, or one branch, to `exports/` beside the index:
     * markdown always, PDF and Word through Pandoc on the desktop, with
     * citations fetched from Zotero. Exports stay in the vault so a PDF
     * opens beside the board and travels with the vault's sync.
     */
    async exportTo(node, format = 'md') {
        await this.flush();
        if (this.reverted.size) {
            const names = [...this.reverted].map((k) =>
                (k === 'index' ? 'the index' : core.shortId(k)));
            new Notice('Dendrite: not exported, since ' + names.join(', ') +
                       ' changed to an older copy. Click "older copy" ' +
                       'to compare and choose first.', 10000);
            return null;
        }
        const scope = node ? [node] : this.root.children;
        const ids = node ? [node, ...core.descendants(node)] :
            core.allNodes(this.root);
        const bodies = new Map();
        for (const n of ids) {
            const f = this.cardFile(n.id);
            if (f) {
                bodies.set(n.id, core.splitFrontmatter(
                    await this.app.vault.cachedRead(f)).body);
            }
        }
        const ms = this.manuscript();
        const floats = this.floatOpts(true);
        const text = core.exportMarkdown(scope, (id) => bodies.get(id),
                                         ms.headingTop, this.numbers(),
                                         (id) => this.printRoleOf(id),
                                         floats);
        const dir = normalizePath(
            (this.file.parent.path === '/' ? '' :
                this.file.parent.path + '/') + 'exports');
        if (!this.app.vault.getAbstractFileByPath(dir)) {
            await this.app.vault.createFolder(dir);
        }
        const name = safeName(this.file.basename +
            (node ? ' - ' + (node.label || node.id) : ''));
        if (format !== 'md') {
            await this.exportPandoc(text, format, dir, name, ms, !node);
            return;
        }
        const path = normalizePath(`${dir}/${name}.md`);
        const existing = this.app.vault.getAbstractFileByPath(path);
        let out;
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, text);
            out = existing;
        } else {
            out = await this.app.vault.create(path, text);
        }
        await this.app.workspace.getLeaf('tab').openFile(out);
        new Notice(`Dendrite: exported to ${path}`);
    }

    /**
     * Write Pandoc's default reference.docx beside the index, never over
     * one that exists. Returns its path from the vault root, or null.
     */
    async makeReferenceDocx() {
        const nodePath = require('path');
        const base = this.app.vault.adapter.getBasePath ?
            this.app.vault.adapter.getBasePath() : '';
        const parent = this.file.parent && this.file.parent.path !== '/' ?
            this.file.parent.path + '/' : '';
        const rel = normalizePath(parent + 'reference.docx');
        if (this.app.vault.getAbstractFileByPath(rel)) {
            new Notice(`Dendrite: ${rel} already exists; it is used as is.`);
            return rel;
        }
        try {
            await this.plugin.pandocDeps().run(
                this.plugin.settings.pandocPath || 'pandoc',
                ['-o', nodePath.join(base, rel),
                 '--print-default-data-file', 'reference.docx']);
        } catch (err) {
            new Notice('Dendrite: could not write reference.docx. ' +
                pandoc.pandocError(err,
                    this.plugin.settings.pandocPath || 'pandoc'));
            return null;
        }
        new Notice(`Dendrite: wrote ${rel}. Open it in Word, set the ` +
                   'Normal and heading styles, and save.');
        return rel;
    }

    async exportPandoc(text, format, dir, name, ms, whole) {
        const s = this.plugin.settings;
        const base = this.app.vault.adapter.getBasePath ?
            this.app.vault.adapter.getBasePath() : '';
        const nodePath = require('path');
        const rel = normalizePath(`${dir}/${name}.${format}`);
        const output = nodePath.join(base, rel);
        const csl = ms.csl ? nodePath.join(base, ms.csl) : null;
        const inVault = (p) => (p ? nodePath.join(base, p) : null);
        const style = Object.assign({}, ms.style, {
            defaults: inVault(ms.style.defaults),
            referenceDocx: inVault(ms.style.referenceDocx) });
        const notice = new Notice('Dendrite: exporting to ' +
            (format === 'pdf' ? 'PDF' : 'Word') + '…', 0);
        const result = await pandoc.exportDocument({
            md: text, format, output, csl, style,
            port: s.zoteroPort, fallbackBib: s.fallbackBib || null,
            pandoc: s.pandocPath || 'pandoc',
            engine: format === 'pdf' ? (s.pdfEngine || 'xelatex') : null,
            resourcePath: base,
            resolve: (link) => {
                const f = this.app.metadataCache.getFirstLinkpathDest(
                    link, this.file.path);
                return f ? nodePath.join(base, f.path) : null;
            },
        }, this.plugin.pandocDeps());
        notice.hide();
        if (result.error) {
            new Notice(`Dendrite: ${result.error}`, 12000);
            return;
        }
        const cites = result.keys.length ?
            ` with ${result.keys.length} citation(s)` : '';
        new Notice(`Dendrite: exported to ${rel}${cites}.`);
        // A whole manuscript's PDF measures its words per page, which
        // page quotas and estimates use from then on.
        const bodies = whole ? await this.loadBodies() : null;
        const counted = whole ? core.countManuscript(this.root.children,
            (id) => bodies.get(id), (id) => this.printRoleOf(id),
            ms.countSpaces, this.floatOpts(true)) : null;
        const rate = whole ? pandoc.measuredRate(counted.words,
            result.layout, result.keys.length > 0, counted.pages) : null;
        if (rate && rate !== ms.wordsPerPageMeasured) {
            await writeProps(this.app, this.file,
                             { dendrite_measured_words_per_page: rate });
        }
        await this.plugin.showExport(rel, output, format);
    }

}

/**
 * The manuscript as export would print it, in a pane beside the board,
 * re-rendered as cards change. Each card's part is its own block: a click
 * selects that card on the board, a double-click opens its editor, and the
 * board's active card is highlighted here. Editing stays in the cards,
 * since the printed text is transformed (headings levelled and numbered,
 * notes and comments dropped) and an edit here could not be mapped back.
 * Only blocks near the screen render, and a block re-renders only when
 * what it prints changes.
 */
class DendritePreview extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.file = null;
        this.showLeft = false;
        this.notesAt = 'section';
        this.blocks = new Map();
        this.segs = new Map();
        this.bodies = new Map();
        this.active = null;
    }

    getViewType() { return PREVIEW; }
    getIcon() { return 'scroll-text'; }
    getDisplayText() {
        return this.file ? `Preview: ${this.file.basename}` :
            'Dendrite preview';
    }

    getState() {
        return { file: this.file ? this.file.path : null,
                 showLeft: this.showLeft, notesAt: this.notesAt };
    }

    async setState(state, result) {
        const f = state && state.file &&
            this.app.vault.getAbstractFileByPath(state.file);
        this.showLeft = !!(state && state.showLeft);
        this.notesAt = NOTES_AT[state && state.notesAt] ? state.notesAt :
            'section';
        if (f instanceof TFile) {
            this.file = f;
            this.build();
            await this.refresh();
        }
        return super.setState(state, result);
    }

    async onOpen() {
        this.contentEl.addClass('dendrite-preview');
        this.observer = new IntersectionObserver(
            (entries) => this.onVisible(entries),
            { root: null, rootMargin: '800px 0px' });
        const changed = (f) => {
            if (!(f instanceof TFile) || !this.file) return;
            if (f === this.file || this.segs.has(f.basename)) {
                this.scheduleRefresh();
            }
        };
        this.registerEvent(this.app.vault.on('modify', changed));
        this.registerEvent(this.app.metadataCache.on('changed', changed));
        this.registerEvent(this.app.vault.on('rename', (f) => {
            if (f === this.file) this.leaf.updateHeader();
            else changed(f);
        }));
        this.registerDomEvent(this.contentEl, 'click', (e) => {
            const b = e.target.closest('.dendrite-pblock');
            if (b && !b.dataset.notes && this.file) {
                this.plugin.focusCard(this.file, b.dataset.id, false);
            }
        });
        this.registerDomEvent(this.contentEl, 'dblclick', (e) => {
            const b = e.target.closest('.dendrite-pblock');
            if (b && !b.dataset.notes && this.file) {
                this.plugin.focusCard(this.file, b.dataset.id, true);
            }
        });
    }

    async onClose() {
        if (this.observer) this.observer.disconnect();
        for (const b of this.blocks.values()) {
            if (b.comp) b.comp.unload();
        }
        this.blocks.clear();
    }

    build() {
        const el = this.contentEl;
        el.empty();
        this.blocks.clear();
        const bar = el.createDiv({ cls: 'dendrite-bar' });
        bar.createDiv({ cls: 'dendrite-title',
                        text: this.file ? this.file.basename : '' });
        const toggle = bar.createEl('label', { cls: 'dendrite-bar-btn' });
        const box = toggle.createEl('input', { type: 'checkbox' });
        box.checked = this.showLeft;
        toggle.createSpan({ text: 'Show left out' });
        toggle.setAttr('aria-label', 'Also show, dimmed, the text that ' +
                       'does not print: notes and comments');
        box.addEventListener('change', () => {
            this.showLeft = box.checked;
            this.app.workspace.requestSaveLayout();
            this.refresh();
        });
        const notesAt = bar.createEl('select',
                                     { cls: 'dropdown dendrite-bar-select' });
        notesAt.setAttr('aria-label', 'Where footnotes are shown');
        for (const [v, label] of Object.entries(NOTES_AT)) {
            notesAt.createEl('option', { value: v, text: label });
        }
        notesAt.value = this.notesAt;
        notesAt.addEventListener('change', () => {
            this.notesAt = notesAt.value;
            this.app.workspace.requestSaveLayout();
            this.refresh();
        });
        this.doc = el.createDiv({ cls: 'dendrite-preview-doc ' +
                                       'markdown-preview-view ' +
                                       'markdown-rendered' });
    }

    scheduleRefresh() {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refresh(), 300);
    }

    cardFile(id) {
        const f = this.app.metadataCache.getFirstLinkpathDest(
            id, this.file.path);
        return f instanceof TFile ? f : null;
    }

    async refresh() {
        if (!this.file || !this.doc) return;
        const text = await this.app.vault.cachedRead(this.file);
        const root = core.parseIndex(core.splitFrontmatter(text).body).root;
        const fm = this.app.metadataCache.getFileCache(this.file)
            ?.frontmatter || {};
        const top = Number(fm.dendrite_heading_top);
        const headingTop = top >= 1 && top <= 6 ? top :
            this.plugin.settings.headingTop;
        for (const n of core.allNodes(root)) {
            const f = this.cardFile(n.id);
            if (!f) continue;
            const had = this.bodies.get(n.id);
            if (had && had.mtime === f.stat.mtime) continue;
            this.bodies.set(n.id, { mtime: f.stat.mtime, body:
                core.splitFrontmatter(await this.app.vault.cachedRead(f))
                    .body });
        }
        const props = (id) => {
            const f = this.cardFile(id);
            return (f && this.app.metadataCache.getFileCache(f)
                ?.frontmatter) || {};
        };
        const kindOf = (id) => {
            const k = props(id).dendrite_kind;
            return core.KINDS.includes(k) ? k : null;
        };
        const roleOf = core.withKinds((id) => {
            const r = props(id).dendrite_role;
            return core.ROLES.includes(r) ? r : null;
        }, kindOf);
        const hasHeading = (id) => {
            const f = this.cardFile(id);
            const s = f && this.app.metadataCache.getFileCache(f)?.sections;
            const first = (s || []).find((x) => x.type !== 'yaml');
            return !!first && first.type === 'heading';
        };
        const numbers = fm.dendrite_number_sections === true ?
            core.sectionNumbers(root.children, hasHeading, roleOf,
                                kindOf) : null;
        // Footnotes numbered across the whole document, as export does;
        // shown under each card, each top-level section, or at the end.
        const segs = core.gatherFootnotes(core.renumberFootnotes(
            core.exportSegments(root.children, (id) => {
                const b = this.bodies.get(id);
                return b ? b.body : '';
            }, headingTop, numbers, roleOf, { kindOf })).segments,
            this.notesAt);
        // Only flagged cards are marked here, with a faint bar, so the
        // preview stays a page to read.
        const statusOf = (id) => {
            const s = props(id).dendrite_status;
            return core.STATUSES.includes(s) ? s : null;
        };
        const report = core.statusReport(root, statusOf, roleOf);
        this.flags = new Map();
        for (const [id, info] of report.cards) {
            if (core.isFlag(info.own)) {
                this.flags.set(id, this.plugin.statusColour ?
                    this.plugin.statusColour(info.own) : null);
            }
        }
        this.renderSegments(segs);
    }

    renderSegments(segs) {
        this.segs = new Map(segs.map((s) => [s.id, s]));
        for (const [id, b] of this.blocks) {
            if (!this.segs.has(id)) {
                if (b.comp) b.comp.unload();
                b.el.remove();
                this.blocks.delete(id);
            }
        }
        for (const s of segs) {
            const key = s.text + '\u0000' +
                core.footnoteBlock(s.cardNotes || []) +
                '\u0000' + (this.showLeft ? s.left : '') + '\u0000' +
                this.notesAt + '\u0000' +
                (s.gathered ? core.footnoteBlock(s.gathered) : '');
            let b = this.blocks.get(s.id);
            if (!b) {
                const el = createDiv({ cls: 'dendrite-pblock' });
                el.dataset.id = s.id;
                if (s.gathered) {
                    el.addClass('dendrite-pnotes');
                    el.dataset.notes = 'true';
                }
                b = { el, key: null, comp: null };
                this.blocks.set(s.id, b);
            }
            const empty = !s.text && !(this.showLeft && s.left) &&
                !s.gathered;
            b.el.toggleClass('is-empty', empty);
            b.el.toggleClass('is-left-out-only', !s.text);
            if (b.key !== key) {
                b.key = key;
                b.el.addClass('is-pending');
                if (this.observer && !empty) this.observer.observe(b.el);
            }
            b.el.toggleClass('is-active', s.id === this.active);
            const flag = this.flags && this.flags.has(s.id);
            b.el.toggleClass('is-flagged', !!flag);
            if (flag && this.flags.get(s.id)) {
                b.el.style.setProperty('--dendrite-chip',
                                       this.flags.get(s.id));
            }
            this.doc.appendChild(b.el);
        }
    }

    onVisible(entries) {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            this.observer.unobserve(e.target);
            if (e.target.hasClass('is-pending')) {
                this.renderBlock(e.target.dataset.id);
            }
        }
    }

    async renderBlock(id) {
        const b = this.blocks.get(id);
        const s = this.segs.get(id);
        if (!b || !s) return;
        b.el.removeClass('is-pending');
        if (b.comp) b.comp.unload();
        b.comp = new Component();
        b.comp.load();
        b.el.empty();
        const f = this.cardFile(id);
        const path = f ? f.path : this.file.path;
        // The same tidied text export writes, so the preview shows the
        // document's real spacing.
        if (s.gathered) {
            await this.renderNotes(s.gathered, b);
            return;
        }
        if (s.text) {
            const notes = s.cardNotes && s.cardNotes.length ?
                '\n\n' + core.footnoteBlock(s.cardNotes) : '';
            await MarkdownRenderer.render(this.app,
                core.normaliseMarkdown(s.text + notes), b.el.createDiv(),
                path, b.comp);
            // Gathered: Obsidian still draws the references, numbered from
            // 1 in this card; they take the document's numbers, and the
            // card's own list is hidden by the stylesheet.
            b.el.toggleClass('is-notes-gathered', this.notesAt !== 'card');
            if (this.notesAt !== 'card') renumberRefs(b.el, s.refs || []);
        }
        if (this.showLeft && s.left) {
            await MarkdownRenderer.render(this.app, s.left,
                b.el.createDiv({ cls: 'dendrite-left-out' }), path, b.comp);
        }
    }

    /**
     * A gathered list of footnotes, rendered by Obsidian as a card's own
     * would be, then numbered as the document numbers them. The
     * references it needs to render are removed after.
     */
    async renderNotes(notes, b) {
        const md = notes.map((x) => `[^${x.n}]`).join(' ') + '\n\n' +
            core.footnoteBlock(notes);
        const el = b.el.createDiv();
        await MarkdownRenderer.render(this.app, md, el, this.file.path,
                                      b.comp);
        const items = el.querySelectorAll('.footnotes li');
        items.forEach((li, i) => {
            if (notes[i]) li.setAttribute('value', String(notes[i].n));
        });
        for (const r of [...el.querySelectorAll('.footnote-ref')]) {
            const p = r.closest('p');
            if (p && !p.closest('.footnotes')) p.remove();
        }
    }

    /** Highlight the board's active card here, and bring it into view. */
    highlight(id) {
        this.active = id;
        for (const [bid, b] of this.blocks) {
            b.el.toggleClass('is-active', bid === id);
        }
        const b = this.blocks.get(id);
        if (b && b.el.scrollIntoView) {
            b.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }
}

/** A text property, trimmed, or null. */
function textProp(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * A running header's or footer's slots from dendrite_<which>_left,
 * _center and _right, each text or a list of lines; null when none is
 * set.
 */
function slots(fm, which) {
    const out = {};
    for (const k of ['left', 'center', 'right']) {
        let v = fm[`dendrite_${which}_${k}`];
        if (Array.isArray(v)) v = v.map(String).join('\n');
        v = textProp(v);
        if (v) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * How PDF and Word export look, from the index's properties: font, font
 * size in points (`10` or `10pt`), margin (a bare number is in cm),
 * paper (letter or a4), line
 * spacing, page numbers (on unless false), a Pandoc defaults file and a
 * Word reference document, both paths from the vault root, the
 * reference list's heading (References unless set; false for none), and
 * the space above the footnote rule, a TeX length (a bare number is in
 * points), and a running header and footer, as `slots` reads them.
 */
function exportStyle(fm) {
    const size = parseFloat(String(fm.dendrite_font_size || ''));
    const spacing = Number(fm.dendrite_line_spacing);
    let margin = textProp(String(fm.dendrite_margin || ''));
    if (margin && /^\d+(\.\d+)?$/.test(margin)) margin += 'cm';
    let gap = String(fm.dendrite_footnote_gap ?? '').trim();
    if (/^\d+(\.\d+)?$/.test(gap)) gap += 'pt';
    if (!/^\d+(\.\d+)?(pt|bp|mm|cm|in|em|ex)$/.test(gap)) gap = null;
    return {
        font: textProp(fm.dendrite_font),
        fontSize: size > 0 ? size : null,
        margin,
        paper: ['letter', 'a4'].includes(fm.dendrite_paper) ?
            fm.dendrite_paper : null,
        lineSpacing: spacing > 0 ? spacing : null,
        pageNumbers: fm.dendrite_page_numbers !== false,
        defaults: textProp(fm.dendrite_pandoc_defaults),
        referenceDocx: textProp(fm.dendrite_reference_docx),
        referencesTitle: fm.dendrite_references_title === false ? false :
            textProp(fm.dendrite_references_title),
        footnoteGap: gap,
        header: slots(fm, 'header'),
        footer: slots(fm, 'footer'),
        headerInMargin: fm.dendrite_header_in_margin === true,
    };
}

/**
 * A POST with Node's http, answered as { status, json() }. Only what the
 * Zotero request needs: no redirects, no User-Agent, no Origin.
 */
function nodeRequest(url, init) {
    const http = require('http');
    return new Promise((resolve, reject) => {
        const body = init.body || '';
        const req = http.request(url, { method: init.method,
            headers: Object.assign({}, init.headers,
                { 'Content-Length': Buffer.byteLength(body) }),
            timeout: 30000 }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode,
                json: async () => JSON.parse(data) }));
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
        req.end(body);
    });
}

/**
 * A ticked menu item's tick, which Obsidian puts after the title, moved
 * to just before the item's key, so the keys stay in one column at the
 * menu's right edge.
 */
function tickBeforeKey(item) {
    const dom = item.dom;
    const tick = item.checkIconEl ||
        (dom && dom.querySelector(':scope > .menu-item-icon.mod-checked'));
    const key = dom && dom.querySelector('.dendrite-menu-key');
    if (tick && key) key.before(tick);
}

/**
 * A card's footnote references, which a renderer numbers from 1 in each
 * card, given the document's numbers: the i-th note the card refers to
 * is `refs[i - 1]`.
 */
function renumberRefs(el, refs) {
    for (const a of el.querySelectorAll('.footnote-ref a, a.footnote-ref')) {
        a.textContent = a.textContent.replace(/\d+/, (d) =>
            String(refs[Number(d) - 1] || d));
    }
}

/**
 * A quota: an amount, which may be a fraction such as 1/4, a unit, and
 * whether the call requires it. Writes `dendrite_limit` and
 * `dendrite_limit_required` into `draft`, or removes them.
 */
function quotaSetting(container, name, desc, current, required, draft) {
    let amount = current ? core.fmtNum(current.amount) : '';
    let unit = current ? current.unit : 'words';
    let req = !!required;
    const emit = () => {
        const n = core.parseAmount(amount);
        const ok = amount.trim() && n > 0;
        draft.dendrite_limit = ok ?
            core.formatLimit({ amount: n, unit }) : null;
        draft.dendrite_limit_required = ok && req ? true : null;
    };
    new Setting(container).setName(name).setDesc(desc)
        .addText((t) => t.setPlaceholder('none, or 500, or 1/4')
            .setValue(amount).onChange((v) => { amount = v; emit(); }))
        .addDropdown((d) => d.addOption('words', 'words')
            .addOption('characters', 'characters')
            .addOption('pages', 'pages').setValue(unit)
            .onChange((v) => { unit = v; emit(); }));
    new Setting(container).setName('Hard limit')
        .setDesc('On: a limit that cannot be exceeded, such as one a ' +
                 'call sets, shown red when exceeded. Off: a soft limit, ' +
                 'your own allocation, shown amber.')
        .addToggle((tg) => tg.setValue(req)
            .onChange((v) => { req = v; emit(); }));
}

class ManuscriptModal extends Modal {
    constructor(view) {
        super(view.app);
        this.view = view;
    }

    onOpen() {
        const { contentEl } = this;
        const view = this.view;
        const ms = view.manuscript();
        const draft = {};
        this.titleEl.setText(`${view.file.basename}: settings`);
        new Setting(contentEl).setName('Prefix')
            .setDesc('Starts every card ID in this manuscript. Fixed once ' +
                     'cards exist, since their file names carry it.')
            .addText((t) => t.setValue(ms.prefix || '').setDisabled(true));
        quotaSetting(contentEl, 'Total quota',
            'For the whole manuscript, shown in the top bar against what ' +
            'it uses and what its sections allocate.', ms.limit,
            ms.limitRequired, draft);
        new Setting(contentEl).setName('Count spaces in characters')
            .setDesc('Funding portals differ; check the call.')
            .addToggle((tg) => tg.setValue(ms.countSpaces)
                .onChange((v) => { draft.dendrite_count_spaces = v; }));
        new Setting(contentEl).setName('Words per page')
            .setDesc(ms.wordsPerPageMeasured ?
                'Measured from the last PDF of the whole manuscript, and ' +
                'measured again at each one. A number typed here is used ' +
                'until then.' :
                'For page estimates and page quotas, until a PDF of the ' +
                'whole manuscript is exported, which measures it.')
            .addText((t) => t.setValue(String(ms.wordsPerPage))
                .onChange((v) => {
                    draft.dendrite_words_per_page = Number(v) > 0 ?
                        Number(v) : null;
                    draft.dendrite_measured_words_per_page = null;
                }));
        new Setting(contentEl).setName('Characters per word')
            .setDesc('Only for comparing quotas set in characters with ' +
                     'quotas in words or pages, an estimate.')
            .addText((t) => t.setValue(String(ms.charsPerWord))
                .onChange((v) => {
                    draft.dendrite_chars_per_word = Number(v) > 0 ?
                        Number(v) : null;
                }));
        new Setting(contentEl).setName('Number sections by position')
            .setDesc('Write headings without numbers; sections are ' +
                     'numbered from where they sit, and renumber when ' +
                     'moved.')
            .addToggle((tg) => tg.setValue(ms.number)
                .onChange((v) => { draft.dendrite_number_sections = v; }));
        new Setting(contentEl).setName('Citation style')
            .setDesc('A CSL style file in the vault, as a path from the ' +
                     'vault root, for PDF and Word export. Empty: ' +
                     'Pandoc\'s default, Chicago author-date.')
            .addText((t) => t.setPlaceholder('styles/nature.csl')
                .setValue(ms.csl || '').onChange((v) => {
                    draft.dendrite_csl = v.trim() || null;
                }));
        const st = ms.style;
        new Setting(contentEl).setName('PDF and Word').setHeading();
        const text = (name, desc, value, key, placeholder) =>
            new Setting(contentEl).setName(name).setDesc(desc)
                .addText((t) => t.setPlaceholder(placeholder || '')
                    .setValue(value === null || value === undefined ? '' :
                        String(value))
                    .onChange((v) => { draft[key] = v.trim() || null; }));
        text('Font', 'For PDF, any font installed on this computer. ' +
             'Empty: Latin Modern, LaTeX\'s own.', st.font,
             'dendrite_font', 'Arial');
        text('Font size', 'In points, for PDF. 8, 9, 10, 11, 12, 14, 17 ' +
             'or 20. Empty: 10.', st.fontSize, 'dendrite_font_size', '10');
        text('Margin', 'For PDF, on every side, such as 2cm or 1in. ' +
             'Empty: 2.5cm.', st.margin, 'dendrite_margin', '2.5cm');
        new Setting(contentEl).setName('Paper')
            .setDesc('For PDF.')
            .addDropdown((d) => d.addOption('letter', 'US Letter')
                .addOption('a4', 'A4').setValue(st.paper || 'letter')
                .onChange((v) => {
                    draft.dendrite_paper = v === 'letter' ? null : v;
                }));
        text('Line spacing', 'For PDF: 1 is single, 1.5 one and a half. ' +
             'Empty: single.', st.lineSpacing, 'dendrite_line_spacing',
             '1');
        text('Space above footnotes', 'For PDF, between the last line ' +
             'of text and the footnote rule, such as 14pt or 0.5cm; a ' +
             'bare number is in points. Empty: one line of text.',
             st.footnoteGap, 'dendrite_footnote_gap', '');
        // Header and footer: three slots each, for PDF.
        new Setting(contentEl).setName('Header and footer').setHeading()
            .setDesc('For PDF, on every page in the text\'s font and size. ' +
                     'Each slot takes several lines, **bold**, *italic*, ' +
                     '{page} and {pages}. A footer set replaces the page ' +
                     'number at the foot; so does {page} anywhere.');
        for (const which of ['header', 'footer']) {
            for (const [k, name] of [['left', 'left'], ['center', 'centre'],
                                     ['right', 'right']]) {
                const key = `dendrite_${which}_${k}`;
                const now = st[which] && st[which][k];
                new Setting(contentEl)
                    .setName(`${which[0].toUpperCase()}${which.slice(1)}, ` +
                             name)
                    .addTextArea((t) => t.setValue(now || '')
                        .onChange((v) => { draft[key] = v.trim() || null; }));
            }
        }
        new Setting(contentEl).setName('Header and footer in the margin')
            .setDesc('Print them in the page margin, so the text keeps its ' +
                     'whole area, where the format allows it. Off, the ' +
                     'margin is measured to them and nothing is printed ' +
                     'in it. A small margin may not hold several lines.')
            .addToggle((tg) => tg.setValue(st.headerInMargin)
                .onChange((v) => {
                    draft.dendrite_header_in_margin = v || null;
                }));
        new Setting(contentEl).setName('Page numbers')
            .setDesc('For PDF, at the foot of each page, numbered ' +
                     'consecutively.')
            .addToggle((tg) => tg.setValue(st.pageNumbers)
                .onChange((v) => {
                    draft.dendrite_page_numbers = v ? null : false;
                }));
        text('Reference list heading', 'Over the list of references, for ' +
             'a citation style that prints one. Empty: References.',
             st.referencesTitle || null, 'dendrite_references_title',
             'References');
        text('Pandoc defaults file', 'For anything else a call asks, a ' +
             'Pandoc defaults file in the vault, as a path from the vault ' +
             'root. The settings above win over it.', st.defaults,
             'dendrite_pandoc_defaults', 'styles/grant.yaml');
        text('Word reference document', 'A .docx whose styles Word export ' +
             'copies, fonts and sizes included, as a path from the vault ' +
             'root. Set its styles in Word.', st.referenceDocx,
             'dendrite_reference_docx', 'styles/reference.docx');
        if (Platform.isDesktopApp) {
            new Setting(contentEl).setDesc('No reference document yet? ' +
                'This writes Pandoc\'s own beside the index, to open in ' +
                'Word, restyle and save.')
                .addButton((b) => b.setButtonText('Make reference.docx')
                    .onClick(async () => {
                        const rel = await view.makeReferenceDocx();
                        if (rel) draft.dendrite_reference_docx = rel;
                    }));
        }
        new Setting(contentEl).setName('Top section heading level')
            .setDesc('Export writes top-level sections at this level.')
            .addDropdown((d) => {
                for (let i = 1; i <= 4; i++) d.addOption(String(i), 'H' + i);
                d.setValue(String(ms.headingTop)).onChange((v) => {
                    draft.dendrite_heading_top = Number(v);
                });
            });
        new Setting(contentEl).addButton((b) => b.setButtonText('Save')
            .setCta().onClick(async () => {
                await writeProps(view.app, view.file, draft);
                this.close();
            }));
    }

    onClose() { this.contentEl.empty(); }
}

/**
 * A note marked as gone back to an older copy: what happened, the text
 * now and before compared, and the choices, each saying what it writes.
 * Opening it writes nothing.
 */
// Rows of a comparison shown at most, in either layout.
const MAX_DIFF_ROWS = 300;

class VersionModal extends Modal {
    constructor(view, id) {
        super(view.app);
        this.view = view;
        this.id = id;
    }

    async onOpen() {
        const { contentEl, view, id } = this;
        const index = id === null;
        const f = index ? view.file : view.cardFile(id);
        const node = !index && view.byId.get(id);
        const name = index ? 'The index' : `Card ${core.shortId(id)}` +
            (node && node.label ? ` (${node.label})` : '');
        const held = !index && view.held.has(id);
        this.titleEl.setText(held ?
            `${name} changed while you were typing in it` :
            `${name} changed to an older copy`);
        const now = f ? await view.app.vault.cachedRead(f) : '';
        const before = await view.newerText(id);
        const info = view.versionInfo.get(index ? 'index' : id);
        const at = view.revertedAt.get(index ? 'index' : id);
        const when = at ? ` at ${new Date(at).toLocaleString()}` : '';
        const p = (text) => contentEl.createEl('p', { text });
        if (index && view.dropped.size) {
            const n = view.dropped.size;
            const names = [...view.dropped].map(([k, label]) =>
                core.shortId(k) + (label ? ` (${label})` : '')).join(', ');
            p(`It changed outside Dendrite${when} and no longer lists ` +
              `${n} card${n === 1 ? '' : 's'} whose notes still exist: ` +
              `${names}.`);
        } else if (held) {
            p(`It changed outside Dendrite${when}, usually from a sync, ` +
              'while you had typing in it not yet saved. The text from ' +
              'before is the card with your typing. Nothing has been ' +
              'written, and export waits until you choose.');
        } else {
            p(`It changed outside Dendrite${when} to text this device ` +
              'had before.');
        }
        const from = (x) => x.outside ? 'came from outside Dendrite' :
            'was written on this device';
        const stamp = (x) => new Date(x.at).toLocaleString();
        if (!held && info && info.before &&
            info.before.outside !== undefined) {
            p(`The text from before ${from(info.before)}, last at ` +
              `${stamp(info.before)}.` + (info.before.outside ?
              ' It can itself be the damaged or stale copy.' : ''));
        }
        if (!held && info && info.now && info.now.outside !== undefined) {
            p(`The note now matches text this device had at ` +
              `${stamp(info.now)}, which ${from(info.now)}.`);
        }
        if (!held) p('Usually a device with an old copy synced it, sometimes ' +
          'merged line by line with the current one. Restoring a backup ' +
          'yourself looks the same. Nothing has been written, and export ' +
          'waits until you choose.');
        if (before === null) {
            p('No earlier text is recorded on this device, so there is ' +
              'nothing to compare or put back here.');
        } else {
            this.showDiff(now, before);
        }
        // One button per side, in the columns' order and colour, neither
        // offered as the default; deciding later below, uncoloured.
        const choice = (into, label, desc, cls, fn) => {
            const cell = into.createDiv({ cls: 'dendrite-version-choice' });
            const b = cell.createEl('button', { cls, text: label });
            cell.createDiv({ cls: 'dendrite-version-desc', text: desc });
            b.onclick = async () => {
                this.close();
                await fn();
            };
        };
        const sides = contentEl.createDiv(
            { cls: 'dendrite-version-choices' });
        choice(sides, 'Keep the note now',
               'Clears this mark. Nothing is written.',
               'is-now', () => view.keepVersion(id));
        if (before !== null) {
            choice(sides, 'Put back the text from before',
                   'Writes it over the note. Ctrl+Z on the board undoes it.',
                   'is-before', () => view.restoreNewer(id));
        }
        choice(contentEl, 'Decide later',
               'Closes this. The mark stays, and export waits.',
               '', async () => {});
    }

    /**
     * The lines that differ, with one line of context around each run,
     * unified or side by side; the choice holds while Obsidian runs.
     */
    showDiff(now, before) {
        const rows = core.lineDiff(now, before);
        const bar = this.contentEl.createDiv(
            { cls: 'dendrite-version-modes' });
        const box = this.contentEl.createDiv();
        const modes = [['unified', 'Unified', 'rows-2'],
                       ['split', 'Side by side', 'columns-2']];
        const draw = () => {
            const split = VersionModal.mode === 'split';
            for (const b of bar.children) {
                b.toggleClass('is-active', b.dataset.mode ===
                              VersionModal.mode);
            }
            if (this.modalEl) this.modalEl.toggleClass('dendrite-wide', split);
            box.empty();
            if (!rows.some((r) => r[0] !== ' ')) {
                box.createEl('p', { text: 'The two texts are the same.' });
            } else if (split) {
                this.drawSplit(box, rows);
            } else {
                this.drawUnified(box, rows);
            }
        };
        // Plain icons at the right, so they do not read as a choice.
        for (const [mode, label, icon] of modes) {
            const b = bar.createDiv({ cls: 'clickable-icon' });
            b.setAttr('aria-label', label);
            setIcon(b, icon);
            b.dataset.mode = mode;
            b.onclick = () => {
                VersionModal.mode = mode;
                draw();
            };
        }
        draw();
    }

    /** Whether each item is a change or next to one, to be shown. */
    static shown(changed) {
        return changed.map((c, i) => c || !!changed[i - 1] ||
                                     !!changed[i + 1]);
    }

    /**
     * Each run of changed lines paired in order, the first line only in
     * the note now with the first only in the text from before, and so
     * on. Returns, per row, its words marked by charDiff, or null.
     */
    static marks(rows) {
        const out = rows.map(() => null);
        for (let i = 0; i < rows.length;) {
            if (rows[i][0] === ' ') {
                i++;
                continue;
            }
            const gone = [];
            const back = [];
            for (; i < rows.length && rows[i][0] !== ' '; i++) {
                (rows[i][0] === '-' ? gone : back).push(i);
            }
            const n = Math.min(gone.length, back.length);
            for (let k = 0; k < n; k++) {
                const [a, b] = core.charDiff(rows[gone[k]][1],
                                             rows[back[k]][1]);
                out[gone[k]] = a;
                out[back[k]] = b;
            }
        }
        return out;
    }

    /**
     * A changed line's text, its changed words marked and any spaces in
     * them drawn, since a change in spaces alone would otherwise show as
     * nothing. A line of only spaces, or none, is marked whole.
     */
    static fillLine(el, line, marks) {
        if (!marks && !line.trim()) marks = [[line, true]];
        if (!marks) {
            el.createSpan({ text: line });
            return;
        }
        const shown = (t) => t.replace(/ /g, '·').replace(/\t/g, '→')
            .replace(/\r/g, '␍').replace(/\u00a0/g, '⍽');
        for (const [text, changed] of marks) {
            if (!changed) el.createSpan({ text });
            else el.createSpan({ cls: 'dendrite-version-change',
                                 text: shown(text) });
        }
        if (!line) {
            el.createSpan({ cls: 'dendrite-version-blank',
                            text: 'blank line' });
        }
    }

    drawUnified(box, rows) {
        const key = box.createEl('p', { cls: 'dendrite-version-desc' });
        key.createSpan({ cls: 'is-removed', text: '− the note now' });
        key.createSpan({ text: ' · ' });
        key.createSpan({ cls: 'is-added', text: '+ the text from before' });
        key.createSpan({ text: ', each line only in that one' });
        const pre = box.createDiv({ cls: 'dendrite-version-diff' });
        const keep = VersionModal.shown(rows.map((r) => r[0] !== ' '));
        const marks = VersionModal.marks(rows);
        let gap = false;
        let shown = 0;
        rows.forEach(([op, line], i) => {
            if (!keep[i]) {
                gap = true;
                return;
            }
            if (shown >= MAX_DIFF_ROWS) return;
            if (gap && shown) pre.createDiv({ text: '⋯' });
            gap = false;
            shown++;
            const cls = op === '+' ? 'is-added' : op === '-' ? 'is-removed'
                : '';
            const row = pre.createDiv({ cls });
            row.createSpan({ cls: 'dendrite-version-op',
                             text: op === '-' ? '−' : op });
            if (op === ' ') row.createSpan({ text: line });
            else VersionModal.fillLine(row.createSpan(), line, marks[i]);
        });
    }

    /**
     * Two columns, the note now and the text from before, a run of
     * changed lines paired row by row and the shorter side left blank.
     */
    drawSplit(box, rows) {
        // Each pair holds row indices, null for a blank side.
        const pairs = [];
        for (let i = 0; i < rows.length;) {
            if (rows[i][0] === ' ') {
                pairs.push([i, i, false]);
                i++;
                continue;
            }
            const gone = [];
            const back = [];
            for (; i < rows.length && rows[i][0] !== ' '; i++) {
                (rows[i][0] === '-' ? gone : back).push(i);
            }
            for (let k = 0; k < Math.max(gone.length, back.length); k++) {
                pairs.push([k < gone.length ? gone[k] : null,
                            k < back.length ? back[k] : null, true]);
            }
        }
        const marks = VersionModal.marks(rows);
        // Scrolled in a box, since a table takes no height limit.
        const table = box.createDiv({ cls: 'dendrite-version-diff' })
            .createEl('table', { cls: 'dendrite-version-split' });
        const head = table.createEl('tr');
        head.createEl('th', { cls: 'is-removed', text: 'The note now' });
        head.createEl('th', { cls: 'is-added',
                              text: 'The text from before' });
        const keep = VersionModal.shown(pairs.map((x) => x[2]));
        let gap = false;
        let shown = 0;
        pairs.forEach(([left, right, changed], i) => {
            if (!keep[i]) {
                gap = true;
                return;
            }
            if (shown >= MAX_DIFF_ROWS) return;
            if (gap && shown) {
                const tr = table.createEl('tr');
                tr.createEl('td', { text: '⋯' });
                tr.createEl('td', { text: '⋯' });
            }
            gap = false;
            shown++;
            const tr = table.createEl('tr');
            const cell = (r, cls) => {
                if (r === null) {
                    tr.createEl('td', { cls: 'is-blank' });
                } else if (!changed) {
                    tr.createEl('td', { text: rows[r][1] });
                } else {
                    VersionModal.fillLine(tr.createEl('td', { cls }),
                                          rows[r][1], marks[r]);
                }
            };
            cell(left, 'is-removed');
            cell(right, 'is-added');
        });
    }

    onClose() { this.contentEl.empty(); }
}
// Unified until a viewer picks side by side.
VersionModal.mode = 'unified';

class CardModal extends Modal {
    constructor(view, id) {
        super(view.app);
        this.view = view;
        this.id = id;
    }

    onOpen() {
        const { contentEl } = this;
        const view = this.view;
        const fm = view.cardProps(this.id);
        const aliases = Array.isArray(fm.aliases) ? fm.aliases :
            (fm.aliases ? [fm.aliases] : []);
        const draft = {};
        this.titleEl.setText('Card properties');
        new Setting(contentEl).setName('Label')
            .setDesc('Shown in the index when the card does not open with ' +
                     'a heading. Stored as the card\'s first alias.')
            .addText((t) => t.setValue(aliases[0] || '')
                .onChange((v) => {
                    const rest = aliases.slice(1);
                    draft.aliases = v.trim() ? [v.trim(), ...rest] :
                        (rest.length ? rest : null);
                }));
        quotaSetting(contentEl, 'Quota',
            'For this card and everything under it, counted from what ' +
            'export would write. Quotas on cards below are allocations ' +
            'from it.', core.parseLimit(fm.dendrite_limit),
            fm.dendrite_limit_required === true, draft);
        new Setting(contentEl).addButton((b) => b.setButtonText('Save')
            .setCta().onClick(async () => {
                const f = view.cardFile(this.id);
                if (f) await writeProps(view.app, f, draft);
                this.close();
            }));
    }

    onClose() { this.contentEl.empty(); }
}

/** Set or remove properties through Obsidian's own frontmatter writer. */
/**
 * Add a value to a note's type property, kept as a list, leaving any
 * values already there; nothing is written if it is present.
 */
async function addType(app, file, value) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    const has = (v) => (Array.isArray(v) ? v : (v ? [v] : []))
        .some((x) => String(x).trim() === value);
    if (fm && has(fm.type)) return;
    await app.fileManager.processFrontMatter(file, (front) => {
        const list = Array.isArray(front.type) ? front.type :
            (front.type ? [front.type] : []);
        if (!list.some((x) => String(x).trim() === value)) list.push(value);
        front.type = list;
    });
}

async function writeProps(app, file, draft) {
    if (!Object.keys(draft).length) return;
    await app.fileManager.processFrontMatter(file, (fm) => {
        for (const [k, v] of Object.entries(draft)) {
            if (v === null || v === undefined) delete fm[k];
            else fm[k] = v;
        }
    });
}

class NewManuscriptModal extends Modal {
    constructor(plugin) {
        super(plugin.app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        this.titleEl.setText('New Dendrite manuscript');
        let title = '';
        let prefix = '';
        new Setting(contentEl).setName('Title')
            .setDesc('Names the folder and the index note.')
            .addText((t) => t.setPlaceholder('Grant application 2026')
                .onChange((v) => { title = v; }));
        new Setting(contentEl).setName('Prefix')
            .setDesc('Starts every card ID, such as GRANT-2026. ' +
                     'Letters, digits and hyphens; unique in the vault.')
            .addText((t) => t.setPlaceholder('GRANT-2026')
                .onChange((v) => { prefix = v.trim(); }));
        new Setting(contentEl).addButton((b) => b.setButtonText('Create')
            .setCta().onClick(async () => {
                const err = this.plugin.checkNew(title, prefix);
                if (err) {
                    new Notice('Dendrite: ' + err);
                    return;
                }
                this.close();
                await this.plugin.createManuscript(safeName(title), prefix);
            }));
    }

    onClose() { this.contentEl.empty(); }
}

class DendriteSettings extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    // Linter's ignore list follows the writing folder once the settings
    // are closed, not on every keystroke while the folder is typed.
    hide() {
        this.plugin.syncLinter();
    }

    display() {
        const { containerEl } = this;
        const s = this.plugin.settings;
        containerEl.empty();
        const save = () => this.plugin.saveSettings();
        const heading = (name) => new Setting(containerEl).setName(name)
            .setHeading();

        heading('Manuscripts');
        new Setting(containerEl).setName('Writing folder')
            .setDesc('Where new manuscripts are created, one folder each.')
            .addText((t) => t.setValue(s.writingFolder).onChange((v) => {
                s.writingFolder = v.trim();
                save();
            }));
        new Setting(containerEl).setName('Open index notes in Dendrite')
            .setDesc('Opening an index note shows it in Dendrite. Its ' +
                     'markdown stays one button away in the view.')
            .addToggle((tg) => tg.setValue(s.openInDendrite)
                .onChange((v) => {
                    s.openInDendrite = v;
                    save();
                }));
        new Setting(containerEl).setName('Index note type')
            .setDesc('Added to each index note\'s type property, so file ' +
                     'lists and colour rules can mark manuscripts. Empty ' +
                     'adds none.')
            .addText((t) => t.setValue(s.indexType).onChange((v) => {
                s.indexType = v.trim();
                save();
            }));
        new Setting(containerEl).setName('Card type')
            .setDesc('Added to each card\'s type property. Plain text ' +
                     'rather than a link keeps cards out of the vault\'s ' +
                     'links. Empty adds none.')
            .addText((t) => t.setValue(s.cardType).onChange((v) => {
                s.cardType = v.trim();
                save();
            }));
        new Setting(containerEl).setName('Top section heading level')
            .setDesc('Export writes a top-level section card as this ' +
                     'heading level, deeper sections one level down each. ' +
                     'A manuscript can set its own in its Settings.')
            .addDropdown((d) => {
                for (let i = 1; i <= 4; i++) d.addOption(String(i), 'H' + i);
                d.setValue(String(s.headingTop)).onChange((v) => {
                    s.headingTop = Number(v);
                    save();
                });
            });

        heading('Board');
        new Setting(containerEl).setName('Card width')
            .setDesc('In pixels.')
            .addSlider((sl) => sl.setLimits(260, 640, 20)
                .setValue(s.cardWidth).setDynamicTooltip()
                .onChange((v) => {
                    s.cardWidth = v;
                    save();
                    this.plugin.rerender();
                }));
        new Setting(containerEl).setName('Vim-style keys')
            .setDesc('In normal mode: h j k l to move, i or a to edit, o ' +
                     'and O for a new card below or above, n for a child, ' +
                     'J and K to move a card, > and < to indent, dd to ' +
                     'delete, u to undo, gg and G for the column\'s ends. ' +
                     'Arrows, + - ] and [ work either way.')
            .addToggle((tg) => tg.setValue(s.vimKeys).onChange((v) => {
                s.vimKeys = v;
                save();
            }));

        heading('Writing in cards');
        new Setting(containerEl).setName('Use Obsidian\'s editor in cards')
            .setDesc('Live preview, link and citation suggestions, and ' +
                     'editor commands inside a card. Off, or if Obsidian\'s ' +
                     'editor cannot start, cards use a plain text box.')
            .addToggle((tg) => tg.setValue(s.obsidianEditor)
                .onChange((v) => {
                    s.obsidianEditor = v;
                    save();
                }));
        new Setting(containerEl).setName('Typewriter scrolling')
            .setDesc('As you type in a card, the line with the cursor ' +
                     'moves to the middle of the column. Clicking and ' +
                     'selecting never move it. Off, the column moves only ' +
                     'enough to keep the cursor in view.')
            .addToggle((tg) => tg.setValue(s.typewriter).onChange((v) => {
                s.typewriter = v;
                save();
            }));
        new Setting(containerEl).setName('Autosave delay')
            .setDesc('Milliseconds after the last keystroke before a card ' +
                     'is written to its note. Leaving a card always saves ' +
                     'at once.')
            .addSlider((sl) => sl.setLimits(200, 3000, 100)
                .setValue(s.autosaveMs).setDynamicTooltip()
                .onChange((v) => {
                    s.autosaveMs = v;
                    save();
                }));

        heading('PDF and Word export');
        new Setting(containerEl).setName('Pandoc')
            .setDesc('The pandoc command, or its full path.')
            .addText((t) => t.setValue(s.pandocPath).onChange((v) => {
                s.pandocPath = v.trim() || 'pandoc';
                save();
            }));
        new Setting(containerEl).setName('PDF engine')
            .setDesc('The LaTeX engine Pandoc uses for PDF, or its full ' +
                     'path. TeX Live\'s usual folders are searched.')
            .addText((t) => t.setValue(s.pdfEngine).onChange((v) => {
                s.pdfEngine = v.trim() || 'xelatex';
                save();
            }));
        new Setting(containerEl).setName('Zotero port')
            .setDesc('Where Better BibTeX answers on this computer.')
            .addText((t) => t.setValue(String(s.zoteroPort))
                .onChange((v) => {
                    s.zoteroPort = Number(v) > 0 ? Number(v) : 23119;
                    save();
                }));
        new Setting(containerEl).setName('Fallback .bib')
            .setDesc('Used when Zotero is not running. A full path on this ' +
                     'computer, such as a Better BibTeX auto-export; empty ' +
                     'stops the export instead.')
            .addText((t) => t.setValue(s.fallbackBib).onChange((v) => {
                s.fallbackBib = v.trim();
                save();
            }));

        heading('Other plugins');
        new Setting(containerEl).setName('Keep Linter out of the writing ' +
                                         'folder')
            .setDesc('Adds the writing folder to the Linter plugin\'s ' +
                     'folders to ignore, so its rules never rewrite a ' +
                     'card. Off removes the entry, if Dendrite added it.')
            .addToggle((tg) => tg.setValue(s.manageLinter).onChange((v) => {
                s.manageLinter = v;
                save();
            }));
        new Setting(containerEl).setName('Clean up cards with Linter')
            .setDesc('When you leave a card you changed, run the Linter ' +
                     'plugin\'s rules on it, except those that break ' +
                     'cards: "File name heading" and "Capitalize ' +
                     'headings".')
            .addToggle((tg) => tg.setValue(s.lintCards).onChange((v) => {
                s.lintCards = v;
                save();
            }));
    }
}

module.exports = class DendritePlugin extends Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULTS, await this.loadData());
        // Versions per device, outside the vault and data.json, which
        // sync plugins copy.
        this.history = new History(idbStore());
        this.registerView(VIEW, (leaf) => new DendriteView(leaf, this));
        this.registerView(PREVIEW, (leaf) => new DendritePreview(leaf, this));
        this.addCommand({
            id: 'open-preview',
            name: 'Open the manuscript preview',
            checkCallback: (checking) => {
                const v = this.app.workspace.getActiveViewOfType(
                    DendriteView);
                const f = v ? v.file : this.app.workspace.getActiveFile();
                if (!f || !isIndex(this.app, f)) return false;
                if (!checking) this.openPreview(f);
                return true;
            },
        });
        this.addSettingTab(new DendriteSettings(this.app, this));
        this.addRibbonIcon('list-tree', 'Open in Dendrite', () => {
            const f = this.app.workspace.getActiveFile();
            if (f && isIndex(this.app, f)) this.openIndex(f);
            else new NewManuscriptModal(this).open();
        });
        this.addCommand({
            id: 'open-index',
            name: 'Open the current index note in Dendrite',
            checkCallback: (checking) => {
                const f = this.app.workspace.getActiveFile();
                if (!f || !isIndex(this.app, f)) return false;
                if (!checking) this.openIndex(f);
                return true;
            },
        });
        this.addCommand({
            id: 'new-manuscript',
            name: 'New manuscript',
            callback: () => new NewManuscriptModal(this).open(),
        });
        // Leaves where markdown was asked for explicitly, by path, so an
        // index opened "as markdown" is not switched back to Dendrite.
        this.markdownLeaves = new WeakMap();
        this.registerEvent(this.app.workspace.on('file-open',
            (f) => this.onFileOpen(f)));
        this.registerEvent(this.app.workspace.on('active-leaf-change',
            (leaf) => this.decorate(leaf)));
        this.app.workspace.onLayoutReady(() => {
            this.app.workspace.iterateAllLeaves((l) => this.decorate(l));
            this.syncLinter();
        });
        const viewCommand = (id, name, needsEdit, run) => this.addCommand({
            id, name,
            checkCallback: (checking) => {
                const v = this.app.workspace.getActiveViewOfType(
                    DendriteView);
                if (!v || (needsEdit ? !v.editing : !v.active)) return false;
                if (!checking) run(v);
                return true;
            },
        });
        viewCommand('move-to-card-below',
            'Move selection, or the rest of the card, to a new card below',
            true, (v) => v.moveSelection('below'));
        viewCommand('move-to-child-card',
            'Move selection, or the rest of the card, to a new child card',
            true, (v) => v.moveSelection('child'));
        viewCommand('next-flagged', 'Go to the next card to revise or ' +
            'finish splitting', false, (v) => v.nextFlagged(1));
        viewCommand('previous-flagged', 'Go to the previous card to ' +
            'revise or finish splitting', false, (v) => v.nextFlagged(-1));
        viewCommand('next-draft', 'Go to the next draft card', false,
            (v) => v.nextFlagged(1, (i) => i.prints && i.own === 'draft'));
        viewCommand('add-types', 'Add the type property to the index ' +
            'and every card', false, (v) => v.sweepTypes());
        viewCommand('merge-into-above', 'Merge card into the card above',
            false, (v) => v.merge('above'));
        viewCommand('merge-into-parent', 'Merge card into its parent',
            false, (v) => v.merge('parent'));
        // The same moves in the editor's own right-click menu, beside cut
        // and copy, when the editor is a card's.
        this.registerEvent(this.app.workspace.on('editor-menu',
            (menu, editor, info) => {
                const v = this.app.workspace.getLeavesOfType(VIEW)
                    .map((l) => l.view)
                    .find((x) => x.editing && info &&
                          info.file === x.editing.file);
                if (!v) return;
                const sel = editor.somethingSelected();
                const what = sel ? 'selection' : 'rest of the card';
                menu.addSeparator();
                menu.addItem((i) => i.setTitle(`Move ${what} to a new card ` +
                                               'below').setIcon('arrow-down')
                    .onClick(() => v.moveSelection('below')));
                menu.addItem((i) => i.setTitle(`Move ${what} to a new ` +
                                               'child card')
                    .setIcon('corner-down-right')
                    .onClick(() => v.moveSelection('child')));
            }));
        this.registerEvent(this.app.workspace.on('file-menu', (menu, f) => {
            if (!isIndex(this.app, f)) return;
            menu.addItem((i) => i.setTitle('Open in Dendrite')
                .setIcon('list-tree').onClick(() => this.openIndex(f)));
        }));
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    linter() {
        const p = this.app.plugins && this.app.plugins.plugins;
        return (p && p[LINTER_ID]) || null;
    }

    /**
     * Run Linter's clean-up on one card, as its lint on save would, with
     * the rules that break cards switched off for that run only. Linter's
     * own triggers skip the writing folder, so this is the only way a
     * card is linted. It calls Linter's runLinterFile, which is not public
     * API: if a Linter update removes it, cards are left unlinted.
     */
    async lintCard(file) {
        const linter = this.linter();
        if (!this.settings.lintCards || !linter) return;
        if (linter.isEnabled === false) return;
        if (typeof linter.runLinterFile !== 'function') return;
        if (!linter.settings || !linter.settings.ruleConfigs) return;
        const original = linter.settings;
        const rules = Object.assign({}, original.ruleConfigs);
        for (const id of CARD_UNSAFE_RULES) {
            if (rules[id]) rules[id] = Object.assign({}, rules[id],
                                                     { enabled: false });
        }
        linter.settings = Object.assign({}, original, { ruleConfigs: rules });
        try {
            await linter.runLinterFile(file);
        } catch (err) {
            console.error('Dendrite: Linter clean-up failed', err);
        } finally {
            linter.settings = original;
        }
    }

    /**
     * Keep the writing folder in Linter's folders to ignore, so Linter's
     * rules, "File name heading" above all, never rewrite a card. Only an
     * entry Dendrite added is ever removed, and Linter's own settings
     * object is changed, so the change applies without a reload.
     */
    async syncLinter() {
        const linter = this.linter();
        const ls = linter && linter.settings;
        if (!ls || !Array.isArray(ls.foldersToIgnore)) return;
        const want = this.settings.manageLinter ?
            normalizePath(this.settings.writingFolder) : null;
        const list = ls.foldersToIgnore;
        const had = this.settings.linterAdded;
        let changed = false;
        if (had && had !== want && list.includes(had)) {
            list.splice(list.indexOf(had), 1);
            changed = true;
        }
        let added = had === want ? had : null;
        if (want && !list.includes(want)) {
            list.push(want);
            added = want;
            changed = true;
            new Notice(`Dendrite added ${want} to Linter's folders to ` +
                       'ignore, so Linter does not rewrite cards. This is ' +
                       'a setting in Dendrite.');
        }
        if (changed) {
            if (typeof linter.saveSettings === 'function') {
                await linter.saveSettings();
            } else {
                await linter.saveData(ls);
            }
        }
        if (added !== this.settings.linterAdded) {
            this.settings.linterAdded = added;
            await this.saveSettings();
        }
    }

    rerender() {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) {
            leaf.view.render();
        }
    }

    async openIndex(file, card = null, leaf = null) {
        const target = leaf || this.app.workspace.getLeaf('tab');
        await target.setViewState({ type: VIEW, active: true,
                                    state: { file: file.path, card } });
        this.app.workspace.revealLeaf(target);
    }

    /** Node's file and process access, for Pandoc export on the desktop. */
    pandocDeps() {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const { execFile } = require('child_process');
        return {
            tmpdir: os.tmpdir,
            join: path.join,
            writeFile: (f, t) => fs.promises.writeFile(f, t),
            readFile: (f) => fs.promises.readFile(f),
            inflate: (b) => require('zlib').inflateSync(b),
            remove: (f) => {
                try { fs.unlinkSync(f); } catch (e) { /* already gone */ }
            },
            run: (cmd, args) => new Promise((res, rej) => execFile(cmd, args,
                { timeout: 180000, env: this.pandocEnv() },
                (err, out, stderr) => (err ?
                    rej(Object.assign(err, { stderr })) : res()))),
            // Through Node rather than the page or Obsidian: Zotero drops,
            // unanswered, a request with a browser's User-Agent or an
            // Origin, which both of those send, so either fails as if
            // Zotero were closed. Node's http sends neither.
            fetch: (url, init) => nodeRequest(url, init),
        };
    }

    /**
     * The search path Pandoc runs with: Obsidian's own plus the usual
     * install folders for Pandoc and TeX, since an app started from the
     * desktop does not read the shell profile that adds them.
     */
    pandocEnv() {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const proc = globalThis.process;
        const extra = [];
        if (proc.platform === 'win32') {
            const local = proc.env.LOCALAPPDATA;
            const prog = proc.env.ProgramFiles || 'C:\\Program Files';
            if (local) {
                extra.push(path.join(local, 'Pandoc'),
                           path.join(local, 'Programs', 'MiKTeX', 'miktex',
                                     'bin', 'x64'));
            }
            extra.push(path.join(prog, 'Pandoc'),
                       path.join(prog, 'MiKTeX', 'miktex', 'bin', 'x64'));
            return pandoc.searchPath(proc.env, proc.platform, extra);
        }
        for (const root of ['/usr/local/texlive', '/opt/texlive']) {
            let years = [];
            try {
                years = fs.readdirSync(root).sort().reverse();
            } catch (e) {
                continue;
            }
            for (const y of years) {
                const bin = path.join(root, y, 'bin');
                let arches = [];
                try { arches = fs.readdirSync(bin); } catch (e) { continue; }
                for (const a of arches) extra.push(path.join(bin, a));
            }
        }
        extra.push('/Library/TeX/texbin', '/usr/local/bin',
                   '/opt/homebrew/bin', '/usr/bin',
                   path.join(os.homedir(), '.local', 'bin'));
        let names = [];
        try { names = fs.readdirSync(os.homedir()).sort(); } catch (e) { }
        extra.push(...pandoc.condaBins(names, os.homedir()));
        return pandoc.searchPath(proc.env, proc.platform, extra);
    }

    /**
     * Show an export: a PDF in a pane beside the board, reusing the one
     * already showing it; a Word file in the system's default app.
     */
    async showExport(rel, full, format) {
        if (format !== 'pdf') {
            try {
                const { shell } = require('electron');
                await shell.openPath(full);
            } catch (e) { /* no desktop shell: the notice says where */ }
            return;
        }
        // The vault notices a file written outside its API a moment later.
        let file = null;
        for (let i = 0; i < 20 && !file; i++) {
            const f = this.app.vault.getAbstractFileByPath(rel);
            if (f instanceof TFile) file = f;
            else await new Promise((r) => setTimeout(r, 150));
        }
        if (!file) return;
        await this.app.workspace.revealLeaf(
            await this.exportLeaf(file), { focus: false });
    }

    /**
     * Where an exported PDF opens, without taking room from the board: a
     * tab already showing an export from the same folder, else a new tab
     * beside the manuscript's preview, else, with no preview, a split.
     */
    async exportLeaf(file) {
        const ws = this.app.workspace;
        const dir = file.parent ? file.parent.path : '';
        const shown = ws.getLeavesOfType('pdf').find((l) => l.view.file &&
            (l.view.file.parent ? l.view.file.parent.path : '') === dir);
        if (shown) {
            await shown.openFile(file, { active: false });
            return shown;
        }
        // The manuscript's index sits beside its exports folder.
        const home = dir.replace(/\/?exports$/, '');
        const previews = ws.getLeavesOfType(PREVIEW);
        const preview = previews.find((l) => l.view.file &&
            (l.view.file.parent ? l.view.file.parent.path : '') === home) ||
            previews[0];
        let leaf;
        if (preview && preview.parent && ws.createLeafInParent) {
            const at = preview.parent.children ?
                preview.parent.children.indexOf(preview) + 1 : 0;
            leaf = ws.createLeafInParent(preview.parent, at);
        } else {
            leaf = ws.getLeaf('split', 'vertical');
        }
        await leaf.openFile(file, { active: false });
        return leaf;
    }

    /** The preview for a manuscript, opened beside the board or reused. */
    async openPreview(file) {
        const open = this.app.workspace.getLeavesOfType(PREVIEW)
            .find((l) => l.view.file === file);
        if (open) {
            this.app.workspace.revealLeaf(open);
            return;
        }
        const leaf = this.app.workspace.getLeaf('split', 'vertical');
        await leaf.setViewState({ type: PREVIEW, active: false,
                                  state: { file: file.path } });
    }

    /** From the preview: select a card on the board, or edit it. */
    async focusCard(file, id, edit) {
        const leaf = this.app.workspace.getLeavesOfType(VIEW)
            .find((l) => l.view.file === file);
        if (!leaf) {
            await this.openIndex(file, id);
            return;
        }
        this.app.workspace.revealLeaf(leaf);
        const view = leaf.view;
        if (edit) await view.startEdit(id);
        else await view.select(id);
    }

    /**
     * A status's colour, from Pretty Properties' colour for that value of
     * dendrite_status, so the Properties panel, Bases and the board agree.
     * Revise and unsplit fall back to orange; other values stay plain
     * unless coloured there.
     */
    statusColour(status) {
        const pp = this.app.plugins && this.app.plugins.plugins &&
            this.app.plugins.plugins['pretty-properties'];
        const c = pp && pp.settings && pp.settings.propertyColors &&
            pp.settings.propertyColors.dendrite_status &&
            pp.settings.propertyColors.dendrite_status[status];
        const pill = c && c.pillColor;
        if (pill && typeof pill === 'object' && 'h' in pill) {
            return `hsl(${pill.h}, ${pill.s}%, ${pill.l}%)`;
        }
        if (pill && typeof pill === 'string' && pill !== 'default' &&
            pill !== 'none') {
            return pill.startsWith('#') ? pill : `var(--color-${pill})`;
        }
        return core.isFlag(status) ? 'var(--color-orange)' : null;
    }

    previewStatuses(file) {
        for (const l of this.app.workspace.getLeavesOfType(PREVIEW)) {
            if (l.view.file === file) l.view.scheduleRefresh();
        }
    }

    previewActive(file, id) {
        for (const l of this.app.workspace.getLeavesOfType(PREVIEW)) {
            if (l.view.file === file) l.view.highlight(id);
        }
    }

    async openAsMarkdown(file) {
        const leaf = this.app.workspace.getLeaf('tab');
        this.markdownLeaves.set(leaf, file.path);
        await leaf.openFile(file);
    }

    /** An index note opened as markdown switches to Dendrite. */
    onFileOpen(file) {
        if (!this.settings.openInDendrite || !file) return;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.file !== file || !isIndex(this.app, file)) return;
        if (this.markdownLeaves.get(view.leaf) === file.path) return;
        this.openIndex(file, null, view.leaf);
    }

    isCard(file) {
        return file instanceof TFile && file.extension === 'md' &&
            file.parent && file.parent.name === 'cards' &&
            CARD_NAME.test(file.basename);
    }

    /** The index note that links a card, found from Obsidian's links. */
    indexFor(card) {
        const links = this.app.metadataCache.resolvedLinks;
        for (const src of Object.keys(links)) {
            if (!links[src][card.path]) continue;
            const f = this.app.vault.getAbstractFileByPath(src);
            if (isIndex(this.app, f)) return f;
        }
        return null;
    }

    /**
     * Give a markdown view of an index or a card a header button back
     * into Dendrite, at that card when it is one.
     */
    decorate(leaf) {
        const view = leaf && leaf.view;
        if (!(view instanceof MarkdownView)) return;
        const file = view.file;
        const kind = isIndex(this.app, file) ? 'index' :
            (this.isCard(file) ? 'card' : null);
        if (view.dendriteAction) {
            if (view.dendriteAction.kind === kind &&
                view.dendriteAction.path === (file && file.path)) return;
            view.dendriteAction.el.remove();
            view.dendriteAction = null;
        }
        if (!kind) return;
        const el = view.addAction('list-tree',
            kind === 'index' ? 'Open in Dendrite' :
                'Open this card in Dendrite', () => {
                if (kind === 'index') {
                    this.markdownLeaves.delete(view.leaf);
                    this.openIndex(file, null, view.leaf);
                    return;
                }
                const index = this.indexFor(file);
                if (index) this.openIndex(index, file.basename, view.leaf);
                else new Notice('Dendrite: no index note links this card.');
            });
        view.dendriteAction = { el, kind, path: file.path };
    }

    prefixesInUse() {
        const out = new Set();
        for (const f of this.app.vault.getMarkdownFiles()) {
            const p = prefixOf(this.app, f);
            if (p) out.add(p.toLowerCase());
        }
        return out;
    }

    checkNew(title, prefix) {
        if (!safeName(title)) return 'give the manuscript a title.';
        if (!core.validPrefix(prefix)) {
            return 'a prefix is letters, digits and single hyphens.';
        }
        if (this.prefixesInUse().has(prefix.toLowerCase())) {
            return `the prefix ${prefix} is already used by another ` +
                'manuscript.';
        }
        const dir = normalizePath(`${this.settings.writingFolder}/` +
                                  safeName(title));
        if (this.app.vault.getAbstractFileByPath(dir)) {
            return `${dir} already exists.`;
        }
        return null;
    }

    async createManuscript(title, prefix) {
        const vault = this.app.vault;
        const dir = normalizePath(`${this.settings.writingFolder}/${title}`);
        for (const p of [this.settings.writingFolder, dir, `${dir}/cards`]) {
            const np = normalizePath(p);
            if (np && !vault.getAbstractFileByPath(np)) {
                await vault.createFolder(np);
            }
        }
        const index = await vault.create(normalizePath(`${dir}/${title}.md`),
            `---\ndendrite_prefix: ${prefix}\n---\n`);
        if (this.settings.indexType) {
            await addType(this.app, index, this.settings.indexType);
        }
        // The view reads the prefix from the metadata cache, which parses
        // the new note asynchronously.
        await new Promise((r) => {
            const ref = this.app.metadataCache.on('changed', (f) => {
                if (f === index) {
                    this.app.metadataCache.offref(ref);
                    r();
                }
            });
            setTimeout(r, 1500);
        });
        await this.openIndex(index);
    }
};

module.exports.core = core;
// Exported for the view tests in test/view.test.mjs.
module.exports.DendriteView = DendriteView;
module.exports.DendritePreview = DendritePreview;
module.exports.DendriteSettings = DendriteSettings;
module.exports.exportStyle = exportStyle;
