// Timings: what Dendrite's steps cost, recorded only when asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const h = require('./harness.cjs');
const timing = require('../src/timing.js');

test('a timed method is counted, with its total and longest, only while ' +
     'recording is on, and an async one until it settles', async () => {
    const proto = {
        quick(x) { return x + 1; },
        async slow() {
            await new Promise((r) => setTimeout(r, 30));
            return 'done';
        },
    };
    timing.wrap(proto, 'demo', ['quick', 'slow']);
    timing.setOn(false);
    assert.equal(proto.quick(1), 2);
    assert.equal(timing.take(), null, 'nothing recorded while off');
    timing.setOn(true);
    proto.quick(1);
    proto.quick(2);
    assert.equal(await proto.slow(), 'done');
    const got = timing.take();
    const by = new Map(got.steps.map((s) => [s.step, s]));
    assert.equal(by.get('demo.quick').n, 2);
    assert.ok(by.get('demo.slow').total_ms >= 25, 'waited for');
    assert.equal(got.steps[0].step, 'demo.slow', 'the longest first');
    assert.equal(timing.take(), null, 'cleared once taken');
    timing.setOn(false);
    assert.throws(() => timing.wrap(proto, 'demo', ['missing']),
                  /no method demo\.missing/);
});

test('the board and the preview are timed, and the plugin appends what ' +
     'was timed to the timings file as a line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dendrite-t-'));
    const was = process.env.DENDRITE_CONFIG_DIR;
    process.env.DENDRITE_CONFIG_DIR = dir;
    try {
        const Plugin = require('../src/main.js');
        const { DendriteView } = Plugin;
        const app = h.makeApp();
        app.vault.getName = () => 'My vault';
        app.vault.folders.add('W/Grant/cards');
        await app.vault.create('W/Grant/Grant.md',
            '---\ndendrite_prefix: G\n---\n- [[G-aaaaa|a]]\n');
        await app.vault.create('W/Grant/cards/G-aaaaa.md', 'Text.');
        timing.setOn(true);
        const view = new DendriteView({ app, updateHeader() {},
            detach() {} }, { settings: { headingTop: 1, cardWidth: 380,
            autosaveMs: 20 }, openAsMarkdown() {}, async lintCard() {},
            statusColour: () => null });
        await view.onOpen();
        await view.setState({ file: 'W/Grant/Grant.md' });
        await new Promise((r) => setTimeout(r, 50));
        const p = new Plugin();
        p.app = app;
        p.manifest = { version: '9.9.9' };
        p.writeTimings();
        const lines = fs.readFileSync(path.join(dir, 'vaults',
            'My vault', 'timings.jsonl'), 'utf8').trim().split('\n');
        assert.equal(lines.length, 1);
        const row = JSON.parse(lines[0]);
        assert.equal(row.version, '9.9.9');
        const steps = row.steps.map((s) => s.step);
        assert.ok(steps.includes('board.render'));
        assert.ok(steps.includes('board.renderCard'));
        assert.ok(row.longtasks, 'the window\'s stalls, counted');
        assert.ok(!lines[0].includes('Text.'), 'no text written');
    } finally {
        timing.setOn(false);
        if (was === undefined) delete process.env.DENDRITE_CONFIG_DIR;
        else process.env.DENDRITE_CONFIG_DIR = was;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a long animation frame is counted with its layout time and its ' +
     'scripts by source file', () => {
    timing.setOn(true);
    timing.frame({ startTime: 100, duration: 80, styleAndLayoutStart: 150,
        scripts: [{ sourceURL: 'app://obsidian.md/plugin:dendrite',
                    duration: 40 },
                  { sourceURL: 'app://obsidian.md/app.js', duration: 10 }] });
    timing.frame({ startTime: 300, duration: 60, styleAndLayoutStart: 0,
        scripts: [{ sourceURL: 'app://obsidian.md/plugin:dendrite',
                    duration: 20 }] });
    const got = timing.take();
    assert.equal(got.frames.n, 2);
    assert.equal(got.frames.total_ms, 140);
    assert.equal(got.frames.max_ms, 80);
    assert.equal(got.frames.layout_ms, 30, 'from layout start to the end');
    assert.deepEqual(got.frames.scripts, [
        { source: 'plugin:dendrite', ms: 60 },
        { source: 'app.js', ms: 10 }]);
    assert.equal(timing.take(), null, 'cleared once taken');
    timing.setOn(false);
});

test('profiling saves into a card and puts it back, a row per phase, and ' +
     'runs only on a manuscript marked dendrite_profile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dendrite-p-'));
    const was = process.env.DENDRITE_CONFIG_DIR;
    process.env.DENDRITE_CONFIG_DIR = dir;
    const Plugin = require('../src/main.js');
    const { DendriteView, DendritePreview } = Plugin;
    const make = async (marked) => {
        const app = h.makeApp();
        app.vault.getName = () => 'test_vault';
        app.vault.folders.add('W/Grant/cards');
        await app.vault.create('W/Grant/Grant.md', '---\n' +
            (marked ? 'dendrite_profile: true\n' : '') +
            'dendrite_prefix: G\n---\n- [[G-aaaaa|a]]\n- [[G-bbbbb|b]]\n');
        await app.vault.create('W/Grant/cards/G-aaaaa.md', 'First.');
        await app.vault.create('W/Grant/cards/G-bbbbb.md', 'Second.');
        const settings = { headingTop: 1, cardWidth: 380, autosaveMs: 20 };
        const host = { settings, openAsMarkdown() {}, async lintCard() {},
                       statusColour: () => null, focusCard() {} };
        const view = new DendriteView({ app, updateHeader() {},
                                        detach() {} }, host);
        await view.onOpen();
        await view.setState({ file: 'W/Grant/Grant.md' });
        const p = new Plugin();
        p.app = app;
        p.manifest = { version: '9.9.9' };
        return { app, view, p, host };
    };
    const file = path.join(dir, 'vaults', 'test_vault', 'profile.jsonl');
    try {
        const plain = await make(false);
        h.notices.length = 0;
        assert.equal(await plain.p.runProfile(plain.view), null);
        assert.match(h.notices[0], /only on a manuscript whose index has/);
        assert.ok(!fs.existsSync(file), 'nothing written');

        const { app, view, p, host } = await make(true);
        const card = 'W/Grant/cards/G-aaaaa.md';
        const before = app.vault.text.get(card);
        let preview = null;
        // Waits past the preview's 300 ms refresh.
        const opts = { saves: 2, every: 30, wait: 600,
            openPreview: async () => {
                preview = new DendritePreview({ app, updateHeader() {} },
                                              host);
                await preview.onOpen();
                await preview.setState({ file: 'W/Grant/Grant.md' });
                return preview;
            },
            closePreview: () => preview.onClose() };
        // runProfile wires its own preview; profile() takes the hooks.
        const { profile } = require('../src/profile.js');
        const rows = await profile(view, opts);
        assert.deepEqual(rows.map((r) => r.phase), ['redraw the board',
            'open the preview', '2 saves, preview open',
            'scroll the preview', 'close the preview',
            '2 saves, preview closed']);
        const steps = (i) => rows[i].steps.map((s) => s.step);
        assert.ok(steps(0).includes('board.render'));
        assert.ok(steps(2).includes('preview.refresh'), 'saves seen');
        assert.equal(app.vault.text.get(card), before, 'card put back');
        assert.equal(timing.isOn(), false, 'timing as it was');

        // No workspace here to split: runProfile without a preview.
        p.openPreview = async () => {};
        p.previewLeaf = () => null;
        const ran = await p.runProfile(view, { saves: 1, every: 10,
                                               wait: 10 });
        assert.equal(ran.length, 6);
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
            .map((l) => JSON.parse(l));
        assert.equal(lines.length, 6);
        assert.equal(lines[0].version, '9.9.9');
        assert.equal(lines[0].phase, 'redraw the board');
        assert.ok(!JSON.stringify(lines).includes('First.'), 'no text');
        assert.equal(app.vault.text.get(card), before);
    } finally {
        timing.setOn(false);
        if (was === undefined) delete process.env.DENDRITE_CONFIG_DIR;
        else process.env.DENDRITE_CONFIG_DIR = was;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
