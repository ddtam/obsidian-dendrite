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
    // The typing is undone first, then the card; redo brings both back.
    await view.doUndo();
    assert.equal(text(cardPath(kept)), '');
    await view.doUndo();
    assert.equal(text(cardPath(kept)), undefined);
    await view.doRedo();
    await view.doRedo();
    assert.equal(text(cardPath(kept)), 'Some words', 'text is never lost');
    assert.ok(view.byId.has(kept), 'and the card is back in the tree');
    // Text written into a new card from outside keeps its note.
    await view.doUndo();
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
    // The roles are a section of their own, and sections are separated
    // once.
    const t = menu.titles;
    const first = t.findIndex((x) => /^Prints automatically/.test(x));
    const last = t.indexOf('Left out of the manuscript');
    assert.ok(first > 0 && last > first);
    assert.equal(t[first - 1], '---', 'a separator before the roles');
    assert.equal(t[last + 1], '---', 'and after them');
    assert.ok(t.slice(first, last + 1).every((x) => x !== '---'));
    assert.ok(!t.some((x, k) => x === '---' && t[k + 1] === '---'),
              'no doubled separators');
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
    // Typing in the moved card is a step of its own, undone and redone.
    await view.startEdit(moved);
    type(view, 'Move this, revised.');
    await view.endEdit();
    await view.doUndo();
    assert.equal(text(cardPath(moved)), 'Move this.', 'the typing first');
    await view.doRedo();
    assert.equal(text(cardPath(moved)), 'Move this, revised.');
    await view.doUndo();
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
    const select = view.contentEl.querySelector('select');
    select.value = 'end';
    select.dispatchEvent(new h.window.Event('change'));
    await tick(20);
    assert.deepEqual(notes(), ['[^1]: [@k]\n[^2]: Second\n    goes on.\n' +
                               '[^3]: Third.']);
    assert.equal(view.getState().notesAt, 'end');
    select.value = 'card';
    select.dispatchEvent(new h.window.Event('change'));
    await tick(20);
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
    assert.match(read(INDEX), /type:\n  - \[\[dendrite index\]\]/);
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
    assert.deepEqual(keys.map((k) => k[1]), ['0', '1', '2', '3', '4']);
    assert.equal(keys[3][0], 'Scaffolding: prints its children only',
                 'the title reads without its key');
});

test('Alt with a number sets a role or status on a whole branch, as ' +
     'one undo', async () => {
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
    // Alt+Shift+2 no longer sets a status.
    view.contentEl.dispatchEvent(new h.window.KeyboardEvent('keydown',
        { code: 'Digit2', key: '@', altKey: true, shiftKey: true,
          bubbles: true, cancelable: true }));
    await tick(30);
    assert.equal(prop('G-ccccc', 'status'), undefined);
    // Ctrl+Alt+2: done on every card in the branch that prints text.
    await press('Digit2', true);
    assert.deepEqual(branch.map((id) => prop(id, 'status')),
                     [undefined, undefined, 'done', 'done'],
                     'headings take no status');
    assert.equal(prop('G-eeeee', 'status'), undefined, 'outside untouched');
    // Alt+4: the whole branch left out, its statuses cleared with it.
    await press('Digit4');
    assert.deepEqual(branch.map((id) => prop(id, 'role')),
                     ['notes', 'notes', 'notes', 'notes']);
    assert.equal(prop('G-ccccc', 'status'), undefined);
    assert.equal(prop('G-eeeee', 'role'), undefined);
    assert.match(h.notices[h.notices.length - 1], /4 cards in the branch/);
    // One undo puts back every card's role and status.
    await view.doUndo();
    await tick(30);
    assert.deepEqual(branch.map((id) => prop(id, 'role')),
                     [undefined, undefined, undefined, undefined]);
    assert.deepEqual(branch.map((id) => prop(id, 'status')),
                     [undefined, undefined, 'done', 'done']);
    // The menus: a Whole branch submenu with each key.
    view.roleMenu('G-aaaaa', view.cardEls.get('G-aaaaa'));
    const whole = h.obsidian.lastMenu.items.find((i) =>
        i.title === 'Whole branch');
    assert.ok(whole && whole.submenu, 'a submenu');
    const keys = whole.submenu.items.map((i) =>
        i.titleContent.querySelector('[data-key]').dataset.key);
    assert.deepEqual(keys, ['Alt+0', 'Alt+1', 'Alt+2', 'Alt+3', 'Alt+4',
                            'Ctrl+Alt+1', 'Ctrl+Alt+2',
                            'Ctrl+Alt+3']);
    await whole.submenu.items[3].click();
    await tick(30);
    assert.deepEqual(branch.map((id) => prop(id, 'role')),
                     ['scaffolding', 'scaffolding', 'scaffolding',
                      'scaffolding']);
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

test('a card\'s text edits join the undo history with tree changes',
     async () => {
    const { view, app, text } = await open(
        '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|A]]\n- [[G-bbbbb|B]]\n',
        { 'G-aaaaa': 'Original text.', 'G-bbbbb': 'B' });
    const undoKey = view.scope.keys.find((k) => k.mods.includes('Mod') &&
                                        k.key === 'z').fn;
    // Typed by accident, then left: Ctrl+Z on the board brings it back.
    await view.startEdit('G-aaaaa');
    type(view, 'Accident.');
    await view.endEdit();
    assert.equal(text(cardPath('G-aaaaa')), 'Accident.');
    await view.doUndo();
    assert.equal(text(cardPath('G-aaaaa')), 'Original text.');
    const redoKey = view.scope.keys.find((k) => k.key === 'y').fn;
    assert.equal(redoKey(), false);
    await tick(20);
    assert.equal(text(cardPath('G-aaaaa')), 'Accident.', 'redone');
    await view.doUndo();
    // A new change ends what could be redone.
    view.active = 'G-bbbbb';
    await view.structural('up');
    await view.doRedo();
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-bbbbb', 'G-aaaaa'], 'nothing redone');
    assert.equal(text(cardPath('G-aaaaa')), 'Original text.');
    await view.doUndo();
    // Left, then opened again: Ctrl+Z before typing restores it there.
    await view.startEdit('G-aaaaa');
    type(view, 'Accident again.');
    await view.endEdit();
    await view.startEdit('G-aaaaa');
    assert.equal(undoKey(), false, 'taken by Dendrite, not the empty editor');
    await tick(20);
    assert.equal(view.editing.ta.value, 'Original text.');
    await view.endEdit();
    assert.equal(text(cardPath('G-aaaaa')), 'Original text.');
    // Once typed in, Ctrl+Z is the editor's own.
    await view.startEdit('G-aaaaa');
    type(view, 'Original text. More.');
    assert.equal(undoKey(), true);
    await view.endEdit();
    // Text and tree changes undo in the order they were made.
    view.active = 'G-bbbbb';
    await view.structural('up');
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-bbbbb', 'G-aaaaa']);
    await view.doUndo();
    assert.deepEqual(view.root.children.map((n) => n.id),
                     ['G-aaaaa', 'G-bbbbb'], 'the move first');
    assert.equal(text(cardPath('G-aaaaa')), 'Original text. More.');
    await view.doUndo();
    assert.equal(text(cardPath('G-aaaaa')), 'Original text.', 'then the text');
    // Text changed since, by a sync or another tab, is never overwritten.
    await view.startEdit('G-bbbbb');
    type(view, 'B edited.');
    await view.endEdit();
    const f = app.vault.getAbstractFileByPath(cardPath('G-bbbbb'));
    await app.vault.process(f, (d) => d.replace('B edited.', 'From sync.'));
    const before = h.notices.length;
    await view.doUndo();
    assert.equal(text(cardPath('G-bbbbb')), 'From sync.');
    assert.ok(h.notices.length > before, 'and says why');
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
