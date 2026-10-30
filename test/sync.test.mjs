// Two devices syncing one manuscript: two in-memory vaults, each with its
// own board and its own version history, and a sync that copies a file
// from one to the other the way LiveSync does, as a modify the receiving
// vault did not make. Checks that a board writes nothing in response to
// what a sync brings, that typing does not rewrite the index on every
// save, and that a card a sync puts back to an earlier version is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const h = require('./harness.cjs');
const { DendriteView } = require('../src/main.js');
const { History, memoryStore, WINDOW_MS } = require('../src/history.js');
const { Ledger } = require('../src/ledger.js');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const INDEX = 'W/Grant/Grant.md';
const cardPath = (id) => `W/Grant/cards/${id}.md`;

/**
 * A device: a vault holding `files`, its board open on the index; with a
 * `name`, it keeps a record for the other devices, saved at once.
 */
async function device(files, clock, name = null) {
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    for (const [p, t] of Object.entries(files)) await app.vault.create(p, t);
    // Writes this device's own code makes, by path; a sync's are not.
    const writes = [];
    let syncing = false;
    const modify = app.vault.modify.bind(app.vault);
    app.vault.modify = async (f, data) => {
        if (!syncing) writes.push(f.path);
        return modify(f, data);
    };
    const create = app.vault.create.bind(app.vault);
    app.vault.create = async (p, data) => {
        if (!syncing) writes.push(p);
        return create(p, data);
    };
    const plugin = { settings: { headingTop: 1, cardWidth: 380,
                                 autosaveMs: 20, vimKeys: true },
                     openAsMarkdown() {}, async lintCard() {},
                     statusColour: () => null,
                     history: new History(memoryStore(), () => clock.t) };
    if (name) {
        plugin.ledger = new Ledger(app.vault, name, () => clock.t, 0);
    }
    const view = new DendriteView({ app, updateHeader() {}, detach() {} },
                                  plugin);
    await view.onOpen();
    await view.setState({ file: INDEX });
    await tick(20);
    const read = (p) => app.vault.text.get(p);
    /** Receive a file's text by sync. */
    const receive = async (p, text) => {
        syncing = true;
        try {
            const f = app.vault.getAbstractFileByPath(p);
            if (f) await modify(f, text);
            else await create(p, text);
        } finally {
            syncing = false;
        }
        await tick(20);
    };
    return { app, view, read, writes, receive, plugin };
}

const type = (view, value) => {
    const ta = view.editing.ta;
    ta.value = value;
    ta.dispatchEvent(new h.window.Event('input'));
};

const FILES = {
    [INDEX]: '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|Aims]]\n',
    [cardPath('G-aaaaa')]: '---\ndendrite_status: draft\n---\n# Aims\n',
};

test('typing on one device: the other writes nothing, and the index is ' +
     'written once typing stops', async () => {
    const clock = { t: 1 };
    const a = await device(FILES, clock);
    const b = await device(FILES, clock);
    assert.deepEqual(a.writes, [], 'opening writes nothing');
    assert.deepEqual(b.writes, []);
    // A new card on A, synced to B.
    a.view.active = 'G-aaaaa';
    await a.view.insert('below');
    const id = a.view.active;
    await tick(40);
    for (const p of [cardPath(id), INDEX]) await b.receive(p, a.read(p));
    a.writes.length = 0;
    // Typing its first words, each autosave synced to B as it lands.
    for (const words of ['One', 'One two', 'One two three',
                         'One two three four']) {
        type(a.view, words);
        await tick(60);
        await b.receive(cardPath(id), a.read(cardPath(id)));
    }
    assert.ok(a.writes.includes(cardPath(id)), 'A autosaved the card');
    assert.ok(!a.writes.includes(INDEX),
              'A did not rewrite the index while typing');
    assert.deepEqual(b.writes, [], 'B wrote nothing in response');
    assert.equal(b.view.byId.get(id).label, 'One two three four',
                 'B follows the label in memory');
    // Leaving the card writes the label once.
    await a.view.endEdit();
    assert.equal(a.writes.filter((p) => p === INDEX).length, 1);
    assert.match(a.read(INDEX), new RegExp(`\\[\\[${id}\\|One two three ` +
                                           'four\\]\\]'));
    await b.receive(INDEX, a.read(INDEX));
    for (const p of [cardPath(id)]) await b.receive(p, a.read(p));
    assert.deepEqual(b.writes, [], 'nor in response to the index');
    assert.equal(b.read(INDEX), a.read(INDEX));
});

test('the label reaches the index after a pause in typing', async () => {
    const clock = { t: 1 };
    const a = await device(FILES, clock);
    a.view.labelIdleMs = 150;
    await a.view.startEdit('G-aaaaa');
    a.writes.length = 0;
    type(a.view, '# Specific aims\n');
    await tick(60);
    assert.ok(!a.writes.includes(INDEX), 'not at the autosave');
    await tick(200);
    assert.deepEqual(a.writes.filter((p) => p === INDEX), [INDEX]);
    assert.match(a.read(INDEX), /\[\[G-aaaaa\|Specific aims\]\]/);
    await a.view.endEdit();
    assert.equal(a.writes.filter((p) => p === INDEX).length, 1,
                 'and not again on leaving');
});

test('a card a stale device puts back is caught and can be restored; the ' +
     'board writes nothing in response', async () => {
    const clock = { t: 1 };
    const oldCard = FILES[cardPath('G-aaaaa')] +
        'What are the anticipated results?\n';
    const files = { ...FILES, [cardPath('G-aaaaa')]: oldCard };
    const a = await device(files, clock);
    const staleIndex = a.read(INDEX);
    // Later, on A: the index gains properties, from Obsidian's own
    // properties editor, and the card is rewritten in the board.
    clock.t += WINDOW_MS + 1;
    await a.receive(INDEX, staleIndex.replace('---\n-',
        'dendrite_font: Arial\n---\n-'));
    await a.view.startEdit('G-aaaaa');
    type(a.view, '# Aims\nThe model.\n');
    await a.view.endEdit();
    await a.view.setRole('G-aaaaa', 'scaffolding');
    await tick(20);
    const newCard = a.read(cardPath('G-aaaaa'));
    const newIndex = a.read(INDEX);
    assert.match(newCard, /dendrite_role: scaffolding/);
    assert.match(newIndex, /dendrite_font: Arial/);
    assert.deepEqual(a.view.reverted, new Set(), 'nothing flagged so far');
    // Later still, a stale device sends its old card and index.
    clock.t += WINDOW_MS + 1;
    a.writes.length = 0;
    h.notices.length = 0;
    await a.receive(cardPath('G-aaaaa'), oldCard);
    await a.receive(INDEX, staleIndex);
    await tick(400);
    assert.deepEqual(a.writes, [], 'A wrote nothing in response');
    assert.deepEqual([...a.view.reverted].sort(), ['G-aaaaa', 'index']);
    assert.ok(h.notices.some((n) => /Card aaaaa .*changed outside Dendrite/
        .test(n)), 'a notice names the card');
    const chip = a.view.cardEls.get('G-aaaaa')
        .querySelector('.dendrite-status-chip.is-reverted');
    assert.ok(chip, 'the card is marked');
    // Counted in the tally, whose click goes to the card.
    const count = [...a.view.statusEl.querySelectorAll('.is-reverted')]
        .find((c) => /changed by sync/.test(c.textContent));
    assert.equal(count && count.textContent, '1 card changed by sync ⟲');
    assert.match(count.getAttribute('aria-label'), /aaaaa/,
                 'names the card');
    // The card already active, as one typed in is: the board is still
    // moved to it, not left where it was.
    assert.equal(a.view.active, 'G-aaaaa');
    let moved = 0;
    const apply = a.view.applyActive.bind(a.view);
    a.view.applyActive = (...x) => { moved++; return apply(...x); };
    await count.onclick();
    assert.equal(a.view.active, 'G-aaaaa', 'gone to');
    assert.equal(moved, 1, 'the board moved to it');
    a.view.applyActive = apply;
    // Export refuses while a card has gone back.
    assert.equal(await a.view.exportTo(null), null);
    assert.equal(a.read('W/Grant/exports/Grant.md'), undefined);
    // Restoring brings back the newer text, properties included, each
    // as one undo step.
    await a.view.restoreNewer('G-aaaaa');
    await a.view.restoreNewer(null);
    await tick(20);
    assert.equal(a.read(cardPath('G-aaaaa')), newCard);
    assert.equal(a.read(INDEX), newIndex);
    assert.deepEqual(a.view.reverted, new Set());
    await a.view.doUndo();
    await tick(20);
    assert.equal(a.read(INDEX), staleIndex, 'the index restore undone');
    await a.view.doRedo();
    await tick(20);
    assert.equal(a.read(INDEX), newIndex, 'and redone');
    await a.view.doUndo();
    await a.view.doUndo();
    assert.equal(a.read(cardPath('G-aaaaa')), oldCard);
    assert.deepEqual(a.view.reverted, new Set(),
                     'an undo made here is not a version going back');
});

test('keeping the earlier version settles it', async () => {
    const clock = { t: 1 };
    const a = await device(FILES, clock);
    const first = a.read(cardPath('G-aaaaa'));
    clock.t += WINDOW_MS + 1;
    await a.receive(cardPath('G-aaaaa'), first + 'Second.\n');
    clock.t += WINDOW_MS + 1;
    await a.receive(cardPath('G-aaaaa'), first);
    assert.ok(a.view.reverted.has('G-aaaaa'));
    await a.view.keepVersion('G-aaaaa');
    assert.ok(!a.view.reverted.has('G-aaaaa'));
    assert.ok(await a.view.exportTo(null) !== null, 'export runs again');
});

test('the dialog marks the characters that differ, spaces made visible',
     async () => {
    const clock = { t: 1 };
    const a = await device(FILES, clock);
    const first = a.read(cardPath('G-aaaaa'));
    for (const t of ['Second.\n', 'Second. \n', 'Second.\n']) {
        clock.t += WINDOW_MS + 1;
        await a.receive(cardPath('G-aaaaa'), first + t);
    }
    assert.ok(a.view.reverted.has('G-aaaaa'));
    a.view.reviewVersion('G-aaaaa');
    await tick(20);
    const m = h.obsidian.lastModal;
    const marks = (sel) => [...m.contentEl.querySelectorAll(sel)]
        .map((e) => e.textContent);
    // Only a trailing space differs: it shows as a dot on the line
    // from before, and nothing on the line now is marked.
    const rows = [...m.contentEl.querySelectorAll(
        '.dendrite-version-diff > div')];
    const back = rows.find((r) => r.classList.contains('is-added'));
    assert.deepEqual([...back.querySelectorAll('.dendrite-version-change')]
        .map((e) => e.textContent), ['·']);
    assert.equal(back.textContent, '+Second.·');
    const now = rows.find((r) => r.classList.contains('is-removed'));
    assert.equal(now.querySelectorAll('.dendrite-version-change').length,
                 0);
    // Side by side marks the same.
    m.contentEl.querySelectorAll(
        '.dendrite-version-modes .clickable-icon')[1].onclick();
    assert.deepEqual(
        marks('.dendrite-version-split .dendrite-version-change'), ['·']);
    m.contentEl.querySelectorAll(
        '.dendrite-version-modes .clickable-icon')[0].onclick();
    m.close();
});

test('a change made here over an index changed elsewhere is not written',
     async () => {
    const clock = { t: 1 };
    const a = await device({ ...FILES,
        [INDEX]: FILES[INDEX] + '- [[G-bbbbb|B]]\n',
        [cardPath('G-bbbbb')]: 'B' }, clock);
    // The index changes on disk before its modify event is handled.
    const other = '---\ndendrite_prefix: G\ndendrite_font: Arial\n---\n' +
        '- [[G-bbbbb|B]]\n- [[G-aaaaa|Aims]]\n';
    a.app.vault.text.set(INDEX, other);
    h.notices.length = 0;
    a.view.active = 'G-aaaaa';
    await a.view.structural('down');
    assert.equal(a.read(INDEX), other, 'left as it was');
    assert.ok(h.notices.some((n) => /index changed outside/.test(n)));
    assert.deepEqual(a.view.root.children.map((n) => n.id),
                     ['G-bbbbb', 'G-aaaaa'], 'and read again');
});

test('a status and a label set on one device show on the other\'s open ' +
     'board when the card arrives, with no action or write there',
     async () => {
    const clock = { t: 1 };
    const files = { ...FILES,
        [INDEX]: FILES[INDEX] + '    - [[G-bbbbb|First words]]\n',
        [cardPath('G-bbbbb')]: '---\ndendrite_status: draft\n---\n' +
            'First words here.\n' };
    const a = await device(files, clock);
    const b = await device(files, clock);
    const chip = (d, id) => {
        const el = d.view.cardEls.get(id)
            .querySelector('.dendrite-status-chip');
        return el ? el.textContent : null;
    };
    assert.equal(chip(b, 'G-bbbbb'), null, 'draft shows no chip');
    // A marks the card done; only the card syncs.
    await a.view.setStatus('G-bbbbb', 'done');
    await tick(20);
    assert.match(a.read(cardPath('G-bbbbb')), /dendrite_status: done/);
    await b.receive(cardPath('G-bbbbb'), a.read(cardPath('G-bbbbb')));
    assert.equal(chip(b, 'G-bbbbb'), 'done ✓', 'B shows done');
    assert.equal(b.view.statusInfo.get('G-bbbbb').own, 'done');
    // A rewrites the card's opening words; again only the card syncs.
    await a.view.startEdit('G-bbbbb');
    type(a.view, 'New opening words.\n');
    await a.view.endEdit();
    await b.receive(cardPath('G-bbbbb'), a.read(cardPath('G-bbbbb')));
    assert.equal(b.view.byId.get('G-bbbbb').label, 'New opening words.');
    const body = b.view.cardEls.get('G-bbbbb')
        .querySelector('.dendrite-card-body');
    assert.match(body.textContent, /New opening words\./,
                 'B shows the new text');
    assert.equal(chip(b, 'G-bbbbb'), 'done ✓', 'status kept');
    assert.deepEqual(b.writes, [], 'B wrote nothing');
    assert.match(b.read(INDEX), /\[\[G-bbbbb\|First words\]\]/,
                 'B\'s index waits for the synced one');
});

test('an index from a sync that leaves out cards whose notes still exist ' +
     'is caught, though this device never saw it, and can be restored',
     async () => {
    const clock = { t: 1 };
    const full = '---\ndendrite_prefix: G\ndendrite_font: Arial\n---\n' +
        '- [[G-aaaaa|Aims]]\n    - [[G-bbbbb|B]]\n    - [[G-ccccc|C]]\n' +
        '- [[G-ddddd|D]]\n';
    const files = { [INDEX]: full,
                    [cardPath('G-aaaaa')]: '# Aims\n',
                    [cardPath('G-bbbbb')]: 'B text\n',
                    [cardPath('G-ccccc')]: 'C text\n',
                    [cardPath('G-ddddd')]: 'D text\n' };
    const a = await device(files, clock);
    clock.t += WINDOW_MS + 1;
    h.notices.length = 0;
    // An old copy, merged: two cards gone, a third out of place, and
    // the properties lost.
    const merged = '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|Aims]]\n' +
        '- [[G-ddddd|D]]\n        - [[G-ccccc|C]]\n    - [[G-zzzzz|Z]]\n';
    await a.receive(INDEX, merged.replace(
        '        - [[G-ccccc|C]]\n', ''));
    await tick(400);
    assert.deepEqual(a.writes, [], 'A wrote nothing in response');
    assert.ok(a.view.reverted.has('index'), 'the bar is marked');
    assert.ok(h.notices.some((n) => /no longer lists 2 cards whose notes /
        .test(n) && /bbbbb \(B\).*ccccc \(C\)/.test(n)),
              'a notice names the cards');
    assert.equal(await a.view.exportTo(null), null, 'export refuses');
    // Listed again, out of place: one card is still left out.
    await a.receive(INDEX, merged);
    await tick(400);
    assert.deepEqual([...a.view.dropped.keys()], ['G-bbbbb']);
    await a.view.restoreNewer(null);
    await tick(400);
    assert.equal(a.read(INDEX), full, 'the index as it was, properties ' +
                 'and all');
    assert.ok(!a.view.reverted.has('index'));
    assert.deepEqual(a.view.root.children.map((n) => n.id),
                     ['G-aaaaa', 'G-ddddd']);
});

test('cards deleted on another device, or the index edited here, are ' +
     'not taken for an old copy', async () => {
    const clock = { t: 1 };
    const files = { ...FILES,
        [INDEX]: FILES[INDEX] + '- [[G-bbbbb|B]]\n- [[G-ccccc|C]]\n',
        [cardPath('G-bbbbb')]: 'B text\n',
        [cardPath('G-ccccc')]: 'C text\n' };
    const a = await device(files, clock);
    const without = (t, id, label) => t.replace(`- [[${id}|${label}]]\n`,
                                                '');
    // The note's deletion arrives first, then the index.
    await a.app.fileManager.trashFile(
        a.app.vault.getAbstractFileByPath(cardPath('G-bbbbb')));
    await a.receive(INDEX, without(a.read(INDEX), 'G-bbbbb', 'B'));
    await tick(400);
    assert.ok(!a.view.reverted.has('index'), 'note deleted first');
    // The index arrives first, then the note's deletion.
    await a.receive(INDEX, without(a.read(INDEX), 'G-ccccc', 'C'));
    await tick(400);
    assert.ok(a.view.reverted.has('index'), 'flagged for now');
    await a.app.fileManager.trashFile(
        a.app.vault.getAbstractFileByPath(cardPath('G-ccccc')));
    assert.ok(!a.view.reverted.has('index'), 'and cleared by the delete');
    // A line deleted in Obsidian's editor on the index, here.
    a.app.workspace.activeEditor = { file: a.view.file };
    await a.receive(INDEX, without(a.read(INDEX), 'G-aaaaa', 'Aims'));
    await tick(400);
    assert.ok(!a.view.reverted.has('index'), 'edited here');
    assert.deepEqual(a.writes, []);
});

test('keeping the index without the cards settles it', async () => {
    const clock = { t: 1 };
    const files = { ...FILES,
        [INDEX]: FILES[INDEX] + '- [[G-bbbbb|B]]\n',
        [cardPath('G-bbbbb')]: 'B text\n' };
    const a = await device(files, clock);
    await a.receive(INDEX, FILES[INDEX]);
    await tick(400);
    assert.ok(a.view.reverted.has('index'));
    await a.view.keepVersion(null);
    assert.ok(!a.view.reverted.has('index'));
    // A later change from outside compares with the kept index.
    await a.receive(INDEX, FILES[INDEX].replace('Aims', 'Aim'));
    await tick(400);
    assert.ok(!a.view.reverted.has('index'));
    assert.deepEqual(a.writes, []);
});

test('the older-copy mark opens a dialog that says what happened, shows ' +
     'both texts, and writes nothing until a choice', async () => {
    const clock = { t: 1 };
    const files = { ...FILES,
        [INDEX]: FILES[INDEX] + '- [[G-bbbbb|B]]\n',
        [cardPath('G-bbbbb')]: 'B text\n' };
    const a = await device(files, clock);
    const full = a.read(INDEX);
    await a.receive(INDEX, FILES[INDEX]);
    await tick(400);
    const chip = a.view.statusEl.querySelector('.is-reverted');
    assert.equal(chip.textContent, 'index: older copy ⟲');
    assert.match(chip.getAttribute('aria-label'), /nothing is written/);
    chip.onclick();
    await tick(20);
    const m = h.obsidian.lastModal;
    assert.equal(m.titleEl.textContent, 'The index changed to an older copy');
    const text = m.contentEl.textContent;
    assert.match(text, /no longer lists 1 card whose notes still exist: /);
    assert.match(text, /exist: bbbbb \(B\)/);
    assert.match(text, /Nothing has been written/);
    const diff = [...m.contentEl.querySelectorAll(
        '.dendrite-version-diff > div')].map((d) => d.textContent);
    assert.ok(diff.includes('+- [[G-bbbbb|B]]'), 'the line coming back');
    const choices = (modal) => [...modal.contentEl.querySelectorAll(
        '.dendrite-version-choice button')];
    const buttons = choices(m).map((b) => b.textContent);
    assert.deepEqual(buttons, ['Keep the note now',
                               'Put back the text from before',
                               'Decide later'], 'in the columns\' order');
    assert.deepEqual(a.writes, [], 'opening wrote nothing');
    // Side by side: the note now on the left, the text from before on
    // the right, the line coming back beside a blank.
    const modes = [...m.contentEl.querySelectorAll(
        '.dendrite-version-modes .clickable-icon')];
    assert.deepEqual(modes.map((b) => b.getAttribute('aria-label')),
                     ['Unified', 'Side by side']);
    modes[1].onclick();
    assert.ok(m.modalEl.classList.contains('dendrite-wide'));
    const cells = [...m.contentEl.querySelectorAll(
        '.dendrite-version-split tr')].map((tr) =>
        [...tr.children].map((c) => c.textContent));
    assert.deepEqual(cells[0], ['The note now', 'The text from before']);
    assert.ok(cells.some((r) => r[0] === '' && r[1] === '- [[G-bbbbb|B]]'));
    modes[0].onclick();
    assert.ok(!m.modalEl.classList.contains('dendrite-wide'));
    // Decide later: nothing changes.
    await choices(m)[2].onclick();
    assert.ok(a.view.reverted.has('index'));
    // Put back: the index as it was, undoable.
    chip.onclick();
    await tick(20);
    await choices(h.obsidian.lastModal)[1].onclick();
    await tick(400);
    assert.equal(a.read(INDEX), full);
    assert.ok(!a.view.reverted.has('index'));
    await a.view.doUndo();
    await tick(400);
    assert.equal(a.read(INDEX), FILES[INDEX], 'undone');
    assert.ok(a.view.reverted.has('index'), 'and marked again');
});

test('a card open in its editor takes a synced change it has no unsaved ' +
     'typing against, writing nothing in response', async () => {
    const clock = { t: 1 };
    const a = await device(FILES, clock);
    await a.view.startEdit('G-aaaaa');
    type(a.view, '# Aims\nHere.\n');
    await tick(60);
    // Later, the other device's edit arrives while the editor is open.
    clock.t += WINDOW_MS + 1;
    a.writes.length = 0;
    const synced = '---\ndendrite_status: draft\n---\n' +
        '# Aims\nHere, and from home.\n';
    await a.receive(cardPath('G-aaaaa'), synced);
    await tick(40);
    assert.deepEqual(a.writes, [], 'nothing written in response');
    assert.equal(a.view.editing && a.view.editing.id, 'G-aaaaa',
                 'still editing');
    assert.equal(a.view.editing.editor.value,
                 '# Aims\nHere, and from home.\n', 'the editor took it');
    assert.ok(!a.view.reverted.has('G-aaaaa'));
    // Typing on writes on top of the synced text, not the old.
    type(a.view, '# Aims\nHere, and from home. More.\n');
    await a.view.endEdit();
    // With the heading's alias, written for the typing, not the sync.
    assert.equal(a.read(cardPath('G-aaaaa')), '---\ndendrite_status: ' +
                 'draft\naliases:\n  - Aims\ndendrite_alias: Aims\n---\n' +
                 '# Aims\nHere, and from home. More.\n');
});

test('a synced change to a card with unsaved typing is not saved over; ' +
     'the card is marked with the typing to put back', async () => {
    const clock = { t: 1 };
    const a = await device(FILES, clock);
    a.view.plugin.settings.autosaveMs = 5000;
    await a.view.startEdit('G-aaaaa');
    clock.t += WINDOW_MS + 1;
    type(a.view, '# Aims\nTyped here.\n');
    a.writes.length = 0;
    const synced = '---\ndendrite_status: draft\n---\n' +
        '# Aims\nFrom home.\n';
    await a.receive(cardPath('G-aaaaa'), synced);
    await tick(40);
    assert.deepEqual(a.writes, [], 'the typing was not saved over it');
    assert.equal(a.read(cardPath('G-aaaaa')), synced);
    assert.equal(a.view.editing, null, 'the editor closed');
    assert.ok(a.view.reverted.has('G-aaaaa'), 'the card is marked');
    assert.ok(h.notices.some((n) => /aaaaa .*while you were typing/
        .test(n)), 'a notice names the card');
    const chip = a.view.cardEls.get('G-aaaaa')
        .querySelector('.dendrite-status-chip.is-reverted');
    assert.equal(chip.textContent, 'typing kept ⟲');
    chip.onclick({ stopPropagation() {} });
    await tick(20);
    const m = h.obsidian.lastModal;
    assert.match(m.titleEl.textContent, /changed while you were typing/);
    assert.equal(await a.view.newerText('G-aaaaa'),
                 '---\ndendrite_status: draft\n---\n# Aims\nTyped here.\n');
    await a.view.restoreNewer('G-aaaaa');
    await tick(20);
    assert.equal(a.read(cardPath('G-aaaaa')),
                 '---\ndendrite_status: draft\n---\n# Aims\nTyped here.\n');
    assert.ok(!a.view.reverted.has('G-aaaaa'), 'putting back settles it');
});

test('the dialog says where and when each side was seen, and opens from ' +
     'memory without waiting on the version store', async () => {
    const clock = { t: Date.UTC(2026, 9, 21, 20) };
    const a = await device(FILES, clock);
    // Last night's text, typed here.
    clock.t += WINDOW_MS + 1;
    await a.view.startEdit('G-aaaaa');
    type(a.view, '# Aims\nThe full card.\n');
    await a.view.endEdit();
    // A damaged copy arrives by sync, then the good text again.
    clock.t += WINDOW_MS + 1;
    const fm = '---\ndendrite_status: draft\n---\n';
    await a.receive(cardPath('G-aaaaa'), fm + '# Aims\nThe\n');
    clock.t += WINDOW_MS + 1;
    await a.receive(cardPath('G-aaaaa'), fm + '# Aims\nThe full card.\n');
    assert.ok(a.view.reverted.has('G-aaaaa'));
    // The store stops answering: the dialog still fills.
    a.view.plugin.history.store.get = () => new Promise(() => {});
    a.view.cardEls.get('G-aaaaa')
        .querySelector('.dendrite-status-chip.is-reverted')
        .onclick({ stopPropagation() {} });
    await tick(20);
    const text = h.obsidian.lastModal.contentEl.textContent;
    assert.match(text, /The text from before came from outside Dendrite, /);
    assert.match(text, /The note now matches text this device had at .*, /);
    assert.match(text, /written on this device/);
    const diff = [...h.obsidian.lastModal.contentEl.querySelectorAll(
        '.dendrite-version-diff > div')].map((d) => d.textContent);
    assert.ok(diff.includes('+The'), 'the damaged copy is the side before');
});

test('a delete over an index changed elsewhere deletes no notes',
     async () => {
    const clock = { t: 1 };
    const a = await device({ ...FILES,
        [INDEX]: FILES[INDEX] + '- [[G-bbbbb|B]]\n',
        [cardPath('G-bbbbb')]: 'B' }, clock);
    const other = '---\ndendrite_prefix: G\n---\n' +
        '- [[G-bbbbb|B]]\n- [[G-aaaaa|Aims]]\n';
    a.app.vault.text.set(INDEX, other);
    a.view.active = 'G-aaaaa';
    await a.view.deleteActive();
    assert.equal(a.read(INDEX), other, 'the index left as it was');
    assert.ok(a.read(cardPath('G-aaaaa')) !== undefined,
              'and the card\'s note kept');
});

// A rename made on another device, arriving by sync one note at a time.
const RENAMED = '---\ndendrite_prefix: G27\n' +
    'dendrite_former_prefixes:\n  - G\n---\n' +
    '- [[G27-aaaaa|Aims]]\n- [[G27-bbbbb|B]]\n';

async function renameArrives(a) {
    const move = async (from, to) => {
        await a.receive(to, a.read(from));
        await a.app.fileManager.trashFile(
            a.app.vault.getAbstractFileByPath(from));
        await tick(250);
    };
    return { move };
}

test('a rename from another device: the board follows, writes nothing, ' +
     'and changes nothing until every card arrives', async () => {
    const clock = { t: 1 };
    const a = await device({ ...FILES,
        [INDEX]: FILES[INDEX] + '- [[G-bbbbb|B]]\n',
        [cardPath('G-bbbbb')]: 'B' }, clock);
    h.notices.length = 0;
    await a.receive(INDEX, RENAMED);
    await tick(400);
    assert.equal(a.view.arriving, 2);
    assert.ok(!a.view.reverted.has('index'), 'no cards reported left out');
    assert.ok(!h.notices.some((n) => /no longer lists/.test(n)));
    assert.ok(h.notices.some((n) => /renamed on another device/.test(n)));
    await a.view.startEdit('G27-aaaaa');
    assert.equal(a.view.editing, null, 'no editing');
    a.view.active = 'G27-aaaaa';
    await a.view.insert('below');
    assert.equal(await a.view.exportTo(null), null, 'export refuses');
    const { move } = await renameArrives(a);
    await move(cardPath('G-aaaaa'), cardPath('G27-aaaaa'));
    assert.equal(a.view.arriving, 1);
    h.notices.length = 0;
    await move(cardPath('G-bbbbb'), cardPath('G27-bbbbb'));
    assert.equal(a.view.arriving, 0);
    assert.ok(h.notices.some((n) => /rename has arrived/.test(n)));
    assert.deepEqual(a.writes, [], 'A wrote nothing throughout');
    a.view.checkOldCopies();
    assert.deepEqual(a.view.oldCopies, []);
    await a.view.startEdit('G27-aaaaa');
    assert.equal(a.view.editing.id, 'G27-aaaaa', 'and edits again');
});

test('an index renamed as a new note and a delete: the board follows the ' +
     'new note, and keeps its versions', async () => {
    const clock = { t: 1 };
    const a = await device({ ...FILES,
        [INDEX]: FILES[INDEX] + '- [[G-bbbbb|B]]\n',
        [cardPath('G-bbbbb')]: 'B' }, clock);
    const NEW = 'W/Grant 2027/Grant 2027.md';
    await a.receive(NEW, RENAMED);
    a.app.metadataCache.trigger('changed',
                                a.app.vault.getAbstractFileByPath(NEW));
    await tick(50);
    assert.equal(a.view.file.path, NEW);
    assert.equal(a.view.arriving, 2);
    let detached = false;
    a.view.leaf.detach = () => { detached = true; };
    await a.app.fileManager.trashFile(a.app.vault.getAbstractFileByPath(
        INDEX));
    assert.ok(!detached, 'the board stays open');
    assert.deepEqual(a.writes, []);
});

test('a card one device puts back to text it held before, by resolving ' +
     'its comment, is that device\'s change on the others once its ' +
     'record arrives; an old copy nobody stands by is still caught; and ' +
     'a version kept on one device settles the others', async () => {
    const clock = { t: 1 };
    const T1 = '---\ndendrite_status: draft\n---\n# Aims\n\n' +
        'Why?%%[!review] Aly, 2026-10-30: Why?%%\n';
    const a = await device(FILES, clock, 'nix');
    const b = await device(FILES, clock, 'laptop');
    const card = cardPath('G-aaaaa');
    const rec = 'W/Grant/_dendrite/devices/laptop.json';
    // B adds a comment; A receives it.
    clock.t += WINDOW_MS + 1;
    await b.view.startEdit('G-aaaaa');
    type(b.view, '# Aims\n\nWhy?%%[!review] Aly, 2026-10-30: Why?%%\n');
    await b.view.endEdit();
    await tick(40);
    await a.receive(card, b.read(card));
    // B resolves it, back to the text both had before.
    clock.t += WINDOW_MS + 1;
    await b.view.startEdit('G-aaaaa');
    type(b.view, '# Aims\n');
    await b.view.endEdit();
    await tick(40);
    assert.ok(b.read(rec), 'B keeps a record');
    // The card first: caught for now; then B's record: settled.
    await a.receive(card, b.read(card));
    await tick(40);
    assert.ok(a.view.reverted.has('G-aaaaa'), 'caught before the record');
    await a.receive(rec, b.read(rec));
    await tick(60);
    assert.ok(!a.view.reverted.has('G-aaaaa'), 'settled by B\'s record');
    // A stale copy from a third device, which nobody stands by: caught.
    clock.t += WINDOW_MS + 1;
    await a.view.startEdit('G-aaaaa');
    type(a.view, '# Aims\n\nNewer.\n');
    await a.view.endEdit();
    await tick(40);
    clock.t += WINDOW_MS + 1;
    await a.receive(card, T1);
    await tick(40);
    assert.ok(a.view.reverted.has('G-aaaaa'), 'an old copy is caught');
    // Kept on B, where the same copy arrived and was caught too: A's
    // mark settles once B's record arrives.
    await b.receive(card, T1);
    await tick(40);
    assert.ok(b.view.reverted.has('G-aaaaa'));
    clock.t += 5;
    await b.view.keepVersion('G-aaaaa');
    await tick(40);
    await a.receive(rec, b.read(rec));
    await tick(60);
    assert.ok(!a.view.reverted.has('G-aaaaa'), 'kept on B, settled on A');
});

test('a card written with no board open, as by the review endpoint, is ' +
     'recorded as this device\'s own text, here and for the others',
     async () => {
    const DendritePlugin = require('../src/main.js');
    const clock = { t: 1 };
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, FILES[INDEX]);
    const before = 'Total ==83==%%[!review] Aly, 2026-10-30: Why?%% TB.';
    await app.vault.create(cardPath('G-aaaaa'), before);
    const p = new DendritePlugin();
    p.app = app;
    p.history = new History(memoryStore(), () => clock.t);
    p.ledger = new Ledger(app.vault, 'nix', () => clock.t, 0);
    const f = app.vault.getAbstractFileByPath(cardPath('G-aaaaa'));
    const index = app.vault.getAbstractFileByPath(INDEX);
    const key = `${app.vault.getName ? app.vault.getName() : 'vault'}/` +
        'G-aaaaa';
    assert.equal(await p.suggestInFile(f, { quote: 'Total',
        replace: 'All', date: '2026-10-30' }, index), null);
    await tick(20);
    const text = app.vault.text.get(cardPath('G-aaaaa'));
    // A board opening later reads it as from outside: not an old copy.
    assert.equal(await p.history.observe(key, text, text, true), null);
    const rec = JSON.parse(app.vault.text.get(
        'W/Grant/_dendrite/devices/nix.json'));
    assert.ok(rec.cards['G-aaaaa'].wrote.h, 'in the record for the others');
});

test('a card the Linter tidies after Dendrite saves it is recorded as ' +
     'this device\'s text as the Linter left it, which is what syncs',
     async () => {
    const { hash } = require('../src/history.js');
    const clock = { t: 1 };
    const a = await device(FILES, clock, 'dtam03');
    const card = cardPath('G-aaaaa');
    // The Linter as Dendrite runs it: the table's spacing rewritten.
    a.plugin.lintCard = async (f) => {
        const t = a.app.vault.text.get(f.path);
        await a.app.vault.modify(f, t.replace('|a|b|', '| a | b |'));
    };
    clock.t += WINDOW_MS + 1;
    await a.view.startEdit('G-aaaaa');
    type(a.view, '# Aims\n\n|a|b|\n|-|-|\n');
    await a.view.endEdit();
    await tick(60);
    const body = a.read(card).replace(/^---[\s\S]*?---\n/, '');
    assert.match(body, /\| a \| b \|/, 'tidied');
    const rec = JSON.parse(a.read('W/Grant/_dendrite/devices/dtam03.json'));
    assert.equal(rec.cards['G-aaaaa'].wrote.h, hash(body),
                 'the tidied text is the one recorded');
});
