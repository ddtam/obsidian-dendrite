// View tests: drive the real DendriteView against an in-memory vault and
// check what lands in the notes. These cover every path that writes text:
// typing, autosave, leaving the editor, inserting, moving, deleting and
// undoing. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const h = require('./harness.cjs');
const { DendriteView } = require('../src/main.js');
const core = require('../src/core.js');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
// A menu's item by title, looked for in its submenus too.
const menuItem = (menu, title) => {
    for (const i of menu.items || []) {
        if (i.title === title || (title instanceof RegExp &&
                                  title.test(i.title))) return i;
        const inner = i.submenu && menuItem(i.submenu, title);
        if (inner) return inner;
    }
    return null;
};
const submenuOf = (menu, title) =>
    menu.items.find((i) => i.title === title).submenu;
const INDEX = 'W/Grant/Grant.md';

// The app the settings tab is given: only the vault's name is read.
const SETTINGS_APP = { vault: { getName: () => 'Vault' } };

async function open(indexText, cards = {}) {
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, indexText);
    for (const [id, t] of Object.entries(cards)) {
        await app.vault.create(`W/Grant/cards/${id}.md`, t);
    }
    const plugin = { settings: { headingTop: 1, cardWidth: 380,
                                 autosaveMs: 20, vimKeys: true },
                     openAsMarkdown() {}, async lintCard() {},
                     statusColour: () => null };
    const view = new DendriteView({ app, updateHeader() {},
                                    detach() {} }, plugin);
    await view.onOpen();
    await view.setState({ file: INDEX });
    await tick();
    const read = (p) => app.vault.text.get(p);
    // A card's text without its properties, which Dendrite now writes on
    // every printing card.
    const text = (p) => {
        const r = read(p);
        return r === undefined ? r :
            r.replace(/^---\n[\s\S]*?\n---\n/, '');
    };
    return { app, view, read, text };
}

const cardPath = (id) => `W/Grant/cards/${id}.md`;
// A card not yet drawn: a slot, far from the view, or a frame whose text
// waits to be drawn.
const waiting = (el) => el.hasClass('is-slot') || el.hasClass('is-pending');
// A board or preview shown, 1000 by 500 px: jsdom lays nothing out, and
// one measuring nothing is taken as not shown.
const shown = (el) => {
    el.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0,
        right: 1000, width: 1000, height: 500 });
};
const type = (view, value) => {
    const ta = view.editing.ta;
    ta.value = value;
    ta.dispatchEvent(new h.window.Event('input'));
};

test('first card: typed text reaches its note and labels the index',
     async () => {
    const { view, read, text } = await open('---\ndendrite_prefix: G\n---\n');
    await view.insert('first');
    const id = view.active;
    assert.match(id, /^G-[a-z0-9]{5}$/);
    type(view, '# Specific Aims\nPlanning text.');
    await tick(60);
    assert.equal(text(cardPath(id)), '# Specific Aims\nPlanning text.',
                 'autosave wrote the card');
    await view.endEdit();
    assert.equal(read(INDEX), '---\ndendrite_prefix: G\n---\n' +
                 `- [[${id}|Specific Aims]]\n`);
});

test('typing in a tall card keeps the caret in view, or centred',
     async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|Long]]\n',
        { 'G-aaaaa': 'Long text\n' });
    await view.startEdit('G-aaaaa');
    // jsdom lays nothing out: the card is 1000 high in a 400 column, and
    // the caret 600 down the card, wherever the column has moved it.
    const fix = (el, k, v) => Object.defineProperty(el, k, { value: v });
    const card = view.cardEls.get('G-aaaaa');
    fix(card, 'offsetTop', 0);
    fix(card, 'offsetHeight', 1000);
    fix(view.board.querySelector('.dendrite-col'), 'clientHeight', 400);
    const inner = view.colInners[0];
    fix(inner, 'scrollHeight', 2000);
    inner.getBoundingClientRect = () => ({ top: -view.colOffset(0) });
    view.editing.editor.caretRect = () => {
        const top = 600 - view.colOffset(0);
        return { top, bottom: top + 20 };
    };
    // Typewriter, the default: the caret's line sits mid-column.
    type(view, 'Long text, more');
    await tick(5);
    assert.equal(view.colOffset(0), 610 - 200);
    // A click moves the caret; a redraw after it moves nothing.
    view.editing.editor.caretRect = () => {
        const top = 100 - view.colOffset(0);
        return { top, bottom: top + 20 };
    };
    view.centre(false);
    assert.equal(view.colOffset(0), 610 - 200, 'not moved by a click');
    view.editing.editor.caretRect = () => {
        const top = 600 - view.colOffset(0);
        return { top, bottom: top + 20 };
    };
    // Off: the column moves only enough to bring the caret into view.
    view.plugin.settings.typewriter = false;
    view.setColOffset(0, 0);
    type(view, 'Long text, more still');
    await tick(5);
    assert.equal(view.colOffset(0), 620 + 24 - 400);
    type(view, 'Long text, and more still');
    await tick(5);
    assert.equal(view.colOffset(0), 620 + 24 - 400, 'in view, held still');
    await view.endEdit();
});

test('typing on one line moves nothing after its first key: the board ' +
     'is laid out again only when the caret changes line or the card its ' +
     'height', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|Long]]\n',
        { 'G-aaaaa': 'Long text\n' });
    await view.startEdit('G-aaaaa');
    const card = view.cardEls.get('G-aaaaa');
    let height = 1000;
    Object.defineProperty(card, 'offsetHeight', { get: () => height });
    let line = 600;
    view.editing.editor.caretRect = () => {
        const top = line - view.colOffset(0);
        return { top, bottom: top + 20 };
    };
    let centred = 0;
    const centre = view.centre.bind(view);
    view.centre = (...a) => {
        centred++;
        return centre(...a);
    };
    for (const t of ['L', 'Lo', 'Lon', 'Long', 'Long ']) {
        type(view, t);
        await tick(5);
    }
    assert.equal(centred, 1, 'five keys on one line: laid out once');
    line = 620;
    type(view, 'Long t');
    await tick(5);
    assert.equal(centred, 2, 'the caret on a new line');
    height = 1020;
    type(view, 'Long te');
    await tick(5);
    assert.equal(centred, 3, 'the card grown');
    await view.endEdit();
});

test('a card drawn while a column is scrolled by hand does not pull the ' +
     'board back to the active card', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
        '    - [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    view.active = 'G-aaaaa';
    view.applyActive(false);
    let centred = 0;
    const centre = view.centre.bind(view);
    view.centre = (...a) => { centred++; return centre(...a); };
    const redraw = async (id) => {
        view.invalidate(id);
        view.cardEls.get(id).addClass('is-pending');
        await view.renderCard(id);
    };
    // Not scrolled: a card on the active path, drawn, re-centres.
    await redraw('G-bbbbb');
    assert.equal(centred, 1);
    // Scrolled by hand: B coming into view and drawn moves nothing.
    const col = view.board.querySelectorAll('.dendrite-col')[1];
    view.onWheel({ target: col, deltaY: 200, deltaMode: 0,
                   preventDefault() {} });
    await redraw('G-bbbbb');
    assert.equal(centred, 1, 'not pulled back');
    // A card changing height as it is drawn moves nothing either.
    view.resizer.cb([]);
    await tick(5);
    assert.equal(centred, 1, 'a resize does not pull it back');
    // Moving to a card centres again, and redraws follow it again.
    view.applyActive(false);
    await redraw('G-bbbbb');
    assert.equal(centred, 3);
});

test('a board scrolled sideways by hand stays there as cards are drawn ' +
     'and as a sync changes the index', async () => {
    const { app, view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
        '    - [[G-bbbbb|B]]\n- [[G-ccccc|C]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B', 'G-ccccc': 'C' });
    view.active = 'G-aaaaa';
    view.applyActive(false);
    let centred = 0;
    const centre = view.centre.bind(view);
    view.centre = (...a) => { centred++; return centre(...a); };
    // A sideways swipe on a trackpad, which the board scrolls itself.
    const col = view.board.querySelectorAll('.dendrite-col')[1];
    view.onWheel({ target: col, deltaX: 300, deltaY: 2, deltaMode: 0,
                   preventDefault() {} });
    view.board.scrollLeft = 300;
    view.invalidate('G-aaaaa');
    view.cardEls.get('G-aaaaa').addClass('is-pending');
    await view.renderCard('G-aaaaa');
    assert.equal(centred, 0, 'a card drawn does not pull the board back');
    // Another device adds a card to the index.
    const f = app.vault.getAbstractFileByPath(INDEX);
    await app.vault.modify(f, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|A]]\n    - [[G-bbbbb|B]]\n- [[G-ccccc|C]]\n' +
        '- [[G-ddddd|D]]\n');
    await tick(400);
    assert.ok(view.byId.has('G-ddddd'), 'the index was re-read');
    assert.equal(centred, 0, 'a sync does not pull the board back');
    assert.equal(view.board.scrollLeft, 300, 'kept where it was scrolled');
    assert.ok(view.cardEls.get('G-aaaaa').hasClass('is-active'),
              'the active card is still shown as active');
    // Moving to a card centres again.
    await view.select('G-ccccc');
    assert.equal(centred, 1);
});

test('cards never scrolled into view are drawn while the board is ' +
     'idle, nearest the active card first, so a move need not draw them',
     async () => {
    // Only the first card is ever in view.
    globalThis.inView = (el) => el.dataset && el.dataset.id === 'G-aaaaa';
    try {
        const { view } = await open(
            '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
            '    - [[G-bbbbb|B]]\n- [[G-ccccc|C]]\n',
            { 'G-aaaaa': 'A', 'G-bbbbb': 'B', 'G-ccccc': 'C' });
        shown(view.board);
        const pending = () => [...view.cardEls]
            .filter(([, el]) => waiting(el)).map(([id]) => id);
        assert.deepEqual(pending().sort(), ['G-bbbbb', 'G-ccccc'],
                         'out of view, not drawn at once');
        const order = [];
        const draw = view.renderCard.bind(view);
        view.renderCard = (id) => { order.push(id); return draw(id); };
        await tick(1500);
        assert.deepEqual(pending(), [], 'all drawn');
        assert.equal(order.length, 2, 'each drawn once');
    } finally {
        globalThis.inView = null;
    }
});

test('idle drawing keeps to the cards near what the board shows, and ' +
     'the children of those it shows, and follows a scroll', async () => {
    globalThis.inView = (el) => el.dataset && el.dataset.id === 'G-aaaaa';
    try {
        const { view } = await open(
            '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
            '    - [[G-bbbbb|B]]\n- [[G-ccccc|C]]\n- [[G-ddddd|D]]\n',
            { 'G-aaaaa': 'A', 'G-bbbbb': 'B', 'G-ccccc': 'C',
              'G-ddddd': 'D' });
        // A board 1000 by 500 px: A at its top, B (A's child) and C far
        // below it, D just under the view.
        const at = { 'G-aaaaa': 0, 'G-bbbbb': 9000, 'G-ccccc': 8000,
                     'G-ddddd': 700 };
        const rect = (top) => ({ top, bottom: top + 100, left: 0,
                                 right: 300, width: 300, height: 100 });
        view.board.getBoundingClientRect = () => ({ top: 0, bottom: 500,
            left: 0, right: 1000, width: 1000, height: 500 });
        for (const [id, el] of view.cardEls) {
            el.getBoundingClientRect = () => rect(at[id]);
        }
        const pending = () => [...view.cardEls]
            .filter(([, el]) => waiting(el)).map(([id]) => id).sort();
        view.drawWhenIdle();
        await tick(1200);
        assert.deepEqual(pending(), ['G-ccccc'],
                         'near ones and a shown card\'s child drawn');
        // Scrolled down to C: it is drawn in turn.
        at['G-ccccc'] = 300;
        const col = view.board.querySelectorAll('.dendrite-col')[0];
        view.onWheel({ target: col, deltaY: 200, deltaMode: 0,
                       preventDefault() {} });
        await tick(800);
        assert.deepEqual(pending(), []);
    } finally {
        globalThis.inView = null;
    }
});

test('the preview refreshed with nothing changed moves none of its ' +
     'parts, which would lay the whole document out again', async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|Aims]]\n    - [[G-bbbbb|p]]\n- [[G-ccccc|q]]\n');
    await app.vault.create(cardPath('G-aaaaa'), '# Aims');
    await app.vault.create(cardPath('G-bbbbb'), 'The prose.');
    await app.vault.create(cardPath('G-ccccc'), 'More prose.');
    const plugin = { settings: { headingTop: 1 }, focusCard() {} };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    await view.setState({ file: INDEX });
    await tick(50);
    const changes = [];
    const watch = new h.window.MutationObserver((m) => changes.push(...m));
    watch.observe(view.doc, { childList: true });
    await view.refresh();
    await tick();
    watch.disconnect();
    assert.equal(changes.length, 0);
    const order = () => [...view.doc.querySelectorAll('.dendrite-pblock')]
        .map((el) => el.dataset.id);
    assert.deepEqual(order(), ['G-aaaaa', 'G-bbbbb', 'G-ccccc']);
    // A card moved to the front is moved in the preview too.
    const f = app.vault.getAbstractFileByPath(INDEX);
    await app.vault.modify(f, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-ccccc|q]]\n- [[G-aaaaa|Aims]]\n    - [[G-bbbbb|p]]\n');
    await view.refresh();
    assert.deepEqual(order(), ['G-ccccc', 'G-aaaaa', 'G-bbbbb']);
    await view.onClose();
});

test('the preview empties drawn parts far from its view at their ' +
     'height, keeps the active one, and sizes parts never drawn',
     async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|Aims]]\n    - [[G-bbbbb|p]]\n- [[G-ccccc|q]]\n');
    await app.vault.create(cardPath('G-aaaaa'), '# Aims');
    await app.vault.create(cardPath('G-bbbbb'), 'The prose. '.repeat(40));
    await app.vault.create(cardPath('G-ccccc'), 'More prose.');
    const plugin = { settings: { headingTop: 1 }, focusCard() {} };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    h.window.document.body.appendChild(view.contentEl);
    // The view 500 px high: A and C in it at first, B far below. Only
    // what is near the view is seen scrolling into it.
    const tops = { 'G-aaaaa': 0, 'G-bbbbb': 9000, 'G-ccccc': 200 };
    const seen = view.observer;
    view.observer = { observe(el) {
        if (Math.abs(tops[el.dataset.id]) < 1300) seen.observe(el);
    }, unobserve() {}, disconnect() {} };
    const proto = h.window.HTMLElement.prototype;
    const real = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function () {
        if (this.classList.contains('dendrite-preview-doc')) {
            return { top: 0, bottom: 500, height: 500, left: 0, right: 600,
                     width: 600 };
        }
        const top = tops[this.dataset && this.dataset.id] ?? 0;
        return { top, bottom: top + 120, height: 120, left: 0, right: 600,
                 width: 600 };
    };
    try {
        await view.setState({ file: INDEX });
        const b = view.blocks.get('G-bbbbb').el;
        assert.ok(b.hasClass('is-pending'));
        assert.match(b.style.height, /^\d+px$/, 'never drawn, sized');
        await tick(50);
        // Scrolled on: A and C are now far above the view.
        tops['G-aaaaa'] = -20000;
        tops['G-ccccc'] = -9500;
        view.highlight('G-aaaaa');
        await tick(1200);
        const c = view.blocks.get('G-ccccc').el;
        assert.ok(c.hasClass('is-pending'), 'far, emptied');
        assert.equal(c.style.height, '120px');
        assert.equal(c.childElementCount, 0);
        assert.ok(!view.blocks.get('G-aaaaa').el.hasClass('is-pending'),
                  'the active part stays drawn');
        // Brought near, it is drawn again at its own height.
        tops['G-ccccc'] = 100;
        view.doc.dispatchEvent(new h.window.Event('scroll'));
        await tick(800);
        assert.ok(!c.hasClass('is-pending'));
        assert.equal(c.style.height, '');
    } finally {
        proto.getBoundingClientRect = real;
        await view.onClose();
        view.contentEl.remove();
    }
});

test('the preview draws while idle only the parts near its view',
     async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|Aims]]\n    - [[G-bbbbb|p]]\n');
    await app.vault.create(cardPath('G-aaaaa'), '# Aims');
    await app.vault.create(cardPath('G-bbbbb'), 'The prose.');
    const plugin = { settings: { headingTop: 1 }, focusCard() {} };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    view.observer = { observe() {}, unobserve() {}, disconnect() {} };
    h.window.document.body.appendChild(view.contentEl);
    // The view 500 px high; the second part 5000 px down.
    const tops = { 'G-aaaaa': 0, 'G-bbbbb': 5000 };
    const proto = h.window.HTMLElement.prototype;
    const real = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function () {
        if (this.classList.contains('dendrite-preview-doc')) {
            return { top: 0, bottom: 500, height: 500, left: 0, right: 600,
                     width: 600 };
        }
        const top = tops[this.dataset && this.dataset.id] || 0;
        return { top, bottom: top + 100, height: 100, left: 0, right: 600,
                 width: 600 };
    };
    try {
        await view.setState({ file: INDEX });
        await tick(1200);
        const waiting = () => [...view.blocks]
            .filter(([, b]) => b.el.hasClass('is-pending')).map(([id]) => id);
        assert.deepEqual(waiting(), ['G-bbbbb'], 'the far part waits');
        tops['G-bbbbb'] = 600;
        view.doc.dispatchEvent(new h.window.Event('scroll'));
        await tick(800);
        assert.deepEqual(waiting(), [], 'drawn once scrolled near');
    } finally {
        proto.getBoundingClientRect = real;
        await view.onClose();
        view.contentEl.remove();
    }
});

test('cards drawn while idle are drawn together, and do not each ' +
     'centre the board', async () => {
    globalThis.inView = (el) => el.dataset && el.dataset.id === 'G-aaaaa';
    try {
        const { view } = await open(
            '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
            '    - [[G-bbbbb|B]]\n    - [[G-ccccc|C]]\n',
            { 'G-aaaaa': 'A', 'G-bbbbb': 'B', 'G-ccccc': 'C' });
        shown(view.board);
        view.active = 'G-aaaaa';
        view.applyActive(false);
        let centred = 0;
        const centre = view.centre.bind(view);
        view.centre = (...a) => { centred++; return centre(...a); };
        const started = [];
        const draw = view.renderCard.bind(view);
        view.renderCard = (id) => {
            started.push([id, started.length]);
            return draw(id);
        };
        await tick(1000);
        assert.deepEqual(started.map(([id]) => id).sort(),
                         ['G-bbbbb', 'G-ccccc'], 'both drawn');
        assert.equal(centred, 0, 'B and C are on the active path, but ' +
                     'drawn while idle they leave centring to the resize');
    } finally {
        globalThis.inView = null;
    }
});

test('a card far from the view is a slot of one element at its height, ' +
     'filled with its number and status as it comes near', async () => {
    globalThis.inView = (el) => el.dataset && el.dataset.id === 'G-aaaaa';
    try {
        const { view } = await open(
            '---\ndendrite_prefix: G\ndendrite_number_sections: true\n' +
            '---\n- [[G-aaaaa|Aims]]\n- [[G-bbbbb|Methods]]\n',
            { 'G-aaaaa': '# Aims',
              'G-bbbbb': '---\ndendrite_status: revise\n---\n# Methods' });
        shown(view.board);
        const b = view.cardEls.get('G-bbbbb');
        assert.ok(b.hasClass('is-slot'), 'out of view, a slot');
        assert.equal(b.childElementCount, 0, 'with nothing in it');
        assert.match(b.style.height, /^\d+px$/, 'kept at a height');
        await tick(1000);
        assert.ok(!b.hasClass('is-slot'), 'filled while idle');
        assert.equal(b.querySelector('.dendrite-num')?.textContent, '2.');
        assert.deepEqual([...b.querySelectorAll('.dendrite-status-chip')]
            .map((c) => c.textContent), ['revise ⚑']);
        assert.ok(b.querySelector('.dendrite-card-foot .dendrite-id'));
    } finally {
        globalThis.inView = null;
    }
});

test('a drawn card far from the view goes back to its slot at the height ' +
     'it was drawn, but never the active card', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n' +
        '- [[G-ccccc|C]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B', 'G-ccccc': 'C' });
    await tick(600);
    view.active = 'G-aaaaa';
    // A board 500 px high; B and A far below it, C in it.
    view.board.getBoundingClientRect = () => ({ top: 0, bottom: 500,
        left: 0, right: 1000, width: 1000, height: 500 });
    const at = { 'G-aaaaa': 20000, 'G-bbbbb': 9000, 'G-ccccc': 100 };
    for (const [id, el] of view.cardEls) {
        el.getBoundingClientRect = () => ({ top: at[id],
            bottom: at[id] + 137, left: 0, right: 300, width: 300,
            height: 137 });
        Object.defineProperty(el, 'offsetHeight', { get: () => 137 });
    }
    // Only C is in view now.
    globalThis.inView = (el) => el.dataset && el.dataset.id === 'G-ccccc';
    try {
        view.drawWhenIdle();
        await tick(800);
        const b = view.cardEls.get('G-bbbbb');
        assert.ok(b.hasClass('is-slot'));
        assert.equal(b.style.height, '137px');
        assert.equal(b.childElementCount, 0);
        assert.ok(!view.rendered.has('G-bbbbb'),
                  'its drawn text let go, so memory stays bounded');
        assert.ok(!view.cardEls.get('G-aaaaa').hasClass('is-slot'),
                  'the active card stays drawn');
        assert.ok(!view.cardEls.get('G-ccccc').hasClass('is-slot'));
    } finally {
        globalThis.inView = null;
    }
});

test('the board rebuilt keeps drawn cards drawn; a slot is filled to be ' +
     'edited, and not for a change to its note', async () => {
    globalThis.inView = (el) => el.dataset && el.dataset.id === 'G-aaaaa';
    try {
        const { view, app } = await open(
            '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
            { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
        assert.ok(!view.cardEls.get('G-aaaaa').hasClass('is-slot'));
        view.render();
        assert.ok(!view.cardEls.get('G-aaaaa').hasClass('is-slot'),
                  'drawn at once after the rebuild');
        assert.ok(view.cardEls.get('G-bbbbb').hasClass('is-slot'));
        // A sync changes B: it stays a slot.
        view.plugin.typedAt = Date.now() + 5000;
        await app.vault.modify(app.vault.getAbstractFileByPath(
            cardPath('G-bbbbb')), 'B, synced');
        await tick(50);
        assert.ok(view.cardEls.get('G-bbbbb').hasClass('is-slot'));
        // Editing B fills it, with its editor.
        await view.startEdit('G-bbbbb');
        const b = view.cardEls.get('G-bbbbb');
        assert.ok(!b.hasClass('is-slot'));
        assert.ok(b.querySelector('.dendrite-card-body')
            .contains(view.editing.editor.el));
        await view.endEdit();
        view.plugin.typedAt = 0;
    } finally {
        globalThis.inView = null;
    }
});

test('find leaves slots empty, and a slot filled while finding shows ' +
     'its matches below', async () => {
    globalThis.inView = (el) => el.dataset && el.dataset.id !== 'G-aaaaa';
    try {
        const { view } = await open(
            '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
            '    - [[G-bbbbb|B]]\n',
            { 'G-aaaaa': 'Aims.', 'G-bbbbb': 'TET2 here.' });
        view.active = 'G-bbbbb';
        view.plugin.typedAt = Date.now() + 5000;
        const a = view.cardEls.get('G-aaaaa');
        if (!a.hasClass('is-slot')) view.emptyFar(['G-aaaaa']);
        assert.ok(a.hasClass('is-slot'));
        view.openFind();
        view.find.input.value = 'tet2';
        view.find.input.dispatchEvent(new h.window.Event('input'));
        await tick(150);
        assert.equal(a.childElementCount, 0, 'the slot stays empty');
        await view.renderCard('G-aaaaa');
        assert.equal(a.querySelector(':scope > .dendrite-find-below')
            ?.textContent, '1 below');
        view.plugin.typedAt = 0;
    } finally {
        globalThis.inView = null;
    }
});

test('a slot never drawn is estimated from the cards drawn so far, ' +
     'measured as they resize', async () => {
    const cards = {};
    const lines = [];
    // Ten drawn cards of 1 to 10 lines' worth of text, each measured at
    // 50 px plus 30 px a line; one more never drawn, of 20 lines.
    for (let k = 1; k <= 11; k++) {
        const id = `G-${String(k).padStart(5, 'a')}`;
        cards[id] = 'x'.repeat(Math.round(44 * (k === 11 ? 20 : k)) - 1);
        lines.push(`- [[${id}|c${k}]]`);
    }
    const ids = Object.keys(cards);
    globalThis.inView = (el) => el.dataset && el.dataset.id !== ids[10];
    try {
        const { view } = await open(
            '---\ndendrite_prefix: G\n---\n' + lines.join('\n') + '\n',
            cards);
        await view.loadBodies();
        view.resizer.cb(ids.slice(0, 10).map((id, k) => ({
            target: view.cardEls.get(id),
            borderBoxSize: [{ blockSize: 50 + 30 * (k + 1) }] })));
        assert.equal(view.slotHeight(ids[10]), 50 + 30 * 20);
        assert.equal(view.slotHeight(ids[3]), 50 + 30 * 4,
                     'a drawn card keeps its own height');
    } finally {
        globalThis.inView = null;
    }
});

test('a board or preview not shown, as in a tab behind another, draws ' +
     'nothing while idle', async () => {
    globalThis.inView = (el) => el.dataset && el.dataset.id === 'G-aaaaa';
    try {
        const { view } = await open(
            '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
            { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
        // Not shown, everything measures nothing, all at one point.
        view.board.getBoundingClientRect = () => ({ top: 0, bottom: 0,
            left: 0, right: 0, width: 0, height: 0 });
        assert.equal(view.nextToDraw(), null);
        assert.ok(waiting(view.cardEls.get('G-bbbbb')));
    } finally {
        globalThis.inView = null;
    }
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|A]]\n');
    await app.vault.create(cardPath('G-aaaaa'), 'Text.');
    const plugin = { settings: { headingTop: 1 }, focusCard() {} };
    const pv = new DendritePreview({ app, updateHeader() {} }, plugin);
    await pv.onOpen();
    pv.observer = { observe() {}, unobserve() {}, disconnect() {} };
    h.window.document.body.appendChild(pv.contentEl);
    await pv.setState({ file: INDEX });
    pv.doc.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0,
        right: 0, width: 0, height: 0 });
    assert.equal(pv.nextToDraw(), null);
    assert.ok(pv.blocks.get('G-aaaaa').el.hasClass('is-pending'));
    await pv.onClose();
    pv.contentEl.remove();
});

test('find goes to a match in a card that is a slot: it is filled, ' +
     'selected and its match painted', async () => {
    globalThis.inView = (el) => el.dataset && el.dataset.id === 'G-aaaaa';
    try {
        const { view } = await open(
            '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
            { 'G-aaaaa': 'Aims.', 'G-bbbbb': 'Far away, TET2.' });
        view.plugin.typedAt = Date.now() + 5000;
        assert.ok(view.cardEls.get('G-bbbbb').hasClass('is-slot'));
        h.window.CSS = { highlights: new Map() };
        h.window.Highlight = class { constructor(...r) { this.ranges = r; } };
        view.openFind();
        view.find.input.value = 'tet2';
        view.find.input.dispatchEvent(new h.window.Event('input'));
        await tick(200);
        const b = view.cardEls.get('G-bbbbb');
        assert.equal(view.active, 'G-bbbbb');
        assert.ok(!b.hasClass('is-slot'), 'filled');
        assert.ok(b.hasClass('is-active'));
        assert.ok(b.querySelector('.dendrite-md'), 'its text drawn');
        await tick(50);
        const lit = (h.window.CSS.highlights.get('dendrite-find-current') ||
            { ranges: [] }).ranges.map((r) => r.toString());
        assert.deepEqual(lit, ['TET2']);
        view.plugin.typedAt = 0;
    } finally {
        globalThis.inView = null;
        delete h.window.CSS;
        delete h.window.Highlight;
    }
});

test('a card\'s note is resolved once, not on every pass over the ' +
     'cards, and again after notes are created or renamed', async () => {
    const { app, view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    let resolved = 0;
    const mc = app.metadataCache;
    const real = mc.getFirstLinkpathDest.bind(mc);
    mc.getFirstLinkpathDest = (...a) => { resolved++; return real(...a); };
    await view.loadBodies();
    const once = resolved;
    await view.loadBodies();
    assert.equal(resolved, once, 'kept from the pass before');
    await app.vault.create('W/Grant/cards/G-zzzzz.md', 'Z');
    resolved = 0;
    await view.loadBodies();
    assert.equal(resolved, 2, 'resolved again after a note was created');
});

test('a long move jumps to within a screen of its place and slides the ' +
     'rest, so the cards it would pass are not drawn', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'A' });
    // A column 500 px high over 20,000 px of cards, at the top.
    const col = view.board.querySelector('.dendrite-col');
    Object.defineProperty(col, 'clientHeight', { get: () => 500 });
    Object.defineProperty(view.colInners[0], 'scrollHeight',
                          { get: () => 20000 });
    Object.defineProperty(view.board, 'clientHeight', { get: () => 500 });
    view.setColOffset(0, 0);
    const seen = [];
    const set = view.setColOffset.bind(view);
    view.setColOffset = (d, y) => { seen.push(Math.round(y)); set(d, y); };
    view.animateOffsets([10000], true);
    await tick(400);
    assert.equal(view.colOffset(0), 10000, 'it arrives');
    assert.ok(seen.every((y) => y >= 9500),
              `never between: ${seen.slice(0, 3).join(', ')}`);
    // A short move slides all the way, as before.
    seen.length = 0;
    view.animateOffsets([10300], true);
    await tick(400);
    assert.equal(view.colOffset(0), 10300);
    assert.ok(seen.some((y) => y < 10300 && y > 10000), 'slid');
});

test('a burst of notes changed, as a sync brings, updates the board ' +
     'once, not once a note', async () => {
    const ids = ['G-aaaaa', 'G-bbbbb', 'G-ccccc', 'G-ddddd'];
    const { app, view } = await open(
        '---\ndendrite_prefix: G\n---\n' +
        ids.map((id) => `- [[${id}|x]]`).join('\n') + '\n',
        Object.fromEntries(ids.map((id) => [id, 'Text.'])));
    await tick(20);
    let statuses = 0;
    const real = view.updateStatuses.bind(view);
    view.updateStatuses = () => { statuses++; return real(); };
    for (const id of ids) {
        app.metadataCache.trigger('changed',
            app.vault.getAbstractFileByPath(cardPath(id)));
    }
    await tick(50);
    assert.equal(statuses, 1);
});

test('a slot filled keeps its height, blank, until its text is drawn, ' +
     'and a card selected is drawn before the board moves to it',
     async () => {
    globalThis.inView = (el) => el.dataset && el.dataset.id === 'G-aaaaa';
    try {
        const { view } = await open(
            '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n' +
            '- [[G-ccccc|C]]\n',
            { 'G-aaaaa': 'A', 'G-bbbbb': 'B', 'G-ccccc': 'C' });
        view.plugin.typedAt = Date.now() + 5000;
        const b = view.cardEls.get('G-bbbbb');
        b.style.height = '230px';
        view.fillFrame('G-bbbbb');
        assert.ok(b.hasClass('is-pending'));
        assert.equal(b.querySelector('.dendrite-placeholder').textContent, '',
                     'no label shown while it waits');
        assert.equal(b.style.minHeight, '230px', 'kept at its height');
        await view.renderCard('G-bbbbb');
        assert.equal(b.style.minHeight, '', 'its own height once drawn');
        // Selected, C is drawn before the board is centred on it.
        const c = view.cardEls.get('G-ccccc');
        assert.ok(c.hasClass('is-slot'));
        let drawnWhenCentred = null;
        const centre = view.centre.bind(view);
        view.centre = (...a) => {
            if (drawnWhenCentred === null) {
                drawnWhenCentred = !!c.querySelector('.dendrite-md');
            }
            return centre(...a);
        };
        await view.select('G-ccccc');
        assert.equal(drawnWhenCentred, true);
        view.plugin.typedAt = 0;
    } finally {
        globalThis.inView = null;
    }
});

test('a card changing height re-centres the board in the same frame, ' +
     'so the shifted column is never painted', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    view.active = 'G-bbbbb';
    view.applyActive(false);
    let centred = 0;
    const centre = view.centre.bind(view);
    view.centre = (...a) => { centred++; return centre(...a); };
    // The resize observer calls back after layout and before painting.
    view.resizer.cb([]);
    assert.equal(centred, 1, 'at once, not on the next frame');
});

test('a card above a column\'s view changing height moves the column ' +
     'with it, so what is on screen stays put', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    const col = view.board.querySelector('.dendrite-col');
    Object.defineProperty(col, 'clientHeight', { get: () => 500 });
    Object.defineProperty(view.colInners[0], 'scrollHeight',
                          { get: () => 20000 });
    const a = view.cardEls.get('G-aaaaa');
    const b = view.cardEls.get('G-bbbbb');
    Object.defineProperty(a, 'offsetTop', { get: () => 200 });
    Object.defineProperty(b, 'offsetTop', { get: () => 3000 });
    const size = (el, h) => ({ target: el, borderBoxSize: [{ blockSize: h }] });
    // Scrolled by hand to 1000 px down: A is above the view, B below.
    view.resizer.cb([size(a, 100), size(b, 100)]);
    view.onWheel({ target: col, deltaY: 1000, deltaMode: 0,
                   preventDefault() {} });
    assert.equal(view.colOffset(0), 1000);
    view.resizer.cb([size(a, 300)]);
    assert.equal(view.colOffset(0), 1200, 'moved with A, 200 px taller');
    view.resizer.cb([size(b, 50)]);
    assert.equal(view.colOffset(0), 1200, 'B is below the view');
});

test('idle drawing waits while the board is moving and just after a key',
     async () => {
    globalThis.inView = (el) => el.dataset && el.dataset.id === 'G-aaaaa';
    try {
        const { view } = await open(
            '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
            { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
        shown(view.board);
        const pending = () => waiting(view.cardEls.get('G-bbbbb'));
        view.anim = 1;
        await tick(700);
        assert.ok(pending(), 'not drawn while the board moves');
        view.anim = null;
        view.plugin.typedAt = Date.now() + 800;
        await tick(700);
        assert.ok(pending(), 'not drawn just after a key');
        await tick(1800);
        assert.ok(!pending(), 'drawn once things are quiet');
    } finally {
        globalThis.inView = null;
    }
});

test('a card drawn while the board moves to another turns the move ' +
     'smoothly, rather than jumping the columns', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
        '    - [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    view.active = 'G-aaaaa';
    view.applyActive(false);
    const calls = [];
    const centre = view.centre.bind(view);
    view.centre = (...a) => { calls.push(a[0]); return centre(...a); };
    // A smooth move under way.
    view.anim = 1;
    view.invalidate('G-bbbbb');
    view.cardEls.get('G-bbbbb').addClass('is-pending');
    await view.renderCard('G-bbbbb');
    assert.deepEqual(calls, [true], 'the move goes on to the new place');
    view.resizer.cb([]);
    await tick(5);
    assert.deepEqual(calls, [true, true], 'a resize turns it too');
    // At rest, a card drawn places the board at once, as before.
    view.anim = null;
    calls.length = 0;
    view.invalidate('G-bbbbb');
    view.cardEls.get('G-bbbbb').addClass('is-pending');
    await view.renderCard('G-bbbbb');
    assert.deepEqual(calls, [false]);
});

test('a phone\'s touch scroll counts as by hand when the board is rebuilt',
     async () => {
    const { app, view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    view.active = 'G-aaaaa';
    view.applyActive(false);
    let centred = 0;
    const centre = view.centre.bind(view);
    view.centre = (...a) => { centred++; return centre(...a); };
    view.scrolledByHand = true;
    const f = app.vault.getAbstractFileByPath(INDEX);
    await app.vault.modify(f, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-bbbbb|B]]\n- [[G-aaaaa|A]]\n');
    await tick(400);
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-bbbbb', 'G-aaaaa'], 'the index was re-read');
    assert.equal(centred, 0, 'not pulled back to the active card');
});

test('Say what moves the board names what centred it, and says when ' +
     'it moved with no touch and no centring', async () => {
    const { callers } = require('../src/main.js');
    // The stacks of the two engines Obsidian runs in.
    assert.deepEqual(callers('Error\n' +
        '    at DendriteView.tellCentred (plugin:dendrite:1:2)\n' +
        '    at DendriteView.centre (plugin:dendrite:1:2)\n' +
        '    at DendriteView.applyActive (plugin:dendrite:1:2)\n' +
        '    at async DendriteView.select (plugin:dendrite:1:2)\n'),
    ['centre', 'applyActive', 'select']);
    assert.deepEqual(callers('tellCentred@app://x:1:2\n' +
        'centre@app://x:1:2\n@app://x:1:2\nrenderCard@app://x:1:2\n', 0),
    ['centre', 'renderCard']);
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    view.plugin.settings.showBoardMoves = true;
    const board = view.board;
    board.scrollLeft = 300;
    h.notices.length = 0;
    await view.select('G-bbbbb');
    assert.match(h.notices[0] || '',
                 /^Dendrite centred the board, -300 px: .*applyActive/);
    // Long after any touch or centring, something else moves it.
    view.handAt = 0;
    view.centredAt = 0;
    h.notices.length = 0;
    board.scrollLeft = 0;
    board.dispatchEvent(new h.window.Event('scroll'));
    board.scrollLeft = 250;
    board.dispatchEvent(new h.window.Event('scroll'));
    assert.deepEqual(h.notices, ['Dendrite: the board moved 250 px ' +
                                 'sideways with no touch and no centring.']);
    // Off, nothing is said.
    view.plugin.settings.showBoardMoves = false;
    h.notices.length = 0;
    board.scrollLeft = 0;
    board.dispatchEvent(new h.window.Event('scroll'));
    await view.select('G-aaaaa');
    assert.deepEqual(h.notices, []);
});

test('leaving the editor saves at once, before the autosave fires',
     async () => {
    const { view, read, text } = await open('---\ndendrite_prefix: G\n---\n');
    view.plugin.settings.autosaveMs = 100000;
    await view.insert('first');
    const id = view.active;
    type(view, 'Never lost.');
    await view.endEdit();
    assert.equal(text(cardPath(id)), 'Never lost.');
});

test('a card\'s frontmatter survives editing its text', async () => {
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|Old]]\n',
        { 'G-aaaaa': '---\naliases:\n  - Kept alias\n---\nOld text\n' });
    await view.startEdit('G-aaaaa');
    assert.equal(view.editing.ta.value, 'Old text\n',
                 'the editor shows the body only');
    type(view, 'New text\n');
    await view.endEdit();
    assert.equal(read(cardPath('G-aaaaa')),
                 '---\naliases:\n  - Kept alias\ndendrite_status: draft\n' +
                 '---\nNew text\n', 'the alias is kept beside the status');
    assert.match(read(INDEX), /\[\[G-aaaaa\|Kept alias\]\]/,
                 'the alias, not the first words, is the label');
});

test('insert below, child and above, then indent and outdent', async () => {
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': '# A\n' });
    view.active = 'G-aaaaa';
    await view.insert('below');
    const b = view.active;
    await view.insert('child');
    const c = view.active;
    view.active = b;
    await view.insert('above');
    const d = view.active;
    await view.endEdit();
    const ids = () => [...read(INDEX).matchAll(/\[\[([^|\]]+)/g)]
        .map((m) => m[1]);
    assert.deepEqual(ids(), ['G-aaaaa', d, b, c]);
    assert.match(read(INDEX), new RegExp(`\\n    - \\[\\[${c}`),
                 'the child is nested under its parent');
    view.active = d;
    await view.structural('indent');
    assert.match(read(INDEX), new RegExp(`\\n    - \\[\\[${d}`));
    await view.structural('outdent');
    assert.match(read(INDEX), new RegExp(`\\n- \\[\\[${d}`));
});

test('delete trashes the branch and undo restores notes and tree',
     async () => {
    const index = '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|A]]\n    - [[G-bbbbb|B text]]\n' +
        '- [[G-ccccc|C text]]\n';
    const { view, read, text } = await open(index, {
        'G-aaaaa': '# A\n', 'G-bbbbb': 'B text', 'G-ccccc': 'C text' });
    view.active = 'G-aaaaa';
    await view.deleteActive();
    assert.equal(text(cardPath('G-aaaaa')), undefined);
    assert.equal(text(cardPath('G-bbbbb')), undefined);
    assert.equal(read(INDEX), '---\ndendrite_prefix: G\n---\n' +
                 '- [[G-ccccc|C text]]\n');
    assert.equal(view.active, 'G-ccccc');
    await view.doUndo();
    assert.equal(text(cardPath('G-bbbbb')), 'B text');
    assert.equal(read(INDEX), index);
});

test('an index edited outside Dendrite is re-read; its own writes are not',
     async () => {
    const { app, view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    let reloads = 0;
    const orig = view.reload.bind(view);
    view.reload = async () => { reloads++; await orig(); };
    view.active = 'G-aaaaa';
    await view.structural('down');
    await view.writeIndex();
    await tick(400);
    assert.equal(reloads, 0, 'own write ignored');
    const f = app.vault.getAbstractFileByPath(INDEX);
    await app.vault.modify(f, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-bbbbb|B]]\n- [[G-aaaaa|A]]\n');
    await tick(400);
    assert.equal(reloads, 1);
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-bbbbb', 'G-aaaaa']);
});

test('cards in cards/ that the index misses are offered for adoption',
     async () => {
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'A', 'G-zzzzz': '# Lost card' });
    assert.deepEqual(view.unlinkedCards().map((f) => f.basename),
                     ['G-zzzzz']);
    await view.adopt(view.unlinkedCards());
    assert.match(read(INDEX), /- \[\[G-zzzzz\|Lost card\]\]\n$/);
});

test('export writes the manuscript beside the index', async () => {
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|Aims]]\n    - [[G-bbbbb|p]]\n',
        { 'G-aaaaa': '# Aims\nplanning', 'G-bbbbb': 'Prose %%note%%here.' });
    await view.exportTo(null);
    assert.equal(read('W/Grant/exports/Grant.md'),
                 '# Aims\n\nProse here.\n');
});

test('opening at a card makes it the active card', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    assert.equal(view.active, 'G-aaaaa');
    await view.setState({ file: INDEX, card: 'G-bbbbb' });
    assert.equal(view.active, 'G-bbbbb');
    assert.ok(view.cardEls.get('G-bbbbb').hasClass('is-active'));
});

test('numbering shows on section cards and never enters their notes',
     async () => {
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\ndendrite_number_sections: true\n---\n' +
        '- [[G-aaaaa|Outline]]\n    - [[G-bbbbb|Sub]]\n' +
        '    - [[G-ccccc|p]]\n- [[G-ddddd|Methods]]\n',
        { 'G-aaaaa': '# Outline', 'G-bbbbb': '# Sub', 'G-ccccc': 'Text.',
          'G-ddddd': '# Methods' });
    const num = (id) => view.cardEls.get(id)
        .querySelector('.dendrite-num')?.textContent;
    assert.equal(num('G-aaaaa'), '1.');
    assert.equal(num('G-bbbbb'), '1.1');
    assert.equal(num('G-ccccc'), undefined);
    assert.equal(num('G-ddddd'), '2.');
    view.active = 'G-ddddd';
    await view.structural('up');
    assert.equal(num('G-ddddd'), '1.');
    assert.equal(num('G-aaaaa'), '2.');
    assert.equal(text(cardPath('G-aaaaa')), '# Outline',
                 'the number is not written into the card');
    await view.exportTo(null);
    assert.equal(read('W/Grant/exports/Grant.md'),
                 '# 1. Methods\n\n# 2. Outline\n\n## 2.1 Sub\n\nText.\n');
});

test('quotas show as a filled target, with details on hover and a quick ' +
     'editor on click', async () => {
    const { view, app, read, text } = await open(
        '---\ndendrite_prefix: G\ndendrite_limit: 1 page\n' +
        'dendrite_limit_required: true\ndendrite_words_per_page: 10\n---\n' +
        '- [[G-aaaaa|Aims]]\n    - [[G-bbbbb|p]]\n- [[G-ccccc|C]]\n',
        { 'G-aaaaa': '---\ndendrite_limit: 8 words\n---\n# Aims\nplan',
          'G-bbbbb': '---\ndendrite_limit: 2 words\n---\n' +
                     'one two three %%not counted%%',
          'G-ccccc': 'C' });
    await view.updateCounts();
    const widget = (id) => view.cardEls.get(id)
        .querySelector('.dendrite-quota');
    const a = widget('G-aaaaa');
    assert.ok(!a.hasClass('is-empty'));
    assert.equal(a.querySelector('.dendrite-quota-fill').style.width, '50%',
                 '4 of 8 words');
    assert.ok(!a.hasClass('is-over-target'));
    assert.ok(widget('G-bbbbb').hasClass('is-over-target'),
              '3 of 2 words: amber');
    assert.ok(widget('G-ccccc').hasClass('is-empty'),
              'no quota: hidden until hover');
    view.showQuotaTip('G-aaaaa', a);
    const lines = [...document.querySelectorAll(
        '.dendrite-quota-tip .dendrite-quota-line')];
    assert.equal(lines[0].firstChild.textContent, '4 / 8 words');
    assert.equal(lines[1].textContent, '2 allocated, 6 free');
    view.hideQuotaTip();
    // Counts show on hover with a quota or without one, as a table:
    // the card, then with the cards below it.
    const table = () => [...document.querySelectorAll(
        '.dendrite-quota-tip .dendrite-count-table tr')].map((tr) =>
        [...tr.children].map((c) => c.textContent));
    await view.showQuotaTip('G-ccccc', widget('G-ccccc'));
    assert.deepEqual(table(), [['', 'Chars', 'Words', 'Pages'],
                               ['This card', '1', '1', '~0.1']]);
    view.hideQuotaTip();
    // The section prints its heading only; the rest is its child's.
    await view.showQuotaTip('G-aaaaa', a);
    assert.deepEqual(table().slice(1).map((r) => [r[0], r[2], r[3]]),
                     [['This card', '1', '~0.1'],
                      ['With cards below', '4', '~0.4']]);
    view.hideQuotaTip();
    const top = [...view.totalEl.querySelectorAll('.dendrite-quota-line')];
    assert.equal(top[0].firstChild.textContent, '~0.5 / 1 page',
                 '5 words at 10 per page');

    // The quick editor writes the quota, required, then removes it.
    app.keymap = { pushScope() {}, popScope() {} };
    view.editQuota('G-ccccc', widget('G-ccccc'));
    const pop = document.querySelector('.dendrite-quota-pop');
    pop.querySelector('input[type=text]').value = '1/4';
    pop.querySelector('select').value = 'pages';
    pop.querySelector('input[type=checkbox]').checked = true;
    pop.querySelector('button.mod-cta').click();
    await tick(10);
    assert.match(read(cardPath('G-ccccc')),
                 /dendrite_limit: 0.25 pages\ndendrite_limit_required: true/);
    assert.equal(document.querySelector('.dendrite-quota-pop'), null);
    view.editQuota('G-ccccc', widget('G-ccccc'));
    [...document.querySelectorAll('.dendrite-quota-pop button')]
        .find((b) => b.textContent === 'Remove').click();
    await tick(10);
    assert.equal(text(cardPath('G-ccccc')), 'C', 'quota removed');
});

test('bold, tab and list enter edit the card and are saved', async () => {
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': '- point' });
    await view.startEdit('G-aaaaa');
    const ta = view.editing.ta;
    ta.setSelectionRange(2, 7);
    assert.equal(view.editKey('bold'), false, 'the key is handled');
    assert.equal(ta.value, '- **point**');
    ta.setSelectionRange(ta.value.length, ta.value.length);
    view.editKey('enter');
    assert.equal(ta.value, '- **point**\n- ');
    view.editKey('indent');
    assert.equal(ta.value, '- **point**\n    - ');
    await view.endEdit();
    assert.equal(text(cardPath('G-aaaaa')), '- **point**\n    - ');
    assert.equal(view.editKey('bold'), true,
                 'outside the editor the key goes through');
});

test('the active path flows into each child group', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|A]]\n    - [[G-bbbbb|B]]\n        - [[G-ccccc|C]]\n' +
        '- [[G-ddddd|D]]\n    - [[G-eeeee|E]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B', 'G-ccccc': 'C', 'G-ddddd': 'D',
          'G-eeeee': 'E' });
    await view.select('G-bbbbb');
    view.drawFlow();
    const flows = [...view.board.querySelectorAll('.is-flow')]
        .map((g) => g.querySelector('.dendrite-card').dataset.id);
    assert.deepEqual(flows.sort(), ['G-bbbbb', 'G-ccccc'],
                     'A opens into its children, B into its own');
    const ctx = view.flowSvg.querySelectorAll('.dendrite-flow-context');
    assert.equal(ctx.length, 1, 'the context is one shape, never doubled');
    assert.equal(ctx[0].getAttribute('d').split(' Z')
        .filter((s) => s.trim()).length, 4, 'two bands and two groups');
    const thread = view.flowSvg.querySelectorAll('.dendrite-flow-thread');
    assert.equal(thread.length, 1);
    assert.equal(thread[0].getAttribute('d').split(' Z')
        .filter((s) => s.trim()).length, 1, 'one step: A to B');
});

test('the flow is sized without reading the board\'s scroll width, ' +
     'which lays out every card while a column moves', async () => {
    // Measured 2026-10-27 on a 2,646-card board: reading scrollWidth
    // after a column moved took about 194 ms, on every wheel step and
    // every frame of a move.
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|A]]\n    - [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    await view.select('G-bbbbb');
    let reads = 0;
    Object.defineProperty(view.board, 'scrollWidth', {
        get() { reads++; return 0; } });
    const cols = view.board.querySelectorAll('.dendrite-col');
    const last = cols[cols.length - 1];
    Object.defineProperty(last, 'offsetLeft', { get: () => 900 });
    Object.defineProperty(last, 'offsetWidth', { get: () => 400 });
    view.drawFlow();
    assert.equal(reads, 0);
    assert.equal(view.flowSvg.style.width, '1300px',
                 'as wide as the board\'s columns reach');
});

test('the flow drawn again with nothing moved changes nothing, so it ' +
     'leaves no layout for the next read to pay for', async () => {
    // Measured 2026-10-27 on a 2,646-card board: rewriting the flow's
    // size and paths on every draw made the next position read lay the
    // board out again, about 194 ms a draw.
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|A]]\n    - [[G-bbbbb|B]]\n        - [[G-ccccc|C]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B', 'G-ccccc': 'C' });
    await view.select('G-bbbbb');
    view.drawFlow();
    const changes = [];
    const watch = new h.window.MutationObserver((m) => changes.push(...m));
    watch.observe(view.board, { subtree: true, childList: true,
                                attributes: true });
    view.drawFlow();
    await tick();
    watch.disconnect();
    assert.deepEqual(changes.map((m) => `${m.type} ${m.attributeName}`),
                     []);
    // Moving to another card still moves the flow.
    await view.select('G-aaaaa');
    view.drawFlow();
    const flows = [...view.board.querySelectorAll('.is-flow')]
        .map((g) => g.querySelector('.dendrite-card').dataset.id);
    assert.deepEqual(flows, ['G-bbbbb'], 'A opens into B\'s group only');
});

test('a warning left on screen is replaced by the next about the same ' +
     'thing, and Dismiss notices clears them all', async () => {
    const { stickyNotice, dismissNotices } = require('../src/main.js');
    h.shown.length = 0;
    stickyNotice('reverted:W/Grant.md:G-aaaaa', 'A changed, once');
    stickyNotice('reverted:W/Grant.md:G-bbbbb', 'B changed');
    stickyNotice('reverted:W/Grant.md:G-aaaaa', 'A changed, again');
    const open = () => h.shown.filter((n) => !n.hidden)
        .map((n) => n.message);
    assert.deepEqual(open(), ['B changed', 'A changed, again']);
    assert.equal(dismissNotices(), 2);
    assert.deepEqual(open(), []);
    assert.equal(dismissNotices(), 0, 'none left');
    // Notices from an earlier version, still showing, are clicked away,
    // and another plugin's are left.
    const Plugin = require('../src/main.js');
    const doc = h.window.document;
    const clicked = [];
    for (const text of ['Dendrite: Card 0007 changed', 'Other: hello']) {
        const el = doc.createElement('div');
        el.className = 'notice';
        el.textContent = text;
        el.addEventListener('click', () => clicked.push(text));
        doc.body.appendChild(el);
    }
    const plugin = Object.create(Plugin.prototype);
    plugin.app = h.makeApp();
    plugin.dismissAllNotices();
    assert.deepEqual(clicked, ['Dendrite: Card 0007 changed']);
    for (const el of [...doc.querySelectorAll('.notice')]) el.remove();
});

test('vim keys move, insert, rearrange and delete in normal mode',
     async () => {
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|A]]\n    - [[G-bbbbb|B]]\n- [[G-ccccc|C]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B', 'G-ccccc': 'C' });
    const key = async (k) => {
        view.contentEl.dispatchEvent(new h.window.KeyboardEvent(
            'keydown', { key: k, bubbles: true, cancelable: true }));
        await tick(5);
    };
    assert.equal(view.active, 'G-aaaaa');
    await key('j');
    assert.equal(view.active, 'G-ccccc');
    await key('k');
    await key('l');
    assert.equal(view.active, 'G-bbbbb');
    await key('h');
    assert.equal(view.active, 'G-aaaaa');
    assert.equal(view.modeEl.textContent, 'NORMAL');
    await key('i');
    assert.equal(view.editing.id, 'G-aaaaa');
    assert.equal(view.editing.ta.selectionStart, 0);
    assert.equal(view.modeEl.textContent, 'INSERT');
    await key('j');
    assert.equal(view.active, 'G-aaaaa', 'letters type in insert mode');
    await view.endEdit();
    await key('J');
    assert.match(read(INDEX), /- \[\[G-ccccc\|C\]\]\n- \[\[G-aaaaa/);
    await key('o');
    const fresh = view.active;
    assert.ok(view.editing && view.editing.id === fresh, 'o opens a card');
    await view.endEdit();
    await key('d');
    assert.ok(view.byId.has(fresh), 'one d does nothing');
    await key('d');
    assert.ok(!view.byId.has(fresh), 'dd deletes');
    await key('u');
    assert.ok(view.byId.has(fresh), 'u restores');
    await key('g');
    await key('g');
    assert.equal(view.active, 'G-ccccc', 'gg goes to the top');
    await key('G');
    assert.equal(view.active, fresh);
});

test('Ctrl+J, K and L make cards when the view\'s scope is not the ' +
     'active one, as Ctrl+arrows do', async () => {
    // Obsidian can leave the view's scope inactive after a card's editor
    // closes; the pane's own keydown then has to handle these keys.
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n', { 'G-aaaaa': 'A' });
    const key = async (k) => {
        view.contentEl.dispatchEvent(new h.window.KeyboardEvent(
            'keydown', { key: k, ctrlKey: true, bubbles: true,
                         cancelable: true }));
        await tick(5);
        if (view.editing) await view.endEdit();
    };
    view.active = 'G-aaaaa';
    await key('l');
    assert.equal(view.byId.get('G-aaaaa').children.length, 1, 'Ctrl+L');
    view.active = 'G-aaaaa';
    await key('j');
    assert.equal(view.root.children.length, 2, 'Ctrl+J');
    view.active = 'G-aaaaa';
    await key('k');
    assert.equal(view.root.children.length, 3, 'Ctrl+K');
    assert.equal(view.root.children[1].id, 'G-aaaaa', 'above it');
});

test('in edit mode the Ctrl shortcuts reach the text, not the view',
     async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n', { 'G-aaaaa': 'A' });
    await view.startEdit('G-aaaaa');
    const handler = (mods, key) => view.scope.keys.find((k) =>
        k.key === key && JSON.stringify(k.mods) === JSON.stringify(mods)).fn;
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowUp', 'j', 'k', 'l',
                       'Enter']) {
        assert.equal(handler(['Mod'], key)(), true, 'Ctrl+' + key);
    }
    assert.equal(view.root.children.length, 1, 'no card was created');
    assert.equal(view.editing.id, 'G-aaaaa', 'still editing');
    await view.endEdit();
    assert.equal(handler(['Mod'], 'ArrowDown')(), false,
                 'in normal mode the shortcut acts');
});

test('the Linter exemption is added once and only its own entry moves',
     async () => {
    const DendritePlugin = require('../src/main.js');
    const make = (folders) => {
        const linter = { settings: { foldersToIgnore: folders }, saves: 0,
                         async saveSettings() { this.saves++; } };
        const p = new DendritePlugin();
        p.app = { plugins: { plugins: { 'obsidian-linter': linter } } };
        p.settings = { writingFolder: 'Writing', manageLinter: true,
                       linterAdded: null };
        p.saveData = async () => {};
        return { p, linter };
    };
    const { p, linter } = make(['Templates']);
    await p.syncLinter();
    assert.deepEqual(linter.settings.foldersToIgnore,
                     ['Templates', 'Writing']);
    assert.equal(p.settings.linterAdded, 'Writing');
    await p.syncLinter();
    assert.equal(linter.saves, 1, 'nothing rewritten when already right');
    p.settings.writingFolder = 'Drafts';
    await p.syncLinter();
    assert.deepEqual(linter.settings.foldersToIgnore,
                     ['Templates', 'Drafts'], 'its own entry moved');
    p.settings.manageLinter = false;
    await p.syncLinter();
    assert.deepEqual(linter.settings.foldersToIgnore, ['Templates']);
    assert.equal(p.settings.linterAdded, null);

    const own = make(['Writing']);
    await own.p.syncLinter();
    assert.equal(own.p.settings.linterAdded, null, 'the entry was not ours');
    own.p.settings.manageLinter = false;
    await own.p.syncLinter();
    assert.deepEqual(own.linter.settings.foldersToIgnore, ['Writing'],
                     'a hand-added entry is never removed');

    const none = new DendritePlugin();
    none.app = { plugins: { plugins: {} } };
    none.settings = { writingFolder: 'Writing', manageLinter: true };
    await none.syncLinter();
});

test('a changed card is linted with the card-breaking rules off',
     async () => {
    const { view, app, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n', { 'G-aaaaa': 'A' });
    const seen = [];
    const linter = {
        settings: { ruleConfigs: {
            'file-name-heading': { enabled: true },
            'capitalize-headings': { enabled: true },
            'emphasis-style': { enabled: true } }, foldersToIgnore: [] },
        async runLinterFile(f) {
            seen.push({ path: f.path, rules: this.settings.ruleConfigs });
            await app.vault.modify(f, app.vault.text.get(f.path)
                .replace(/_(\w+)_/g, '*$1*'));
        },
    };
    app.plugins = { plugins: { 'obsidian-linter': linter } };
    view.plugin = Object.assign(Object.create(
        require('../src/main.js').prototype), { app,
        settings: Object.assign({}, view.plugin.settings,
                                { lintCards: true }) });
    await view.startEdit('G-aaaaa');
    await view.endEdit();
    assert.equal(seen.length, 0, 'an unchanged card is not linted');
    await view.startEdit('G-aaaaa');
    type(view, 'An _emphasised_ word');
    await view.endEdit();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].rules['file-name-heading'].enabled, false);
    assert.equal(seen[0].rules['capitalize-headings'].enabled, false);
    assert.equal(seen[0].rules['emphasis-style'].enabled, true);
    assert.equal(linter.settings.ruleConfigs['file-name-heading'].enabled,
                 true, 'Linter\'s own settings are restored');
    assert.equal(text(cardPath('G-aaaaa')), 'An *emphasised* word');
});

test('undoing a new card removes its note unless text was written',
     async () => {
    const { view, read, app, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n', { 'G-aaaaa': 'A' });
    view.active = 'G-aaaaa';
    await view.insert('child');
    const blank = view.active;
    await view.endEdit();
    await view.doUndo();
    assert.equal(text(cardPath(blank)), undefined, 'empty note removed');
    assert.deepEqual(view.unlinkedCards(), []);
    view.active = 'G-aaaaa';
    await view.insert('child');
    const kept = view.active;
    type(view, 'Some words');
    await view.endEdit();
    // Typed in on this board: undoing the card takes its text with it,
    // and redo brings both back.
    await view.doUndo();
    assert.equal(text(cardPath(kept)), undefined);
    await view.doRedo();
    assert.equal(text(cardPath(kept)), 'Some words', 'text is never lost');
    assert.ok(view.byId.has(kept), 'and the card is back in the tree');
    // Text written into a new card from outside keeps its note.
    const f = app.vault.getAbstractFileByPath(cardPath(kept));
    await app.vault.process(f, () => 'Written in a tab.');
    await view.doUndo();
    assert.equal(text(cardPath(kept)), 'Written in a tab.');
    assert.deepEqual(view.unlinkedCards().map((f) => f.basename), [kept]);
});

test('the orphan panel adds or deletes each unlinked note', async () => {
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'A', 'G-empty': '', 'G-words': 'Lost words' });
    await tick(20);
    const panel = view.contentEl.querySelector('.dendrite-orphans');
    assert.ok(panel, 'the panel floats over the board');
    const labels = [...panel.querySelectorAll('.dendrite-orphan-label')]
        .map((e) => e.textContent).sort();
    assert.deepEqual(labels, ['Lost words', 'empty']);
    const delEmpty = [...panel.querySelectorAll('button')]
        .find((b) => b.textContent === 'Delete 1 empty');
    delEmpty.click();
    await tick(20);
    assert.equal(text(cardPath('G-empty')), undefined);
    assert.equal(text(cardPath('G-words')), 'Lost words');
    const panel2 = view.contentEl.querySelector('.dendrite-orphans');
    [...panel2.querySelectorAll('button')]
        .find((b) => b.textContent === 'Add').click();
    await tick(20);
    assert.match(read(INDEX), /\[\[G-words\|Lost words\]\]/);
    assert.equal(view.contentEl.querySelector('.dendrite-orphans'), null);
});

test('right-click opens the card menu at the pointer, delete included',
     async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    const card = view.cardEls.get('G-bbbbb');
    let centred = 0;
    const orig = view.centre.bind(view);
    view.centre = (...a) => { centred++; orig(...a); };
    card.dispatchEvent(new h.window.MouseEvent('contextmenu',
        { bubbles: true, cancelable: true }));
    await tick(10);
    assert.equal(view.active, 'G-bbbbb', 'the card is selected');
    assert.equal(centred, 0, 'right-click does not move the board');
    assert.ok(card.hasClass('is-active'), 'but the card is highlighted');
    const menu = h.obsidian.lastMenu;
    assert.equal(menu.shown, 'mouse');
    // The roles lead their own submenu, and sections are separated once.
    const t = submenuOf(menu, 'Prints as').titles;
    const first = t.findIndex((x) => /^Prints automatically/.test(x));
    const last = t.indexOf('Left out of the manuscript');
    assert.ok(first === 0 && last > first);
    assert.equal(t[last + 1], '---', 'a separator after them');
    assert.ok(t.slice(first, last + 1).every((x) => x !== '---'));
    for (const list of [t, menu.titles]) {
        assert.ok(!list.some((x, k) => x === '---' && list[k + 1] === '---'),
                  'no doubled separators');
    }
    const del = menu.items.find((i) => /^Delete/.test(i.title));
    assert.ok(del, 'the menu offers delete');
    await del.click();
    await tick(10);
    assert.ok(!view.byId.has('G-bbbbb'));
});

test('a card changing height redraws the flow', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n    - [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    let draws = 0;
    const orig = view.drawFlow.bind(view);
    view.drawFlow = () => { draws++; orig(); };
    globalThis.lastResizer.fire();
    await tick(5);
    assert.equal(draws, 1);
});

test('Obsidian\'s editor: typing saves, Escape leaves, and it is torn down',
     async () => {
    const edmod = require('../src/editor.js');
    let made = null;
    class FakeMarkdownEditor {
        constructor(app, container, owner) {
            this.app = app;
            this.owner = owner;
            this.doc = '';
            this.cbs = [];
            const contentDOM = createDiv();
            container.appendChild(contentDOM);
            const self = this;
            this.editor = {
                cm: { contentDOM, hasFocus: false,
                      state: { doc: { toString: () => self.doc } } },
                focus() {}, setCursor(c) { this.cursor = c; },
                lastLine() { return 0; },
                getLine() { return self.doc; },
            };
            made = this;
        }
        set(v) { this.doc = v; }
        onUpdate() {}
        register(fn) { this.cbs.push(fn); }
        load() { this._loaded = true; }
        unload() {
            this._loaded = false;
            this.onunload();
            this.cbs.forEach((f) => f());
            this.unloaded = true;
        }
        onunload() {}
    }
    const { view, app, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'Start' });
    const scopes = [];
    app.keymap = { pushScope: (s) => scopes.push(s), popScope() {} };
    const original = () => 'leaf';
    app.workspace.setActiveLeaf = original;
    app.embedRegistry = { embedByExtension: { md: () => ({
        showEditor() {}, unload() {},
        editMode: Object.create(Object.create(FakeMarkdownEditor.prototype)),
    }) } };
    edmod.resetForTests();
    try {
        await view.startEdit('G-aaaaa');
        assert.equal(view.editing.editor.kind, 'obsidian');
        assert.equal(made.doc, 'Start', 'the card body is loaded');
        assert.equal(made.owner.file.basename, 'G-aaaaa',
                     'suggestions resolve against the card');
        assert.ok(view.cardEls.get('G-aaaaa').hasClass('has-obsidian-editor'));
        made.editor.cm.contentDOM.dispatchEvent(
            new h.window.Event('focusin'));
        assert.equal(app.workspace.activeEditor, made.owner);
        // Obsidian's window not the focused one: CodeMirror says it has no
        // focus while the card still has it, and a pane is still refused.
        const content = made.editor.cm.contentDOM;
        h.window.document.body.appendChild(view.contentEl);
        content.tabIndex = 0;
        content.focus();
        assert.equal(content.ownerDocument.activeElement, content);
        assert.equal(app.workspace.setActiveLeaf(), undefined,
                     'a pane does not take the focus from the card');
        content.blur();
        assert.equal(app.workspace.setActiveLeaf(), 'leaf',
                     'once the card lets the focus go, a pane takes it');
        made.doc = 'Typed in Obsidian\'s editor';
        made.onUpdate({}, true);
        await tick(60);
        assert.equal(text(cardPath('G-aaaaa')),
                     'Typed in Obsidian\'s editor', 'autosaved');
        const esc = scopes[0].keys.find((k) => k.key === 'Escape');
        esc.fn();
        await tick(20);
        assert.equal(view.editing, null, 'Escape left the card');
        assert.ok(made.unloaded, 'the editor was torn down');
        assert.equal(app.workspace.setActiveLeaf, original,
                     'the focus guard was removed');
    } finally {
        edmod.resetForTests();
        delete app.embedRegistry;
    }
});

test('arrow keys navigate from the pane even when no scope handles them',
     async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|A]]\n    - [[G-bbbbb|B]]\n- [[G-ccccc|C]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B', 'G-ccccc': 'C' });
    view.plugin.settings.vimKeys = false;
    const key = async (k, extra = {}) => {
        view.contentEl.dispatchEvent(new h.window.KeyboardEvent('keydown',
            Object.assign({ key: k, bubbles: true, cancelable: true },
                          extra)));
        await tick(5);
    };
    await key('ArrowDown');
    assert.equal(view.active, 'G-ccccc');
    await key('ArrowUp');
    await key('ArrowRight');
    assert.equal(view.active, 'G-bbbbb');
    await key('ArrowLeft');
    assert.equal(view.active, 'G-aaaaa');
    await key('Enter');
    assert.equal(view.editing.id, 'G-aaaaa', 'Enter edits');
    await key('ArrowDown');
    assert.equal(view.active, 'G-aaaaa', 'arrows are the text\'s in edit mode');
    await view.endEdit();
    await key('ArrowDown', { altKey: true });
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-ccccc', 'G-aaaaa'], 'Alt+Down moves the card');
    await key('j');
    assert.equal(view.active, 'G-aaaaa', 'vim keys off: letters do nothing');
});

test('moving a selection to a new card below or a child, and undoing it',
     async () => {
    const { view, app, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-zzzzz|Z]]\n',
        { 'G-aaaaa': 'Keep this.\n\nMove this.\n\nAnd keep this.',
          'G-zzzzz': 'Z' });
    await view.startEdit('G-aaaaa');
    view.editing.ta.setSelectionRange(12, 22);
    await view.moveSelection('below');
    assert.equal(text(cardPath('G-aaaaa')), 'Keep this.\n\nAnd keep this.');
    const ids = view.root.children.map((n) => n.id);
    assert.equal(ids.length, 3);
    const moved = ids[1];
    assert.equal(text(cardPath(moved)), 'Move this.');
    assert.match(read(INDEX), new RegExp(
        '- \\[\\[G-aaaaa\\|[^\\]]*\\]\\]\\n' +
        `- \\[\\[${moved}\\|Move this.\\]\\]`));
    assert.equal(view.editing.id, 'G-aaaaa', 'still editing the original');
    // A bare cursor moves the rest of the card, into a child.
    view.editing.ta.setSelectionRange(12, 12);
    await view.moveSelection('child');
    assert.equal(read(cardPath('G-aaaaa')),
                 '---\ndendrite_status: unsplit\n---\nKeep this.',
                 'text left behind after a split into a child: unsplit');
    const child = view.byId.get('G-aaaaa').children[0];
    assert.equal(text(cardPath(child.id)), 'And keep this.');
    await view.endEdit();
    await view.doUndo();
    assert.equal(text(cardPath('G-aaaaa')), 'Keep this.\n\nAnd keep this.');
    assert.equal(text(cardPath(child.id)), undefined, 'new card removed');
    // Typing in the moved card is undone inside it.
    await view.startEdit(moved);
    type(view, 'Move this, revised.');
    await view.endEdit();
    await view.startEdit(moved);
    view.undoInEditor();
    await view.endEdit();
    assert.equal(text(cardPath(moved)), 'Move this.');
    // Text written into a moved card from outside is never discarded.
    const f = app.vault.getAbstractFileByPath(cardPath(moved));
    await app.vault.process(f, (d) => d.replace('Move this.',
                                                'Edited in a tab.'));
    await view.doUndo();
    assert.equal(text(cardPath('G-aaaaa')),
                 'Keep this.\n\nMove this.\n\nAnd keep this.');
    assert.equal(text(cardPath(moved)), 'Edited in a tab.',
                 'the edited new card is kept');
});

test('merging into the card above or the parent, and undoing it',
     async () => {
    const index = '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|Para A.]]\n- [[G-bbbbb|Para B.]]\n' +
        '    - [[G-ccccc|Para C.]]\n';
    const { view, read, text } = await open(index, {
        'G-aaaaa': 'Para A.', 'G-bbbbb': 'Para B.', 'G-ccccc': 'Para C.' });
    view.active = 'G-bbbbb';
    await view.merge('above');
    assert.equal(text(cardPath('G-aaaaa')), 'Para A.\n\nPara B.');
    assert.equal(text(cardPath('G-bbbbb')), undefined, 'merged note trashed');
    assert.equal(read(INDEX), '---\ndendrite_prefix: G\n---\n' +
                 '- [[G-aaaaa|Para A.]]\n    - [[G-ccccc|Para C.]]\n',
                 'B\'s child follows its text');
    await view.doUndo();
    assert.equal(text(cardPath('G-aaaaa')), 'Para A.');
    assert.equal(text(cardPath('G-bbbbb')), 'Para B.');
    assert.equal(read(INDEX), index);
    view.active = 'G-ccccc';
    await view.merge('parent');
    assert.equal(text(cardPath('G-bbbbb')), 'Para B.\n\nPara C.');
    assert.equal(view.byId.get('G-bbbbb').children.length, 0);
    view.active = 'G-aaaaa';
    await view.merge('above');
    assert.equal(text(cardPath('G-aaaaa')), 'Para A.',
                 'nothing above the first card: unchanged');
});

test('the quota and the active card\'s tools share one footer row',
     async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n', { 'G-aaaaa': 'A' });
    const card = view.cardEls.get('G-aaaaa');
    const foot = card.querySelector(':scope > .dendrite-card-foot');
    assert.ok(foot.querySelector(':scope > .dendrite-quota'), 'quota left');
    assert.ok(foot.querySelector(':scope > .dendrite-toolbar'), 'tools right');
    assert.equal(foot.firstElementChild.className.split(' ')[0],
                 'dendrite-quota');
});

test('the preview prints by role, follows edits, and links to the board',
     async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n' +
        'dendrite_number_sections: true\n---\n' +
        '- [[G-aaaaa|Outline]]\n- [[G-bbbbb|Aims]]\n    - [[G-ccccc|p]]\n');
    const card = (id, text) => app.vault.create(cardPath(id), text);
    await card('G-aaaaa', '---\ndendrite_role: section\n---\n' +
               '# Research outline\nMy notes on what to do.');
    await card('G-bbbbb', '# Aims\nPlanning.');
    await card('G-ccccc', 'The aims prose. %% check %%');
    const focused = [];
    const plugin = { settings: { headingTop: 1 },
                     focusCard: (f, id, edit) => focused.push([id, edit]) };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    await view.setState({ file: INDEX });
    await tick(20);
    const blocks = () => [...view.contentEl.querySelectorAll(
        '.dendrite-pblock')].filter((b) => !b.hasClass('is-empty'));
    const texts = () => blocks().map((b) => b.textContent.trim());
    assert.deepEqual(texts(), ['# 1. Research outline', '# 2. Aims',
                               'The aims prose.'],
                     'headings numbered, notes and comments left out');
    // Show left out: the notes appear, dimmed, in their own element.
    const allBtn = [...view.contentEl.querySelectorAll('.dendrite-seg-btn')]
        .find((b) => b.textContent === 'All');
    allBtn.onclick();
    await tick(20);
    assert.ok(allBtn.hasClass('is-on'));
    assert.ok(!view.contentEl.querySelector('.dendrite-title'),
              'the bar does not repeat the manuscript\'s name');
    const left = [...view.contentEl.querySelectorAll('.dendrite-left-out')]
        .map((e) => e.textContent);
    assert.deepEqual(left, ['My notes on what to do.', 'Planning.', 'check']);
    // An edit to a card reaches the preview.
    await app.vault.modify(app.vault.getAbstractFileByPath(
        cardPath('G-ccccc')), 'Revised aims prose.');
    await view.refresh();
    await tick(20);
    assert.match(texts().join('|'), /Revised aims prose\./);
    // Click selects the card on the board; double-click edits it.
    const b = view.blocks.get('G-bbbbb').el;
    b.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    b.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));
    assert.deepEqual(focused, [['G-bbbbb', false], ['G-bbbbb', true]]);
    // A view 400 px high; C 100 px high, 600 px down.
    const scrolled = [];
    const c = view.blocks.get('G-ccccc').el;
    Object.defineProperty(view.doc, 'clientHeight', { get: () => 400 });
    let down = 600;
    Object.defineProperty(c, 'offsetTop', { get: () => down });
    Object.defineProperty(c, 'offsetHeight', { get: () => 100 });
    view.doc.scrollTo = (o) => scrolled.push(o);
    view.highlight('G-ccccc');
    assert.ok(c.hasClass('is-active'));
    assert.deepEqual(scrolled, [{ top: 450, behavior: 'smooth' }],
                     'the card selected is brought to the middle');
    assert.ok(!b.hasClass('is-active'));
    // Far down, it jumps to a screen short of it and slides the rest, so
    // the parts between are not drawn on the way.
    scrolled.length = 0;
    down = 20000;
    view.doc.scrollTop = 0;
    view.highlight('G-ccccc');
    assert.equal(view.doc.scrollTop, 19850 - 400);
    assert.deepEqual(scrolled, [{ top: 19850, behavior: 'smooth' }]);
});

test('a preview whose parts are never seen scrolling into view draws ' +
     'them while idle, and a failure to draw says so', async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|Aims]]\n    - [[G-bbbbb|p]]\n');
    await app.vault.create(cardPath('G-aaaaa'), '# Aims');
    await app.vault.create(cardPath('G-bbbbb'), 'The prose.');
    const plugin = { settings: { headingTop: 1 }, focusCard() {} };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    // As on the iPad: the observer that draws parts in view never fires.
    view.observer = { observe() {}, unobserve() {}, disconnect() {} };
    h.window.document.body.appendChild(view.contentEl);
    h.notices.length = 0;
    await view.setState({ file: INDEX });
    shown(view.doc);
    const drawn = () => [...view.contentEl.querySelectorAll(
        '.dendrite-pblock:not(.is-pending):not(.is-empty)')]
        .map((b) => b.textContent.trim());
    assert.deepEqual(drawn(), [], 'nothing drawn yet');
    await tick(1700);
    assert.deepEqual(drawn(), ['# Aims', 'The prose.']);
    assert.deepEqual(h.notices, [], 'drawn without a word');
    // A refresh that throws shows its message, once.
    h.notices.length = 0;
    app.vault.cachedRead = async () => { throw new Error('no read'); };
    await view.refresh();
    await view.refresh();
    assert.deepEqual(h.notices,
                     ['Dendrite: the preview could not draw: no read']);
    await view.onClose();
    view.contentEl.remove();
});

test('the preview gathers footnotes under each section or at the end',
     async () => {
    // The harness renders markdown as its text, so this checks where each
    // note goes and its number; Obsidian's own footnote markup, hidden
    // and renumbered in the cards, needs a look in Obsidian.
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|Aims]]\n    - [[G-ddddd|t]]\n' +
        '    - [[G-bbbbb|p]]\n- [[G-ccccc|Plan]]\n');
    const card = (id, text) => app.vault.create(cardPath(id), text);
    await card('G-aaaaa', '# Aims');
    await card('G-ddddd', 'Aims text.^[[@k]]');
    await card('G-bbbbb', 'More.[^1]\n\n[^1]: Second\n    goes on.');
    await card('G-ccccc', '# Plan\nPlan.[^a]\n\n[^a]: Third.');
    const plugin = { settings: { headingTop: 1 }, focusCard() {} };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    await view.setState({ file: INDEX });
    await tick(20);
    const notes = () => [...view.contentEl.querySelectorAll(
        '.dendrite-pnotes')].map((b) => b.textContent.split('\n\n')[1]
        .replace(/\n+$/, ''));
    assert.deepEqual(notes(), ['[^1]: [@k]\n[^2]: Second\n    goes on.',
                               '[^3]: Third.'],
                     'by default, under each top-level section');
    assert.match(view.blocks.get('G-ddddd').el.textContent,
                 /^Aims text\.\[\^1\]/, 'an inline note is numbered');
    assert.ok(view.blocks.get('G-ddddd').el.hasClass('is-notes-gathered'));
    const notesAt = async (label) => {
        [...view.contentEl.querySelectorAll('.dendrite-bar-btn')]
            .find((b) => b.textContent === 'Footnotes').onclick();
        await h.obsidian.lastMenu.items.find((i) => i.title === label)
            .click();
        await tick(20);
    };
    await notesAt('Footnotes collected at the end');
    assert.deepEqual(notes(), ['[^1]: [@k]\n[^2]: Second\n    goes on.\n' +
                               '[^3]: Third.']);
    assert.equal(view.getState().notesAt, 'end');
    await notesAt('Footnotes under each card');
    assert.deepEqual(notes(), [], 'under each card: nothing gathered');
    const b = view.blocks.get('G-ddddd').el;
    assert.equal(b.textContent.trim(), 'Aims text.[^1]\n\n[^1]: [@k]',
                 'under each card, an inline note has its number too');
    assert.ok(!b.hasClass('is-notes-gathered'));
});

test('card status: chips, tally, keys, and status moving with text',
     async () => {
    const { view, read, app, text } = await open(
        '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|Aims]]\n    - [[G-bbbbb|p1]]\n    - [[G-ccccc|p2]]\n' +
        '- [[G-ddddd|D]]\n',
        { 'G-aaaaa': '# Aims',
          'G-bbbbb': '---\ndendrite_status: done\n---\nFirst para.',
          'G-ccccc': '---\ndendrite_status: revise\n---\nSecond para.',
          'G-ddddd': 'Para D. More of D.' });
    const chips = (id) => [...view.cardEls.get(id)
        .querySelectorAll('.dendrite-status-chip')].map((c) => c.textContent);
    assert.deepEqual(chips('G-bbbbb'), ['done ✓']);
    // At the top right beside the role icon, not in the footer.
    const done = view.cardEls.get('G-bbbbb');
    assert.ok(done.querySelector(':scope > .dendrite-status'));
    assert.ok(!done.querySelector('.dendrite-card-foot .dendrite-status'));
    assert.deepEqual(chips('G-ccccc'), ['revise ⚑']);
    assert.deepEqual(chips('G-aaaaa'), ['1 to revise ⚑'],
                     'a section counts what is flagged below it');
    assert.deepEqual(chips('G-ddddd'), [], 'draft shows nothing');
    assert.equal(view.statusEl.textContent, '1 revise · 1 draft · 1 done');
    // ] goes to the next flagged card in reading order; - and + set
    // revise and done.
    const key = async (k) => {
        view.contentEl.dispatchEvent(new h.window.KeyboardEvent('keydown',
            { key: k, bubbles: true, cancelable: true }));
        await tick(10);
    };
    view.active = 'G-aaaaa';
    await key(']');
    assert.equal(view.active, 'G-ccccc');
    await key('+');
    assert.match(read(cardPath('G-ccccc')), /dendrite_status: done/);
    view.active = 'G-ddddd';
    await key('-');
    assert.match(read(cardPath('G-ddddd')), /dendrite_status: revise/);

    // Moving text into a child: the child takes the status; the parent,
    // now structural, is unsplit while text is left behind.
    await view.startEdit('G-ddddd');
    view.editing.ta.setSelectionRange(8, 8);
    await view.moveSelection('child');
    const child = view.byId.get('G-ddddd').children[0].id;
    assert.match(read(cardPath(child)), /dendrite_status: revise/);
    assert.match(read(cardPath('G-ddddd')), /dendrite_status: unsplit/);
    // Finishing the split clears unsplit on its own.
    view.editing.ta.setSelectionRange(0, 0);
    await view.moveSelection('below');
    await view.endEdit();
    await view.clearFinishedSplit(view.cardFile('G-ddddd'));
    assert.doesNotMatch(read(cardPath('G-ddddd')), /dendrite_status/);

    // A done card that gains its first child stops printing and loses
    // its status.
    view.active = 'G-bbbbb';
    await view.insert('child');
    await view.endEdit();
    assert.doesNotMatch(read(cardPath('G-bbbbb')), /dendrite_status/);

    // Pretty Properties' colour for a value is used.
    const plugin = Object.create(require('../src/main.js').prototype);
    plugin.app = { plugins: { plugins: { 'pretty-properties': { settings: {
        propertyColors: { dendrite_status: {
            done: { pillColor: 'green' },
            revise: { pillColor: { h: 10, s: 80, l: 50 } } } } } } } } };
    assert.equal(plugin.statusColour('done'), 'var(--color-green)');
    assert.equal(plugin.statusColour('revise'), 'hsl(10, 80%, 50%)');
    assert.equal(plugin.statusColour('draft'), null);
    // None set: no colour, so a flag is drawn in the neutral default
    // rather than in what could be taken for a reviewer's colour.
    plugin.app = { plugins: { plugins: {} } };
    assert.equal(plugin.statusColour('unsplit'), null);
    assert.equal(plugin.statusColour('revise'), null);
});

test('merging keeps the less mature status', async () => {
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': '---\ndendrite_status: done\n---\nA.',
          'G-bbbbb': '---\ndendrite_status: revise\n---\nB.' });
    view.active = 'G-bbbbb';
    await view.merge('above');
    assert.match(read(cardPath('G-aaaaa')),
                 /dendrite_status: revise\n---\nA\.\n\nB\./);
    await view.doUndo();
    assert.match(read(cardPath('G-aaaaa')), /dendrite_status: done\n---\nA\./,
                 'undo restores the status too');
});

test('settings are grouped under headings by what they affect', () => {
    const { DendriteSettings } = require('../src/main.js');
    h.obsidian.settingsLog = [];
    const tab = new DendriteSettings(SETTINGS_APP, {
        settings: { writingFolder: 'Writing', headingTop: 1, cardWidth: 380,
                    autosaveMs: 600, openInDendrite: true, vimKeys: true,
                    manageLinter: true, lintCards: true,
                    obsidianEditor: true },
        saveSettings() {}, rerender() {}, googleToken: () => null,
        googleClient: () => null });
    tab.display();
    const out = h.obsidian.settingsLog.map((s) =>
        (s.heading ? '## ' : '') + s.name);
    assert.deepEqual(out, [
        '## Manuscripts', 'Writing folder', 'Open index notes in Dendrite',
        'Index note type', 'Card type', 'Top section heading level',
        '## Board', 'Card width', 'Vim-style keys',
        '## Writing in cards', 'Use Obsidian\'s editor in cards',
        'Typewriter scrolling', 'Autosave delay',
        '## PDF and Word export', 'Pandoc', 'PDF engine', 'Zotero port',
        'Fallback .bib',
        '## Review', 'Your name, on replies',
        'Accept reviews from programs on this computer',
        'Review port',
        '## Google Docs', 'Google OAuth client', 'Google Picker API key',
        'Google account',
        '## Other plugins', 'Keep Linter out of the writing folder',
        'Clean up cards with Linter',
        '## Diagnostics', 'Record timings', 'Say what moves the board',
    ]);
});

test('every printing card holds its status; structural cards hold none',
     async () => {
    const { view, read } = await open(
        '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|S]]\n    - [[G-bbbbb|p]]\n- [[G-ccccc|N]]\n',
        { 'G-aaaaa': '---\ndendrite_status: done\n---\n# S',
          'G-bbbbb': 'Prose.',
          'G-ccccc': '---\ndendrite_role: notes\n---\nNotes.' });
    await tick(20);
    assert.equal(read(cardPath('G-bbbbb')), 'Prose.',
                 'opening writes nothing');
    assert.equal(view.statusInfo.get('G-bbbbb').own, 'draft',
                 'shown as draft meanwhile');
    // A change made here backfills, and a new card is written with
    // draft.
    view.active = 'G-bbbbb';
    await view.insert('below');
    const fresh = view.active;
    await view.endEdit();
    assert.match(read(cardPath(fresh)), /dendrite_status: draft/);
    assert.match(read(cardPath('G-bbbbb')), /dendrite_status: draft/,
                 'backfilled at the first change made here');
    assert.doesNotMatch(read(cardPath('G-aaaaa')), /dendrite_status/,
                        'a section holds no status');
    assert.doesNotMatch(read(cardPath('G-ccccc')), /dendrite_status/,
                        'a left-out card holds no status');
});

test('dragging a card drops it above, below or into another, with undo',
     async () => {
    const index = '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|A]]\n    - [[G-bbbbb|B]]\n- [[G-ccccc|C]]\n';
    const { view, read } = await open(index,
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B', 'G-ccccc': 'C' });
    const ids = () => read(INDEX).replace(/^---[\s\S]*?---\n/, '');
    // Where the pointer is over is decided by dropTargetAt; the browser's
    // hit-testing is not available here, so it is fixed per step.
    let over = null;
    view.dropTargetAt = () => over;
    const ev = (type, x, y, extra = {}) => new h.window.MouseEvent(type,
        Object.assign({ bubbles: true, cancelable: true, button: 0,
                        clientX: x, clientY: y }, extra));
    const grip = (id) => view.cardEls.get(id)
        .querySelector('.dendrite-grip');
    const drag = async (id, target) => {
        grip(id).dispatchEvent(ev('pointerdown', 0, 0));
        over = target;
        h.window.dispatchEvent(ev('pointermove', 30, 30));
        h.window.dispatchEvent(ev('pointerup', 30, 30));
        await tick(10);
    };
    // A press that does not move is a click, not a drag.
    grip('G-ccccc').dispatchEvent(ev('pointerdown', 0, 0));
    h.window.dispatchEvent(ev('pointerup', 2, 2));
    await tick(5);
    assert.equal(ids(), index.replace(/^---[\s\S]*?---\n/, ''));
    // The selected card's text selects text; only its handle drags.
    await view.select('G-ccccc');
    over = { id: 'G-aaaaa', where: 'above' };
    const body = (id) => view.cardEls.get(id)
        .querySelector('.dendrite-card-body');
    body('G-ccccc').dispatchEvent(ev('pointerdown', 0, 0));
    h.window.dispatchEvent(ev('pointermove', 30, 30));
    h.window.dispatchEvent(ev('pointerup', 30, 30));
    await tick(5);
    assert.equal(ids(), index.replace(/^---[\s\S]*?---\n/, ''),
                 'a press on the selected card\'s text does not drag');
    // Any other card drags from anywhere on it.
    await view.select('G-aaaaa');
    over = { id: 'G-aaaaa', where: 'above' };
    body('G-ccccc').dispatchEvent(ev('pointerdown', 0, 0));
    h.window.dispatchEvent(ev('pointermove', 30, 30));
    h.window.dispatchEvent(ev('pointerup', 30, 30));
    await tick(10);
    assert.equal(ids(), '- [[G-ccccc|C]]\n- [[G-aaaaa|A]]\n' +
                 '    - [[G-bbbbb|B]]\n',
                 'an unselected card drags by its body');
    await view.doUndo();

    await drag('G-ccccc', { id: 'G-aaaaa', where: 'above' });
    assert.equal(ids(), '- [[G-ccccc|C]]\n- [[G-aaaaa|A]]\n' +
                 '    - [[G-bbbbb|B]]\n');
    await drag('G-ccccc', { id: 'G-bbbbb', where: 'child' });
    assert.equal(ids(), '- [[G-aaaaa|A]]\n    - [[G-bbbbb|B]]\n' +
                 '        - [[G-ccccc|C]]\n', 'dropped into B');
    await drag('G-aaaaa', { id: 'G-ccccc', where: 'below' });
    assert.match(ids(), /^- \[\[G-aaaaa/, 'not into its own branch');
    await view.doUndo();
    assert.equal(ids(), '- [[G-ccccc|C]]\n- [[G-aaaaa|A]]\n' +
                 '    - [[G-bbbbb|B]]\n', 'undo reverses one drop');
    assert.equal(document.querySelector('.dendrite-ghost'), null,
                 'no label left behind');
});

test('PDF export from the board uses the manuscript\'s citation style',
     async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\ndendrite_csl: styles/apa.csl\n' +
        'dendrite_font: Arial\ndendrite_font_size: 10pt\n' +
        'dendrite_margin: 2\ndendrite_reference_docx: styles/ref.docx\n' +
        '---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'As shown [@smith2020].' });
    view.app.vault.adapter = { getBasePath: () => '/vault' };
    const runs = [];
    const shown = [];
    view.plugin.settings.pandocPath = 'pandoc';
    view.plugin.pandocDeps = () => ({
        tmpdir: () => '/tmp', join: (...a) => a.join('/'),
        writeFile: async () => {}, remove: () => {},
        run: async (cmd, args) => { runs.push(args); },
        fetch: async () => ({ json: async () => (
            { result: '[{"id":"smith2020"}]' }) }),
    });
    view.plugin.showExport = async (rel, full, fmt) =>
        shown.push([rel, fmt]);
    await view.exportTo(null, 'pdf');
    const args = runs[0];
    assert.ok(args.includes('/vault/W/Grant/exports/Grant.pdf'),
              'written beside the index, in the vault');
    assert.equal(args[args.indexOf('--csl') + 1], '/vault/styles/apa.csl');
    assert.deepEqual(shown, [['W/Grant/exports/Grant.pdf', 'pdf']]);
    // The index's style: Arial 10pt, a bare margin in cm.
    for (const v of ['mainfont=Arial', 'fontsize=10pt',
                     'geometry:margin=2cm']) {
        assert.ok(args.includes(v), v);
    }
    await view.exportTo(null, 'docx');
    assert.ok(runs[1].includes('--reference-doc=/vault/styles/ref.docx'),
              'Word takes its styles from the reference, in the vault');
});

test('a PDF of the whole manuscript measures its words per page, which ' +
     'page estimates then use', async () => {
    const { deflateSync, inflateSync } = await import('node:zlib');
    const words = Array.from({ length: 700 }, () => 'word').join(' ');
    const { view, read } = await open(
        '---\ndendrite_prefix: G\ndendrite_words_per_page: 500\n---\n' +
        '- [[G-aaaaa|A]]\n', { 'G-aaaaa': words });
    view.app.vault.adapter = { getBasePath: () => '/vault' };
    // Four pages, the body ending on the third.
    const pdf = Buffer.concat([Buffer.from('stream\n'), deflateSync(
        Buffer.from('<< /Type /Page >>\n'.repeat(4) +
                    '<< /DendriteBodyEnd (3) >>')),
        Buffer.from('\nendstream\n')]);
    let input = '';
    view.plugin.pandocDeps = () => ({
        tmpdir: () => '/tmp', join: (...a) => a.join('/'),
        writeFile: async (f, t) => { input = t; }, remove: () => {},
        run: async () => {}, readFile: async () => pdf,
        inflate: inflateSync,
    });
    view.plugin.showExport = async () => {};
    await view.exportTo(view.byId.get('G-aaaaa'), 'pdf');
    assert.doesNotMatch(read(INDEX), /measured/, 'a branch measures nothing');
    await view.exportTo(null, 'pdf');
    assert.match(input, /DendriteBodyEnd/);
    assert.match(read(INDEX), /dendrite_measured_words_per_page: 280/,
                 '700 words over 2.5 pages');
    await tick(10);
    assert.equal(view.manuscript().wordsPerPage, 280,
                 'the measured rate wins over the one set by hand');
});

test('the preview opens beside the board at a third of the width',
     async () => {
    const Plugin = require('../src/main.js');
    const dims = [];
    const item = (name, parent) => ({ name, parent,
        setDimension: (d) => dims.push([name, Math.round(d)]) });
    const split = { direction: 'vertical', children: [] };
    const boardTabs = item('board', split);
    const newTabs = item('preview', split);
    split.children.push(boardTabs, newTabs);
    const state = [];
    const leaf = { parent: newTabs,
                   setViewState: async (v) => state.push(v.type) };
    const self = { app: { workspace: { getLeaf: () => leaf } },
                   previewLeaf: () => null };
    await Plugin.prototype.openPreview.call(self, new h.TFile('W/G.md'));
    assert.deepEqual(state, ['dendrite-preview']);
    assert.deepEqual(dims, [['preview', 33], ['board', 67]]);
});

test('an exported PDF opens beside the preview, or in the tab already ' +
     'showing an export, never by splitting the board', async () => {
    const Plugin = require('../src/main.js');
    const tfile = (path) => new h.TFile(path);
    const made = [];
    const shown = [];
    const leaf = (type, file, parent) => ({ type, parent,
        view: { file }, openFile: async (f) => { shown.push(f.path); } });
    const group = { children: [] };
    const preview = leaf('dendrite-preview', tfile('W/Grant/Grant.md'),
                         group);
    group.children.push(leaf('markdown', null, group), preview);
    const leaves = { 'dendrite-preview': [preview], pdf: [] };
    const files = new Map();
    const ws = {
        getLeavesOfType: (t) => leaves[t] || [],
        createLeafInParent: (parent, at) => {
            const l = leaf('pdf', null, parent);
            made.push(['tab', parent === group, at]);
            return l;
        },
        getLeaf: (how) => { made.push(['split', how]); return leaf('pdf'); },
        revealLeaf: async () => {},
    };
    const self = { app: { workspace: ws, vault: {
        getAbstractFileByPath: (p) => files.get(p) } } };
    self.exportLeaf = Plugin.prototype.exportLeaf;
    files.set('W/Grant/exports/Grant.pdf',
              tfile('W/Grant/exports/Grant.pdf'));
    await Plugin.prototype.showExport.call(self,
        'W/Grant/exports/Grant.pdf', '/v/x.pdf', 'pdf');
    assert.deepEqual(made, [['tab', true, 2]], 'a new tab after the preview');
    // A branch export later reuses the tab showing the first.
    const tab = { type: 'pdf', parent: group,
        view: { file: files.get('W/Grant/exports/Grant.pdf') },
        openFile: async (f) => { shown.push('reused ' + f.path); } };
    leaves.pdf.push(tab);
    files.set('W/Grant/exports/Grant - Aims.pdf',
              tfile('W/Grant/exports/Grant - Aims.pdf'));
    await Plugin.prototype.showExport.call(self,
        'W/Grant/exports/Grant - Aims.pdf', '/v/y.pdf', 'pdf');
    assert.equal(made.length, 1, 'no new tab, no split');
    assert.equal(shown[shown.length - 1],
                 'reused W/Grant/exports/Grant - Aims.pdf');
    // With no preview open, a split, as before.
    leaves.pdf = [];
    leaves['dendrite-preview'] = [];
    await Plugin.prototype.showExport.call(self,
        'W/Grant/exports/Grant.pdf', '/v/x.pdf', 'pdf');
    assert.deepEqual(made[1], ['split', 'split']);
});

test('the index and every card get their type, kept beside existing ones',
     async () => {
    const { view, read } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': '---\ntype:\n  - "[[journal article]]"\n---\nA' });
    view.plugin.settings.indexType = '[[dendrite index]]';
    view.plugin.settings.cardType = 'dendrite card';
    const before = read(INDEX);
    await view.reload();
    assert.equal(read(INDEX), before, 'opening adds nothing');
    await view.sweepTypes();
    assert.match(read(INDEX), /type:\n  - "\[\[dendrite index\]\]"/);
    assert.match(read(cardPath('G-aaaaa')),
                 /type:\n  - "\[\[journal article\]\]"\n  - dendrite card/,
                 'an existing type is kept');
    view.active = 'G-aaaaa';
    await view.insert('below');
    const fresh = view.active;
    await view.endEdit();
    assert.match(read(cardPath(fresh)), /type:\n  - dendrite card/);
    await view.sweepTypes();
    assert.equal((read(INDEX).match(/dendrite index/g) || []).length, 1,
                 'added once, never twice');
});

test('a wheel scroll moves the column and redraws the flow at once',
     async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n    - [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    const col = view.board.querySelectorAll('.dendrite-col')[1];
    const inner = view.colInners[1];
    Object.defineProperty(inner, 'scrollHeight', { value: 1000 });
    Object.defineProperty(col, 'clientHeight', { value: 300 });
    let draws = 0;
    const orig = view.drawFlow.bind(view);
    view.drawFlow = () => { draws++; orig(); };
    const card = view.cardEls.get('G-bbbbb');
    card.dispatchEvent(new h.window.WheelEvent('wheel',
        { bubbles: true, cancelable: true, deltaY: 120 }));
    assert.equal(inner.style.transform, 'translateY(-120px)');
    assert.equal(draws, 1, 'redrawn in the same call, not a frame later');
    card.dispatchEvent(new h.window.WheelEvent('wheel',
        { bubbles: true, cancelable: true, deltaY: 5000 }));
    assert.equal(inner.style.transform, 'translateY(-700px)',
                 'clamped to the column\'s content');
    card.dispatchEvent(new h.window.WheelEvent('wheel',
        { bubbles: true, cancelable: true, deltaX: 200, deltaY: 10 }));
    assert.equal(inner.style.transform, 'translateY(-700px)',
                 'a sideways scroll is left to the board');
});

test('a sync rewriting the index unchanged leaves the board and the ' +
     'editor alone', async () => {
    const { app, view, read } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A\n', 'G-bbbbb': 'B\n' });
    h.window.document.body.appendChild(view.contentEl);
    await view.startEdit('G-aaaaa');
    const ta = view.editing.ta;
    assert.equal(h.window.document.activeElement, ta);
    const board = view.board;
    // LiveSync writes the same text back after Dendrite's own write
    // event has already been consumed.
    const f = app.vault.getAbstractFileByPath(INDEX);
    await app.vault.modify(f, read(INDEX));
    await tick(400);
    assert.equal(view.board, board, 'the board was not rebuilt');
    assert.equal(h.window.document.activeElement, ta,
                 'the card being written keeps the focus');
    view.contentEl.remove();
});

test('an outside change to the index while a card is written keeps ' +
     'the editor focused at its cursor', async () => {
    const { app, view, read } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'Some text\n', 'G-bbbbb': 'B\n' });
    h.window.document.body.appendChild(view.contentEl);
    await view.startEdit('G-aaaaa');
    const ta = view.editing.ta;
    ta.setSelectionRange(2, 4);
    const f = app.vault.getAbstractFileByPath(INDEX);
    await app.vault.modify(f, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-bbbbb|B]]\n- [[G-aaaaa|A]]\n');
    await tick(400);
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-bbbbb', 'G-aaaaa'], 'the change was loaded');
    assert.equal(view.editing && view.editing.ta, ta, 'still editing');
    assert.equal(h.window.document.activeElement, ta,
                 'the card being written keeps the focus');
    assert.deepEqual([ta.selectionStart, ta.selectionEnd], [2, 4]);
    view.contentEl.remove();
});

test('a scaffolding card is marked on the board and its children print',
     async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|Why]]\n' +
        '    - [[G-bbbbb|Burden]]\n',
        { 'G-aaaaa': '---\ndendrite_role: scaffolding\n---\n' +
              '# Why is this research important?\n',
          'G-bbbbb': '# Clinical burden\nProse.\n' });
    const card = view.cardEls.get('G-aaaaa');
    assert.ok(card.hasClass('is-scaffolding'));
    assert.ok(!card.hasClass('is-left-out'));
    assert.ok(!view.cardEls.get('G-bbbbb').hasClass('is-left-out'));
});

test('in a popout window, the quota box, its editor and dragging use that ' +
     'window', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': '---\ndendrite_limit: 8 words\n---\n# A\nplan',
          'G-bbbbb': 'B' });
    const pop = h.makePopout();
    // Obsidian moves a leaf's elements into the popout's document.
    pop.document.body.appendChild(pop.document.adoptNode(view.contentEl));
    await view.updateCounts();
    const q = view.cardEls.get('G-aaaaa').querySelector('.dendrite-quota');
    q.dispatchEvent(new pop.MouseEvent('mouseenter'));
    assert.ok(pop.document.querySelector('.dendrite-quota-tip'),
              'the hover box is in the popout');
    assert.equal(document.querySelector('.dendrite-quota-tip'), null,
                 'and not in the main window');
    q.dispatchEvent(new pop.MouseEvent('click', { bubbles: true }));
    assert.ok(pop.document.querySelector('.dendrite-quota-pop'),
              'the quick editor opens in the popout');
    view.closeQuotaEditor();
    // A drag is followed in the popout's own window.
    let over = { id: 'G-aaaaa', where: 'above' };
    view.dropTargetAt = () => over;
    const ev = (type, x, y) => new pop.MouseEvent(type, { bubbles: true,
        cancelable: true, button: 0, clientX: x, clientY: y });
    view.cardEls.get('G-bbbbb').querySelector('.dendrite-grip')
        .dispatchEvent(ev('pointerdown', 0, 0));
    pop.dispatchEvent(ev('pointermove', 30, 30));
    assert.ok(pop.document.querySelector('.dendrite-ghost'),
              'the drag label is in the popout');
    pop.dispatchEvent(ev('pointerup', 30, 30));
    await tick(10);
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-bbbbb', 'G-aaaaa'], 'the drop landed');
});

test('in a popout window, a smooth scroll reaches its target in time',
     async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    const pop = h.makePopout();
    pop.document.body.appendChild(pop.document.adoptNode(view.contentEl));
    // The board has no layout here, so offsets are recorded, not clamped.
    const set = [];
    view.setColOffset = (d, y) => { view.offsets[d] = y; set.push(y); };
    view.offsets = [200];
    view.animateOffsets([100], true);
    await tick(400);
    assert.equal(view.anim, null, 'the animation finished');
    assert.equal(view.offsets[0], 100, 'at its target');
    assert.ok(set.every((y) => y >= 100 && y <= 200),
              'never past either end: ' + set.join(','));
});

test('each card shows what it prints top right, and a click there ' +
     'changes it', async () => {
    const { view, app } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
        '    - [[G-bbbbb|B]]\n- [[G-ccccc|C]]\n    - [[G-ddddd|D]]\n' +
        '- [[G-eeeee|E]]\n',
        { 'G-aaaaa': '# A', 'G-bbbbb': 'B',
          'G-ccccc': '---\ndendrite_role: notes\n---\nC',
          'G-ddddd': 'D',
          'G-eeeee': '---\ndendrite_role: scaffolding\n---\nE' });
    const badge = (id) => view.cardEls.get(id)
        .querySelector('.dendrite-grip');
    const shown = (id) => [badge(id).dataset.role,
                           badge(id).hasClass('is-auto')];
    assert.deepEqual(shown('G-aaaaa'), ['section', true],
                     'a card with children: heading only, automatic');
    assert.deepEqual(shown('G-bbbbb'), ['prose', true]);
    assert.deepEqual(shown('G-ccccc'), ['notes', false], 'set by hand');
    assert.deepEqual(shown('G-ddddd'), ['notes', true],
                     'inside a left-out branch');
    assert.deepEqual(shown('G-eeeee'), ['scaffolding', false]);
    // A click on it, without a drag, offers the roles.
    badge('G-bbbbb').dispatchEvent(new h.window.MouseEvent('click',
        { bubbles: true, cancelable: true }));
    await tick(10);
    assert.equal(view.active, 'G-bbbbb');
    const menu = h.obsidian.lastMenu;
    const item = menu.items.find((i) => /^Scaffolding/.test(i.title));
    assert.ok(item, 'the role menu is open');
    assert.ok(!menu.titles.some((t) => /^Delete/.test(t)),
              'it holds the roles only');
    await item.click();
    await tick(10);
    const f = app.vault.getAbstractFileByPath('W/Grant/cards/G-bbbbb.md');
    assert.match(app.vault.text.get(f.path), /dendrite_role: scaffolding/);
    assert.deepEqual(shown('G-bbbbb'), ['scaffolding', false]);
});

test('a card split from one whose role was set takes that role', async () => {
    const { view, read } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|Why]]\n' +
        '- [[G-bbbbb|Note]]\n',
        { 'G-aaaaa': '---\ndendrite_role: scaffolding\n---\n' +
              'Why it matters.\n\nWho it helps.',
          'G-bbbbb': '---\ndendrite_role: section\n---\n# Note\nPlan.' });
    await view.startEdit('G-aaaaa');
    view.editing.ta.setSelectionRange(17, 17);
    await view.moveSelection('below');
    const made = view.root.children[1].id;
    const props = (id) => /^---\n([\s\S]*?)\n---/.exec(
        read(cardPath(id)))[1];
    assert.match(props(made), /dendrite_role: scaffolding/);
    assert.doesNotMatch(props(made), /dendrite_status/,
                        'a card that prints nothing has no status');
    await view.endEdit();
    // Heading only describes the card's own heading line, which the
    // moved text does not carry: the new card follows the tree.
    await view.startEdit('G-bbbbb');
    view.editing.ta.setSelectionRange(7, 7);
    await view.moveSelection('below');
    const next = view.root.children[3].id;
    assert.doesNotMatch(props(next), /dendrite_role/);
    assert.match(props(next), /dendrite_status: draft/);
});

test('find fades cards without a match, counts each branch, steps ' +
     'through matches and edits at one', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|Aims]]\n' +
        '    - [[G-bbbbb|B]]\n- [[G-ccccc|C]]\n- [[G-ddddd|D]]\n',
        { 'G-aaaaa': '# Aims', 'G-bbbbb': 'TET2 drives clonal growth.',
          'G-ccccc': 'Clonal only.',
          'G-ddddd': 'Clonal and TET2. %% TET2 again %%' });
    // `/` opens it in vim mode, as Ctrl+F does.
    view.contentEl.dispatchEvent(new h.window.KeyboardEvent('keydown',
        { key: '/', bubbles: true, cancelable: true }));
    const f = view.find;
    assert.ok(f && view.contentEl.contains(f.input),
              'the find bar is open');
    const search = async (q) => {
        f.input.value = q;
        f.input.dispatchEvent(new h.window.Event('input'));
        await tick(150);
    };
    // jsdom has no highlight registry; a stand-in records the ranges.
    h.window.CSS = { highlights: new Map() };
    h.window.Highlight = class { constructor(...r) { this.ranges = r; } };
    await search('tet2 clonal');
    assert.equal(f.countEl.textContent, '1 of 5 in 2 cards, 1 in comments');
    const lit = (name) => (h.window.CSS.highlights.get(name) ||
        { ranges: [] }).ranges.map((r) => r.toString());
    assert.deepEqual(lit('dendrite-find-current'), ['TET2'],
                     'the current match is painted');
    assert.ok(lit('dendrite-find').includes('clonal'));
    const card = (id) => view.cardEls.get(id);
    assert.ok(view.board.hasClass('is-finding'));
    assert.ok(card('G-bbbbb').hasClass('is-match'));
    assert.ok(!card('G-ccccc').hasClass('is-match'), 'C lacks TET2');
    assert.equal(card('G-aaaaa').querySelector('.dendrite-find-below')
        .textContent, '2 below');
    assert.equal(view.active, 'G-bbbbb', 'went to the first match');
    await view.findStep(1);
    await view.findStep(1);
    assert.equal(view.active, 'G-ddddd');
    assert.equal(f.countEl.textContent,
                 '3 of 5 in 2 cards, 1 in comments');
    await view.findStep(-1);
    await view.findStep(-1);
    await view.findStep(-1);
    assert.equal(f.index, 4, 'stepping back from the first wraps round');
    // Editing at a match selects it in the card.
    await view.findStep(-1);
    await view.editAtMatch();
    assert.equal(view.editing.id, 'G-ddddd');
    const ta = view.editing.ta;
    assert.equal(ta.value.slice(ta.selectionStart, ta.selectionEnd), 'TET2');
    // Options: match case, regex, and a bad pattern.
    await view.endEdit();
    f.matchCase = true;
    await search('Clonal');
    assert.equal(f.countEl.textContent, '2 of 2 in 2 cards',
                 'from the selected card, D, onwards');
    f.matchCase = false;
    f.regex = true;
    await search('TET\\d (drives|and)');
    assert.equal(f.countEl.textContent, '1 of 1 in 1 card');
    await search('(');
    assert.equal(f.countEl.textContent, 'Not a valid pattern');
    assert.ok(!view.board.hasClass('is-finding'));
    view.closeFind();
    assert.equal(view.find, null);
    assert.equal(h.window.CSS.highlights.size, 0, 'highlights cleared');
    delete h.window.CSS;
    delete h.window.Highlight;
    assert.ok(!view.contentEl.contains(f.el), 'the bar is gone');
    assert.ok(!card('G-bbbbb').hasClass('is-match'));
    assert.equal(view.contentEl.querySelector('.dendrite-find-below'), null);
});

test('Ctrl+Z in a new card still empty undoes making it', async () => {
    const { view, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n', { 'G-aaaaa': 'A' });
    view.active = 'G-aaaaa';
    const undo = view.scope.keys.find((k) => k.mods.includes('Mod') &&
                                     k.key === 'z').fn;
    await view.insert('below');
    const blank = view.active;
    assert.equal(view.editing.id, blank);
    assert.equal(undo(), false, 'handled here, not by the text');
    await tick(20);
    assert.equal(view.editing, null);
    assert.equal(view.byId.has(blank), false, 'the card is gone');
    assert.equal(text(cardPath(blank)), undefined, 'and its note');
    assert.equal(view.active, 'G-aaaaa');
    // Once anything is typed, Ctrl+Z is the text's own undo.
    await view.insert('below');
    type(view, 'W');
    assert.equal(undo(), true, 'passed on to the text');
    type(view, '');
    assert.equal(undo(), true, 'even once cleared again, to bring it back');
    assert.ok(view.editing);
});

test('moving the board tells the window it scrolled, so other plugins\' ' +
     'popups close', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    h.window.document.body.appendChild(view.contentEl);
    let scrolls = 0;
    const heard = () => { scrolls++; };
    h.window.addEventListener('scroll', heard, { capture: true });
    const col = view.board.querySelector('.dendrite-col');
    col.dispatchEvent(new h.window.WheelEvent('wheel',
        { deltaY: 40, bubbles: true, cancelable: true }));
    assert.ok(scrolls > 0, 'a wheel scroll is announced');
    scrolls = 0;
    view.render();
    assert.ok(scrolls > 0, 'so is redrawing the board');
    h.window.removeEventListener('scroll', heard, { capture: true });
    view.contentEl.remove();
});

test('a copy does not leave the board scrolled sideways', async () => {
    // Seen in Obsidian: at Ctrl+C another handler focused a hidden
    // textarea, the browser scrolled the board to show it, from 1008 to
    // 0, and every column jumped right.
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    h.window.document.body.appendChild(view.contentEl);
    const board = view.board;
    board.scrollLeft = 1008;
    const card = view.cardEls.get('G-aaaaa');
    card.dispatchEvent(new h.window.Event('copy', { bubbles: true }));
    board.scrollLeft = 0;
    board.dispatchEvent(new h.window.Event('scroll'));
    assert.equal(board.scrollLeft, 1008, 'put back at once');
    await tick(400);
    board.scrollLeft = 300;
    board.dispatchEvent(new h.window.Event('scroll'));
    assert.equal(board.scrollLeft, 300, 'a later scroll is left alone');
    // Seen again on 2026-10-22: the hidden textarea's handler copies a
    // second time, after the board has already moved. The second copy
    // must not hold the board where it was moved to.
    await tick(400);
    board.scrollLeft = 1009;
    card.dispatchEvent(new h.window.Event('copy', { bubbles: true }));
    board.scrollLeft = 0;
    card.dispatchEvent(new h.window.Event('copy', { bubbles: true }));
    board.dispatchEvent(new h.window.Event('scroll'));
    assert.equal(board.scrollLeft, 1009, 'held where the first copy was');
    board.scrollLeft = 0;
    board.dispatchEvent(new h.window.Event('scroll'));
    assert.equal(board.scrollLeft, 1009, 'and still there');
    await tick(400);
    assert.equal(board.scrollLeft, 1009, 'after both holds end');
    view.contentEl.remove();
});

test('find keeps painting its matches in the card being written',
     async () => {
    const edmod = require('../src/editor.js');
    let made = null;
    class FakeMarkdownEditor {
        constructor(app, container, owner) {
            this.owner = owner;
            const contentDOM = createDiv();
            container.appendChild(contentDOM);
            this.textNode = h.window.document.createTextNode('');
            contentDOM.appendChild(this.textNode);
            const self = this;
            this.editor = {
                cm: { contentDOM, hasFocus: false,
                      state: { doc: { toString: () => self.textNode.data } },
                      viewport: { from: 0, to: 1e9 },
                      domAtPos: (k) => ({ node: self.textNode, offset: k }) },
                focus() {}, setCursor() {}, setSelection() {},
                lastLine() { return 0; },
                getLine() { return self.textNode.data; },
                offsetToPos: (k) => k,
            };
            made = this;
        }
        set(v) { this.textNode.data = v; }
        onUpdate() {}
        register() {}
        load() {}
        unload() { this.onunload(); }
        onunload() {}
    }
    const { view, app } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'TET2 here and TET2 there', 'G-bbbbb': 'B' });
    app.keymap = { pushScope() {}, popScope() {} };
    app.embedRegistry = { embedByExtension: { md: () => ({
        showEditor() {}, unload() {},
        editMode: Object.create(Object.create(FakeMarkdownEditor.prototype)),
    }) } };
    edmod.resetForTests();
    h.window.CSS = { highlights: new Map() };
    h.window.Highlight = class { constructor(...r) { this.ranges = r; } };
    const lit = (name) => (h.window.CSS.highlights.get(name) ||
        { ranges: [] }).ranges.map((r) => r.toString());
    try {
        view.openFind();
        view.find.input.value = 'tet2';
        view.find.input.dispatchEvent(new h.window.Event('input'));
        await tick(150);
        await view.editAtMatch();
        assert.equal(view.editing.editor.kind, 'obsidian');
        assert.deepEqual(lit('dendrite-find-current'), ['TET2'],
                         'the current match, in the editor');
        assert.deepEqual(lit('dendrite-find'), ['TET2'], 'and the other');
        // The editor redraws its lines; the paint follows the new text.
        made.set('No match now, then TET2');
        h.window.CSS.highlights.clear();
        made.onUpdate({}, true);
        assert.deepEqual([...lit('dendrite-find-current'),
                          ...lit('dendrite-find')], ['TET2']);
    } finally {
        await view.endEdit();
        view.closeFind();
        delete h.window.CSS;
        delete h.window.Highlight;
        edmod.resetForTests();
        delete app.embedRegistry;
    }
});

test('a text selection dragged out of the card keeps the keyboard in it',
     async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'Some text to select', 'G-bbbbb': 'B' });
    h.window.document.body.appendChild(view.contentEl);
    try {
        await view.startEdit('G-aaaaa');
        const ta = view.editing.ta;
        assert.equal(h.window.document.activeElement, ta);
        // The press starts in the text; the release lands over the
        // column, so the click goes to what holds both.
        ta.dispatchEvent(new h.window.MouseEvent('pointerdown',
            { bubbles: true, cancelable: true, button: 0 }));
        ta.setSelectionRange(0, 9);
        view.board.querySelector('.dendrite-col').dispatchEvent(
            new h.window.MouseEvent('click', { bubbles: true }));
        await tick(10);
        assert.ok(view.editing, 'still editing');
        assert.equal(h.window.document.activeElement, ta,
                     'the keyboard stays in the card');
        assert.deepEqual([ta.selectionStart, ta.selectionEnd], [0, 9]);
        // A click that starts and ends on the board still selects cards.
        view.cardEls.get('G-bbbbb').dispatchEvent(new h.window.MouseEvent(
            'pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        h.window.dispatchEvent(new h.window.MouseEvent('pointerup',
            { bubbles: true }));
        view.cardEls.get('G-bbbbb').dispatchEvent(
            new h.window.MouseEvent('click', { bubbles: true }));
        await tick(20);
        assert.equal(view.active, 'G-bbbbb');
    } finally {
        view.contentEl.remove();
    }
});

test('number keys set a card\'s role, and the menus show each key',
     async () => {
    const { view, read } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'A', 'G-bbbbb': 'B' });
    view.plugin.settings.vimKeys = false;
    await view.select('G-bbbbb');
    const press = async (key) => {
        view.contentEl.dispatchEvent(new h.window.KeyboardEvent('keydown',
            { key, bubbles: true, cancelable: true }));
        await tick(20);
    };
    const role = () => (/dendrite_role: (\w+)/.exec(
        read(cardPath('G-bbbbb'))) || [])[1];
    for (const [key, want] of [['1', 'section'], ['2', 'prose'],
                               ['3', 'scaffolding'], ['4', 'notes'],
                               ['0', undefined]]) {
        await press(key);
        assert.equal(role(), want, `key ${key}`);
    }
    // Typing a digit into a card is text, not a role.
    await view.startEdit('G-bbbbb');
    await press('3');
    assert.equal(role(), undefined);
    await view.endEdit();
    view.roleMenu('G-bbbbb', view.cardEls.get('G-bbbbb'));
    const keys = h.obsidian.lastMenu.items.map((i) => [i.title,
        i.titleContent && i.titleContent.querySelector('[data-key]')
            .dataset.key]);
    assert.deepEqual(keys.slice(0, 5).map((k) => k[1]),
                     ['0', '1', '2', '3', '4']);
    assert.equal(keys[3][0], 'Scaffolding: prints its children only',
                 'the title reads without its key');
});

test('a whole branch is set from the menu only, as one undo; Alt with a ' +
     'number does nothing', async () => {
    const { view, read } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
        '    - [[G-bbbbb|B]]\n        - [[G-ccccc|C]]\n' +
        '    - [[G-ddddd|D]]\n- [[G-eeeee|E]]\n',
        { 'G-aaaaa': '# A', 'G-bbbbb': '# B', 'G-ccccc': 'C text',
          'G-ddddd': 'D text', 'G-eeeee': 'E text' });
    view.plugin.settings.vimKeys = false;
    await view.select('G-aaaaa');
    const press = async (code, ctrl = false) => {
        view.contentEl.dispatchEvent(new h.window.KeyboardEvent('keydown',
            { code, key: 'x', altKey: true, ctrlKey: ctrl,
              bubbles: true, cancelable: true }));
        await tick(30);
    };
    const prop = (id, k) => (new RegExp(`dendrite_${k}: (\\w+)`).exec(
        read(cardPath(id))) || [])[1];
    const branch = ['G-aaaaa', 'G-bbbbb', 'G-ccccc', 'G-ddddd'];
    await press('Digit2', true);
    await press('Digit4');
    assert.deepEqual(branch.map((id) => prop(id, 'status')),
                     [undefined, undefined, undefined, undefined],
                     'Ctrl+Alt+2 sets nothing');
    assert.deepEqual(branch.map((id) => prop(id, 'role')),
                     [undefined, undefined, undefined, undefined],
                     'Alt+4 sets nothing');
    // The menus: a Whole branch submenu, without keys.
    view.roleMenu('G-aaaaa', view.cardEls.get('G-aaaaa'));
    const whole = h.obsidian.lastMenu.items.find((i) =>
        i.title === 'Whole branch');
    assert.ok(whole && whole.submenu, 'a submenu');
    assert.deepEqual(whole.submenu.items.map((i) => i.title), [
        'Prints automatically', 'Prints its heading only',
        'Prints its full text', 'Scaffolding: prints its children only',
        'Left out of the manuscript'], 'roles only');
    // Statuses for the cards below are at the top of the card's menu.
    view.active = 'G-aaaaa';
    view.cardMenu(view.cardEls.get('G-aaaaa'));
    await h.obsidian.lastMenu.items.find((i) =>
        i.title === 'Cards below: done').click();
    await tick(30);
    assert.deepEqual(branch.map((id) => prop(id, 'status')),
                     [undefined, undefined, 'done', 'done'],
                     'headings take no status');
    assert.equal(prop('G-eeeee', 'status'), undefined, 'outside untouched');
    await whole.submenu.items[4].click();
    await tick(30);
    assert.deepEqual(branch.map((id) => prop(id, 'role')),
                     ['notes', 'notes', 'notes', 'notes']);
    assert.equal(prop('G-ccccc', 'status'), undefined);
    assert.match(h.notices[h.notices.length - 1], /4 cards in the branch/);
    // One undo puts back every card's role and status.
    await view.doUndo();
    await tick(30);
    assert.deepEqual(branch.map((id) => prop(id, 'role')),
                     [undefined, undefined, undefined, undefined]);
    assert.deepEqual(branch.map((id) => prop(id, 'status')),
                     [undefined, undefined, 'done', 'done']);
    // A heading card's own menu sets the cards below it.
    await view.updateStatuses();
    view.cardMenu(view.cardEls.get('G-aaaaa'));
    const below = h.obsidian.lastMenu.items.find((i) =>
        i.title === 'Cards below: revise');
    assert.ok(below, 'the cards below take a status from its menu');
    await below.click();
    await tick(30);
    assert.deepEqual(branch.map((id) => prop(id, 'status')),
                     [undefined, undefined, 'revise', 'revise']);
    // A card with nothing below it has no branch to set.
    view.roleMenu('G-eeeee', view.cardEls.get('G-eeeee'));
    assert.ok(!h.obsidian.lastMenu.items.some((i) =>
        i.title === 'Whole branch'));
});

test('Ctrl and 1 to 3 set a printing card\'s status, by physical key',
     async () => {
    const { view, read } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
        '    - [[G-bbbbb|B]]\n',
        { 'G-aaaaa': '# A', 'G-bbbbb': 'B' });
    await view.select('G-bbbbb');
    // A layout's own character for a digit key varies; the key's code
    // does not.
    const press = async (code, key, more = {}) => {
        view.contentEl.dispatchEvent(new h.window.KeyboardEvent('keydown',
            { code, key, ctrlKey: true, bubbles: true, cancelable: true,
              ...more }));
        await tick(20);
    };
    const status = (id) => (/dendrite_status: (\w+)/.exec(
        read(cardPath(id))) || [])[1];
    await press('Digit2', '2');
    assert.equal(status('G-bbbbb'), 'done');
    await press('Digit3', '"');
    assert.equal(status('G-bbbbb'), 'revise', 'a French layout\'s 3');
    await press('Digit1', '1');
    assert.equal(status('G-bbbbb'), 'draft');
    await press('Digit2', '@', { ctrlKey: false, shiftKey: true });
    assert.equal(status('G-bbbbb'), 'draft', 'Shift no longer sets one');
    assert.equal(/dendrite_role/.test(read(cardPath('G-bbbbb'))), false,
                 'no role was set by the digit');
    await view.select('G-aaaaa');
    await press('Digit2', '2');
    assert.equal(status('G-aaaaa'), undefined,
                 'a structural card takes its status from below');
    view.cardMenu(view.cardEls.get('G-aaaaa'));
    await view.select('G-bbbbb');
    view.cardMenu(view.cardEls.get('G-bbbbb'));
    const chips = h.obsidian.lastMenu.items.filter((i) =>
        /^Status/.test(i.title)).map((i) => [i.title,
        i.titleContent.querySelector('[data-key]').dataset.key]);
    assert.deepEqual(chips, [['Status: draft', 'Ctrl+1'],
                             ['Status: done', 'Ctrl+2'],
                             ['Status: revise', 'Ctrl+3']]);
});

test('each card undoes its own text, visit by visit; the board undoes ' +
     'the tree', async () => {
    const { view, app, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'Original text.', 'G-bbbbb': 'B' });
    const undoKey = view.scope.keys.find((k) => k.key === 'z' &&
                                        !k.mods.includes('Shift')).fn;
    const redoKey = view.scope.keys.find((k) => k.key === 'y').fn;
    const value = () => view.editing.ta.value;
    // Settings and the index note as icons at the bar's left, then undo
    // and redo; nothing at the right, under other plugins' overlays.
    const bar = [...view.contentEl.querySelectorAll('.dendrite-bar-btn')];
    assert.deepEqual(bar.map((b) => b.textContent || b.ariaLabel ||
                             b.getAttribute('aria-label')),
                     ['This manuscript\'s settings',
                      'Open the index note as markdown',
                      'Undo', 'Redo', 'Preview', 'All', 'Printed',
                      'Export', 'Review']);
    // The mode comes after the buttons; the name is the pane's title.
    const kids = [...view.contentEl.querySelector('.dendrite-bar').children];
    assert.ok(kids.indexOf(view.modeEl) > kids.indexOf(bar[5]));
    assert.equal(view.contentEl.querySelector('.dendrite-bar .dendrite-title'),
                 null);
    // A edited twice, then B: A's edits are undone in A, B's kept.
    for (const t of ['A first.', 'A second.']) {
        await view.startEdit('G-aaaaa');
        type(view, t);
        await view.endEdit();
    }
    await view.startEdit('G-bbbbb');
    type(view, 'B edited.');
    await view.endEdit();
    await view.startEdit('G-aaaaa');
    assert.equal(undoKey(), false, 'taken by Dendrite');
    assert.equal(value(), 'A first.');
    assert.equal(undoKey(), false);
    assert.equal(value(), 'Original text.');
    assert.equal(undoKey(), true, 'nothing earlier: the editor\'s own');
    assert.equal(redoKey(), false);
    assert.equal(value(), 'A first.', 'redone');
    await view.endEdit();
    assert.equal(text(cardPath('G-aaaaa')), 'A first.');
    assert.equal(text(cardPath('G-bbbbb')), 'B edited.', 'B left alone');
    // Typing in this visit is the editor's to undo first; once it is
    // undone, Ctrl+Z steps back a visit.
    await view.startEdit('G-aaaaa');
    type(view, 'A third.');
    assert.equal(undoKey(), true, 'the editor\'s own undo');
    type(view, 'A first.');
    assert.equal(undoKey(), false);
    assert.equal(value(), 'Original text.');
    // Typing after a step back ends what could be redone.
    type(view, 'New.');
    assert.equal(redoKey(), true, 'the editor\'s own redo');
    await view.endEdit();
    assert.equal(text(cardPath('G-aaaaa')), 'New.');
    // The board's undo is the tree's alone.
    view.active = 'G-bbbbb';
    await view.structural('up');
    await view.doUndo();
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-aaaaa', 'G-bbbbb']);
    assert.equal(text(cardPath('G-aaaaa')), 'New.');
    assert.equal(text(cardPath('G-bbbbb')), 'B edited.');
    await view.doUndo();
    assert.match(h.notices[h.notices.length - 1], /inside the card/);
    // Text changed since, by a sync or another tab, is never overwritten.
    const f = app.vault.getAbstractFileByPath(cardPath('G-bbbbb'));
    await app.vault.process(f, (d) => d.replace('B edited.', 'From sync.'));
    await view.startEdit('G-bbbbb');
    assert.equal(undoKey(), false);
    assert.equal(value(), 'From sync.');
    assert.match(h.notices[h.notices.length - 1], /changed since/);
    await view.endEdit();
    assert.equal(text(cardPath('G-bbbbb')), 'From sync.');
});

test('each card shows its short id, which copies on a click and finds ' +
     'the card', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
        '    - [[G-bbbbb|B]]\n- [[G-ccccc|C]]\n',
        { 'G-aaaaa': 'Alpha', 'G-bbbbb': 'Beta', 'G-ccccc': 'See bbbbb' });
    const tag = (id) => view.cardEls.get(id).querySelector(
        ':scope > .dendrite-card-foot > .dendrite-id');
    assert.equal(tag('G-bbbbb').textContent, 'bbbbb');
    const nav = view.pageWin().navigator;
    const copied = [];
    Object.defineProperty(nav, 'clipboard', { configurable: true,
        value: { writeText: async (t) => { copied.push(t); } } });
    view.active = 'G-aaaaa';
    view.applyActive();
    tag('G-bbbbb').dispatchEvent(new h.window.MouseEvent('click',
        { bubbles: true }));
    await tick(10);
    assert.deepEqual(copied, ['bbbbb']);
    assert.equal(h.notices[h.notices.length - 1], 'Copied bbbbb');
    assert.equal(view.active, 'G-aaaaa', 'the click does not select it');
    // Find: the id finds its card, first, before text that mentions it.
    view.openFind();
    const f = view.find;
    f.input.value = 'BBBBB';
    f.input.dispatchEvent(new h.window.Event('input'));
    await tick(150);
    assert.deepEqual(f.matches.map((m) => [m.id, !!m.card]),
                     [['G-bbbbb', true], ['G-ccccc', false]]);
    assert.equal(view.active, 'G-bbbbb', 'the card is selected');
    assert.ok(view.cardEls.get('G-bbbbb').hasClass('is-match'));
    assert.ok(tag('G-bbbbb').hasClass('is-current'), 'its id is marked');
    await view.findStep(1);
    assert.ok(tag('G-bbbbb').hasClass('is-match'));
    assert.ok(!tag('G-bbbbb').hasClass('is-current'));
    view.closeFind();
    assert.ok(!tag('G-bbbbb').hasClass('is-match'), 'cleared with find');
    delete nav.clipboard;
});

test('Escape closes find from its box or from the board', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'Alpha', 'G-bbbbb': 'Beta alpha' });
    const key = (el, k, shift = false) => el.dispatchEvent(
        new h.window.KeyboardEvent('keydown', { key: k, shiftKey: shift,
            bubbles: true, cancelable: true }));
    view.openFind();
    const f = view.find;
    f.input.value = 'alpha';
    f.input.dispatchEvent(new h.window.Event('input'));
    await tick(150);
    // In the box, the keys work even where no scope delivers them.
    key(f.input, 'Enter');
    await tick(20);
    assert.equal(f.index, 1, 'Enter steps');
    key(f.input, 'Enter', true);
    await tick(20);
    assert.equal(f.index, 0, 'Shift+Enter steps back');
    key(f.input, 'Escape');
    assert.equal(view.find, null, 'Escape in the box closes it');
    // From the board: a card being edited is left first, then find.
    view.openFind();
    await view.startEdit('G-aaaaa');
    const esc = view.scope.keys.find((k) => k.key === 'Escape' &&
                                     !k.mods.length).fn;
    esc();
    await tick(20);
    assert.equal(view.editing, null);
    assert.ok(view.find, 'find stays while the card is left');
    assert.equal(esc(), false, 'handled');
    assert.equal(view.find, null, 'then closes');
    // And from the board's own keys, where no scope is active.
    view.openFind();
    key(view.contentEl, 'Escape');
    assert.equal(view.find, null, 'closed from the board');
    // With nothing to close, Escape stops at Dendrite: Obsidian's own
    // Escape takes a popout's focus back to the main window. What
    // Obsidian does with a key passed on is not in the harness.
    assert.equal(esc(), false, 'not passed on to Obsidian');
    const ev = new h.window.KeyboardEvent('keydown', { key: 'Escape',
        bubbles: true, cancelable: true });
    view.contentEl.dispatchEvent(ev);
    assert.ok(ev.defaultPrevented, 'nor from the board');
});

test('a card set to table prints numbered, a link to it prints its ' +
     'number, and the menu copies a reference', async () => {
    const { view, read } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|Aims]]\n' +
        '    - [[G-bbbbb|p]]\n    - [[G-ttttt|Budget]]\n',
        { 'G-aaaaa': '# Aims', 'G-bbbbb': 'See [[G-ttttt]].',
          'G-ttttt': '# Budget\n\n| Y | C |\n| - | - |\n| 1 | 2 |' });
    view.active = 'G-ttttt';
    view.applyActive();
    view.cardMenu(view.cardEls.get('G-ttttt'));
    const menu = submenuOf(h.obsidian.lastMenu, 'Prints as');
    const t = menu.titles;
    const text = t.indexOf('Text');
    assert.ok(text > 0, 'the kinds are offered');
    assert.deepEqual(t.slice(text, text + 3), ['Text',
        'Table: numbered, caption above', 'Figure: numbered, caption below']);
    assert.equal(t[text - 1], '---', 'apart from the roles');
    await menu.items.find((i) => /^Table:/.test(i.title)).click();
    await tick(20);
    assert.match(read(cardPath('G-ttttt')), /dendrite_kind: table/);
    const grip = view.cardEls.get('G-ttttt')
        .querySelector(':scope > .dendrite-grip');
    assert.equal(grip.dataset.role, 'table', 'the corner shows a table');
    await view.exportTo(null);
    assert.equal(read('W/Grant/exports/Grant.md'),
                 '# Aims\n\nSee [[G-ttttt|Table 1]].\n\n' +
                 '**Table 1.** Budget\n\n' +
                 '| Y | C |\n| - | - |\n| 1 | 2 |\n');
    // Copy reference: the full link, to paste where it is cited.
    const nav = view.pageWin().navigator;
    const copied = [];
    Object.defineProperty(nav, 'clipboard', { configurable: true,
        value: { writeText: async (x) => { copied.push(x); } } });
    view.cardMenu(view.cardEls.get('G-ttttt'));
    await h.obsidian.lastMenu.items.find((i) =>
        i.title === 'Copy reference').click();
    await tick(10);
    assert.deepEqual(copied, ['[[G-ttttt]]']);
    delete nav.clipboard;
    // Back to text: no number, and the link prints as before.
    view.cardMenu(view.cardEls.get('G-ttttt'));
    await menuItem(h.obsidian.lastMenu, 'Text').click();
    await tick(20);
    assert.doesNotMatch(read(cardPath('G-ttttt')), /dendrite_kind/);
    await view.exportTo(null);
    assert.match(read('W/Grant/exports/Grant.md'), /See \[\[G-ttttt\]\]\./);
});

test('review comments go into their cards as one undo step, set them to ' +
     'revise, and are resolved, dismissed or applied from the card',
     async () => {
    const A = 'The cohort is composed of longitudinally paired samples.';
    const B = 'Samples were collected between 2014 and 2023 under the ' +
        'protocol.';
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': A, 'G-bbbbb': B });
    const rows = [
        { kind: 'comment', author: 'Aly Karsan', date: '2026-10-23',
          text: 'How many?', quote: 'longitudinally paired samples',
          before: 'The cohort is composed of ', after: '.' },
        { kind: 'change', author: 'Aly Karsan', date: '2026-10-23',
          quote: 'between 2014 and 2023', insert: 'from 2014 to 2023',
          before: 'Samples were collected ', after: ' under the' },
        { kind: 'comment', author: 'R', date: '2026-10-24',
          text: 'Not in any card.', quote: 'gone entirely from the text',
          before: '', after: '' },
    ].map((item) => ({ item, at: {}, use: true }));
    rows[2].at = null;
    view.active = 'G-bbbbb';
    await view.addReview(rows, view.byId.get('G-bbbbb'));
    assert.equal(text(cardPath('G-aaaaa')), 'The cohort is composed of ' +
        '%%{1%%longitudinally paired samples%%}1 [!review] Aly Karsan, ' +
        '2026-10-23: How many?%%.');
    assert.equal(text(cardPath('G-bbbbb')), 'Samples were collected ' +
        '%%{1%%between 2014 and 2023%%}1 [!suggest] Aly Karsan, ' +
        '2026-10-23: from 2014 to 2023%% under the protocol.%%[!review] R, ' +
        '2026-10-24: On “gone entirely from the text”: Not in any card.%%',
        'one never found goes on the selected card, quoted');
    assert.match(read(cardPath('G-aaaaa')), /dendrite_status: revise/);
    assert.match(read(cardPath('G-bbbbb')), /dendrite_status: revise/);
    await view.doUndo();
    assert.equal(text(cardPath('G-aaaaa')), A, 'one step undoes all');
    assert.equal(text(cardPath('G-bbbbb')), B);
    assert.ok(!/revise/.test(read(cardPath('G-aaaaa'))), 'status too');
    await view.addReview(rows.slice(0, 2), null);
    // Drawn on the card: callouts with their buttons.
    view.invalidate('G-bbbbb');
    await view.renderCard('G-bbbbb');
    const card = view.cardEls.get('G-bbbbb');
    assert.equal(card.querySelectorAll('.dendrite-review-note').length, 1);
    await view.reviewAction('G-aaaaa', 0, 'resolve');
    assert.equal(text(cardPath('G-aaaaa')), A, 'resolved: as it was');
    await view.reviewAction('G-bbbbb', 0, 'apply');
    const m = h.obsidian.lastModal;
    assert.match(m.titleEl.textContent, /Apply the suggested change/);
    // The card now in grey, with the change in the reviewer's colour, as
    // their suggestions are drawn.
    const tint = view.colourOf()('Aly Karsan');
    assert.equal(m.modalEl.style.getPropertyValue('--dendrite-now'),
                 'var(--text-muted)');
    assert.equal(m.modalEl.style.getPropertyValue('--dendrite-before'),
                 tint ? `var(--color-${tint})` : 'var(--interactive-accent)');
    assert.equal(text(cardPath('G-bbbbb')).includes('[!suggest]'), true,
                 'nothing written until applied');
    await [...m.contentEl.querySelectorAll('button')]
        .find((b) => b.textContent === 'Apply').onclick();
    assert.equal(text(cardPath('G-bbbbb')), 'Samples were collected from ' +
        '2014 to 2023 under the protocol.');
    await view.doUndo();
    assert.match(text(cardPath('G-bbbbb')),
                 /%%\{1%%between 2014 and 2023%%\}1 /,
                 'applying is undone in one step');
});

// ---- renaming the manuscript --------------------------------------------

const RENAME_INDEX = '---\ndendrite_prefix: G\n' +
    'dendrite_csl: W/Grant/style.csl\n---\n' +
    '- [[G-aaaaa|One]]\n    - [[G-bbbbb|Two]]\n';

async function openForRename() {
    const o = await open(RENAME_INDEX, { 'G-aaaaa': '# One\nText.',
                                         'G-bbbbb': 'Two text.' });
    o.app.vault.folders.add('W/Grant');
    await o.app.vault.create('Notes.md', 'See [[G-aaaaa|the aims]].');
    await o.view.versionsChecked;
    return o;
}

test('renaming the manuscript renames every card note, the index and ' +
     'its folder, and keeps links and versions', async () => {
    const { app, view, read } = await openForRename();
    h.notices.length = 0;
    assert.equal(await view.renameManuscript('Grant 2027', 'G27'), true);
    const dir = 'W/Grant 2027';
    assert.deepEqual([...app.vault.files.keys()].sort(), [
        'Notes.md', `${dir}/Grant 2027.md`, `${dir}/cards/G27-aaaaa.md`,
        `${dir}/cards/G27-bbbbb.md`]);
    assert.equal(read(`${dir}/Grant 2027.md`),
                 '---\ndendrite_prefix: G27\n' +
                 `dendrite_csl: ${dir}/style.csl\n` +
                 'dendrite_former_prefixes:\n  - G\n---\n' +
                 '- [[G27-aaaaa|One]]\n    - [[G27-bbbbb|Two]]\n');
    assert.equal(read('Notes.md'), 'See [[G27-aaaaa|the aims]].');
    assert.equal(read(`${dir}/cards/G27-aaaaa.md`), '# One\nText.');
    assert.equal(view.file.path, `${dir}/Grant 2027.md`);
    assert.deepEqual([...view.byId.keys()], ['G27-aaaaa', 'G27-bbbbb']);
    assert.ok(await view.history.store.get(view.historyKey('G27-aaaaa')),
              'the card\'s versions followed it');
    assert.ok(h.notices.some((n) => /renamed to Grant 2027/.test(n)));
    assert.equal(view.renameProblem('Grant 2027', 'G27'),
                 'that is already its title and prefix.');
});

test('a rename takes the review rounds along: the file beside the ' +
     'index, and its cards, so nothing reads as changed', async () => {
    const { app, view, read } = await openForRename();
    await view.recordRound('Aly');
    assert.ok(read('W/Grant/Grant.rounds.json'));
    assert.equal(await view.renameManuscript('Grant 2027', 'G27'), true);
    const dir = 'W/Grant 2027';
    assert.equal(read(`${dir}/Grant.rounds.json`), undefined,
                 'not left under the old name');
    const rounds = JSON.parse(read(`${dir}/Grant 2027.rounds.json`)).rounds;
    assert.deepEqual(Object.keys(rounds[0].cards).sort(),
                     ['G27-aaaaa', 'G27-bbbbb']);
    await view.updateChanged();
    assert.equal(view.changed.ids.size, 0, 'no card changed since sent');
});

test('a review naming its cards by the ids they had before a rename ' +
     'still finds them, by their short id', async () => {
    const review = require('../src/review.js');
    const cards = [{ id: 'G27-aaaaa', text: 'The cohort is large.' },
                   { id: 'G27-bbbbb', text: 'The cohort is small.' }];
    const at = review.locate({ card: 'G-bbbbb', quote: 'cohort',
                               text: 'How many?' }, cards);
    assert.equal(at && at.id, 'G27-bbbbb');
});

test('a rename cut short finishes when run again', async () => {
    const { app, view, read } = await openForRename();
    const rename = app.fileManager.renameFile;
    let n = 0;
    app.fileManager.renameFile = async (f, to) => {
        if (++n === 2) throw new Error('disk full');
        return rename(f, to);
    };
    h.notices.length = 0;
    assert.equal(await view.renameManuscript('Grant 2027', 'G27'), false);
    assert.ok(h.notices.some((n) => /stopped part way: disk full/.test(n)));
    assert.ok(read('W/Grant/cards/G27-aaaaa.md') !== undefined);
    assert.ok(read('W/Grant/cards/G-bbbbb.md') !== undefined);
    app.fileManager.renameFile = rename;
    assert.equal(await view.renameManuscript('Grant 2027', 'G27'), true);
    assert.equal(read('W/Grant 2027/Grant 2027.md'),
                 '---\ndendrite_prefix: G27\n' +
                 'dendrite_csl: W/Grant 2027/style.csl\n' +
                 'dendrite_former_prefixes:\n  - G\n---\n' +
                 '- [[G27-aaaaa|One]]\n    - [[G27-bbbbb|Two]]\n');
});

test('a rename refuses a prefix another manuscript has or had, and a ' +
     'title taken', async () => {
    const { app, view } = await openForRename();
    await app.vault.create('W/Other.md', '---\ndendrite_prefix: OTH\n' +
        'dendrite_former_prefixes:\n  - OLD\n---\n');
    await app.vault.create('W/Taken/Taken.md', 'x');
    app.vault.folders.add('W/Taken');
    assert.match(view.renameProblem('New', 'OTH'), /already used/);
    assert.match(view.renameProblem('New', 'OLD'), /already used/);
    assert.match(view.renameProblem('Taken', 'NEW'), /W\/Taken already exists/);
    assert.equal(view.renameProblem('New', 'NEW'), null);
});

test('after a rename, notes back under the old name are old copies, and ' +
     'opening the old index shows the new one', async () => {
    const { app, view } = await openForRename();
    await view.renameManuscript('Grant 2027', 'G27');
    await app.vault.create('W/Grant 2027/cards/G-aaaaa.md', '# One\nOld.');
    await app.vault.create('W/Grant/Grant.md', RENAME_INDEX);
    h.notices.length = 0;
    view.checkOldCopies();
    assert.deepEqual(view.oldCopies.map((c) => c.file.path).sort(),
                     ['W/Grant 2027/cards/G-aaaaa.md', 'W/Grant/Grant.md']);
    assert.ok(h.notices.some((n) => /2 notes under this manuscript's/
        .test(n)));
    assert.match(view.renameProblem('Grant 2028', 'G28'), /old copy/);
    const other = new DendriteView({ app, updateHeader() {}, detach() {} },
                                   view.plugin);
    await other.onOpen();
    await other.setState({ file: 'W/Grant/Grant.md' });
    assert.equal(other.file.path, 'W/Grant 2027/Grant 2027.md');
});

test('a status set on a card is one undo step, and redoes', async () => {
    const { view, read } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': '---\ndendrite_status: draft\n---\nA text' });
    const status = () => (/dendrite_status: (\w+)/.exec(
        read(cardPath('G-aaaaa'))) || [])[1];
    await view.select('G-aaaaa');
    await view.setStatusByKey('done');
    assert.equal(status(), 'done');
    await view.doUndo();
    await tick(30);
    assert.equal(status(), 'draft', 'undone');
    await view.doRedo();
    await tick(30);
    assert.equal(status(), 'done', 'redone');
    await view.stepStatus(false);
    assert.equal(status(), 'revise');
    await view.doUndo();
    await tick(30);
    assert.equal(status(), 'done', 'the step undone too');
});

test('the print-only view shows the cards that print, each where it ' +
     'prints, and changes no structure', async () => {
    const { view, read } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
        '    - [[G-sssss|S]]\n        - [[G-ccccc|C]]\n' +
        '    - [[G-nnnnn|N]]\n        - [[G-mmmmm|M]]\n' +
        '    - [[G-ddddd|D]]\n- [[G-eeeee|E]]\n',
        { 'G-aaaaa': '# A\nNotes under A.',
          'G-sssss': '---\ndendrite_role: scaffolding\n---\nplan',
          'G-ccccc': 'C text', 'G-nnnnn': '---\ndendrite_role: notes\n' +
          '---\nN', 'G-mmmmm': 'M text', 'G-ddddd': 'D text',
          'G-eeeee': 'E text' });
    await view.select('G-sssss');
    const before = read(INDEX);
    view.togglePrintOnly();
    await tick(30);
    const ids = (col) => col.map((n) => n.id);
    assert.deepEqual(view.cols.map(ids),
                     [['G-aaaaa', 'G-eeeee'], ['G-ccccc', 'G-ddddd']],
                     'scaffolding lifts its children; notes go');
    assert.deepEqual([...view.cardEls.keys()].sort(),
                     ['G-aaaaa', 'G-ccccc', 'G-ddddd', 'G-eeeee']);
    assert.equal(view.active, 'G-ccccc', 'a hidden card gives way');
    assert.ok(view.cardEls.get('G-aaaaa').hasClass('is-prints-heading'));
    assert.ok(view.board.hasClass('is-print-only'));
    view.navigate('left');
    await tick();
    assert.equal(view.active, 'G-aaaaa', 'left goes to where it prints');
    view.navigate('right');
    await tick();
    assert.equal(view.active, 'G-ccccc');
    h.notices.length = 0;
    await view.structural('down');
    await view.insert('below');
    await view.deleteActive();
    assert.equal(read(INDEX), before, 'no structure changed');
    assert.ok(h.notices.some((n) => /print-only view/.test(n)));
    await view.setStatusByKey('done');
    assert.match(read(cardPath('G-ccccc')), /dendrite_status: done/,
                 'statuses still set');
    assert.equal(view.getState().printOnly, true);
    view.togglePrintOnly();
    await tick(30);
    assert.equal(view.cols.length, 3, 'every card again');
    assert.equal(view.cardEls.size, 7);
});

test('a JSON review list opens the same dialog, each comment found in the ' +
     'card it names, and adding it is one undo step', async () => {
    const A = 'The cohort is composed of paired samples.';
    const B = 'Each patient gave paired samples.';
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': A, 'G-bbbbb': B });
    const json = JSON.stringify([
        { card: 'bbbbb', quote: 'paired samples', text: 'How many?',
          author: 'Claude', date: '2026-10-23' },
        { quote: 'paired samples', text: 'Which card?' }]);
    const m = await view.reviewFrom('review.json', Buffer.from(json));
    assert.match(m.contentEl.textContent, /2 comments .*; 1 found/);
    assert.equal(m.rows[0].at.id, 'G-bbbbb');
    assert.equal(m.rows[1].at, null, 'in two cards, naming neither');
    await view.addReview(m.rows.filter((x) => x.use), null);
    assert.equal(text(cardPath('G-bbbbb')), 'Each patient gave ' +
        '%%{1%%paired samples%%}1 [!review] Claude, 2026-10-23: How ' +
        'many?%%.');
    assert.equal(text(cardPath('G-aaaaa')), A);
    assert.match(read(cardPath('G-bbbbb')), /dendrite_status: revise/);
    await view.doUndo();
    assert.equal(text(cardPath('G-bbbbb')), B);
    assert.equal(await view.reviewFrom('bad.json', Buffer.from('{')),
                 null, 'unreadable: a notice, no dialog');
});

test('a review submitted for a manuscript is queued with where its ' +
     'passages are, offered on its board, and taken only by adding or ' +
     'ignoring it', async () => {
    const DendritePlugin = require('../src/main.js');
    const A = 'The cohort is composed of paired samples.';
    const B = 'Each patient gave paired samples.';
    const { app, view, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': A, 'G-bbbbb': B });
    const p = new DendritePlugin();
    p.app = app;
    p.settings = { reviewQueue: [] };
    let saved = 0;
    p.saveData = async () => { saved++; };
    p.openViews = () => [view];
    view.plugin = Object.assign(view.plugin, {
        settings: p.settings, reviewQueue: () => p.reviewQueue(),
        settleReview: (id, st) => p.settleReview(id, st) });
    const item = (card, quote, text) => ({ card, quote, text,
        author: 'Claude', date: '2026-10-23' });
    h.notices.length = 0;
    const bad = await p.submitReview({ manuscript: 'X', items: [] });
    assert.equal(bad.status, 404);
    assert.match(bad.json.error, /no manuscript has the prefix X/);
    assert.equal((await p.submitReview({ manuscript: 'G',
        items: [{ quote: 'q' }] })).status, 400);
    assert.equal((await p.submitReview({ items: [] })).status, 400);
    const sent = { manuscript: 'G', title: 'RAC review', items: [
        item('aaaaa', 'paired samples', 'How many?'),
        item('bbbbb', 'not in the card', 'Lost.')] };
    const out = await p.submitReview(sent);
    assert.equal(out.status, 202);
    assert.equal(out.json.state, 'pending');
    assert.equal(out.json.found, 1);
    assert.deepEqual(out.json.missing, [{ n: 2, card: 'bbbbb',
                                          quote: 'not in the card' }]);
    assert.equal((await p.submitReview(sent)).json.id, out.json.id,
                 'the same review again is not queued twice');
    assert.equal(p.settings.reviewQueue.length, 1);
    assert.ok(saved >= 1, 'kept until decided');
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0], /RAC review: 2 comments from Claude/);
    const chips = () => [...view.statusEl.querySelectorAll(
        '.dendrite-status-chip')].filter((s) =>
        /^review/.test(s.textContent)).map((s) => s.textContent);
    assert.deepEqual(chips(), ['review: 2 from Claude']);
    // Cancel leaves it; Add takes it.
    await view.openInbox(view.inbox[0]);
    const m = h.obsidian.lastModal;
    assert.match(m.titleEl.textContent, /RAC review/);
    [...m.contentEl.querySelectorAll('button')]
        .find((b) => b.textContent === 'Cancel').onclick();
    assert.equal(view.inbox.length, 1);
    await view.openInbox(view.inbox[0]);
    await h.obsidian.lastModal.contentEl.querySelector('.mod-cta').onclick();
    assert.match(text(cardPath('G-aaaaa')),
                 /%%\{1%%paired samples%%\}1 \[!review\] Claude/);
    assert.deepEqual(chips(), []);
    assert.deepEqual((await p.reviewStatus(out.json.id)).json.state,
                     'added');
    // Sent again once added: queued, but what is already in the card
    // comes unticked.
    const again = await p.submitReview(sent);
    assert.notEqual(again.json.id, out.json.id);
    assert.equal(again.json.already, 1);
    await view.openInbox(view.inbox[0]);
    const dm = h.obsidian.lastModal;
    assert.match(dm.contentEl.textContent, /1 already in the cards/);
    assert.match(dm.contentEl.textContent, /Already in the card/);
    assert.equal(dm.rows[0].use, false);
    assert.equal(dm.contentEl.querySelector('.mod-cta').textContent,
                 'Add 0');
    await [...dm.contentEl.querySelectorAll('button')]
        .find((b) => b.textContent === 'Ignore this review').onclick();
    assert.equal((await p.reviewStatus('nope')).status, 404);
    // Ignored: nothing written.
    const two = await p.submitReview({ manuscript: 'G', items: [
        item('bbbbb', 'paired samples', 'Which?')] });
    await view.openInbox(view.inbox[0]);
    await [...h.obsidian.lastModal.contentEl.querySelectorAll('button')]
        .find((b) => b.textContent === 'Ignore this review').onclick();
    assert.equal(text(cardPath('G-bbbbb')), B);
    assert.equal((await p.reviewStatus(two.json.id)).json.state,
                 'ignored');
    assert.deepEqual(chips(), []);
});

test('the card menu keeps its exports in one submenu', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'Text.' });
    view.active = 'G-aaaaa';
    view.cardMenu(view.cardEls.get('G-aaaaa'), null);
    const titles = h.obsidian.lastMenu.items.map((i) => i.title);
    assert.ok(!titles.some((t) => /to (markdown|PDF|Word)/.test(t)));
    const exp = h.obsidian.lastMenu.items.find((i) =>
        i.title === 'Export this branch');
    assert.ok(exp && exp.submenu, 'a submenu');
    assert.deepEqual(exp.submenu.items.map((i) => i.title),
                     ['Markdown', 'PDF', 'Word']);
});

test('turned on, Dendrite listens for reviews with a key it writes to the ' +
     'discovery file, and removes the file when it stops', async () => {
    const DendritePlugin = require('../src/main.js');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dendrite-api-'));
    const file = path.join(dir, 'vaults', 'Vault', 'review-api.json');
    process.env.DENDRITE_CONFIG_DIR = dir;
    // Before 0.23 one file served every vault: this vault's goes.
    const legacy = path.join(dir, 'review-api.json');
    fs.writeFileSync(legacy, JSON.stringify({ vault: 'Vault' }));
    const { app } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'Each patient gave paired samples.' });
    app.vault.getName = () => 'Vault';
    const p = new DendritePlugin();
    p.app = app;
    p.settings = { reviewApi: true, reviewApiPort: 0, reviewApiKey: '',
                   reviewQueue: [] };
    p.saveData = async () => {};
    p.openViews = () => [];
    try {
        await p.syncReviewApi();
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.ok(!fs.existsSync(legacy), 'the shared file is gone');
        assert.equal(d.vault, 'Vault');
        assert.equal(d.key.length, 48, 'a key was made');
        assert.equal(d.key, p.settings.reviewApiKey);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        const res = await fetch(d.url, { method: 'POST', headers: {
            authorization: `Bearer ${d.key}`,
            'content-type': 'application/json' },
            body: JSON.stringify({ manuscript: 'G', items: [
                { card: 'aaaaa', quote: 'paired samples', text: 'How?',
                  author: 'Claude' }] }) });
        assert.equal(res.status, 202);
        const out = await res.json();
        assert.equal(out.found, 1, 'found without a board open');
        assert.equal(p.settings.reviewQueue.length, 1);
        const st = await fetch(`${d.url}/${out.id}`, { headers: {
            authorization: `Bearer ${d.key}` } });
        assert.equal((await st.json()).state, 'pending');
        p.settings.reviewApi = false;
        await p.syncReviewApi();
        assert.ok(!fs.existsSync(file), 'stopped: the file is gone');
        await assert.rejects(fetch(d.url, { method: 'POST' }));
    } finally {
        await p.stopReviewApi();
        delete process.env.DENDRITE_CONFIG_DIR;
        fs.rmSync(dir, { recursive: true });
    }
});

test('Dendrite in two vaults on one port: each listens, the second on a ' +
     'free port, and writes its own discovery file', async () => {
    const DendritePlugin = require('../src/main.js');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dendrite-api-'));
    process.env.DENDRITE_CONFIG_DIR = dir;
    const legacy = path.join(dir, 'review-api.json');
    fs.writeFileSync(legacy, JSON.stringify({ vault: 'elsewhere' }));
    const taken = require('net').createServer();
    await new Promise((r) => taken.listen(0, '127.0.0.1', r));
    const port = taken.address().port;
    const plugin = async (vault) => {
        const { app } = await open(
            '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
            { 'G-aaaaa': 'Text.' });
        app.vault.getName = () => vault;
        const p = new DendritePlugin();
        p.app = app;
        p.settings = { reviewApi: true, reviewApiPort: port,
                       reviewApiKey: '', reviewQueue: [] };
        p.saveData = async () => {};
        p.openViews = () => [];
        return p;
    };
    const a = await plugin('second_brain');
    const b = await plugin('test_vault');
    try {
        await a.syncReviewApi();
        await b.syncReviewApi();
        const read = (v) => JSON.parse(fs.readFileSync(
            path.join(dir, 'vaults', v, 'review-api.json'), 'utf8'));
        const da = read('second_brain');
        const db = read('test_vault');
        assert.notEqual(da.url, db.url, 'two addresses');
        assert.ok(!da.url.includes(`:${port}/`), 'the taken port avoided');
        assert.notEqual(da.key, db.key);
        assert.ok(fs.existsSync(legacy), 'another vault\'s file is kept');
        for (const d of [da, db]) {
            const res = await fetch(d.url, { method: 'POST', headers: {
                authorization: `Bearer ${d.key}`,
                'content-type': 'application/json' },
                body: JSON.stringify({ manuscript: 'G', items: [
                    { card: 'aaaaa', quote: 'Text', text: 'Why?',
                      author: 'Claude' }] }) });
            assert.equal(res.status, 202);
        }
        assert.equal(a.settings.reviewQueue.length, 1);
        assert.equal(b.settings.reviewQueue.length, 1);
    } finally {
        await a.stopReviewApi();
        await b.stopReviewApi();
        taken.close();
        delete process.env.DENDRITE_CONFIG_DIR;
        fs.rmSync(dir, { recursive: true });
    }
});

const STACK_INDEX = '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
    '    - [[G-ccccc|C]]\n- [[G-bbbbb|B]]\n';

async function exported(view) {
    const bodies = new Map();
    for (const n of core.allNodes(view.root)) {
        const f = view.cardFile(n.id);
        if (f) {
            bodies.set(n.id, core.splitFrontmatter(
                await view.app.vault.read(f)).body);
        }
    }
    return core.exportMarkdown(view.root.children, (id) => bodies.get(id),
                               1, null, (id) => view.printRoleOf(id));
}

test('a card replaced by its child goes into a stack under it: hidden, ' +
     'not printed, shown as versions, and brought back from there',
     async () => {
    const { view, read } = await open(STACK_INDEX, {
        'G-aaaaa': '---\ndendrite_role: prose\n---\nOld paragraph.',
        'G-ccccc': 'New paragraph.', 'G-bbbbb': 'Next.' });
    assert.match(await exported(view), /Old paragraph[^]*New paragraph/,
                 'before: both print');
    await view.select('G-ccccc');
    view.cardMenu(view.cardEls.get('G-ccccc'), null);
    const replace = menuItem(h.obsidian.lastMenu,
                             'Replace the parent card with this one');
    assert.ok(replace, 'offered on a child card');
    await replace.click();
    await tick();
    assert.equal(core.serialiseTree(view.root).split('\n')
        .filter(Boolean).length, 3);
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-ccccc', 'G-bbbbb'], 'the child takes its place');
    assert.deepEqual(view.byId.get('G-ccccc').children.map((n) => n.id),
                     ['G-aaaaa'], 'the old card is under it');
    assert.match(read(cardPath('G-aaaaa')), /dendrite_superseded: \d{4}-/);
    assert.match(read(cardPath('G-ccccc')), /dendrite_role: prose/,
                 'the new card prints as the old one did');
    assert.ok(!view.cardEls.has('G-aaaaa'), 'hidden from the board');
    assert.ok(!view.cardEls.get('G-ccccc').classList
        .contains('has-children'));
    const out = await exported(view);
    assert.match(out, /New paragraph/);
    assert.doesNotMatch(out, /Old paragraph/, 'the old one does not print');
    const chip = [...view.cardEls.get('G-ccccc')
        .querySelectorAll('.dendrite-status-chip')]
        .find((s) => /versions/.test(s.textContent));
    assert.equal(chip && chip.textContent, '2 versions');
    assert.ok(view.cardEls.get('G-ccccc').classList.contains('has-stack'),
              'drawn with a card behind it');
    assert.ok(!view.cardEls.get('G-bbbbb').classList.contains('has-stack'));
    // Brought back from the stack.
    view.openStack('G-ccccc');
    const m = h.obsidian.lastModal;
    await m.ready;
    assert.match(m.contentEl.textContent, /Old paragraph/);
    await [...m.contentEl.querySelectorAll('button')]
        .find((b) => b.textContent === 'Make current').onclick();
    await tick();
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-aaaaa', 'G-bbbbb']);
    assert.deepEqual(view.byId.get('G-aaaaa').children.map((n) => n.id),
                     ['G-ccccc']);
    assert.doesNotMatch(read(cardPath('G-aaaaa')), /superseded/);
    assert.match(read(cardPath('G-ccccc')), /dendrite_superseded/);
    assert.match(await exported(view), /Old paragraph/);
    assert.doesNotMatch(await exported(view), /New paragraph/);
    // Each step undoes in one.
    await view.doUndo();
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-ccccc', 'G-bbbbb']);
    await view.doUndo();
    assert.equal(core.serialiseTree(view.root), core.serialiseTree(
        core.parseIndex(core.splitFrontmatter(STACK_INDEX).body).root));
    assert.doesNotMatch(read(cardPath('G-aaaaa')), /superseded/);
    assert.match(await exported(view), /Old paragraph[^]*New paragraph/);
});

test('a new version of a card starts empty in its place, with the old one ' +
     'stacked under it and its children moved up to the new one',
     async () => {
    const { view, read } = await open(STACK_INDEX, {
        'G-aaaaa': '# Aims\nOld.', 'G-ccccc': 'Child.', 'G-bbbbb': 'B.' });
    await view.select('G-aaaaa');
    view.cardMenu(view.cardEls.get('G-aaaaa'), null);
    await menuItem(h.obsidian.lastMenu, 'New version of this card').click();
    await tick();
    const top = view.root.children[0];
    assert.notEqual(top.id, 'G-aaaaa');
    assert.equal(view.editing && view.editing.id, top.id, 'editing it');
    assert.deepEqual(top.children.map((n) => n.id), ['G-ccccc', 'G-aaaaa'],
                     'its children, then the old card');
    assert.match(read(cardPath(top.id)), /dendrite_role: section/,
                 'prints as the old card did');
    assert.deepEqual(view.kidsOf(top).map((n) => n.id), ['G-ccccc']);
    // Moving the last shown child down passes no hidden card.
    await view.endEdit();
    await view.select('G-ccccc');
    await view.structural('down');
    assert.deepEqual(top.children.map((n) => n.id),
                     ['G-ccccc', 'G-aaaaa'], 'nothing to move past');
    // Undone while still empty, the new card goes.
    await view.doUndo();
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-aaaaa', 'G-bbbbb']);
    assert.equal(read(cardPath(top.id)), undefined, 'its note is gone');
});

test('an old version can be deleted from the stack, undoably',
     async () => {
    const { view, read } = await open(STACK_INDEX, {
        'G-aaaaa': '---\ndendrite_role: prose\n---\nOld.',
        'G-ccccc': 'New.', 'G-bbbbb': 'B.' });
    await view.promote('G-aaaaa', 'G-ccccc');
    await view.openStack('G-ccccc');
    await h.obsidian.lastModal.ready;
    await [...h.obsidian.lastModal.contentEl.querySelectorAll('button')]
        .find((b) => b.textContent === 'Delete').onclick();
    assert.equal(read(cardPath('G-aaaaa')), undefined);
    assert.deepEqual(view.byId.get('G-ccccc').children, []);
    await view.doUndo();
    assert.match(read(cardPath('G-aaaaa')), /Old\./);
    assert.deepEqual(view.byId.get('G-ccccc').children.map((n) => n.id),
                     ['G-aaaaa']);
});

test('a manuscript linked to a Google Doc pulls its comments and ' +
     'suggested changes into the review dialog, and offers it in Export',
     async () => {
    const { app, view, text } = await open(
        '---\ndendrite_prefix: G\ndendrite_gdoc: https://docs.google.com/' +
        'document/d/DOC1/edit\ndendrite_gdoc_title: RAC draft\n---\n' +
        '- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'Samples were collected between 2014 and 2023 ' +
          'under the protocol.' });
    let asked = null;
    view.plugin.gdocReview = async (url) => {
        asked = url;
        return { title: 'RAC draft', resolved: 2, items: [
            { kind: 'comment', author: 'Aly Karsan', date: '2026-10-24',
              text: 'Which protocol?', quote: 'the protocol',
              before: '', after: '' },
            { kind: 'change', author: 'Google Docs suggestion',
              date: '2026-10-24', quote: 'between 2014 and 2023',
              insert: 'from 2014 to 2023', before: 'collected ',
              after: ' under' }] };
    };
    assert.equal(view.gdocUrl(),
                 'https://docs.google.com/document/d/DOC1/edit');
    view.exportMenu(null, { preventDefault() {} });
    assert.ok(!h.obsidian.lastMenu.items.some((i) =>
        /review/i.test(i.title)), 'Export only exports');
    view.reviewMenu({ preventDefault() {} });
    assert.deepEqual(h.obsidian.lastMenu.items.map((i) => i.title), [
        'Pull from Google Docs', 'Open the linked doc',
        'Change the linked doc…', 'Import a Word or JSON file…',
        'Reviewers…', 'Mark as sent for review…']);
    const m = await view.pullGdoc();
    assert.equal(asked, view.gdocUrl());
    assert.match(m.titleEl.textContent, /RAC draft \(Google Docs\)/);
    assert.equal(m.rows.filter((r) => r.use).length, 2);
    await m.contentEl.querySelector('.mod-cta').onclick();
    assert.equal(text(cardPath('G-aaaaa')), 'Samples were collected ' +
        '%%{2%%between 2014 and 2023%%}2 [!suggest] Google Docs ' +
        'suggestion, 2026-10-24: from 2014 to 2023%% under %%{1%%the ' +
        'protocol%%}1 [!review] Aly Karsan, 2026-10-24: Which protocol?%%.');
    // Pulled again: nothing comes ticked.
    const again = await view.pullGdoc();
    assert.equal(again.rows.filter((r) => r.use).length, 0);
    view.plugin.gdocReview = async () => ({ title: 'RAC draft',
                                            resolved: 3, items: [] });
    h.notices.length = 0;
    assert.equal(await view.pullGdoc(), null);
    assert.match(h.notices[0], /no open comments .* 3 resolved left out/);
    void app;
});

test('the Google client and Picker key can be pasted into the settings, ' +
     'which come before the files', async () => {
    const DendritePlugin = require('../src/main.js');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dendrite-g-'));
    process.env.DENDRITE_CONFIG_DIR = dir;
    try {
        const p = new DendritePlugin();
        p.settings = { googleClientJson: '', googlePickerKey: '' };
        assert.equal(p.googleClient(), null);
        assert.equal(p.googlePickerKey(), '');
        fs.writeFileSync(path.join(dir, 'google-oauth-client.json'),
            JSON.stringify({ installed: { client_id: '1-file' } }));
        fs.writeFileSync(path.join(dir, 'google-api-key.txt'), 'FILEKEY\n');
        assert.equal(p.googleClient().clientId, '1-file');
        assert.equal(p.googlePickerKey(), 'FILEKEY');
        p.settings.googleClientJson = JSON.stringify({ installed: {
            client_id: '2-pasted', client_secret: 's' } });
        p.settings.googlePickerKey = ' PASTED ';
        assert.equal(p.googleClient().clientId, '2-pasted');
        assert.equal(p.googleClient().projectNumber, '2');
        assert.equal(p.googlePickerKey(), 'PASTED');
        p.settings.googleClientJson = 'not json';
        assert.equal(p.googleClient(), null, 'unreadable: none');
    } finally {
        delete process.env.DENDRITE_CONFIG_DIR;
        fs.rmSync(dir, { recursive: true });
    }
});

test('a card\'s old versions fan out in the column to its right, read ' +
     'only with their review comments, which can be resolved there, and ' +
     'fold away',
     async () => {
    const OLD = 'The ==old claim==%%[!review] Aly Karsan, 2026-10-23: ' +
        'Evidence?%% stands.';
    const { view, text } = await open(STACK_INDEX, {
        'G-aaaaa': '---\ndendrite_role: prose\n---\n' + OLD,
        'G-ccccc': 'New paragraph.', 'G-bbbbb': 'Next.' });
    await view.promote('G-aaaaa', 'G-ccccc');
    const chip = () => [...view.cardEls.get('G-ccccc')
        .querySelectorAll('.dendrite-status-chip')]
        .find((s) => /versions/.test(s.textContent));
    const fanned = () => [...view.board.parentElement.querySelectorAll(
        '.dendrite-fan .dendrite-fan-row > .dendrite-version')];
    assert.equal(fanned().length, 0);
    await chip().onclick({ stopPropagation() {} });
    await tick();
    assert.equal(fanned().length, 1, 'fanned out');
    const v = fanned()[0];
    assert.equal(v.dataset.id, 'G-aaaaa');
    assert.match(v.textContent, /Replaced \d{4}-/);
    assert.match(v.textContent, /old claim/);
    assert.equal(v.querySelectorAll('.dendrite-review-note').length, 1,
                 'its comment is drawn');
    assert.ok(!view.cardEls.has('G-aaaaa'), 'not a card on the board');
    await view.reviewAction('G-aaaaa', 0, 'resolve');
    await tick();
    assert.equal(text(cardPath('G-aaaaa')), 'The old claim stands.');
    assert.equal(fanned().length, 1, 'still fanned after resolving');
    assert.equal(fanned()[0].querySelectorAll('.dendrite-review-note')
        .length, 0);
    await view.doUndo();
    assert.equal(text(cardPath('G-aaaaa')), OLD, 'resolving undoes');
    await chip().onclick({ stopPropagation() {} });
    await tick();
    assert.equal(fanned().length, 0, 'folded away');
    // Drawn as a card, its text in a card's body; Escape folds it away.
    await chip().onclick({ stopPropagation() {} });
    assert.ok(fanned()[0].querySelector(
        ':scope > .dendrite-card-body .dendrite-md'));
    assert.ok(!fanned()[0].classList.contains('dendrite-card'),
              'not a card the board selects or edits');
    view.contentEl.dispatchEvent(new view.contentEl.ownerDocument
        .defaultView.KeyboardEvent('keydown', { key: 'Escape',
                                                bubbles: true }));
    await tick();
    assert.equal(fanned().length, 0, 'Escape folds it away');
    assert.equal(view.fannedId, null);
});

test('a review comment on wording only in an old version goes on the ' +
     'current card, quoted; one already in the stack comes unticked',
     async () => {
    const { view, text } = await open(STACK_INDEX, {
        'G-aaaaa': '---\ndendrite_role: prose\n---\nThe old claim ' +
            '==stands==%%[!review] Aly Karsan, 2026-10-23: Why?%%.',
        'G-ccccc': 'New paragraph.', 'G-bbbbb': 'Next.' });
    await view.promote('G-aaaaa', 'G-ccccc');
    const m = await view.reviewModal('Docs', [
        { kind: 'comment', author: 'Aly Karsan', date: '2026-10-24',
          text: 'Too strong.', quote: 'old claim', before: '', after: '' },
        { kind: 'comment', author: 'Aly Karsan', date: '2026-10-23',
          text: 'Why?', quote: 'stands', before: '', after: '' }]);
    assert.equal(m.rows[0].at.id, 'G-ccccc');
    assert.equal(m.rows[0].at.how, 'old');
    assert.equal(m.rows[0].use, true);
    assert.match(m.contentEl.textContent, /an earlier version/);
    assert.equal(m.rows[1].dup, true, 'already on the old version');
    assert.equal(m.rows[1].use, false);
    await m.contentEl.querySelector('.mod-cta').onclick();
    assert.equal(text(cardPath('G-ccccc')), 'New paragraph.%%[!review] ' +
        'Aly Karsan, 2026-10-24: On “old claim”, in an earlier version: ' +
        'Too strong.%%');
    assert.match(text(cardPath('G-aaaaa')), /^The old claim ==stands==/,
                 'the old version is left as it was');
});

test('pasting the Google client in the settings unlocks signing in ' +
     'without reopening them', () => {
    const { DendriteSettings } = require('../src/main.js');
    h.obsidian.settingsLog = [];
    const settings = { googleClientJson: '', googlePickerKey: '' };
    const plugin = { settings, saveSettings() {}, googleToken: () => null,
        googleClient: () => (settings.googleClientJson ?
            { clientId: 'x' } : null) };
    const tab = new DendriteSettings(SETTINGS_APP, plugin);
    tab.display();
    const named = (n) => h.obsidian.settingsLog.find((x) => x.name === n);
    const account = named('Google account');
    const button = account.controls[0];
    assert.equal(button.disabled, true);
    assert.match(account.desc, /Paste the OAuth client above first/);
    named('Google OAuth client').controls[0]._onChange(
        '{"installed": {"client_id": "1-x"}}');
    assert.equal(button.disabled, false, 'unlocked');
    assert.match(account.desc, /Not signed in/);
    named('Google OAuth client').controls[0]._onChange('');
    assert.equal(button.disabled, true, 'locked again when cleared');
});

test('the Review menu offers linking a doc when none is, and each review ' +
     'waiting from a program', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'Text.' });
    view.inbox = [{ id: 'r1', title: 'RAC review', received: '2026-10-24',
                    items: [{ author: 'Claude' }, { author: 'Claude' }] }];
    let opened = null;
    view.openInbox = async (e) => { opened = e; };
    view.reviewMenu({ preventDefault() {} });
    const titles = h.obsidian.lastMenu.items.map((i) => i.title);
    assert.deepEqual(titles, ['Link a Google Doc…',
        'Import a Word or JSON file…', 'Reviewers…',
        'Mark as sent for review…', 'RAC review: 2 from Claude']);
    await h.obsidian.lastMenu.items[4].click();
    assert.equal(opened.id, 'r1');
});

test('the manuscript settings are in tabs, the header and footer as a ' +
     'grid of their slots, and Save writes what changed in any tab',
     async () => {
    const { view, read } = await open(
        '---\ndendrite_prefix: G\ndendrite_header_left: Aly Karsan\n---\n' +
        '- [[G-aaaaa|A]]\n', { 'G-aaaaa': 'Text.' });
    h.obsidian.settingsLog = [];
    view.openManuscriptSettings();
    const m = h.obsidian.lastModal;
    const tabs = [...m.contentEl.querySelectorAll('.dendrite-ms-tab')]
        .map((t) => t.textContent);
    assert.deepEqual(tabs, ['Manuscript', 'Length', 'Page',
                            'Header and footer', 'References', 'Review']);
    const panes = [...m.contentEl.querySelectorAll('.dendrite-ms-pane')];
    const shown = () => panes.filter((p) =>
        !p.classList.contains('is-hidden')).map((p) => p.dataset.tab);
    assert.deepEqual(shown(), ['Manuscript']);
    const inTab = (t) => h.obsidian.settingsLog.filter((x) =>
        x.container === panes.find((p) => p.dataset.tab === t))
        .map((x) => x.name);
    assert.deepEqual(inTab('Manuscript'), ['Title and prefix',
        'Number sections by position', 'Top section heading level']);
    assert.deepEqual(inTab('Length'), ['Total quota', 'Hard limit',
        'Count spaces in characters',
        'Words per page', 'Characters per word']);
    assert.deepEqual(inTab('Page'), ['Font', 'Font size', 'Line spacing',
        'Paper', 'Margin', 'Space above footnotes']);
    assert.deepEqual(inTab('Header and footer'), [
        'Header and footer in the margin', 'Page numbers']);
    assert.deepEqual(inTab('References'), ['Citation style',
        'Reference list heading', 'Word reference document',
        'Pandoc defaults file']);
    assert.deepEqual(inTab('Review'), ['Google Doc']);
    // The header and footer slots, as on a page.
    const grid = m.contentEl.querySelector('.dendrite-hf-grid');
    const slots = [...grid.querySelectorAll('textarea')];
    assert.equal(slots.length, 6);
    assert.equal(slots[0].value, 'Aly Karsan', 'header left');
    m.contentEl.querySelectorAll('.dendrite-ms-tab')[3].click();
    assert.deepEqual(shown(), ['Header and footer']);
    slots[5].value = '{page}';
    slots[5].dispatchEvent(new slots[5].ownerDocument.defaultView
        .Event('input'));
    await [...m.contentEl.querySelectorAll('.dendrite-ms-foot button')]
        .find((b) => b.textContent === 'Save').onclick();
    assert.match(read(INDEX), /dendrite_footer_right: ["']?\{page\}/);
    assert.match(read(INDEX), /dendrite_header_left: Aly Karsan/);
    // It opens again where it was left.
    view.openManuscriptSettings();
    const again = [...h.obsidian.lastModal.contentEl.querySelectorAll(
        '.dendrite-ms-pane')].filter((p) =>
        !p.classList.contains('is-hidden')).map((p) => p.dataset.tab);
    assert.deepEqual(again, ['Header and footer']);
});

test('a pulled comment keeps its Google Docs link on the card, and one ' +
     'resolved here comes unticked when pulled again', async () => {
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\ndendrite_gdoc: https://docs.google.com/' +
        'document/d/D1/edit\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'The cohort is composed of paired samples.' });
    const url = 'https://docs.google.com/document/d/D1/edit?disco=AAA1';
    const pulled = () => ({ title: 'RAC', resolved: 0, items: [
        { kind: 'comment', author: 'Aly Karsan', date: '2026-10-24',
          text: 'How many?', quote: 'paired samples', before: '',
          after: '', gid: 'AAA1', link: url }] });
    view.plugin.gdocReview = async () => pulled();
    const m = await view.pullGdoc();
    assert.ok([...m.contentEl.querySelectorAll('a')].some((a) =>
        a.textContent === 'Open in Google Docs' && a.href === url));
    await m.contentEl.querySelector('.mod-cta').onclick();
    assert.equal(text(cardPath('G-aaaaa')), 'The cohort is composed of ' +
        `%%{1%%paired samples%%}1 [!review] Aly Karsan, 2026-10-24: How ` +
        `many? ` +
        `${url}%%.`);
    view.invalidate('G-aaaaa');
    await view.renderCard('G-aaaaa');
    const note = view.cardEls.get('G-aaaaa')
        .querySelector('.dendrite-review-note');
    assert.equal(note.querySelector('.dendrite-review-text').textContent,
                 'How many?', 'the link is not shown as text');
    assert.equal(note.querySelector('a.dendrite-review-link').href, url);
    await view.reviewAction('G-aaaaa', 0, 'resolve');
    assert.equal(text(cardPath('G-aaaaa')),
                 'The cohort is composed of paired samples.');
    assert.match(read(INDEX), /dendrite_review_done:[^]*g:AAA1/,
                 'remembered on the index');
    // Pulled again, the coauthor having edited the comment's text.
    view.plugin.gdocReview = async () => {
        const r = pulled();
        r.items[0].text = 'How many samples?';
        return r;
    };
    const again = await view.pullGdoc();
    assert.equal(again.rows[0].done, true);
    assert.equal(again.rows[0].use, false);
    assert.match(again.contentEl.textContent, /Resolved here before/);
    assert.match(again.contentEl.textContent, /1 resolved here before/);
});

test('the flow takes a card with old versions from the top of its stack',
     async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'Text.' });
    const card = view.cardEls.get('G-aaaaa');
    // Styles are computed only for a card in a document, as on the board.
    card.ownerDocument.body.appendChild(view.contentEl);
    card.getBoundingClientRect = () => ({ left: 10, right: 210, top: 100,
                                          bottom: 160 });
    const box = { left: 0, top: 0 };
    assert.equal(view.flowBox(card, box, 0).top, 100);
    card.classList.add('has-stack');
    card.style.marginTop = '18px';
    assert.equal(view.flowBox(card, box, 0).top, 82, 'up by its stack');
    assert.equal(view.flowBox(card, box, 0).bottom, 160);
});

test('the card menu: status first, then what it prints, its versions and ' +
     'its place in the tree each in a submenu, export and the card\'s ' +
     'note, and delete alone at the foot', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
        '    - [[G-ccccc|C]]\n', { 'G-aaaaa': '---\ndendrite_role: ' +
        'prose\n---\nOld.', 'G-ccccc': 'New.' });
    await view.promote('G-aaaaa', 'G-ccccc');
    await view.select('G-ccccc');
    view.cardMenu(view.cardEls.get('G-ccccc'), null);
    const m = h.obsidian.lastMenu;
    assert.deepEqual(m.titles, ['Status: draft', 'Status: done',
        'Status: revise', '---', 'Prints as', 'Versions', 'Structure',
        '---', 'Export this branch', 'Card properties…', 'Copy reference',
        'Open card note', '---', 'Delete card and its children']);
    const del = m.items.find((i) => /^Delete/.test(i.title));
    assert.deepEqual([...del.titleContent.querySelectorAll('kbd')]
        .map((k) => k.dataset.k), ['Ctrl', 'Backspace'],
                     'each key a keycap');
    assert.ok(m.items.find((i) => /^Delete card/.test(i.title)).warning,
              'deleting a card, in the warning colour');
    assert.deepEqual(submenuOf(m, 'Versions').titles, [
        'New version of this card', 'Show old versions',
        'Make an old version current, or delete one…']);
    const st = submenuOf(m, 'Structure');
    assert.deepEqual(st.titles, ['New card above', 'Move up', 'Move down',
        'Indent', 'Outdent', '---', 'Merge into the card above',
        'Merge into the parent card']);
    assert.deepEqual(st.items.map((i) => i.icon || ''),
                     ['', '', '', '', '', 'merge', 'git-merge'],
                     'the keys show the arrows; the merges are marked');
    await menuItem(m, 'Show old versions').click();
    assert.equal(view.fannedId, 'G-ccccc');
    view.cardMenu(view.cardEls.get('G-ccccc'), null);
    assert.ok(menuItem(h.obsidian.lastMenu, 'Hide old versions'));
});

test('replacing a card clears the old one\'s status and starts the new ' +
     'one as draft, unless it already has one', async () => {
    const { view, read } = await open(STACK_INDEX, {
        'G-aaaaa': '---\ndendrite_role: prose\ndendrite_status: revise\n' +
            '---\nOld.',
        'G-ccccc': '---\ndendrite_status: done\n---\nNew.',
        'G-bbbbb': '---\ndendrite_status: done\n---\nNext.' });
    await view.promote('G-aaaaa', 'G-ccccc');
    await tick(20);
    assert.doesNotMatch(read(cardPath('G-aaaaa')), /dendrite_status/,
                        'the old version prints nothing, so has none');
    assert.match(read(cardPath('G-ccccc')), /dendrite_status: done/,
                 'the replacement keeps its own');
    await view.endEdit();
    await view.promote('G-bbbbb');
    await tick(20);
    const fresh = view.root.children.find((n) =>
        !['G-ccccc', 'G-bbbbb'].includes(n.id));
    assert.match(read(cardPath(fresh.id)), /dendrite_status: draft/,
                 'a new version starts as draft');
    // Brought back from its stack, an old version starts as draft.
    await view.endEdit();
    await view.promote('G-ccccc', 'G-aaaaa');
    await tick(20);
    assert.match(read(cardPath('G-aaaaa')), /dendrite_status: draft/);
});

test('the preview can show review comments as bubbles beside the text, ' +
     'step through them in reading order, and act on them', async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|Aims]]\n    - [[G-bbbbb|p]]\n- [[G-ccccc|q]]\n');
    const card = (id, text) => app.vault.create(cardPath(id), text);
    const url = 'https://docs.google.com/document/d/D/edit?disco=A1';
    await card('G-aaaaa', '# Aims\nPlanning ==notes==%%[!review] R, ' +
               '2026-10-24: Not printed.%%');
    await card('G-bbbbb', 'The ==cohort==%%[!review] Aly Karsan, ' +
               `2026-10-24: How many? ${url}%% is ==large==` +
               '%%[!suggest] Aly Karsan, 2026-10-24: big%%.');
    await card('G-ccccc', 'Plan ==here==%%[!review] Claude, ' +
               '2026-10-23: Say when.%%');
    const focused = [];
    const acted = [];
    // Selecting a card on the board marks it active in the preview, as
    // the board does.
    const plugin = { settings: { headingTop: 1 },
        focusCard: (f, id, edit) => {
            focused.push(id);
            view.highlight(id);
        },
        reviewFromPreview: async (f, id, n, what) =>
            acted.push([id, n, what]) };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    await view.setState({ file: INDEX });
    await tick(20);
    const bubbles = () => [...view.contentEl.querySelectorAll(
        '.dendrite-pbubble')];
    assert.equal(bubbles().length, 0, 'off at first');
    const toggle = [...view.contentEl.querySelectorAll('.dendrite-bar-btn')]
        .find((b) => b.textContent === 'Comments');
    toggle.onclick();
    await tick(30);
    assert.ok(toggle.hasClass('is-on'));
    assert.equal(view.getState().showComments, true);
    // Only what prints: the heading card's notes are not in the document.
    assert.deepEqual(bubbles().map((b) => b.querySelector(
        '.dendrite-pbubble-text').textContent),
        ['How many?', 'Suggests: big', 'Say when.']);
    // One gutter for the document: the cards' parts keep their height.
    assert.ok(bubbles().every((x) =>
        x.closest('.dendrite-pgutter') && !x.closest('.dendrite-pblock')));
    assert.ok([...view.blocks.values()].every((x) =>
        x.el.style.minHeight === ''));
    // A card selected: the other cards' comments fade, and its own are
    // drawn from the card's top.
    view.highlight('G-ccccc');
    assert.deepEqual(bubbles().map((x) => x.hasClass('is-faded')),
                     [true, true, false]);
    assert.deepEqual(view.bubbleFocus(bubbles()), { index: 2, at: 'card' });
    view.highlight('G-bbbbb');
    assert.deepEqual(view.bubbleFocus(bubbles()), { index: 0, at: 'card' },
                     'its first comment');
    view.highlight('G-aaaaa');
    assert.deepEqual(bubbles().map((x) => x.hasClass('is-faded')),
                     [false, false, false], 'one with none fades none');
    const first = bubbles()[0];
    assert.match(first.textContent, /Aly Karsan/);
    assert.equal(first.querySelector('a').href, url);
    assert.ok(view.doc.hasClass('has-comments'));
    // The widths are the stylesheet's, from the pane's: nothing set here
    // that would hold while a pane is resized.
    assert.equal(view.doc.style.paddingLeft, '');
    assert.equal(view.doc.style.maxWidth, '');
    const label = () => view.contentEl.querySelector(
        '.dendrite-pcomments-pos').textContent;
    assert.equal(label(), '3 comments');
    const nav = (t) => [...view.contentEl.querySelectorAll(
        '.dendrite-pcomments-nav button')].find((b) =>
        b.getAttribute('aria-label') === t);
    await nav('Next comment').onclick();
    assert.equal(label(), '1 of 3');
    assert.deepEqual(focused, ['G-bbbbb'], 'its card is selected');
    assert.deepEqual(view.bubbleFocus(bubbles()), { index: 0, at: 'mark' },
                     'the comment gone to, at its mark');
    view.highlight('G-ccccc');
    assert.deepEqual(view.bubbleFocus(bubbles()), { index: 2, at: 'card' },
                     'a card clicked since takes over');
    view.highlight('G-bbbbb');
    assert.ok(bubbles()[0].hasClass('is-current'));
    // Its passage in the text is marked as the one gone to; hovering a
    // bubble marks its passage too.
    const block = view.blocks.get('G-bbbbb').el;
    const passage = (n) => view.passageOf(block, n);
    assert.deepEqual(passage(0).map((e) => e.textContent), ['cohort', '1'],
                     'the marked text and its number');
    assert.ok(passage(0).every((e) => e.hasClass('is-current')));
    assert.ok(!passage(1).some((e) => e.hasClass('is-current')));
    bubbles()[1].dispatchEvent(new h.window.MouseEvent('mouseenter'));
    assert.ok(passage(1).every((e) => e.hasClass('is-hover')));
    bubbles()[1].dispatchEvent(new h.window.MouseEvent('mouseleave'));
    assert.ok(!passage(1).some((e) => e.hasClass('is-hover')));
    await nav('Next comment').onclick();
    await nav('Next comment').onclick();
    assert.equal(label(), '3 of 3');
    assert.ok(bubbles()[2].hasClass('is-current'));
    await nav('Next comment').onclick();
    assert.equal(label(), '1 of 3', 'round to the first');
    await nav('Previous comment').onclick();
    assert.equal(label(), '3 of 3');
    // Clicking a bubble goes to its comment: its passage brought into
    // view, its card selected, the count where it is.
    focused.length = 0;
    const passageNow = view.passageOf(view.blocks.get('G-bbbbb').el, 1)[0];
    let scrolledTo = null;
    passageNow.scrollIntoView = (o) => { scrolledTo = o; };
    bubbles()[1].dispatchEvent(new h.window.MouseEvent('click',
                                                       { bubbles: true }));
    await tick(10);
    assert.equal(label(), '2 of 3');
    assert.deepEqual(focused, ['G-bbbbb']);
    assert.ok(bubbles()[1].hasClass('is-current'));
    assert.equal(scrolledTo && scrolledTo.block, 'center',
                 'out of view, brought to the middle');
    bubbles()[2].dispatchEvent(new h.window.MouseEvent('click',
                                                       { bubbles: true }));
    await tick(10);
    assert.equal(label(), '3 of 3');
    // Acting on a bubble acts on its card's comment, on the board.
    await [...bubbles()[1].querySelectorAll('button')]
        .find((b) => b.textContent === 'Dismiss').onclick();
    await [...bubbles()[2].querySelectorAll('button')]
        .find((b) => b.textContent === 'Resolve').onclick();
    assert.deepEqual(acted, [['G-bbbbb', 1, 'dismiss'],
                             ['G-ccccc', 0, 'resolve']]);
    // The current comment resolved, the next one is gone to: in view,
    // its card selected, and the count where it was.
    await nav('Next comment').onclick();
    assert.equal(label(), '1 of 3');
    focused.length = 0;
    await app.vault.modify(app.vault.getAbstractFileByPath(
        cardPath('G-bbbbb')), 'The cohort is ==large==%%[!suggest] Aly ' +
        'Karsan, 2026-10-24: big%%.');
    await view.refresh();
    await tick(30);
    assert.equal(label(), '1 of 2');
    assert.ok(bubbles()[0].hasClass('is-current'));
    assert.match(bubbles()[0].textContent, /Suggests: big/);
    assert.deepEqual(focused, ['G-bbbbb']);
    await nav('Next comment').onclick();
    assert.equal(label(), '2 of 2', 'on to the one after, none skipped');
    toggle.onclick();
    await tick(30);
    assert.equal(bubbles().length, 0);
    assert.ok(!view.doc.hasClass('has-comments'));
    assert.equal(view.doc.style.paddingLeft, '', 'spaced as before');
    // Off, each card's part is as tall as its text again: none keeps the
    // room its bubbles took.
    for (const b of view.blocks.values()) {
        assert.equal(b.el.style.minHeight, '', `${b.el.dataset.id} held`);
        assert.ok(!b.el.hasClass('has-bubbles'));
    }
});

test('the board\'s Preview button opens the preview and closes it again, ' +
     'lit while it is open', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'Text.' });
    let shown = false;
    view.plugin.previewOpen = () => shown;
    view.plugin.togglePreview = async () => { shown = !shown; };
    view.render();
    const btn = [...view.contentEl.querySelectorAll('.dendrite-bar-btn')]
        .find((b) => b.textContent === 'Preview');
    assert.ok(!btn.hasClass('is-on'));
    await btn.onclick();
    assert.ok(btn.hasClass('is-on'));
    await btn.onclick();
    assert.ok(!btn.hasClass('is-on'));
});

test('bar buttons that open a menu carry a caret; ones that switch a view ' +
     'do not', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'Text.' });
    const caret = (t) => !![...view.contentEl.querySelectorAll(
        '.dendrite-bar-btn')].find((b) => b.textContent === t)
        .querySelector('.dendrite-bar-caret');
    assert.deepEqual(['Export', 'Review', 'All', 'Printed', 'Preview']
        .map(caret), [true, true, false, false, false]);
});

test('icons: one meaning each across the bars and menus, and a menu has ' +
     'one on every item or on none', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\ndendrite_gdoc: https://docs.google.com/' +
        'document/d/D/edit\n---\n- [[G-aaaaa|A]]\n    - [[G-ccccc|C]]\n' +
        '    - [[G-ddddd|D]]\n', { 'G-aaaaa': '---\ndendrite_role: prose\n' +
        '---\nOld.', 'G-ccccc': 'New.', 'G-ddddd': 'D.' });
    await view.promote('G-aaaaa', 'G-ccccc');
    await view.select('G-ccccc');
    // Every icon, with what it is on.
    const uses = [];
    const menus = [];
    const walk = (menu, where) => {
        menus.push([where, menu]);
        for (const i of menu.items || []) {
            if (i.icon) uses.push([i.icon, i.title.replace(/ \(.*\)$/, '')]);
            if (i.submenu) walk(i.submenu, `${where} › ${i.title}`);
        }
    };
    view.cardMenu(view.cardEls.get('G-ccccc'), null);
    walk(h.obsidian.lastMenu, 'card');
    walk(view.reviewMenu(null), 'review');
    view.exportMenu(null, null);
    walk(h.obsidian.lastMenu, 'export');
    for (const b of view.contentEl.querySelectorAll('.dendrite-bar-btn')) {
        const icon = b.querySelector('[data-icon]');
        if (icon) uses.push([icon.dataset.icon,
                             b.getAttribute('aria-label').split(/[,:.]/)[0]]);
    }
    // A fold-out is a heading for its group: no icon. A menu with no
    // icons at all keeps no room for them; one with some keeps room on
    // every row, so its labels line up.
    for (const [where, menu] of menus) {
        for (const i of menu.items || []) {
            assert.ok(!(i.submenu && i.icon),
                      `${where} › ${i.title} folds out and has an icon`);
        }
        const n = (menu.items || []).filter((i) => i.icon).length;
        if (menu.items && menu.items.length) {
            assert.equal(menu.dendriteIcons, n > 0,
                `${where}: ${n} icons, but made with icons ` +
                `${menu.dendriteIcons}`);
        }
    }
    // The same icon only for the same thing.
    const same = [
        ['Move down', 'Move this card down'],
        ['Card properties…', 'This card\'s label and limit'],
        ['Export this branch', 'Export the manuscript'],
    ];
    const meaning = (t) => (same.find((g) => g.some((x) =>
        t.startsWith(x))) || [t])[0];
    const byIcon = new Map();
    for (const [icon, title] of uses) {
        if (!byIcon.has(icon)) byIcon.set(icon, new Set());
        byIcon.get(icon).add(meaning(title));
    }
    for (const [icon, titles] of byIcon) {
        assert.equal(titles.size, 1,
                     `${icon} means more than one thing: ${[...titles]}`);
    }
});

test('which cards the board shows is a switch between All and Printed, ' +
     'the view shown lit', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'Text.' });
    const seg = () => [...view.contentEl.querySelectorAll(
        '.dendrite-seg .dendrite-seg-btn')];
    const lit = () => seg().filter((b) => b.hasClass('is-on'))
        .map((b) => b.textContent);
    assert.deepEqual(seg().map((b) => b.textContent), ['All', 'Printed']);
    assert.deepEqual(lit(), ['All']);
    seg()[0].onclick();
    assert.equal(view.printOnly, false, 'the view shown: nothing changes');
    seg()[1].onclick();
    assert.equal(view.printOnly, true);
    assert.deepEqual(lit(), ['Printed']);
    seg()[0].onclick();
    assert.equal(view.printOnly, false);
    assert.deepEqual(lit(), ['All']);
});

test('a card that prints and has cards below sets theirs from a Cards ' +
     'below fold-out after its own statuses', async () => {
    const { view, read } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n' +
        '    - [[G-bbbbb|B]]\n', { 'G-aaaaa': '---\ndendrite_role: ' +
        'prose\n---\nA text.', 'G-bbbbb': 'B text.' });
    await view.select('G-aaaaa');
    await view.updateStatuses();
    view.cardMenu(view.cardEls.get('G-aaaaa'), null);
    const m = h.obsidian.lastMenu;
    assert.deepEqual(m.titles.slice(0, 5), ['Status: draft', 'Status: done',
        'Status: revise', 'Cards below', '---']);
    const below = submenuOf(m, 'Cards below');
    assert.deepEqual(below.titles, ['Status: draft', 'Status: done',
                                    'Status: revise']);
    await below.items[2].click();
    await tick(30);
    assert.match(read(cardPath('G-bbbbb')), /dendrite_status: revise/);
    assert.doesNotMatch(read(cardPath('G-aaaaa')), /revise/,
                        'its own is its own');
});

const SEVEN = '---\ndendrite_prefix: G\ndendrite_number_sections: true\n' +
    '---\n' + ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) =>
    `- [[G-${x.repeat(5)}|${x}]]\n`).join('') + '    - [[G-hhhhh|h]]\n';
const sevenCards = () => Object.fromEntries(
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) =>
        [`G-${x.repeat(5)}`, `# ${x.toUpperCase()}\nText ${x}.`]));
const click = (view, id, mods = {}) => view.cardEls.get(id).dispatchEvent(
    new h.window.MouseEvent('click', { bubbles: true, ...mods }));

test('cards are picked with Ctrl-click, a run of them with Shift-click, ' +
     'and a plain click or Escape lets them go', async () => {
    const { view } = await open(SEVEN, sevenCards());
    const picked = () => [...view.picked].sort();
    click(view, 'G-aaaaa');
    await tick(10);
    click(view, 'G-ccccc', { ctrlKey: true });
    await tick(10);
    assert.deepEqual(picked(), ['G-aaaaa', 'G-ccccc']);
    assert.ok(view.cardEls.get('G-ccccc').hasClass('is-picked'));
    click(view, 'G-ccccc', { ctrlKey: true });
    await tick(10);
    assert.deepEqual(picked(), ['G-aaaaa'], 'Ctrl-click again lets go');
    click(view, 'G-ddddd', { shiftKey: true });
    await tick(10);
    assert.deepEqual(picked(), ['G-aaaaa', 'G-bbbbb', 'G-ccccc', 'G-ddddd'],
                     'Shift-click picks the run between');
    click(view, 'G-hhhhh', { shiftKey: true });
    await tick(10);
    assert.deepEqual(picked(), ['G-aaaaa', 'G-bbbbb', 'G-ccccc', 'G-ddddd'],
                     'a run is of cards side by side, under one parent');
    view.contentEl.dispatchEvent(new h.window.KeyboardEvent('keydown',
        { key: 'Escape', bubbles: true }));
    assert.deepEqual(picked(), []);
    click(view, 'G-bbbbb', { ctrlKey: true });
    await tick(10);
    click(view, 'G-eeeee');
    await tick(10);
    assert.deepEqual(picked(), [], 'a plain click picks one card only');
    assert.equal(view.active, 'G-eeeee');
});

test('picked cards are grouped under a new card, as a section with a ' +
     'heading or as scaffolding, in one step to undo', async () => {
    const { view, read, text } = await open(SEVEN, sevenCards());
    const before = core.serialiseTree(view.root);
    for (const id of ['G-aaaaa', 'G-bbbbb', 'G-ccccc', 'G-ddddd']) {
        view.picked.add(id);
    }
    await view.groupPicked('section');
    const top = view.root.children.map((n) => n.id);
    const group = top[0];
    assert.deepEqual(top.slice(1), ['G-eeeee', 'G-fffff', 'G-ggggg']);
    assert.deepEqual(view.byId.get(group).children.map((n) => n.id),
                     ['G-aaaaa', 'G-bbbbb', 'G-ccccc', 'G-ddddd']);
    assert.equal(text(cardPath(group)), '# ', 'a heading to write');
    assert.equal(view.editing && view.editing.id, group);
    assert.equal(view.picked.size, 0);
    await view.endEdit();
    await view.doUndo();
    assert.equal(core.serialiseTree(view.root), before, 'one step undoes');
    assert.equal(read(cardPath(group)), undefined, 'its note goes too');
    // As scaffolding: the cards below keep their numbers and levels.
    for (const id of ['G-eeeee', 'G-fffff', 'G-ggggg']) view.picked.add(id);
    await view.groupPicked('scaffolding');
    const sc = view.root.children[4].id;
    assert.deepEqual(view.byId.get(sc).children.map((n) => n.id),
                     ['G-eeeee', 'G-fffff', 'G-ggggg']);
    assert.match(read(cardPath(sc)), /dendrite_role: scaffolding/);
    const nums = core.sectionNumbers(view.root.children,
        (id) => /^#/.test(text(cardPath(id)) || ''),
        (id) => view.printRoleOf(id), (id) => view.kindOf(id));
    assert.equal(nums.get('G-eeeee'), '5.', 'numbered as before');
    // Cards not side by side are not grouped.
    view.picked.clear();
    view.picked.add('G-aaaaa');
    view.picked.add('G-hhhhh');
    const now = core.serialiseTree(view.root);
    h.notices.length = 0;
    await view.groupPicked('section');
    assert.equal(core.serialiseTree(view.root), now);
    assert.match(h.notices[0], /side by side under one parent/);
});

test('with cards picked, the card menu acts on all of them, and grouping ' +
     'asks what the group is', async () => {
    const { view, read } = await open(SEVEN, sevenCards());
    click(view, 'G-aaaaa');
    await tick(10);
    click(view, 'G-ccccc', { shiftKey: true });
    await tick(10);
    view.cardMenu(view.cardEls.get('G-bbbbb'), null);
    const m = h.obsidian.lastMenu;
    assert.equal(m.titles[0], '3 cards picked');
    await menuItem(m, 'Status: revise').click();
    await tick(20);
    for (const id of ['G-aaaaa', 'G-bbbbb', 'G-ccccc']) {
        assert.match(read(cardPath(id)), /dendrite_status: revise/);
    }
    await view.doUndo();
    for (const id of ['G-aaaaa', 'G-bbbbb', 'G-ccccc']) {
        assert.doesNotMatch(read(cardPath(id)), /revise/, 'one undo');
    }
    view.cardMenu(view.cardEls.get('G-bbbbb'), null);
    await menuItem(h.obsidian.lastMenu, 'Group into a new card…').click();
    const g = h.obsidian.lastModal;
    assert.match(g.contentEl.textContent, /section/);
    assert.match(g.contentEl.textContent, /[Ss]caffolding/);
    await [...g.contentEl.querySelectorAll('button')].find((b) =>
        /Scaffolding/.test(b.textContent)).onclick();
    assert.equal(view.root.children[0].children.length, 3);
    // Delete takes every picked card.
    await view.endEdit();
    view.picked.add('G-eeeee');
    view.picked.add('G-fffff');
    // Right-clicking a picked card makes it the active one, picks kept.
    await view.select('G-eeeee', false);
    assert.equal(view.picked.size, 2);
    view.cardMenu(view.cardEls.get('G-eeeee'), null);
    await menuItem(h.obsidian.lastMenu, /^Delete 2 cards/).click();
    assert.ok(!view.byId.has('G-eeeee') && !view.byId.has('G-fffff'));
    await view.doUndo();
    assert.ok(view.byId.has('G-eeeee') && view.byId.has('G-fffff'));
});

test('an old version with open comments shows on its card, so they are ' +
     'not buried in the stack', async () => {
    const { view } = await open(STACK_INDEX, {
        'G-aaaaa': '---\ndendrite_role: prose\n---\nThe ==old claim==' +
            '%%[!review] Aly Karsan, 2026-10-23: Evidence?%% stands.',
        'G-ccccc': 'New paragraph.', 'G-bbbbb': 'Next.' });
    await view.promote('G-aaaaa', 'G-ccccc');
    await view.stackOpenReady;
    const chip = () => [...view.cardEls.get('G-ccccc')
        .querySelectorAll('.dendrite-status-chip')]
        .find((s) => /versions/.test(s.textContent));
    assert.equal(chip().textContent, '2 versions · 1 open');
    assert.ok(chip().hasClass('is-revise'));
    assert.ok(view.cardEls.get('G-ccccc').hasClass('has-stack-open'));
    // Fanned out, the old version is a card with its own flag, and the
    // card it was replaced by shows only how many versions there are.
    await view.toggleFan('G-ccccc');
    await view.stackOpenReady;
    const v = () => view.board.parentElement
        .querySelector('.dendrite-version');
    const flag = () => v().querySelector('.dendrite-status-chip');
    assert.equal(flag() && flag().textContent, '1 open ⚑');
    assert.ok(flag().hasClass('is-revise'));
    assert.equal(chip().textContent, '2 versions');
    assert.ok(!chip().hasClass('is-revise'));
    assert.ok(!view.cardEls.get('G-ccccc').hasClass('has-stack-open'));
    assert.ok(view.cardEls.get('G-ccccc').hasClass('is-fanned'),
              'fanned out: no cards drawn behind it');
    await view.reviewAction('G-aaaaa', 0, 'resolve');
    await view.stackOpenReady;
    assert.equal(flag(), null, 'resolved: its flag goes');
    await view.toggleFan('G-ccccc');
    await view.stackOpenReady;
    assert.equal(chip().textContent, '2 versions');
    assert.ok(!view.cardEls.get('G-ccccc').hasClass('has-stack-open'));
    assert.ok(!view.cardEls.get('G-ccccc').hasClass('is-fanned'),
              'folded: the cards behind it again');
});

const FLOAT_INDEX = '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|Fig]]\n' +
    '- [[G-bbbbb|Tab]]\n- [[G-ccccc|Plain]]\n';
const floatCards = () => ({
    'G-aaaaa': '---\ndendrite_kind: figure\n---\n![[old.png]]\n\nOld caption.',
    'G-bbbbb': '---\ndendrite_kind: table\n---\nPer year.\n\n| A | B |\n' +
        '| --- | --- |\n| 1 | 2 |',
    'G-ccccc': 'Some text.' });

test('a figure card is edited in the card, widened to the page\'s text: ' +
     'one image, replaced by one pasted, and a caption', async () => {
    const { app, view, text } = await open(FLOAT_INDEX, floatCards());
    await view.startEdit('G-aaaaa');
    const ed = view.editing.editor;
    assert.equal(ed.kind, 'float');
    assert.ok(view.cardEls.get('G-aaaaa').hasClass('is-float-editing'));
    const form = view.contentEl.querySelector('.dendrite-float-edit');
    assert.ok(form && !form.closest('.dendrite-col'),
              'drawn over the board, so it can be wider than a column');
    assert.match(form.style.width, /pt$/, 'as wide as the page\'s text');
    const cap = form.querySelector(
        '.dendrite-float-field:not(.dendrite-float-image) textarea');
    assert.equal(cap.value, 'Old caption.');
    cap.value = 'New caption.';
    cap.dispatchEvent(new h.window.Event('input'));
    // An image pasted: saved in figures/ beside the index, named for the
    // card, and the card's one image.
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
    await ed.take({ files: [{ name: 'Screenshot 1.png', type: 'image/png',
                              arrayBuffer: async () => bytes }],
                    getData: () => '' });
    assert.ok(app.vault.binaries.has('W/Grant/figures/G-aaaaa.png'));
    await view.endEdit();
    assert.equal(text(cardPath('G-aaaaa')),
                 '![[figures/G-aaaaa.png]]\n\nNew caption.');
    // A link dropped replaces it; a second paste does not overwrite the
    // first file.
    await view.startEdit('G-aaaaa');
    await view.editing.editor.take({ files: [],
        getData: () => '[[other.png]]' });
    await view.endEdit();
    assert.equal(text(cardPath('G-aaaaa')),
                 '![[other.png]]\n\nNew caption.');
    await view.startEdit('G-aaaaa');
    await view.editing.editor.take({ files: [{ name: 'b.png',
        type: 'image/png', arrayBuffer: async () => bytes }],
        getData: () => '' });
    assert.ok(app.vault.binaries.has('W/Grant/figures/G-aaaaa-2.png'));
    await view.endEdit();
    assert.ok(!view.contentEl.querySelector('.dendrite-float-edit'),
              'the wide form goes when editing ends');
    assert.ok(!view.cardEls.get('G-aaaaa').hasClass('is-float-editing'));
});

test('a table card is edited with its caption, its table as it prints, ' +
     'and its markdown; Edit as text gives the plain editor', async () => {
    const { view, text } = await open(FLOAT_INDEX, floatCards());
    await view.startEdit('G-bbbbb');
    const form = view.contentEl.querySelector('.dendrite-float-edit');
    // Both in the card editor, Obsidian's where it has one, whose live
    // preview edits a table as a grid; the text box in the tests.
    const [cap, table] = form.querySelectorAll('textarea.dendrite-editor');
    assert.equal(cap.value, 'Per year.');
    assert.equal(table.value, '| A | B |\n| --- | --- |\n| 1 | 2 |');
    assert.equal(form.querySelector('.dendrite-float-number').textContent,
                 'Table 1.', 'its number above the table');
    assert.ok(!form.querySelector('.dendrite-float-shown'),
              'shown once, in the editor, not again above it');
    table.value = '| A | B |\n| --- | --- |\n| 3 | 4 |';
    table.dispatchEvent(new h.window.Event('input'));
    await view.endEdit();
    assert.equal(text(cardPath('G-bbbbb')),
                 'Per year.\n\n| A | B |\n| --- | --- |\n| 3 | 4 |');
    await view.startEdit('G-bbbbb');
    [...view.contentEl.querySelectorAll('.dendrite-float-astext')][0]
        .dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await tick(20);
    assert.ok(view.editing && view.editing.editor.kind !== 'float',
              'the card\'s text, as any card\'s');
    await view.endEdit();
});

test('a card set to Table starts with a table, in one step to undo, and ' +
     'the board shows what a table or figure lacks', async () => {
    const { view, text } = await open(FLOAT_INDEX, floatCards());
    await view.setKind('G-ccccc', 'table');
    assert.equal(text(cardPath('G-ccccc')),
                 'Some text.\n\n| Column 1 | Column 2 |\n| --- | --- |\n' +
                 '|  |  |');
    await view.doUndo();
    assert.equal(text(cardPath('G-ccccc')), 'Some text.');
    await view.setKind('G-bbbbb', null);
    await view.setKind('G-bbbbb', 'table');
    assert.equal((text(cardPath('G-bbbbb')).match(/\| A \|/g) || []).length,
                 1, 'a card with a table keeps its own');
    // A figure without an image, or a caption.
    await view.startEdit('G-aaaaa');
    view.editing.editor.replace('');
    view.editing.dirty = true;
    await view.endEdit();
    view.invalidate('G-aaaaa');
    await view.renderCard('G-aaaaa');
    const face = view.cardEls.get('G-aaaaa').textContent;
    assert.match(face, /No image: paste, drop or link one/);
    assert.match(face, /No caption/);
});

test('pulling again links comments already in the cards that came ' +
     'without their Google Docs link, on Add, in one step to undo',
     async () => {
    const { view, text } = await open(
        '---\ndendrite_prefix: G\ndendrite_gdoc: https://docs.google.com/' +
        'document/d/D/edit\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'The ==cohort==%%[!review] Joshua Bridgers, ' +
          '2026-10-22: How many?%% was large.' });
    const url = 'https://docs.google.com/document/d/D/edit?disco=AAA1';
    view.plugin.gdocReview = async () => ({ title: 'RAC', resolved: 0,
        items: [{ kind: 'comment', author: 'Joshua Bridgers',
                  date: '2026-10-22', text: 'How many?', quote: 'cohort',
                  before: '', after: '', gid: 'AAA1', link: url }] });
    const before = text(cardPath('G-aaaaa'));
    const m = await view.pullGdoc();
    assert.equal(m.rows[0].dup, true);
    assert.equal(m.rows[0].relink, true);
    assert.match(m.contentEl.textContent,
                 /1 already in the cards will get its Google Docs link/);
    assert.equal(text(cardPath('G-aaaaa')), before, 'nothing written yet');
    await m.contentEl.querySelector('.mod-cta').onclick();
    assert.equal(text(cardPath('G-aaaaa')), 'The ==cohort==%%[!review] ' +
        `Joshua Bridgers, 2026-10-22: How many? ${url}%% was large.`);
    await view.doUndo();
    assert.equal(text(cardPath('G-aaaaa')), before);
});

test('a comment deleted here leaves the card and is not remembered, so a ' +
     'pull offers it again; one resolved is remembered', async () => {
    const { view, read, text } = await open(
        '---\ndendrite_prefix: G\ndendrite_gdoc: https://docs.google.com/' +
        'document/d/D/edit\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'The ==cohort==%%[!review] Joshua Bridgers, ' +
          '2026-10-22: Wrong card?%% and ==size==%%[!review] Joshua ' +
          'Bridgers, 2026-10-22: How many?%%.' });
    // Resolve the one button; Delete from the comment's right-click menu.
    view.invalidate('G-aaaaa');
    await view.renderCard('G-aaaaa');
    const note = view.cardEls.get('G-aaaaa')
        .querySelector('.dendrite-review-note');
    assert.deepEqual([...note.querySelectorAll('button')]
        .map((b) => b.textContent), ['Resolve', 'Reply']);
    h.obsidian.lastMenu = null;
    note.dispatchEvent(new h.window.MouseEvent('contextmenu',
        { bubbles: true, cancelable: true }));
    await tick(10);
    const cm = h.obsidian.lastMenu;
    assert.ok(cm, 'a menu of its own');
    assert.deepEqual(cm.titles, ['Resolve', 'Delete from Dendrite', '---',
                                 'Colour for Joshua Bridgers']);
    assert.deepEqual(cm.items.map((i) => !!i.warning), [false, true, false],
                     'a deletion, in the warning colour');
    await cm.items[1].click();
    await tick(10);
    assert.equal(text(cardPath('G-aaaaa')), 'The cohort and ==size==' +
        '%%[!review] Joshua Bridgers, 2026-10-22: How many?%%.');
    assert.doesNotMatch(read(INDEX), /dendrite_review_done/,
                        'deleted: nothing remembered');
    await view.reviewAction('G-aaaaa', 0, 'resolve');
    assert.match(read(INDEX), /dendrite_review_done/, 'resolved: remembered');
    view.plugin.gdocReview = async () => ({ title: 'RAC', resolved: 0,
        items: ['Wrong card?', 'How many?'].map((t, k) => ({
            kind: 'comment', author: 'Joshua Bridgers', date: '2026-10-22',
            text: t, quote: k ? 'size' : 'cohort', before: '', after: '' }))
    });
    const m = await view.pullGdoc();
    assert.deepEqual(m.rows.map((r) => [r.use, !!r.done]),
                     [[true, false], [false, true]],
                     'the deleted one offered again; the resolved one not');
    await view.doUndo();
});

test('the review dialog says which comments gain a link, and when none ' +
     'of a Word file\'s comments has one', async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\ndendrite_gdoc: https://docs.google.com/' +
        'document/d/D/edit\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': 'The ==cohort==%%[!review] Joshua Bridgers, ' +
          '2026-10-22: How many?%% was large.' });
    const item = (link) => ({ kind: 'comment', author: 'Joshua Bridgers',
        date: '2026-10-22', text: 'How many?', quote: 'cohort', before: '',
        after: '', ...(link ? { gid: 'A1', link } : {}) });
    view.plugin.gdocReview = async () => ({ title: 'RAC.docx', resolved: 0,
        items: [item(null)] });
    let m = await view.pullGdoc();
    assert.match(m.contentEl.textContent, /None has a Google Docs link: /);
    assert.match(m.contentEl.textContent, /kept inside the Word file/);
    view.plugin.gdocReview = async () => ({ title: 'RAC.docx', resolved: 0,
        items: [item('https://docs.google.com/document/d/D/edit?disco=A1')]
    });
    m = await view.pullGdoc();
    assert.match(m.contentEl.textContent,
                 /Already in the card, \S+: gets its Google Docs link\./);
});

test('resolving one passage of a comment on several resolves it on all ' +
     'of them, in every card, in one step to undo; deleting takes one',
     async () => {
    const url = 'https://docs.google.com/document/d/D/edit?disco=doco.Wk1b';
    const n = (p) => `==${p}==%%[!review] Joshua Bridgers, 2026-10-23: ` +
        `Inconsistent naming. ${url}%%`;
    const A = `We sequenced ${n('WGS CRAMs')} here.`;
    const B = `And ${n('scDNA panels')} there, ${n('bulk')} too.`;
    const { view, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': A, 'G-bbbbb': B });
    await view.reviewAction('G-bbbbb', 1, 'delete');
    assert.equal(text(cardPath('G-bbbbb')),
                 `And ${n('scDNA panels')} there, bulk too.`,
                 'delete: the one passage');
    await view.reviewAction('G-aaaaa', 0, 'resolve');
    assert.equal(text(cardPath('G-aaaaa')), 'We sequenced WGS CRAMs here.');
    assert.equal(text(cardPath('G-bbbbb')), 'And scDNA panels there, bulk ' +
                 'too.', 'resolved on every passage');
    await view.doUndo();
    assert.equal(text(cardPath('G-aaaaa')), A);
    assert.equal(text(cardPath('G-bbbbb')),
                 `And ${n('scDNA panels')} there, bulk too.`, 'one step');
});

test('a figure\'s image is found with Obsidian\'s search in its own ' +
     'field, shown by its name, with no [[ or ![[ to write', async () => {
    const { app, view, text } = await open(FLOAT_INDEX, floatCards());
    app.vault.folders.add('W/Grant/figures');
    await app.vault.createBinary('W/Grant/figures/umap_by_clone.png',
                                 new ArrayBuffer(4));
    await app.vault.createBinary('W/Grant/figures/notes.pdf',
                                 new ArrayBuffer(4));
    await view.startEdit('G-aaaaa');
    const form = view.contentEl.querySelector('.dendrite-float-edit');
    const image = form.querySelector('.dendrite-float-image input');
    assert.ok(image, 'an Image field, a search box');
    assert.ok(!form.querySelector('.dendrite-float-image textarea'),
              'not an editor, whose live preview drew the image again');
    assert.equal(image.value, 'old.png', 'by its name');
    // Images only, found as typed, [[ or not.
    const suggest = h.obsidian.lastSuggest;
    assert.equal(suggest.inputEl, image);
    const names = (q) => suggest.getSuggestions(q).map((f) => f.name);
    assert.deepEqual(names('umap'), ['umap_by_clone.png']);
    assert.deepEqual(names('![[umap'), ['umap_by_clone.png']);
    assert.deepEqual(names('notes'), [], 'a PDF is not an image');
    suggest.selectSuggestion(app.vault.getAbstractFileByPath(
        'W/Grant/figures/umap_by_clone.png'));
    assert.equal(image.value, 'umap_by_clone.png');
    // A dropped image fills the field in, by its name.
    await view.editing.editor.take({ files: [],
        getData: () => '[[other.png]]' });
    assert.equal(image.value, 'other.png');
    // A link typed by hand, with ![[ or [[, is taken too.
    image.value = '![[umap_by_clone.png]]';
    image.dispatchEvent(new h.window.Event('change'));
    assert.equal(image.value, 'umap_by_clone.png');
    await view.endEdit();
    assert.equal(text(cardPath('G-aaaaa')),
                 '![[umap_by_clone.png]]\n\nOld caption.');
});

test('in the preview a Google comment on several passages, in one card or ' +
     'several, is one bubble and one step, its passages all marked',
     async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|a]]\n- [[G-bbbbb|b]]\n');
    const url = 'https://docs.google.com/document/d/D/edit?disco=doco.W';
    const n = (p, t, link) => `==${p}==%%[!review] J, 2026-10-23: ${t}` +
        (link ? ` ${url}` : '') + '%%';
    await app.vault.create(cardPath('G-aaaaa'), `A ${n('one', 'Same.', 1)} ` +
        `and ${n('two', 'Other.')}.`);
    await app.vault.create(cardPath('G-bbbbb'), `B ${n('three', 'Same.', 1)}.`);
    const plugin = { settings: { headingTop: 1 }, focusCard() {} };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    await view.setState({ file: INDEX, showComments: true });
    await tick(30);
    const bubbles = [...view.contentEl.querySelectorAll('.dendrite-pbubble')];
    assert.equal(bubbles.length, 2);
    assert.match(bubbles[0].textContent, /2 passages/);
    assert.equal(view.contentEl.querySelector('.dendrite-pcomments-pos')
        .textContent, '2 comments');
    await [...view.contentEl.querySelectorAll('.dendrite-pcomments-nav ' +
        'button')].find((b) => b.getAttribute('aria-label') ===
        'Next comment').onclick();
    const marked = [...view.contentEl.querySelectorAll(
        'mark.dendrite-review-mark.is-current')].map((m) => m.textContent);
    assert.deepEqual(marked, ['one', 'three'], 'all its passages');
});

test('scrolling over the text moves it at the wheel\'s pace, the comment ' +
     'column hurrying through a crowded run; over the comments, they do',
     async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|a]]\n');
    await app.vault.create(cardPath('G-aaaaa'), 'A ==b==%%[!review] J, ' +
        '2026-10-23: Why?%%.');
    const view = new DendritePreview({ app, updateHeader() {} },
        { settings: { headingTop: 1 }, focusCard() {} });
    await view.onOpen();
    await view.setState({ file: INDEX, showComments: true });
    await tick(30);
    // A crowded run: the column moves 200 while the text moves 20.
    view.commentKnots = [[0, 0], [100, 100], [300, 120]];
    view.doc.scrollTop = 100;
    const wheel = (target, deltaY) => {
        const e = new h.window.WheelEvent('wheel', { deltaY, bubbles: true,
                                                     cancelable: true });
        target.dispatchEvent(e);
        return e.defaultPrevented;
    };
    const block = view.blocks.get('G-aaaaa').el;
    assert.ok(wheel(block, 50), 'over the text: taken over');
    assert.equal(view.doc.scrollTop, 330, 'the text 50 on, past the run');
    view.doc.scrollTop = 100;
    const bubble = view.contentEl.querySelector('.dendrite-pbubble');
    assert.ok(!wheel(bubble, 50), 'over the comments: the usual scroll');
    view.commentKnots = null;
    assert.ok(!wheel(block, 50), 'without comments: the usual scroll');
});

test('an image clicked on a card, in the figure editor or in the preview ' +
     'opens in Image Toolkit, where it is installed', async () => {
    const { app, view } = await open(FLOAT_INDEX, floatCards());
    const seen = [];
    app.plugins = { plugins: { 'obsidian-image-toolkit': {
        clickImage: (e) => seen.push(e.target) } } };
    const card = view.cardEls.get('G-aaaaa');
    const img = card.querySelector('.dendrite-card-body')
        .createEl('img');
    img.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(seen, [img]);
    // Not an image: nothing for it.
    card.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    assert.equal(seen.length, 1);
    await view.startEdit('G-aaaaa');
    const shown = view.contentEl.querySelector('.dendrite-float-shown');
    const big = shown.createEl('img');
    big.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(seen, [img, big]);
    await view.endEdit();
    // Without it, a click on an image is a click on its card.
    app.plugins = { plugins: {} };
    img.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    assert.equal(seen.length, 2);
});

test('an image clicked in the preview opens in Image Toolkit, and does not ' +
     'also select its card', async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|a]]\n');
    await app.vault.create(cardPath('G-aaaaa'), 'Text.');
    const seen = [];
    app.plugins = { plugins: { 'obsidian-image-toolkit': {
        clickImage: (e) => seen.push(e.target) } } };
    const focused = [];
    const plugin = { settings: { headingTop: 1 },
                     focusCard: (f, id) => focused.push(id) };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    await view.setState({ file: INDEX });
    await tick(30);
    const block = view.contentEl.querySelector('.dendrite-pblock');
    const img = block.createEl('img');
    img.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(seen, [img]);
    assert.deepEqual(focused, []);
});

test('the Preview and Comments buttons are toggles, lit while on and ' +
     'faded while off', async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|a]]\n');
    await app.vault.create(cardPath('G-aaaaa'), 'Text.');
    const plugin = { settings: { headingTop: 1 }, focusCard() {} };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    await view.setState({ file: INDEX });
    await tick(30);
    const comments = [...view.contentEl.querySelectorAll(
        '.dendrite-bar-btn')].find((b) => /Comments/.test(b.textContent));
    assert.ok(comments.hasClass('is-toggle'));
    assert.ok(!comments.hasClass('is-on'));
    comments.onclick();
    assert.ok(comments.hasClass('is-on'));
    const board = await open(FLOAT_INDEX, floatCards());
    assert.ok(board.view.previewBtn.hasClass('is-toggle'));
});

test('a heading card carrying a review comment shows revise, not the ' +
     'done of the card below it, until the comment is resolved',
     async () => {
    const { view } = await open(
        '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|Cluster]]\n    - [[G-bbbbb|p1]]\n',
        { 'G-aaaaa': '---\ndendrite_role: section\n---\n' +
              '# ==Cluster Selection==%%[!review] J, ' +
              '2026-10-23: Unnecessary?%%',
          'G-bbbbb': '---\ndendrite_status: done\n---\nFir it is.' });
    await tick(30);
    const chips = (id) => [...view.cardEls.get(id)
        .querySelectorAll('.dendrite-status-chip')].map((c) => c.textContent);
    assert.deepEqual(chips('G-aaaaa'), ['revise ⚑']);
    assert.match(view.statusEl.textContent, /1 revise/);
    await view.reviewAction('G-aaaaa', 0, 'resolve');
    await tick(30);
    assert.deepEqual(chips('G-aaaaa'), ['done ✓']);
});

const REVIEWED = {
    'G-aaaaa': 'First ==one==%%[!review] Joshua Bridgers, 2026-10-23: ' +
        'Why?%%.',
    'G-bbbbb': 'Second ==two==%%[!review] Aly Karsan, 2026-10-23: Hm.%% ' +
        'and ==three==%%[!suggest] Joshua Bridgers, 2026-10-23: 3%%.' };
const REVIEWED_INDEX = '---\ndendrite_prefix: G\n---\n' +
    '- [[G-aaaaa|a]]\n- [[G-bbbbb|b]]\n';

test('comments in the old highlighted form are offered a one-way ' +
     'conversion to markers in a pinned panel, done as one undo step',
     async () => {
    const { view, text } = await open(REVIEWED_INDEX, REVIEWED);
    await tick(30);
    const panel = () => view.contentEl.querySelector(
        '.dendrite-pinned .dendrite-old-comments');
    assert.ok(panel(), 'offered');
    assert.match(panel().textContent,
                 /3 review comments in 2 cards are in the old style/);
    await [...panel().querySelectorAll('button')].find((b) =>
        b.textContent === 'Convert').onclick();
    await tick(30);
    assert.equal(text(cardPath('G-aaaaa')), 'First %%{1%%one%%}1 ' +
        '[!review] Joshua Bridgers, 2026-10-23: Why?%%.');
    assert.equal(text(cardPath('G-bbbbb')), 'Second %%{1%%two%%}1 ' +
        '[!review] Aly Karsan, 2026-10-23: Hm.%% and %%{2%%three%%}2 ' +
        '[!suggest] Joshua Bridgers, 2026-10-23: 3%%.');
    assert.equal(panel(), null, 'gone once converted');
    assert.ok(h.notices.some((n) => /converted 3 review comments/.test(n)));
    assert.ok(view.cardEls.get('G-bbbbb').querySelector(
        'mark.dendrite-review-mark.dendrite-rid-1'), 'drawn as before');
    await view.doUndo();
    assert.equal(text(cardPath('G-bbbbb')), REVIEWED['G-bbbbb']);
});

test('each reviewer is given a colour for the manuscript, in reading ' +
     'order, kept in its index; right-click changes it', async () => {
    const { app, view, read } = await open(REVIEWED_INDEX, REVIEWED);
    await tick(30);
    const fm = () => app.metadataCache.getFileCache(
        app.vault.getAbstractFileByPath(INDEX)).frontmatter;
    assert.deepEqual(fm().dendrite_reviewer_colours,
                     ['Joshua Bridgers: blue', 'Aly Karsan: green']);
    const card = (id) => view.cardEls.get(id);
    assert.ok(card('G-aaaaa').querySelector('mark.is-c-blue'));
    assert.ok(card('G-aaaaa').querySelector('.dendrite-review-note.is-c-blue'));
    assert.ok(card('G-bbbbb').querySelector('mark.is-c-green'));
    assert.ok(card('G-bbbbb').querySelector(
        '.dendrite-review-old.is-c-blue'), 'a suggestion too');
    // Right-click on Aly's comment: a colour for Aly.
    const note = card('G-bbbbb').querySelector('.dendrite-review-note');
    note.dispatchEvent(new h.window.MouseEvent('contextmenu',
                                               { bubbles: true }));
    await tick(10);
    const menu = h.obsidian.lastMenu;
    const colour = menu.items.find((i) => i.title === 'Colour for ' +
                                   'Aly Karsan');
    assert.ok(colour && colour.submenu, 'a colour submenu');
    const orange = colour.submenu.items.find((i) => i.title === 'Orange');
    const chip = orange.titleContent &&
        orange.titleContent.querySelector('.dendrite-colour-chip');
    assert.ok(chip, 'a chip of the colour beside its name');
    assert.equal(chip.style.getPropertyValue('--dendrite-chip'),
                 'var(--color-orange)');
    await orange.click();
    await tick(30);
    assert.deepEqual(fm().dendrite_reviewer_colours,
                     ['Joshua Bridgers: blue', 'Aly Karsan: orange']);
    assert.ok(card('G-bbbbb').querySelector('mark.is-c-orange'));
    assert.ok(card('G-aaaaa').querySelector('mark.is-c-blue'),
              'the others keep theirs');
    assert.ok(read(INDEX).includes('- [[G-aaaaa|a]]'), 'the tree kept');
});

test('in the preview a reviewer\'s comments take the manuscript\'s ' +
     'colour for them', async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n' +
        'dendrite_reviewer_colours:\n  - Joshua Bridgers: pink\n---\n' +
        '- [[G-aaaaa|a]]\n');
    await app.vault.create(cardPath('G-aaaaa'), REVIEWED['G-aaaaa']);
    const plugin = { settings: { headingTop: 1 }, focusCard() {} };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    await view.setState({ file: INDEX, showComments: true });
    await tick(30);
    assert.ok(view.contentEl.querySelector('.dendrite-pbubble.is-c-pink'));
    assert.ok(view.contentEl.querySelector('mark.is-c-pink'));
});

test('Reviewers… in the Review menu sets each reviewer\'s colour and links ' +
     'one to their note, offered where a note has their name', async () => {
    const { app, view } = await open(REVIEWED_INDEX, REVIEWED);
    app.vault.folders.add('People');
    await app.vault.create('People/Joshua Bridgers.md', 'A person.');
    await tick(30);
    const fm = () => app.metadataCache.getFileCache(
        app.vault.getAbstractFileByPath(INDEX)).frontmatter
        .dendrite_reviewer_colours;
    const menu = view.reviewMenu();
    await menuItem(menu, 'Reviewers…').click();
    const modal = h.obsidian.lastModal;
    // Rows looked up again after each link, which draws them again.
    const rows = () => [...modal.contentEl.querySelectorAll(
        '.dendrite-reviewer')];
    assert.deepEqual(rows().map((r) => r.dataset.name),
                     ['Joshua Bridgers', 'Aly Karsan'], 'in reading order');
    let [josh, aly] = rows();
    assert.equal(josh.querySelector('select').value, 'blue');
    // A colour chosen: saved, the comments drawn in it.
    const sel = aly.querySelector('select');
    sel.value = 'pink';
    sel.dispatchEvent(new h.window.Event('change'));
    await tick(30);
    assert.deepEqual(fm(), ['Joshua Bridgers: blue', 'Aly Karsan: pink']);
    assert.ok(view.cardEls.get('G-bbbbb').querySelector('mark.is-c-pink'));
    // Only Joshua has a note of that name to offer.
    assert.ok(!aly.querySelector('.dendrite-reviewer-offer'));
    await josh.querySelector('.dendrite-reviewer-offer').onclick();
    await tick(10);
    [josh, aly] = rows();
    assert.deepEqual(fm(), ['[[Joshua Bridgers]]: blue', 'Aly Karsan: pink']);
    // A note typed for Aly: none of that name; then cleared.
    const note = aly.querySelector('input.dendrite-reviewer-note');
    note.value = 'Nobody here';
    note.dispatchEvent(new h.window.Event('change'));
    await tick(10);
    assert.match(aly.textContent, /No note named Nobody here/);
    assert.deepEqual(fm(), ['[[Joshua Bridgers]]: blue', 'Aly Karsan: pink']);
    // Joshua's link taken off again.
    const jn = josh.querySelector('input.dendrite-reviewer-note');
    assert.equal(jn.value, 'Joshua Bridgers');
    jn.value = '';
    jn.dispatchEvent(new h.window.Event('change'));
    await tick(10);
    assert.deepEqual(fm(), ['Joshua Bridgers: blue', 'Aly Karsan: pink']);
    // Colours stay per reviewer though the link changed.
    assert.ok(view.cardEls.get('G-aaaaa').querySelector('mark.is-c-blue'));
});

test('your replies are drawn in your colour and under the name you are ' +
     'shown as, both set in Reviewers… under You', async () => {
    const cards = { 'G-aaaaa': 'First ==one==%%[!review] Joshua Bridgers, ' +
        '2026-10-23: Why?%%%%[!reply] Me, 2026-10-24: Because.%%.' };
    const { app, view } = await open('---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|a]]\n', cards);
    let saved = 0;
    view.plugin.saveSettings = async () => { saved++; };
    await tick(30);
    const fm = () => app.metadataCache.getFileCache(
        app.vault.getAbstractFileByPath(INDEX)).frontmatter
        .dendrite_reviewer_colours;
    // A replier is a reviewer too: given a colour as the reviewers are.
    assert.deepEqual(fm(), ['Joshua Bridgers: blue', 'Me: green']);
    const reply = () => view.cardEls.get('G-aaaaa')
        .querySelector('.dendrite-review-reply');
    assert.ok(reply().classList.contains('is-c-green'));
    await menuItem(view.reviewMenu(), 'Reviewers…').click();
    const modal = h.obsidian.lastModal;
    const you = modal.contentEl.querySelector('.dendrite-reviewer-self');
    assert.ok(you, 'You, at the top');
    assert.deepEqual([...modal.contentEl.querySelectorAll(
        '.dendrite-reviewer')].map((r) => r.dataset.name),
        ['Joshua Bridgers'], 'not among the reviewers');
    const sel = you.querySelector('select');
    sel.value = 'orange';
    sel.dispatchEvent(new h.window.Event('change'));
    await tick(30);
    assert.deepEqual(fm(), ['Joshua Bridgers: blue', 'Me: orange']);
    assert.ok(reply().classList.contains('is-c-orange'));
    const shown = you.querySelector('input.dendrite-reviewer-shown');
    shown.value = 'Derek Tam';
    shown.dispatchEvent(new h.window.Event('change'));
    await tick(30);
    assert.equal(view.plugin.settings.presentName, 'Derek Tam');
    assert.ok(saved > 0);
    assert.equal(reply().querySelector('.dendrite-review-meta b')
        .textContent, 'Derek Tam', 'shown as, the card still says Me');
    assert.match(app.vault.text.get(cardPath('G-aaaaa')), /\[!reply\] Me,/);
});

test('names linked to the same note are one person: one colour for all ' +
     'of them, set from any, and shown together', async () => {
    const { app, view } = await open(REVIEWED_INDEX + '- [[G-ccccc|c]]\n',
        Object.assign({}, REVIEWED, { 'G-ccccc': 'Third ==four==' +
            '%%[!review] jbridgers, 2026-10-24: From Word.%%.' }));
    app.vault.folders.add('People');
    await app.vault.create('People/Joshua Bridgers.md', 'A person.');
    await tick(30);
    const fm = () => app.metadataCache.getFileCache(
        app.vault.getAbstractFileByPath(INDEX)).frontmatter
        .dendrite_reviewer_colours;
    assert.deepEqual(fm(), ['Joshua Bridgers: blue', 'Aly Karsan: green',
                            'jbridgers: purple']);
    await menuItem(view.reviewMenu(), 'Reviewers…').click();
    const modal = h.obsidian.lastModal;
    const row = (name) => [...modal.contentEl.querySelectorAll(
        '.dendrite-reviewer')].find((r) => r.dataset.name === name);
    await row('Joshua Bridgers').querySelector('.dendrite-reviewer-offer')
        .onclick();
    await tick(10);
    // The Word name linked to the same note: Joshua's colour.
    const note = row('jbridgers').querySelector('input');
    note.value = 'Joshua Bridgers';
    note.dispatchEvent(new h.window.Event('change'));
    await tick(30);
    assert.deepEqual(fm(), ['[[Joshua Bridgers]]: blue', 'Aly Karsan: green',
        '[[Joshua Bridgers|jbridgers]]: blue']);
    assert.ok(view.cardEls.get('G-ccccc').querySelector('mark.is-c-blue'));
    // One block for the person, the names it includes under it.
    const people = () => [...modal.contentEl.querySelectorAll(
        '.dendrite-reviewer')].map((r) => [r.dataset.person,
        [...r.querySelectorAll('.dendrite-reviewer-alias')]
            .map((x) => x.dataset.name)]);
    assert.deepEqual(people(), [
        ['Joshua Bridgers', ['Joshua Bridgers', 'jbridgers']],
        ['Aly Karsan', []]]);
    assert.match(row('Joshua Bridgers').querySelector(
        '.dendrite-reviewer-names').textContent, /^includes:/);
    // A colour set for the person, in the dialog: both names.
    const sel = row('Joshua Bridgers').querySelector('select');
    sel.value = 'cyan';
    sel.dispatchEvent(new h.window.Event('change'));
    await tick(30);
    assert.deepEqual(fm(), ['[[Joshua Bridgers]]: cyan',
        '[[Joshua Bridgers|jbridgers]]: cyan', 'Aly Karsan: green'],
        'kept with the same person\'s names together');
    // From a comment's right-click: both.
    await view.setReviewerColour('Joshua Bridgers', 'pink');
    await tick(30);
    assert.deepEqual(fm(), ['[[Joshua Bridgers]]: pink',
        '[[Joshua Bridgers|jbridgers]]: pink', 'Aly Karsan: green'],
        'kept with the same person\'s names together');
    assert.ok(view.cardEls.get('G-ccccc').querySelector('mark.is-c-pink'));
    // One name unlinked by its ×: its own block again, its colour kept.
    await row('Joshua Bridgers').querySelector(
        '.dendrite-reviewer-alias[data-name="jbridgers"] button').onclick();
    await tick(30);
    assert.deepEqual(people(), [
        ['Joshua Bridgers', ['Joshua Bridgers']], ['Aly Karsan', []],
        ['jbridgers', []]]);
    assert.deepEqual(fm(), ['[[Joshua Bridgers]]: pink', 'jbridgers: pink',
                            'Aly Karsan: green']);
});

test('a name Word numbers, as "Aly Karsan 2", is offered the note without ' +
     'the number, and a linked name is shown as the person', async () => {
    const { app, view } = await open(REVIEWED_INDEX, {
        'G-aaaaa': 'First ==one==%%[!review] Aly Karsan 2, 2026-10-23: ' +
            'Why?%%.',
        'G-bbbbb': 'Second ==two==%%[!review] jbridgers, 2026-10-23: ' +
            'No.%%.' });
    app.vault.folders.add('People');
    await app.vault.create('People/Aly Karsan.md', 'A person.');
    await tick(30);
    await menuItem(view.reviewMenu(), 'Reviewers…').click();
    const modal = h.obsidian.lastModal;
    const row = (name) => [...modal.contentEl.querySelectorAll(
        '.dendrite-reviewer')].find((r) => r.dataset.name === name);
    const offer = row('Aly Karsan 2').querySelector(
        '.dendrite-reviewer-offer');
    assert.equal(offer && offer.textContent, 'Link [[Aly Karsan]]');
    assert.ok(!row('jbridgers').querySelector('.dendrite-reviewer-offer'));
    await offer.onclick();
    await tick(30);
    const who = (id) => view.cardEls.get(id)
        .querySelector('.dendrite-review-meta b');
    assert.equal(who('G-aaaaa').textContent, 'Aly Karsan');
    assert.equal(who('G-aaaaa').title, 'As written: Aly Karsan 2');
    assert.equal(who('G-bbbbb').textContent, 'jbridgers', 'not linked');
    assert.equal(who('G-bbbbb').title, '');
});

test('a reviewer\'s note is found with Obsidian\'s note search as it is ' +
     'typed, [[ or not, and linked when one is chosen', async () => {
    const { app, view } = await open(REVIEWED_INDEX, REVIEWED);
    app.vault.folders.add('People');
    await app.vault.create('People/Aly Karsan.md', 'A person.');
    await app.vault.create('People/Joshua Bridgers.md', 'A person.');
    await tick(30);
    await menuItem(view.reviewMenu(), 'Reviewers…').click();
    const modal = h.obsidian.lastModal;
    const aly = [...modal.contentEl.querySelectorAll('.dendrite-reviewer')]
        .find((r) => r.dataset.name === 'Aly Karsan');
    const input = aly.querySelector('input.dendrite-reviewer-note');
    const suggest = h.obsidian.lastSuggest;
    assert.equal(suggest.inputEl, input,
                 'the last row\'s box has the search, as each does');
    const names = (q) => suggest.getSuggestions(q).map((f) => f.basename);
    assert.deepEqual(names('[[aly'), ['Aly Karsan']);
    assert.deepEqual(names('bridg'), ['Joshua Bridgers']);
    suggest.selectSuggestion(app.vault.getAbstractFileByPath(
        'People/Aly Karsan.md'));
    await tick(30);
    assert.deepEqual(app.metadataCache.getFileCache(
        app.vault.getAbstractFileByPath(INDEX)).frontmatter
        .dendrite_reviewer_colours,
        ['Joshua Bridgers: blue', '[[Aly Karsan]]: green']);
});

test('find marks a match in a review comment in its callout, and steps ' +
     'to it as to any match', async () => {
    const { view } = await open('---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|a]]\n',
        { 'G-aaaaa': 'A ==passage==%%[!review] Joshua Bridgers, ' +
            '2026-10-23: Check timepoints https://docs.google.com/' +
            'document/d/D/edit?disco=x%% and timepoints here.' });
    view.openFind();
    const f = view.find;
    h.window.CSS = { highlights: new Map() };
    h.window.Highlight = class { constructor(...r) { this.ranges = r; } };
    const cur = () => h.window.CSS.highlights.get('dendrite-find-current')
        .ranges[0];
    f.input.value = 'timepoints';
    f.input.dispatchEvent(new h.window.Event('input'));
    await tick(150);
    assert.equal(f.countEl.textContent, '1 of 2 in 1 card, 1 in comments');
    // The first, in the card's text, is the comment's: marked in its
    // callout, though the callout is drawn after the paragraph.
    let r = cur();
    assert.ok(r.startContainer.parentElement
        .closest('.dendrite-review-note'), 'in the callout');
    await view.findStep(1);
    r = cur();
    assert.ok(!r.startContainer.parentElement
        .closest('.dendrite-review-note'), 'then in the text');
    f.input.value = '2026';
    f.input.dispatchEvent(new h.window.Event('input'));
    await tick(150);
    assert.equal(f.countEl.textContent, 'No matches', 'not its date');
    view.closeFind();
    delete h.window.CSS;
    delete h.window.Highlight;
});

test('find\'s printed-text toggle searches only what prints: a section\'s ' +
     'heading, prose, no comments, no left-out branch', async () => {
    const { view } = await open('---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|Aims]]\n    - [[G-bbbbb|p]]\n- [[G-ccccc|n]]\n' +
        '    - [[G-ddddd|q]]\n',
        { 'G-aaaaa': '# Aims\nPlanning the aims here.',
          'G-bbbbb': 'The aims are clear %%aims to check%%.',
          'G-ccccc': '---\ndendrite_role: notes\n---\nNotes on aims.',
          'G-ddddd': 'Left-out aims.' });
    view.openFind();
    const f = view.find;
    f.input.value = 'aims';
    f.input.dispatchEvent(new h.window.Event('input'));
    await tick(150);
    assert.equal(f.countEl.textContent, '1 of 6 in 4 cards, 1 in comments');
    const printed = [...f.el.querySelectorAll('button')].find((b) =>
        b.getAttribute('aria-label') === 'Only text that prints');
    assert.ok(printed, 'a toggle beside match case and regex');
    printed.onclick();
    await tick(150);
    assert.ok(printed.hasClass('is-on'));
    assert.equal(f.countEl.textContent, '1 of 2 in 2 cards');
    assert.deepEqual(f.matches.map((m) => m.id), ['G-aaaaa', 'G-bbbbb']);
    view.closeFind();
});

test('a reply is written under a comment on its card, signed with the ' +
     'name in settings, shown in the callout, and taken back by ' +
     'right-click', async () => {
    const { view, text } = await open('---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|a]]\n',
        { 'G-aaaaa': 'The ==cohort==%%[!review] Claude, 2026-10-23: ' +
            'Say how many.%% is large.' });
    view.plugin.settings.replyName = 'Derek Tam';
    const note = () => view.cardEls.get('G-aaaaa')
        .querySelector('.dendrite-review-note');
    const reply = [...note().querySelectorAll('button')]
        .find((b) => b.textContent === 'Reply');
    assert.ok(reply, 'a Reply button beside Resolve');
    reply.click();
    const box = note().querySelector('textarea.dendrite-review-reply-box');
    assert.ok(box, 'a box to write it in');
    box.value = '175 patients,\nin Methods.';
    const send = [...note().querySelectorAll('button')]
        .find((b) => b.textContent === 'Send');
    await send.onclick();
    await tick(20);
    // Today, where the writer is.
    const d = new Date();
    const today = `${d.getFullYear()}-` +
        `${String(d.getMonth() + 1).padStart(2, '0')}-` +
        `${String(d.getDate()).padStart(2, '0')}`;
    assert.equal(text(cardPath('G-aaaaa')), 'The ==cohort==%%[!review] ' +
        'Claude, 2026-10-23: Say how many.%%%%[!reply] Derek Tam, ' +
        `${today}: 175 patients, in Methods.%% is large.`);
    const shown = note().querySelector('.dendrite-review-reply');
    assert.match(shown.textContent, /Derek Tam.*175 patients, in Methods\./);
    // Ctrl+Z takes it back as any change to the card.
    await view.doUndo();
    assert.equal(text(cardPath('G-aaaaa')), 'The ==cohort==%%[!review] ' +
        'Claude, 2026-10-23: Say how many.%% is large.');
    await view.doRedo();
    await tick(20);
    note().querySelector('.dendrite-review-reply').dispatchEvent(
        new h.window.MouseEvent('contextmenu', { bubbles: true }));
    await tick(10);
    const menu = h.obsidian.lastMenu;
    const del = menu.items.find((i) => i.title === 'Delete reply');
    assert.ok(del && del.warning);
    await del.click();
    await tick(20);
    assert.equal(text(cardPath('G-aaaaa')), 'The ==cohort==%%[!review] ' +
        'Claude, 2026-10-23: Say how many.%% is large.');
});

test('in the preview a bubble shows a comment\'s replies and takes a new ' +
     'one, written on the card through the board', async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|a]]\n');
    await app.vault.create(cardPath('G-aaaaa'), 'The ==cohort==' +
        '%%[!review] Claude, 2026-10-23: Say how many.%%%%[!reply] ' +
        'Derek Tam, 2026-10-24: In Methods.%% is large.');
    const sent = [];
    const plugin = { settings: { headingTop: 1 }, focusCard() {},
                     reviewFromPreview: async (...a) => sent.push(a) };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    await view.setState({ file: INDEX, showComments: true });
    await tick(30);
    const bubble = view.contentEl.querySelector('.dendrite-pbubble');
    assert.match(bubble.querySelector('.dendrite-review-reply').textContent,
                 /Derek Tam.*In Methods\./);
    [...bubble.querySelectorAll('button')]
        .find((b) => b.textContent === 'Reply').click();
    const box = bubble.querySelector('textarea');
    box.value = 'And the samples.';
    await [...bubble.querySelectorAll('button')]
        .find((b) => b.textContent === 'Send').onclick();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].slice(1), ['G-aaaaa', 0, 'reply',
                                        'And the samples.']);
});

test('a comment\'s link to Google Docs opens outside Obsidian, on the ' +
     'board and in the preview, never in the window Dendrite is in',
     async () => {
    const link = 'https://docs.google.com/document/d/D/edit?disco=x';
    const card = `The ==cohort==%%[!review] Joshua Bridgers, 2026-10-23: ` +
        `Why? ${link}%% is large.`;
    const { app, view } = await open('---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|a]]\n', { 'G-aaaaa': card });
    const opened = [];
    const was = global.window.open;
    global.window.open = (u) => opened.push(u);
    try {
        const click = (a) => {
            const e = new h.window.MouseEvent('click', { bubbles: true,
                                                         cancelable: true });
            a.dispatchEvent(e);
            return e.defaultPrevented;
        };
        const a = view.cardEls.get('G-aaaaa')
            .querySelector('a.dendrite-review-link');
        assert.ok(click(a), 'the window does not follow the link');
        const { DendritePreview } = require('../src/main.js');
        const prev = new DendritePreview({ app, updateHeader() {} },
            { settings: { headingTop: 1 }, focusCard() {} });
        await prev.onOpen();
        await prev.setState({ file: INDEX, showComments: true });
        await tick(30);
        const b = prev.contentEl.querySelector('a.dendrite-review-link');
        assert.ok(click(b), 'nor in the preview');
        assert.deepEqual(opened, [link, link]);
    } finally {
        global.window.open = was;
    }
});

test('a reply written to a card shows in the preview\'s bubble, though ' +
     'what the card prints is the same', async () => {
    const { DendritePreview } = require('../src/main.js');
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|a]]\n');
    const card = 'The ==cohort==%%[!review] Claude, 2026-10-23: Say how ' +
        'many.%% is large.';
    await app.vault.create(cardPath('G-aaaaa'), card);
    const plugin = { settings: { headingTop: 1 }, focusCard() {} };
    const view = new DendritePreview({ app, updateHeader() {} }, plugin);
    await view.onOpen();
    await view.setState({ file: INDEX, showComments: true });
    await tick(30);
    assert.equal(view.contentEl.querySelectorAll(
        '.dendrite-pbubble .dendrite-review-reply').length, 0);
    await app.vault.modify(app.vault.getAbstractFileByPath(
        cardPath('G-aaaaa')), card.replace('many.%%',
        'many.%%%%[!reply] Derek Tam, 2026-10-23: In Methods.%%'));
    await tick(500);
    const shown = view.contentEl.querySelector(
        '.dendrite-pbubble .dendrite-review-reply');
    assert.ok(shown, 'the reply is in the bubble');
    assert.match(shown.textContent, /In Methods\./);
});

test('threads: each open comment of a manuscript with its card, passage ' +
     'and replies, in reading order, for a reviewer to read back',
     async () => {
    const DendritePlugin = require('../src/main.js');
    const link = 'https://docs.google.com/document/d/D/edit?disco=x';
    const { app, view } = await open('---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|a]]\n- [[G-bbbbb|b]]\n',
        { 'G-aaaaa': 'The ==cohort==%%[!review] Claude, 2026-10-23: ' +
              'Say how many.%%%%[!reply] Derek Tam, 2026-10-24: In ' +
              'Methods.%% is large.',
          'G-bbbbb': 'B ==text==%%[!review] Joshua Bridgers, 2026-10-23: ' +
              `Why? ${link}%% and ==old==%%[!suggest] Claude, ` +
              '2026-10-23: new%%.' });
    const p = new DendritePlugin();
    p.app = app;
    p.settings = { reviewQueue: [] };
    p.openViews = () => [view];
    const all = await p.threadsFor('G');
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.threads.map((t) => [t.card, t.kind, t.passage,
        t.author, t.text, t.link, t.replies.length]), [
        ['G-aaaaa', 'comment', 'cohort', 'Claude', 'Say how many.', null, 1],
        ['G-bbbbb', 'comment', 'text', 'Joshua Bridgers', 'Why?', link, 0],
        ['G-bbbbb', 'suggestion', 'old', 'Claude', 'new', null, 0]]);
    assert.deepEqual(all.json.threads[0].replies, [
        { author: 'Derek Tam', date: '2026-10-24', text: 'In Methods.' }]);
    const mine = await p.threadsFor('G', 'Claude');
    assert.equal(mine.json.threads.length, 2, 'one reviewer\'s');
    assert.equal((await p.threadsFor('X')).status, 404);
});

test('a review round is recorded beside the index, and a card whose ' +
     'printed text changed since shows it', async () => {
    const { app, view } = await open('---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|a]]\n- [[G-bbbbb|b]]\n',
        { 'G-aaaaa': 'First text.', 'G-bbbbb': 'Second text.' });
    const chips = (id) => [...view.cardEls.get(id)
        .querySelectorAll('.dendrite-status-chip')].map((c) => c.textContent);
    assert.ok(!chips('G-aaaaa').some((t) => /changed/.test(t)));
    // Offered after an export: a notice with a button.
    h.notices.length = 0;
    view.offerRound();
    const offer = h.notices[h.notices.length - 1];
    const btn = offer.querySelector && offer.querySelector('button');
    assert.equal(btn && btn.textContent, 'Mark as sent for review…');
    btn.click();
    const modal = h.obsidian.lastModal;
    modal.contentEl.querySelector('input').value = 'Joshua Bridgers';
    await [...modal.contentEl.querySelectorAll('button')]
        .find((b) => b.textContent === 'Record').onclick();
    await tick(30);
    const file = app.vault.getAbstractFileByPath('W/Grant/Grant.rounds.json');
    assert.ok(file, 'kept beside the index');
    const rounds = JSON.parse(await app.vault.read(file)).rounds;
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].to, 'Joshua Bridgers');
    assert.deepEqual(Object.keys(rounds[0].cards), ['G-aaaaa', 'G-bbbbb']);
    // Edited since: that card shows it, and the bar counts it.
    const f = app.vault.getAbstractFileByPath(cardPath('G-bbbbb'));
    await app.vault.modify(f, 'Second text, revised.');
    await tick(700);
    const day = rounds[0].date.slice(8, 10).replace(/^0/, '');
    assert.ok(chips('G-bbbbb').some((t) => t.startsWith('changed since ' +
        day)), chips('G-bbbbb').join());
    assert.ok(!chips('G-aaaaa').some((t) => /changed/.test(t)));
    assert.match(view.statusEl.textContent, /1 changed since sent/);
    // The Review menu records one too.
    assert.ok(menuItem(view.reviewMenu(), 'Mark as sent for review…'));
});
