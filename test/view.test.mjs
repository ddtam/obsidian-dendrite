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

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const INDEX = 'W/Grant/Grant.md';

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
        '- [[G-aaaaa|A]]\n    - [[G-bbbbb|B]]\n- [[G-ccccc|C]]\n';
    const { view, read, text } = await open(index, {
        'G-aaaaa': '# A\n', 'G-bbbbb': 'B text', 'G-ccccc': 'C text' });
    view.active = 'G-aaaaa';
    await view.deleteActive();
    assert.equal(text(cardPath('G-aaaaa')), undefined);
    assert.equal(text(cardPath('G-bbbbb')), undefined);
    assert.equal(read(INDEX), '---\ndendrite_prefix: G\n---\n' +
                 '- [[G-ccccc|C]]\n');
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
    await view.doUndo();
    assert.equal(text(cardPath(kept)), 'Some words', 'text is never lost');
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
    const { view, read, text } = await open(
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
    // Text written into a moved card since is never discarded by undo.
    await view.startEdit(moved);
    type(view, 'Move this, revised.');
    await view.endEdit();
    await view.doUndo();
    assert.equal(text(cardPath('G-aaaaa')),
                 'Keep this.\n\nMove this.\n\nAnd keep this.');
    assert.equal(text(cardPath(moved)), 'Move this, revised.',
                 'the edited new card is kept');
});

test('merging into the card above or the parent, and undoing it',
     async () => {
    const index = '---\ndendrite_prefix: G\n---\n' +
        '- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n    - [[G-ccccc|C]]\n';
    const { view, read, text } = await open(index, {
        'G-aaaaa': 'Para A.', 'G-bbbbb': 'Para B.', 'G-ccccc': 'Para C.' });
    view.active = 'G-bbbbb';
    await view.merge('above');
    assert.equal(text(cardPath('G-aaaaa')), 'Para A.\n\nPara B.');
    assert.equal(text(cardPath('G-bbbbb')), undefined, 'merged note trashed');
    assert.equal(read(INDEX), '---\ndendrite_prefix: G\n---\n' +
                 '- [[G-aaaaa|Para A.]]\n    - [[G-ccccc|C]]\n',
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
    const box = view.contentEl.querySelector('input[type=checkbox]');
    box.checked = true;
    box.dispatchEvent(new h.window.Event('change'));
    await tick(20);
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
    view.highlight('G-ccccc');
    assert.ok(view.blocks.get('G-ccccc').el.hasClass('is-active'));
    assert.ok(!b.hasClass('is-active'));
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
    assert.deepEqual(chips('G-bbbbb'), ['✓ done']);
    assert.deepEqual(chips('G-ccccc'), ['revise']);
    assert.deepEqual(chips('G-aaaaa'), ['1 to revise'],
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
    plugin.app = { plugins: { plugins: {} } };
    assert.equal(plugin.statusColour('unsplit'), 'var(--color-orange)');
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
    const tab = new DendriteSettings({}, {
        settings: { writingFolder: 'Writing', headingTop: 1, cardWidth: 380,
                    autosaveMs: 600, openInDendrite: true, vimKeys: true,
                    manageLinter: true, lintCards: true,
                    obsidianEditor: true },
        saveSettings() {}, rerender() {} });
    tab.display();
    const out = h.obsidian.settingsLog.map((s) =>
        (s.heading ? '## ' : '') + s.name);
    assert.deepEqual(out, [
        '## Manuscripts', 'Writing folder', 'Open index notes in Dendrite',
        'Index note type', 'Card type', 'Top section heading level',
        '## Board', 'Card width', 'Vim-style keys',
        '## Writing in cards', 'Use Obsidian\'s editor in cards',
        'Autosave delay',
        '## PDF and Word export', 'Pandoc', 'PDF engine', 'Zotero port',
        'Fallback .bib',
        '## Other plugins', 'Keep Linter out of the writing folder',
        'Clean up cards with Linter',
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
    assert.match(read(cardPath('G-bbbbb')), /dendrite_status: draft/,
                 'backfilled on opening');
    assert.doesNotMatch(read(cardPath('G-aaaaa')), /dendrite_status/,
                        'a section holds no status');
    assert.doesNotMatch(read(cardPath('G-ccccc')), /dendrite_status/,
                        'a left-out card holds no status');
    // A new card is written with draft.
    view.active = 'G-bbbbb';
    await view.insert('below');
    const fresh = view.active;
    await view.endEdit();
    assert.match(read(cardPath(fresh)), /dendrite_status: draft/);
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
    const drag = async (id, target) => {
        view.cardEls.get(id).dispatchEvent(ev('pointerdown', 0, 0));
        over = target;
        h.window.dispatchEvent(ev('pointermove', 30, 30));
        h.window.dispatchEvent(ev('pointerup', 30, 30));
        await tick(10);
    };
    // A press that does not move is a click, not a drag.
    view.cardEls.get('G-ccccc').dispatchEvent(ev('pointerdown', 0, 0));
    h.window.dispatchEvent(ev('pointerup', 2, 2));
    await tick(5);
    assert.equal(ids(), index.replace(/^---[\s\S]*?---\n/, ''));

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
        '---\ndendrite_prefix: G\ndendrite_csl: styles/apa.csl\n---\n' +
        '- [[G-aaaaa|A]]\n',
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
            { result: '@article{smith2020}' }) }),
    });
    view.plugin.showExport = async (rel, full, fmt) =>
        shown.push([rel, fmt]);
    await view.exportTo(null, 'pdf');
    const args = runs[0];
    assert.ok(args.includes('/vault/W/Grant/exports/Grant.pdf'),
              'written beside the index, in the vault');
    assert.equal(args[args.indexOf('--csl') + 1], '/vault/styles/apa.csl');
    assert.deepEqual(shown, [['W/Grant/exports/Grant.pdf', 'pdf']]);
});

test('the index and every card get their type, kept beside existing ones',
     async () => {
    const { view, read } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n',
        { 'G-aaaaa': '---\ntype:\n  - "[[journal article]]"\n---\nA' });
    view.plugin.settings.indexType = '[[dendrite index]]';
    view.plugin.settings.cardType = 'dendrite card';
    await view.reload();
    assert.match(read(INDEX), /type:\n  - \[\[dendrite index\]\]/);
    assert.match(read(cardPath('G-aaaaa')),
                 /type:\n  - "\[\[journal article\]\]"\n  - dendrite card/,
                 'an existing type is kept');
    view.active = 'G-aaaaa';
    await view.insert('below');
    const fresh = view.active;
    await view.endEdit();
    assert.match(read(cardPath(fresh)), /type:\n  - dendrite card/);
    await view.reload();
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
