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

const VIEW = 'dendrite-view';
const PREVIEW = 'dendrite-preview';
const DEFAULTS = {
    writingFolder: 'Writing',
    headingTop: 1,
    cardWidth: 380,
    autosaveMs: 600,
    openInDendrite: true,
    vimKeys: true,
    manageLinter: true,
    lintCards: true,
    obsidianEditor: true,
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
        this.selfWrites = new Set();
        this.reloadTimer = null;
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
            else if (f instanceof TFile && this.byId.has(f.basename)) {
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
        // Backfill: a printing card with no status is given draft, so
        // every card says what it is; the index and every card get their
        // type.
        await this.sweepStatuses();
        await this.sweepTypes();
    }

    /** Add the index's and every card's type value, where missing. */
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
        this.drawBoard();
        if (keep && this.editing === ed && ed.editor.el.isConnected) {
            ed.editor.focusAt(keep[0], keep[1]);
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
            if (e.target !== board) this.scheduleFlow();
        }, true);
        if (!this.nativeScroll) {
            board.addEventListener('wheel', (e) => this.onWheel(e),
                                   { passive: false });
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
        this.updateNumbers();
        this.updateRoles();
        this.updateStatuses();
        this.updateCounts();
    }

    renderBar(el) {
        // Everything sits at the left: the right edge of a pane is where
        // other plugins' overlays, such as LiveSync's status, are drawn.
        const bar = el.createDiv({ cls: 'dendrite-bar' });
        this.modeEl = bar.createDiv({ cls: 'dendrite-mode' });
        this.showMode();
        bar.createDiv({ cls: 'dendrite-title', text: this.file.basename });
        const btn = (icon, label, title, fn) => {
            const b = bar.createEl('button', { cls: 'dendrite-bar-btn' });
            setIcon(b.createSpan({ cls: 'dendrite-bar-icon' }), icon);
            b.createSpan({ text: label });
            b.setAttr('aria-label', title);
            b.onclick = fn;
        };
        btn('file-output', 'Export', 'Export the manuscript to markdown, ' +
            'PDF or Word', (e) => this.exportMenu(null, e));
        btn('undo-2', 'Undo', 'Undo the last structural change (Ctrl+Z)',
            () => this.doUndo());
        btn('file-text', 'Index', 'Open the index note as markdown',
            () => this.plugin.openAsMarkdown(this.file));
        btn('settings', 'Settings', 'This manuscript\'s settings',
            () => new ManuscriptModal(this).open());
        btn('scroll-text', 'Preview', 'Show what export would print, ' +
            'beside the board', () => this.plugin.openPreview(this.file));
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
        // The handle a card is dragged by, so a press on its text still
        // selects text.
        const grip = card.createDiv({ cls: 'dendrite-grip' });
        setIcon(grip, 'grip-vertical');
        grip.setAttr('aria-label', 'Drag to move this card and its branch');
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
            // the centre if the card is on the active card's lineage.
            if (this.lineage && this.lineage.has(id)) this.centre(false);
            this.scheduleFlow();
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
    centre(smooth = true) {
        if (!this.board) return;
        const node = this.active && this.byId.get(this.active);
        if (!node) return;
        const behavior = smooth ? 'smooth' : 'auto';
        const cols = this.board.querySelectorAll('.dendrite-col');
        const pos = (id) => {
            const el = this.cardEls.get(id);
            return el ? { top: el.offsetTop, height: el.offsetHeight } : null;
        };
        const heights = [...cols].map((c) => c.clientHeight);
        const targets = core.alignColumns(this.cols, node, pos, heights);
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
        const start = performance.now();
        const DURATION = 220;
        const step = (now) => {
            const k = Math.min(1, (now - start) / DURATION);
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
        const unit = e.deltaMode === 1 ? 16 :
            (e.deltaMode === 2 ? col.clientHeight : 1);
        this.setColOffset(d, this.colOffset(d) + e.deltaY * unit);
        this.drawFlow();
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
        m.addSeparator();
        // What this card prints: automatic follows its place in the tree.
        const id = this.active;
        const role = this.roleOf(id);
        const node = this.byId.get(id);
        const auto = node && node.children.length ? 'heading only' :
            'full text';
        const info = this.statusInfo && this.statusInfo.get(id);
        if (info && info.prints) {
            m.addSeparator();
            for (const [value, title, icon] of [
                ['draft', 'Status: draft', 'pencil-line'],
                ['done', 'Status: done (+)', 'check'],
                ['revise', 'Status: revise (−)', 'flag'],
            ]) {
                m.addItem((i) => {
                    i.setTitle(title).setIcon(icon)
                        .onClick(() => this.setStatus(id, value));
                    if (typeof i.setChecked === 'function') {
                        i.setChecked(info.own === value);
                    }
                });
            }
        } else if (info && info.own === 'unsplit') {
            m.addSeparator();
            item('Keep the leftover text as notes', 'check',
                 () => this.setStatus(id, null));
        }
        m.addSeparator();
        for (const [value, title, icon] of [
            [null, `Prints automatically (${auto})`, 'wand'],
            ['section', 'Prints its heading only', 'heading'],
            ['prose', 'Prints its full text', 'text'],
            ['scaffolding', 'Scaffolding: prints its children only',
             'layers'],
            ['notes', 'Left out of the manuscript', 'eye-off'],
        ]) {
            m.addItem((i) => {
                i.setTitle(title).setIcon(icon)
                    .onClick(() => this.setRole(id, value));
                if (typeof i.setChecked === 'function') {
                    i.setChecked(role === value);
                }
            });
        }
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
        const link = e.target.closest('a.internal-link');
        if (link) {
            e.preventDefault();
            const href = link.getAttr('data-href') || link.getAttr('href');
            this.app.workspace.openLinkText(href, this.file.path,
                                            Keymap.isModEvent(e));
            return;
        }
        if (e.target.closest('.dendrite-toolbar, textarea, .dendrite-cm, ' +
                             'button, .dendrite-quota')) return;
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
        s.register([], 'Tab', () => this.editKey('indent'));
        s.register(['Shift'], 'Tab', () => this.editKey('outdent'));
        s.register([], 'Escape', () => {
            if (this.drag && this.drag.started) {
                this.cancelDrag();
                return false;
            }
            if (!this.editing) return true;
            this.endEdit();
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
        s.register(['Mod'], 'z', () => {
            if (this.editing) return true;
            this.doUndo();
            return false;
        });
    }

    // ---- dragging cards -------------------------------------------------

    onDragDown(e) {
        if (e.button !== 0 || e.pointerType === 'touch') return;
        if (!e.target.closest('.dendrite-grip')) return;
        const card = e.target.closest('.dendrite-card');
        if (!card) return;
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
        this.undo.push({ tree: before, active: id, files: [] });
        if (this.undo.length > UNDO_DEPTH) this.undo.shift();
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
        const ed = { id, file: f, dirty: false, timer: null,
                     saving: Promise.resolve() };
        const editor = cardEditor(this.app, this, {
            value: core.splitFrontmatter(raw).body,
            file: f,
            onChange: () => {
                ed.dirty = true;
                ed.changed = true;
                // A growing card stays centred while it is written in.
                this.centre(false);
                this.scheduleCounts();
                clearTimeout(ed.timer);
                ed.timer = setTimeout(() => this.save(ed),
                                      this.plugin.settings.autosaveMs);
            },
            onBlur: () => { this.save(ed); },
            onEscape: () => { this.endEdit(); },
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
    }

    /** Write the editor's text to its card, keeping the frontmatter. */
    save(ed) {
        clearTimeout(ed.timer);
        if (!ed.dirty) return ed.saving;
        ed.dirty = false;
        const text = ed.editor.value;
        ed.saving = ed.saving.then(() => this.app.vault.process(ed.file,
            (data) => core.splitFrontmatter(data).fm + text))
            .then(() => this.syncLabel(ed.id, text))
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
    }

    async endEdit() {
        const ed = this.editing;
        if (!ed) return;
        await this.save(ed);
        this.editing = null;
        ed.editor.destroy();
        if (ed.changed) await this.plugin.lintCard(ed.file);
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
        if (!this.plugin.settings.vimKeys) return;
        const prev = this.pendingKey;
        this.pendingKey = null;
        const k = e.key;
        const act = {
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

    async syncLabel(id, body) {
        const node = this.byId.get(id);
        if (!node) return;
        const f = this.cardFile(id);
        const fm = f && this.app.metadataCache.getFileCache(f)?.frontmatter;
        const label = core.deriveLabel(body, fm && fm.aliases);
        if (label !== node.label) {
            node.label = label;
            await this.writeIndex();
        }
    }

    // ---- structure -------------------------------------------------------

    snapshot(files = [], created = []) {
        this.undo.push({ tree: core.serialiseTree(this.root),
                         active: this.active, files, created });
        if (this.undo.length > UNDO_DEPTH) this.undo.shift();
    }

    async writeIndex() {
        const root = this.root;
        await this.app.vault.process(this.file, (data) => {
            const out = core.writeIndexText(data, root);
            // Remembered so the modify event this write causes is not
            // mistaken for an outside edit; capped in case an event never
            // arrives, as when the text did not change.
            this.selfWrites.add(out);
            if (this.selfWrites.size > 20) {
                this.selfWrites.delete(this.selfWrites.values().next().value);
            }
            return out;
        });
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
        const srcText = await this.app.vault.read(ed.file);
        // Read fresh, not from the board's last drawing: a status set a
        // moment ago may not have been drawn yet.
        const srcStatus = core.roleFor(node, (x) => this.roleOf(x)) ===
            'prose' ? this.statusOf(ed.id) : null;
        const id = core.newId(prefix, (x) => this.taken(x));
        const made = await this.createCardFile(id, cut.moved);
        // The moved text is as mature as it was where it came from.
        await writeProps(this.app, made, {
            dendrite_status: srcStatus || 'draft' });
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
        // A card that moved part of itself into a child and stopped
        // printing has a status only if text is left behind: unsplit,
        // until the split is finished or the rest is kept as notes.
        if (where === 'child' &&
            core.roleFor(node, (x) => this.roleOf(x)) !== 'prose') {
            await this.setStatus(ed.id,
                core.leftover(cut.keep) ? 'unsplit' : null);
        }
        this.undo.push({
            tree: before, active: ed.id, files: [],
            created: [{ path: made.path, body: cut.moved }],
            restores: [{ path: ed.file.path, body: original,
                         ifBody: cut.keep, text: srcText }],
        });
        if (this.undo.length > UNDO_DEPTH) this.undo.shift();
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
        await this.app.vault.process(dst,
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
        this.undo.push({
            tree: before, active: node.id,
            files: [{ path: src.path, data: srcText }], created: [],
            restores: [{ path: dst.path, body: dstBody, ifBody: merged,
                         text: dstText }],
        });
        if (this.undo.length > UNDO_DEPTH) this.undo.shift();
        await this.syncLabel(target.id, merged);
        // Merged text is only as mature as the less mature of the two.
        if (core.roleFor(target, (x) => this.roleOf(x)) === 'prose') {
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
        this.undo.push({ tree: before, active: this.active, files: [] });
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

    async doUndo() {
        const snap = this.undo.pop();
        if (!snap) {
            new Notice('Dendrite: nothing to undo.');
            return;
        }
        if (this.editing) await this.endEdit();
        for (const { path, data } of snap.files) {
            if (!this.app.vault.getAbstractFileByPath(path)) {
                await this.app.vault.create(path, data);
            }
        }
        // A card note the undone change created goes with it, but only
        // while it holds what the change put there: text written into it
        // since is never discarded.
        for (const entry of snap.created || []) {
            const path = typeof entry === 'string' ? entry : entry.path;
            const expect = typeof entry === 'string' ? '' : entry.body;
            const f = this.app.vault.getAbstractFileByPath(path);
            if (!(f instanceof TFile)) continue;
            const body = core.splitFrontmatter(
                await this.app.vault.read(f)).body;
            if (body.trim() === expect.trim()) {
                this.invalidate(f.basename);
                await this.app.fileManager.trashFile(f);
            }
        }
        // A card note the change rewrote gets its text back, if it still
        // holds what the change left in it.
        for (const r of snap.restores || []) {
            const f = this.app.vault.getAbstractFileByPath(r.path);
            if (!(f instanceof TFile)) continue;
            const body = core.splitFrontmatter(
                await this.app.vault.read(f)).body;
            if (body.trim() !== r.ifBody.trim()) continue;
            await this.app.vault.process(f, (data) => (r.text !== undefined ?
                r.text : core.splitFrontmatter(data).fm + r.body));
            this.invalidate(f.basename);
        }
        this.root = core.parseIndex(snap.tree + '\n').root;
        this.reindex();
        this.active = snap.active;
        await this.writeIndex();
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
            if (this.selfWrites.delete(text)) return;
            // A sync can write the text back unchanged, after Dendrite's
            // own event was consumed: nothing to reload.
            if (this.root && core.writeIndexText(text, this.root) === text) {
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
        if (this.editing && this.editing.id === id) return;
        this.invalidate(id);
        const card = this.cardEls.get(id);
        if (card) {
            card.addClass('is-pending');
            this.renderCard(id);
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
        this.clearFinishedSplit(f);
        // A label can come from aliases, which only the metadata cache
        // knows once parsed, so labels are synced here rather than on
        // modify.
        if (this.editing && this.editing.id === f.basename) return;
        const body = core.splitFrontmatter(
            await this.app.vault.cachedRead(f)).body;
        await this.syncLabel(f.basename, body);
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
        const wpp = Number(fm.dendrite_words_per_page);
        const cpw = Number(fm.dendrite_chars_per_word);
        return {
            prefix: this.prefix(),
            limit: core.parseLimit(fm.dendrite_limit),
            limitRequired: fm.dendrite_limit_required === true,
            charsPerWord: cpw > 0 ? cpw : 6,
            countSpaces: fm.dendrite_count_spaces !== false,
            wordsPerPage: wpp > 0 ? wpp : 500,
            headingTop: top >= 1 && top <= 6 ? top :
                this.plugin.settings.headingTop,
            number: fm.dendrite_number_sections === true,
            csl: typeof fm.dendrite_csl === 'string' &&
                fm.dendrite_csl.trim() ? fm.dendrite_csl.trim() : null,
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
                                   (id) => this.roleOf(id));
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
    async setStatus(id, status) {
        const f = this.cardFile(id);
        if (!f) return;
        if ((this.statusOf(id) || null) === (status || null)) return;
        await writeProps(this.app, f, { dendrite_status: status || null });
    }

    /**
     * Show each card's status in its footer and the counts in the bar.
     * A printing card shows its own status, a structural card the least
     * finished state below it and how many cards there are flagged.
     */
    updateStatuses() {
        if (!this.board) return;
        const report = core.statusReport(this.root,
            (id) => this.statusOf(id), (id) => this.roleOf(id));
        this.statusInfo = report.cards;
        for (const [id, card] of this.cardEls) {
            const foot = card.querySelector(':scope > .dendrite-card-foot');
            if (!foot) continue;
            const old = foot.querySelector(':scope > .dendrite-status');
            if (old) old.remove();
            card.removeClass('is-flagged');
            const info = report.cards.get(id);
            if (!info) continue;
            const chip = createDiv({ cls: 'dendrite-status' });
            const show = (status, text) => {
                const s = chip.createSpan({ cls: 'dendrite-status-chip ' +
                                                 `is-${status}`, text });
                const colour = this.plugin.statusColour(status);
                if (colour) s.style.setProperty('--dendrite-chip', colour);
            };
            if (info.own === 'done') show('done', '✓ done');
            else if (info.own === 'revise') show('revise', 'revise');
            else if (info.own === 'unsplit') show('unsplit', 'unsplit');
            if (!info.prints && info.below > 0) {
                show('revise', `${info.below} to revise`);
            } else if (!info.prints && info.derived === 'done' &&
                       !info.own) {
                show('done', '✓ done');
            }
            if (core.isFlag(info.own)) card.addClass('is-flagged');
            if (!chip.childElementCount) continue;
            const quota = foot.querySelector(':scope > .dendrite-quota');
            if (quota && quota.nextSibling) {
                foot.insertBefore(chip, quota.nextSibling);
            } else {
                foot.appendChild(chip);
            }
        }
        if (this.statusEl) {
            const t = report.tally;
            const parts = [];
            if (t.revise) parts.push(`${t.revise} revise`);
            if (t.unsplit) parts.push(`${t.unsplit} unsplit`);
            parts.push(`${t.draft} draft`, `${t.done} done`);
            this.statusEl.setText(parts.join(' · '));
            this.statusEl.toggleClass('has-flags', t.revise + t.unsplit > 0);
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
            const prints = core.roleFor(n, (id) => this.roleOf(id)) ===
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
        if (core.roleFor(node, (x) => this.roleOf(x)) !== 'prose') {
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
                if (core.roleFor(n, (x) => this.roleOf(x)) === 'notes') {
                    out = true;
                    break;
                }
            }
            card.toggleClass('is-left-out', out);
            card.toggleClass('is-heading-only',
                             this.roleOf(id) === 'section');
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
     * total. Over a required quota is an error, over a target a warning.
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
        const countOf = (nodes) => core.countText(
            core.exportMarkdown(nodes, bodyOf, 1, null,
                                (id) => this.roleOf(id)), ms.countSpaces);
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
        else tip.setText('No quota. Click to set one.');
        const a = anchor.getBoundingClientRect();
        tip.style.left = a.left + 'px';
        tip.style.top = (a.top - 6) + 'px';
        this.quotaTip = tip;
        this.pageWin().requestAnimationFrame(() => tip.addClass('is-shown'));
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
        label.createSpan({ text: 'required by the call' });
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
        used.createSpan({ cls: 'dendrite-quota-kind', text: kind });
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
        const text = core.exportMarkdown(scope, (id) => bodies.get(id),
                                         ms.headingTop, this.numbers(),
                                         (id) => this.roleOf(id));
        const dir = normalizePath(
            (this.file.parent.path === '/' ? '' :
                this.file.parent.path + '/') + 'exports');
        if (!this.app.vault.getAbstractFileByPath(dir)) {
            await this.app.vault.createFolder(dir);
        }
        const name = safeName(this.file.basename +
            (node ? ' - ' + (node.label || node.id) : ''));
        if (format !== 'md') {
            await this.exportPandoc(text, format, dir, name, ms);
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

    async exportPandoc(text, format, dir, name, ms) {
        const s = this.plugin.settings;
        const base = this.app.vault.adapter.getBasePath ?
            this.app.vault.adapter.getBasePath() : '';
        const nodePath = require('path');
        const rel = normalizePath(`${dir}/${name}.${format}`);
        const output = nodePath.join(base, rel);
        const csl = ms.csl ? nodePath.join(base, ms.csl) : null;
        const notice = new Notice('Dendrite: exporting to ' +
            (format === 'pdf' ? 'PDF' : 'Word') + '…', 0);
        const result = await pandoc.exportDocument({
            md: text, format, output, csl,
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
                 showLeft: this.showLeft };
    }

    async setState(state, result) {
        const f = state && state.file &&
            this.app.vault.getAbstractFileByPath(state.file);
        this.showLeft = !!(state && state.showLeft);
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
            if (b && this.file) this.plugin.focusCard(this.file,
                                                      b.dataset.id, false);
        });
        this.registerDomEvent(this.contentEl, 'dblclick', (e) => {
            const b = e.target.closest('.dendrite-pblock');
            if (b && this.file) this.plugin.focusCard(this.file,
                                                      b.dataset.id, true);
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
        const roleOf = (id) => {
            const r = props(id).dendrite_role;
            return core.ROLES.includes(r) ? r : null;
        };
        const hasHeading = (id) => {
            const f = this.cardFile(id);
            const s = f && this.app.metadataCache.getFileCache(f)?.sections;
            const first = (s || []).find((x) => x.type !== 'yaml');
            return !!first && first.type === 'heading';
        };
        const numbers = fm.dendrite_number_sections === true ?
            core.sectionNumbers(root.children, hasHeading, roleOf) : null;
        // Footnotes numbered across the whole document, as export does;
        // each block shows its own beneath it.
        const segs = core.renumberFootnotes(core.exportSegments(
            root.children, (id) => {
                const b = this.bodies.get(id);
                return b ? b.body : '';
            }, headingTop, numbers, roleOf)).segments;
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
            const key = s.text + '\u0000' + core.footnoteBlock(s.notes || []) +
                '\u0000' + (this.showLeft ? s.left : '');
            let b = this.blocks.get(s.id);
            if (!b) {
                const el = createDiv({ cls: 'dendrite-pblock' });
                el.dataset.id = s.id;
                b = { el, key: null, comp: null };
                this.blocks.set(s.id, b);
            }
            const empty = !s.text && !(this.showLeft && s.left);
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
        if (s.text) {
            const notes = s.notes && s.notes.length ?
                '\n\n' + core.footnoteBlock(s.notes) : '';
            await MarkdownRenderer.render(this.app,
                core.normaliseMarkdown(s.text + notes), b.el.createDiv(),
                path, b.comp);
        }
        if (this.showLeft && s.left) {
            await MarkdownRenderer.render(this.app, s.left,
                b.el.createDiv({ cls: 'dendrite-left-out' }), path, b.comp);
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
    new Setting(container).setName('Required by the call')
        .setDesc('On: a limit the call sets, shown red when exceeded. ' +
                 'Off: your own allocation, shown amber.')
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
            .setDesc('Only for page estimates while writing. The real ' +
                     'count depends on the final layout.')
            .addText((t) => t.setValue(String(ms.wordsPerPage))
                .onChange((v) => {
                    draft.dendrite_words_per_page = Number(v) > 0 ?
                        Number(v) : null;
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
            remove: (f) => {
                try { fs.unlinkSync(f); } catch (e) { /* already gone */ }
            },
            run: (cmd, args) => new Promise((res, rej) => execFile(cmd, args,
                { timeout: 180000, env: this.pandocEnv() },
                (err, out, stderr) => (err ?
                    rej(Object.assign(err, { stderr })) : res()))),
            fetch: (u, i) => fetch(u, i),
        };
    }

    /**
     * The search path Pandoc runs with: Obsidian's own plus TeX Live's
     * usual install folders, since an app started from the desktop does
     * not read the shell profile that adds them.
     */
    pandocEnv() {
        const fs = require('fs');
        const path = require('path');
        const extra = [];
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
                   '/opt/homebrew/bin');
        const vars = Object.assign({}, globalThis.process.env);
        vars.PATH = [vars.PATH || '', ...extra].filter(Boolean).join(':');
        return vars;
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
        const open = this.app.workspace.getLeavesOfType('pdf')
            .find((l) => l.view.file && l.view.file.path === rel);
        const leaf = open || this.app.workspace.getLeaf('split', 'vertical');
        await leaf.openFile(file, { active: false });
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
