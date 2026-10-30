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
    normalizePath, Keymap, requestUrl, AbstractInputSuggest,
    prepareFuzzySearch,
} = require('obsidian');
const core = require('./core.js');
const textedit = require('./textedit.js');
const { cardEditor } = require('./editor.js');
const pandoc = require('./pandoc.js');
const review = require('./review.js');
const google = require('./google.js');
const float = require('./float.js');
const timing = require('./timing.js');
const { History, idbStore } = require('./history.js');
const zotero = require('./zotero.js');
const reviewlog = require('./reviewlog.js');
const { PdfLinks } = zotero;

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
    [null, 'Text', 'type'],
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
// How far beyond the preview's view its parts are drawn, as they come
// near it: the margin of the observer that draws them.
const DRAW_MARGIN = 800;
// The comment list in the sidebar, and its filter with nothing chosen.
const COMMENTS = 'dendrite-comments';
const COMMENT_FILTER = Object.freeze({ author: '', waiting: '', kind: '',
                                      priority: '' });
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
    // Comments folded until clicked, and folded again when left.
    foldComments: true,
    // A table edited in the editor's font, not as it prints.
    floatPlain: true,
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
    // Reviews from programs on this computer, over a local port with a
    // key; off until turned on. Desktop only.
    reviewApi: false,
    reviewApiPort: 27130,
    reviewApiKey: '',
    // The name a reply to a review comment is signed with.
    replyName: '',
    // How a diff is shown: unified until side by side is picked.
    diffMode: 'unified',
    // How you are shown where your replies are, and in what is sent out.
    presentName: '',
    recordTimings: false,
    // A notice for each time the board is moved sideways other than by
    // hand, naming what moved it.
    showBoardMoves: false,
    // Reviews submitted, pending until added or ignored on the board,
    // and the latest ones decided, so a submitter can ask.
    reviewQueue: [],
    // Google Docs: the OAuth client's JSON and the Picker API key, as
    // pasted, so every desktop the vault syncs to can sign in. Each
    // computer keeps its own sign-in token, outside the vault.
    googleClientJson: '',
    googlePickerKey: '',
};
const LINTER_ID = 'obsidian-linter';
// Linter rules switched off when Dendrite lints a card. "File name
// heading" inserts the card's ID as its heading, which then becomes its
// label and an exported section heading; "Capitalize headings" rewrites
// the case of headings as they are written. Linter does not know review
// comments: "No bare URLs" wrapped a comment's Google Docs link in <>
// and took the comment's closing %% inside, and "Remove multiple spaces"
// takes the space a suggested insertion starts with, after its colon.
const CARD_UNSAFE_RULES = ['file-name-heading', 'capitalize-headings',
                           'no-bare-urls', 'remove-multiple-spaces'];
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

/**
 * The prefix an index's text names, read from the text itself, since the
 * metadata cache can lag a write such as a sync's.
 */
function indexPrefix(text) {
    const m = /^dendrite_prefix:[ \t]*["']?([^"'\n]*?)["']?[ \t]*$/m
        .exec(core.splitFrontmatter(text).fm);
    return m ? m[1].trim() : null;
}

function formersOf(app, file) {
    return core.formerPrefixes(
        app.metadataCache.getFileCache(file)?.frontmatter);
}

/**
 * Every prefix taken in the vault, lowercased: each manuscript's own and
 * the ones it had before a rename, which an old copy may still carry.
 * `except`, an index, is left out.
 */
function prefixesInUse(app, except = null) {
    const out = new Set();
    for (const f of app.vault.getMarkdownFiles()) {
        const p = f !== except && prefixOf(app, f);
        if (!p) continue;
        out.add(p.toLowerCase());
        for (const q of formersOf(app, f)) out.add(q.toLowerCase());
    }
    return out;
}

/** The index a manuscript with `prefix` was renamed to, if any. */
function successorOf(app, prefix) {
    if (!prefix) return null;
    return app.vault.getMarkdownFiles().find((f) => {
        const p = prefixOf(app, f);
        return p && p !== prefix && formersOf(app, f).includes(prefix);
    }) || null;
}

// Properties holding a path from the vault root, which a renamed folder
// moves.
const PATH_PROPS = ['dendrite_csl', 'dendrite_pandoc_defaults',
                    'dendrite_reference_docx'];

/**
 * Dendrite's folder outside every vault, readable only by this user, for
 * what should not sync with a vault.
 */
function configDir() {
    const env = typeof process !== 'undefined' && process.env &&
        process.env.DENDRITE_CONFIG_DIR;
    if (env) return env;
    try {
        return require('path').join(require('os').homedir(), '.config',
                                    'dendrite');
    } catch (err) {
        return '~/.config/dendrite';
    }
}

/** A file in Dendrite's folder outside the vault, shared by every vault. */
function configFile(name) {
    try {
        return require('path').join(configDir(), name);
    } catch (err) {
        return `${configDir()}/${name}`;
    }
}

/**
 * A file of one vault's own outside it, under vaults/<vault name>/, so
 * that Dendrite in two vaults never writes the same one.
 */
function vaultFile(vault, name) {
    const safe = String(vault).replace(/[^\w .-]/g, '_')
        .replace(/^\./, '_') || '_';
    return configFile(`vaults/${safe}/${name}`);
}

/**
 * Where Dendrite says, while it listens for reviews in vault `vault`,
 * which port and key to use.
 */
function discoveryPath(vault) {
    return vaultFile(vault, 'review-api.json');
}

/** A request to Google through Obsidian, answered as { status, json }. */
async function googleRequest(req) {
    const res = await requestUrl({ url: req.url, method: req.method || 'GET',
        headers: req.headers, body: req.body, contentType: req.contentType,
        throw: false });
    if (req.binary) return { status: res.status, buffer: res.arrayBuffer };
    let json = null;
    try {
        json = res.json;
    } catch (err) {
        json = null;
    }
    return { status: res.status, json };
}

function openExternal(url) {
    try {
        require('electron').shell.openExternal(url);
    } catch (err) {
        window.open(url);
    }
}

/**
 * A comment's links to Google Docs under `el` opened in the browser:
 * followed in the window, they would take Dendrite's window away from
 * Obsidian.
 */
/**
 * Warnings left on screen until clicked, by what each is about: a second
 * about the same thing replaces the first rather than stacking under it,
 * and Dismiss notices clears them all.
 */
const stuckNotices = new Map();

/** A warning left on screen, replacing any earlier one under `key`. */
function stickyNotice(key, text) {
    const old = stuckNotices.get(key);
    if (old) old.hide();
    const n = new Notice(text, 0);
    stuckNotices.set(key, n);
    return n;
}

/** The warning left on screen under `key`, if any, taken away. */
function unstickNotice(key) {
    const old = stuckNotices.get(key);
    if (old) old.hide();
    stuckNotices.delete(key);
}

/** Every warning left on screen hidden; how many there were. */
function dismissNotices() {
    const n = stuckNotices.size;
    for (const x of stuckNotices.values()) x.hide();
    stuckNotices.clear();
    return n;
}

/**
 * A card's note by its id, as Obsidian resolves a link to it from the
 * index at `from`, kept in `cache` (a Map) while the note is still where
 * it was under that name: resolving every card's link took about 130 ms
 * on a 2,646-card board, measured 2026-10-27, on every rebuild and
 * refresh. Each view clears its cache when a note is created, deleted or
 * renamed, so a note closer to the index, or one put back, is found.
 */
function noteOf(app, cache, id, from) {
    const had = cache.get(id);
    if (had && had.basename === id &&
        app.vault.getAbstractFileByPath(had.path) === had) return had;
    const f = app.metadataCache.getFirstLinkpathDest(id, from);
    if (f instanceof TFile) {
        cache.set(id, f);
        return f;
    }
    cache.delete(id);
    return null;
}

/**
 * Inline styles set on an element, each only if it differs: a write that
 * changes nothing still leaves layout for the next read to do.
 */
function setStyles(el, styles) {
    for (const [k, v] of Object.entries(styles)) {
        if (el.style[k] !== v) el.style[k] = v;
    }
}

/**
 * How many screens beyond what is shown, above and below, the board and
 * the preview draw while idle (idleDrawer).
 */
const DRAW_REACH = 2;

/**
 * How many waiting cards or parts are drawn together while idle, so the
 * board is laid out and centred once for them rather than once each.
 */
const DRAW_BATCH = 8;

/**
 * A slot's estimated height, for a card never drawn: the frame around
 * its text, then one line per SLOT_CHAR pixels of text across the card's
 * width less its padding, each line SLOT_LINE high. Estimates, used until
 * enough cards are drawn to fit them (heightFit); a card drawn once keeps
 * its measured height. SLOT_FRAME from the 2,646-card test manuscript,
 * measured 2026-10-27, where 84 left short cards 37 px under.
 */
const SLOT_FRAME = 118;
const SLOT_PADDING = 28;
const SLOT_CHAR = 8;
const SLOT_LINE = 24;

/** How many drawn cards' heights are measured before estimates use them. */
const HEIGHT_SAMPLES = 8;

/**
 * How many screens a move must cover before it jumps to within one of its
 * place and slides only the rest.
 */
const LONG_MOVE = 1.5;
// Under this many cards' width the board shows one column at a time:
// a phone held upright, or a narrow pane.
const NARROW_CARDS = 1.5;
// Room above a card brought to the top of a column in that layout, for
// its parent's name, which stays at the top as the column scrolls.
const NARROW_TOP = 40;

/** How many screens from the view a drawn card is emptied to its slot. */
const EMPTY_REACH = 5;

/**
 * Draws what is still waiting to be drawn, one piece at a time while the
 * window is idle, so a later move or scroll finds it drawn rather than
 * stopping to draw it. `next()` starts drawing the piece nearest what is
 * being read and returns its promise, or null when nothing waits; while
 * `busy()`, as when the board moves or text is typed, it waits a little.
 */
function idleDrawer(winOf, next, busy) {
    let handle = null;
    let stopped = false;
    const run = async () => {
        handle = null;
        if (stopped) return;
        if (busy()) {
            handle = { timer: winOf().setTimeout(run, 250) };
            return;
        }
        const job = next();
        if (!job) return;
        try {
            await job;
        } catch (err) {
            console.error('Dendrite: drawing while idle failed', err);
        }
        schedule();
    };
    const schedule = () => {
        if (stopped || handle) return;
        const win = winOf();
        handle = win.requestIdleCallback ?
            { idle: win.requestIdleCallback(run) } :
            { timer: win.setTimeout(run, 200) };
    };
    const stop = () => {
        stopped = true;
        if (!handle) return;
        const win = winOf();
        if (handle.idle !== undefined) win.cancelIdleCallback(handle.idle);
        else win.clearTimeout(handle.timer);
        handle = null;
    };
    return { schedule, stop };
}

function externalLinks(el) {
    for (const a of el.querySelectorAll('a.dendrite-review-link')) {
        a.target = '_blank';
        a.rel = 'noopener nofollow';
        a.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openExternal(a.href);
        });
    }
}

/**
 * A menu of Dendrite's. Obsidian gives a row without an icon no room for
 * one, so its label would start left of the others; here every row keeps
 * the room, and a row has an icon only where it earns one. A menu with
 * no icons at all, `icons` false, keeps no room.
 */
function dendriteMenu(icons = true) {
    const { Menu } = require('obsidian');
    return styleMenu(new Menu(), icons);
}

/**
 * A box typed in on a card or bubble keeps its keys while it has the
 * focus, so Enter and the arrows are not the view's.
 */
/**
 * The drawn text around the point of mouse event `e` in `body`, a card's
 * text as drawn, for review.offsetAt; null off its text.
 */
function clickedText(body, e) {
    const doc = body && body.ownerDocument;
    if (!doc || !doc.caretRangeFromPoint) return null;
    const r = doc.caretRangeFromPoint(e.clientX, e.clientY);
    if (!r || r.startContainer.nodeType !== 3 ||
        !body.contains(r.startContainer)) return null;
    return review.textAround(body, r.startContainer, r.startOffset);
}

function ownKeys(app, el) {
    const scope = new Scope(app.scope);
    // Ctrl+Enter is the box's, to send, before any hotkey of Obsidian's.
    scope.register(['Mod'], 'Enter', () => {
        if (el.dendriteSend) el.dendriteSend();
        return false;
    });
    el.addEventListener('focus', () => {
        if (app.keymap) app.keymap.pushScope(scope);
    });
    el.addEventListener('blur', () => {
        if (app.keymap) app.keymap.popScope(scope);
    });
}

/**
 * Stop any Escape pressed inside `view` at its own edge. Obsidian takes
 * an Escape nothing stopped, in a view that is not a note, as leaving
 * for the last note's tab, which would take the writer off the board
 * and away from what they were typing; Escape here only ever closes or
 * leaves something within the view.
 */
function keepEscape(view) {
    view.registerDomEvent(view.containerEl, 'keydown', (e) => {
        if (e.key === 'Escape') e.preventDefault();
    });
}

// Dendrite's links in Obsidian's page preview settings.
const HOVER_SOURCE = 'dendrite';

/**
 * A link to card `id` in a comment, labelled `label`: a click calls
 * `go`, and pointing at it shows the card in Obsidian's page preview.
 */
function cardRef(view, doc, id, label, go) {
    const a = doc.createElement('a');
    a.className = 'internal-link dendrite-card-ref';
    a.dataset.href = id;
    a.textContent = label;
    a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        go();
    });
    for (const ev of ['mousedown', 'pointerdown', 'dblclick']) {
        a.addEventListener(ev, (e) => e.stopPropagation());
    }
    a.addEventListener('mouseover', (e) => {
        view.app.workspace.trigger('hover-link', { event: e,
            source: HOVER_SOURCE, hoverParent: view, targetEl: a,
            linktext: id, sourcePath: view.file ? view.file.path : '' });
    });
    return a;
}

/**
 * Obsidian's page preview for the links in a card's text inside `el`, as
 * a note's own links have it; a link to a card made by cardRef has its
 * own.
 */
function hoverLinks(view, el) {
    view.registerDomEvent(el, 'mouseover', (e) => {
        const a = e.target.closest &&
            e.target.closest('a.internal-link:not(.dendrite-card-ref)');
        if (!a || (e.relatedTarget && a.contains(e.relatedTarget))) return;
        const href = a.getAttribute('data-href') || a.getAttribute('href');
        if (!href) return;
        view.app.workspace.trigger('hover-link', { event: e,
            source: HOVER_SOURCE, hoverParent: view, targetEl: a,
            linktext: href, sourcePath: view.file ? view.file.path : '' });
    });
}

/** The card among `ids` a link names, by its id or short id, or null. */
function cardNamed(ids, target) {
    const t = String(target || '').trim();
    const low = t.toLowerCase();
    for (const id of ids) {
        if (id === t || core.shortId(id).toLowerCase() === low) return id;
    }
    return null;
}

/** Today's date where the writer is, as 2026-10-24. */
// The longest reply a program may send: a reply says what the writer
// needs before acting on the comment, and no more.
const MAX_REPLY = 500;

// A program's reply that was to replace its own and could not.
const REFUSED = -2;

// A suggestion to resolve sent on a suggested change, which is applied
// or dismissed instead.
const NOT_COMMENT = -3;

/**
 * A card's body with `reply` under its `n`th comment; null where it is
 * refused as a replacement, false where it suggests resolving a change.
 */
function withReply(body, n, reply) {
    const { replace, priority, only, ...r } = reply;
    if (r.resolve && (review.reviewItems(body)[n] || {}).kind === 'suggest') {
        return false;
    }
    const out = only ? body : replace ?
        review.replaceReplies(body, n, r.author, r) :
        review.addReply(body, n, r);
    // A priority given with it, p1 to p3, or none to take it off.
    return typeof out === 'string' && priority !== undefined ?
        review.setPriority(out, n, priority) : out;
}

/**
 * A comment's triage priority as a chip, review.priorityChip, that opens
 * priorityMenu; `pick(p)` with the one chosen.
 */
function priorityButton(parent, p, pick) {
    const b = review.priorityChip(parent.ownerDocument, p);
    parent.append(b);
    b.addEventListener('click', (e) => {
        e.stopPropagation();
        priorityMenu(e, p, pick);
    });
    return b;
}

/**
 * The priorities as a menu at mouse event `e`, `p` the one set, ticked;
 * `pick(p)` with another chosen, null for none.
 */
function priorityMenu(e, p, pick) {
    const m = dendriteMenu(false);
    for (const [value, title] of [['p1', 'p1'], ['p2', 'p2'],
                                  ['p3', 'p3'], [null, 'None']]) {
        m.addItem((i) => {
            // The one set too: setting it again mends a tag a table
            // editor split.
            i.setTitle(title).onClick(() => pick(value));
            if (typeof i.setChecked === 'function') {
                i.setChecked(value === (p || null));
            }
        });
    }
    if (m.showAtMouseEvent) m.showAtMouseEvent(e);
}

function localDay(d = new Date()) {
    const two = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * A review comment's menu, `items` [action, label, warning], each calling
 * `act(action)`; a warning, a deletion, in the theme's warning colour.
 * `colours` { author, current, pick(colour) } adds the reviewer's colour.
 */
/** A theme colour's name in a menu, after a chip of the colour. */
function colourTitle(c) {
    // The document of the window in use, a popout's if it is one.
    const doc = typeof activeDocument !== 'undefined' ? activeDocument :
        document;
    const frag = doc.createDocumentFragment();
    const chip = frag.appendChild(doc.createElement('span'));
    chip.className = 'dendrite-colour-chip';
    chip.style.setProperty('--dendrite-chip', review.colourCss(c));
    frag.append(c[0].toUpperCase() + c.slice(1));
    return frag;
}

function showCommentMenu(items, event, act, colours = null) {
    const m = dendriteMenu(false);
    for (const [what, label, warn] of items) {
        m.addItem((i) => {
            i.setTitle(label).onClick(() => act(what));
            if (warn && typeof i.setWarning === 'function') i.setWarning(true);
        });
    }
    if (colours) {
        m.addSeparator();
        m.addItem((i) => {
            i.setTitle(`Colour for ${colours.author}`);
            const sub = i.setSubmenu();
            for (const c of review.REVIEWER_COLOURS) {
                sub.addItem((x) => {
                    x.setTitle(colourTitle(c))
                        .onClick(() => colours.pick(c));
                    if (typeof x.setChecked === 'function') {
                        x.setChecked(c === colours.current);
                    }
                });
            }
        });
    }
    if (event && m.showAtMouseEvent) m.showAtMouseEvent(event);
    return m;
}

/**
 * An image clicked, handed to the Image Toolkit plugin to show large,
 * where it is installed; true if it took it. It listens only in note and
 * image panes, so Dendrite's images are passed to it.
 */
function openInImageToolkit(app, e) {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return false;
    const kit = app.plugins && app.plugins.plugins &&
        app.plugins.plugins['obsidian-image-toolkit'];
    if (!kit || typeof kit.clickImage !== 'function') return false;
    kit.clickImage(e);
    return true;
}

/** The preview's share of the width: half on a tablet, else a third. */
function previewShare() {
    return Platform.isTablet ? 1 / 2 : 1 / 3;
}

/**
 * A pane just split off beside another given `share` of the width, the
 * other the rest: the item holding it in a side-by-side split, and its
 * neighbour, sized through Obsidian's setDimension where it has one.
 */
function narrowSplit(leaf, share = 1 / 3) {
    let item = leaf;
    while (item && item.parent && !(item.parent.direction === 'vertical' &&
        (item.parent.children || []).length > 1)) item = item.parent;
    const split = item && item.parent;
    if (!split || typeof item.setDimension !== 'function') return false;
    const rest = split.children.filter((c) => c !== item);
    item.setDimension(100 * share);
    for (const c of rest) {
        if (typeof c.setDimension === 'function') {
            c.setDimension(100 * (1 - share) / rest.length);
        }
    }
    return true;
}

// A sidebar's width, which the comment list takes beside a board in a
// popout window, where there is no sidebar to open it in.
const SIDEBAR_WIDTH = 300;

/**
 * A pane just split off given `px` of its side-by-side split's width,
 * at most two fifths, as a sidebar is, the others keeping their shares
 * of the rest; through setDimension, as narrowSplit.
 */
function sideSplit(leaf, px) {
    let item = leaf;
    while (item && item.parent && !(item.parent.direction === 'vertical' &&
        (item.parent.children || []).length > 1)) item = item.parent;
    const split = item && item.parent;
    if (!split || typeof item.setDimension !== 'function') return false;
    const width = (el) => el && el.getBoundingClientRect ?
        el.getBoundingClientRect().width : 0;
    const total = width(split.containerEl);
    const share = total ? Math.min(0.4, px / total) : 0.25;
    const rest = split.children.filter((c) => c !== item);
    const widths = rest.map((c) => width(c.containerEl) || 1);
    const sum = widths.reduce((a, b) => a + b, 0);
    item.setDimension(100 * share);
    rest.forEach((c, k) => {
        if (typeof c.setDimension === 'function') {
            c.setDimension(100 * (1 - share) * widths[k] / sum);
        }
    });
    return true;
}

function styleMenu(m, icons) {
    if (m.dom && m.dom.addClass) m.dom.addClass('dendrite-menu');
    if (!icons && typeof m.setNoIcon === 'function') m.setNoIcon();
    m.dendriteIcons = icons;
    return m;
}

/**
 * A switch between two views of a bar, the one shown lit: `views` is
 * [[value, label, tooltip], ...], `now` the value shown.
 */
function barSwitch(bar, title, views, now, pick) {
    const seg = bar.createDiv({ cls: 'dendrite-seg' });
    seg.setAttr('aria-label', title);
    for (const [value, label, tip] of views) {
        const b = seg.createEl('button',
            { cls: 'dendrite-bar-btn dendrite-seg-btn', text: label });
        b.setAttr('aria-label', tip);
        b.toggleClass('is-on', now === value);
        b.onclick = () => {
            if (value === now) return;
            now = value;
            for (const x of seg.children) {
                x.toggleClass('is-on', x === b);
            }
            pick(value);
        };
    }
    return seg;
}

/**
 * A button in a view's bar: an icon, a label when given, and what it
 * does in its tooltip. The board's and the preview's bars use the same.
 * One that opens a menu ends in a caret; one without switches a view on
 * or off and is lit while on.
 */
function barButton(bar, icon, label, title, fn, menu = false) {
    const b = bar.createEl('button', { cls: 'dendrite-bar-btn' });
    setIcon(b.createSpan({ cls: 'dendrite-bar-icon' }), icon);
    if (label) b.createSpan({ text: label });
    if (menu) {
        b.addClass('is-menu');
        setIcon(b.createSpan({ cls: 'dendrite-bar-caret' }), 'chevron-down');
    }
    b.setAttr('aria-label', title);
    b.onclick = fn;
    return b;
}

/** Who wrote review items, for a label: "Claude", or "A, B". */
function reviewAuthors(items) {
    return [...new Set(items.map((x) => x.author || 'Reviewer'))]
        .join(', ');
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
        // Renaming: true while this board renames its manuscript; the
        // prefix the index had when last read; the cards listed under a
        // new name whose notes still carry an old one, waiting for a
        // sync; and notes under an old name that came back after.
        // The print-only view: only cards that print, each where it
        // prints, as { parent, kids } by id; null shows every card.
        this.printOnly = false;
        this.shown = null;
        this.renaming = false;
        this.loadedPrefix = null;
        this.arriving = 0;
        this.oldCopies = [];
        this.renameTimer = null;
        this.copiesTimer = null;
        this.inbox = [];
        // Cards picked together, by Ctrl- or Shift-click, to act on at
        // once; the active card is one of them while any are.
        this.picked = new Set();
        // The card whose old versions are fanned out to its right.
        this.fannedId = null;
        this.fanEl = null;
        this.fanReady = Promise.resolve();
        this.fanComps = [];
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
        return { file: this.file ? this.file.path : null,
                 printOnly: this.printOnly };
    }

    async setState(state, result) {
        const f = state && state.file &&
            this.app.vault.getAbstractFileByPath(state.file);
        if (f instanceof TFile) {
            this.file = f;
            if (state.printOnly !== undefined) {
                this.printOnly = !!state.printOnly;
            }
            await this.reload();
            // An old copy of a manuscript renamed since: show the new one.
            const next = successorOf(this.app, this.loadedPrefix);
            if (next) {
                await this.follow(next);
                return super.setState(state, result);
            }
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
        keepEscape(this);
        hoverLinks(this, this.contentEl);
        this.observer = new IntersectionObserver(
            (entries) => this.onVisible(entries),
            { root: null, rootMargin: '600px 200px' });
        // A card changing height, as when it opens for editing or its text
        // renders, moves the flow's edges and the centre.
        this.resizer = new ResizeObserver((entries) =>
            this.onResize(entries));
        this.registerEvent(this.app.vault.on('modify',
            (f) => this.onModify(f)));
        // Notes found by their names are found afresh after any of these.
        for (const e of ['create', 'delete', 'rename']) {
            this.registerEvent(this.app.vault.on(e, () => {
                if (this.notes) this.notes.clear();
            }));
        }
        this.registerEvent(this.app.vault.on('rename', (f, old) => {
            if (this.file && f === this.file) {
                this.leaf.updateHeader();
                // Its versions follow it, as when a sync renames it.
                this.history.adopt(this.historyKey(null),
                                   this.historyKey(null, old));
            } else if (f instanceof TFile && !this.renaming) {
                this.onRenameCard(f, old);
                this.scheduleRenameChecks();
            }
        }));
        this.registerEvent(this.app.vault.on('create', (f) => {
            if (!(f instanceof TFile) || this.renaming || !this.file) return;
            if (this.byId.has(f.basename)) {
                this.invalidate(f.basename);
                this.renderCard(f.basename);
            }
            this.scheduleRenameChecks();
        }));
        this.registerEvent(this.app.vault.on('delete', (f) => {
            if (this.renaming) return;
            if (f === this.file) {
                // Renamed elsewhere and synced as a delete and a create:
                // follow the new index when it is here.
                const next = successorOf(this.app, this.loadedPrefix);
                if (next) this.follow(next);
                else this.leaf.detach();
                return;
            }
            if (f instanceof TFile) this.scheduleRenameChecks();
            if (f instanceof TFile && this.dropped.has(f.basename)) {
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
        // The preview closed or opened elsewhere: the button follows.
        if (this.app.workspace.on) {
            this.registerEvent(this.app.workspace.on('layout-change',
                () => this.showPreviewOn()));
        }
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
        // The caret lands where the card was clicked.
        this.registerDomEvent(this.contentEl, 'dblclick', (e) => {
            const card = e.target.closest('.dendrite-card');
            if (!card || this.editing) return;
            this.startEdit(card.dataset.id, false, clickedText(
                card.querySelector('.dendrite-card-body'), e));
        });
        this.registerDomEvent(window, 'beforeunload',
            () => { this.flush(); });
    }

    async onClose() {
        if (this.idleDraw) this.idleDraw.stop();
        clearTimeout(this.renameTimer);
        clearTimeout(this.copiesTimer);
        for (const c of this.fanComps.splice(0)) c.unload();
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
        this.loadedPrefix = indexPrefix(text);
        this.checkArriving(false);
        this.scheduleOldCopies();
        this.render(true);
        this.refreshInbox();
        // Opening writes nothing: a printing card with no status shows as
        // draft and is given it at the next change made here. Versions
        // are checked behind the board, one card at a time.
        this.versionsChecked = this.checkVersions().catch((err) =>
            console.error('Dendrite: version check failed', err));
    }

    /**
     * Add the index's and every card's type value, where missing, and
     * each card's alias (syncAlias). Run from a command, never on
     * opening, since every device would make the same writes at once.
     */
    async sweepTypes() {
        const s = this.plugin.settings;
        if (s.indexType && this.file) {
            await addType(this.app, this.file, s.indexType);
        }
        for (const n of core.allNodes(this.root)) {
            const f = this.cardFile(n.id);
            if (f && s.cardType) await addType(this.app, f, s.cardType);
            await this.syncAlias(n.id);
        }
    }

    /**
     * A table's, figure's or heading card's alias, kept in step with its
     * caption or heading (core.cardAlias), for finding it with [[; only
     * on a card whose text prints, so notes, scaffolding and old versions
     * are not found among what the document says.
     */
    async syncAlias(id) {
        const f = this.cardFile(id);
        if (!f) return;
        const body = core.splitFrontmatter(await this.app.vault.read(f)).body;
        const alias = this.printsOwn(id) ?
            core.cardAlias(body, this.kindOf(id)) : null;
        await keepAlias(this.app, f, alias);
    }

    /**
     * Mend every card's tables a table editor split at a priority's pipe
     * (review.mendSplitTags), as one step to undo; says how many.
     */
    async mendTables() {
        if (this.editing) await this.endEdit();
        const restores = [];
        const mended = [];
        for (const n of core.allNodes(this.root)) {
            const f = this.cardFile(n.id);
            if (!f) continue;
            const data = await this.app.vault.read(f);
            const { body } = core.splitFrontmatter(data);
            const out = review.mendSplitTags(body);
            if (out === body) continue;
            await this.writeCard(f, (d) => core.splitFrontmatter(d).fm + out);
            restores.push({ path: f.path, text: data, ifBody: out });
            mended.push(n.id);
        }
        if (restores.length) {
            this.pushUndo({ active: this.active, files: [], text: true,
                            restores });
            for (const id of mended) {
                this.invalidate(id);
                await this.renderCard(id);
            }
        }
        new Notice(restores.length ? `Dendrite: mended the tables of ` +
            `${restores.length} card${restores.length === 1 ? '' : 's'}: ` +
            `${mended.map((id) => core.shortId(id)).join(', ')}.` :
            'Dendrite: no table needed mending.');
    }

    /**
     * Whether a card's own text prints: it is not scaffolding, and
     * neither it nor a card above it is left out, as an old version is.
     */
    printsOwn(id) {
        const node = this.byId.get(id);
        if (!node) return false;
        const roleOf = (x) => this.printRoleOf(x);
        if (core.roleFor(node, roleOf) === 'scaffolding') return false;
        for (let n = node; n && n.id; n = n.parent) {
            if (core.roleFor(n, roleOf) === 'notes') return false;
        }
        return true;
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
        this.notes = this.notes || new Map();
        return noteOf(this.app, this.notes, id,
                      this.file ? this.file.path : '');
    }

    // ---- the print-only view ----------------------------------------------

    /**
     * The cards that print, each where it prints: a card left out goes
     * with its branch, and a scaffolding card's children take its place
     * under its parent, as export prints them a level up. So each column
     * is a heading level of the printed document.
     */
    shownTree() {
        const roleOf = (x) => this.printRoleOf(x);
        const parent = new Map();
        const kids = new Map();
        const walk = (n, under) => {
            const out = [];
            for (const c of n.children) {
                // Out of print, a card's old versions in its stack are
                // all that is hidden.
                if (!this.printOnly) {
                    if (this.isSuperseded(c.id)) continue;
                    parent.set(c.id, under);
                    kids.set(c.id, walk(c, c));
                    out.push(c);
                    continue;
                }
                const role = core.roleFor(c, roleOf);
                if (role === 'notes') continue;
                if (role === 'scaffolding') {
                    out.push(...walk(c, under));
                    continue;
                }
                parent.set(c.id, under);
                kids.set(c.id, walk(c, c));
                out.push(c);
            }
            return out;
        };
        kids.set(null, walk(this.root, this.root));
        return { parent, kids };
    }

    /** A shown tree as text, to tell when it changes. */
    shownKey(t) {
        return [...t.parent].map(([id, p]) => `${id}<${p.id}`).join(' ');
    }

    /** A card's children as the board shows them. */
    kidsOf(n) {
        return this.shown ? this.shown.kids.get(n.id) || [] : n.children;
    }

    /** A card's parent as the board shows it. */
    upOf(n) {
        return this.shown ? this.shown.parent.get(n.id) || null : n.parent;
    }

    /** Every card shown below one, in order. */
    shownBelow(node) {
        const out = [];
        const walk = (n) => {
            for (const c of this.kidsOf(n)) {
                out.push(c);
                walk(c);
            }
        };
        walk(node);
        return out;
    }

    /** The shown card nearest a hidden one: the next that prints. */
    nearestShown(id) {
        const all = core.allNodes(this.root);
        const at = all.findIndex((n) => n.id === id);
        const shown = (n) => this.shown.parent.has(n.id);
        const pick = all.slice(at + 1).find(shown) ||
            all.slice(0, Math.max(at, 0)).reverse().find(shown);
        return pick ? pick.id : null;
    }

    togglePrintOnly() {
        this.printOnly = !this.printOnly;
        if (this.editing) this.endEdit();
        this.render();
        this.app.workspace.requestSaveLayout();
    }

    /** True, with a notice, when the print-only view is on. */
    refuseInPrintView() {
        if (!this.printOnly) return false;
        new Notice('Dendrite: the print-only view shows the cards where ' +
                   'they print, not where they sit in the index, so the ' +
                   'structure is changed with every card shown. Click ' +
                   '"Printed" in the bar to show them.', 8000);
        return true;
    }

    // ---- rendering -------------------------------------------------------

    /**
     * Draw the board again. `outside` is a rebuild for a change made
     * elsewhere, such as a sync, which leaves a board scrolled by hand
     * where it was scrolled to rather than centring the active card.
     */
    render(outside = false) {
        const held = outside && this.scrolledByHand && this.board ?
            this.scrollState() : null;
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
        this.drawBoard(held);
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

    drawBoard(held = null) {
        const el = this.contentEl;
        if (this.observer) this.observer.disconnect();
        if (this.resizer) this.resizer.disconnect();
        // Keep cached card renderings: they are re-attached below, so a
        // structural change rebuilds the frame, not the markdown. Cards
        // drawn as frames are drawn as frames again, and slots keep their
        // heights.
        this.keepFilled = new Set();
        for (const [id] of this.liveCards()) this.keepFilled.add(id);
        el.empty();
        this.cardEls.clear();
        el.style.setProperty('--dendrite-card-width',
                             this.plugin.settings.cardWidth + 'px');
        if (!this.file) {
            el.createDiv({ cls: 'dendrite-empty',
                           text: 'Open an index note in Dendrite.' });
            return;
        }
        this.narrow = this.isNarrow();
        el.toggleClass('is-narrow', this.narrow);
        this.renderBar(el);
        this.crumbsEl = null;
        this.trayBtn = null;
        if (this.narrow) this.renderPhoneBar(el);
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
        this.nativeScroll = !!Platform.isMobile || this.narrow;
        board.toggleClass('is-native-scroll', this.nativeScroll);
        const NS = 'http://www.w3.org/2000/svg';
        this.flowSvg = this.pageDoc().createElementNS(NS, 'svg');
        this.flowSvg.classList.add('dendrite-flow');
        board.appendChild(this.flowSvg);
        this.colInners = [];
        this.offsets = [];
        board.addEventListener('scroll', (e) => {
            if (e.target === board) {
                if (this.narrow) this.scheduleSettle();
                return;
            }
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
            this.drawWhenIdle();
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
        this.watchBoardMoves(board);
        // A press on the board itself, not a card, is on its scrollbar.
        board.addEventListener('pointerdown', (e) => {
            if (e.target === board) this.scrolledByHand = true;
        });
        // Notices that wait on a choice, floating over the board's top
        // right, one under another.
        const pinned = stage.createDiv({ cls: 'dendrite-pinned' });
        this.renderOrphans(pinned);
        this.renderOldComments(pinned);
        // One column at a time, a notice is its heading line until it is
        // tapped, so it does not cover the column.
        pinned.addEventListener('click', (e) => {
            const head = this.narrow &&
                e.target.closest('.dendrite-orphans-head');
            if (head) head.parentElement.toggleClass('is-open',
                !head.parentElement.hasClass('is-open'));
        });
        // A pane resized moves the columns, which the flow follows in the
        // same frame, as it does a scroll.
        if (this.resizer) this.resizer.observe(board);
        board.toggleClass('is-print-only', this.printOnly);
        this.shown = this.shownTree();
        if (this.shown && this.active && !this.shown.parent.has(this.active)) {
            this.active = this.nearestShown(this.active);
        }
        const cols = core.columns(this.root, (n) => this.kidsOf(n));
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
                if (!group || this.upOf(n) !== parent) {
                    group = inner.createDiv({ cls: 'dendrite-group' });
                    parent = this.upOf(n);
                    if (parent && parent.id) this.groupHead(group, parent);
                }
                this.renderShell(group, n);
            }
            inner.createDiv({ cls: 'dendrite-spacer' });
        });
        this.keepFilled = null;
        this.fanReady = this.renderFan(stage);
        if (held) {
            this.highlight();
            this.restoreScroll(held);
        } else {
            this.applyActive(false);
        }
        // The cards were rebuilt: anything floating over the old ones goes.
        this.announceScroll();
        this.updateNumbers();
        this.updateRoles();
        this.updateStatuses();
        this.updateCounts();
        this.scheduleChanged();
    }

    renderBar(el) {
        // Buttons from the left: the manuscript's settings and index note
        // as two icons, undo and redo, the views, then the menus. After
        // them, read-outs: the mode, the totals and the tally. The name
        // is the pane's own title. Nothing sits at the right, where other
        // plugins' overlays, such as LiveSync's status, are drawn.
        // The buttons and, under them, the read-outs, as one header.
        const head = el.createDiv({ cls: 'dendrite-head' });
        const bar = head.createDiv({ cls: 'dendrite-bar' });
        const btn = (icon, label, title, fn, menu) =>
            barButton(bar, icon, label, title, fn, menu);
        btn('settings', '', 'This manuscript\'s settings',
            () => this.openManuscriptSettings());
        btn('file-text', '', 'Open the index note as markdown',
            () => this.plugin.openAsMarkdown(this.file))
            .addClass('dendrite-bar-gap');
        btn('undo-2', 'Undo', 'Undo the last change to the tree: moves, ' +
            'new and deleted cards, roles and statuses (Ctrl+Z). A card\'s ' +
            'text is undone inside the card.', () => this.doUndo());
        btn('redo-2', 'Redo', 'Redo what was undone (Ctrl+Shift+Z or ' +
            'Ctrl+Y)', () => this.doRedo()).addClass('dendrite-bar-gap');
        // Which cards are shown, as a switch between its two views, the
        // one shown lit: a single lit button would not say whether its
        // label is what is shown or what a click shows.
        barSwitch(bar, 'Which cards the board shows', [
            [false, 'All', 'Show every card'],
            [true, 'Printed', 'Show only the cards that print, each where ' +
                'it prints, headings by their heading line alone']],
            this.printOnly, (on) => {
                if (this.printOnly !== on) this.togglePrintOnly();
            }).addClass('dendrite-bar-gap');
        // The panes beside the board, side by side: each on or off,
        // faded while off.
        this.previewBtn = btn('scroll-text', 'Preview', 'Show what export ' +
            'would print beside the board, or close it',
            async () => {
                await this.plugin.togglePreview(this.file);
                this.showPreviewOn();
            });
        this.previewBtn.addClass('is-toggle');
        this.showPreviewOn();
        this.commentsBtn = btn('messages-square', 'Comments', 'Review on ' +
            'or off: the list of open comments, to filter them by who ' +
            'wrote them and whose answer they wait for, and the comments ' +
            'beside the preview\'s text', () => this.plugin.setReview(this,
                !this.plugin.reviewOn()));
        this.commentsBtn.addClass('is-toggle');
        this.commentsBtn.addClass('dendrite-bar-gap');
        this.showReviewOn();
        // Then the menus, what goes out and what comes in, and the inbox,
        // shown only while reviews or requests from programs wait.
        btn('file-output', 'Export', 'Export the manuscript to markdown, ' +
            'PDF or Word', (e) => this.exportMenu(null, e), true);
        this.reviewBtn = btn('message-square-plus', 'Review', 'Bring in ' +
            'review comments: from the linked Google Doc or a returned ' +
            'Word file; reviewers, and marking it sent',
            (e) => this.reviewMenu(e), true);
        this.inboxBtn = btn('inbox', 'Inbox', 'Reviews and requests ' +
            'waiting for you to add or ignore', () => this.openInboxList());
        this.showInboxBadge();
        // The read-outs in a row of their own under the buttons: the
        // mode, the totals and the tally with its flags.
        const info = head.createDiv({ cls: 'dendrite-info' });
        this.modeEl = info.createDiv({ cls: 'dendrite-mode' });
        this.showMode();
        this.totalEl = info.createDiv({ cls: 'dendrite-total' });
        this.statusEl = info.createDiv({ cls: 'dendrite-tally' });
    }

    /**
     * The next card changed outside Dendrite to an older copy, or kept
     * from a change while typed in, after the active one in reading
     * order, selected; from the tally's count of them.
     */
    async nextReverted() {
        const ids = core.allNodes(this.root).map((n) => n.id)
            .filter((id) => this.reverted.has(id));
        if (!ids.length) return;
        const at = ids.indexOf(this.active);
        await this.select(ids[(at + 1) % ids.length]);
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

    /**
     * Review comments still in the old form, ==passage== then its note,
     * offered a one-way conversion to markers, the form Dendrite now
     * writes, in a panel over the board.
     */
    async renderOldComments(pinned) {
        await this.loadBodies();
        let n = 0;
        let cards = 0;
        // Counted once per text, kept with it, since the board is drawn
        // again on every change to the tree.
        for (const b of this.bodies.values()) {
            if (b.old === undefined) b.old = review.oldComments(b.body);
            n += b.old;
            if (b.old) cards++;
        }
        // Not on a board drawn again meanwhile.
        if (!n || !this.contentEl.contains(pinned)) return;
        const panel = pinned.createDiv({
            cls: 'dendrite-orphans dendrite-old-comments' });
        panel.createDiv({ cls: 'dendrite-orphans-head',
            text: `${n} review comment${n === 1 ? '' : 's'} in ${cards} ` +
                `card${cards === 1 ? '' : 's'} are in the old style` });
        panel.createDiv({ cls: 'dendrite-old-comments-desc',
            text: 'Converting holds each passage between markers, which ' +
                'lets comments overlap and draws them alike everywhere. ' +
                'It is one way: a device still on an older Dendrite ' +
                'shows converted comments without their passages. The ' +
                'text itself does not change, and Undo takes it back.' });
        const foot = panel.createDiv({ cls: 'dendrite-orphans-foot' });
        const go = foot.createEl('button', { cls: 'mod-cta',
                                             text: 'Convert' });
        go.onclick = () => this.convertOldComments();
    }

    /** Every card's old-form comments converted to markers, one undo. */
    async convertOldComments() {
        if (this.editing) await this.endEdit();
        const restores = [];
        let n = 0;
        for (const node of core.allNodes(this.root)) {
            const f = this.cardFile(node.id);
            if (!f) continue;
            const data = await this.app.vault.read(f);
            const { body } = core.splitFrontmatter(data);
            const k = review.oldComments(body);
            if (!k) continue;
            const next = review.convertOld(body);
            const out = await this.writeCard(f, (d) =>
                core.splitFrontmatter(d).fm + next);
            restores.push({ path: f.path, text: data,
                            ifBody: core.splitFrontmatter(out).body });
            n += k;
            this.invalidate(node.id);
        }
        if (restores.length) {
            this.pushUndo({ active: this.active, files: [], text: true,
                            restores });
        }
        new Notice(`Dendrite: converted ${n} review comment` +
                   `${n === 1 ? '' : 's'} to the new style.`);
        this.render();
    }

    async trashOrphans(files) {
        for (const f of files) await this.app.fileManager.trashFile(f);
        this.render();
    }

    /**
     * A card's place on the board. Far from the view it is a slot, one
     * empty element as tall as the card was when last drawn, or as its
     * text is estimated to be, so the board keeps its shape while holding
     * a handful of elements per card instead of its full frame; near the
     * view it is filled (fillFrame). A card filled before the board was
     * rebuilt, or being written, is filled again at once.
     */
    renderShell(group, n) {
        const card = group.createDiv({ cls: 'dendrite-card' });
        card.dataset.id = n.id;
        if (this.kidsOf(n).length) card.addClass('has-children');
        this.cardEls.set(n.id, card);
        if ((this.editing && this.editing.id === n.id) ||
            (this.keepFilled && this.keepFilled.has(n.id))) {
            this.fillFrame(n.id);
        } else {
            this.makeSlot(n.id, card);
        }
        // A slot is watched from makeSlot.
        if (this.observer && !card.hasClass('is-slot')) {
            this.observer.observe(card);
        }
        if (this.resizer) this.resizer.observe(card);
    }

    /** A card emptied to its slot, at the height it is to keep. */
    makeSlot(id, card) {
        card.addClass('is-slot');
        card.style.height = `${this.slotHeight(id)}px`;
        // Watched again, so it is filled as soon as it nears the view.
        if (this.observer) this.observer.observe(card);
        this.drawWhenIdle();
    }

    /**
     * How tall a card's slot is: as tall as the card was when last
     * drawn, or, never drawn, an estimate from its text's length.
     */
    slotHeight(id) {
        const known = this.heights && this.heights.get(id);
        if (known) return known;
        const lines = this.slotLines(id);
        const fit = this.heightFit();
        if (fit) return Math.max(SLOT_LINE, Math.round(fit.a + fit.b * lines));
        return SLOT_FRAME + lines * SLOT_LINE;
    }

    /** How many lines a card's text would take, roughly: its length. */
    slotLines(id) {
        const b = this.bodies && this.bodies.get(id);
        const chars = b ? b.body.length : 0;
        const perLine = Math.max(20, (this.plugin.settings.cardWidth -
                                      SLOT_PADDING) / SLOT_CHAR);
        return Math.max(1, Math.ceil(chars / perLine));
    }

    /** A drawn card's height, kept for its slot and learnt from. */
    learnHeight(id, h) {
        if (!id || !h) return;
        this.heights = this.heights || new Map();
        this.heights.set(id, h);
        if (!this.bodies || !this.bodies.has(id)) return;
        this.samples = this.samples || new Map();
        this.samples.set(id, [this.slotLines(id), h]);
        this.fit = null;
    }

    /**
     * Height against lines, fitted by least squares over the cards drawn,
     * as { a, b }: so a slot never drawn is estimated from how this
     * manuscript's cards come out in this font and width. Null until
     * HEIGHT_SAMPLES cards are measured.
     */
    heightFit() {
        if (!this.fit) {
            this.fit = core.fitHeights([...(this.samples || new Map())
                .values()], HEIGHT_SAMPLES, SLOT_LINE);
        }
        return this.fit;
    }

    /**
     * A slot filled with the card's frame: its role icon and grip, its
     * text, drawn or waiting to be, and its footer, then each thing shown
     * on a card (decorateCard). The card, or undefined.
     */
    fillFrame(id) {
        const card = this.cardEls.get(id);
        const n = this.byId.get(id);
        if (!card || !n) return card;
        if (card.childElementCount && !card.hasClass('is-slot')) return card;
        const was = card.style.height;
        card.removeClass('is-slot');
        card.style.height = '';
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
            // Blank, at the slot's height until its text is drawn: a label
            // in place of the text, and the card shrinking to it and
            // growing again, flickered as a column moved to a card far
            // away.
            body.createDiv({ cls: 'dendrite-placeholder' });
            if (was) card.style.minHeight = was;
            card.addClass('is-pending');
            this.drawWhenIdle();
        }
        // One column at a time, a card's children are a column away: a
        // tab on its right edge goes to them, saying how many.
        const kids = this.narrow ? this.kidsOf(n) : [];
        if (kids.length) {
            const tab = card.createDiv({ cls: 'dendrite-kids',
                                         text: `› ${kids.length}` });
            tab.setAttr('aria-label', `Go to its ${kids.length} card` +
                        (kids.length === 1 ? '' : 's') + ' below');
            tab.onclick = (e) => {
                e.stopPropagation();
                this.select(kids[0].id);
            };
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
        this.decorateCard(id, card);
        return card;
    }

    /**
     * Cards far from the view emptied back to their slots, keeping their
     * heights; never the active card, the one being written, dragged or
     * with its versions fanned out. All are measured before any is
     * emptied, so the board is laid out once.
     */
    emptyFar(ids) {
        this.heights = this.heights || new Map();
        const keep = (id) => id === this.active || id === this.fannedId ||
            (this.editing && this.editing.id === id) ||
            (this.drag && this.drag.id === id);
        const cards = ids.filter((id) => !keep(id))
            .map((id) => [id, this.cardEls.get(id)])
            .filter(([, c]) => c && !c.hasClass('is-slot'));
        const tall = cards.map(([, c]) => c.offsetHeight);
        cards.forEach(([id, card], i) => {
            if (tall[i]) this.heights.set(id, tall[i]);
            // Its drawn text let go too, or a long session would end up
            // holding every card's; it is drawn again when near.
            this.invalidate(id);
            card.empty();
            card.removeClass('is-pending');
            this.makeSlot(id, card);
        });
        return cards.length;
    }

    /**
     * What every drawn card shows, put on one just filled: its number,
     * role, status chips, quota, the classes of the active path and the
     * cards picked, and the active card's tools.
     */
    decorateCard(id, card) {
        this.numberCard(id, card);
        this.roleCard(id, card);
        this.statusCard(id, card);
        this.stackOpenCard(id, card);
        this.fillQuota(card, id);
        card.toggleClass('is-active', id === this.active);
        card.toggleClass('is-lineage', !!(this.lineage &&
                                          this.lineage.has(id)));
        card.toggleClass('is-picked', !!(this.picked &&
                                         this.picked.has(id)));
        if (id === this.active) this.renderToolbar();
        if (this.find) {
            this.findCard(id, card);
            this.schedulePaintFind();
        }
    }

    /** Find's marks painted again once, after the cards being filled. */
    schedulePaintFind() {
        if (this.paintFrame) return;
        this.paintFrame = this.pageWin().requestAnimationFrame(() => {
            this.paintFrame = null;
            if (this.find) this.paintFind();
        });
    }

    /** The cards drawn as frames, not slots: [id, card]. */
    *liveCards() {
        for (const [id, card] of this.cardEls) {
            if (!card.hasClass('is-slot')) yield [id, card];
        }
    }

    onVisible(entries) {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            const id = e.target.dataset.id;
            this.observer.unobserve(e.target);
            if (e.target.hasClass('is-pending') ||
                e.target.hasClass('is-slot')) this.renderCard(id);
        }
    }

    /**
     * Cards not yet in view drawn while the board is idle, so moving to
     * one, or scrolling to it, does not stop to draw it (idleDrawer).
     */
    drawWhenIdle() {
        if (!this.idleDraw) {
            this.idleDraw = idleDrawer(() => this.pageWin(),
                () => this.nextToDraw(),
                () => !!this.anim ||
                    Date.now() - (this.plugin.typedAt || 0) < 1000);
        }
        this.idleDraw.schedule();
    }

    /**
     * The waiting cards nearest the board's middle, up to DRAW_BATCH,
     * drawn together; or null. Only a card within two screens of what the
     * board shows is drawn, or the
     * child of a card it shows, since moving to that card brings its
     * children into view: so a long manuscript keeps only the part around
     * the reader drawn, and moving or scrolling draws around the new
     * place (DRAW_REACH).
     */
    nextToDraw() {
        if (!this.board) return null;
        this.undrawable = this.undrawable || new WeakSet();
        const box = this.board.getBoundingClientRect();
        // Not shown, as in a tab behind another, every card measures
        // nothing and all would seem near; it is drawn once shown.
        if (!box.width || !box.height) return null;
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const reachX = box.width / 2 + box.width;
        const reachY = box.height / 2 + DRAW_REACH * box.height;
        const rects = new Map();
        const kids = new Set();
        for (const [id, el] of this.cardEls) {
            const r = el.getBoundingClientRect();
            rects.set(id, r);
            const shown = r.bottom >= box.top && r.top <= box.bottom &&
                r.right >= box.left && r.left <= box.right;
            const node = shown && this.byId.get(id);
            if (node) for (const k of this.kidsOf(node)) kids.add(k.id);
        }
        const near = [];
        const far = [];
        for (const [id, el] of this.cardEls) {
            const r = rects.get(id);
            const dx = Math.abs(r.left + r.width / 2 - cx);
            const dy = Math.abs(r.top + r.height / 2 - cy);
            const waiting = el.hasClass('is-pending') ||
                el.hasClass('is-slot');
            if (!waiting) {
                // Never one the rule above would draw again.
                if ((dx > box.width * (EMPTY_REACH + 0.5) ||
                     dy > box.height * (EMPTY_REACH + 0.5)) &&
                    !kids.has(id)) far.push(id);
                continue;
            }
            if (this.undrawable.has(el) ||
                (this.editing && this.editing.id === id)) continue;
            if ((dx > reachX || dy > reachY) && !kids.has(id)) continue;
            near.push([Math.hypot(dx, dy), id, el]);
        }
        if (!near.length) {
            // Nothing near is waiting: what is far from the view goes back
            // to its slot, so the board holds frames only around the reader.
            if (far.length) this.emptyFar(far);
            return null;
        }
        near.sort((a, b) => a[0] - b[0]);
        // Drawn together, each without centring the board: the change in
        // their heights centres it once (onResize).
        this.drawingIdle = (this.drawingIdle || 0) + 1;
        return Promise.all(near.slice(0, DRAW_BATCH).map(([, id, el]) =>
            // One that fails, or is still waiting after, is not tried
            // again until the board is redrawn.
            this.renderCard(id).then(() => {
                if (el.hasClass('is-slot') || el.hasClass('is-pending')) {
                    this.undrawable.add(el);
                }
            }, (err) => {
                this.undrawable.add(el);
                console.error('Dendrite: a card could not be drawn', err);
            }))).finally(() => { this.drawingIdle--; });
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
        if (card.hasClass('is-slot')) {
            this.fillFrame(id);
            if (!card.hasClass('is-pending')) return;
        }
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
        // Review comments render as marks in the text and callouts under
        // their paragraphs, where Obsidian alone would hide them.
        const notes = review.reviewItems(text);
        // Open comments flag a heading card to revise (core.statusReport).
        this.openComments = this.openComments || new Map();
        const count = review.countComments(notes);
        if ((this.openComments.get(id) || 0) !== count) {
            this.openComments.set(id, count);
            this.scheduleStatuses();
        }
        const kind = this.kindOf(id);
        // A figure's image written as a plain link shows as its image.
        const shown = kind === 'figure' && !notes.length ?
            float.compose('figure', float.split(text, 'figure').caption,
                          float.split(text, 'figure').content) : text;
        this.noteReviewers(id, notes);
        if (text.trim()) {
            await MarkdownRenderer.render(this.app,
                notes.length ? review.renderMarkdown(text, this.colourOf()) :
                    shown, out, f.path, comp);
            zotero.linkCitations(out, text, this.plugin.pdfLinks);
            if (notes.length) {
                review.wrapPassages(out);
                review.decorate(out, notes,
                    (n, what, arg) => this.reviewAct(id, n, what, arg),
                    (n, e, k) => this.commentMenu(id, n, e, k),
                    this.colourOf(), (el) => ownKeys(this.app, el),
                    this.nameOf(), id, this.cardLinker());
                externalLinks(out);
            }
        } else if (!kind) {
            out.createDiv({ cls: 'dendrite-placeholder',
                            text: 'Empty card' });
        }
        // A table or figure shows what it still lacks.
        if (kind) {
            const parts = float.split(text, kind);
            const missing = (t) => createDiv({ cls: 'dendrite-float-missing',
                                               text: t });
            if (!parts.content) {
                out.prepend(missing(kind === 'figure' ?
                    'No image: paste, drop or link one' :
                    'No table yet'));
            }
            if (!parts.caption) out.append(missing('No caption'));
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
            now.style.minHeight = '';
            // Its rendered height replaces the placeholder's, which moves
            // the centre if the card is on the active card's lineage;
            // unless a column has been scrolled by hand since, as cards
            // are drawn when scrolled into view and would pull it back.
            // During a move, the move turns to the new place rather than
            // the columns jumping there.
            if (this.lineage && this.lineage.has(id) && !this.scrolledByHand &&
                !this.drawingIdle) {
                this.centre(!!this.anim);
            }
            this.scheduleFlow();
            if (this.find) this.paintFind();
        }
    }

    /** Highlight the active card's lineage and bring it into view. */
    applyActive(smooth = true) {
        // Filled now, so it is centred at its own height.
        const card = this.active && this.cardEls.get(this.active);
        if (card && card.hasClass('is-slot')) this.renderCard(this.active);
        this.highlight();
        this.centre(smooth);
    }

    highlight() {
        if (!this.board) return;
        const node = this.active && this.byId.get(this.active);
        const lineage = new Set();
        if (node) {
            for (let n = node; n && n.id; n = this.upOf(n)) lineage.add(n.id);
            for (const d of this.shownBelow(node)) lineage.add(d.id);
        }
        this.lineage = lineage;
        if (this.plugin.previewActive) {
            this.plugin.previewActive(this.file, this.active);
        }
        this.board.toggleClass('has-active', !!node);
        for (const [id, el] of this.cardEls) {
            el.toggleClass('is-active', id === this.active);
            el.toggleClass('is-lineage', lineage.has(id));
            el.toggleClass('is-picked', this.picked.has(id));
        }
        this.renderToolbar();
        this.renderCrumbs();
        this.scheduleFlow();
    }

    /**
     * Whether the pane is too narrow for columns side by side, so the
     * board shows one at a time. Not known before the pane has a width.
     */
    isNarrow() {
        const w = this.contentEl.clientWidth;
        const card = this.plugin.settings.cardWidth || 480;
        return w > 0 && w < card * NARROW_CARDS + 4 * 12;
    }

    /**
     * A group's parent named at its top, for the one-column layout, where
     * the parent's own column is out of sight; it stays at the top of
     * the column while the group is scrolled, and goes to the parent.
     */
    groupHead(group, parent) {
        const head = group.createDiv({ cls: 'dendrite-group-head' });
        head.setText(parent.label || core.shortId(parent.id));
        head.onclick = (e) => {
            e.stopPropagation();
            this.select(parent.id);
        };
    }

    /** The active card's parents, each a step back up to it. */
    renderCrumbs() {
        const el = this.crumbsEl;
        if (!el) return;
        el.empty();
        const node = this.active && this.byId.get(this.active);
        const path = [];
        for (let n = node; n && n.id; n = this.upOf(n)) path.unshift(n);
        path.forEach((n, k) => {
            if (k) el.createSpan({ cls: 'dendrite-crumb-sep', text: '›' });
            const c = el.createSpan({ cls: 'dendrite-crumb',
                text: n.label || core.shortId(n.id) });
            if (n.id === this.active) c.addClass('is-current');
            else c.onclick = () => this.select(n.id);
        });
        // The deepest steps are the context, so a long trail is kept
        // scrolled to its end and its top steps are the ones cut off.
        el.scrollLeft = el.scrollWidth;
    }

    /**
     * Where each column goes in the one-column layout to show the active
     * card's line: its parents, itself and its first children, each at
     * the top of its column, under the parent's name.
     */
    narrowTargets(node, pos) {
        const at = this.cols.map(() => null);
        for (let n = node; n && n.id; n = this.upOf(n)) at[n.depth] = n;
        for (let n = node, kids = this.kidsOf(n); kids.length;
            kids = this.kidsOf(n)) {
            n = kids[0];
            at[n.depth] = n;
        }
        return at.map((n) => {
            const p = n && pos(n.id);
            return p ? Math.max(0, p.top - NARROW_TOP) : null;
        });
    }

    /**
     * The phone's bar: the way down to the active card, which takes the
     * row, then Undo and a menu holding the rest of the board's bar and
     * the notices waiting on it. The full bar is kept, hidden, so its
     * buttons and notices are still drawn and counted.
     */
    renderPhoneBar(el) {
        const bar = el.createDiv({ cls: 'dendrite-phone-bar' });
        this.crumbsEl = bar.createDiv({ cls: 'dendrite-crumbs' });
        const btn = (icon, label, fn) => {
            const b = bar.createEl('button',
                { cls: 'clickable-icon dendrite-phone-btn' });
            setIcon(b, icon);
            b.setAttr('aria-label', label);
            b.onclick = fn;
            return b;
        };
        btn('undo-2', 'Undo', () => this.doUndo());
        this.trayBtn = btn('more-horizontal', 'More', (e) =>
            this.openTray(e));
        this.showTrayCount();
    }

    /** The notices waiting on the bar, as the full bar draws them. */
    barChips() {
        return this.statusEl ?
            [...this.statusEl.querySelectorAll('.dendrite-status-chip')] :
            [];
    }

    /** How many notices wait, on the phone bar's menu button. */
    showTrayCount() {
        const b = this.trayBtn;
        if (!b) return;
        const old = b.querySelector('.dendrite-bar-badge');
        if (old) old.remove();
        const n = this.barChips().length;
        if (n) b.createSpan({ cls: 'dendrite-bar-badge', text: String(n) });
    }

    /** The phone bar's menu: the notices, then what the full bar holds. */
    openTray(e) {
        const m = dendriteMenu();
        const tally = this.statusEl && this.statusEl.firstChild &&
            this.statusEl.firstChild.nodeType === 3 ?
            this.statusEl.firstChild.textContent : '';
        if (tally) {
            m.addItem((i) => {
                i.setTitle(tally).setIcon('list-checks');
                if (typeof i.setDisabled === 'function') i.setDisabled(true);
            });
        }
        for (const c of this.barChips()) {
            m.addItem((i) => i.setTitle(c.textContent).setIcon('bell')
                .onClick(() => c.onclick && c.onclick()));
        }
        m.addSeparator();
        m.addItem((i) => i.setTitle('Redo').setIcon('redo-2')
            .onClick(() => this.doRedo()));
        const on = this.previewBtn && this.previewBtn.hasClass('is-on');
        m.addItem((i) => i.setTitle(on ? 'Close the preview' : 'Preview')
            .setIcon('scroll-text').onClick(async () => {
                await this.plugin.togglePreview(this.file);
                this.showPreviewOn();
            }));
        m.addItem((i) => i.setTitle(this.printOnly ? 'Show every card' :
            'Show only the cards that print').setIcon('filter')
            .onClick(() => this.togglePrintOnly()));
        m.addItem((i) => i.setTitle('Export…').setIcon('file-output')
            .onClick(() => this.exportMenu(null, e)));
        const waiting = (this.inbox || []).length;
        if (waiting) {
            m.addItem((i) => i.setTitle(`Inbox (${waiting})`)
                .setIcon('inbox').onClick(() => this.openInboxList()));
        }
        m.addItem((i) => i.setTitle('Review…').setIcon('message-square-plus')
            .onClick(() => this.reviewMenu(e)));
        const reviewing = this.plugin.reviewOn && this.plugin.reviewOn();
        m.addItem((i) => i.setTitle(reviewing ? 'Close the comments' :
            'Comments').setIcon('messages-square')
            .onClick(() => this.plugin.setReview(this, !reviewing)));
        m.addSeparator();
        m.addItem((i) => i.setTitle('This manuscript\'s settings')
            .setIcon('settings').onClick(() =>
                this.openManuscriptSettings()));
        m.addItem((i) => i.setTitle('Open the index note')
            .setIcon('file-text').onClick(() =>
                this.plugin.openAsMarkdown(this.file)));
        if (m.showAtMouseEvent) m.showAtMouseEvent(e);
    }

    scheduleSettle() {
        const win = this.pageWin();
        win.clearTimeout(this.settleTimer);
        this.settleTimer = win.setTimeout(() => this.settleSwipe(), 140);
    }

    /** The first card at the top of column `d`, below its parent's name. */
    topCard(d) {
        const col = this.board.querySelectorAll('.dendrite-col')[d];
        if (!col) return null;
        const line = col.scrollTop + NARROW_TOP + 4;
        for (const n of this.cols[d] || []) {
            const el = this.cardEls.get(n.id);
            if (el && el.offsetTop + el.offsetHeight > line) return n;
        }
        return null;
    }

    /** Whether card `node` shows in its column. */
    onScreen(node) {
        const col = this.board.querySelectorAll('.dendrite-col')[node.depth];
        const el = this.cardEls.get(node.id);
        if (!col || !el) return false;
        return el.offsetTop < col.scrollTop + col.clientHeight &&
            el.offsetTop + el.offsetHeight > col.scrollTop + NARROW_TOP;
    }

    /**
     * After a swipe sideways settles in the one-column layout, the card
     * it went from, the active one if it shows, else the card at the top
     * of the column, decides where it lands: on that card's first child,
     * or its parent. With no child, it goes back. Scrolling down a column
     * changes nothing; a tap selects.
     */
    settleSwipe() {
        if (!this.narrow || this.editing || !this.board) return;
        const board = this.board;
        const wide = board.clientWidth;
        const count = this.cols ? this.cols.length : 0;
        if (!wide || !count) return;
        const d = Math.max(0, Math.min(count - 1,
            Math.round(board.scrollLeft / wide)));
        const node = this.active && this.byId.get(this.active);
        if (node && node.depth === d) return;
        const p = node ? node.depth : d;
        const from = node && this.onScreen(node) ? node : this.topCard(p);
        let to = from;
        for (let k = p; to && k < d; k++) to = this.kidsOf(to)[0] || null;
        for (let k = p; to && to.id && k > d; k--) to = this.upOf(to);
        if (!to || !to.id) to = from || this.topCard(d);
        if (!to) return;
        if (to.id === this.active) this.centre(true);
        else this.select(to.id);
    }

    onResize(entries = []) {
        // Wide enough again, or too narrow now: the other layout.
        if (this.board && this.isNarrow() !== !!this.narrow) {
            this.render();
            return;
        }
        this.anchorColumns(entries);
        // The cards drawn tell their heights for nothing, as they resize:
        // kept for their slots, and learnt from for those never drawn.
        for (const e of entries) {
            const card = e.target;
            const size = e.borderBoxSize && e.borderBoxSize[0];
            if (!size || !card.classList.contains('dendrite-card') ||
                card.classList.contains('is-slot') ||
                card.classList.contains('is-pending') ||
                card.classList.contains('is-editing')) continue;
            this.learnHeight(card.dataset.id, size.blockSize);
        }
        // Cards are drawn as a scrolled column brings them into view, and
        // change height as they are, so after a scroll by hand a resize
        // only redraws the flow. On the desktop, centring redraws the
        // flow itself. During a move, the move turns. Done here, after
        // layout and before painting, not on the next frame: waiting a
        // frame painted the column shifted, then put it back, a flicker
        // for each card filled as a column arrived at a card far away.
        if (!this.scrolledByHand) this.centre(!!this.anim);
        if (this.nativeScroll || this.scrolledByHand) this.drawFlow();
    }

    /**
     * Each column kept where it shows when a card beginning above its view
     * changes height, as when one is filled or drawn: the columns move by
     * transform, outside the browser's own scroll anchoring, so a column
     * scrolled by hand jumped as the cards above it were drawn. The column
     * moves by the change, here before painting. A phone's columns scroll
     * natively and are anchored by the browser.
     */
    anchorColumns(entries) {
        if (this.nativeScroll) return;
        this.seenHeights = this.seenHeights || new WeakMap();
        const shift = new Map();
        for (const e of entries) {
            const card = e.target;
            const size = e.borderBoxSize && e.borderBoxSize[0];
            if (!size || !card.classList.contains('dendrite-card')) continue;
            const was = this.seenHeights.get(card);
            this.seenHeights.set(card, size.blockSize);
            if (was === undefined || was === size.blockSize) continue;
            const col = card.closest('.dendrite-col');
            if (!col) continue;
            const d = Number(col.dataset.depth);
            if (card.offsetTop < this.colOffset(d)) {
                shift.set(d, (shift.get(d) || 0) + size.blockSize - was);
            }
        }
        for (const [d, by] of shift) {
            this.setColOffset(d, this.colOffset(d) + by);
        }
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
        this.placeFan();
        this.placeFloat();
        // Everything is read before anything is written, and only what
        // changed is written: a write here left the board to be laid out
        // again by the next read, here or in centring, about 194 ms on a
        // 2,646-card board, measured 2026-10-27.
        const node = this.active && this.byId.get(this.active);
        // In the board's content coordinates: the SVG spans the board's
        // columns and moves with its horizontal scroll. Not its scroll
        // width, which the columns' moves change.
        const cols = this.board.querySelectorAll('.dendrite-col');
        const last = cols[cols.length - 1];
        const width = `${last ? last.offsetLeft + last.offsetWidth : 0}px`;
        const height = `${this.board.clientHeight}px`;
        const box = this.board.getBoundingClientRect();
        const sx = this.board.scrollLeft;
        const rel = (el) => this.flowBox(el, box, sx);
        // Grey context: each card on the path opens into its whole group
        // of children. Purple thread: each card on the path leads to the
        // specific next card, ending at the active card.
        const pairs = [];
        const steps = [];
        const groups = new Set();
        for (let n = node; n && n.id; n = this.upOf(n)) {
            const card = this.cardEls.get(n.id);
            if (!card) continue;
            const parent = this.upOf(n);
            if (parent && parent.id) {
                const up = this.cardEls.get(parent.id);
                if (up) steps.push({ from: rel(up), to: rel(card) });
            }
            const kids = this.kidsOf(n);
            if (!kids.length) continue;
            const child = this.cardEls.get(kids[0].id);
            const group = child && child.parentElement;
            if (!group) continue;
            groups.add(group);
            pairs.push({ card: rel(card), group: rel(group) });
        }
        for (const g of this.board.querySelectorAll('.is-flow')) {
            if (!groups.has(g)) g.classList.remove('is-flow');
        }
        for (const g of groups) {
            if (!g.classList.contains('is-flow')) g.classList.add('is-flow');
        }
        if (svg.style.width !== width) svg.style.width = width;
        if (svg.style.height !== height) svg.style.height = height;
        this.flowPath(svg, 'dendrite-flow-context',
                      node ? core.flowPath(pairs) : '');
        this.flowPath(svg, 'dendrite-flow-thread',
                      node ? core.threadPath(steps) : '');
    }

    /** One of the flow's two shapes, given its path, or removed. */
    flowPath(svg, cls, d) {
        let path = svg.querySelector(`.${cls}`);
        if (!d) {
            if (path) path.remove();
            return;
        }
        if (!path) {
            const NS = 'http://www.w3.org/2000/svg';
            path = this.pageDoc().createElementNS(NS, 'path');
            path.setAttribute('class', cls);
            // The context under the thread.
            if (cls === 'dendrite-flow-context') svg.prepend(path);
            else svg.appendChild(path);
        }
        if (path.getAttribute('d') !== d) path.setAttribute('d', d);
    }

    /**
     * An element's box for the flow, in the board's content coordinates
     * (`box` the board's rect, `sx` its scroll). A card with old versions
     * starts at the top of its stack, the room above it its margin holds.
     */
    flowBox(el, box, sx) {
        const r = el.getBoundingClientRect();
        // The element's own window's, which in a popout is not this one.
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        const lift = el.classList.contains('has-stack') ?
            parseFloat(cs.marginTop) || 0 : 0;
        return { left: r.left - box.left + sx,
                 right: r.right - box.left + sx,
                 top: r.top - box.top - lift, bottom: r.bottom - box.top,
                 r: parseFloat(cs.borderTopLeftRadius) || 0 };
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
        let targets = core.alignColumns(this.cols, node, pos, heights,
            own, { up: (n) => this.upOf(n), kids: (n) => this.kidsOf(n) });
        // One column at a time: the card at the top, and while it is
        // typed in, the column left to keep the caret in view itself.
        if (this.narrow) {
            targets = this.editing ? targets.map(() => null) :
                this.narrowTargets(node, pos);
        }
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
            this.tellCentred(left);
            // Far to go sideways, the same: a jump, then a screen's slide.
            const wide = this.board.clientWidth;
            const by = left - this.board.scrollLeft;
            if (smooth && wide && Math.abs(by) > LONG_MOVE * wide) {
                this.board.scrollTo({ left: left - Math.sign(by) * wide,
                                      behavior: 'auto' });
            }
            this.board.scrollTo({ left, behavior });
        }
        // What is around the new place is drawn next.
        this.drawWhenIdle();
    }

    /** With Say what moves the board on, a centring that moves it. */
    tellCentred(left) {
        this.centredAt = Date.now();
        if (!this.plugin.settings.showBoardMoves) return;
        const max = this.board.scrollWidth - this.board.clientWidth;
        const to = Math.max(0, Math.min(max, left));
        const by = Math.round(to - this.board.scrollLeft);
        if (Math.abs(by) < 20) return;
        new Notice(`Dendrite centred the board, ${by} px: ` +
                   callers(new Error().stack).join(' \u2190 '), 10000);
    }

    /**
     * With Say what moves the board on, the board moved sideways with no
     * touch, wheel or centring in the last moments.
     */
    watchBoardMoves(board) {
        let rest = board.scrollLeft;
        const handAt = () => { this.handAt = Date.now(); };
        for (const t of ['touchstart', 'touchmove', 'touchend', 'wheel',
                         'pointerdown']) {
            board.addEventListener(t, handAt, { passive: true });
        }
        board.addEventListener('scroll', (e) => {
            if (e.target !== board) return;
            const now = Date.now();
            const quiet = now - (this.handAt || 0) > 3000 &&
                now - (this.centredAt || 0) > 1500;
            // Measured from where a hand or a centring last left it.
            if (!quiet) {
                rest = board.scrollLeft;
                return;
            }
            const by = Math.round(board.scrollLeft - rest);
            if (Math.abs(by) < 20) return;
            rest = board.scrollLeft;
            if (!this.plugin.settings.showBoardMoves) return;
            new Notice(`Dendrite: the board moved ${by} px sideways with ` +
                       'no touch and no centring.', 10000);
        });
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

    /**
     * Move the active column to the caret once the editor has drawn. Most
     * keys leave the caret on its line and the card its height, and then
     * nothing would move: the board is laid out again, every column
     * measured and the flow redrawn, only when one of them changes.
     */
    followCaret() {
        if (this.caretFrame) return;
        const win = this.pageWin();
        this.caretFrame = win.requestAnimationFrame(() => {
            this.caretFrame = null;
            const ed = this.editing;
            if (!ed) return;
            if (this.caretAt && this.caretAt === this.caretKey(ed)) return;
            this.centre(false, true);
            // Where the caret is once moved, so the next key on the same
            // line finds it there; a column moved by hand since moves it.
            this.caretAt = this.caretKey(ed);
        });
    }

    /**
     * Where editor `ed`'s caret is on screen, and its card's height; null
     * when the caret cannot be read, so the board is laid out every time.
     */
    caretKey(ed) {
        let r = null;
        try {
            r = ed.editor.caretRect && ed.editor.caretRect();
        } catch (err) {
            return null;
        }
        const card = this.cardEls.get(ed.id);
        return r && card ?
            `${ed.id}:${Math.round(r.top)}:${card.offsetHeight}` : null;
    }

    /** A column's scroll position, however it is scrolled. */
    /** Where the board and each column are scrolled to. */
    scrollState() {
        const cols = this.board.querySelectorAll('.dendrite-col');
        return { left: this.board.scrollLeft,
                 cols: [...cols].map((c, d) => this.colOffset(d)) };
    }

    /** The board and its columns scrolled back to `held`, by hand. */
    restoreScroll(held) {
        this.board.scrollLeft = held.left;
        held.cols.forEach((y, d) => this.setColOffset(d, y));
        this.scrolledByHand = true;
        this.scheduleFlow();
    }

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
        // A column with far to go jumps to within a screen of its place
        // and slides the rest: sliding the whole way brought every card
        // it passed into view, each drawn only to leave it again.
        const screen = this.board.clientHeight;
        targets.forEach((y, d) => {
            if (!smooth || y === null || !screen) return;
            if (Math.abs(y - from[d]) > LONG_MOVE * screen) {
                from[d] = y - Math.sign(y - from[d]) * screen;
            }
        });
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

    /**
     * Keep the board's horizontal scroll where it is for a moment. The
     * handler that scrolls it copies a second time once the board has
     * moved, so a copy during a hold extends that hold rather than
     * holding the board where it was moved to.
     */
    holdBoardScroll() {
        const board = this.board;
        const win = this.pageWin();
        if (this.boardHold && this.boardHold.board === board) {
            win.clearTimeout(this.boardHold.timer);
        } else {
            const x = board.scrollLeft;
            const hold = (e) => {
                if (e.target === board && board.scrollLeft !== x) {
                    board.scrollLeft = x;
                }
            };
            board.addEventListener('scroll', hold);
            this.boardHold = { board, hold };
        }
        const held = this.boardHold;
        held.timer = win.setTimeout(() => {
            board.removeEventListener('scroll', held.hold);
            if (this.boardHold === held) this.boardHold = null;
        }, 300);
    }

    /** The wheel scrolls the column under it, flow redrawn the same frame. */
    onWheel(e) {
        if (e.ctrlKey) return;
        const horizontal = e.shiftKey ||
            Math.abs(e.deltaX) > Math.abs(e.deltaY);
        // The board scrolls sideways itself, and is then where the hand
        // put it until a card is moved to.
        if (horizontal) {
            this.scrolledByHand = true;
            return;
        }
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
        this.drawWhenIdle();
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
        // A slot gets its tools once filled (decorateCard).
        if (!card || card.hasClass('is-slot')) return;
        // A phone's keyboard has no Escape: a card being typed in there,
        // or in a narrow pane, has a Done button to leave it.
        const done = this.editing && this.editing.id === this.active &&
            (this.editing.editor || {}).kind !== 'float' &&
            (this.narrow || Platform.isMobile);
        if (this.editing && !done) return;
        const foot = card.querySelector(':scope > .dendrite-card-foot') ||
            card.createDiv({ cls: 'dendrite-card-foot' });
        const t = foot.createDiv({ cls: 'dendrite-toolbar' });
        if (done) {
            const b = t.createEl('button', { cls: 'mod-cta dendrite-done',
                                             text: 'Done' });
            b.onclick = (e) => {
                e.stopPropagation();
                this.endEdit();
            };
            this.toolbar = t;
            return;
        }
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
     * Roles for a card and everything below it, in a submenu where
     * Obsidian has them, else as items of their own. Statuses for the
     * cards below are with the card's own, at the top of its menu.
     */
    addBranchItems(m, id) {
        let sub = null;
        m.addSeparator();
        m.addItem((i) => {
            i.setTitle('Whole branch');
            if (typeof i.setSubmenu === 'function') sub = i.setSubmenu();
        });
        if (sub) styleMenu(sub, true);
        const into = sub || m;
        const lead = sub ? '' : 'Whole branch: ';
        for (const [value, title, icon] of
            [[null, 'Prints automatically', 'wand'], ...ROLE_ITEMS]) {
            into.addItem((i) => i.setTitle(lead + title).setIcon(icon)
                .onClick(() => this.setBranch(id, 'role', value)));
        }
    }

    /**
     * Set a role on a card and every card below it, or a status on every
     * card below it that prints its text, as one step to undo.
     */
    async setBranch(id, what, value) {
        const node = this.byId.get(id);
        if (!node) return;
        const roleOf = (x) => this.printRoleOf(x);
        const key = what === 'role' ? 'dendrite_role' : 'dendrite_status';
        const restores = [];
        // A role goes to the whole branch; a status to the cards below,
        // the card's own being set beside it.
        const cards = what === 'status' ? core.descendants(node) :
            [node, ...core.descendants(node)];
        for (const c of cards) {
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
        const where = what === 'role' ? 'in the branch' : 'below';
        new Notice(n ? `Dendrite: ${n} card${n === 1 ? '' : 's'} ${where} ` +
            `set to ${name}.` : what === 'role' ?
            `Dendrite: the branch is already ${name}.` :
            `Dendrite: the cards below are already ${name}.`);
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
        // Each key a keycap, its text drawn by the stylesheet, so the
        // item's text is its title alone.
        const chip = row.appendChild(doc.createElement('span'));
        chip.className = 'dendrite-menu-key';
        chip.dataset.key = key;
        for (const part of key.split('+')) {
            const k = chip.appendChild(doc.createElement('kbd'));
            k.className = 'dendrite-kbd';
            k.dataset.k = part;
        }
        return label;
    }

    /** The role choices alone, from a card's corner icon. */
    roleMenu(id, anchor) {
        const m = dendriteMenu();
        this.addRoleItems(m, id);
        const r = anchor.getBoundingClientRect();
        m.showAtPosition({ x: r.left, y: r.bottom }, this.pageDoc());
    }

    cardMenu(anchor, event) {
        if (this.picked.size > 1 && this.picked.has(this.active)) {
            this.pickedMenu(anchor, event);
            return;
        }
        const m = dendriteMenu();
        const id = this.active;
        const node = this.byId.get(id);
        // A submenu where Obsidian has them, else its items in the menu
        // itself, each titled with the submenu's name.
        // A fold-out is a heading for its group, so it has no icon; its
        // items have one where `ic` gives one.
        const submenu = (title, icons = true) => {
            let sub = null;
            m.addItem((i) => {
                i.setTitle(title);
                if (typeof i.setSubmenu === 'function') sub = i.setSubmenu();
            });
            if (sub) styleMenu(sub, icons);
            const lead = sub ? '' : `${title}: `;
            const into = sub || m;
            return { into, item: (t, ic, fn, key) => into.addItem((i) => {
                i.setTitle(key ? this.menuLabel(lead + t, key) : lead + t)
                    .onClick(fn);
                if (ic) i.setIcon(ic);
            }) };
        };
        const item = (title, icon, fn) => m.addItem((i) => {
            i.setTitle(title).onClick(fn);
            if (icon) i.setIcon(icon);
        });
        // Status first, the change made most often to one card.
        const info = this.statusInfo && this.statusInfo.get(id);
        if (info && info.prints) {
            for (const [value, title, icon, key] of STATUS_ITEMS) {
                m.addItem((i) => {
                    i.setTitle(this.menuLabel(title, `Ctrl+${key}`))
                        .setIcon(icon)
                        .onClick(() => this.markStatus(id, value));
                    if (typeof i.setChecked === 'function') {
                        i.setChecked(info.own === value);
                        tickBeforeKey(i);
                    }
                });
            }
            // A card with cards below sets theirs from one fold-out,
            // every card there that prints its text.
            if (node && this.kidsOf(node).length) {
                let sub = null;
                m.addItem((i) => {
                    i.setTitle('Cards below');
                    if (typeof i.setSubmenu === 'function') {
                        sub = i.setSubmenu();
                    }
                });
                if (sub) styleMenu(sub, true);
                for (const [value, title, icon] of STATUS_ITEMS) {
                    (sub || m).addItem((i) => i.setTitle(sub ? title :
                        title.replace('Status', 'Cards below'))
                        .setIcon(icon)
                        .onClick(() => this.setBranch(id, 'status', value)));
                }
            }
            m.addSeparator();
        } else if (info && info.own === 'unsplit') {
            item('Keep the leftover text as notes', 'check',
                 () => this.markStatus(id, null));
            m.addSeparator();
        } else if (info && info.derived) {
            // A card that takes its status from the cards below it sets
            // theirs, every card there that prints its text.
            for (const [value, title, icon] of STATUS_ITEMS) {
                m.addItem((i) => {
                    i.setTitle(title.replace('Status', 'Cards below'))
                        .setIcon(icon)
                        .onClick(() => this.setBranch(id, 'status', value));
                    if (typeof i.setChecked === 'function') {
                        i.setChecked(info.derived === value);
                    }
                });
            }
            m.addSeparator();
        }
        // What prints: the role, the kind, and the whole branch's.
        this.addRoleItems(submenu('Prints as').into, id);
        // Versions: a card replaced keeps its old self in a stack.
        const versions = submenu('Versions', false);
        versions.item('New version of this card', null,
                      () => this.promote(id));
        if (node && node.parent && node.parent.id) {
            const up = node.parent.id;
            versions.item('Replace the parent card with this one',
                          null, () => this.promote(up, id));
        }
        if (this.stackOf(id).length) {
            versions.item(this.fannedId === id ? 'Hide old versions' :
                          'Show old versions', null,
                          () => this.toggleFan(id));
            versions.item('Make an old version current, or delete one…',
                          null, () => this.openStack(id));
        }
        // The card's place in the tree, with the keys that do the same.
        const structure = submenu('Structure');
        // The keys show the arrows; a merge, which joins two cards into
        // one, is marked as the heavier action.
        structure.item('New card above', null, () => this.insert('above'),
                       'Ctrl+↑');
        structure.item('Move up', null, () => this.structural('up'),
                       'Alt+↑');
        structure.item('Move down', null, () => this.structural('down'),
                       'Alt+↓');
        structure.item('Indent', null, () => this.structural('indent'),
                       'Alt+→');
        structure.item('Outdent', null, () => this.structural('outdent'),
                       'Alt+←');
        structure.into.addSeparator();
        structure.item('Merge into the card above', 'merge',
                       () => this.merge('above'));
        structure.item('Merge into the parent card', 'git-merge',
                       () => this.merge('parent'));
        m.addSeparator();
        const exp = submenu('Export this branch', false);
        const formats = [['Markdown', 'md']];
        if (Platform.isDesktopApp) {
            formats.push(['PDF', 'pdf'], ['Word', 'docx']);
        }
        for (const [title, fmt] of formats) {
            exp.item(title, null, () => this.exportTo(node, fmt));
        }
        item('Card properties…', 'sliders-horizontal',
             () => new CardModal(this, id).open());
        item('Copy reference', 'link', () => this.copyRef(id));
        item('Open card note', null, () => {
            const f = this.cardFile(id);
            if (f) this.plugin.openAsMarkdown(f);
        });
        m.addSeparator();
        m.addItem((i) => {
            i.setTitle(this.menuLabel('Delete card and its children',
                                      'Ctrl+Backspace'))
                .setIcon('trash-2').onClick(() => this.deleteActive());
            // A deletion, in the theme's warning colour.
            if (typeof i.setWarning === 'function') i.setWarning(true);
        });
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
        if (openInImageToolkit(this.app, e)) return;
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
            const mod = e.ctrlKey || e.metaKey || Keymap.isModEvent(e);
            // A card of this manuscript is gone to on the board; with
            // Ctrl, its note opens, as any other link's does.
            const id = !mod && cardNamed(this.byId.keys(),
                                         String(href).split(/[#|]/)[0]);
            if (id) {
                this.select(id);
                return;
            }
            this.app.workspace.openLinkText(href, this.file.path, mod);
            return;
        }
        if (e.target.closest('.dendrite-toolbar, textarea, .dendrite-cm, ' +
                             'button, .dendrite-quota, .dendrite-id, ' +
                             '.dendrite-float-edit')) {
            return;
        }
        const grip = e.target.closest('.dendrite-grip');
        if (grip) {
            const id = grip.parentElement.dataset.id;
            this.select(id, false).then(() => this.roleMenu(id, grip));
            return;
        }
        const card = e.target.closest('.dendrite-card');
        if (card) {
            const id = card.dataset.id;
            if (e.ctrlKey || e.metaKey) this.pickToggle(id);
            else if (e.shiftKey) this.pickRun(id);
            else {
                this.clearPicked();
                this.select(id);
            }
        }
        this.contentEl.focus();
    }

    // ---- picking several cards --------------------------------------

    /** Pick a card, or let it go, with the active card picked as well. */
    pickToggle(id) {
        if (!this.picked.size && this.active && this.active !== id) {
            this.picked.add(this.active);
        }
        if (this.picked.has(id)) this.picked.delete(id);
        else this.picked.add(id);
        this.showPicked();
    }

    /**
     * Pick the run of cards from the active one to `id`, both included:
     * cards side by side under one parent, as the board shows them.
     */
    pickRun(id) {
        const from = this.active && this.byId.get(this.active);
        const to = this.byId.get(id);
        if (!from || !to) return;
        if (from.parent !== to.parent) {
            new Notice('Dendrite: a run is of cards side by side under ' +
                       'one parent.');
            return;
        }
        const sibs = this.kidsOf(from.parent);
        const a = sibs.indexOf(from);
        const b = sibs.indexOf(to);
        if (a < 0 || b < 0) return;
        this.picked = new Set(sibs.slice(Math.min(a, b), Math.max(a, b) + 1)
            .map((n) => n.id));
        this.showPicked();
    }

    clearPicked() {
        if (!this.picked.size) return;
        this.picked.clear();
        this.showPicked();
    }

    showPicked() {
        for (const [id, el] of this.cardEls) {
            el.toggleClass('is-picked', this.picked.has(id));
        }
    }

    /** The picked cards, in reading order. */
    pickedInOrder() {
        return core.allNodes(this.root).filter((n) => this.picked.has(n.id));
    }

    /**
     * Put the picked cards under a new card in the first one's place,
     * in order: `kind` 'section', a card with a heading to write, which
     * numbers them below it; or 'scaffolding', which only groups them,
     * so they print and number as before. Only cards side by side under
     * one parent are grouped. One step to undo.
     */
    async groupPicked(kind) {
        const nodes = this.pickedInOrder();
        if (!nodes.length) return;
        const parent = nodes[0].parent;
        if (!nodes.every((n) => n.parent === parent)) {
            new Notice('Dendrite: only cards side by side under one parent ' +
                       'are grouped.');
            return;
        }
        if (this.refuseWhileArriving() || this.refuseInPrintView()) return;
        const prefix = this.prefix();
        if (!prefix || !core.validPrefix(prefix)) {
            new Notice('Dendrite: set a valid dendrite_prefix first.');
            return;
        }
        if (this.editing) await this.endEdit();
        const body = kind === 'section' ? '# ' : '';
        const id = core.newId(prefix, (x) => this.taken(x));
        const made = await this.createCardFile(id, body);
        if (kind === 'scaffolding') {
            await writeProps(this.app, made, { dendrite_role: 'scaffolding' });
        }
        this.snapshot([], [{ path: made.path, body }]);
        const fresh = core.makeNode(id, '', null);
        core.insertSibling(nodes[0], fresh, false);
        for (const n of nodes) {
            core.remove(n);
            core.appendChild(fresh, n);
        }
        this.reindex();
        this.active = id;
        this.picked.clear();
        if (!await this.writeIndex()) {
            this.undo.pop();
            await this.app.fileManager.trashFile(made);
            return;
        }
        await this.sweepStatuses();
        this.render();
        if (kind === 'section') await this.startEdit(id);
    }

    /**
     * Set a role or a status on every picked card, a status only where
     * the card prints its text; one step to undo.
     */
    async setPicked(what, value) {
        const roleOf = (x) => this.printRoleOf(x);
        const key = what === 'role' ? 'dendrite_role' : 'dendrite_status';
        const restores = [];
        for (const n of this.pickedInOrder()) {
            const f = this.cardFile(n.id);
            if (!f) continue;
            if (what === 'status' && core.roleFor(n, roleOf) !== 'prose') {
                continue;
            }
            const cur = what === 'role' ? this.roleOf(n.id) :
                this.statusOf(n.id);
            if ((cur || null) === (value || null)) continue;
            const data = await this.app.vault.read(f);
            restores.push({ path: f.path, text: data,
                            ifBody: core.splitFrontmatter(data).body });
            await writeProps(this.app, f, { [key]: value || null });
        }
        if (what === 'role') await this.sweepStatuses();
        if (restores.length) {
            this.pushUndo({ active: this.active, files: [], created: [],
                            restores, text: false });
        }
        const n = restores.length;
        new Notice(`Dendrite: ${n} picked card${n === 1 ? '' : 's'} set ` +
                   `to ${what === 'role' ?
                       BRANCH_ROLE_NAMES[value || ''] : value}.`);
    }

    /** Delete every picked card and the cards below it; one undo. */
    async deletePicked() {
        const tops = this.pickedInOrder().filter((n) => {
            for (let p = n.parent; p && p.id; p = p.parent) {
                if (this.picked.has(p.id)) return false;
            }
            return true;
        });
        if (!tops.length || this.refuseWhileArriving() ||
            this.refuseInPrintView()) return;
        if (this.editing) await this.endEdit();
        const doomed = tops.flatMap((n) => [n, ...core.descendants(n)]);
        const files = [];
        for (const n of doomed) {
            const f = this.cardFile(n.id);
            if (f) files.push({ path: f.path,
                                data: await this.app.vault.read(f) });
        }
        this.snapshot(files);
        const gone = new Set(doomed.map((n) => n.id));
        const after = core.allNodes(this.root).find((n) =>
            !gone.has(n.id) && core.allNodes(this.root).indexOf(n) >
            core.allNodes(this.root).indexOf(tops[0]));
        for (const n of tops) core.remove(n);
        this.reindex();
        this.picked.clear();
        this.active = after ? after.id : (this.root.children[0] || {}).id ||
            null;
        if (!await this.writeIndex()) {
            this.undo.pop();
            return;
        }
        for (const n of doomed) {
            const f = this.cardFile(n.id);
            this.invalidate(n.id);
            if (f) await this.app.fileManager.trashFile(f);
        }
        await this.sweepStatuses();
        this.render();
        new Notice(`Dendrite: deleted ${doomed.length} card(s). Ctrl+Z ` +
                   'in the view restores them.');
    }

    /** The menu for the picked cards, from any of them. */
    pickedMenu(anchor, event) {
        const m = dendriteMenu();
        const n = this.picked.size;
        m.addItem((i) => {
            i.setTitle(`${n} cards picked`);
            if (typeof i.setIsLabel === 'function') i.setIsLabel(true);
            else if (typeof i.setDisabled === 'function') i.setDisabled(true);
        });
        m.addSeparator();
        for (const [value, title, icon] of STATUS_ITEMS) {
            m.addItem((i) => i.setTitle(title).setIcon(icon)
                .onClick(() => this.setPicked('status', value)));
        }
        m.addSeparator();
        let sub = null;
        m.addItem((i) => {
            i.setTitle('Prints as');
            if (typeof i.setSubmenu === 'function') sub = i.setSubmenu();
        });
        if (sub) styleMenu(sub, true);
        for (const [value, title, icon] of
            [[null, 'Prints automatically', 'wand'], ...ROLE_ITEMS]) {
            (sub || m).addItem((i) => i.setTitle(sub ? title :
                `Prints as: ${title}`).setIcon(icon)
                .onClick(() => this.setPicked('role', value)));
        }
        m.addItem((i) => i.setTitle(this.menuLabel('Group into a new card…',
                                                   'Ctrl+G'))
            .setIcon('folder-plus')
            .onClick(() => new GroupModal(this).open()));
        m.addSeparator();
        m.addItem((i) => {
            i.setTitle(`Delete ${n} cards and their children`)
                .setIcon('trash-2').onClick(() => this.deletePicked());
            if (typeof i.setWarning === 'function') i.setWarning(true);
        });
        if (event) {
            m.showAtMouseEvent(event);
            return;
        }
        if (anchor) {
            const r = anchor.getBoundingClientRect();
            m.showAtPosition({ x: r.left, y: r.bottom }, this.pageDoc());
        }
    }

    /**
     * Make a card the active one. `move` false highlights it without
     * scrolling, so a menu opened on it stays beside it.
     */
    async select(id, move = true) {
        // Going to a card not picked lets the picked ones go.
        if (id && !this.picked.has(id)) this.clearPicked();
        if (!id || id === this.active) return;
        if (this.editing) await this.endEdit();
        const node = this.byId.get(id);
        const parent = node && this.upOf(node);
        if (parent && parent.id) this.lastChild.set(parent.id, id);
        this.active = id;
        // A card not yet drawn is drawn first, so the board is moved to it
        // at its own height rather than moved again once it is drawn.
        const card = move && this.cardEls.get(id);
        if (card && (card.hasClass('is-slot') ||
                     card.hasClass('is-pending'))) {
            await this.renderCard(id);
            if (this.active !== id) return;
        }
        if (move) this.applyActive();
        else this.highlight();
    }

    navigate(dir) {
        const node = this.active && this.byId.get(this.active);
        if (!node) return;
        if (dir === 'left') {
            const parent = this.upOf(node);
            if (parent && parent.id) this.select(parent.id);
        } else if (dir === 'right') {
            const kids = this.kidsOf(node);
            if (!kids.length) return;
            const last = this.lastChild.get(node.id);
            const pick = kids.find((c) => c.id === last) || kids[0];
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
        // Ctrl and 1 to 3 set the selected card's status, ahead of
        // Obsidian's own Ctrl+1 to 3, which go to a tab. onNavKey reads
        // them too, for when this scope is not active. A whole branch is
        // set from the menu only, as a deliberate change.
        for (const [value, , , key] of STATUS_ITEMS) {
            s.register(['Mod'], key, () => {
                if (this.editing || !this.active) return true;
                this.setStatusByKey(value);
                return false;
            });
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
            if (this.picked.size) {
                this.clearPicked();
                return false;
            }
            if (this.fannedId) {
                this.toggleFan(this.fannedId);
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
        if (!card || this.printOnly) return;
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

    async startEdit(id, atStart = false, at = null) {
        if (this.refuseWhileArriving()) return;
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
        // A table or figure card is edited as its caption and its table
        // or image, unless its text was asked for.
        const kind = this.kindOf(id);
        const asFloat = !!kind && this.asTextOnce !== id;
        this.asTextOnce = null;
        const handlers = {
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
                // Drawing while idle waits for a pause in the typing.
                this.plugin.typedAt = Date.now();
            },
            onBlur: () => { this.save(ed); },
            onEscape: () => { this.endEdit(); },
            onFind: () => { this.openFind(); },
            onRedraw: () => { if (this.find) this.paintFind(); },
            onUndo: () => this.undoInEditor(),
            onRedo: () => this.redoInEditor(),
        };
        const editor = asFloat ? float.floatEditor(Object.assign(handlers, {
            kind,
            label: this.floatOpts().floats.get(id) ||
                (kind === 'table' ? 'Table' : 'Figure'),
            onAsText: () => this.editAsText(id),
            plain: kind === 'table' &&
                this.plugin.settings.floatPlain !== false,
            onPlain: (on) => {
                this.plugin.settings.floatPlain = on;
                if (this.plugin.saveSettings) this.plugin.saveSettings();
                this.sizeFloat();
            },
            render: (md, el) => this.renderInto(md, el, f.path),
            image: (file) => this.saveFigureImage(id, file),
            // Images found by name, linked as Obsidian links them.
            findImage: (input, pick) => noteSuggest(this.app, input, (img) =>
                pick(this.app.metadataCache.getFirstLinkpathDest(img.name,
                    f.path) === img ? img.name : img.path), true),
            // Each field in the card editor: Obsidian's live preview
            // edits a table as a grid, rows, columns and alignment from
            // its own menu.
            makeEditor: (value, h) => this.newEditor({
                value, file: f, onChange: h.onChange, onBlur: h.onBlur,
                onEscape: h.onEscape, onFind: () => this.openFind(),
                onRedraw: () => {}, onUndo: () => false,
                onRedo: () => false,
            }),
        })) : this.newEditor(handlers);
        ed.editor = editor;
        // The text box's own commands (bold, Tab, lists) are Dendrite's;
        // Obsidian's editor brings its own.
        ed.ta = editor.ta || null;
        this.editing = ed;
        this.caretAt = null;
        const card = this.fillFrame(id);
        if (card && editor.kind === 'float') {
            this.mountFloat(card, editor);
        } else if (card) {
            const body = card.querySelector('.dendrite-card-body');
            body.empty();
            body.appendChild(editor.el);
            card.addClass('is-editing');
            card.toggleClass('has-obsidian-editor', editor.kind === 'obsidian');
            card.removeClass('is-pending');
        }
        this.renderToolbar();
        this.focusEditor(editor, atStart, at);
        this.showMode();
        // The rendered card it replaced took find's paint with it.
        if (this.find) this.paintFind();
    }

    /**
     * How a [[link]] in a comment is drawn on the board and in its
     * editor: to one of the manuscript's cards, a link that goes to it.
     */
    cardLinker() {
        return (doc, target, alias) => {
            const id = cardNamed(this.byId.keys(), target);
            return id ? cardRef(this, doc, id, alias || target,
                                () => this.select(id)) : null;
        };
    }

    /** A card's editor: Obsidian's, unless the settings say not. */
    newEditor(handlers) {
        const colours = this.colourOf();
        const nameOf = this.nameOf();
        return cardEditor(this.app, this, Object.assign({
            colourOf: (who) => colours(who || 'Reviewer'),
            pdfOf: (key) => (this.plugin.pdfLinks ?
                this.plugin.pdfLinks.get(key) : null),
            linkOf: this.cardLinker(),
            nameOf,
            onLost: (lost) => {
                const clip = (t) => (t.length > 40 ?
                    `${t.slice(0, 39).trim()}…` : t);
                const said = lost.map((x) => `${x.n} (${nameOf(
                    x.author || 'Reviewer')}: "${clip(x.text.trim())}")`);
                new Notice(`Dendrite: comment${lost.length === 1 ? '' :
                    's'} ${said.join(', ')} no longer mark${lost.length ===
                    1 ? 's' : ''} any text. Undo puts the text back.`, 10000);
            } }, handlers),
                          this.plugin.settings.obsidianEditor !== false);
    }

    /** The caret into a card's new editor, at its start or its end. */
    /**
     * Focus a card's editor: at the text `at` gives, the drawn text
     * around a click (clickedText), where it is found; else at its start
     * or its end.
     */
    focusEditor(editor, atStart, at = null) {
        const off = at && editor.kind !== 'float' && editor.focusAt ?
            review.offsetAt(editor.value, at.before, at.after) : null;
        if (off === null) editor.focus(atStart);
        else editor.focusAt(off);
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
        if (ed.changed && !ed.fromSync) await this.syncAlias(ed.id);
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
            card.removeClass('is-float-editing');
            card.addClass('is-pending');
            const body = card.querySelector('.dendrite-card-body');
            if (body) body.style.minHeight = '';
        }
        this.unmountFloat();
        await this.renderCard(ed.id);
        this.renderToolbar();
        this.showMode();
        this.contentEl.focus();
    }

    // ---- tables and figures, edited wide --------------------------------

    /**
     * A table or figure card's editor, drawn over the board where the card
     * is, as wide as the page's text, since a column is narrower than what
     * it holds. The card keeps its place and grows to the editor's height,
     * so the cards below move down for it.
     */
    mountFloat(card, editor) {
        const stage = this.board && this.board.parentElement;
        if (!stage) return;
        const st = this.manuscript().style || {};
        const el = editor.el;
        el.style.setProperty('--dendrite-float-size',
                             `${st.fontSize || 10}pt`);
        if (st.font) el.style.setProperty('--dendrite-float-font', st.font);
        stage.appendChild(el);
        card.addClass('is-editing');
        card.addClass('is-float-editing');
        card.removeClass('is-pending');
        const body = card.querySelector('.dendrite-card-body');
        if (body) body.empty();
        this.floatEl = el;
        this.floatCard = card;
        this.sizeFloat(false);
        if (typeof ResizeObserver !== 'undefined') {
            this.floatSizer = new ResizeObserver(() => this.placeFloat());
            this.floatSizer.observe(el);
        }
        this.placeFloat();
    }

    unmountFloat() {
        if (this.floatSizer) this.floatSizer.disconnect();
        this.floatSizer = null;
        if (this.floatComp) this.floatComp.unload();
        this.floatComp = null;
        this.floatEl = null;
        this.floatCard = null;
    }

    /** Keep the wide editor over its card as the columns move. */
    /**
     * The table or figure editor's width: the page's text width as it
     * prints, or, a table shown as text, the pane's, set when placed.
     */
    sizeFloat(place = true) {
        const el = this.floatEl;
        if (!el) return;
        const plain = el.hasClass('is-plain');
        const st = this.manuscript().style || {};
        el.style.width = plain ? '' :
            `${Math.round(float.textWidthPt(st))}pt`;
        if (place) this.placeFloat();
    }

    placeFloat() {
        const el = this.floatEl;
        const card = this.floatCard;
        if (!el || !card || !el.parentElement) return;
        const stage = el.parentElement.getBoundingClientRect();
        const r = card.getBoundingClientRect();
        const left = Math.max(0, r.left - stage.left);
        const room = `${Math.max(r.width, stage.width - left - 12)}px`;
        setStyles(el, { left: `${left}px`, top: `${r.top - stage.top}px`,
                        maxWidth: room });
        // Shown as text, as wide as the pane allows, as a note is: the
        // editor's font is larger than the page's.
        if (el.hasClass('is-plain')) {
            el.style.width = `calc(${room} - 34px)`;
        }
        const body = card.querySelector('.dendrite-card-body');
        const extra = r.height - (body ? body.offsetHeight : 0);
        // Its height at the width just set.
        const high = el.offsetHeight;
        if (body && high) {
            setStyles(body, { minHeight: `${Math.max(0, high - extra)}px` });
        }
    }

    /** The card's text in the plain editor, for this visit. */
    async editAsText(id) {
        this.asTextOnce = id;
        if (this.editing) await this.endEdit();
        this.asTextOnce = id;
        await this.startEdit(id);
    }

    /** Markdown drawn into a table or figure editor. */
    async renderInto(md, el, path) {
        if (!this.floatComp) {
            this.floatComp = new Component();
            this.floatComp.load();
        }
        await MarkdownRenderer.render(this.app, md, el, path,
                                      this.floatComp);
    }

    /**
     * An image pasted or dropped on a figure card, saved in figures/ in
     * the manuscript's folder, named for the card, never over another
     * file; answers its embed.
     */
    async saveFigureImage(id, file) {
        const parent = this.file.parent ? this.file.parent.path : '';
        const folder = normalizePath(`${parent}/figures`);
        if (!this.app.vault.getAbstractFileByPath(folder)) {
            await this.app.vault.createFolder(folder);
        }
        const ext = (/\.([a-z0-9]+)$/i.exec(file.name || '') ||
            [null, (file.type || 'image/png').split('/')[1] || 'png'])[1]
            .toLowerCase();
        let name = `${id}.${ext}`;
        for (let k = 2; this.app.vault.getAbstractFileByPath(
            `${folder}/${name}`); k++) {
            name = `${id}-${k}.${ext}`;
        }
        await this.app.vault.createBinary(`${folder}/${name}`,
                                          await file.arrayBuffer());
        return float.embedFor(`figures/${name}`);
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
        // Arrows, Enter, and Ctrl with J, K or L are bound in the view's
        // scope too, but that scope is not always the active one after
        // Obsidian's editor closes, so they are also read here;
        // defaultPrevented means the scope already handled the key.
        if (this.arrowKey(e)) return;
        // Escape closes find here too, for when that scope is not active,
        // and otherwise goes no further, as in the scope.
        if (e.key === 'Escape') {
            e.preventDefault();
            if (this.picked.size) this.clearPicked();
            else if (this.fannedId) this.toggleFan(this.fannedId);
            else if (this.find) this.closeFind();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey &&
            e.key.toLowerCase() === 'g' && this.picked.size) {
            e.preventDefault();
            new GroupModal(this).open();
            return;
        }
        // The number row by its physical key, since what a digit key types
        // with a modifier depends on the keyboard layout; the key's own
        // text where no code is given.
        const code = /^(?:Digit|Numpad)(\d)$/.exec(e.code || '');
        const digit = code ? code[1] : (/^\d$/.test(e.key) ? e.key : null);
        // Ctrl and 1 to 3 set a printing card's status; also registered
        // in the scope, as there.
        const mod = e.ctrlKey || e.metaKey;
        const status = mod && !e.shiftKey && !e.altKey && digit &&
            STATUS_ITEMS.find((r) => r[3] === digit);
        if (status) {
            if (!this.active) return;
            e.preventDefault();
            this.setStatusByKey(status[0]);
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
        // Ctrl with J, K or L makes a card as Ctrl with an arrow does.
        const vim = { j: 'below', k: 'above', l: 'child' }[e.key];
        if (vim && mod && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            this.insert(vim);
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
        if (this.refuseWhileArriving()) {
            await this.reload();
            return false;
        }
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
        if (!ed || this.refuseInPrintView()) return;
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
        if (!await this.writeIndex()) {
            // Not listed: the text stays where it was, and only there.
            await this.app.fileManager.trashFile(made);
            return;
        }
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
        if (this.refuseInPrintView()) return;
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
        if (!await this.writeIndex()) {
            await this.writeCard(dst, () => dstText);
            return;
        }
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
        if (this.refuseWhileArriving() || this.refuseInPrintView()) return;
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
        if (!await this.writeIndex()) {
            this.undo.pop();
            await this.app.fileManager.trashFile(made);
            return;
        }
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
        if (this.refuseInPrintView()) return;
        const node = this.active && this.byId.get(this.active);
        if (!node) return;
        if (this.editing) await this.endEdit();
        const before = core.serialiseTree(this.root);
        // Up or down past the next shown sibling, not an old version
        // hidden in the stack between them.
        const past = (d) => {
            const sibs = node.parent.children;
            let j = sibs.indexOf(node) + d;
            while (sibs[j] && this.isSuperseded(sibs[j].id)) j += d;
            if (!sibs[j]) return false;
            const to = sibs[j];
            core.remove(node);
            core.insertSibling(to, node, d > 0);
            return true;
        };
        const fn = { up: () => past(-1),
                     down: () => past(1),
                     indent: () => core.indent(node),
                     outdent: () => core.outdent(node) }[op];
        if (!fn || !fn()) return;
        this.pushUndo({ tree: before, active: this.active, files: [] });
        await this.writeIndex();
        await this.sweepStatuses();
        this.render();
    }

    // ---- stacks: a card's old versions, kept under it -------------------

    /** Whether a card is an old version, kept in another's stack. */
    isSuperseded(id) {
        return !!this.cardProps(id).dendrite_superseded;
    }

    /** A card's old versions, newest first. */
    stackOf(id) {
        const node = this.byId.get(id);
        return node ? node.children.filter((c) => this.isSuperseded(c.id)) :
            [];
    }

    /**
     * Put `byId`, a card under `topId` or one of its old versions, in
     * its place, or with no `byId` a new empty card: it takes the place,
     * the cards below and the stack, and the card it replaces goes to
     * the top of the stack, hidden and printing nothing. One step to
     * undo.
     */
    async promote(topId, byId = null) {
        if (this.refuseWhileArriving() || this.refuseInPrintView()) return;
        const top = this.byId.get(topId);
        if (!top || this.isSuperseded(topId)) return;
        let by = byId ? this.byId.get(byId) : null;
        if (byId && (!by || by.parent !== top)) return;
        if (this.editing) await this.endEdit();
        // What the new card prints as: what the old one did, set or
        // following from the cards shown below it.
        const set = this.cardProps(topId).dendrite_role;
        const shownBelow = top.children.filter((c) => c !== by &&
            !this.isSuperseded(c.id));
        const role = core.ROLES.includes(set) ? set :
            (shownBelow.length ? 'section' : 'prose');
        const kind = this.kindOf(topId);
        let made = null;
        if (!by) {
            const prefix = this.prefix();
            if (!prefix || !core.validPrefix(prefix)) {
                new Notice('Dendrite: set a valid dendrite_prefix first.');
                return;
            }
            const id = core.newId(prefix, (x) => this.taken(x));
            made = await this.createCardFile(id);
            by = core.makeNode(id, '', null);
        }
        const restores = [];
        for (const n of made ? [top] : [top, by]) {
            const f = this.cardFile(n.id);
            if (!f) continue;
            const data = await this.app.vault.read(f);
            restores.push({ path: f.path, text: data,
                            ifBody: core.splitFrontmatter(data).body });
        }
        const before = core.serialiseTree(this.root);
        if (by.parent) core.remove(by);
        core.insertSibling(top, by, false);
        const shown = top.children.filter((c) => !this.isSuperseded(c.id));
        const stacked = top.children.filter((c) => this.isSuperseded(c.id));
        core.remove(top);
        top.children = [];
        for (const c of [...shown, top, ...stacked]) core.appendChild(by, c);
        this.reindex();
        this.active = by.id;
        this.pushUndo({ tree: before, active: topId, files: [],
                        created: made ? [made.path] : [], restores,
                        text: false });
        if (!await this.writeIndex()) {
            this.undo.pop();
            if (made) await this.app.fileManager.trashFile(made);
            return;
        }
        const d = new Date();
        const today = `${d.getFullYear()}-` +
            `${String(d.getMonth() + 1).padStart(2, '0')}-` +
            `${String(d.getDate()).padStart(2, '0')}`;
        await writeProps(this.app, this.cardFile(topId),
                         { dendrite_superseded: today });
        const props = { dendrite_superseded: null };
        if (!core.ROLES.includes(this.cardProps(by.id).dendrite_role)) {
            props.dendrite_role = role;
        }
        if (kind && !this.kindOf(by.id)) props.dendrite_kind = kind;
        await writeProps(this.app, this.cardFile(by.id), props);
        this.invalidate(topId);
        this.invalidate(by.id);
        await this.sweepStatuses();
        this.render();
        if (made) {
            await this.startEdit(by.id);
            // Until something is typed, Ctrl+Z takes it all back.
            if (this.editing && this.editing.id === by.id) {
                this.editing.fresh = true;
            }
        }
    }

    /**
     * Open review comments and suggested changes on a card's old
     * versions, shown on the card: its versions chip says how many, in
     * the revise colour, and its stack's edges take that colour, so they
     * are not left unresolved under it. Read after the board is drawn.
     */
    async markOpenStacks() {
        const counts = new Map();
        for (const [id, card] of this.cardEls) {
            const stack = this.stackOf(id);
            if (!stack.length) {
                card.removeClass('has-stack-open');
                continue;
            }
            let open = 0;
            for (const v of stack) {
                const f = this.cardFile(v.id);
                if (!f) continue;
                open += review.countComments(review.reviewItems(
                    core.splitFrontmatter(
                        await this.app.vault.cachedRead(f)).body));
            }
            counts.set(id, open);
        }
        this.stackOpen = counts;
        for (const id of counts.keys()) {
            const card = this.cardEls.get(id);
            if (card) this.stackOpenCard(id, card);
        }
    }

    /**
     * A stacked card's open comments, from the last markOpenStacks: its
     * edges flagged and the count on its versions chip.
     */
    stackOpenCard(id, card) {
        const all = this.stackOpen && this.stackOpen.get(id);
        if (all === undefined) return;
        // Fanned out, each old version carries its own flag.
        const open = this.fannedId === id ? 0 : all;
        card.toggleClass('has-stack-open', open > 0);
        const s = card.querySelector(`[data-stack="${id}"]`);
        if (!s) return;
        const n = this.stackOf(id).length + 1;
        s.setText(`${n} versions` + (open ? ` · ${open} open` : ''));
        s.toggleClass('is-revise', open > 0);
        const colour = open && this.plugin.statusColour &&
            this.plugin.statusColour('revise');
        if (colour) s.style.setProperty('--dendrite-chip', colour);
        else s.style.removeProperty('--dendrite-chip');
    }

    /** An old version taken out of a stack, its note to the trash. */
    async deleteVersion(id) {
        const node = this.byId.get(id);
        if (!node || !this.isSuperseded(id) ||
            this.refuseWhileArriving()) return;
        const doomed = [node, ...core.descendants(node)];
        const files = [];
        for (const n of doomed) {
            const f = this.cardFile(n.id);
            if (f) files.push({ path: f.path,
                                data: await this.app.vault.read(f) });
        }
        this.snapshot(files);
        core.remove(node);
        this.reindex();
        if (!await this.writeIndex()) {
            this.undo.pop();
            return;
        }
        for (const n of doomed) {
            const f = this.cardFile(n.id);
            this.invalidate(n.id);
            if (f) await this.app.fileManager.trashFile(f);
        }
        this.render();
    }

    openStack(id) {
        new StackModal(this, id).open();
    }

    /**
     * Fan a card's old versions out to its right, or fold them away; one
     * card's at a time.
     */
    toggleFan(id) {
        this.fannedId = this.fannedId === id ? null : id;
        this.render();
        return this.fanReady;
    }

    /**
     * The fanned card's old versions in a column floating over the next
     * column to its right, newest first beside the card, scrolled through
     * up and down: the columns to its left stay in view.
     */
    async renderFan(stage) {
        for (const c of this.fanComps.splice(0)) c.unload();
        this.fanEl = null;
        const id = this.fannedId;
        const stack = id && !this.printOnly && this.cardEls.has(id) ?
            this.stackOf(id) : [];
        if (!stack.length) {
            this.fannedId = null;
            return;
        }
        const fan = stage.createDiv({ cls: 'dendrite-fan' });
        this.fanEl = fan;
        const head = fan.createDiv({ cls: 'dendrite-fan-head' });
        head.createSpan({ text: `${stack.length} old ` +
            `version${stack.length === 1 ? '' : 's'}, newest first` });
        const b = head.createEl('button', { cls: 'dendrite-fan-btn' });
        setIcon(b, 'x');
        b.setAttr('aria-label', 'Fold the old versions away');
        b.onclick = () => this.toggleFan(id);
        const row = fan.createDiv({ cls: 'dendrite-fan-row' });
        this.placeFan();
        await Promise.all(stack.map((old) =>
            this.renderVersion(row, old.id)));
        this.placeFan();
    }

    /**
     * Keep the fan in the column right of its card as the columns move:
     * its newest version where a card of that column would sit, level
     * with the card, of the card's width, so their text lines up.
     */
    placeFan() {
        const fan = this.fanEl;
        const card = fan && this.cardEls.get(this.fannedId);
        if (!fan || !card || !fan.parentElement) return;
        const stage = fan.parentElement.getBoundingClientRect();
        const r = card.getBoundingClientRect();
        const col = card.closest('.dendrite-col');
        const gap = col ? col.getBoundingClientRect().right - r.right : 12;
        // From the fan's edge to its first version's, which the outline,
        // its padding and its heading take.
        const first = fan.querySelector('.dendrite-version');
        const f = fan.getBoundingClientRect();
        const v = first ? first.getBoundingClientRect() : f;
        const inX = v.left - f.left;
        const inY = v.top - f.top;
        const top = Math.max(8, r.top - stage.top - inY);
        setStyles(fan, {
            left: `${r.right - stage.left + 2 * gap - inX}px`,
            top: `${top}px`,
            width: `${r.width + 2 * inX}px`,
            maxHeight: `${Math.max(160, stage.height - top - 8)}px` });
    }

    /**
     * An old version in the fan: read only, with its review comments,
     * which can be resolved from it. Not a card on the board, so it is
     * never selected or edited.
     */
    async renderVersion(group, id) {
        // Drawn as a card, of a card's width and with its padding, so its
        // text lines up with the card it was replaced by.
        const el = group.createDiv({ cls: 'dendrite-version' });
        el.dataset.id = id;
        el.createDiv({ cls: 'dendrite-version-head',
            text: `Replaced ${this.cardProps(id).dendrite_superseded}, ` +
                `card ${core.shortId(id)}` });
        const body = el.createDiv({ cls: 'dendrite-card-body' });
        const f = this.cardFile(id);
        if (!f) return;
        const text = core.splitFrontmatter(
            await this.app.vault.read(f)).body;
        const comp = new Component();
        comp.load();
        this.fanComps.push(comp);
        const out = body.createDiv({ cls: 'dendrite-md markdown-rendered' });
        const notes = review.reviewItems(text);
        el.toggleClass('has-open', notes.length > 0);
        // Its open comments flagged on it, as on any card.
        if (notes.length) {
            const chip = el.createDiv({ cls: 'dendrite-status' })
                .createSpan({ cls: 'dendrite-status-chip is-revise',
                              text: `${review.countComments(notes)} open ⚑` });
            const colour = this.plugin.statusColour &&
                this.plugin.statusColour('revise');
            if (colour) chip.style.setProperty('--dendrite-chip', colour);
        }
        if (!text.trim()) {
            out.createDiv({ cls: 'dendrite-placeholder',
                            text: 'Empty card' });
            return;
        }
        await MarkdownRenderer.render(this.app,
            notes.length ? review.renderMarkdown(text, this.colourOf()) :
                text, out, f.path, comp);
        zotero.linkCitations(out, text, this.plugin.pdfLinks);
        if (notes.length) {
            review.wrapPassages(out);
            review.decorate(out, notes,
                (n, what, arg) => this.reviewAct(id, n, what, arg),
                (n, e, k) => this.commentMenu(id, n, e, k),
                this.colourOf(), (el) => ownKeys(this.app, el),
                this.nameOf(), id, this.cardLinker());
            externalLinks(out);
        }
    }

    async deleteActive() {
        const node = this.active && this.byId.get(this.active);
        if (!node || this.refuseWhileArriving() ||
            this.refuseInPrintView()) return;
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
        if (!await this.writeIndex()) {
            this.undo.pop();
            return;
        }
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
        // A card's text, or the rounds, changed: what changed since sent.
        this.scheduleChanged();
        if (f === this.file) {
            const text = await this.app.vault.cachedRead(f);
            if (this.selfWrites.delete(text)) {
                this.indexText = text;
                await this.checkVersion(null, text, true);
                return;
            }
            if (this.renaming) return;
            if (indexPrefix(text) !== this.loadedPrefix) {
                // Renamed on another device: the cards it no longer lists
                // are being renamed too, not left out.
                if (this.editing) await this.endEdit();
                this.dropped.clear();
                this.dropBase = null;
                this.indexText = text;
                this.flagIndex();
                new Notice(`Dendrite: ${this.file.basename} was renamed ` +
                           'on another device, to the prefix ' +
                           `${indexPrefix(text)}. The board follows it ` +
                           'as its cards arrive.', 10000);
            } else {
                this.checkDropped(text);
            }
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
        // A slot is drawn from the new text when it is filled; its height
        // is estimated again.
        if (card && card.hasClass('is-slot')) {
            if (this.heights) this.heights.delete(id);
            card.style.height = `${this.slotHeight(id)}px`;
        } else if (card) {
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
        // Closed below to take the synced change: nothing is written in
        // response to it.
        ed.fromSync = true;
        if (ed.dirty) {
            ed.dirty = false;
            this.held.set(ed.id, fm + ed.editor.value);
            await this.endEdit();
            this.reverted.add(ed.id);
            this.revertedAt.set(ed.id, Date.now());
            const node = this.byId.get(ed.id);
            stickyNotice(`card:${this.file.path}:${ed.id}`,
                         `Dendrite: Card ${core.shortId(ed.id)}` +
                         (node && node.label ? ` (${node.label})` : '') +
                         ' changed outside Dendrite while you were ' +
                         'typing in it, usually from a sync. Your typing ' +
                         'was not saved over it. Click "typing kept" on ' +
                         'the card to compare and choose.');
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
        if (!(f instanceof TFile) || this.renaming) return;
        if (f !== this.file && this.loadedPrefix && isIndex(this.app, f) &&
            prefixOf(this.app, f) !== this.loadedPrefix &&
            formersOf(this.app, f).includes(this.loadedPrefix)) {
            // The index renamed on another device, arriving as a new note.
            await this.follow(f);
            return;
        }
        if (f === this.file) {
            this.checkArriving();
            // Reviewer colours changed by hand or on another device.
            const was = review.colourList(this.reviewers());
            this.reviewerMap = null;
            if (review.colourList(this.reviewers()).join('\n') !==
                was.join('\n')) {
                this.recolour();
            }
            // The manuscript's settings changed: numbering and limits.
            this.updateNumbers();
            this.updateCounts();
            return;
        }
        if (!this.byId.has(f.basename)) return;
        // A heading added or removed changes the numbering, and a limit
        // or role set in the card's properties changes what is counted;
        // once for a burst of notes, as a sync or an index brings.
        this.scheduleCardMeta();
        // A label can come from aliases, which only the metadata cache
        // knows once parsed, so labels follow here rather than on modify;
        // in memory only, since the change may have come from a sync.
        if (this.editing && this.editing.id === f.basename) return;
        const body = core.splitFrontmatter(
            await this.app.vault.cachedRead(f)).body;
        this.noteLabel(f.basename, body);
    }

    /**
     * Numbers, roles, statuses and counts brought up to date once, after
     * the cards' notes changed: each is worked out over the whole
     * manuscript, and Obsidian indexing the 2,900 notes of the deep test
     * manuscript ran them about 180 times in 10 s, 2 to 3 s of work.
     */
    scheduleCardMeta() {
        if (this.metaFrame) return;
        this.metaFrame = this.pageWin().requestAnimationFrame(() => {
            this.metaFrame = null;
            if (!this.board) return;
            this.updateNumbers();
            this.updateRoles();
            this.updateStatuses();
            this.scheduleCounts();
        });
    }

    // ---- versions going back ---------------------------------------------

    historyKey(id, path = this.file.path) {
        const vault = this.app.appId ||
            (this.app.vault.getName && this.app.vault.getName()) || 'vault';
        return `${vault}/${id === null ? 'index:' + path : id}`;
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
            stickyNotice(`card:${this.file.path}:${key}`,
                         `Dendrite: ${name} changed outside Dendrite to ` +
                         'text this device had before, usually an old ' +
                         'copy from a sync. Nothing was written. Click ' +
                         `"older copy" on ${id === null ? 'the bar' :
                             'the card'} to compare and choose.`);
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
            stickyNotice(`gone:${this.file.path}`,
                         'Dendrite: the index changed outside Dendrite ' +
                         `and no longer lists ${gone.length} ` +
                         `card${gone.length === 1 ? '' : 's'} whose notes ` +
                         `still exist: ${names}${more}. This is probably ` +
                         'a sync of an old copy. Nothing was written. ' +
                         'Click "older copy" on the bar to compare and ' +
                         'choose.');
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

    // ---- renaming the manuscript ------------------------------------------

    /** The prefixes this manuscript had before, from its index. */
    formers() {
        return this.file ? formersOf(this.app, this.file) : [];
    }

    /**
     * The index's new path, and its folder's when the folder has the
     * index's name, as a manuscript made here does.
     */
    renameTargets(name) {
        const dir = this.file.parent ? this.file.parent.path : '/';
        const top = !dir || dir === '/';
        const parts = top ? [] : dir.split('/');
        const moveFolder = !top && parts[parts.length - 1] ===
            this.file.basename && name !== this.file.basename;
        const newDir = moveFolder ?
            normalizePath([...parts.slice(0, -1), name].join('/')) : dir;
        return { dir, newDir, moveFolder,
                 index: normalizePath((top ? '' : dir + '/') + name + '.md') };
    }

    /** Why the manuscript cannot be renamed so, or null. */
    renameProblem(title, prefix) {
        const name = safeName(title);
        if (!name) return 'give the manuscript a title.';
        if (!core.validPrefix(prefix)) {
            return 'a prefix is letters, digits and single hyphens.';
        }
        const now = this.prefix();
        if (prefix !== now && prefix.toLowerCase() === now.toLowerCase()) {
            return 'a prefix that differs only in capitals is not ' +
                'supported, since some systems treat the file names as ' +
                'the same.';
        }
        const mine = [now, ...this.formers()].map((p) => p.toLowerCase());
        if (!mine.includes(prefix.toLowerCase()) &&
            prefixesInUse(this.app, this.file).has(prefix.toLowerCase())) {
            return `the prefix ${prefix} is already used by another ` +
                'manuscript.';
        }
        if (this.reverted.size || this.oldCopies.length) {
            return 'something on the board is marked as an older or old ' +
                'copy. Compare and choose first.';
        }
        const t = this.renameTargets(name);
        if (name !== this.file.basename &&
            this.app.vault.getAbstractFileByPath(t.index)) {
            return `${t.index} already exists.`;
        }
        if (t.moveFolder && this.app.vault.getAbstractFileByPath(t.newDir)) {
            return `${t.newDir} already exists.`;
        }
        if (name === this.file.basename && prefix === now &&
            !this.renamePlan(prefix).moves.length) {
            return 'that is already its title and prefix.';
        }
        return null;
    }

    /**
     * Each card note to rename to `prefix`: its note under this or an
     * earlier prefix, where the note under the new name is not there
     * yet. A card with notes under both names is a clash.
     */
    renamePlan(prefix) {
        const from = [this.prefix(), ...this.formers()]
            .filter((p) => p !== prefix);
        const to = (id) =>
            from.reduce((x, p) => core.withPrefix(x, p, prefix), id);
        const moves = [];
        const clashes = [];
        for (const n of core.allNodes(this.root)) {
            const id = to(n.id);
            const have = new Set();
            for (const old of [n.id, ...from.map((p) =>
                `${p}-${core.shortId(id)}`)]) {
                const f = old !== id && this.cardFile(old);
                if (f) have.add(f);
            }
            if (!have.size) continue;
            if (have.size > 1 || this.cardFile(id)) clashes.push(id);
            else moves.push({ file: [...have][0], id });
        }
        return { from, to, moves, clashes };
    }

    /**
     * Rename the manuscript: every card note to the new prefix, the
     * index's list and prefix, the index note, and its folder when the
     * folder has the index's name. The old prefix is recorded on the
     * index first, as dendrite_former_prefixes, so a board on another
     * device follows the rename as a sync brings it and tells an old
     * copy that comes back later from a card. Run again with the same
     * title and prefix, it finishes a rename cut short.
     */
    async renameManuscript(title, prefix) {
        const problem = this.renameProblem(title, prefix);
        if (problem) {
            new Notice('Dendrite: not renamed: ' + problem, 10000);
            return false;
        }
        if (this.editing) await this.endEdit();
        await this.flush();
        const name = safeName(title);
        const plan = this.renamePlan(prefix);
        if (plan.clashes.length) {
            stickyNotice(`rename:${this.file.path}`,
                         'Dendrite: not renamed: these cards have a note ' +
                         'under both the old and the new name: ' +
                         plan.clashes.join(', ') + '. Keep one of each ' +
                         'first.');
            return false;
        }
        const target = this.renameTargets(name);
        const old = this.prefix();
        const indexKey = this.historyKey(null);
        const roundsWas = this.roundsPath();
        const fm = this.app.fileManager;
        this.renaming = true;
        let failed = null;
        try {
            const formers = [...new Set([...this.formers(), old])]
                .filter((p) => p !== prefix);
            await writeProps(this.app, this.file, {
                dendrite_former_prefixes: formers.length ? formers : null });
            for (const m of plan.moves) {
                await fm.renameFile(m.file, normalizePath(
                    `${m.file.parent.path}/${m.id}.md`));
            }
            for (const n of core.allNodes(this.root)) n.id = plan.to(n.id);
            this.reindex();
            if (this.active) this.active = plan.to(this.active);
            // Written whole: Obsidian has updated links in the list as
            // each note moved, which is not a change from elsewhere.
            await this.app.vault.process(this.file,
                (data) => core.writeIndexText(data, this.root));
            await writeProps(this.app, this.file,
                             { dendrite_prefix: prefix });
            await this.renameRounds(roundsWas, plan.to);
            for (const n of core.allNodes(this.root)) {
                for (const p of plan.from) {
                    await this.history.adopt(this.historyKey(n.id),
                        this.historyKey(`${p}-${core.shortId(n.id)}`));
                }
            }
            if (name !== this.file.basename) {
                await fm.renameFile(this.file, target.index);
                // The rounds' file keeps the index's name.
                const rounds = this.app.vault.getAbstractFileByPath(
                    roundsWas);
                if (rounds instanceof TFile &&
                    !this.app.vault.getAbstractFileByPath(
                        this.roundsPath())) {
                    await fm.renameFile(rounds, this.roundsPath());
                }
            }
            if (target.moveFolder) {
                await fm.renameFile(
                    this.app.vault.getAbstractFileByPath(target.dir),
                    target.newDir);
                await fm.processFrontMatter(this.file, (props) => {
                    for (const k of PATH_PROPS) {
                        const v = props[k];
                        if (typeof v === 'string' &&
                            v.startsWith(target.dir + '/')) {
                            props[k] = target.newDir +
                                v.slice(target.dir.length);
                        }
                    }
                });
            }
            await this.history.adopt(this.historyKey(null), indexKey);
        } catch (err) {
            console.error('Dendrite: rename failed', err);
            failed = err;
        } finally {
            this.renaming = false;
            // Undo steps name the old notes.
            this.undo = [];
            this.redo = [];
            this.texts.clear();
            this.leaf.updateHeader();
            await this.reload();
        }
        if (failed) {
            stickyNotice(`rename:${this.file.path}`,
                         'Dendrite: the rename stopped part way: ' +
                         failed.message + '. Rename again with the same ' +
                         'title and prefix to finish it.');
            return false;
        }
        new Notice(`Dendrite: renamed to ${name}, cards ${prefix}-…, ` +
                   `${plan.moves.length} card notes renamed.`, 10000);
        return true;
    }

    /** Show `f`, the index this manuscript was renamed to. */
    async follow(f) {
        if (this.editing) await this.endEdit();
        const was = this.file ? this.file.basename : '';
        this.undo = [];
        this.redo = [];
        this.texts.clear();
        this.reverted.clear();
        this.held.clear();
        this.versionInfo.clear();
        this.dropped.clear();
        this.dropBase = null;
        this.indexReverted = false;
        this.file = f;
        this.leaf.updateHeader();
        await this.reload();
        new Notice(`Dendrite: ${was} was renamed to ${f.basename} on ` +
                   'another device; the board shows it under its new ' +
                   'name.', 10000);
        if (this.app.workspace.requestSaveLayout) {
            this.app.workspace.requestSaveLayout();
        }
    }

    scheduleRenameChecks() {
        clearTimeout(this.renameTimer);
        this.renameTimer = setTimeout(() => this.checkArriving(), 200);
        this.scheduleOldCopies();
    }

    /**
     * Count the cards listed under the new prefix whose notes still
     * carry an earlier one: a rename from another device arriving.
     * While any are, the board changes nothing.
     */
    checkArriving(tell = true) {
        if (!this.file || this.renaming) return;
        const now = this.prefix();
        const formers = this.formers().filter((p) => p !== now);
        let n = 0;
        for (const node of formers.length ? core.allNodes(this.root) : []) {
            if (this.cardFile(node.id)) continue;
            const s = core.shortId(node.id);
            if (formers.some((p) => this.cardFile(`${p}-${s}`))) n++;
        }
        const was = this.arriving;
        this.arriving = n;
        if (n === was) return;
        if (n && this.editing) this.endEdit();
        if (!n && tell) {
            new Notice('Dendrite: the rename has arrived; every card is ' +
                       'here under its new name.');
            this.render();
        }
        this.updateStatuses();
    }

    refuseWhileArriving() {
        if (!this.arriving || this.renaming) return false;
        new Notice(`Dendrite: ${this.arriving} ` +
                   `card${this.arriving === 1 ? '' : 's'} renamed on ` +
                   'another device ' +
                   `${this.arriving === 1 ? 'has' : 'have'} not arrived ` +
                   'yet, so the board changes nothing until they do. If ' +
                   'they never arrive, rename again from the settings ' +
                   'with the same title and prefix.', 10000);
        return true;
    }

    scheduleOldCopies() {
        clearTimeout(this.copiesTimer);
        // Late, so a sync part way through a rename, with a note briefly
        // under both names, is not reported.
        this.copiesTimer = setTimeout(() => this.checkOldCopies(), 5000);
    }

    /**
     * Notes under a name this manuscript had before a rename: its index,
     * or a card whose note under the new name exists or which the index
     * no longer lists. A device that had not seen the rename brought
     * them back. They are reported, never used.
     */
    checkOldCopies() {
        if (!this.file || this.renaming) return;
        const now = this.prefix();
        const formers = this.formers().filter((p) => p !== now);
        const out = [];
        for (const f of formers.length ?
            this.app.vault.getMarkdownFiles() : []) {
            if (f === this.file) continue;
            const p = prefixOf(this.app, f);
            if (p && formers.includes(p)) {
                out.push({ file: f, id: null });
                continue;
            }
            const q = formers.find((x) =>
                core.withPrefix(f.basename, x, now) !== f.basename);
            if (!q) continue;
            const id = core.withPrefix(f.basename, q, now);
            if (this.cardFile(id) || !this.byId.has(id)) {
                out.push({ file: f, id: this.byId.has(id) ? id : null });
            }
        }
        const before = new Set(this.oldCopies.map((c) => c.file.path));
        this.oldCopies = out;
        const fresh = out.filter((c) => !before.has(c.file.path));
        if (fresh.length) {
            const names = fresh.slice(0, 5).map((c) => c.file.basename)
                .join(', ');
            const more = fresh.length > 5 ?
                `, and ${fresh.length - 5} more` : '';
            stickyNotice(`copies:${this.file.path}`,
                         `Dendrite: ${fresh.length} ` +
                         `note${fresh.length === 1 ? '' : 's'} under this ` +
                         'manuscript\'s name before its rename came ' +
                         'back, probably from a device that had not ' +
                         `synced: ${names}${more}. They are not used. ` +
                         'Click "old copies" on the bar to see them.');
        }
        if (fresh.length || before.size !== out.length) {
            this.updateStatuses();
        }
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
        this.nums = this.numbers();
        for (const [id, card] of this.liveCards()) this.numberCard(id, card);
    }

    /** A card's section number, from the last updateNumbers. */
    numberCard(id, card) {
        let badge = card.querySelector(':scope > .dendrite-num');
        const num = this.nums && this.nums.get(id);
        if (!num) {
            if (badge) badge.remove();
            return;
        }
        if (!badge) {
            badge = createDiv({ cls: 'dendrite-num' });
            card.prepend(badge);
        }
        badge.setText(num);
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
        return core.cardRole(this.cardProps(id));
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

    /**
     * Set a card's kind; a card set to Table without one starts with a
     * table to fill in. One step to undo.
     */
    async setKind(id, kind) {
        const f = this.cardFile(id);
        if (!f) return;
        const data = await this.app.vault.read(f);
        await writeProps(this.app, f, { dendrite_kind: kind });
        let body = core.splitFrontmatter(data).body;
        if (kind === 'table' && !float.split(body, 'table').content) {
            body = float.compose('table', body, float.STARTER_TABLE);
            await this.writeCard(f, (d) => core.splitFrontmatter(d).fm +
                                 body);
        }
        // Undone with the rest: the undo puts back the whole file.
        await this.syncAlias(id);
        this.pushUndo({ active: this.active, files: [], created: [],
                        restores: [{ path: f.path, text: data,
                                     ifBody: body }], text: false });
        this.invalidate(id);
        await this.renderCard(id);
        await this.sweepStatuses();
    }

    async setRole(id, role) {
        const f = this.cardFile(id);
        if (f) await writeProps(this.app, f, { dendrite_role: role });
        // Printing or not, it and the cards under it gain or lose their
        // aliases.
        const node = this.byId.get(id);
        for (const n of node ? [node, ...core.allNodes(node)] : []) {
            await this.syncAlias(n.id);
        }
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
        await this.markStatus(this.active, status);
    }

    /**
     * Ask for a returned Word file, or a JSON list of review comments,
     * then show what it says and where in the cards, to choose which to
     * add.
     */
    importReview() {
        const input = this.pageDoc().createElement('input');
        input.type = 'file';
        input.accept = '.docx,.json,application/vnd.openxmlformats-' +
            'officedocument.wordprocessingml.document,application/json';
        input.onchange = async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            await this.reviewFrom(file.name, await file.arrayBuffer());
        };
        input.click();
    }

    /** The Google Doc this manuscript is linked to, or null. */
    gdocUrl() {
        const fm = this.file &&
            this.app.metadataCache.getFileCache(this.file)?.frontmatter;
        return fm && typeof fm.dendrite_gdoc === 'string' ?
            fm.dendrite_gdoc : null;
    }

    /**
     * Bring in the linked Google Doc's open comments and suggested
     * changes through the review dialog, as from a returned Word file.
     */
    async pullGdoc() {
        const url = this.gdocUrl();
        if (!url) {
            new Notice('Dendrite: link a Google Doc in the manuscript\'s ' +
                       'settings first.');
            return null;
        }
        let r;
        try {
            r = await this.plugin.gdocReview(url);
        } catch (err) {
            new Notice(`Dendrite: could not read the Google Doc ` +
                       `(${err.message}).`, 10000);
            return null;
        }
        if (!r) return null;
        if (!r.items.length) {
            new Notice(`Dendrite: ${r.title || 'the doc'} has no open ` +
                       'comments or suggested changes' + (r.resolved ?
                           `; ${r.resolved} resolved left out.` : '.'));
            return null;
        }
        return this.reviewModal(`${r.title || 'Google Doc'} (Google Docs)`,
                                r.items);
    }

    /**
     * Keys of the review comments and changes resolved, applied or
     * dismissed in this manuscript: those in its review log, and those
     * kept on the index before there was one.
     */
    async reviewDone() {
        if (!this.file) return [];
        const keys = reviewlog.keysOf(
            await readReviewLog(this.app, this.file));
        for (const k of this.legacyDone()) keys.add(k);
        return [...keys];
    }

    /** The keys kept on the index before the review log, as text. */
    legacyDone() {
        const fm = this.file &&
            this.app.metadataCache.getFileCache(this.file)?.frontmatter;
        const d = fm && fm.dendrite_review_done;
        return Array.isArray(d) ? d.map(String) : [];
    }

    /**
     * Log a comment or change of card `card` as dealt with by `action`.
     * Keys kept on the index from before go into the log first, and off
     * the index once they are in it.
     */
    async rememberDone(item, action, card) {
        if (!this.file) return;
        const at = new Date().toISOString();
        const legacy = this.legacyDone();
        const lines = [];
        if (legacy.length) {
            lines.push({ at, action: null, keys: legacy,
                         from: 'dendrite_review_done' });
        }
        lines.push(reviewlog.entry(item, action, card, at));
        await appendReviewLog(this.app, this.file, lines);
        if (legacy.length) {
            await this.app.fileManager.processFrontMatter(this.file,
                (fm) => { delete fm.dendrite_review_done; });
        }
    }

    /** Every old version kept in a stack, with its whole text. */
    async oldVersionCards() {
        const bodies = await this.loadBodies();
        return core.allNodes(this.root).filter((n) =>
            this.isSuperseded(n.id) && bodies.has(n.id))
            .map((n) => ({ id: n.id, text: bodies.get(n.id) }));
    }

    /** The end of a card's printed text, as where a comment goes. */
    endOf(id, cards) {
        const text = (cards.find((c) => c.id === id) || { text: '' })
            .text.trimEnd();
        return { id, start: text.length, end: text.length };
    }

    /**
     * Where review comments come in from: the linked Google Doc, a file,
     * and reviews programs sent that wait to be added.
     */
    reviewMenu(event) {
        const m = dendriteMenu(false);
        const linked = this.gdocUrl();
        if (linked) {
            m.addItem((i) => i.setTitle('Pull from Google Docs')
                .onClick(() => this.pullGdoc()));
        }
        if (Platform.isDesktopApp) {
            if (linked) {
                m.addItem((i) => i.setTitle('Open the linked doc')
                    .onClick(() => openExternal(linked)));
            }
            m.addItem((i) => i.setTitle(linked ? 'Change the linked doc…' :
                                        'Link a Google Doc…')
                .onClick(() => this.plugin.linkGdoc(this.file)));
        }
        m.addSeparator();
        m.addItem((i) => i.setTitle('Import a Word or JSON file…')
            .onClick(() => this.importReview()));
        m.addItem((i) => i.setTitle('Reviewers…')
            .onClick(() => new ReviewersModal(this).open()));
        m.addItem((i) => i.setTitle('Mark as sent for review…')
            .onClick(() => new RoundModal(this).open()));
        if (event && m.showAtMouseEvent) m.showAtMouseEvent(event);
        return m;
    }

    openManuscriptSettings() {
        new ManuscriptModal(this).open();
    }

    /** Light the Preview button while this manuscript's preview is open. */
    /** The Comments button lit while review is on. */
    showReviewOn() {
        if (!this.commentsBtn) return;
        this.commentsBtn.toggleClass('is-on',
            !!(this.plugin.reviewOn && this.plugin.reviewOn()));
    }

    showPreviewOn() {
        if (this.previewBtn && this.plugin.previewOpen) {
            this.previewBtn.toggleClass('is-on',
                                        this.plugin.previewOpen(this.file));
        }
    }

    /** Submitted reviews for this manuscript, waiting on the bar. */
    refreshInbox() {
        const q = this.plugin.reviewQueue ? this.plugin.reviewQueue() : [];
        const prefixes = [this.prefix(), ...this.formers()].filter(Boolean);
        const out = q.filter((r) => r.state === 'pending' &&
                             prefixes.includes(r.manuscript));
        const key = (l) => l.map((r) => r.id).join(' ');
        const changed = key(out) !== key(this.inbox);
        this.inbox = out;
        this.showInboxBadge();
        if (changed) this.updateStatuses();
    }

    /**
     * The Inbox button, shown only while reviews or requests wait, the
     * count in a block on its right.
     */
    showInboxBadge() {
        const b = this.inboxBtn;
        if (!b) return;
        const old = b.querySelector('.dendrite-bar-badge');
        if (old) old.remove();
        const n = (this.inbox || []).length;
        b.toggleClass('is-hidden', !n);
        b.toggleClass('is-waiting', n > 0);
        if (!n) return;
        const badge = b.createSpan({ cls: 'dendrite-bar-badge',
                                     text: String(n) });
        badge.setAttr('aria-label', `${n} review${n === 1 ? '' : 's'} ` +
                      'waiting to be added');
    }

    /** What waits, as an inbox, each opening it; nothing when none. */
    openInboxList() {
        if (!(this.inbox || []).length) return;
        new InboxModal(this).open();
    }

    /** Show a submitted review's comments to add, or ignore it. */
    async openInbox(entry) {
        if (entry.kind === 'revise') {
            const rows = [];
            for (const item of entry.items) {
                const f = this.cardFile(item.card);
                const got = !f ? { reason: `no card ${item.card}` } :
                    item.current === undefined ?
                        { reason: 'not found when it was sent' } :
                        review.findSuggestion(core.splitFrontmatter(
                            await this.app.vault.read(f)).body,
                        { ...item, was: item.current });
                rows.push({ item, it: got.it || null, reason: got.reason,
                            use: !got.reason });
            }
            const modal = new ReviseModal(this, entry, rows);
            modal.open();
            return modal;
        }
        return this.reviewModal(entry.title, entry.items, entry);
    }

    /**
     * Accepted changes to suggestions, `rows` as ReviseModal has them:
     * each suggestion found again and its text changed or taken out, a
     * card at a time, one undo step each, and each change logged.
     */
    async applyRevisions(rows) {
        const at = new Date().toISOString();
        const logged = [];
        const byCard = new Map();
        for (const row of rows) {
            if (!byCard.has(row.item.card)) byCard.set(row.item.card, []);
            byCard.get(row.item.card).push(row.item);
        }
        for (const [id, items] of byCard) {
            const f = this.cardFile(id);
            if (!f) continue;
            let md = core.splitFrontmatter(await this.app.vault.read(f))
                .body;
            const was = md;
            for (const item of items) {
                const got = review.findSuggestion(md,
                    { ...item, was: item.current });
                if (got.reason) continue;
                const e = reviewlog.entry(got.it, item.withdraw ?
                    'withdraw' : 'revise', id, at);
                if (item.withdraw) {
                    md = review.removeItem(md, got.n);
                } else {
                    md = review.reviseSuggestion(md, got.n, item.replace,
                                                 localDay());
                    e.to = item.replace;
                }
                logged.push(e);
            }
            if (md !== was) await this.reviewAction(id, 0, 'text', md);
        }
        if (logged.length && this.file) {
            await appendReviewLog(this.app, this.file, logged);
        }
        return logged.length;
    }

    /** A submitted review added or ignored: not offered again. */
    async takeInbox(entry, state) {
        if (this.plugin.settleReview) {
            await this.plugin.settleReview(entry.id, state);
        }
        this.refreshInbox();
    }

    /** Show the review in a file, `data` its bytes, to choose from. */
    async reviewFrom(name, data) {
        const buf = require('buffer').Buffer.from(data);
        const json = /\.json$/i.test(name);
        let items;
        try {
            items = json ? review.readReviewJson(buf.toString('utf8')) :
                review.readReview(buf, require('zlib'));
        } catch (err) {
            new Notice(`Dendrite: ${name} could not be read as ` +
                       `${json ? 'a review list' : 'a Word file'} ` +
                       `(${err.message}).`);
            return null;
        }
        if (!items.length) {
            new Notice(`Dendrite: ${name} has no comments` +
                       `${json ? '' : ' or tracked changes'}.`);
            return null;
        }
        return this.reviewModal(name, items);
    }

    /**
     * Show review items, each with where in the cards it was found, to
     * choose which to add; `inbox`, the submitted review they came from.
     */
    async reviewModal(name, items, inbox = null) {
        const cards = await this.reviewCards();
        const old = await this.oldVersionCards();
        const doneKeys = new Set(await this.reviewDone());
        const bodies = new Map();
        const body = async (id) => {
            if (!bodies.has(id)) {
                const f = this.cardFile(id);
                bodies.set(id, f ? core.splitFrontmatter(
                    await this.app.vault.read(f)).body : '');
            }
            return bodies.get(id);
        };
        const rows = [];
        const aligned = new Map();
        for (const item of items) {
            const at = this.placeReview(item, cards, old, aligned);
            // Already in its card or the card's old versions, as from the
            // same review sent twice: shown, but not added again unless
            // ticked.
            let dup = false;
            if (at) {
                const texts = [await body(at.id)];
                for (const v of this.stackOf(at.id)) {
                    texts.push(await body(v.id));
                }
                dup = review.alreadyIn(texts.join('\n\n'), item);
            }
            // Resolved, applied or dismissed here before, which a doc
            // still holding it open would otherwise bring back.
            const done = !dup && review.reviewKeys(item)
                .some((k) => doneKeys.has(k));
            // Already in, from before links were kept: it gains its link.
            let relink = null;
            if (dup && at && item.link) {
                for (const cid of [at.id, ...this.stackOf(at.id)
                    .map((v) => v.id)]) {
                    if (review.needsLink(await body(cid), item)) {
                        relink = cid;
                        break;
                    }
                }
            }
            rows.push({ item, at, dup, done, relink: !!relink,
                        relinkId: relink, use: !!at && !dup && !done });
        }
        const modal = new ReviewImportModal(this, name, rows, inbox);
        modal.open();
        return modal;
    }

    /**
     * Where a review item goes, `cards` the cards as they print and `old`
     * their earlier versions, `aligned` keeping each pair of versions
     * lined up once: { id, start, end, how }, or null. As it was sent to
     * a current card, 'exact'. Else as it was sent to an earlier version,
     * carried to the card that replaced it where its text is still there
     * (review.mapThrough), 'mapped': a change is not put on a version
     * that does not print. Else found by most of its words, 'close'. Else
     * in an earlier version only, at the end of the card that replaced
     * it, its passage to be quoted, 'old'.
     */
    placeReview(item, cards, old, aligned = new Map()) {
        const at = review.locate(item, cards);
        if (at && at.how === 'exact') return at;
        const o = review.locate(item, old);
        const top = o && this.byId.get(o.id) && this.byId.get(o.id).parent;
        if (o && o.how === 'exact' && top && top.id) {
            const was = old.find((c) => c.id === o.id);
            const now = cards.find((c) => c.id === top.id);
            if (was && now) {
                const key = `${o.id}\u0000${top.id}`;
                if (!aligned.has(key)) {
                    aligned.set(key, review.alignWords(was.text, now.text));
                }
                const m = review.mapThrough(aligned.get(key), was.text,
                                            now.text, o.start, o.end);
                if (m) {
                    return { id: top.id, start: m.start, end: m.end,
                             how: 'mapped', from: o.id };
                }
            }
        }
        if (at) return at;
        if (top && top.id) {
            return Object.assign(this.endOf(top.id, cards),
                                 { how: 'old', from: o.id });
        }
        return null;
    }

    /**
     * Every card's text, in reading order, for finding passages in: only
     * what export prints, since that is what a reviewer was sent; the
     * rest blanked, so offsets still point into the card.
     */
    async reviewCards() {
        await this.flush();
        const bodies = await this.loadBodies();
        const roleOf = (x) => this.printRoleOf(x);
        return core.allNodes(this.root).filter((n) => bodies.has(n.id))
            .map((n) => ({ id: n.id, text: core.printedOnly(
                bodies.get(n.id), core.roleFor(n, roleOf)) }));
    }

    /**
     * Write the chosen comments and changes into their cards, each card
     * found again in its text as it is now; one step to undo. The cards
     * show revise while the comments are open. A change goes in as one to
     * apply only where its passage is still exactly as it was sent.
     */
    async addReview(rows, fallback, relinks = []) {
        const cards = await this.reviewCards();
        const old = await this.oldVersionCards();
        const aligned = new Map();
        const byId = new Map();
        let placed = 0;
        let missed = 0;
        for (const row of rows) {
            const item = row.item;
            let at = this.placeReview(item, cards, old, aligned);
            let add;
            // Only one never found goes on the selected card; one found
            // before but not now has gone with its text.
            if (!at && !row.at && fallback) {
                at = Object.assign(this.endOf(fallback.id, cards),
                                   { how: 'none' });
            }
            if (!at) {
                missed++;
                continue;
            }
            const quoted = !item.quote ? '' :
                at.how === 'none' ? `On “${item.quote}”: ` :
                at.how === 'old' ?
                    `On “${item.quote}”, in an earlier version: ` : '';
            if (item.kind === 'comment') {
                add = { kind: 'review', text: quoted + item.text +
                        (item.link ? ` ${item.link}` : '') };
            } else if (at.how === 'exact' || at.how === 'mapped' ||
                       (!item.quote && at.how === 'close')) {
                // An addition takes nothing away, so one found only by
                // most of the words around it still goes in to apply,
                // checked in the Apply dialog; a replacement there may
                // no longer have its text, and goes in as a comment.
                add = { kind: 'suggest', text: item.insert,
                        quote: item.quote };
            } else {
                add = { kind: 'review',
                        text: quoted + review.changeAsComment(item) };
            }
            Object.assign(add, { start: at.how === 'none' ||
                                     at.how === 'old' ? at.end : at.start,
                                 end: at.end, author: item.author,
                                 date: item.date });
            if (!byId.has(at.id)) byId.set(at.id, []);
            byId.get(at.id).push(add);
            placed++;
        }
        const restores = [];
        // Comments already in, given their Google Docs links.
        const linked = new Map();
        for (const row of relinks) {
            if (!linked.has(row.relinkId)) linked.set(row.relinkId, []);
            linked.get(row.relinkId).push(row.item);
        }
        for (const [id, items] of linked) {
            if (byId.has(id)) continue;
            const f = this.cardFile(id);
            if (!f) continue;
            const data = await this.app.vault.read(f);
            const out = await this.writeCard(f, (d) => {
                const { fm, body } = core.splitFrontmatter(d);
                return fm + items.reduce((md, it) => review.addLink(md, it),
                                         body);
            });
            restores.push({ path: f.path, text: data,
                            ifBody: core.splitFrontmatter(out).body });
            this.invalidate(id);
            if (this.cardEls.has(id)) await this.renderCard(id);
        }
        for (const [id, adds] of byId) {
            const f = this.cardFile(id);
            if (!f) continue;
            const data = await this.app.vault.read(f);
            const relinked = linked.get(id) || [];
            const out = await this.writeCard(f, (d) => {
                const { fm, body } = core.splitFrontmatter(d);
                return fm + relinked.reduce((md, it) =>
                    review.addLink(md, it), review.addItems(body, adds));
            });
            restores.push({ path: f.path, text: data,
                            ifBody: core.splitFrontmatter(out).body });
            // No status is written: a card shows revise while it has open
            // comments (core.statusReport), and not once they are dealt
            // with, so a revise set by hand is not mistaken for one.
            this.invalidate(id);
            await this.renderCard(id);
        }
        if (restores.length) {
            this.pushUndo({ active: this.active, files: [], text: true,
                            restores });
        }
        const n = restores.length;
        new Notice(`Dendrite: ${placed} added to ${n} card` +
            `${n === 1 ? '' : 's'}` + (missed ? `; ${missed} no longer ` +
            'found, left out.' : '.'));
    }

    /**
     * A review comment's button: resolve or dismiss takes the comment
     * out and leaves the passage; apply shows the card with the change
     * first. One step to undo either way.
     */
    /** A review comment's right-click menu, Delete from Dendrite in it. */
    commentMenu(id, n, event, reply = null) {
        const f = this.cardFile(id);
        if (!f) return;
        this.app.vault.cachedRead(f).then((data) => {
            const it = review.reviewItems(core.splitFrontmatter(data)
                .body)[n];
            if (!it) return;
            // A reply's own menu: taking it back.
            if (reply !== null && reply !== undefined) {
                showCommentMenu([['unreply', 'Delete reply', true]], event,
                    () => this.reviewAction(id, n, 'unreply', reply));
                return;
            }
            const who = it.author || 'Reviewer';
            showCommentMenu(review.commentMenu(it), event,
                            (what) => this.reviewAction(id, n, what), {
                                author: this.nameOf()(who),
                                current: this.colourOf()(who),
                                pick: (c) => this.setReviewerColour(who, c),
                            });
        });
    }

    // ---- a colour per reviewer -------------------------------------------

    /** The manuscript's reviewer colours, as kept in its index. */
    reviewers() {
        if (!this.reviewerMap) {
            const fm = (this.file && this.app.metadataCache
                .getFileCache(this.file)?.frontmatter) || {};
            this.reviewerMap = review.reviewerColours(
                fm.dendrite_reviewer_colours);
        }
        return this.reviewerMap;
    }

    /**
     * The names your replies are signed with: the name set, and Me, the
     * name a reply is signed with when none is, as earlier ones were.
     */
    selfNames() {
        return new Set([this.plugin.settings.replyName || 'Me', 'Me']);
    }

    colourOf() {
        const map = this.reviewers();
        // Replies signed Me are yours, in your colour, which is kept under
        // the name you sign with now.
        const me = this.plugin.settings.replyName || 'Me';
        const mine = this.selfNames();
        return (who) => (mine.has(who) && map.has(me) ? map.get(me) :
            map.get(who) || null);
    }

    /**
     * Your names other than the one you sign with now: Me, once you sign
     * with your name, which is given no colour of its own.
     */
    otherSelves() {
        const me = this.plugin.settings.replyName || 'Me';
        return [...this.selfNames()].filter((x) => x !== me);
    }

    /** A reviewer name as the person it is linked to, or as it is. */
    nameOf() {
        const fm = this.file &&
            this.app.metadataCache.getFileCache(this.file)?.frontmatter;
        const names = review.reviewerNames(
            fm && fm.dendrite_reviewer_colours);
        const mine = this.selfNames();
        const shown = this.plugin.settings.presentName;
        return (who) => (shown && mine.has(who) ? shown :
            names.get(who) || who);
    }

    /**
     * The reviewers of a card's comments, noted as it is drawn; one not
     * yet given a colour is given one, once the cards drawn now are.
     */
    noteReviewers(id, notes) {
        this.reviewersOf = this.reviewersOf || new Map();
        // Those who replied as well, so a reply is drawn in its writer's
        // colour.
        const names = [...new Set(notes.flatMap((x) => [
            x.author || 'Reviewer',
            ...(x.replies || []).map((r) => r.author || 'Me')]))];
        this.reviewersOf.set(id, names);
        const map = this.reviewers();
        if (names.some((x) => !map.has(x)) && !this.colourTimer) {
            this.colourTimer = this.pageWin().setTimeout(() => {
                this.colourTimer = null;
                this.assignReviewers();
            }, 0);
        }
    }

    /**
     * Colours for the reviewers not yet given one, in reading order, so
     * the first to comment in the manuscript is given the first colour;
     * written to the index, and their comments drawn again in them.
     */
    async assignReviewers() {
        const names = [];
        for (const n of core.allNodes(this.root)) {
            names.push(...((this.reviewersOf || new Map()).get(n.id) || []));
        }
        const others = this.otherSelves();
        const { map, added } = review.assignColours(this.reviewers(),
            names.filter((x) => !others.includes(x)));
        if (added) await this.saveReviewers(map);
    }

    /** Reviewers [{ name, note, colour }] kept, as the dialog sets them. */
    async saveEntries(entries) {
        if (!this.file) return;
        this.reviewerMap = new Map(entries.map((e) => [e.name, e.colour]));
        await writeProps(this.app, this.file,
                         { dendrite_reviewer_colours:
                               review.entryList(entries) });
        this.recolour();
    }

    /** A reviewer's colour, and so every name linked to their note. */
    async setReviewerColour(who, colour) {
        const fm = this.app.metadataCache.getFileCache(this.file)
            ?.frontmatter || {};
        const kept = review.reviewerEntries(fm.dendrite_reviewer_colours);
        const note = (kept.find((e) => e.name === who) || {}).note;
        const map = new Map(this.reviewers());
        map.set(who, colour);
        for (const e of kept) {
            if (note && e.note === note) map.set(e.name, colour);
        }
        await this.saveReviewers(map);
    }

    async saveReviewers(map) {
        if (!this.file) return;
        const fm = this.app.metadataCache.getFileCache(this.file)
            ?.frontmatter || {};
        const list = review.colourList(map, fm.dendrite_reviewer_colours);
        this.reviewerMap = map;
        await writeProps(this.app, this.file,
                         { dendrite_reviewer_colours: list });
        this.recolour();
    }

    /** The cards with comments drawn again in their reviewers' colours. */
    recolour() {
        for (const [id, names] of this.reviewersOf || new Map()) {
            if (!names.length) continue;
            this.invalidate(id);
            // A slot is drawn afresh when it is filled.
            const card = this.cardEls.get(id);
            if (card && !card.hasClass('is-slot')) this.renderCard(id);
        }
    }

    /**
     * Take a Google comment, known by `gid` ('g:' and its id), out of
     * every card it is on, old versions too, its passages left as they
     * were; one step to undo.
     */
    async resolveEverywhere(gid) {
        const restores = [];
        for (const node of core.allNodes(this.root)) {
            const f = this.cardFile(node.id);
            if (!f) continue;
            const data = await this.app.vault.read(f);
            const { body } = core.splitFrontmatter(data);
            const hits = review.reviewItems(body).map((x, k) =>
                review.reviewKeys(x).includes(gid) ? k : -1)
                .filter((k) => k >= 0);
            if (!hits.length) continue;
            let next = body;
            for (const k of hits.reverse()) next = review.removeItem(next, k);
            const out = await this.writeCard(f, (d) =>
                core.splitFrontmatter(d).fm + next);
            restores.push({ path: f.path, text: data,
                            ifBody: core.splitFrontmatter(out).body });
            this.invalidate(node.id);
            if (this.cardEls.has(node.id)) await this.renderCard(node.id);
        }
        if (restores.length) {
            this.pushUndo({ active: this.active, files: [], text: true,
                            restores });
        }
        if (this.fannedId) {
            this.render();
            await this.fanReady;
        }
    }

    /**
     * A comment of the writer's own, `said`, on the passage selected in
     * the card being typed in, signed with their reply name; false when
     * nothing is selected. A change to the text, in the editor's history.
     */
    commentOnSelection(said, range = null) {
        const ed = this.editing;
        if (!ed || !ed.editor.update || !String(said || '').trim()) {
            return false;
        }
        const [a, b] = range || ed.editor.selection();
        if (a === b) return false;
        const body = ed.editor.value;
        ed.editor.update(review.addItems(body, [{ kind: 'review',
            start: a, end: b, date: localDay(), text: said,
            author: this.plugin.settings.replyName || 'Me' }]));
        ed.dirty = true;
        ed.changed = true;
        this.save(ed);
        return true;
    }

    /** Asks for a comment on the selected passage, then adds it. */
    askComment() {
        const ed = this.editing;
        const range = ed && ed.editor.update ? ed.editor.selection() : null;
        if (!range || range[0] === range[1]) {
            new Notice('Dendrite: select the passage to comment on.');
            return;
        }
        new CommentModal(this.app, (said) =>
            this.commentOnSelection(said, range)).open();
    }

    /**
     * A reply from a program to the comment `tid` on card `id`; its
     * index, or -1 when there is no such comment. In the card's editor if
     * it is being typed in, which stays open, as a change to the text.
     */
    async replyFrom(id, tid, reply) {
        const ed = this.editing;
        if (ed && ed.id === id && ed.editor.update) {
            const body = ed.editor.value;
            const n = review.threadIds(review.reviewItems(body))
                .indexOf(tid);
            if (n < 0) return n;
            const out = withReply(body, n, reply);
            if (out === false) return NOT_COMMENT;
            if (out === null) return REFUSED;
            ed.editor.update(out);
            ed.dirty = true;
            ed.changed = true;
            await this.save(ed);
            return n;
        }
        const f = this.cardFile(id);
        if (!f) return -1;
        const { body } = core.splitFrontmatter(await this.app.vault.read(f));
        const n = review.threadIds(review.reviewItems(body)).indexOf(tid);
        if (n < 0) return n;
        const out = withReply(body, n, reply);
        if (out === false) return NOT_COMMENT;
        if (out === null) return REFUSED;
        await this.reviewAction(id, n, 'text', out);
        return n;
    }

    /**
     * A suggested change from a program on card `id`; why it was not
     * added, or null. In the card's editor if it is being typed in.
     */
    async suggestIn(id, item) {
        const ed = this.editing;
        if (ed && ed.id === id && ed.editor.update) {
            const out = review.suggestInto(ed.editor.value, id, item);
            if (out.reason) return out.reason;
            ed.editor.update(out.md);
            ed.dirty = true;
            ed.changed = true;
            await this.save(ed);
            return null;
        }
        const f = this.cardFile(id);
        if (!f) return `no card ${id}`;
        const { body } = core.splitFrontmatter(await this.app.vault.read(f));
        const out = review.suggestInto(body, id, item);
        if (out.reason) return out.reason;
        await this.reviewAction(id, 0, 'text', out.md);
        return null;
    }

    /** A comment's button on a card: its priority's menu, or the rest. */
    reviewAct(id, n, what, arg) {
        if (what !== 'priority-menu') {
            return this.reviewAction(id, n, what, arg);
        }
        const b = this.bodies && this.bodies.get(id);
        const body = b && b.body || '';
        const it = review.reviewItems(body)[n];
        priorityMenu(arg, it && it.priority, (p) =>
            this.reviewAction(id, n, 'priority', p));
        return null;
    }

    async reviewAction(id, n, what, arg = null) {
        const f = this.cardFile(id);
        if (!f) return;
        if (this.editing && this.editing.id === id) await this.endEdit();
        const data = await this.app.vault.read(f);
        const { fm, body } = core.splitFrontmatter(data);
        const write = async (text) => {
            const out = await this.writeCard(f, () => fm + text);
            this.pushUndo({ active: id, files: [], text: true,
                restores: [{ path: f.path, text: data,
                             ifBody: core.splitFrontmatter(out).body }] });
            this.invalidate(id);
            await this.renderCard(id);
            // An old version fanned out is drawn with the board.
            if (!this.cardEls.has(id)) {
                this.render();
                await this.fanReady;
            }
        };
        const item = review.reviewItems(body)[n];
        // A reply, written under its comment, or taken back: a change to
        // the card, undone as one.
        // A card's new text, as with a program's suggested change.
        if (what === 'text') {
            await write(arg);
            return;
        }
        // A triage priority, on the comment's marker.
        if (what === 'priority') {
            const out = review.setPriority(body, n, arg);
            if (out !== body) await write(out);
            return;
        }
        // A program's reply comes signed and dated.
        if (what === 'reply') {
            await write(review.addReply(body, n, typeof arg === 'object' ?
                arg : { author: this.plugin.settings.replyName || 'Me',
                        date: localDay(), text: arg }));
            return;
        }
        if (what === 'unreply') {
            await write(review.removeReply(body, n, arg));
            return;
        }
        // Applied, its replies go with it, or, where they say something,
        // can stay open as a comment on the new text.
        if (what === 'apply') {
            const after = review.removeItem(body, n, true);
            const done = (text) => async () => {
                await write(text);
                if (item) await this.rememberDone(item, 'apply', id);
            };
            const replies = item ? review.keptReplies(item) : [];
            new SuggestModal(this, id, body, after, done(after),
                item && this.colourOf()(item.author || 'Reviewer'),
                replies, replies.length ?
                    done(review.applyKeeping(body, n)) : null).open();
            return;
        }
        // A Google comment on several passages comes in as one comment
        // per passage; resolved, it is resolved on all of them.
        const gid = what === 'resolve' && item && review.reviewKeys(item)
            .find((k) => k.startsWith('g:'));
        if (gid) {
            await this.resolveEverywhere(gid);
            await this.rememberDone(item, what, id);
            return;
        }
        await write(review.removeItem(body, n));
        // Deleted, as misplaced, it is not remembered: a pull offers it
        // again, to be placed where it belongs.
        if (item && what !== 'delete') {
            await this.rememberDone(item, what, id);
        }
    }

    async setStatus(id, status) {
        const f = this.cardFile(id);
        if (!f) return;
        if ((this.statusOf(id) || null) === (status || null)) return;
        await writeProps(this.app, f, { dendrite_status: status || null });
    }

    /** A status set by hand: a key, a menu or a chip. One undo step. */
    async markStatus(id, status) {
        const f = this.cardFile(id);
        if (!f || (this.statusOf(id) || null) === (status || null)) return;
        const data = await this.app.vault.read(f);
        await this.setStatus(id, status);
        this.pushUndo({ active: this.active, files: [], created: [],
                        restores: [{ path: f.path, text: data,
                                     ifBody: core.splitFrontmatter(data)
                                         .body }],
                        text: false });
    }

    /**
     * Show each card's status at its top right, beside the role icon,
     * and the counts in the bar.
     * A printing card shows its own status, a structural card the least
     * finished state below it and how many cards there are flagged.
     */
    // ---- review rounds ---------------------------------------------------

    /** The review rounds' file, beside the index: Grant.rounds.json. */
    roundsPath() {
        return this.file ? this.file.path.replace(/\.md$/, '') +
            '.rounds.json' : null;
    }

    async readRounds() {
        const f = this.app.vault.getAbstractFileByPath(this.roundsPath());
        if (!(f instanceof TFile)) return [];
        try {
            const data = JSON.parse(await this.app.vault.read(f));
            return Array.isArray(data.rounds) ? data.rounds : [];
        } catch (err) {
            return [];
        }
    }

    /** What each card prints now, fingerprinted as a round keeps it. */
    async fingerprints() {
        const bodies = await this.loadBodies();
        const { crc32, utf8 } = require('./docx.js');
        return core.roundFingerprints(this.root, (id) => bodies.get(id),
            (id) => this.printRoleOf(id),
            (t) => String(crc32(utf8(t))));
    }

    /**
     * A review round: the manuscript as sent, today, to `to`, kept in
     * the rounds' file so the board can show what changed since.
     */
    async recordRound(to) {
        const rounds = await this.readRounds();
        rounds.push({ date: localDay(), to: String(to || '').trim(),
                      cards: await this.fingerprints() });
        const path = this.roundsPath();
        const text = JSON.stringify({ rounds }, null, 2) + '\n';
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) await this.app.vault.modify(f, text);
        else await this.app.vault.create(path, text);
        await this.updateChanged();
    }

    /**
     * The review rounds' cards under their new ids, `to(id)`, for a
     * rename, so none reads as changed since it was sent.
     */
    async renameRounds(path, to) {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) return;
        await this.app.vault.process(f, (data) => {
            let d;
            try {
                d = JSON.parse(data);
            } catch (err) {
                return data;
            }
            for (const r of Array.isArray(d.rounds) ? d.rounds : []) {
                r.cards = Object.fromEntries(Object.entries(r.cards || {})
                    .map(([id, crc]) => [to(id), crc]));
            }
            return JSON.stringify(d, null, 2) + '\n';
        });
    }

    /** After an export: a notice offering to mark it as sent. */
    offerRound() {
        const frag = this.pageDoc().createDocumentFragment();
        const el = createDiv({ text: 'Dendrite: sent this for review? ' });
        const b = el.createEl('button', { text: 'Mark as sent for review…' });
        b.addEventListener('click', () => new RoundModal(this).open());
        frag.append(el);
        new Notice(frag, 15000);
    }

    scheduleChanged() {
        clearTimeout(this.changedTimer);
        this.changedTimer = setTimeout(() => this.updateChanged(), 500);
    }

    /** Which cards' printed text changed since the latest round. */
    async updateChanged() {
        if (!this.root) return;
        const rounds = await this.readRounds();
        const last = rounds[rounds.length - 1];
        const before = this.changed;
        this.changed = last ? { date: last.date, to: last.to,
            ids: core.changedSince(last.cards || {},
                                   await this.fingerprints()) } : null;
        const key = (c) => c ? `${c.date}|${[...c.ids].join(',')}` : '';
        if (key(before) !== key(this.changed)) this.updateStatuses();
    }

    /** Statuses shown again once, after the cards being drawn. */
    scheduleStatuses() {
        if (this.statusTimer) return;
        this.statusTimer = this.pageWin().setTimeout(() => {
            this.statusTimer = null;
            this.updateStatuses();
        }, 0);
    }

    /** A card's status chips, flag and stack edges, from statusInfo. */
    statusCard(id, card) {
        if (!this.statusInfo) return;
        const old = card.querySelector(':scope > .dendrite-status');
        if (old) old.remove();
        card.removeClass('is-flagged');
        const info = this.statusInfo.get(id) ||
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
        // Its printed text changed since the latest review round.
        if (this.changed && this.changed.ids.has(id)) {
            const s = show('changed', 'changed since ' +
                           review.shortDate(this.changed.date));
            s.setAttr('aria-label', 'What this card prints changed ' +
                      'since it was sent to ' +
                      (this.changed.to || 'review'));
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
        const stack = this.stackOf(id).length;
        // Old versions show as card edges behind this one's top.
        card.toggleClass('has-stack', stack > 0);
        card.toggleClass('has-stacks', stack > 1);
        // Fanned out, its old versions are beside it, not behind it.
        card.toggleClass('is-fanned', stack > 0 && this.fannedId === id);
        if (stack) {
            const s = show('stack', `${stack + 1} versions`);
            s.dataset.stack = id;
            s.toggleClass('is-on', this.fannedId === id);
            s.setAttr('aria-label', this.fannedId === id ?
                      'Click to fold the old versions away' :
                      'Earlier versions of this card, kept and not ' +
                      'printed. Click to fan them out to its right');
            s.onclick = (e) => {
                e.stopPropagation();
                return this.toggleFan(id);
            };
        }
        if (core.isFlag(info.own)) card.addClass('is-flagged');
        if (!chip.childElementCount) return;
        card.appendChild(chip);
    }

    updateStatuses() {
        if (!this.board) return;
        const open = this.openComments || new Map();
        // As counted when a card was drawn, or from its text, which every
        // card has read though few are drawn on a long board.
        const comments = (id) => {
            if (open.has(id)) return open.get(id);
            const b = this.bodies && this.bodies.get(id);
            if (!b) return 0;
            if (b.comments === undefined) {
                b.comments = review.countComments(review.reviewItems(b.body));
            }
            return b.comments;
        };
        const report = core.statusReport(this.root,
            (id) => this.statusOf(id), (id) => this.printRoleOf(id),
            comments);
        this.statusInfo = report.cards;
        for (const [id, card] of this.liveCards()) this.statusCard(id, card);
        this.stackOpenReady = this.markOpenStacks();
        if (this.statusEl) {
            const t = report.tally;
            const parts = [];
            if (t.revise) parts.push(`${t.revise} revise`);
            if (t.unsplit) parts.push(`${t.unsplit} unsplit`);
            parts.push(`${t.draft} draft`, `${t.done} done`);
            const ch = this.changed;
            if (ch && ch.ids.size) {
                parts.push(`${ch.ids.size} changed since sent ` +
                           review.shortDate(ch.date));
            }
            this.statusEl.setText(parts.join(' · '));
            this.statusEl.toggleClass('has-flags', t.revise + t.unsplit > 0);
            const cards = [...this.reverted].filter((k) => k !== 'index' &&
                this.byId.has(k)).length;
            if (cards) {
                const s = this.statusEl.createSpan({ cls:
                    'dendrite-status-chip is-reverted',
                    text: `${cards} card${cards === 1 ? '' : 's'} ` +
                        'changed by sync ⟲' });
                s.setAttr('aria-label', 'Cards changed outside Dendrite ' +
                          'to an older copy, or kept from a change while ' +
                          'you typed. Click to go to each in turn; its ' +
                          'red chip compares and chooses');
                s.onclick = () => this.nextReverted();
            }
            if (this.reverted.has('index')) {
                const s = this.statusEl.createSpan({ cls:
                    'dendrite-status-chip is-reverted',
                    text: 'index: older copy ⟲' });
                s.setAttr('aria-label', 'The index changed outside ' +
                          'Dendrite to an older copy. Click to compare and ' +
                          'choose; nothing is written until you do');
                s.onclick = () => this.reviewVersion(null);
            }
            if (this.arriving) {
                const s = this.statusEl.createSpan({ cls:
                    'dendrite-status-chip is-reverted',
                    text: `renaming: ${this.arriving} to arrive` });
                s.setAttr('aria-label', 'Renamed on another device; ' +
                          'some card notes have not arrived under their ' +
                          'new names. The board changes nothing until ' +
                          'they do');
                s.onclick = () => this.refuseWhileArriving();
            }
            if (this.oldCopies.length) {
                const n = this.oldCopies.length;
                const s = this.statusEl.createSpan({ cls:
                    'dendrite-status-chip is-reverted',
                    text: `${n} old cop${n === 1 ? 'y' : 'ies'} ⟲` });
                s.setAttr('aria-label', 'Notes under this manuscript\'s ' +
                          'name before its rename, brought back by a ' +
                          'sync. Click to see them');
                s.onclick = () => new OldCopiesModal(this).open();
            }
        }
        this.showTrayCount();
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
            if (up) await this.markStatus(node.id, null);
            return;
        }
        if (core.roleFor(node, (x) => this.printRoleOf(x)) !== 'prose') {
            new Notice('Dendrite: a structural card takes its status from ' +
                       'the cards below it.');
            return;
        }
        await this.markStatus(this.active, up ? 'done' : 'revise');
    }

    /** Mark cards that print nothing, and where a role was set by hand. */
    updateRoles() {
        // A role changed in the print-only view can show or hide cards,
        // and a card superseded or brought back from its stack.
        if (this.shown && this.shownKey(this.shownTree()) !==
            this.shownKey(this.shown)) {
            this.render();
            return;
        }
        for (const [id, card] of this.liveCards()) this.roleCard(id, card);
    }

    /** A card's role: its classes, and its icon in the corner. */
    roleCard(id, card) {
        const node = this.byId.get(id);
        if (!node) return;
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
        card.toggleClass('is-prints-heading', !out &&
            core.roleFor(node, (x) => this.printRoleOf(x)) ===
                'section');
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
            for (const [id, card] of this.liveCards()) {
                this.fillQuota(card, id);
            }
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
        for (const [id, card] of this.liveCards()) this.fillQuota(card, id);
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
        let read = false;
        for (const n of core.allNodes(this.root)) {
            const f = this.cardFile(n.id);
            if (!f) continue;
            const had = this.bodies.get(n.id);
            if (had && had.mtime === f.stat.mtime) continue;
            const text = await this.app.vault.cachedRead(f);
            this.bodies.set(n.id, { mtime: f.stat.mtime,
                                    body: core.splitFrontmatter(text).body });
            read = true;
        }
        // Flags counted from the texts read.
        if (read) this.scheduleStatuses();
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

    /** The find bar, under the view's header. */
    renderFind() {
        const f = this.find;
        const bar = this.contentEl.querySelector(
            ':scope > .dendrite-head, :scope > .dendrite-bar');
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
        toggle('printed', 'printer', 'Only text that prints',
               () => !f.printed);
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
        const nodes = (top ? [top, ...core.descendants(top)]
            : core.allNodes(this.root))
            .filter((n) => !this.shown || this.shown.parent.has(n.id));
        const ids = nodes.map((n) => n.id);
        const r = core.findMatches(ids, bodyOf, f.query, Object.assign({},
            f, { printed: f.printed ? this.printedOf() : null }));
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

    /**
     * What a card prints, for find: its text by its role, nothing in a
     * left-out branch.
     */
    printedOf() {
        const roleOf = (x) => this.printRoleOf(x);
        const out = new Set();
        const walk = (node) => {
            if (core.roleFor(node, roleOf) === 'notes') {
                for (const d of [node, ...core.descendants(node)]) {
                    out.add(d.id);
                }
                return;
            }
            node.children.forEach(walk);
        };
        this.root.children.forEach(walk);
        return (id, body) => {
            const node = this.byId.get(id);
            if (!node || out.has(id)) return [];
            return core.printedRanges(body, core.roleFor(node, roleOf));
        };
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
            for (let p = node && this.upOf(node); p && p.id;
                p = this.upOf(p)) {
                below.set(p.id, (below.get(p.id) || 0) + k);
            }
        }
        this.findShown = { on, per, below };
        for (const [id, card] of this.cardEls) this.findCard(id, card);
        this.paintFind();
    }

    /**
     * A card marked as a match or not, and, drawn, how many matches its
     * branch holds below it; a slot gets the count once filled.
     */
    findCard(id, card) {
        const s = this.findShown;
        const on = !!(s && s.on && this.find);
        card.toggleClass('is-match', on && s.per.has(id));
        if (card.hasClass('is-slot')) return;
        const old = card.querySelector(':scope > .dendrite-find-below');
        if (old) old.remove();
        if (on && s.below.get(id)) {
            const chip = card.createDiv({ cls: 'dendrite-find-below',
                text: `${s.below.get(id)} below` });
            chip.setAttr('aria-label', 'Matches in this card\'s branch');
        }
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
            const parent = node && this.upOf(node);
            if (parent && parent.id) this.lastChild.set(parent.id, m.id);
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
        for (const [id, card] of this.liveCards()) {
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
        // The current match counted among its card's matches of its kind:
        // in the text, or in a review callout, drawn after its paragraph
        // though written inside it.
        const nth = cur && !cur.card ? f.matches.filter((m) =>
            m.id === cur.id && !m.card && !!m.note === !!cur.note &&
            m.start < cur.start).length : -1;
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
            const inNote = (r) => {
                const el = r.startContainer.parentElement;
                return !!(el && el.closest('.dendrite-review-notes'));
            };
            const seen = { true: 0, false: 0 };
            for (const [a, b] of spans) {
                const r = doc.createRange();
                r.setStart(...point(a));
                r.setEnd(...point(b));
                const note = inNote(r);
                const k = seen[note]++;
                if (id === (cur && cur.id) && note === !!cur.note &&
                    k === nth) current = r;
                else all.push(r);
            }
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
        const m = dendriteMenu(false);
        // Text only: no icon tells the formats apart better than their
        // names.
        m.addItem((i) => i.setTitle('Markdown')
            .onClick(() => this.exportTo(node, 'md')));
        if (Platform.isDesktopApp) {
            m.addItem((i) => i.setTitle('PDF')
                .onClick(() => this.exportTo(node, 'pdf')));
            m.addItem((i) => i.setTitle('Word')
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
        if (this.refuseWhileArriving()) return null;
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
     * Write a reference.docx beside the index, never over one that
     * exists: Pandoc's, with the manuscript's font, size, spacing and page
     * and black text, as an export without one uses. Returns its path
     * from the vault root, or null.
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
        const deps = this.plugin.pandocDeps();
        const out = nodePath.join(base, rel);
        try {
            await deps.run(this.plugin.settings.pandocPath || 'pandoc',
                           ['-o', out, '--print-default-data-file',
                            'reference.docx']);
            await deps.writeFile(out, pandoc.restyledReference(
                await deps.readFile(out), this.manuscript().style,
                deps.zlib));
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
        if (whole) this.offerRound();
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
        // Review comments as bubbles beside the text, and which of them,
        // in reading order, is the one stepped to.
        this.showComments = false;
        this.reviewList = [];
        this.reviewAt = -1;
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
                 showLeft: this.showLeft, notesAt: this.notesAt,
                 showComments: this.showComments };
    }

    async setState(state, result) {
        const f = state && state.file &&
            this.app.vault.getAbstractFileByPath(state.file);
        this.showLeft = !!(state && state.showLeft);
        // Review on, as the comment list being open says: shown too.
        this.showComments = !!(state && state.showComments) ||
            !!(this.plugin.reviewOn && this.plugin.reviewOn());
        this.notesAt = NOTES_AT[state && state.notesAt] ? state.notesAt :
            'section';
        if (f instanceof TFile) {
            this.file = f;
            this.build();
            await this.refresh();
        }
        return super.setState(state, result);
    }

    /** Review comments beside the text, or not, as review is on or off. */
    async setComments(on) {
        if (this.showComments === on) return;
        this.showComments = on;
        this.reviewAt = -1;
        this.app.workspace.requestSaveLayout();
        await this.refresh();
    }

    /**
     * How a [[link]] in a comment is drawn in the preview: to one of the
     * manuscript's cards, a link that selects it on the board.
     */
    cardLinker() {
        return (doc, target, alias) => {
            const id = cardNamed(this.segs.keys(), target);
            return id ? cardRef(this, doc, id, alias || target, () =>
                this.plugin.focusCard(this.file, id, false)) : null;
        };
    }

    async onOpen() {
        this.contentEl.addClass('dendrite-preview');
        keepEscape(this);
        // Escape with nothing in the preview to close stops here too.
        this.scope = new Scope(this.app.scope);
        this.scope.register([], 'Escape', () => false);
        this.observer = new IntersectionObserver(
            (entries) => this.onVisible(entries),
            { root: null, rootMargin: `${DRAW_MARGIN}px 0px` });
        const changed = (f) => {
            if (!(f instanceof TFile) || !this.file) return;
            if (f === this.file || this.segs.has(f.basename)) {
                this.scheduleRefresh();
            }
        };
        this.registerEvent(this.app.vault.on('modify', changed));
        this.registerEvent(this.app.metadataCache.on('changed', changed));
        // Notes found by their names are found afresh after any of these.
        for (const e of ['create', 'delete', 'rename']) {
            this.registerEvent(this.app.vault.on(e, () => {
                if (this.notes) this.notes.clear();
            }));
        }
        this.registerEvent(this.app.vault.on('rename', (f) => {
            if (f === this.file) this.leaf.updateHeader();
            else changed(f);
        }));
        this.registerDomEvent(this.contentEl, 'click', (e) => {
            if (openInImageToolkit(this.app, e)) return;
            const b = e.target.closest('.dendrite-pblock');
            if (b && !b.dataset.notes && this.file) {
                this.plugin.focusCard(this.file, b.dataset.id, false);
            }
        });
        this.registerDomEvent(this.contentEl, 'dblclick', (e) => {
            const b = e.target.closest('.dendrite-pblock');
            if (b && !b.dataset.notes && this.file) {
                this.plugin.focusCard(this.file, b.dataset.id, true,
                                      clickedText(b, e));
            }
        });
    }

    async onClose() {
        if (this.idleDraw) this.idleDraw.stop();
        if (this.observer) this.observer.disconnect();
        if (this.resizer) this.resizer.disconnect();
        for (const b of this.blocks.values()) {
            if (b.comp) b.comp.unload();
        }
        this.blocks.clear();
    }

    build() {
        const el = this.contentEl;
        el.empty();
        this.blocks.clear();
        // As the board's bar: icon buttons, lit while on.
        const bar = el.createDiv({ cls: 'dendrite-bar' });
        // What text is shown, as the board's switch of which cards.
        barSwitch(bar, 'Which text the preview shows', [
            [true, 'All', 'Also show, dimmed, the text that does not ' +
                'print: notes and comments'],
            [false, 'Printed', 'Show only the text that prints']],
            this.showLeft, (v) => {
                this.showLeft = v;
                this.app.workspace.requestSaveLayout();
                this.refresh();
            });
        // Back and on through the comments in reading order, shown while
        // review is on, which the board's Comments button turns on and
        // off: a stepper, one bordered group with the count in its own
        // cell.
        this.navEl = bar.createDiv({ cls: 'dendrite-seg ' +
                                          'dendrite-pcomments-nav' });
        const navBtn = (icon, label, d) => barButton(this.navEl, icon, '',
            label, () => this.stepComment(d));
        navBtn('chevron-left', 'Previous comment', -1);
        this.posEl = this.navEl.createSpan(
            { cls: 'dendrite-pcomments-pos' });
        navBtn('chevron-right', 'Next comment', 1);
        // Toggles first, then, set apart, the menu.
        const notes = barButton(bar, 'list-end', 'Footnotes',
            'Where footnotes are shown', (e) => {
                const m = dendriteMenu(false);
                for (const [v, label] of Object.entries(NOTES_AT)) {
                    m.addItem((i) => {
                        i.setTitle(label).onClick(() => {
                            this.notesAt = v;
                            this.app.workspace.requestSaveLayout();
                            this.refresh();
                        });
                        if (typeof i.setChecked === 'function') {
                            i.setChecked(this.notesAt === v);
                        }
                    });
                }
                if (e && m.showAtMouseEvent) m.showAtMouseEvent(e);
            }, true);
        notes.addClass('dendrite-bar-gap-before');
        this.doc = el.createDiv({ cls: 'dendrite-preview-doc ' +
                                       'markdown-preview-view ' +
                                       'markdown-rendered' });
        // A passage or number pointed at marks its comment's bubble and
        // passages, the other bubbles dimmed, as the bubble pointed at
        // marks its passages.
        this.doc.addEventListener('mouseover', (e) =>
            this.hoverComment(this.commentAt(e.target)));
        hoverLinks(this, this.doc);
        // A link in the text to a card goes to it on the board; with
        // Ctrl, or to anything else, the note opens.
        this.doc.addEventListener('click', (e) => {
            const a = e.target.closest &&
                e.target.closest('a.internal-link:not(.dendrite-card-ref)');
            if (!a) return;
            e.preventDefault();
            e.stopPropagation();
            const href = a.getAttribute('data-href') ||
                a.getAttribute('href');
            const mod = e.ctrlKey || e.metaKey || Keymap.isModEvent(e);
            const id = !mod && cardNamed(this.segs.keys(),
                                         String(href).split(/[#|]/)[0]);
            if (id) this.plugin.focusCard(this.file, id, false);
            else if (this.file) {
                this.app.workspace.openLinkText(href, this.file.path, mod);
            }
        }, true);
        // A wheel over the text moves the text at its own pace, the
        // comment column hurrying through a crowded run; over the
        // comments, the usual scroll moves them, and the text keeps pace.
        this.doc.addEventListener('wheel', (e) => {
            const knots = this.showComments && this.commentKnots;
            if (!knots || e.ctrlKey || !e.deltaY ||
                e.target.closest('.dendrite-pgutter')) return;
            const line = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ?
                this.doc.clientHeight : 1;
            const t = core.textAt(this.doc.scrollTop, knots);
            const to = core.scrollFor(Math.max(0, t + e.deltaY * line), knots);
            e.preventDefault();
            this.doc.scrollTop = Math.max(0, to);
        }, { passive: false });
        // Scrolling moves the text at the comment column's pace.
        this.doc.addEventListener('scroll', () => {
            this.drawWhenIdle();
            if (this.shiftFrame) return;
            const win = this.doc.ownerDocument.defaultView;
            this.shiftFrame = win.requestAnimationFrame(() => {
                this.shiftFrame = null;
                this.keepPace();
            });
        });
        // A change of width reflows the text under the bubbles.
        if (this.resizer) this.resizer.disconnect();
        if (typeof ResizeObserver !== 'undefined') {
            this.resizer = new ResizeObserver(() => {
                if (this.fitFrame) return;
                const win = this.doc.ownerDocument.defaultView;
                this.fitFrame = win.requestAnimationFrame(() => {
                    this.fitFrame = null;
                    this.fitComments();
                });
            });
            this.resizer.observe(this.doc);
        }
    }

    scheduleRefresh() {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refresh(), 300);
    }

    cardFile(id) {
        this.notes = this.notes || new Map();
        return noteOf(this.app, this.notes, id, this.file.path);
    }

    /** Draw the preview again, saying so if it fails rather than blank. */
    async refresh() {
        try {
            await this.refreshNow();
        } catch (err) {
            this.failed(err);
        }
        this.drawWhenIdle();
    }

    /** A failure to draw, shown once while the preview is open. */
    failed(err) {
        console.error('Dendrite: the preview could not draw', err);
        if (this.failShown) return;
        this.failShown = true;
        new Notice('Dendrite: the preview could not draw: ' +
                   `${err && err.message || err}`, 15000);
    }

    /**
     * Parts drawn while the preview is idle, as well as when they scroll
     * into view, so a scroll or a card selected on the board does not
     * stop to draw them; and so they are drawn where the observer is
     * never told they are in view, as on an iPad (idleDrawer).
     */
    drawWhenIdle() {
        if (!this.idleDraw) {
            this.idleDraw = idleDrawer(
                () => (this.doc && this.doc.ownerDocument.defaultView) ||
                    window,
                () => this.nextToDraw(),
                () => Date.now() - (this.plugin.typedAt || 0) < 1000);
        }
        this.idleDraw.schedule();
    }

    /**
     * The waiting parts nearest the middle of the view, up to
     * DRAW_BATCH, drawn together; or null. Only parts within DRAW_REACH
     * screens of the view are drawn, so a long document keeps only the
     * part around the reader drawn; with none of those waiting, drawn
     * parts beyond EMPTY_REACH screens are emptied, keeping their
     * heights. The drawn parts' heights, read on the way, are learnt
     * from for those never drawn (partHeight).
     */
    nextToDraw() {
        if (!this.doc) return null;
        const v = this.doc.getBoundingClientRect();
        // Not shown, every part measures nothing and all would seem near.
        if (!v.width || !v.height) return null;
        const mid = v.top + v.height / 2;
        const reach = v.height / 2 + DRAW_REACH * v.height;
        const away = v.height / 2 + EMPTY_REACH * v.height;
        this.samples = this.samples || new Map();
        const near = [];
        const far = [];
        for (const [id, b] of this.blocks) {
            if (b.el.hasClass('is-empty') || !this.doc.contains(b.el)) {
                continue;
            }
            const r = b.el.getBoundingClientRect();
            const d = Math.abs(r.top + r.height / 2 - mid);
            if (!b.el.hasClass('is-pending')) {
                if (r.height && b.lines) {
                    this.samples.set(id, [b.lines, r.height]);
                    this.fit = null;
                }
                if (d > away && id !== this.active) far.push([id, r.height]);
                continue;
            }
            if (d <= reach) near.push([d, id]);
        }
        if (!near.length) {
            for (const [id, h] of far) this.emptyPart(id, h);
            return null;
        }
        near.sort((a, b) => a[0] - b[0]);
        return Promise.all(near.slice(0, DRAW_BATCH).map(([, id]) =>
            this.renderBlock(id).catch((err) => this.failed(err))));
    }

    /** How many lines a part's text would take, roughly: its length. */
    partLines(s) {
        const chars = (s.text || '').length + (s.gathered ? 200 : 0);
        const perLine = Math.max(20, (this.textWidth || 600) / SLOT_CHAR);
        return Math.max(1, Math.ceil(chars / perLine));
    }

    /**
     * How tall a part waiting to be drawn is: as tall as when last drawn
     * with the same text, or, from the parts drawn so far, as its length
     * suggests (core.fitHeights).
     */
    partHeight(b) {
        if (b.measured && b.measured.key === b.key) return b.measured.h;
        if (!this.fit) {
            this.fit = core.fitHeights([...(this.samples || new Map())
                .values()], HEIGHT_SAMPLES, SLOT_LINE);
        }
        const lines = b.lines || 1;
        return Math.max(SLOT_LINE, Math.round(this.fit ?
            this.fit.a + this.fit.b * lines : lines * SLOT_LINE + 16));
    }

    /** A drawn part emptied to wait again, at the height it was drawn. */
    emptyPart(id, h) {
        const b = this.blocks.get(id);
        if (!b || b.el.hasClass('is-pending')) return;
        if (h) b.measured = { key: b.key, h };
        if (b.comp) b.comp.unload();
        b.comp = null;
        b.el.empty();
        b.el.addClass('is-pending');
        setStyles(b.el, { height: `${this.partHeight(b)}px` });
        if (this.observer) this.observer.observe(b.el);
    }

    async refreshNow() {
        if (!this.file || !this.doc) return;
        // The text's width, for estimating how tall a part not yet drawn
        // will be (partLines).
        this.textWidth = this.doc.clientWidth;
        const text = await this.app.vault.cachedRead(this.file);
        const root = core.parseIndex(core.splitFrontmatter(text).body).root;
        const fm = this.app.metadataCache.getFileCache(this.file)
            ?.frontmatter || {};
        this.colours = review.reviewerColours(fm.dendrite_reviewer_colours);
        // Replies signed Me in your colour, kept under the name you sign.
        const signed = (this.plugin.settings || {}).replyName;
        if (signed && signed !== 'Me' && this.colours.has(signed)) {
            this.colours.set('Me', this.colours.get(signed));
        }
        this.names = review.reviewerNames(fm.dendrite_reviewer_colours);
        // You, as you are shown, where your replies are.
        const s = this.plugin.settings || {};
        if (s.presentName) {
            this.names.set(s.replyName || 'Me', s.presentName);
            this.names.set('Me', s.presentName);
        }
        const colourOf = (who) => this.colours.get(who) || null;
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
        const roleOf = core.withKinds((id) => core.cardRole(props(id)),
                                      kindOf);
        const hasHeading = (id) => {
            const f = this.cardFile(id);
            const s = f && this.app.metadataCache.getFileCache(f)?.sections;
            const first = (s || []).find((x) => x.type !== 'yaml');
            return !!first && first.type === 'heading';
        };
        const numbers = fm.dendrite_number_sections === true ?
            core.sectionNumbers(root.children, hasHeading, roleOf,
                                kindOf) : null;
        // While the comment list is open, only the comments its filter
        // keeps are drawn.
        const filter = this.plugin.commentFilter ?
            this.plugin.commentFilter() : null;
        const self = filter ? this.plugin.selfNames() : null;
        const keepOf = (body) => {
            if (!filter) return null;
            const items = review.reviewItems(body);
            return (k) => review.passesFilter(items[k], filter, self);
        };
        // Footnotes numbered across the whole document, as export does;
        // shown under each card, each top-level section, or at the end.
        // With comments shown, each comment is a mark and a number in the
        // text, which export would strip with the comment itself.
        const segs = core.gatherFootnotes(core.renumberFootnotes(
            core.exportSegments(root.children, (id) => {
                const b = this.bodies.get(id);
                if (!b) return '';
                return this.showComments ?
                    review.renderMarkdown(b.body, colourOf,
                                          keepOf(b.body)) :
                    b.body;
            }, headingTop, numbers, roleOf, { kindOf })).segments,
            this.notesAt);
        // Only flagged cards are marked here, with a faint bar, so the
        // preview stays a page to read.
        const statusOf = (id) => {
            const s = props(id).dendrite_status;
            return core.STATUSES.includes(s) ? s : null;
        };
        const report = core.statusReport(root, statusOf, roleOf, (id) => {
            const b = this.bodies.get(id);
            return b ? review.countComments(review.reviewItems(b.body)) : 0;
        });
        this.flags = new Map();
        for (const [id, info] of report.cards) {
            if (core.isFlag(info.own)) {
                this.flags.set(id, this.plugin.statusColour ?
                    this.plugin.statusColour(info.own) : null);
            }
        }
        this.renderSegments(segs);
        this.listComments(segs);
    }

    /**
     * Every review comment the document prints, in reading order: those
     * whose number is in a printed card's text. A comment in a part of a
     * card that does not print, as under a heading-only card's heading,
     * is left out, as the document leaves it.
     */
    listComments(segs) {
        const list = [];
        if (this.showComments) {
            for (const sg of segs) {
                if (!sg.text || sg.gathered) continue;
                const body = (this.bodies.get(sg.id) || {}).body || '';
                const items = review.reviewItems(body);
                // Which comments the part prints, by the comment each
                // number names: a Google comment's passages share one
                // number, so the numbers themselves do not say.
                const shown = new Set([...sg.text.matchAll(
                    /\bdendrite-item-(\d+)\b/g)].map((m) => Number(m[1])));
                items.forEach((item, n) => {
                    if (!shown.has(n)) return;
                    // A Google comment on several passages, in this card
                    // or others, is one entry, its passages its parts.
                    const g = review.googleOf(item);
                    const had = g && list.find((x) => x.g === g);
                    if (had) had.parts.push({ id: sg.id, n });
                    else list.push({ id: sg.id, n, item, g,
                                     parts: [{ id: sg.id, n }] });
                });
            }
        }
        // The comment gone to keeps its place in the count as others
        // come and go; when it was itself resolved, the one now in its
        // place, the next, is gone to.
        const was = this.reviewList[this.reviewAt];
        const key = (x) => `${x.id}\u0000${review.reviewKeys(x.item)[0]}`;
        this.reviewList = list;
        let moved = false;
        if (was) {
            const k = list.findIndex((x) => key(x) === key(was));
            if (k >= 0) this.reviewAt = k;
            else moved = true;
        }
        if (this.reviewAt >= list.length) this.reviewAt = list.length - 1;
        this.doc.toggleClass('has-comments', this.showComments);
        if (!this.showComments) this.commentKnots = null;
        if (!this.showComments && this.gutterEl) {
            this.gutterEl.remove();
            this.gutterEl = null;
        } else if (this.gutterEl) {
            const keep = new Set(list.map((x) => `${x.id}\u0000${x.n}`));
            for (const el of [...this.gutterEl.children]) {
                if (!keep.has(`${el.dataset.id}\u0000${el.dataset.n}`)) {
                    el.remove();
                }
            }
        }
        this.fitComments();
        this.navEl.toggleClass('is-hidden', !this.showComments);
        this.showPos();
        if (moved && this.reviewAt >= 0) this.goComment();
    }

    showPos() {
        const n = this.reviewList.length;
        this.posEl.setText(!n ? 'No comments' : this.reviewAt < 0 ?
            `${n} comment${n === 1 ? '' : 's'}` :
            `${this.reviewAt + 1} of ${n}`);
        const cur = this.reviewList[this.reviewAt];
        for (const el of this.doc.querySelectorAll('.is-current')) {
            el.removeClass('is-current');
        }
        if (!cur) return;
        const b = this.blocks.get(cur.id);
        if (!b) return;
        const bubble = this.bubbleOf(cur.id, cur.n);
        if (bubble) bubble.addClass('is-current');
        for (const el of this.passagesOf(cur)) el.addClass('is-current');
        this.scheduleBubbles();
    }

    /** A comment pointed at in the comment list, marked as on hover. */
    pointAt(id, n, on) {
        const entry = this.reviewList.find((x) => (x.parts || [x])
            .some((p) => p.id === id && p.n === n));
        if (!entry) return;
        for (const p of this.passagesOf(entry)) p.toggleClass('is-hover', on);
        const b = this.bubbleOf(entry.id, entry.n);
        if (b) b.toggleClass('is-hover', on);
        if (this.gutterEl) this.gutterEl.toggleClass('has-hover', on);
    }

    bubbleOf(id, n) {
        return this.gutterEl ? [...this.gutterEl.children].find((el) =>
            el.dataset.id === id && Number(el.dataset.n) === n) || null :
            null;
    }

    /** Every passage of a comment's entry, in every card it is on. */
    passagesOf(entry) {
        return (entry.parts || [{ id: entry.id, n: entry.n }]).flatMap((p) => {
            const b = this.blocks.get(p.id);
            return b ? this.passageOf(b.el, p.n) : [];
        });
    }

    /**
     * The comment, of reviewList, whose passage or number `el` is in:
     * its number's index, found from a passage by the id it is held by,
     * or, in the old form, by the number after it; or null.
     */
    commentAt(el) {
        const at = el && el.closest && el.closest(
            'sup.dendrite-review-n, mark.dendrite-review-mark, ' +
            '.dendrite-review-old, .dendrite-review-new');
        const block = at && at.closest('.dendrite-pblock');
        if (!block) return null;
        let sup = at.matches('sup') ? at : null;
        const rid = !sup && [...at.classList].find((c) =>
            c.startsWith('dendrite-rid-'));
        if (rid) sup = block.querySelector(`sup.${rid}`);
        for (let x = at; !sup && x; x = x.nextElementSibling) {
            if (x.matches('sup.dendrite-review-n')) sup = x;
        }
        const k = sup && [...sup.classList].find((c) =>
            c.startsWith('dendrite-item-'));
        if (!k) return null;
        const n = Number(k.slice('dendrite-item-'.length));
        const id = block.dataset.id;
        return this.reviewList.find((x) => x.parts.some((p) =>
            p.id === id && p.n === n)) || null;
    }

    /** One comment marked, its bubble and passages, or none, `entry`. */
    hoverComment(entry) {
        if (entry === this.hovered) return;
        const mark = (x, on) => {
            if (!x) return;
            for (const p of this.passagesOf(x)) p.toggleClass('is-hover', on);
            const b = this.bubbleOf(x.id, x.n);
            if (b) b.toggleClass('is-hover', on);
        };
        mark(this.hovered, false);
        this.hovered = entry;
        mark(entry, true);
        if (this.gutterEl) this.gutterEl.toggleClass('has-hover', !!entry);
    }

    /** A comment's passage in a card's drawn text, `n` its index. */
    passageOf(el, n) {
        return review.passageEls(el, n);
    }

    /**
     * Go to the next comment, or the one before, round from the end:
     * its card is drawn if it was not yet, its bubble brought into view,
     * and the card selected on the board.
     */
    async stepComment(d) {
        const list = this.reviewList;
        if (!list.length) return;
        this.reviewAt = this.reviewAt < 0 ? this.stepFrom(d) :
            (this.reviewAt + d + list.length) % list.length;
        await this.goComment();
    }

    /**
     * Where stepping by `d` starts with no comment gone to: the first
     * comment at or after the selected card, or the last before it, in
     * reading order; with no card selected, the first or the last.
     */
    stepFrom(d) {
        const list = this.reviewList;
        const order = this.doc ? [...this.doc.querySelectorAll(
            '.dendrite-pblock')].map((el) => el.dataset.id) : [];
        const at = order.indexOf(this.active);
        if (at < 0) return d > 0 ? 0 : list.length - 1;
        const pos = (x) => order.indexOf(x.id);
        if (d > 0) {
            const k = list.findIndex((x) => pos(x) >= at);
            return k < 0 ? 0 : k;
        }
        for (let k = list.length - 1; k >= 0; k--) {
            if (pos(list[k]) <= at) return k;
        }
        return list.length - 1;
    }

    /** Whether an element is wholly within the preview's view. */
    inView(el) {
        if (!this.doc) return false;
        const v = this.doc.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return v.height > 0 && r.top >= v.top && r.bottom <= v.bottom;
    }

    /**
     * Bring the comment gone to into view, and select its card. The
     * parts that will be drawn around it once it is in view are drawn
     * first: drawn after, they would push it on past where it was aimed.
     */
    async goComment() {
        const cur = this.reviewList[this.reviewAt];
        if (!cur) return;
        const b = this.blocks.get(cur.id);
        if (b) await this.drawAround(b.el);
        this.showPos();
        // The passage brought to the middle unless it is in view; its
        // bubble is placed level with it.
        const at = b && this.passageOf(b.el, cur.n)[0];
        if (at && !this.inView(at)) {
            let t = 0;
            for (let e = at; e && e !== this.doc; e = e.offsetParent) {
                t += e.offsetTop;
            }
            if (!this.scrollToText(t, this.doc.clientHeight / 3) &&
                at.scrollIntoView) {
                at.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        }
        if (this.file) this.plugin.focusCard(this.file, cur.id, false);
    }

    /** The parts not yet drawn that would be, with `el` in view. */
    async drawAround(el) {
        const reach = 2 * (this.doc ? this.doc.clientHeight : 0) +
            DRAW_MARGIN;
        for (const [id, x] of [...this.blocks]) {
            if (x.el.hasClass('is-pending') &&
                Math.abs(x.el.offsetTop - el.offsetTop) <= reach) {
                await this.renderBlock(id);
            }
        }
    }

    /**
     * The gutter right of the text that holds every card's comments, one
     * for the document, so the text keeps its own spacing.
     */
    gutter() {
        if (!this.gutterEl || this.gutterEl.parentElement !== this.doc) {
            this.gutterEl = this.doc.createDiv({ cls: 'dendrite-pgutter' });
        }
        return this.gutterEl;
    }

    /** A card's review comments as bubbles in the gutter. */
    drawBubbles(id) {
        const gutter = this.gutter();
        for (const el of [...gutter.querySelectorAll('.dendrite-pbubble')]) {
            if (el.dataset.id === id) el.remove();
        }
        const body = (this.bodies.get(id) || {}).body || '';
        const items = review.reviewItems(body);
        const mark = (entry, on) => {
            for (const p of this.passagesOf(entry)) {
                p.toggleClass('is-hover', on);
            }
        };
        for (const entry of this.reviewList.filter((x) => x.id === id)) {
            const { n } = entry;
            const it = items[n];
            const c = this.colours && this.colours.get(it.author ||
                                                       'Reviewer');
            const el = gutter.createDiv({ cls: 'dendrite-pbubble' +
                (it.kind === 'suggest' ? ' is-suggest' : '') +
                (c ? ` is-c-${c}` : '') });
            el.dataset.id = id;
            el.dataset.n = String(n);
            // Pointing at a bubble shows its passage in the text; clicking
            // it goes to its comment, as stepping to it does.
            el.addEventListener('mouseenter', () => mark(entry, true));
            el.addEventListener('mouseleave', () => mark(entry, false));
            el.addEventListener('click', (e) => {
                if (e.target.closest('button, a')) return;
                e.stopPropagation();
                const k = this.reviewList.findIndex((x) => x.id === id &&
                                                     x.n === n);
                if (k < 0) return;
                this.reviewAt = k;
                this.goComment();
            });
            const meta = el.createDiv({ cls: 'dendrite-review-meta' });
            if (this.file && this.plugin.setCommentPriority) {
                priorityButton(meta, it.priority, (p) => this.plugin
                    .setCommentPriority(this.file, id, n, p));
            }
            review.shownAs(meta.createEl('b'), it.author || 'Reviewer',
                           (who) => this.names.get(who));
            meta.appendText(` · ${review.shortDate(it.date)}`);
            if (entry.parts.length > 1) {
                meta.appendText(` · ${entry.parts.length} passages`);
            }
            const { text, url } = review.noteLink(it.text);
            if (url && it.kind !== 'suggest') {
                meta.appendText(' ');
                const a = meta.createEl('a', { cls: 'dendrite-review-link',
                                               text: '↗' });
                a.href = url;
                a.title = 'Open this comment in Google Docs';
                externalLinks(meta);
            }
            const shown = el.createDiv({ cls: 'dendrite-pbubble-text' });
            if (it.kind !== 'suggest') {
                review.fillAddressed(shown, text,
                    (who) => this.colours && this.colours.get(who),
                    this.cardLinker());
            } else {
                shown.textContent = review.suggestionText(it);
            }
            // Its replies, under it, a seen mark among them; one taken
            // back from the board.
            const send = async (t) => {
                if (this.plugin.reviewFromPreview) {
                    await this.plugin.reviewFromPreview(this.file, id, n,
                                                        'reply', t);
                }
            };
            for (const r of it.replies || []) {
                const reply = el.appendChild(review.replyRow(
                    el.ownerDocument, r, (who) => this.names.get(who),
                    (who) => this.colours && this.colours.get(who),
                    this.cardLinker()));
                // Claude's reply answered as on the board: for Claude
                // only, never sent to the reviewer.
                if (r.author !== 'Claude') continue;
                const doc = el.ownerDocument;
                const bar = doc.createElement('span');
                bar.className = 'dendrite-review-acts';
                const btn = bar.appendChild(doc.createElement('button'));
                btn.className = 'dendrite-review-btn';
                btn.textContent = 'Reply to Claude';
                btn.title = 'For Claude only: not sent to the reviewer';
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    review.replyBox(el, send, (box) => ownKeys(this.app, box),
                                    '@Claude ', review.draftKey(id, it));
                    this.scheduleBubbles();
                });
                reply.prepend(bar);
            }
            const row = el.createDiv({ cls: 'dendrite-pbubble-btns' });
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const who = it.author || 'Reviewer';
                showCommentMenu(review.commentMenu(it), e, (what) => {
                    if (this.plugin.reviewFromPreview) {
                        this.plugin.reviewFromPreview(this.file, id, n, what);
                    }
                }, this.plugin.reviewerColourFor ? {
                    author: this.names.get(who) || who, current: c,
                    pick: (to) => this.plugin.reviewerColourFor(this.file,
                                                                who, to),
                } : null);
            });
            for (const [what, label, tip, by] of
                review.commentActions(it)) {
                const btn = row.createEl('button', { text: label });
                const bc = by && this.colours && this.colours.get(by);
                if (by) btn.addClass('is-suggested');
                if (bc) btn.addClass(`is-c-${bc}`);
                if (tip) btn.title = tip;
                btn.onclick = async (e) => {
                    if (e && e.stopPropagation) e.stopPropagation();
                    if (this.plugin.reviewFromPreview) {
                        await this.plugin.reviewFromPreview(this.file, id, n,
                                                            what);
                    }
                };
            }
            const answer = row.createEl('button', { text: 'Reply' });
            answer.title = 'Answer this comment';
            answer.addEventListener('click', (e) => {
                e.stopPropagation();
                review.replyBox(el, send, (box) => ownKeys(this.app, box),
                                '', review.draftKey(id, it));
                this.scheduleBubbles();
            });
            review.restoreDraft(el, it, id, send,
                                (box) => ownKeys(this.app, box));
            review.foldable(el, meta, it, () => this.scheduleBubbles());
        }
        // In reading order, as they are gone through.
        const order = new Map(this.reviewList.map((x, k) =>
            [`${x.id}\u0000${x.n}`, k]));
        const key = (el) =>
            order.get(`${el.dataset.id}\u0000${el.dataset.n}`) ?? 1e9;
        for (const el of [...gutter.children]
            .sort((a, b) => key(a) - key(b))) {
            gutter.appendChild(el);
        }
        this.fadeBubbles();
        this.scheduleBubbles();
        this.showPos();
    }

    scheduleBubbles() {
        if (this.bubbleFrame || !this.doc) return;
        const win = this.doc.ownerDocument.defaultView;
        this.bubbleFrame = win.requestAnimationFrame(() => {
            this.bubbleFrame = null;
            this.layoutBubbles();
        });
    }

    /**
     * Place the bubbles in their column, each level with its passage, a
     * crowded run pushed down (core.placeComments), and keep the column
     * long enough for them. Positions are read without the text's offset
     * (offsetTop ignores transforms), which is the scroll's to set.
     */
    layoutBubbles() {
        const gutter = this.gutterEl;
        const doc = this.doc;
        if (!gutter || !doc) return;
        const bubbles = [...gutter.querySelectorAll('.dendrite-pbubble')];
        const topIn = (el) => {
            let y = 0;
            for (let e = el; e && e !== doc; e = e.offsetParent) {
                y += e.offsetTop;
            }
            return y;
        };
        const anchors = bubbles.map((el) => {
            const b = this.blocks.get(el.dataset.id);
            const sup = b && this.passageOf(b.el, Number(el.dataset.n))
                .slice(-1)[0];
            const at = sup || (b && b.el);
            return at ? topIn(at) : 0;
        });
        const heights = bubbles.map((el) => el.offsetHeight);
        const placed = core.placeComments(anchors, heights, 8);
        bubbles.forEach((el, k) => { el.style.top = `${placed.tops[k]}px`; });
        this.commentKnots = placed.knots;
        // The column runs past the text by what crowded runs pushed down.
        const last = [...this.blocks.values()].map((b) => b.el)
            .filter((el) => el.parentElement === doc).slice(-1)[0];
        const end = last ? topIn(last) + last.offsetHeight : 0;
        const [c, t] = placed.knots[placed.knots.length - 1];
        gutter.style.minHeight = `${Math.max(0, end + c - t)}px`;
        this.keepPace();
    }

    /**
     * The text kept level with the comment column as it scrolls: moved
     * down by how far it lags the scroll, slower through a crowded run
     * of comments (core.textAt).
     */
    keepPace() {
        const doc = this.doc;
        if (!doc) return;
        const knots = this.showComments && this.commentKnots;
        const lag = knots ? doc.scrollTop - core.textAt(doc.scrollTop,
                                                         knots) : 0;
        doc.style.setProperty('--dendrite-lag', `${Math.round(lag)}px`);
    }

    /**
     * Scroll so the text at `t`, from the top of the text, shows `y`
     * below the preview's top; smooth, the comment column following.
     */
    scrollToText(t, y) {
        const doc = this.doc;
        const knots = this.commentKnots;
        if (!doc || !knots || !doc.clientHeight || !doc.scrollTo) {
            return false;
        }
        this.glideTo(Math.max(0, core.scrollFor(t - y, knots)));
        return true;
    }

    /**
     * Which bubble the column is laid out from: the comment gone to,
     * level with its mark; else the selected card's first comment, level
     * with the card's top; else none, -1.
     */
    bubbleFocus(bubbles) {
        const cur = this.reviewList[this.reviewAt];
        // A card clicked since takes over from the comment gone to.
        if (cur && (!this.active || cur.id === this.active)) {
            const k = bubbles.findIndex((el) => el.dataset.id === cur.id &&
                Number(el.dataset.n) === cur.n);
            if (k >= 0) return { index: k, at: 'mark' };
        }
        const k = bubbles.findIndex((el) => el.dataset.id === this.active);
        return k >= 0 ? { index: k, at: 'card' } : { index: -1, at: null };
    }


    /**
     * A card selected: the other cards' comments fade, when it has
     * comments of its own to set apart.
     */
    fadeBubbles() {
        const gutter = this.gutterEl;
        if (!gutter) return;
        const bubbles = [...gutter.querySelectorAll('.dendrite-pbubble')];
        const mine = bubbles.some((el) => el.dataset.id === this.active);
        for (const el of bubbles) {
            el.toggleClass('is-faded', mine && el.dataset.id !== this.active);
        }
    }

    /**
     * Lay the bubbles out again for the text as it now runs. The widths
     * themselves, the text's and the gutter's, are the stylesheet's,
     * worked out from the pane's width as it changes, so a pane being
     * resized moves them smoothly.
     */
    fitComments() {
        if (!this.doc) return;
        if (!this.showComments) {
            this.keepPace();
            return;
        }
        this.layoutBubbles();
    }

    renderSegments(segs) {
        this.segs = new Map(segs.map((s) => [s.id, s]));
        for (const [id, b] of this.blocks) {
            if (!this.segs.has(id)) {
                if (b.comp) b.comp.unload();
                b.el.remove();
                this.blocks.delete(id);
                if (this.gutterEl) {
                    for (const el of [...this.gutterEl.children]) {
                        if (el.dataset.id === id) el.remove();
                    }
                }
            }
        }
        // Each block placed after the one before it only when it is not
        // already there: moving them all on every refresh laid the whole
        // document out again, about once a save.
        let prev = null;
        // Shown with comments, a block is drawn again when they or their
        // replies change, though what it prints does not.
        const said = (id) => !this.showComments ? '' : JSON.stringify(
            review.reviewItems((this.bodies.get(id) || {}).body || '')
                .map((x) => [x.text, x.replies]));
        for (const s of segs) {
            const key = (this.showComments ? 'c\u0000' : '') + s.text +
                '\u0000' + said(s.id) +
                '\u0000' +
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
            b.lines = this.partLines(s);
            // Waiting to be drawn, a part is as tall as it was when last
            // drawn with this text, or as it is estimated to be.
            if (b.el.hasClass('is-pending')) {
                setStyles(b.el, { height: empty ? '' :
                    `${this.partHeight(b)}px` });
            }
            b.el.toggleClass('is-active', s.id === this.active);
            const flag = this.flags && this.flags.has(s.id);
            b.el.toggleClass('is-flagged', !!flag);
            if (flag && this.flags.get(s.id)) {
                b.el.style.setProperty('--dendrite-chip',
                                       this.flags.get(s.id));
            }
            const at = prev ? prev.nextSibling : this.doc.firstChild;
            if (at !== b.el) this.doc.insertBefore(b.el, at);
            prev = b.el;
        }
    }

    onVisible(entries) {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            this.observer.unobserve(e.target);
            if (e.target.hasClass('is-pending')) {
                this.renderBlock(e.target.dataset.id)
                    .catch((err) => this.failed(err));
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
        // Drawn afresh: no room kept for bubbles it may no longer have,
        // and no height kept from while it waited.
        b.el.removeClass('has-bubbles');
        b.el.style.minHeight = '';
        b.el.style.height = '';
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
            const md = core.normaliseMarkdown(s.text + notes);
            await MarkdownRenderer.render(this.app, md, b.el.createDiv(),
                                          path, b.comp);
            review.wrapPassages(b.el);
            // Read by the card's own numbers, so before renumbering.
            zotero.linkCitations(b.el, md, this.plugin.pdfLinks);
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
        if (this.showComments && s.text) this.drawBubbles(id);
        else this.scheduleBubbles();
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

    /**
     * Highlight the board's active card here, and bring it to the middle
     * of the preview, where the text around it can be read.
     */
    highlight(id) {
        this.active = id;
        for (const [bid, b] of this.blocks) {
            b.el.toggleClass('is-active', bid === id);
        }
        // Another card selected: the comment stepped to is no longer the
        // one being read, so none is marked, and stepping starts here.
        const cur = this.reviewList && this.reviewList[this.reviewAt];
        if (cur && !(cur.parts || [cur]).some((p) => p.id === id)) {
            this.reviewAt = -1;
            this.showPos();
        }
        this.drawWhenIdle();
        this.fadeBubbles();
        this.scheduleBubbles();
        const b = this.blocks.get(id);
        // The card of the comment gone to: that comment was brought into
        // view, which bringing the card to the middle would undo.
        const going = this.reviewList && this.reviewList[this.reviewAt];
        if (b && !going) {
            // One taller than most of the preview shows from its start.
            const view = this.doc ? this.doc.clientHeight : 0;
            const tall = view && b.el.offsetHeight > view * 0.8;
            const y = tall ? 16 : (view - b.el.offsetHeight) / 2;
            const done = this.showComments &&
                this.scrollToText(b.el.offsetTop, y);
            if (!done && this.doc && this.doc.scrollTo) {
                this.glideTo(Math.max(0, b.el.offsetTop - y));
            }
        }
    }

    /**
     * Scroll the text to `top`, smoothly. From far away it jumps to within
     * a screen first and slides the rest: a long smooth scroll brought
     * every part it passed into view, each drawn only to leave it.
     */
    glideTo(top) {
        const doc = this.doc;
        const screen = doc.clientHeight;
        const by = top - doc.scrollTop;
        if (screen && Math.abs(by) > LONG_MOVE * screen) {
            doc.scrollTop = top - Math.sign(by) * screen;
        }
        doc.scrollTo({ top, behavior: 'smooth' });
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

/**
 * The comment list: a manuscript's open comments and suggested changes
 * in reading order, in the right sidebar, filtered by who wrote them,
 * whose answer they wait for and their kind. It follows the board or
 * preview last used; the preview shows only the comments it keeps, and
 * a click goes to one there and on the board.
 */
class DendriteComments extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.file = null;
        this.threads = [];
        this.colours = new Map();
        this.names = new Map();
    }

    getViewType() { return COMMENTS; }
    getIcon() { return 'messages-square'; }
    getDisplayText() { return 'Comments'; }

    getState() {
        return { filter: { ...this.plugin.commentFilterState } };
    }

    async setState(state, result) {
        if (state && state.filter) {
            this.plugin.commentFilterState = { ...COMMENT_FILTER,
                                               ...state.filter };
            this.showFilter();
            this.draw();
        }
        return super.setState(state, result);
    }

    async onOpen() {
        const el = this.contentEl;
        el.empty();
        el.addClass('dendrite-comments');
        // The filters as one row of buttons, each a menu of its choices,
        // lit and naming its choice while one is set.
        this.filterEl = el.createDiv({ cls: 'dendrite-comments-filter' });
        this.countEl = el.createDiv({ cls: 'dendrite-comments-count' });
        this.listEl = el.createDiv({ cls: 'dendrite-comments-list' });
        const ws = this.app.workspace;
        this.registerEvent(ws.on('active-leaf-change',
            (leaf) => this.follow(leaf)));
        const changed = (f) => {
            if (!(f instanceof TFile) || !this.file) return;
            if (f === this.file || this.ids && this.ids.has(f.basename)) {
                this.scheduleRefresh();
            }
        };
        this.registerEvent(this.app.vault.on('modify', changed));
        this.registerEvent(this.app.metadataCache.on('changed', changed));
        // The board it was opened from, else the active one, else any.
        const asked = this.plugin.commentsFor;
        this.plugin.commentsFor = null;
        const last = ws.getActiveViewOfType &&
            (ws.getActiveViewOfType(DendriteView) ||
             ws.getActiveViewOfType(DendritePreview));
        const board = ws.getLeavesOfType(VIEW)[0];
        const f = asked || (last ? last.file : board && board.view.file);
        await this.show(f || null);
        // Open, review is on, restored with the layout too.
        if (this.plugin.reviewChanged) this.plugin.reviewChanged();
    }

    async onClose() {
        clearTimeout(this.timer);
        // Closed, review is off: the previews' comments go with it.
        if (this.plugin.reviewChanged) this.plugin.reviewChanged();
    }

    /** The manuscript of a board or preview made active. */
    follow(leaf) {
        const v = leaf && leaf.view;
        if (!(v instanceof DendriteView || v instanceof DendritePreview)) {
            return;
        }
        if (v.file && v.file !== this.file) this.show(v.file);
    }

    async show(file) {
        this.file = file;
        await this.refresh();
    }

    scheduleRefresh() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh(), 300);
    }

    /** Every open comment of the manuscript, read from its cards. */
    async refresh() {
        const file = this.file;
        const app = this.app;
        this.threads = [];
        this.ids = new Set();
        if (file) {
            const text = await app.vault.cachedRead(file);
            const root = core.parseIndex(core.splitFrontmatter(text).body)
                .root;
            const fm = (app.metadataCache.getFileCache(file) || {})
                .frontmatter || {};
            this.colours = review.reviewerColours(
                fm.dendrite_reviewer_colours);
            this.names = review.reviewerNames(fm.dendrite_reviewer_colours);
            const s = this.plugin.settings || {};
            const signed = s.replyName;
            if (signed && signed !== 'Me' && this.colours.has(signed)) {
                this.colours.set('Me', this.colours.get(signed));
            }
            if (s.presentName) {
                this.names.set(signed || 'Me', s.presentName);
                this.names.set('Me', s.presentName);
            }
            const fileOf = (id) => {
                const f = app.metadataCache.getFirstLinkpathDest(id,
                                                                file.path);
                return f instanceof TFile ? f : null;
            };
            const props = (id) => {
                const f = fileOf(id);
                return (f && app.metadataCache.getFileCache(f)
                    ?.frontmatter) || {};
            };
            const kindOf = (id) => {
                const k = props(id).dendrite_kind;
                return core.KINDS.includes(k) ? k : null;
            };
            const roleOf = core.withKinds((id) => core.cardRole(props(id)),
                                          kindOf);
            const bodies = new Map();
            for (const n of core.allNodes(root)) {
                const f = fileOf(n.id);
                if (f) {
                    bodies.set(n.id, core.splitFrontmatter(
                        await app.vault.cachedRead(f)).body);
                }
            }
            const headingOf = (id) => {
                const line = (bodies.get(id) || '').trim().split('\n')[0];
                const h = core.HEADING.exec(line || '');
                return h ? h[2] : null;
            };
            const numbers = fm.dendrite_number_sections === true ?
                core.sectionNumbers(root.children, (id) => !!headingOf(id),
                                    roleOf, kindOf) : null;
            // A Google comment on several passages is listed once.
            const seen = new Set();
            // Each card under the nearest heading, its own or a parent's,
            // and, where export leaves it out, why.
            const walk = (node, under, out) => {
                const role = core.roleFor(node, roleOf);
                const own = headingOf(node.id);
                const where = own ? ((numbers && numbers.get(node.id) ?
                    numbers.get(node.id) + ' ' : '') + own) : under;
                const gone = out || (props(node.id).dendrite_superseded ?
                    'Old version' : role === 'notes' ? 'Left out' : null);
                this.ids.add(node.id);
                const body = bodies.get(node.id);
                if (body !== undefined) {
                    const printed = core.printedOnly(body, role);
                    review.reviewItems(body).forEach((it, k) => {
                        const g = review.googleOf(it);
                        if (g && seen.has(g)) return;
                        if (g) seen.add(g);
                        const shown = printed.slice(it.start, it.end)
                            .trim();
                        this.threads.push({ id: node.id, n: k, it,
                            where: where || node.label ||
                                core.shortId(node.id),
                            unprinted: gone || (shown ? null :
                                role === 'scaffolding' ? 'Scaffolding' :
                                'Under a heading only') });
                    });
                }
                for (const c of node.children) walk(c, where, gone);
            };
            for (const n of root.children) walk(n, null, null);
        }
        if (this.file !== file) return;
        this.showFilter();
        this.draw();
    }

    /** The filter's choices, with every name that wrote a comment. */
    showFilter() {
        if (!this.filterEl) return;
        const f = this.plugin.commentFilterState;
        const self = this.plugin.selfNames();
        const nameOf = (who) => this.names.get(who) || who;
        const authors = [...new Set(this.threads.map((t) => t.it.author)
            .filter((a) => a && !self.has(a)))].sort();
        if (f.author && f.author !== 'me' && !authors.includes(f.author)) {
            authors.push(f.author);
        }
        // Each: its name, its choices as [value, in the menu, on the
        // button once chosen], the first meaning any.
        const facets = [
            ['author', 'Author', 'Who wrote it', [['', 'Anyone'],
                ['me', 'Me', 'By me'],
                ...authors.map((a) => [a, nameOf(a)])]],
            ['waiting', 'Waiting', 'Whose answer it waits for', [
                ['', 'Anyone'], ['me', 'Me', 'On me'],
                ['Claude', 'Claude', 'On Claude'],
                ['resolve', 'Ready to resolve', 'To resolve']]],
            ['priority', 'Priority', 'The priority set to work through it',
                [['', 'Any'], ['p1', 'p1'], ['p2', 'p2'], ['p3', 'p3'],
                 ['none', 'None set', 'No priority']]],
            ['kind', 'Kind', 'A comment or a suggested change', [
                ['', 'All'], ['comment', 'Comments'],
                ['suggest', 'Suggested changes', 'Changes']]]];
        const bar = this.filterEl;
        bar.empty();
        for (const [key, name, tip, choices] of facets) {
            const now = choices.find((c) => c[0] === (f[key] || ''));
            const set = !!(f[key] && now);
            const b = bar.createEl('button', { cls: 'dendrite-cfilter' +
                (set ? ' is-on' : '') });
            b.dataset.filter = key;
            b.createSpan({ text: set ? now[2] || now[1] : name });
            setIcon(b.createSpan({ cls: 'dendrite-cfilter-caret' }),
                    'chevron-down');
            b.setAttr('aria-label', tip);
            b.addEventListener('click', (e) => {
                const m = dendriteMenu(false);
                for (const [value, label] of choices) {
                    m.addItem((i) => {
                        i.setTitle(label).onClick(() =>
                            this.plugin.setCommentFilter({ [key]: value }));
                        if (typeof i.setChecked === 'function') {
                            i.setChecked(value === (f[key] || ''));
                        }
                    });
                }
                if (m.showAtMouseEvent) m.showAtMouseEvent(e);
            });
        }
        if (Object.values(f).some(Boolean)) {
            const x = bar.createEl('button', { cls: 'dendrite-cfilter ' +
                'dendrite-cfilter-clear' });
            setIcon(x, 'x');
            x.setAttr('aria-label', 'Clear the filters');
            x.addEventListener('click', () => this.plugin.setCommentFilter(
                { author: '', waiting: '', priority: '', kind: '' }));
        }
    }

    draw() {
        if (!this.listEl) return;
        const list = this.listEl;
        list.empty();
        if (!this.file) {
            this.countEl.setText('Open a manuscript to list its comments.');
            return;
        }
        const f = this.plugin.commentFilterState;
        const self = this.plugin.selfNames();
        // In reading order, the higher priorities first in each section.
        const rank = (t) => {
            const k = review.PRIORITIES.indexOf(t.it.priority);
            return k < 0 ? review.PRIORITIES.length : k;
        };
        const shown = this.threads.map((t, k) => ({ t, k }))
            .filter(({ t }) => review.passesFilter(t.it, f, self))
            .sort((a, b) => a.k - b.k)
            .map(({ t }) => t);
        const groups = [];
        for (const t of shown) {
            const g = groups[groups.length - 1];
            if (g && g[0].where === t.where) g.push(t);
            else groups.push([t]);
        }
        shown.length = 0;
        for (const g of groups) {
            shown.push(...g.map((t, k) => ({ t, k }))
                .sort((a, b) => rank(a.t) - rank(b.t) || a.k - b.k)
                .map(({ t }) => t));
        }
        const all = this.threads.length;
        this.countEl.setText(shown.length === all ?
            `${all} open comment${all === 1 ? '' : 's'}` :
            `${shown.length} of ${all} open comments`);
        const nameOf = (who) => this.names.get(who);
        let under = null;
        for (const t of shown) {
            const { it } = t;
            // Under the heading of its section, said once for the
            // comments in a row under it.
            if (t.where !== under) {
                under = t.where;
                list.createDiv({ cls: 'dendrite-cgroup', text: t.where });
            }
            const suggest = it.kind === 'suggest';
            const c = this.colours.get(it.author || 'Reviewer');
            const el = list.createDiv({ cls: 'dendrite-cthread' +
                (suggest ? ' is-suggest' : '') + (c ? ` is-c-${c}` : '') +
                (t.unprinted ? ' is-unprinted' : '') });
            // Who wrote it, then the comment's start; the passage and the
            // thread are read in the preview.
            const who = el.createDiv({ cls: 'dendrite-cthread-meta' });
            priorityButton(who, it.priority, (p) =>
                this.plugin.setCommentPriority(this.file, t.id, t.n, p));
            review.shownAs(who.createEl('b'), it.author || 'Reviewer',
                           nameOf);
            const rs = it.replies || [];
            who.appendText(` · ${review.shortDate(it.date)}` + (rs.length ?
                ` · ${rs.length} repl${rs.length === 1 ? 'y' : 'ies'}` :
                ''));
            el.createDiv({ cls: 'dendrite-cthread-text', text: (suggest ?
                review.suggestionText(it) :
                review.noteLink(it.text).text).replace(/\s+/g, ' ').trim() });
            if (t.unprinted) {
                el.createDiv({ cls: 'dendrite-cthread-unprinted',
                    text: `${t.unprinted}: does not print` });
            }
            // The passage on pointing, as the preview may not show it.
            if (it.passage) {
                el.title = `On: ${core.stripComments(it.passage).trim()}`;
            }
            el.addEventListener('mouseenter', () => this.hover(t, true));
            el.addEventListener('mouseleave', () => this.hover(t, false));
            el.addEventListener('click', () => this.go(t));
        }
    }

    /** A comment pointed at: its passage and bubble in the preview. */
    hover(t, on) {
        const leaf = this.file && this.plugin.previewLeaf ?
            this.plugin.previewLeaf(this.file) : null;
        if (leaf && leaf.view.pointAt) {
            leaf.view.pointAt(t.id, t.n, on);
        }
    }

    /**
     * To a comment: in the preview, its comments shown, as stepping to
     * it there, which selects its card; without one, its card selected.
     */
    async go(t) {
        if (!this.file) return;
        const leaf = this.plugin.previewLeaf ?
            this.plugin.previewLeaf(this.file) : null;
        const pv = leaf && leaf.view;
        if (pv) {
            await pv.setComments(true);
            const k = pv.reviewList.findIndex((x) =>
                (x.parts || [x]).some((p) => p.id === t.id && p.n === t.n));
            if (k >= 0) {
                pv.reviewAt = k;
                await pv.goComment();
                return;
            }
        }
        await this.plugin.focusCard(this.file, t.id, false);
    }
}

class ManuscriptModal extends Modal {
    constructor(view) {
        super(view.app);
        this.view = view;
    }

    /**
     * The manuscript's settings in tabs, one shown at a time, all written
     * together by Save. It opens on the tab last used.
     */
    onOpen() {
        const { contentEl } = this;
        const view = this.view;
        const ms = view.manuscript();
        const st = ms.style;
        const draft = {};
        this.modalEl.addClass('dendrite-ms-modal');
        this.titleEl.setText(`${view.file.basename}: Settings`);
        const body = contentEl.createDiv({ cls: 'dendrite-ms-body' });
        const tabs = body.createDiv({ cls: 'dendrite-ms-tabs' });
        const panes = body.createDiv({ cls: 'dendrite-ms-panes' });
        const sections = [];
        const show = (name) => {
            for (const sec of sections) {
                sec.tab.toggleClass('is-active', sec.name === name);
                sec.pane.toggleClass('is-hidden', sec.name !== name);
            }
            ManuscriptModal.lastTab = name;
        };
        const section = (name, icon, intro) => {
            const tab = tabs.createEl('button', { cls: 'dendrite-ms-tab' });
            setIcon(tab.createSpan({ cls: 'dendrite-ms-tab-icon' }), icon);
            tab.createSpan({ text: name });
            tab.onclick = () => show(name);
            const pane = panes.createDiv({ cls: 'dendrite-ms-pane' });
            pane.dataset.tab = name;
            if (intro) pane.createEl('p', { cls: 'dendrite-ms-intro',
                                            text: intro });
            sections.push({ name, tab, pane });
            return pane;
        };
        const text = (el, name, desc, value, key, placeholder) =>
            new Setting(el).setName(name).setDesc(desc)
                .addText((t) => t.setPlaceholder(placeholder || '')
                    .setValue(value === null || value === undefined ? '' :
                        String(value))
                    .onChange((v) => { draft[key] = v.trim() || null; }));

        // ---- the manuscript: its name, IDs and section numbers
        let el = section('Manuscript', 'book-open');
        new Setting(el).setName('Title and prefix')
            .setDesc(`The index is ${view.file.basename}, and card IDs ` +
                     `start ${ms.prefix}. Renaming changes both, with ` +
                     'every card note and the folder.')
            .addButton((b) => b.setButtonText('Rename…').onClick(() => {
                this.close();
                new RenameModal(view).open();
            }));
        new Setting(el).setName('Number sections by position')
            .setDesc('Write headings without numbers; sections are ' +
                     'numbered from where they sit, and renumber when ' +
                     'moved.')
            .addToggle((tg) => tg.setValue(ms.number)
                .onChange((v) => { draft.dendrite_number_sections = v; }));
        new Setting(el).setName('Top section heading level')
            .setDesc('Export writes top-level sections at this level.')
            .addDropdown((d) => {
                for (let i = 1; i <= 4; i++) d.addOption(String(i), 'H' + i);
                d.setValue(String(ms.headingTop)).onChange((v) => {
                    draft.dendrite_heading_top = Number(v);
                });
            });

        // ---- length: the quota and how text is counted
        el = section('Length', 'ruler', 'The whole manuscript\'s quota, ' +
            'shown in the top bar against what it uses and what its ' +
            'sections allocate, and how words, characters and pages are ' +
            'counted.');
        quotaSetting(el, 'Total quota', 'In words, characters or pages; ' +
            'fractions allowed.', ms.limit, ms.limitRequired, draft);
        new Setting(el).setName('Count spaces in characters')
            .setDesc('Funding portals differ; check the call.')
            .addToggle((tg) => tg.setValue(ms.countSpaces)
                .onChange((v) => { draft.dendrite_count_spaces = v; }));
        new Setting(el).setName('Words per page')
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
        new Setting(el).setName('Characters per word')
            .setDesc('Only for comparing quotas set in characters with ' +
                     'quotas in words or pages, an estimate.')
            .addText((t) => t.setValue(String(ms.charsPerWord))
                .onChange((v) => {
                    draft.dendrite_chars_per_word = Number(v) > 0 ?
                        Number(v) : null;
                }));

        // ---- the page, for PDF and Word export
        el = section('Page', 'file', 'How PDF and Word export set the ' +
            'page and its text. Word export takes these through its ' +
            'reference document, unless one is set under References.');
        text(el, 'Font', 'Any font installed on this computer. Empty: ' +
             'Latin Modern, LaTeX\'s own.', st.font, 'dendrite_font',
             'Arial');
        text(el, 'Font size', 'In points: 8, 9, 10, 11, 12, 14, 17 or 20. ' +
             'Empty: 10.', st.fontSize, 'dendrite_font_size', '10');
        text(el, 'Line spacing', '1 is single, 1.5 one and a half. Empty: ' +
             'single.', st.lineSpacing, 'dendrite_line_spacing', '1');
        new Setting(el).setName('Paper')
            .addDropdown((d) => d.addOption('letter', 'US Letter')
                .addOption('a4', 'A4').setValue(st.paper || 'letter')
                .onChange((v) => {
                    draft.dendrite_paper = v === 'letter' ? null : v;
                }));
        text(el, 'Margin', 'On every side, such as 2cm or 1in. Empty: ' +
             '2.5cm.', st.margin, 'dendrite_margin', '2.5cm');
        text(el, 'Space above footnotes', 'For PDF, between the last line ' +
             'of text and the footnote rule, such as 14pt or 0.5cm; a ' +
             'bare number is in points. Empty: one line of text.',
             st.footnoteGap, 'dendrite_footnote_gap', '');

        // ---- header and footer: three slots each, drawn as on a page
        el = section('Header and footer', 'panel-top', 'For PDF, on every ' +
            'page in the text\'s font and size. Each slot takes several ' +
            'lines, **bold**, *italic*, {page} and {pages}. A footer set ' +
            'replaces the page number at the foot; so does {page} ' +
            'anywhere.');
        const grid = el.createDiv({ cls: 'dendrite-hf-grid' });
        for (const which of ['header', 'footer']) {
            const row = grid.createDiv({ cls: `dendrite-hf-row is-${which}` });
            row.createDiv({ cls: 'dendrite-hf-label',
                            text: which === 'header' ? 'Header' : 'Footer' });
            for (const [k, name] of [['left', 'Left'], ['center', 'Centre'],
                                     ['right', 'Right']]) {
                const key = `dendrite_${which}_${k}`;
                const now = st[which] && st[which][k];
                const ta = row.createEl('textarea',
                                        { cls: 'dendrite-hf-slot' });
                ta.value = now || '';
                ta.placeholder = name;
                ta.rows = 2;
                ta.addEventListener('input', () => {
                    draft[key] = ta.value.trim() || null;
                });
            }
            if (which === 'header') {
                grid.createDiv({ cls: 'dendrite-hf-page',
                                 text: 'the page\'s text' });
            }
        }
        new Setting(el).setName('Header and footer in the margin')
            .setDesc('Print them in the page margin, so the text keeps its ' +
                     'whole area, where the format allows it. Off, the ' +
                     'margin is measured to them and nothing is printed ' +
                     'in it. A small margin may not hold several lines.')
            .addToggle((tg) => tg.setValue(st.headerInMargin)
                .onChange((v) => {
                    draft.dendrite_header_in_margin = v || null;
                }));
        new Setting(el).setName('Page numbers')
            .setDesc('At the foot of each page, numbered consecutively, ' +
                     'when no footer is set.')
            .addToggle((tg) => tg.setValue(st.pageNumbers)
                .onChange((v) => {
                    draft.dendrite_page_numbers = v ? null : false;
                }));

        // ---- references, and the files export takes its style from
        el = section('References', 'quote', 'Citations come from Zotero ' +
            'at export; these set how they and the rest of the document ' +
            'look. Paths are from the vault root.');
        text(el, 'Citation style', 'A CSL style file in the vault, for PDF ' +
             'and Word export. Empty: Pandoc\'s default, Chicago ' +
             'author-date.', ms.csl, 'dendrite_csl', 'styles/nature.csl');
        text(el, 'Reference list heading', 'Over the list of references, ' +
             'for a citation style that prints one. Empty: References.',
             st.referencesTitle || null, 'dendrite_references_title',
             'References');
        const ref = text(el, 'Word reference document', 'A .docx whose ' +
             'styles Word export copies, fonts and sizes included. Set ' +
             'its styles in Word.', st.referenceDocx,
             'dendrite_reference_docx', 'styles/reference.docx');
        if (Platform.isDesktopApp) {
            ref.addButton((b) => b.setButtonText('Make one')
                .setTooltip('Writes Pandoc\'s own beside the index, to ' +
                            'open in Word, restyle and save')
                .onClick(async () => {
                    const rel = await view.makeReferenceDocx();
                    if (rel) draft.dendrite_reference_docx = rel;
                }));
        }
        text(el, 'Pandoc defaults file', 'For anything else a call asks, ' +
             'a Pandoc defaults file in the vault. The settings in these ' +
             'tabs win over it.', st.defaults, 'dendrite_pandoc_defaults',
             'styles/grant.yaml');

        // ---- review: where coauthors' comments come from
        el = section('Review', 'message-square', 'Comments and suggested ' +
            'changes come in from Review on the bar, only when you ask, ' +
            'and nothing is written to a card until you add them.');
        const linked = view.gdocUrl();
        const fm = view.app.metadataCache.getFileCache(view.file)
            ?.frontmatter || {};
        const gdoc = new Setting(el).setName('Google Doc')
            .setDesc(!Platform.isDesktopApp ? 'Linked from Obsidian on a ' +
                'computer.' : linked ? `Linked to ${fm.dendrite_gdoc_title ||
                linked}.` : 'The doc or Word file in Drive that coauthors ' +
                'review, chosen in Google\'s file picker, which gives ' +
                'Dendrite that file only.');
        if (Platform.isDesktopApp) {
            gdoc.addButton((b) => b.setButtonText(linked ? 'Change…' :
                                                  'Link a Google Doc…')
                .onClick(async () => {
                    this.close();
                    await view.plugin.linkGdoc(view.file);
                }));
            if (linked) {
                gdoc.addButton((b) => b.setButtonText('Unlink')
                    .onClick(async () => {
                        await writeProps(view.app, view.file, {
                            dendrite_gdoc: null,
                            dendrite_gdoc_title: null });
                        this.close();
                    }));
            }
        }

        show(sections.some((x) => x.name === ManuscriptModal.lastTab) ?
            ManuscriptModal.lastTab : 'Manuscript');
        const foot = contentEl.createDiv({ cls: 'dendrite-ms-foot' });
        foot.createEl('button', { text: 'Cancel' }).onclick = () =>
            this.close();
        const save = foot.createEl('button', { cls: 'mod-cta',
                                               text: 'Save' });
        save.onclick = async () => {
            await writeProps(view.app, view.file, draft);
            this.close();
        };
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
        // What the two sides of the comparison are called.
        this.labels = ['the note now', 'the text from before'];
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
     * unified or side by side; the choice is kept in the settings.
     */
    showDiff(now, before) {
        const settings = this.view.plugin.settings;
        const rows = core.lineDiff(now, before);
        const bar = this.contentEl.createDiv(
            { cls: 'dendrite-version-modes' });
        const box = this.contentEl.createDiv();
        const modes = [['unified', 'Unified', 'rows-2'],
                       ['split', 'Side by side', 'columns-2']];
        const draw = () => {
            const mode = settings.diffMode || 'unified';
            const split = mode === 'split';
            for (const b of bar.children) {
                b.toggleClass('is-active', b.dataset.mode === mode);
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
                if ((settings.diffMode || 'unified') !== mode) {
                    settings.diffMode = mode;
                    if (this.view.plugin.saveSettings) {
                        this.view.plugin.saveSettings();
                    }
                }
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
        const [now, other] = this.labels;
        key.createSpan({ cls: 'is-removed', text: `− ${now}` });
        key.createSpan({ text: ' · ' });
        key.createSpan({ cls: 'is-added', text: `+ ${other}` });
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
        const cap = (t) => t[0].toUpperCase() + t.slice(1);
        head.createEl('th', { cls: 'is-removed', text: cap(this.labels[0]) });
        head.createEl('th', { cls: 'is-added', text: cap(this.labels[1]) });
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

/**
 * A reviewer's suggested change to a card, shown as the comparison of
 * the card now and the card with it, to apply or not.
 */
class SuggestModal extends VersionModal {
    constructor(view, id, now, after, apply, tint = null, replies = [],
                keep = null) {
        super(view, id);
        this.now = now;
        this.after = after;
        this.apply = apply;
        this.tint = tint;
        this.replies = replies;
        this.keep = keep;
        this.labels = ['the card now', 'with the change'];
    }

    async onOpen() {
        const { contentEl, view, id } = this;
        // The card now in grey, with the change in the reviewer's colour,
        // or the accent's, as their suggestions are drawn on the board.
        this.modalEl.style.setProperty('--dendrite-now', 'var(--text-muted)');
        this.modalEl.style.setProperty('--dendrite-before', this.tint ?
            review.colourCss(this.tint) : 'var(--interactive-accent)');
        const node = view.byId.get(id);
        this.titleEl.setText(`Apply the suggested change to card ` +
            `${core.shortId(id)}` + (node && node.label ?
                ` (${node.label})` : ''));
        contentEl.createEl('p', { text: 'The passage it was made on is ' +
            'still in the card as the reviewer was sent it. Nothing has ' +
            'been written yet.' });
        this.showDiff(review.stripReview(this.now),
                      review.stripReview(this.after));
        // Replies that say something are lost with it unless kept.
        const many = this.replies.length > 1;
        if (this.replies.length) {
            const box = contentEl.createDiv({
                cls: 'dendrite-suggest-replies' });
            box.createEl('p', { text: 'Applying it removes its ' +
                (many ? `${this.replies.length} replies:` : 'reply:') });
            const list = box.createEl('ul');
            for (const r of this.replies) {
                list.createEl('li', { text: `${r.author}, ` +
                    `${review.shortDate(r.date)}: ${r.text}` });
            }
        }
        const row = contentEl.createDiv({ cls: 'dendrite-version-choices' });
        const yes = row.createEl('button', { cls: 'mod-cta',
                                             text: 'Apply' });
        yes.onclick = async () => {
            this.close();
            await this.apply();
        };
        if (this.keep) {
            row.createEl('button', { text: 'Apply, keep the ' +
                (many ? 'replies' : 'reply') + ' as a comment' })
                .onclick = async () => {
                    this.close();
                    await this.keep();
                };
        }
        row.createEl('button', { text: 'Cancel' }).onclick = () =>
            this.close();
    }
}

/**
 * The comments and changes read from a returned Word file, each with the
 * card it was found in, to choose which to add. A row not found in any
 * card can go on the selected card instead.
 */
/**
 * Changes a reviewer asks to its own pending suggestions, from the inbox:
 * each with the suggestion as it is and what it would become, or that
 * it would be withdrawn, ticked to accept. One no longer found, or
 * replied to since, cannot be ticked. Nothing is written until Accept.
 */
/**
 * What waits for the writer, as an inbox: each review or request from a
 * program, newest first, by who sent it, when, its title and what it
 * holds; a click opens it to add or ignore.
 */
class InboxModal extends Modal {
    constructor(view) {
        super(view.app);
        this.view = view;
    }

    onOpen() {
        const { contentEl, view } = this;
        this.titleEl.setText('Inbox');
        this.modalEl.addClass('dendrite-inbox-modal');
        const list = contentEl.createDiv({ cls: 'dendrite-inbox' });
        const when = (iso) => {
            const d = new Date(iso);
            if (isNaN(d)) return '';
            const today = new Date().toDateString() === d.toDateString();
            return today ? d.toLocaleTimeString([], { hour: '2-digit',
                                                       minute: '2-digit' }) :
                review.shortDate(localDay(d));
        };
        const entries = [...view.inbox].sort((a, b) =>
            String(b.received).localeCompare(String(a.received)));
        for (const entry of entries) {
            const revise = entry.kind === 'revise';
            const row = list.createDiv({ cls: 'dendrite-inbox-row' });
            setIcon(row.createDiv({ cls: 'dendrite-inbox-icon' }),
                    revise ? 'pencil' : 'message-square-plus');
            const main = row.createDiv({ cls: 'dendrite-inbox-main' });
            const top = main.createDiv({ cls: 'dendrite-inbox-top' });
            top.createSpan({ cls: 'dendrite-inbox-from',
                             text: reviewAuthors(entry.items) });
            top.createSpan({ cls: 'dendrite-inbox-when',
                             text: when(entry.received) });
            main.createDiv({ cls: 'dendrite-inbox-title', text: entry.title });
            const n = entry.items.length;
            main.createDiv({ cls: 'dendrite-inbox-what', text: (revise ?
                `${n} change${n === 1 ? '' : 's'} to suggestions` :
                `${n} comment${n === 1 ? '' : 's'} to add`) +
                (entry.replaces && entry.replaces.length ?
                    ' · replaces an earlier request' : '') });
            row.addEventListener('click', () => {
                this.close();
                view.openInbox(entry);
            });
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ReviseModal extends Modal {
    constructor(view, entry, rows) {
        super(view.app);
        this.view = view;
        this.entry = entry;
        this.rows = rows;
    }

    onOpen() {
        const { contentEl, view, rows, entry } = this;
        this.modalEl.addClass('dendrite-wide');
        this.titleEl.setText(entry.title);
        contentEl.createEl('p', { text: `${reviewAuthors(entry.items)} ` +
            `asks to change ${rows.length} of its pending suggestion` +
            `${rows.length === 1 ? '' : 's'}. Nothing is written until ` +
            'you accept; each card changed is one step for Ctrl+Z on the ' +
            'board.' });
        if (entry.replaces && entry.replaces.length) {
            contentEl.createEl('p', { cls: 'dendrite-review-replaces',
                text: 'Replaces an earlier request for the same ' +
                    'suggestions, which no longer asks for them.' });
        }
        const list = contentEl.createDiv({ cls: 'dendrite-review-rows' });
        const count = () => rows.filter((x) => x.use).length;
        let go = null;
        for (const row of rows) {
            const { item } = row;
            const c = view.colourOf()(item.author);
            const el = list.createDiv({ cls: 'dendrite-review-row ' +
                'is-suggest' + (c ? ` is-c-${c}` : '') });
            const box = el.createEl('input', { type: 'checkbox' });
            box.checked = row.use;
            box.disabled = !!row.reason;
            box.onchange = () => {
                row.use = box.checked;
                go.setText(`Accept ${count()}`);
            };
            const main = el.createDiv({ cls: 'dendrite-review-main' });
            const meta = main.createDiv({ cls: 'dendrite-review-meta' });
            review.shownAs(meta.createEl('b'), item.author, view.nameOf());
            meta.appendText(` · card ${core.shortId(item.card)} · ` +
                (item.withdraw ? 'withdraw' : 'revise'));
            if (item.quote) {
                main.createDiv({ cls: 'dendrite-review-quote',
                                 text: `“${item.quote}”` });
            }
            const now = row.it ? review.suggestionText(row.it) :
                item.current !== undefined ? `Suggests: ${item.current}` :
                '';
            main.createDiv({ cls: 'dendrite-review-text',
                text: item.withdraw ? `Withdraw: ${now}` :
                    `${now} → ${item.replace.trim() ||
                        '(delete the passage)'}` });
            if (row.reason) {
                main.createDiv({ cls: 'dendrite-review-where is-missing',
                                 text: `Cannot be changed: ${row.reason}.` });
            }
        }
        const buttons = contentEl.createDiv(
            { cls: 'dendrite-version-choices' });
        go = buttons.createEl('button', { cls: 'mod-cta',
                                          text: `Accept ${count()}` });
        go.onclick = async () => {
            this.close();
            await view.applyRevisions(rows.filter((x) => x.use));
            await view.takeInbox(entry, 'added');
        };
        buttons.createEl('button', { text: 'Ignore these' }).onclick =
            async () => {
                this.close();
                await view.takeInbox(entry, 'ignored');
            };
        buttons.createEl('button', { text: 'Cancel' }).onclick = () =>
            this.close();
    }

    onClose() { this.contentEl.empty(); }
}

class ReviewImportModal extends Modal {
    constructor(view, name, rows, inbox = null) {
        super(view.app);
        this.view = view;
        this.name = name;
        this.rows = rows;
        this.inbox = inbox;
    }

    onOpen() {
        const { contentEl, view, rows } = this;
        this.modalEl.addClass('dendrite-wide');
        this.titleEl.setText(`Review comments in ${this.name}`);
        const found = rows.filter((x) => x.at).length;
        const dups = rows.filter((x) => x.dup).length;
        const done = rows.filter((x) => x.done).length;
        const relinks = rows.filter((x) => x.relink).length;
        contentEl.createEl('p', { text: `${rows.length} comment` +
            `${rows.length === 1 ? '' : 's'} and suggested change` +
            `${rows.length === 1 ? '' : 's'}; ${found} found in the cards` +
            (dups ? `, ${dups} already in the cards` : '') +
            (done ? `, ${done} resolved here before` : '') + '. ' +
            (relinks ? `${relinks} already in the cards will get ` +
                `${relinks === 1 ? 'its' : 'their'} Google Docs link. ` :
                '') +
            // From a Google Doc or a Word file in Drive: whether any of its
            // comments has a link, which those kept inside a Word file,
            // not in Drive's own comments, do not.
            (this.name && /\(Google Docs\)$/.test(this.name) &&
             rows.some((x) => x.item.kind === 'comment') &&
             !rows.some((x) => x.item.link) ?
                'None has a Google Docs link: its comments are kept inside ' +
                'the Word file, not in Google Docs\' own comments, so ' +
                'Google gives them no link to their thread. ' : '') +
            'Each goes after its passage in the card, which is set to ' +
            'revise. A change still made on the text as it was sent can ' +
            'be applied from its card later; one whose passage has ' +
            'changed since comes in as a comment. Nothing is written ' +
            'until you add them, and Ctrl+Z on the board undoes it.' });
        const list = contentEl.createDiv({ cls: 'dendrite-review-rows' });
        const active = view.active && view.byId.get(view.active);
        const count = () => rows.filter((x) => x.use).length;
        // Comments already in that gain their link go with the others.
        const linking = rows.filter((x) => x.relink).length;
        const addLabel = () => `Add ${count()}` +
            (linking ? ` and link ${linking}` : '');
        let go = null;
        for (const row of rows) {
            const it = row.item;
            const c = view.colourOf()(it.author || 'Reviewer');
            const el = list.createDiv({ cls: 'dendrite-review-row' +
                (it.kind === 'change' ? ' is-suggest' : '') +
                (c ? ` is-c-${c}` : '') });
            const box = el.createEl('input', { type: 'checkbox' });
            box.checked = row.use;
            box.disabled = !row.at && !active;
            box.onchange = () => {
                row.use = box.checked;
                go.setText(addLabel());
            };
            const main = el.createDiv({ cls: 'dendrite-review-main' });
            const meta = main.createDiv({ cls: 'dendrite-review-meta' });
            review.shownAs(meta.createEl('b'), it.author || 'Reviewer',
                           view.nameOf());
            meta.appendText(` · ${review.shortDate(it.date)} · ` +
                (it.kind === 'change' ? 'suggested change' : 'comment'));
            if (it.quote) {
                main.createDiv({ cls: 'dendrite-review-quote',
                                 text: `“${it.quote}”` });
            }
            main.createDiv({ cls: 'dendrite-review-text',
                text: it.kind === 'comment' ? it.text :
                    !it.insert ? 'Delete this.' :
                    it.quote ? `Replace with “${it.insert.trim()}”` :
                    `Add “${it.insert.trim()}”` });
            const where = main.createDiv({ cls: 'dendrite-review-where' });
            if (it.link) {
                const a = main.createEl('a', { cls: 'dendrite-review-open',
                                               text: 'Open in Google Docs' });
                a.href = it.link;
                a.onclick = (e) => {
                    e.preventDefault();
                    openExternal(it.link);
                };
            }
            // Red only for one that cannot be placed; amber for one placed
            // that should be checked; grey for one already dealt with.
            if (row.done) {
                where.addClass('is-known');
                where.setText('Resolved here before: left unticked.');
            } else if (row.dup && row.relink) {
                where.setText(`Already in the card, ` +
                    `${core.shortId(row.at.id)}: gets its Google Docs link.`);
            } else if (row.dup) {
                where.addClass('is-known');
                where.setText(`Already in the card, ` +
                    `${core.shortId(row.at.id)}: left unticked.`);
            } else if (row.at && row.at.how === 'mapped') {
                const node = view.byId.get(row.at.id);
                where.addClass('is-close');
                where.setText(`→ card ${core.shortId(row.at.id)}` +
                    (node && node.label ? ` (${node.label})` : '') +
                    ', found in an earlier version of it, card ' +
                    `${core.shortId(row.at.from)}: placed where its text ` +
                    'now is. Check it.');
            } else if (row.at && row.at.how === 'old') {
                const node = view.byId.get(row.at.id);
                where.addClass('is-close');
                where.setText(`→ card ${core.shortId(row.at.id)}` +
                    (node && node.label ? ` (${node.label})` : '') +
                    ', found in an earlier version of it, card ' +
                    `${core.shortId(row.at.from)}: goes at the end of the ` +
                    'current one, with the passage quoted.');
            } else if (row.at) {
                const node = view.byId.get(row.at.id);
                if (row.at.how === 'close') where.addClass('is-close');
                where.setText(`→ card ${core.shortId(row.at.id)}` +
                    (node && node.label ? ` (${node.label})` : '') +
                    (row.at.how === 'close' ? ', found by most of its ' +
                        'words: check it' : ''));
            } else {
                where.addClass('is-missing');
                where.setText(active ? 'Not found in the cards. Ticked, ' +
                    `it goes at the end of the selected card, ` +
                    `${core.shortId(active.id)}, with the passage quoted.` :
                    'Not found in the cards. Select a card to put it ' +
                    'there instead.');
            }
        }
        const buttons = contentEl.createDiv(
            { cls: 'dendrite-version-choices' });
        go = buttons.createEl('button', { cls: 'mod-cta',
                                          text: addLabel() });
        go.onclick = async () => {
            this.close();
            await view.addReview(rows.filter((x) => x.use), active,
                                 rows.filter((x) => x.relink));
            if (this.inbox) await view.takeInbox(this.inbox, 'added');
        };
        if (this.inbox) {
            buttons.createEl('button', { text: 'Ignore this review' })
                .onclick = async () => {
                    this.close();
                    await view.takeInbox(this.inbox, 'ignored');
                };
        }
        buttons.createEl('button', { text: 'Cancel' }).onclick = () =>
            this.close();
    }

    onClose() { this.contentEl.empty(); }
}

/**
 * What a group of picked cards becomes: a section, with a heading that
 * numbers them below it, or scaffolding, which only gathers them, so
 * they print and number as they did.
 */
// An image file, by its extension.
const IMAGE_EXT = /^(png|jpe?g|gif|svg|webp|bmp|tiff?|avif)$/i;

/**
 * Obsidian's note search under a text box, as a link is typed; `pick`
 * is called with the note chosen. A leading [[ or ![[ is searched
 * without. `images` searches image files instead of notes.
 */
function noteSuggest(app, input, pick, images = false) {
    if (typeof AbstractInputSuggest !== 'function') return null;
    class NoteSuggest extends AbstractInputSuggest {
        getSuggestions(query) {
            const q = query.replace(/^\s*!?\[\[|\]\]\s*$/g, '').trim();
            const files = images ? app.vault.getFiles().filter((f) =>
                IMAGE_EXT.test(f.extension)) : app.vault.getMarkdownFiles();
            if (!q) return files.slice(0, 20);
            const match = typeof prepareFuzzySearch === 'function' ?
                prepareFuzzySearch(q) : null;
            const scored = [];
            for (const f of files) {
                const name = f.path.replace(/\.md$/, '');
                const m = match ? match(name) :
                    name.toLowerCase().includes(q.toLowerCase()) ?
                        { score: 0 } : null;
                if (m) scored.push([m.score, f]);
            }
            return scored.sort((a, b) => b[0] - a[0]).slice(0, 20)
                .map(([, f]) => f);
        }

        renderSuggestion(f, el) {
            el.createDiv({ text: images ? f.name : f.basename });
            if (f.parent && f.parent.path !== '/') {
                el.createDiv({ cls: 'dendrite-reviewer-path',
                               text: f.parent.path });
            }
        }

        selectSuggestion(f) {
            this.setValue(images ? f.name : f.basename);
            this.close();
            pick(f);
        }
    }
    return new NoteSuggest(app, input);
}

/**
 * The manuscript's reviewers: each one's colour, and the person's note
 * where there is one, offered when a note has their name. A reviewer
 * that is not a person, such as Claude, keeps a plain name.
 */
/** Who a draft went to, for its review round. */
class RoundModal extends Modal {
    constructor(view) {
        super(view.app);
        this.view = view;
    }

    onOpen() {
        this.titleEl.setText('Mark as sent for review');
        this.contentEl.createEl('p', { cls: 'setting-item-description',
            text: 'Keeps what each card prints now, so the board can show ' +
                'which cards change from here on.' });
        const input = this.contentEl.createEl('input', { type: 'text' });
        input.placeholder = 'Sent to';
        input.addClass('dendrite-round-to');
        const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
        const go = row.createEl('button', { text: 'Record', cls: 'mod-cta' });
        go.onclick = async () => {
            this.close();
            await this.view.recordRound(input.value);
            new Notice('Dendrite: recorded as sent for review.');
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                go.onclick();
            }
        });
        input.focus();
    }

    onClose() { this.contentEl.empty(); }
}

class ReviewersModal extends Modal {
    constructor(view) {
        super(view.app);
        this.view = view;
    }

    /**
     * The reviewers as kept, then any only in the cards, in order; as
     * this dialog last saved them while the index is still as it was
     * read before, which would otherwise show a colour just picked as it
     * was.
     */
    entries() {
        const view = this.view;
        const fm = this.app.metadataCache.getFileCache(view.file)
            ?.frontmatter || {};
        let kept = review.reviewerEntries(fm.dendrite_reviewer_colours);
        // The index not yet read again since this dialog saved it: what
        // was saved. Read again, or changed elsewhere, as by a colour set
        // from a comment: what it holds.
        if (this.latest && JSON.stringify(kept) === this.latest.before) {
            kept = this.latest.saved.map((e) => Object.assign({}, e));
        } else {
            this.latest = null;
        }
        const map = view.reviewers();
        const order = [];
        for (const n of core.allNodes(view.root)) {
            for (const who of (view.reviewersOf || new Map()).get(n.id) ||
                []) {
                if (!order.includes(who)) order.push(who);
            }
        }
        for (const e of kept) if (!order.includes(e.name)) order.push(e.name);
        // Me, once you sign with your name, is you, with no entry of its own.
        const others = view.otherSelves();
        const all = order.filter((name) => !others.includes(name))
            .map((name) => kept.find((e) => e.name === name) ||
                { name, note: null, colour: map.get(name) || 'blue' });
        // One person's names together, where the first of them comes.
        const out = [];
        for (const e of all) {
            if (out.includes(e)) continue;
            out.push(e, ...all.filter((x) => x !== e && e.note &&
                                     x.note === e.note));
        }
        return out;
    }

    onOpen() {
        this.modalEl.addClass('dendrite-reviewers-modal');
        this.titleEl.setText('Reviewers');
        this.contentEl.createEl('p', { cls: 'setting-item-description',
            text: 'Each reviewer\'s comments and suggested changes are ' +
                'drawn in their colour, kept for this manuscript. A ' +
                'reviewer who is a person can be linked to their note.' });
        this.list = this.contentEl.createDiv({ cls: 'dendrite-reviewers' });
        this.draw();
    }

    /** The entries saved, and the dialog drawn from them. */
    async save(now) {
        const fm = this.app.metadataCache.getFileCache(this.view.file)
            ?.frontmatter || {};
        this.latest = { saved: now, before: JSON.stringify(
            review.reviewerEntries(fm.dendrite_reviewer_colours)) };
        await this.view.saveEntries(now);
        this.draw();
    }

    draw() {
        this.list.empty();
        const entries = this.entries();
        // `fn` applied to the names in `which`, as the property is now,
        // since a colour can be changed from a comment while this is open.
        const change = async (which, fn) => {
            const now = this.entries();
            for (const x of now) {
                if (which.some((y) => y.name === x.name)) fn(x, now);
            }
            await this.save(now);
        };
        // One block per person: the names linked to one note together,
        // a name linked to none on its own.
        const people = [];
        for (const e of entries) {
            const p = e.note && people.find((x) => x[0].note === e.note);
            if (p) p.push(e);
            else people.push([e]);
        }
        const find = (n) => this.app.metadataCache.getFirstLinkpathDest(n,
            this.view.file.path);
        const me = this.drawYou(entries);
        for (const names of people) {
            const e = names[0];
            // You are drawn above, apart from the reviewers.
            if (names.length === 1 && me.has(e.name)) continue;
            const person = e.note ? e.note.split('/').pop() : e.name;
            // Who, then their note, then their colour, as You's row is.
            const { block, mid } = this.row('dendrite-reviewer', person,
                e.colour, (c) => change(names, (x) => { x.colour = c; }));
            block.dataset.name = e.name;
            block.dataset.person = person;
            const note = mid.createEl('input', { type: 'text',
                cls: 'dendrite-reviewer-note' });
            note.placeholder = 'Their note, if a person';
            note.value = e.note ? e.note.split('/').pop() : '';
            const said = mid.createDiv({ cls: 'dendrite-reviewer-said' });
            // Every name of this person linked to note `f`, or to none;
            // linked to someone already here, they take that colour.
            const link = (f) => {
                const to = f ? this.linktext(f) : null;
                return change(names, (x, now) => {
                    const known = to && now.find((y) => y.note === to &&
                        !names.some((n) => n.name === y.name));
                    x.note = to;
                    if (known) x.colour = known.colour;
                });
            };
            // Found as it is typed, with Obsidian's note search.
            noteSuggest(this.app, note, (f) => link(f));
            note.addEventListener('change', async () => {
                const v = note.value.trim().replace(/^\[\[|\]\]$/g, '');
                if (!v) {
                    await link(null);
                    return;
                }
                const f = find(v);
                if (f) await link(f);
                else said.setText(`No note named ${v}`);
            });
            if (e.note) {
                // The names the reviews wrote, each unlinked on its own.
                const as = mid.createDiv({ cls: 'dendrite-reviewer-names' });
                as.createSpan({ text: 'includes:' });
                for (const x of names) {
                    const chip = as.createSpan({
                        cls: 'dendrite-reviewer-alias' });
                    chip.dataset.name = x.name;
                    chip.createSpan({ text: x.name });
                    const off = chip.createEl('button', {
                        cls: 'dendrite-reviewer-unlink', text: '×' });
                    off.title = `Not ${person}: unlink ${x.name}`;
                    off.onclick = () => change([x], (y) => {
                        y.note = null;
                    });
                }
                continue;
            }
            // A note with their name, offered when not linked; or with
            // it less a number Word adds, as "Aly Karsan 2".
            const named = find(e.name) || (/\s\d+$/.test(e.name) &&
                find(e.name.replace(/\s\d+$/, '')));
            if (named) {
                const b = mid.createEl('button', {
                    cls: 'dendrite-reviewer-offer',
                    text: `Link [[${named.basename}]]` });
                b.onclick = () => link(named);
            }
        }
    }

    /**
     * One row of the dialog, laid out alike for You and each reviewer:
     * who, with their colour's dot; a middle part, returned to be
     * filled; and their colour, a button showing it that opens a menu of
     * the colours, each with its chip, `pick(colour)` told of the choice.
     */
    row(cls, name, colour, pick) {
        const block = this.list.createDiv({ cls });
        const who = block.createDiv({ cls: 'dendrite-reviewer-who' });
        const dot = who.createSpan({ cls: 'dendrite-reviewer-dot' });
        dot.style.background = review.colourCss(colour);
        who.createSpan({ cls: 'dendrite-reviewer-name', text: name });
        const mid = block.createDiv({ cls: 'dendrite-reviewer-mid' });
        const btn = block.createEl('button', {
            cls: 'dendrite-reviewer-colour' });
        btn.dataset.colour = colour;
        btn.append(colourTitle(colour));
        btn.setAttr('aria-label', `Colour for ${name}`);
        btn.addEventListener('click', (e) => {
            const m = dendriteMenu(false);
            for (const c of review.REVIEWER_COLOURS) {
                m.addItem((i) => {
                    i.setTitle(colourTitle(c)).onClick(() => pick(c));
                    if (typeof i.setChecked === 'function') {
                        i.setChecked(c === colour);
                    }
                });
            }
            if (m.showAtMouseEvent) m.showAtMouseEvent(e);
        });
        return { block, mid };
    }

    /**
     * You, at the top: your colour, the name your replies are signed with
     * in the cards, and the name you are shown as, on the board, in the
     * preview and in what is sent out. The name you sign with, or Me.
     */
    drawYou(entries) {
        const view = this.view;
        const s = view.plugin.settings;
        const me = s.replyName || 'Me';
        const mine = view.selfNames();
        const own = entries.find((e) => e.name === me) ||
            entries.find((e) => mine.has(e.name));
        const { mid } = this.row('dendrite-reviewer-self', 'You',
            own ? own.colour : 'blue', async (c) => {
                const now = this.entries();
                const e = now.find((x) => x.name === me);
                if (e) e.colour = c;
                else now.push({ name: me, note: null, colour: c });
                await this.save(now);
            });
        const field = (cls, label, value, placeholder, set) => {
            const at = mid.createEl('label', {
                cls: 'dendrite-reviewer-self-field' });
            at.createSpan({ text: label });
            const input = at.createEl('input', { type: 'text', cls });
            input.value = value || '';
            input.placeholder = placeholder;
            input.addEventListener('change', async () => {
                set(input.value.trim());
                if (view.plugin.saveSettings) await view.plugin.saveSettings();
                // Which names are yours may have changed.
                view.reviewerMap = null;
                view.recolour();
                this.draw();
            });
        };
        field('dendrite-reviewer-signed', 'Replies signed', s.replyName, 'Me',
              (v) => { s.replyName = v; });
        field('dendrite-reviewer-shown', 'Shown as', s.presentName, me,
              (v) => { s.presentName = v; });
        return mine;
    }

    /** A note as a link reaches it: by its name, or its path if shared. */
    linktext(f) {
        const by = this.app.metadataCache.getFirstLinkpathDest(f.basename,
            this.view.file.path);
        return by === f ? f.basename : f.path.replace(/\.md$/, '');
    }

    onClose() { this.contentEl.empty(); }
}

class GroupModal extends Modal {
    constructor(view) {
        super(view.app);
        this.view = view;
    }

    onOpen() {
        const { contentEl, view } = this;
        const n = view.picked.size;
        this.titleEl.setText(`Group ${n} cards under a new card`);
        const choices = [
            ['section', 'Section with a heading',
             'A new section: you write its heading, and the cards become ' +
             'its subsections, numbered and printed a level down.'],
            ['scaffolding', 'Scaffolding',
             'Only gathers them on the board: they print, and are ' +
             'numbered, as they are now.']];
        for (const [, label, desc] of choices) {
            const p = contentEl.createEl('p');
            p.createEl('b', { text: label });
            p.appendText(`: ${desc}`);
        }
        const row = contentEl.createDiv({ cls: 'dendrite-version-choices' });
        for (const [kind, label] of choices) {
            const b = row.createEl('button', { text: label });
            if (kind === 'section') b.addClass('mod-cta');
            b.onclick = async () => {
                this.close();
                await view.groupPicked(kind);
            };
        }
    }

    onClose() { this.contentEl.empty(); }
}

/** A comment's text, asked for; `send(text)` once given. */
class CommentModal extends Modal {
    constructor(app, send) {
        super(app);
        this.send = send;
    }

    onOpen() {
        this.titleEl.setText('Comment on the selection');
        const box = this.contentEl.createEl('textarea',
            { cls: 'dendrite-review-reply-box' });
        box.rows = 3;
        box.placeholder = 'Comment';
        const row = this.contentEl.createDiv(
            { cls: 'dendrite-version-choices' });
        const go = row.createEl('button', { text: 'Comment',
                                            cls: 'mod-cta' });
        go.onclick = () => {
            const t = box.value.trim();
            if (!t) return;
            this.close();
            this.send(t);
        };
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                go.onclick();
            }
        });
        box.focus();
    }

    onClose() { this.contentEl.empty(); }
}

class StackModal extends Modal {
    constructor(view, id) {
        super(view.app);
        this.view = view;
        this.id = id;
    }

    onOpen() {
        this.ready = this.fill();
    }

    async fill() {
        const { contentEl, view } = this;
        contentEl.empty();
        this.modalEl.addClass('dendrite-wide');
        const node = view.byId.get(this.id);
        this.titleEl.setText('Versions of ' +
            (node && node.label ? node.label : core.shortId(this.id)));
        contentEl.createEl('p', { text: 'The newest first. Old versions ' +
            'are kept under the card, hidden on the board and left out ' +
            'of the manuscript. Making one current puts this card at the ' +
            'top of the stack; Ctrl+Z on the board undoes either.' });
        const text = async (id) => {
            const f = view.cardFile(id);
            return f ? core.splitFrontmatter(
                await view.app.vault.read(f)).body.trim() : '';
        };
        const list = contentEl.createDiv({ cls: 'dendrite-stack' });
        const row = async (id, label) => {
            const el = list.createDiv({ cls: 'dendrite-stack-row' });
            el.createDiv({ cls: 'dendrite-review-meta', text: label });
            el.createDiv({ cls: 'dendrite-stack-text',
                           text: await text(id) || '(empty)' });
            return el;
        };
        await row(this.id, 'Current');
        for (const old of view.stackOf(this.id)) {
            const when = view.cardProps(old.id).dendrite_superseded;
            const el = await row(old.id, `Replaced ${when}, card ` +
                                 core.shortId(old.id));
            const buttons = el.createDiv({ cls: 'dendrite-version-choices' });
            buttons.createEl('button', { cls: 'mod-cta',
                                         text: 'Make current' })
                .onclick = async () => {
                    this.close();
                    await view.promote(this.id, old.id);
                };
            buttons.createEl('button', { cls: 'mod-warning',
                                         text: 'Delete' })
                .onclick = async () => {
                    await view.deleteVersion(old.id);
                    if (view.stackOf(this.id).length) await this.fill();
                    else this.close();
                };
        }
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

/**
 * A card's alias, `alias` or none for null, in its aliases property,
 * the one Dendrite gave it before, kept in dendrite_alias, replaced and
 * any of the writer's own left; nothing is written if it is there.
 */
async function keepAlias(app, file, alias) {
    const list = (v) => Array.isArray(v) ? v.map(String) :
        (v ? [String(v)] : []);
    const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
    if ((fm.dendrite_alias || null) === alias &&
        (!alias || list(fm.aliases).includes(alias))) return;
    await app.fileManager.processFrontMatter(file, (front) => {
        const was = front.dendrite_alias;
        const out = list(front.aliases).filter((a) => a !== was);
        if (alias && !out.includes(alias)) out.push(alias);
        if (out.length) front.aliases = out;
        else delete front.aliases;
        if (alias) front.dendrite_alias = alias;
        else delete front.dendrite_alias;
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

class RenameModal extends Modal {
    constructor(view) {
        super(view.app);
        this.view = view;
    }

    onOpen() {
        const { contentEl } = this;
        const view = this.view;
        let title = view.file.basename;
        let prefix = view.prefix() || '';
        this.titleEl.setText(`Rename ${title}`);
        new Setting(contentEl).setName('Title')
            .setDesc('Names the index note, and its folder when the ' +
                     'folder has the same name.')
            .addText((t) => t.setValue(title)
                .onChange((v) => { title = v; }));
        new Setting(contentEl).setName('Prefix')
            .setDesc('Starts every card ID. Each card note is renamed to ' +
                     'it, keeping its last five characters.')
            .addText((t) => t.setValue(prefix)
                .onChange((v) => { prefix = v.trim(); }));
        contentEl.createEl('p', { text: 'Let your other devices finish ' +
            'syncing first. A board open on another device follows the ' +
            'rename as it arrives and changes nothing until every card ' +
            'is there. A note under the old name that a device brings ' +
            'back later is marked on the board as an old copy and not ' +
            'used. Links elsewhere in the vault follow when Obsidian is ' +
            'set to update internal links. This is not an undo step; ' +
            'rename again to go back.' });
        new Setting(contentEl)
            .addButton((b) => b.setButtonText('Cancel')
                .onClick(() => this.close()))
            .addButton((b) => b.setButtonText('Rename').setCta()
                .onClick(async () => {
                    this.close();
                    await view.renameManuscript(title, prefix);
                }));
    }

    onClose() { this.contentEl.empty(); }
}

/**
 * Notes under a manuscript's name before its rename, brought back by a
 * sync: each can be opened, to copy any writing it holds into the card
 * it names, and moved to the trash.
 */
class OldCopiesModal extends Modal {
    constructor(view) {
        super(view.app);
        this.view = view;
    }

    onOpen() {
        const { contentEl } = this;
        const view = this.view;
        contentEl.empty();
        this.titleEl.setText('Old copies from before the rename');
        contentEl.createEl('p', { text: 'These notes carry a name this ' +
            'manuscript had before it was renamed. A device that had not ' +
            'synced the rename brought them back. The manuscript does not ' +
            'use them. If one holds writing you want, open it and copy ' +
            'the writing into the card it names, then move it to the ' +
            'trash.' });
        for (const c of view.oldCopies) {
            const node = c.id && view.byId.get(c.id);
            const desc = c.id === null && prefixOf(this.app, c.file) ?
                'the index as it was' : node ?
                    `old copy of card ${core.shortId(c.id)}` +
                    (node.label ? ` (${node.label})` : '') :
                    'a card the index does not list';
            new Setting(contentEl).setName(c.file.path).setDesc(desc)
                .addButton((b) => b.setButtonText('Open').onClick(() => {
                    this.app.workspace.getLeaf('tab').openFile(c.file);
                }))
                .addButton((b) => b.setButtonText('Move to trash')
                    .setWarning().onClick(async () => {
                        await this.app.fileManager.trashFile(c.file);
                        view.checkOldCopies();
                        if (view.oldCopies.length) this.onOpen();
                        else this.close();
                    }));
        }
    }

    onClose() { this.contentEl.empty(); }
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
        this.plugin.syncReviewApi();
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

        heading('Review');
        new Setting(containerEl).setName('Fold comments until clicked')
            .setDesc('A comment shows its first line and its latest reply ' +
                     'until you click it, and folds again when you click ' +
                     'elsewhere, on the board, in a card and in the ' +
                     'preview. Off, comments are open, and fold only by ' +
                     'their ▸ toggle.')
            .addToggle((tg) => tg.setValue(s.foldComments).onChange((v) => {
                s.foldComments = v;
                review.setFoldUntilClicked(v);
                save();
                this.plugin.rerender();
                if (this.plugin.refreshPreviews) this.plugin.refreshPreviews();
            }));
        new Setting(containerEl).setName('Your name, on replies')
            .setDesc('Replies you write to review comments are signed ' +
                     'with this, as a reviewer\'s comments are with theirs.')
            .addText((t) => t.setPlaceholder('Me').setValue(s.replyName)
                .onChange((v) => {
                    s.replyName = v.trim();
                    save();
                }));
        new Setting(containerEl)
            .setName('Accept reviews from programs on this computer')
            .setDesc('Listens on 127.0.0.1 for review comments sent by a ' +
                     'program, such as an agent, with a key. Each waits ' +
                     'on its manuscript\'s board, and nothing is written ' +
                     'until you add it there. The port and key are in ' +
                     `${discoveryPath(this.app.vault.getName())} while ` +
                     'Dendrite listens. Desktop only.')
            .addToggle((tg) => tg.setValue(!!s.reviewApi)
                .onChange(async (v) => {
                    s.reviewApi = v;
                    await save();
                    await this.plugin.syncReviewApi();
                }));
        new Setting(containerEl).setName('Review port')
            .setDesc('0 for any free port. Taken, Dendrite listens on a ' +
                     'free one instead. Applied when settings are closed.')
            .addText((t) => t.setValue(String(s.reviewApiPort))
                .onChange((v) => {
                    const n = Number(v);
                    s.reviewApiPort = Number.isInteger(n) && n >= 0 &&
                        n < 65536 ? n : 27130;
                    save();
                }))
            .addButton((b) => b.setButtonText('New key').onClick(async () => {
                s.reviewApiKey = '';
                await save();
                await this.plugin.syncReviewApi(true);
                new Notice('Dendrite: a new review key is in ' +
                           `${discoveryPath(this.app.vault.getName())}; ` +
                           'the old one no longer works.');
            }));

        heading('Google Docs');
        new Setting(containerEl).setName('Google OAuth client')
            .setDesc('The JSON of a Desktop app client from your Google ' +
                     'Cloud project, pasted whole. It syncs with the ' +
                     'vault; Google treats a desktop client\'s secret as ' +
                     'not confidential.')
            .addTextArea((t) => t.setValue(s.googleClientJson || '')
                .setPlaceholder('{"installed": {"client_id": ...}}')
                .onChange((v) => {
                    s.googleClientJson = v.trim();
                    save();
                    showAccount();
                }));
        new Setting(containerEl).setName('Google Picker API key')
            .setDesc('An API key restricted to the Google Picker API, for ' +
                     'choosing a manuscript\'s doc.')
            .addText((t) => t.setValue(s.googlePickerKey || '')
                .onChange((v) => {
                    s.googlePickerKey = v.trim();
                    save();
                }));
        // Drawn again as the client is pasted, so signing in unlocks
        // without the settings being reopened.
        let accountBtn = null;
        const account = new Setting(containerEl).setName('Google account')
            .addButton((b) => {
                accountBtn = b;
                b.onClick(async () => {
                    if (this.plugin.googleToken()) {
                        await this.plugin.googleSignOut();
                    } else {
                        await this.plugin.googleSignIn();
                    }
                    this.display();
                });
            });
        const showAccount = () => {
            const signedIn = !!this.plugin.googleToken();
            const client = this.plugin.googleClient();
            account.setDesc(!client ? (s.googleClientJson ?
                'The pasted text is not an OAuth client\'s JSON.' :
                'Paste the OAuth client above first.') :
                signedIn ? 'Signed in. Dendrite reaches only the docs ' +
                    'you link to a manuscript.' :
                    'Not signed in. Signing in opens your browser.');
            accountBtn.setButtonText(signedIn ? 'Sign out' :
                                     'Sign in with Google')
                .setDisabled(!client || !Platform.isDesktopApp);
        };
        showAccount();

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

        heading('Diagnostics');
        new Setting(containerEl).setName('Record timings')
            .setDesc('While on, writes how long each of Dendrite\'s steps ' +
                     'took, and how often the window stalled, to ' +
                     `${vaultFile(this.app.vault.getName(), TIMINGS)} ` +
                     'every 10 seconds, to find ' +
                     'what makes it slow. Only step names and times are ' +
                     'written, never text. Desktop only.')
            .addToggle((t) => t.setValue(!!s.recordTimings)
                .setDisabled(!Platform.isDesktopApp)
                .onChange((v) => {
                    s.recordTimings = v;
                    timing.setOn(v && Platform.isDesktopApp);
                    save();
                }));
        new Setting(containerEl).setName('Say what moves the board')
            .setDesc('While on, a notice each time the board moves ' +
                     'sideways other than by hand: the steps that centred ' +
                     'it, or that it moved with no touch and no centring. ' +
                     'For finding what pulls the board back.')
            .addToggle((t) => t.setValue(!!s.showBoardMoves)
                .onChange((v) => {
                    s.showBoardMoves = v;
                    save();
                }));
    }
}

/**
 * The functions that led to the one that read `stack`, nearest first,
 * from Chromium's "at View.name (" or WebKit's "name@" lines.
 */
function callers(stack, skip = 1) {
    const out = [];
    for (const line of String(stack).split('\n').slice(1 + skip)) {
        const m = /^\s*at (?:async )?(?:[\w$]+\.)*([\w$]+) \(/.exec(line) ||
            /^(?:[\w$]+\.)*([\w$]+)@/.exec(line.trim());
        if (m && !out.includes(m[1])) out.push(m[1]);
        if (out.length === 5) break;
    }
    return out;
}

// Timed while Record timings is on (timing.js): the steps that draw the
// board and the preview, and those run on every change.
timing.wrap(DendriteView.prototype, 'board', ['render', 'renderCard',
    'updateStatuses', 'updateChanged', 'updateNumbers', 'updateCounts',
    'applyActive', 'drawFlow', 'loadBodies', 'onModify', 'onMetadata',
    'sweepStatuses', 'startEdit', 'endEdit', 'centre', 'followCaret',
    'onResize', 'scheduleFlow', 'animateOffsets', 'newEditor',
    'focusEditor', 'renderToolbar', 'fillFrame', 'emptyFar',
    'nextToDraw']);
timing.wrap(DendritePreview.prototype, 'preview', ['refresh',
    'renderSegments', 'renderBlock', 'drawBubbles', 'layoutBubbles',
    'keepPace', 'fitComments', 'listComments', 'highlight']);

const TIMINGS = 'timings.jsonl';

/** The review log of the manuscript whose index is `index`. */
async function readReviewLog(app, index) {
    const f = app.vault.getAbstractFileByPath(reviewlog.logPath(index.path));
    return f instanceof TFile ? reviewlog.parse(await app.vault.read(f)) : [];
}

// Each review log's writes, in turn: two comments resolved together
// cannot both make the log, or append to it at once.
const logWrites = new Map();

/**
 * Add `entries` to the review log of the manuscript whose index is
 * `index`, made if there is none.
 */
function appendReviewLog(app, index, entries) {
    const path = reviewlog.logPath(index.path);
    const text = entries.map(reviewlog.line).join('');
    const run = async () => {
        const f = app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) await app.vault.append(f, text);
        else await app.vault.create(path, text);
    };
    const next = (logWrites.get(path) || Promise.resolve()).then(run, run);
    logWrites.set(path, next);
    return next;
}

module.exports = class DendritePlugin extends Plugin {
    onunload() {
        this.stopReviewApi();
        this.writeTimings();
    }

    /**
     * What was timed since last written, appended to the timings file as
     * one line; the file kept under 5 MB by starting it again.
     */
    writeTimings() {
        if (!timing.isOn() || this.profiling) return;
        timing.watch(window);
        for (const t of [VIEW, PREVIEW]) {
            for (const l of this.app.workspace.getLeavesOfType(t)) {
                timing.watch(l.view.containerEl.ownerDocument.defaultView);
            }
        }
        const memory = this.memoryNow();
        const got = timing.take() || (memory && {});
        if (!got) return;
        if (memory) got.memory = memory;
        try {
            const fs = require('fs');
            const file = vaultFile(this.app.vault.getName(), TIMINGS);
            fs.mkdirSync(require('path').dirname(file), { recursive: true });
            if (fs.existsSync(file) && fs.statSync(file).size > 5e6) {
                fs.renameSync(file, file + '.old');
            }
            fs.appendFileSync(file, JSON.stringify(Object.assign({
                at: new Date().toISOString(),
                version: this.manifest && this.manifest.version }, got)) +
                '\n', { mode: 0o600 });
        } catch (err) {
            console.error('Dendrite: timings not written', err);
        }
    }

    /**
     * Dendrite's notices left on screen, hidden: those it keeps, and any
     * others showing whose text is its own, such as an earlier version's,
     * clicked away as a click would, in every window a board or preview
     * is open in.
     */
    dismissAllNotices() {
        dismissNotices();
        const docs = new Set([document]);
        for (const t of [VIEW, PREVIEW]) {
            for (const l of this.app.workspace.getLeavesOfType(t)) {
                docs.add(l.view.containerEl.ownerDocument);
            }
        }
        for (const doc of docs) {
            for (const el of doc.querySelectorAll('.notice')) {
                if (el.textContent.startsWith('Dendrite:')) el.click();
            }
        }
    }

    /**
     * The window's memory, in MB, and how much of the boards and previews
     * open is drawn, for the timings file: `rss_mb` the window's process,
     * `heap_mb` its script heap, `nodes` the elements in Dendrite's
     * views, `cards` and `parts` those drawn of all there are. Written
     * even when nothing was timed, so memory can be followed while idle.
     */
    memoryNow() {
        let m;
        try {
            m = process.memoryUsage();
        } catch (err) {
            return null;
        }
        const mb = (x) => Math.round(x / 1048576);
        const out = { rss_mb: mb(m.rss), heap_mb: mb(m.heapUsed), nodes: 0,
                      cards: [0, 0], parts: [0, 0] };
        for (const l of this.app.workspace.getLeavesOfType(VIEW)) {
            out.nodes += l.view.containerEl.getElementsByTagName('*').length;
            for (const el of (l.view.cardEls || new Map()).values()) {
                out.cards[1]++;
                if (!el.hasClass('is-pending') &&
                    !el.hasClass('is-slot')) out.cards[0]++;
            }
        }
        for (const l of this.app.workspace.getLeavesOfType(PREVIEW)) {
            out.nodes += l.view.containerEl.getElementsByTagName('*').length;
            for (const b of (l.view.blocks || new Map()).values()) {
                if (b.el.hasClass('is-empty')) continue;
                out.parts[1]++;
                if (!b.el.hasClass('is-pending')) out.parts[0]++;
            }
        }
        return out;
    }

    async onload() {
        this.settings = Object.assign({}, DEFAULTS, await this.loadData());
        review.setFoldUntilClicked(this.settings.foldComments);
        timing.setOn(this.settings.recordTimings && Platform.isDesktopApp);
        this.registerInterval(window.setInterval(() => this.writeTimings(),
                                                 10000));
        // Versions per device, outside the vault and data.json, which
        // sync plugins copy.
        this.history = new History(idbStore());
        // Citations linked to their PDF: asked of the Zotero Mirror plugin
        // where it can say, else found in its literature notes.
        const mirror = () => (this.app.plugins && this.app.plugins.plugins &&
            this.app.plugins.plugins['obsidian-zotero-mirror']) || null;
        this.pdfLinks = new PdfLinks(this.app, () => {
            const p = mirror();
            return (p && p.settings && p.settings.citekeyProperty) ||
                'citekey';
        }, mirror);
        this.registerEvent(this.app.metadataCache.on('changed',
            (f, data, cache) => this.pdfLinks.changed(f, cache)));
        for (const ev of ['rename', 'delete']) {
            this.registerEvent(this.app.vault.on(ev,
                () => this.pdfLinks.forget()));
        }
        // Links to cards in comments show in the page preview, as
        // Obsidian's own links do.
        if (this.registerHoverLinkSource) {
            this.registerHoverLinkSource(HOVER_SOURCE,
                { display: 'Dendrite', defaultMod: false });
        }
        this.registerView(VIEW, (leaf) => new DendriteView(leaf, this));
        this.registerView(PREVIEW, (leaf) => new DendritePreview(leaf, this));
        this.commentFilterState = { ...COMMENT_FILTER };
        this.registerView(COMMENTS,
            (leaf) => new DendriteComments(leaf, this));
        this.addCommand({
            id: 'show-comments',
            name: 'Show the comment list',
            callback: () => this.showCommentList(
                this.app.workspace.getActiveViewOfType(DendriteView) ||
                this.app.workspace.getActiveViewOfType(DendritePreview)),
        });
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
        this.addCommand({
            id: 'dismiss-notices',
            name: 'Dismiss notices',
            callback: () => this.dismissAllNotices(),
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
        this.app.workspace.onLayoutReady(() => this.syncReviewApi());
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
        viewCommand('comment-on-selection', 'Comment on the selected ' +
            'passage', true, (v) => v.askComment());
        viewCommand('next-flagged', 'Go to the next card to revise or ' +
            'finish splitting', false, (v) => v.nextFlagged(1));
        viewCommand('previous-flagged', 'Go to the previous card to ' +
            'revise or finish splitting', false, (v) => v.nextFlagged(-1));
        viewCommand('next-draft', 'Go to the next draft card', false,
            (v) => v.nextFlagged(1, (i) => i.prints && i.own === 'draft'));
        viewCommand('toggle-printed', 'Show only the cards that print, ' +
            'or every card', false, (v) => v.togglePrintOnly());
        viewCommand('import-review', 'Import review comments from a ' +
            'returned Word file or a JSON list', false,
            (v) => v.importReview());
        viewCommand('pull-gdoc-review', 'Pull review comments and ' +
            'suggested changes from the linked Google Doc', false,
            (v) => v.pullGdoc());
        viewCommand('add-types', 'Add the type property to the index ' +
            'and every card, and aliases to tables, figures and headings',
            false, (v) => v.sweepTypes());
        viewCommand('mend-tables', 'Mend tables split at a comment\'s ' +
            'priority', false, (v) => v.mendTables());
        viewCommand('merge-into-above', 'Merge card into the card above',
            false, (v) => v.merge('above'));
        viewCommand('merge-into-parent', 'Merge card into its parent',
            false, (v) => v.merge('parent'));
        viewCommand('profile', 'Profile the board and preview, on a ' +
            'manuscript marked dendrite_profile', false,
            (v) => this.runProfile(v));
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
                if (sel) {
                    menu.addItem((i) => i.setTitle('Comment on the ' +
                                                   'selection')
                        .setIcon('message-square')
                        .onClick(() => v.askComment()));
                }
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

    // ---- reviews submitted by programs ---------------------------------

    /**
     * Listen for reviews when the setting is on, on its port and key,
     * and stop when it is off; `force` restarts, as for a new key.
     */
    async syncReviewApi(force = false) {
        const s = this.settings;
        const want = s.reviewApi && Platform.isDesktopApp &&
            Number.isInteger(s.reviewApiPort) ? s.reviewApiPort : null;
        if (!force && this.reviewServer && want === this.reviewPort &&
            s.reviewApiKey === this.reviewKey) return;
        if (!force && !this.reviewServer && want === null) return;
        await this.stopReviewApi();
        if (want === null) return;
        if (!s.reviewApiKey) {
            s.reviewApiKey = require('crypto').randomBytes(24)
                .toString('hex');
            await this.saveSettings();
        }
        const start = (port) => require('./reviewapi.js').start({
            port, token: s.reviewApiKey,
            submit: (d) => this.submitReview(d),
            status: (id) => this.reviewStatus(id),
            threads: (m, opts) => this.threadsFor(m, opts),
            reply: (d) => this.replyTo(d),
            suggest: (d) => this.suggestTo(d),
            revise: (d) => this.submitRevision(d) });
        try {
            try {
                this.reviewServer = await start(want);
            } catch (err) {
                // Taken, by another program or Dendrite in another
                // vault: any free port, which the discovery file gives.
                if (err.code !== 'EADDRINUSE' || want === 0) throw err;
                this.reviewServer = await start(0);
            }
        } catch (err) {
            new Notice(`Dendrite: could not listen for reviews on port ` +
                       `${want} (${err.message}).`, 10000);
            return;
        }
        this.reviewPort = want;
        this.reviewKey = s.reviewApiKey;
        const fs = require('fs');
        const vault = this.app.vault.getName();
        const file = discoveryPath(vault);
        // Before 0.23 the file was shared by every vault: this vault's is
        // stale, and would send a program to the wrong place.
        try {
            const old = configFile('review-api.json');
            if (JSON.parse(fs.readFileSync(old, 'utf8')).vault === vault) {
                fs.unlinkSync(old);
            }
        } catch (err) {
            // None, or another vault's.
        }
        fs.mkdirSync(require('path').dirname(file), { recursive: true });
        const base = 'http://127.0.0.1:' +
            `${this.reviewServer.address().port}/dendrite`;
        fs.writeFileSync(file, JSON.stringify({
            url: `${base}/review`, threads: `${base}/threads`,
            reply: `${base}/reply`, suggest: `${base}/suggest`,
            revise: `${base}/revise`,
            key: s.reviewApiKey, vault: this.app.vault.getName(),
            pid: process.pid }, null, 2) + '\n', { mode: 0o600 });
    }

    async stopReviewApi() {
        const server = this.reviewServer;
        if (!server) return;
        this.reviewServer = null;
        this.reviewPort = null;
        await new Promise((r) => server.close(() => r()));
        // Only this run's file: another vault's Dendrite may have written
        // its own since.
        try {
            const fs = require('fs');
            const file = discoveryPath(this.app.vault.getName());
            const d = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (d.pid === process.pid && d.key === this.reviewKey) {
                fs.unlinkSync(file);
            }
        } catch (err) {
            // Gone already, or not ours.
        }
    }

    // ---- profiling ------------------------------------------------------

    /**
     * Profile the board `view` (profile.js), when its index asks to be,
     * and append a line per phase to this vault's profile.jsonl outside
     * it. `opts` as profile.js takes them. Answers the rows, or null when
     * not run.
     */
    async runProfile(view, opts = {}) {
        const { allowed, profile } = require('./profile.js');
        if (!allowed(this.app, view.file)) {
            new Notice('Dendrite: profiling saves into a card, so it runs ' +
                       'only on a manuscript whose index has ' +
                       'dendrite_profile: true, such as a test copy.');
            return null;
        }
        if (this.profiling) return null;
        this.profiling = true;
        new Notice('Dendrite: profiling, about 30 seconds.');
        let rows;
        try {
            rows = await profile(view, Object.assign({}, opts, {
                openPreview: async () => {
                    await this.openPreview(view.file);
                    const l = this.previewLeaf(view.file);
                    return l && l.view;
                },
                closePreview: () => {
                    const l = this.previewLeaf(view.file);
                    if (l) l.detach();
                } }));
        } catch (err) {
            new Notice(`Dendrite: profiling stopped (${err.message}).`);
            return null;
        } finally {
            this.profiling = false;
        }
        const file = vaultFile(this.app.vault.getName(), 'profile.jsonl');
        const head = { at: new Date().toISOString(),
                       version: this.manifest && this.manifest.version };
        try {
            const fs = require('fs');
            fs.mkdirSync(require('path').dirname(file), { recursive: true });
            fs.appendFileSync(file, rows.map((r) => JSON.stringify(
                Object.assign({}, head, r)) + '\n').join(''),
                { mode: 0o600 });
            new Notice(`Dendrite: profile written to ${file}.`);
        } catch (err) {
            new Notice(`Dendrite: profile not written (${err.message}).`);
        }
        return rows;
    }

    reviewQueue() {
        return this.settings.reviewQueue || [];
    }

    openViews() {
        return this.app.workspace.getLeavesOfType(VIEW).map((l) => l.view)
            .filter((v) => v instanceof DendriteView);
    }

    /** The index with `prefix`, or the one it was renamed to. */
    indexWithPrefix(prefix) {
        return this.app.vault.getMarkdownFiles().find((f) =>
            prefixOf(this.app, f) === prefix) ||
            successorOf(this.app, prefix);
    }

    /**
     * What each card of a manuscript prints, for finding passages in: the
     * open board's own when there is one, so unsaved typing counts.
     */
    async reviewCardsOf(file) {
        const open = this.openViews().find((v) => v.file === file);
        if (open) return open.reviewCards();
        const app = this.app;
        const text = await app.vault.cachedRead(file);
        const root = core.parseIndex(core.splitFrontmatter(text).body).root;
        const cardOf = (id) => {
            const f = app.metadataCache.getFirstLinkpathDest(id, file.path);
            return f instanceof TFile ? f : null;
        };
        const props = (id) => {
            const f = cardOf(id);
            return (f && app.metadataCache.getFileCache(f)?.frontmatter) ||
                {};
        };
        const kindOf = (id) => {
            const k = props(id).dendrite_kind;
            return core.KINDS.includes(k) ? k : null;
        };
        const roleOf = core.withKinds((id) => core.cardRole(props(id)),
                                      kindOf);
        const out = [];
        for (const n of core.allNodes(root)) {
            const f = cardOf(n.id);
            if (!f) continue;
            const body = core.splitFrontmatter(await app.vault.cachedRead(f))
                .body;
            out.push({ id: n.id,
                       text: core.printedOnly(body, core.roleFor(n, roleOf)) });
        }
        return out;
    }

    /**
     * Queue a review for its manuscript's board, where it is added or
     * ignored; nothing is written to a card here. `data`: { manuscript,
     * title?, items }, items as an imported JSON review's. Answers
     * { status, json } with where its passages were found. Other plugins
     * may call this directly; programs reach it over the local port.
     */
    async submitReview(data) {
        const bad = (status, error) => ({ status, json: { error } });
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return bad(400, 'send { manuscript, title, items }');
        }
        const prefix = typeof data.manuscript === 'string' ?
            data.manuscript.trim() : '';
        if (!prefix) {
            return bad(400, 'say which manuscript, by its prefix, as ' +
                       '"manuscript"');
        }
        const file = this.indexWithPrefix(prefix);
        if (!file) return bad(404, `no manuscript has the prefix ${prefix}`);
        let items;
        try {
            items = review.readReviewJson(JSON.stringify(data));
        } catch (err) {
            return bad(400, err.message);
        }
        if (!items.length) return bad(400, 'no items');
        const current = prefixOf(this.app, file);
        const title = String(data.title || '').trim() || 'Review';
        const key = String(require('./docx.js').crc32(Buffer.from(
            JSON.stringify([current, title, items]), 'utf8')));
        const cards = await this.reviewCardsOf(file);
        let found = 0;
        let already = 0;
        const missing = [];
        const bodies = new Map();
        for (const [k, it] of items.entries()) {
            const at = review.locate(it, cards);
            if (!at) {
                missing.push({ n: k + 1, card: it.card || null,
                               quote: it.quote });
                continue;
            }
            found++;
            if (!bodies.has(at.id)) {
                const f = this.app.metadataCache.getFirstLinkpathDest(
                    at.id, file.path);
                bodies.set(at.id, f instanceof TFile ?
                    core.splitFrontmatter(await this.app.vault.read(f))
                        .body : '');
            }
            if (review.alreadyIn(bodies.get(at.id), it)) already++;
        }
        const queue = this.settings.reviewQueue =
            this.settings.reviewQueue || [];
        let entry = queue.find((r) => r.key === key &&
                               r.state === 'pending');
        if (!entry) {
            entry = { id: Math.random().toString(16).slice(2, 10), key,
                      received: new Date().toISOString(),
                      manuscript: current, title, items, state: 'pending' };
            queue.push(entry);
            // Every pending review, and the latest 50 decided.
            const decided = queue.filter((r) => r.state !== 'pending');
            const drop = new Set(decided.slice(0, -50));
            this.settings.reviewQueue = queue.filter((r) => !drop.has(r));
            await this.saveSettings();
            stickyNotice(`review:${file.path}:${entry.id}`,
                         `Dendrite: ${title}: ${items.length} comment` +
                         `${items.length === 1 ? '' : 's'} from ` +
                         `${reviewAuthors(items)}, for ${file.basename}. ` +
                         'Click Inbox on its board\'s bar to choose ' +
                         'which to add.');
            for (const v of this.openViews()) v.refreshInbox();
        }
        return { status: 202, json: { id: entry.id, state: entry.state,
                                      manuscript: current, found,
                                      already, missing } };
    }

    /**
     * Queue changes a reviewer asks to its own pending suggestions, for
     * the manuscript's board, where each is accepted or not; nothing is
     * written to a card here. `data`: { manuscript, title?, author?,
     * items: [{ card, quote, was?, before?, after?, replace } or { card,
     * quote, ..., withdraw: true }] }. Answers as submitReview does,
     * each item not found among `missing` with its reason.
     */
    async submitRevision(data) {
        const bad = (status, error) => ({ status, json: { error } });
        if (!data || typeof data !== 'object' ||
            !Array.isArray(data.items) || !data.items.length) {
            return bad(400, 'send { manuscript, items: [{ card, quote, ' +
                       'replace } or { card, quote, withdraw: true }] }');
        }
        const prefix = String(data.manuscript || '').trim();
        const file = prefix && this.indexWithPrefix(prefix);
        if (!file) return bad(404, `no manuscript has the prefix ${prefix}`);
        const current = prefixOf(this.app, file);
        const root = core.parseIndex(core.splitFrontmatter(
            await this.app.vault.cachedRead(file)).body).root;
        const ids = core.allNodes(root).map((n) => n.id);
        const items = [];
        const missing = [];
        let found = 0;
        // Each card's text, read once, and the suggestion an item names
        // in it, by its card and thread id, or null where it names none.
        const bodies = new Map();
        const bodyOf = async (f) => {
            if (!bodies.has(f.path)) {
                bodies.set(f.path, core.splitFrontmatter(
                    await this.app.vault.read(f)).body);
            }
            return bodies.get(f.path);
        };
        const targetOf = async (item) => {
            const f = this.app.metadataCache.getFirstLinkpathDest(item.card,
                                                                file.path);
            if (!(f instanceof TFile)) return null;
            const got = review.findSuggestion(await bodyOf(f), item);
            return got.it ? `${item.card}/${review.threadId(got.it)}` : null;
        };
        for (const [k, x] of data.items.entries()) {
            const n = k + 1;
            const id = x && cardNamed(ids, String(x.card || ''));
            const f = id && this.app.metadataCache.getFirstLinkpathDest(
                id, file.path);
            const item = { card: id || String((x && x.card) || ''),
                quote: String((x && x.quote) || ''),
                was: x && x.was !== undefined ? String(x.was) : null,
                before: x && x.before, after: x && x.after,
                withdraw: !!(x && x.withdraw),
                replace: x && typeof x.replace === 'string' ? x.replace :
                    null,
                author: String((x && x.author) || data.author || '')
                    .trim() || 'Claude' };
            items.push(item);
            let reason = null;
            if (!(f instanceof TFile)) reason = `no card ${item.card}`;
            else if (!item.withdraw && item.replace === null) {
                reason = 'no replace: the new text, or withdraw: true';
            } else {
                const got = review.findSuggestion(await bodyOf(f), item);
                if (got.reason) reason = got.reason;
                else item.current = got.it.text;
            }
            if (reason) {
                missing.push({ n, card: item.card, quote: item.quote,
                               reason });
            } else found++;
        }
        const title = String(data.title || '').trim() ||
            'Changes to suggestions';
        const key = String(require('./docx.js').crc32(Buffer.from(
            JSON.stringify([current, 'revise', items]), 'utf8')));
        const queue = this.settings.reviewQueue =
            this.settings.reviewQueue || [];
        let entry = queue.find((r) => r.key === key &&
                               r.state === 'pending');
        const superseded = [];
        if (!entry && found) {
            entry = { id: Math.random().toString(16).slice(2, 10), key,
                      kind: 'revise', received: new Date().toISOString(),
                      manuscript: current, title, items, state: 'pending' };
            // An earlier request still pending for the same suggestions
            // gives them up to this one, so the inbox holds one request
            // for each; its others stay, and emptied it is superseded.
            const mine = new Set();
            for (const item of items) {
                const t = await targetOf(item);
                if (t) mine.add(t);
            }
            for (const old of queue) {
                if (old.kind !== 'revise' || old.state !== 'pending' ||
                    old.manuscript !== current) continue;
                const keep = [];
                const gone = [];
                for (const item of old.items) {
                    const t = await targetOf(item);
                    (t && mine.has(t) ? gone : keep).push(item);
                }
                if (!gone.length) continue;
                old.items = keep;
                if (!keep.some((i) => i.current !== undefined)) {
                    old.state = 'superseded';
                    old.decided = new Date().toISOString();
                    old.by = entry.id;
                    unstickNotice(`review:${file.path}:${old.id}`);
                }
                superseded.push({ batch: old.id, items: gone.map((i) =>
                    ({ card: i.card, quote: i.quote })) });
            }
            if (superseded.length) {
                entry.replaces = superseded.map((s) => s.batch);
            }
            queue.push(entry);
            await this.saveSettings();
            stickyNotice(`review:${file.path}:${entry.id}`,
                         `Dendrite: ${reviewAuthors(items)} asks to ` +
                         `change ${found} of its suggestions in ` +
                         `${file.basename}. Click Inbox on its board\'s ` +
                         'bar to choose which to accept.');
            for (const v of this.openViews()) v.refreshInbox();
        }
        if (!entry) {
            return { status: 404, json: { error: 'none of these is a ' +
                'pending suggestion that can be changed', missing } };
        }
        return { status: 202, json: { id: entry.id, state: entry.state,
                                      manuscript: current, found,
                                      missing, superseded } };
    }

    /**
     * A manuscript's open review comments and suggested changes, each
     * with its id, card, passage, reviewer, text, Google link and
     * replies, in reading order, and the text of their cards without
     * comments; only `author`'s, if given, where "me" is
     * any name the writer signs with; with `awaiting`, only those that
     * wait for that name's answer (review.awaits); and
     * with `card`, only that card's and those of the cards under it.
     * With `resolved`, also those dealt with, from the review log, each
     * as it was when it was: what a reviewer should not raise again.
     * Read only, for a reviewer to read what was answered.
     */
    async threadsFor(prefix, { author = null, awaiting = null,
                               card = null, resolved = false } = {}) {
        const file = this.indexWithPrefix(prefix);
        if (!file) {
            return { status: 404, json: {
                error: `no manuscript has the prefix ${prefix}` } };
        }
        const app = this.app;
        const who = author === 'me' ? this.selfNames() : new Set([author]);
        const text = await app.vault.cachedRead(file);
        const root = core.parseIndex(core.splitFrontmatter(text).body).root;
        const all = core.allNodes(root);
        const top = card && all.find((n) => n.id === card);
        if (card && !top) {
            return { status: 404, json: { error: `no card ${card}` } };
        }
        const threads = [];
        // The text of each card with a thread, for reading it in context.
        const cards = {};
        // Keys of every comment open now, so one resolved and brought
        // back, as by an undo, is not also given as resolved.
        const open = new Set();
        const within = top ? [top, ...core.allNodes(top)] : all;
        for (const n of within) {
            const f = app.metadataCache.getFirstLinkpathDest(n.id, file.path);
            if (!(f instanceof TFile)) continue;
            const body = core.splitFrontmatter(
                await app.vault.cachedRead(f)).body;
            const items = review.reviewItems(body);
            const ids = review.threadIds(items);
            for (const [k, it] of items.entries()) {
                for (const key of review.reviewKeys(it)) open.add(key);
                if (author && !who.has(it.author)) continue;
                const replies = it.replies || [];
                if (awaiting && !review.awaits(it, awaiting,
                                               this.selfNames())) continue;
                const { text: said, url } = review.noteLink(it.text);
                cards[n.id] = core.stripComments(body).trim();
                threads.push({ id: `${n.id}/${ids[k]}`, card: n.id,
                    kind: it.kind === 'suggest' ? 'suggestion' : 'comment',
                    passage: it.passage, author: it.author, date: it.date,
                    text: it.kind === 'suggest' ? it.text : said.trim(),
                    link: it.kind === 'suggest' ? null : url || null,
                    priority: it.priority, replies });
            }
        }
        const json = { manuscript: prefixOf(app, file), threads, cards };
        if (resolved) {
            const ids = new Set(within.map((n) => n.id));
            json.resolved = reviewlog.settled(
                await readReviewLog(app, file), open)
                .filter((e) => (!card || ids.has(e.card)) &&
                    (!author || who.has(e.author)))
                .map(({ keys, ...e }) => e);
        }
        return { status: 200, json };
    }

    /** The names the writer signs with: the reply name, and Me. */
    selfNames() {
        return new Set([this.settings.replyName || 'Me', 'Me']);
    }

    /**
     * A reply from a program, written at once under the comment `thread`
     * names, as threadsFor gives it: `card/id`. With `replace`, it takes
     * the place of its writer's replies at the end of the thread, and is
     * refused where someone has replied since. Through the board when
     * one has the manuscript open, so it is drawn, undone, and goes into
     * the card's editor if the card is being typed in.
     */
    async replyTo(data) {
        const bad = (status, error) => ({ status, json: { error } });
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return bad(400, 'send { manuscript, thread, text }');
        }
        const file = this.indexWithPrefix(String(data.manuscript || '')
            .trim());
        if (!file) {
            return bad(404, `no manuscript has the prefix ` +
                       `${data.manuscript}`);
        }
        const said = String(data.text || '').trim();
        if (data.seen && (said || data.resolve)) {
            return bad(400, 'either seen, with no text, or a reply');
        }
        const ranked = data.priority !== undefined;
        const priority = data.priority === 'none' ? null : data.priority;
        if (ranked && priority !== null &&
            !review.PRIORITIES.includes(priority)) {
            return bad(400, 'priority is p1, p2, p3 or none');
        }
        // A priority alone, with no reply, ranks the comment and no more.
        const only = ranked && !data.seen && !data.resolve && !said;
        if (!data.seen && !data.resolve && !said && !only) {
            return bad(400, 'no text');
        }
        if (said.length > MAX_REPLY) {
            return bad(400, `${said.length} characters; a reply is up to ` +
                       `${MAX_REPLY}. Say only what the writer needs ` +
                       'before acting on the comment.');
        }
        const ids = Array.isArray(data.threads) ? data.threads.map(String) :
            [String(data.thread || '')];
        const reply = { author: String(data.author || '').trim() ||
                            'Claude',
                        date: localDay(), text: data.seen ? '' : said,
                        replace: !!data.replace };
        if (data.resolve) reply.resolve = true;
        if (ranked) reply.priority = priority;
        if (only) reply.only = true;
        const view = this.openViews().find((v) => v.file === file);
        const done = [];
        const missing = [];
        const refused = [];
        for (const id of ids) {
            const [card, tid] = id.split('/');
            const f = card && this.app.metadataCache.getFirstLinkpathDest(
                card, file.path);
            const n = !(f instanceof TFile) ? -1 :
                await (view ? view.replyFrom(card, tid, reply) :
                    this.replyInFile(f, tid, reply));
            if (n === REFUSED) {
                refused.push({ id, reason: 'someone has replied since; ' +
                    'send a new reply instead' });
            } else if (n === NOT_COMMENT) {
                refused.push({ id, reason: 'a suggested change is applied ' +
                    'or dismissed, not resolved' });
            } else (n < 0 ? missing : done).push(id);
        }
        if (!done.length && !refused.length) {
            return bad(404, `no open comment ${missing.join(', ')}; it may ` +
                       'have been resolved or changed');
        }
        if (data.resolve && done.length) {
            new Notice(`Dendrite: ${reply.author} suggests resolving ` +
                       `${done.length} comment${done.length === 1 ? '' :
                           's'}, on ` +
                       `${done.map((x) => x.split('/')[0]).join(', ')}.`);
        } else if (!data.seen && !only && done.length) {
            new Notice(`Dendrite: ${reply.author} replied on ` +
                       `${done.map((x) => x.split('/')[0]).join(', ')}.`);
        }
        return { status: 201, json: { done, missing, refused } };
    }

    /**
     * Suggested changes from a program, `items` [{ card, quote, replace,
     * before?, after?, author? }], each written at once where its quote
     * is found exactly in its card, and refused anywhere less sure; a
     * suggestion is applied or dismissed from the board, so it needs no
     * other approval. Through the board when the manuscript is open.
     */
    async suggestTo(data) {
        const bad = (status, error) => ({ status, json: { error } });
        if (!data || typeof data !== 'object' || !Array.isArray(data.items) ||
            !data.items.length) {
            return bad(400, 'send { manuscript, items: [{ card, quote, ' +
                       'replace }] }');
        }
        const file = this.indexWithPrefix(String(data.manuscript || '')
            .trim());
        if (!file) {
            return bad(404, `no manuscript has the prefix ` +
                       `${data.manuscript}`);
        }
        const view = this.openViews().find((v) => v.file === file);
        const done = [];
        const refused = [];
        for (const [k, x] of data.items.entries()) {
            const n = k + 1;
            const card = x && String(x.card || '');
            const f = card && this.app.metadataCache.getFirstLinkpathDest(
                card, file.path);
            if (!(f instanceof TFile)) {
                refused.push({ n, reason: `no card ${card}` });
                continue;
            }
            const item = { ...x, author: String(x.author || '').trim() ||
                               'Claude', date: localDay() };
            const reason = await (view ? view.suggestIn(card, item) :
                this.suggestInFile(f, item));
            if (reason) refused.push({ n, reason });
            else done.push(n);
        }
        if (done.length) {
            new Notice(`Dendrite: ${done.length} suggested change` +
                       `${done.length === 1 ? '' : 's'} from Claude.`);
        }
        return { status: 201, json: { done, refused } };
    }

    /** A suggestion written into a card's file; why not, or null. */
    async suggestInFile(f, item) {
        let reason = null;
        await this.app.vault.process(f, (data) => {
            const { fm, body } = core.splitFrontmatter(data);
            const out = review.suggestInto(body, f.basename, item);
            reason = out.reason || null;
            return out.md === undefined ? data : fm + out.md;
        });
        return reason;
    }

    /**
     * A reply written into a card's file; the comment's index, -1 where
     * it is not there, or REFUSED where it would replace and cannot.
     */
    async replyInFile(f, tid, reply) {
        let n = -1;
        await this.app.vault.process(f, (data) => {
            const { fm, body } = core.splitFrontmatter(data);
            n = review.threadIds(review.reviewItems(body)).indexOf(tid);
            const out = n < 0 ? null : withReply(body, n, reply);
            if (n >= 0 && out === false) n = NOT_COMMENT;
            else if (n >= 0 && out === null) n = REFUSED;
            return typeof out !== 'string' ? data : fm + out;
        });
        return n;
    }

    async reviewStatus(id) {
        const r = this.reviewQueue().find((x) => x.id === id);
        return r ? { status: 200, json: { id, state: r.state,
                                          manuscript: r.manuscript,
                                          title: r.title } } :
            { status: 404, json: { error: 'no such review' } };
    }

    /**
     * Act on a review comment from the preview, as from its card on the
     * board: the board for the manuscript is opened if it is not.
     */
    async reviewFromPreview(indexFile, id, n, what, arg = null) {
        let view = this.openViews().find((v) => v.file === indexFile);
        if (!view) {
            await this.focusCard(indexFile, id, false);
            view = this.openViews().find((v) => v.file === indexFile);
        }
        if (view) await view.reviewAction(id, n, what, arg);
    }

    // ---- Google Docs ---------------------------------------------------

    /**
     * The OAuth client, as pasted in the settings or else from its file,
     * or null without one.
     */
    googleClient() {
        const pasted = this.settings && this.settings.googleClientJson;
        try {
            return google.readClient(pasted && pasted.trim() ? pasted :
                require('fs').readFileSync(
                    configFile('google-oauth-client.json'), 'utf8'));
        } catch (err) {
            return null;
        }
    }

    /** The Picker API key, as pasted or else from its file. */
    googlePickerKey() {
        const pasted = this.settings && this.settings.googlePickerKey;
        if (pasted && pasted.trim()) return pasted.trim();
        try {
            return require('fs').readFileSync(
                configFile('google-api-key.txt'), 'utf8').trim();
        } catch (err) {
            return '';
        }
    }

    googleToken() {
        try {
            return JSON.parse(require('fs').readFileSync(
                configFile('google-token.json'), 'utf8'));
        } catch (err) {
            return null;
        }
    }

    saveGoogleToken(tok) {
        const fs = require('fs');
        const file = configFile('google-token.json');
        fs.mkdirSync(require('path').dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(tok, null, 2) + '\n',
                         { mode: 0o600 });
    }

    googleDeps() {
        return { request: googleRequest, openUrl: openExternal,
                 http: require('http'), crypto: require('crypto') };
    }

    /** Sign in as the user in the browser; false when it did not work. */
    async googleSignIn() {
        const client = this.googleClient();
        if (!client) {
            new Notice('Dendrite: paste the Google OAuth client\'s JSON in ' +
                       'Dendrite\'s settings first.', 10000);
            return false;
        }
        new Notice('Dendrite: sign in to Google in the browser that ' +
                   'opened.');
        try {
            const tok = await google.signIn(Object.assign(
                { client }, this.googleDeps()));
            this.saveGoogleToken(tok);
        } catch (err) {
            new Notice(`Dendrite: Google sign-in failed (${err.message}).`,
                       10000);
            return false;
        }
        new Notice('Dendrite: signed in to Google.');
        return true;
    }

    async googleSignOut() {
        const tok = this.googleToken();
        try {
            await google.revoke({ tok, request: googleRequest });
        } catch (err) {
            // Revoked already, or offline: the token goes either way.
        }
        try {
            require('fs').unlinkSync(configFile('google-token.json'));
        } catch (err) {
            // Never signed in.
        }
    }

    /** A current access token, signing in first when Google wants it. */
    async googleAccess() {
        const client = this.googleClient();
        const get = () => google.accessToken({ client,
            tok: this.googleToken(), request: googleRequest,
            save: async (t) => this.saveGoogleToken(t) });
        try {
            return await get();
        } catch (err) {
            if (!err.signIn) throw err;
            if (!await this.googleSignIn()) return null;
            return get();
        }
    }

    /**
     * Pair a manuscript with a Google Doc, chosen in Google's picker,
     * which also grants Dendrite that doc.
     */
    async linkGdoc(indexFile) {
        const key = this.googlePickerKey();
        if (!key) {
            new Notice('Dendrite: paste the Google Picker API key in ' +
                       'Dendrite\'s settings first.', 10000);
            return;
        }
        const token = await this.googleAccess();
        if (!token) return;
        new Notice('Dendrite: choose the doc in the browser that opened.');
        let picked;
        try {
            picked = await google.pick(Object.assign({ token, apiKey: key,
                client: this.googleClient(),
                onEvent: (what) => new Notice(what === 'loaded' ?
                    'Dendrite: Google\'s picker is open in the browser. ' +
                    'Click the doc, then Select.' :
                    `Dendrite: Google's picker reported ${what}.`, 10000) },
                this.googleDeps()));
        } catch (err) {
            // A newer try took its place, and reports for itself.
            if (/replaced by a new try/.test(err.message)) return;
            new Notice(`Dendrite: the picker failed (${err.message}).`,
                       10000);
            return;
        }
        if (!picked) return;
        await writeProps(this.app, indexFile, {
            dendrite_gdoc: google.docUrl(picked.id),
            dendrite_gdoc_title: picked.name || null });
        new Notice(`Dendrite: linked to the Google Doc ${picked.name}.`);
    }

    /** A linked doc's open comments and suggested changes. */
    async gdocReview(url) {
        const docId = google.docIdFromUrl(url);
        if (!docId) throw new Error('the linked doc\'s URL has no doc id');
        const token = await this.googleAccess();
        if (!token) return null;
        return google.fetchReview({ docId, token, request: googleRequest,
                                    zlib: require('zlib') });
    }

    async settleReview(id, state) {
        const r = this.reviewQueue().find((x) => x.id === id);
        if (!r) return;
        r.state = state;
        r.decided = new Date().toISOString();
        await this.saveSettings();
        for (const v of this.openViews()) v.refreshInbox();
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

    /** A reviewer's colour in a manuscript, set from its preview. */
    async reviewerColourFor(file, who, colour) {
        const board = this.app.workspace.getLeavesOfType(VIEW)
            .map((l) => l.view).find((v) => v.file === file);
        if (board) {
            await board.setReviewerColour(who, colour);
            return;
        }
        const fm = this.app.metadataCache.getFileCache(file)
            ?.frontmatter || {};
        const map = review.reviewerColours(fm.dendrite_reviewer_colours);
        map.set(who, colour);
        await writeProps(this.app, file, { dendrite_reviewer_colours:
            review.colourList(map, fm.dendrite_reviewer_colours) });
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
            zlib: require('zlib'),
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
            narrowSplit(leaf);
        }
        await leaf.openFile(file, { active: false });
        return leaf;
    }

    /** The preview for a manuscript, opened beside the board or reused. */
    previewLeaf(file) {
        return this.app.workspace.getLeavesOfType(PREVIEW)
            .find((l) => l.view.file === file) || null;
    }

    previewOpen(file) {
        return !!this.previewLeaf(file);
    }

    /** Open a manuscript's preview beside its board, or close it. */
    async togglePreview(file) {
        const open = this.previewLeaf(file);
        if (open) open.detach();
        else await this.openPreview(file);
    }

    async openPreview(file) {
        const open = this.previewLeaf(file);
        if (open) {
            this.app.workspace.revealLeaf(open);
            return;
        }
        // Beside the board, a third of the width, the board the rest; on
        // a tablet half, where a third is too narrow to read.
        const leaf = this.app.workspace.getLeaf('split', 'vertical');
        narrowSplit(leaf, previewShare());
        await leaf.setViewState({ type: PREVIEW, active: false,
                                  state: { file: file.path } });
    }

    /**
     * The comment list, opened if it is not: in the right sidebar, or,
     * for a board `from` in a popout window, which has no sidebar, beside
     * it in that window, right of its preview there if it has one.
     */
    async showCommentList(from = null) {
        const ws = this.app.workspace;
        const where = from && from.leaf && from.leaf.getContainer ?
            from.leaf.getContainer() : ws.rootSplit;
        const popout = where && where !== ws.rootSplit;
        const inWindow = (l) => !popout ||
            (l.getContainer && l.getContainer() === where);
        let leaf = ws.getLeavesOfType(COMMENTS).find(inWindow);
        const file = from && from.file || null;
        this.commentsFor = file;
        if (!leaf && popout) {
            const pv = ws.getLeavesOfType(PREVIEW).find((l) =>
                l.view && l.view.file === from.file && inWindow(l));
            leaf = ws.createLeafBySplit(pv || from.leaf, 'vertical');
            sideSplit(leaf, SIDEBAR_WIDTH);
            await leaf.setViewState({ type: COMMENTS, active: false });
        } else if (!leaf) {
            leaf = ws.getRightLeaf(false);
            await leaf.setViewState({ type: COMMENTS, active: true });
        }
        this.commentsFor = null;
        await ws.revealLeaf(leaf);
        // Already open, or drawn only once shown: on this board's text.
        const v = leaf.view;
        if (file && v && v.show && v.file !== file) await v.show(file);
    }

    /**
     * A comment's triage priority set, p1 to p3 or null: through the
     * board when it has the manuscript open, so it is undone as a change
     * to the card; else in the card's file.
     */
    async setCommentPriority(file, id, n, p) {
        const view = this.openViews().find((v) => v.file === file);
        if (view) {
            await view.reviewAction(id, n, 'priority', p);
            return;
        }
        const f = this.app.metadataCache.getFirstLinkpathDest(id, file.path);
        if (!(f instanceof TFile)) return;
        await this.app.vault.process(f, (data) => {
            const { fm, body } = core.splitFrontmatter(data);
            return fm + review.setPriority(body, n, p);
        });
    }

    /** Whether review is on: the comment list open. */
    reviewOn() {
        return this.app.workspace.getLeavesOfType(COMMENTS).length > 0;
    }

    /**
     * Review on, from board `from`: the comment list opened, which shows
     * the previews' comments; off: the list closed, which hides them.
     */
    async setReview(from, on) {
        if (on) await this.showCommentList(from);
        else {
            for (const l of this.app.workspace.getLeavesOfType(COMMENTS)) {
                l.detach();
            }
        }
        this.reviewChanged();
    }

    /** The previews and the boards' buttons, as review is on or off. */
    reviewChanged() {
        const on = this.reviewOn();
        for (const l of this.app.workspace.getLeavesOfType(PREVIEW)) {
            if (l.view.setComments) l.view.setComments(on);
            else if (l.view.scheduleRefresh) l.view.scheduleRefresh();
        }
        for (const v of this.openViews ? this.openViews() : []) {
            if (v.showReviewOn) v.showReviewOn();
        }
    }

    /** The comment list's filter while the list is open, or null. */
    commentFilter() {
        const f = this.commentFilterState;
        if (!f || !Object.values(f).some(Boolean)) return null;
        return this.app.workspace.getLeavesOfType(COMMENTS).length ? f :
            null;
    }

    /** A change to the comment list's filter, for the list and previews. */
    setCommentFilter(change) {
        this.commentFilterState = { ...this.commentFilterState, ...change };
        for (const l of this.app.workspace.getLeavesOfType(COMMENTS)) {
            l.view.showFilter();
            l.view.draw();
        }
        this.app.workspace.requestSaveLayout();
        this.refreshPreviews();
    }

    refreshPreviews() {
        for (const l of this.app.workspace.getLeavesOfType(PREVIEW)) {
            l.view.scheduleRefresh();
        }
    }

    /** From the preview: select a card on the board, or edit it. */
    async focusCard(file, id, edit, at = null) {
        const leaf = this.app.workspace.getLeavesOfType(VIEW)
            .find((l) => l.view.file === file);
        if (!leaf) {
            await this.openIndex(file, id);
            return;
        }
        this.app.workspace.revealLeaf(leaf);
        const view = leaf.view;
        if (edit) await view.startEdit(id, false, at);
        else await view.select(id);
    }

    /**
     * A status's colour, from Pretty Properties' colour for that value of
     * dendrite_status, so the Properties panel, Bases and the board agree.
     * Unset, null: a flag is drawn in the neutral --dendrite-flag, and
     * other values stay plain.
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
        return null;
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
        return prefixesInUse(this.app);
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
module.exports.DendriteComments = DendriteComments;
module.exports.DendriteSettings = DendriteSettings;
module.exports.exportStyle = exportStyle;
module.exports.callers = callers;
module.exports.stickyNotice = stickyNotice;
module.exports.dismissNotices = dismissNotices;
