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
    const was = process.env.DENDRITE_REVIEW_API_FILE;
    process.env.DENDRITE_REVIEW_API_FILE = path.join(dir, 'review-api.json');
    try {
        const Plugin = require('../src/main.js');
        const { DendriteView } = Plugin;
        const app = h.makeApp();
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
        const lines = fs.readFileSync(path.join(dir, 'timings.jsonl'),
                                      'utf8').trim().split('\n');
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
        if (was === undefined) delete process.env.DENDRITE_REVIEW_API_FILE;
        else process.env.DENDRITE_REVIEW_API_FILE = was;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
