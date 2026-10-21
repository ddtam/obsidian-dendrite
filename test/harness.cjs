'use strict';
// A fake Obsidian for the view tests: an in-memory vault, a metadata cache
// that reads frontmatter, and Obsidian's HTMLElement helpers on jsdom.
// Only what Dendrite calls is implemented, so a new API call fails loudly
// here rather than passing untested.
const { JSDOM } = require('jsdom');
const Module = require('module');

const dom = new JSDOM('<!doctype html><body></body>');
const w = dom.window;
global.window = w;
global.document = w.document;
global.HTMLElement = w.HTMLElement;
global.Event = w.Event;
global.getComputedStyle = (el) => w.getComputedStyle(el);
// A frame is called with its window's clock, as a browser does.
global.requestAnimationFrame = (fn) =>
    setTimeout(() => fn(performance.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
w.requestAnimationFrame = global.requestAnimationFrame;
w.cancelAnimationFrame = global.cancelAnimationFrame;

function make(tag, o = {}, parent, doc = w.document) {
    const el = doc.createElement(tag);
    if (typeof o === 'string') o = { cls: o };
    if (o.cls) el.className = o.cls;
    if (o.text !== undefined) el.textContent = o.text;
    if (o.type) el.setAttribute('type', o.type);
    if (o.value !== undefined) el.setAttribute('value', o.value);
    if (parent) parent.appendChild(el);
    return el;
}

/**
 * Obsidian's element helpers, on a window's elements. A second window
 * stands in for a popout: its elements are made in its own document.
 */
function installHelpers(win) {
    const P = win.HTMLElement.prototype;
    P.createDiv = function (o) {
        return make('div', o, this, this.ownerDocument);
    };
    P.createSpan = function (o) {
        return make('span', o, this, this.ownerDocument);
    };
    P.createEl = function (t, o) {
        return make(t, o, this, this.ownerDocument);
    };
    P.empty = function () { while (this.firstChild) this.firstChild.remove(); };
    P.addClass = function (c) { this.classList.add(c); };
    P.removeClass = function (c) { this.classList.remove(c); };
    P.hasClass = function (c) { return this.classList.contains(c); };
    P.toggleClass = function (c, on) { this.classList.toggle(c, !!on); };
    P.setText = function (t) { this.textContent = t; };
    P.setAttr = function (k, v) { this.setAttribute(k, v); };
    P.getAttr = function (k) { return this.getAttribute(k); };
    P.scrollTo = function () {};
}
installHelpers(w);

/** A second window, as Obsidian opens for a popout. */
function makePopout() {
    const win = new JSDOM('<!doctype html><body></body>').window;
    installHelpers(win);
    // Its clock starts when it opens, so it reads behind the main
    // window's by however long that was open first.
    win.requestAnimationFrame = (fn) =>
        setTimeout(() => fn(performance.now() - 60000), 0);
    win.cancelAnimationFrame = (id) => clearTimeout(id);
    return win;
}
global.createDiv = (o) => make('div', o);
global.createEl = (t, o) => make(t, o);

global.ResizeObserver = class {
    constructor(cb) { this.cb = cb; global.lastResizer = this; }
    observe() {}
    disconnect() {}
    fire() { this.cb([]); }
};

global.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(el) {
        queueMicrotask(() => this.cb([{ isIntersecting: true, target: el }]));
    }
    unobserve() {}
    disconnect() {}
};

class TAbstractFile {}
class TFile extends TAbstractFile {
    constructor(path) {
        super();
        this.setPath(path);
        this.extension = 'md';
        this.stat = { mtime: 1 };
    }
    setPath(path) {
        this.path = path;
        this.basename = path.split('/').pop().replace(/\.md$/, '');
        const dir = path.split('/').slice(0, -1).join('/');
        this.parent = { path: dir || '/' };
    }
}
class TFolder extends TAbstractFile {
    constructor(path, vault) {
        super();
        this.path = path;
        this.vault = vault;
    }
    get children() {
        return [...this.vault.files.values()].filter(
            (f) => f.path.startsWith(this.path + '/') &&
                !f.path.slice(this.path.length + 1).includes('/'));
    }
}

function emitter() {
    const h = {};
    return {
        on(ev, fn) { (h[ev] = h[ev] || []).push(fn); return { ev, fn }; },
        offref(ref) {
            h[ref.ev] = (h[ref.ev] || []).filter((f) => f !== ref.fn);
        },
        trigger(ev, ...a) { for (const fn of h[ev] || []) fn(...a); },
    };
}

function makeApp() {
    const files = new Map();
    const text = new Map();
    const folders = new Set();
    const ev = emitter();
    const meta = emitter();
    let clock = 1;
    const touch = (f) => { f.stat = { mtime: ++clock }; };
    const vault = {
        files, text, folders,
        on: ev.on, trigger: ev.trigger,
        getAbstractFileByPath(p) {
            if (files.has(p)) return files.get(p);
            if (folders.has(p)) return new TFolder(p, vault);
            return null;
        },
        async createFolder(p) { folders.add(p); },
        async create(p, data) {
            if (files.has(p)) throw new Error('exists: ' + p);
            const f = new TFile(p);
            files.set(p, f);
            text.set(p, data);
            touch(f);
            return f;
        },
        async read(f) { return text.get(f.path); },
        async cachedRead(f) { return text.get(f.path); },
        async modify(f, data) {
            text.set(f.path, data);
            touch(f);
            ev.trigger('modify', f);
            // Obsidian re-parses the note after it is written, then says
            // its metadata changed.
            setTimeout(() => meta.trigger('changed', f), 0);
        },
        async process(f, fn) {
            const out = fn(text.get(f.path));
            await vault.modify(f, out);
            return out;
        },
        getMarkdownFiles() { return [...files.values()]; },
    };
    const metadataCache = {
        on: meta.on, offref: meta.offref,
        getFileCache(f) {
            const t = text.get(f.path) || '';
            const m = /^---\n([\s\S]*?)\n---/.exec(t);
            const body = m ? t.slice(m[0].length) : t;
            const firstLine = body.split('\n').find((l) => l.trim()) || '';
            const sections = firstLine ? [{ type:
                /^#{1,6}\s/.test(firstLine) ? 'heading' : 'paragraph' }] : [];
            if (!m) return { sections };
            const fm = {};
            const lines = m[1].split('\n');
            for (let i = 0; i < lines.length; i++) {
                const kv = /^(\w+):\s*(.*)$/.exec(lines[i]);
                if (!kv) continue;
                if (kv[2]) {
                    const v = kv[2];
                    fm[kv[1]] = v === 'true' ? true : v === 'false' ? false :
                        (/^\d+(\.\d+)?$/.test(v) ? Number(v) : v);
                }
                else {
                    fm[kv[1]] = [];
                    while (/^\s+-\s/.test(lines[i + 1] || '')) {
                        fm[kv[1]].push(lines[++i].replace(/^\s+-\s/, ''));
                    }
                }
            }
            return { frontmatter: fm, sections };
        },
        getFirstLinkpathDest(link) {
            for (const f of files.values()) {
                if (f.basename === link || f.path === link + '.md') return f;
            }
            return null;
        },
    };
    const opened = [];
    const app = {
        vault, metadataCache, scope: {},
        fileManager: {
            async processFrontMatter(f, fn) {
                const t = text.get(f.path);
                const m = /^---\n[\s\S]*?\n---\n?/.exec(t);
                const fm = metadataCache.getFileCache(f).frontmatter || {};
                fn(fm);
                const lines = [];
                for (const [k, v] of Object.entries(fm)) {
                    if (Array.isArray(v)) {
                        lines.push(k + ':');
                        for (const x of v) lines.push('  - ' + x);
                    } else lines.push(`${k}: ${v}`);
                }
                const head = lines.length ?
                    '---\n' + lines.join('\n') + '\n---\n' : '';
                await vault.modify(f, head + (m ? t.slice(m[0].length) : t));
            },
            async trashFile(f) {
                files.delete(f.path);
                text.delete(f.path);
                ev.trigger('delete', f);
            },
        },
        workspace: {
            getLeaf() { return { openFile: async (f) => opened.push(f) }; },
            getActiveFile() { return null; },
            on() { return {}; },
            getLeavesOfType() { return []; },
            requestSaveLayout() {},
            openLinkText() {},
        },
        opened,
    };
    return app;
}

const notices = [];
const requests = [];
const obsidian = {
    TFile, TFolder,
    Platform: { isDesktopApp: true },
    MarkdownView: class {},
    ItemView: class {
        constructor(leaf) {
            this.leaf = leaf;
            this.app = leaf.app;
            this.contentEl = make('div');
        }
        registerEvent() {}
        registerDomEvent(el, ev, fn) { el.addEventListener(ev, fn); }
        addChild(c) { c.load(); return c; }
        removeChild(c) { c.unload(); return c; }
        setState() { return Promise.resolve(); }
    },
    Plugin: class {},
    Setting: class {
        constructor(container) {
            this.container = container;
            obsidian.settingsLog = obsidian.settingsLog || [];
        }
        setName(n) {
            this.name = n;
            obsidian.settingsLog.push(this);
            return this;
        }
        setDesc() { return this; }
        setHeading() { this.heading = true; return this; }
        stub() {
            const s = new Proxy({}, { get: (o, k) => (k === 'then' ?
                undefined : () => s) });
            return s;
        }
        addText(f) { f(this.stub()); return this; }
        addToggle(f) { f(this.stub()); return this; }
        addDropdown(f) { f(this.stub()); return this; }
        addSlider(f) { f(this.stub()); return this; }
        addButton(f) { f(this.stub()); return this; }
    },
    PluginSettingTab: class {
        constructor(app, plugin) {
            this.app = app;
            this.containerEl = make('div');
        }
    },
    Modal: class {
        constructor(app) {
            this.app = app;
            this.titleEl = make('div');
            this.contentEl = make('div');
            this.modalEl = make('div');
            obsidian.lastModal = this;
        }
        open() { return this.onOpen && this.onOpen(); }
        close() { if (this.onClose) this.onClose(); }
    },
    Menu: class {
        constructor() { this.titles = []; obsidian.lastMenu = this; }
        addItem(fn) {
            const self = this;
            const item = {
                // A title may be page content, as in Obsidian; its text
                // is what a reader sees as the title.
                setTitle(x) {
                    const t = typeof x === 'string' ? x : x.textContent;
                    self.titles.push(t);
                    this.title = t;
                    this.titleContent = typeof x === 'string' ? null : x;
                    return this;
                },
                setIcon() { return this; },
                onClick(f) { this.click = f; return this; },
                // A submenu, kept off lastMenu, which names the menu shown.
                setSubmenu() {
                    const shown = obsidian.lastMenu;
                    this.submenu = new obsidian.Menu();
                    obsidian.lastMenu = shown;
                    return this.submenu;
                },
            };
            fn(item);
            (this.items = this.items || []).push(item);
            return this;
        }
        addSeparator() { this.titles.push('---'); return this; }
        showAtMouseEvent() { this.shown = 'mouse'; }
        showAtPosition() { this.shown = 'position'; }
    },
    Component: class { load() {} unload() {} },
    // Obsidian's request outside the page; a test sets `respond`.
    requestUrl: async (req) => {
        requests.push(req);
        return obsidian.respond(req);
    },
    respond: () => ({ status: 200, json: {} }),
    MarkdownRenderer: {
        async render(app, md, el) { el.textContent = md; },
    },
    Notice: class {
        constructor(m) { notices.push(m); }
        hide() {}
    },
    Scope: class {
        constructor() { this.keys = []; }
        register(mods, key, fn) { this.keys.push({ mods, key, fn }); }
    },
    Keymap: { isModEvent: () => false },
    setIcon() {},
    normalizePath: (s) => s.replace(/\/+/g, '/').replace(/^\/|\/$/g, ''),
};

const orig = Module._load;
Module._load = function (req, ...a) {
    if (req === 'obsidian') return obsidian;
    return orig.call(this, req, ...a);
};

module.exports = { makeApp, makePopout, notices, requests, TFile,
                   window: w, obsidian };
