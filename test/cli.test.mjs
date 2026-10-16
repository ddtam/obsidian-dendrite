// The command-line export against the plugin's own: the same manuscript
// exported by the view in the in-memory vault and by the script from the
// same files on disk must agree, so the script cannot drift from Export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadManuscript, exportText, report, cardMap }
    from '../scripts/dendrite-export.mjs';

const require = createRequire(import.meta.url);
const h = require('./harness.cjs');
const { DendriteView } = require('../src/main.js');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const INDEX = 'W/Grant/Grant.md';
const SCRIPT = fileURLToPath(new URL('../scripts/dendrite-export.mjs',
                                     import.meta.url));

test('the command line exports what Export does, and reports quotas as ' +
     'the board measures them', async () => {
    const app = h.makeApp();
    app.vault.folders.add('W/Grant/cards');
    await app.vault.create(INDEX, '---\ndendrite_prefix: G\n' +
        'dendrite_number_sections: true\ndendrite_words_per_page: 4\n' +
        'dendrite_limit: 1 page\n---\n' +
        '- [[G-aaaaa|Aims]]\n    - [[G-bbbbb|s]]\n        - [[G-ccccc|p]]\n' +
        '    - [[G-ddddd|n]]\n        - [[G-eeeee|under]]\n' +
        '- [[G-fffff|Plan]]\n    - [[G-ggggg|p]]\n');
    const cards = {
        'G-aaaaa': '---\ndendrite_limit: 3 words\n' +
            'dendrite_limit_required: true\n---\n# Aims\nPlanning text.',
        'G-bbbbb': '---\ndendrite_role: scaffolding\n---\n# Goal\nWhy.',
        'G-ccccc': 'One two three four.^[[@k]] %% aside %%',
        'G-ddddd': '---\ndendrite_role: notes\n---\nTo self.',
        'G-eeeee': 'Hidden.',
        'G-fffff': '# Plan',
        'G-ggggg': 'Five six.^[[@k]]',
    };
    for (const [id, t] of Object.entries(cards)) {
        await app.vault.create(`W/Grant/cards/${id}.md`, t);
    }
    const plugin = { settings: { headingTop: 1, cardWidth: 380,
                                 autosaveMs: 20, vimKeys: true },
                     openAsMarkdown() {}, async lintCard() {},
                     statusColour: () => null };
    const view = new DendriteView({ app, updateHeader() {}, detach() {} },
                                  plugin);
    await view.onOpen();
    await view.setState({ file: INDEX });
    await tick(20);
    await view.exportTo(null);
    await view.updateCounts();
    const exported = app.vault.text.get('W/Grant/exports/Grant.md');
    // The same files, as the view left them, on disk in a vault.
    const dir = mkdtempSync(path.join(tmpdir(), 'dendrite-cli-'));
    try {
        mkdirSync(path.join(dir, '.obsidian'));
        for (const [p, t] of app.vault.text) {
            if (p.startsWith('W/Grant/exports/')) continue;
            mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
            writeFileSync(path.join(dir, p), t);
        }
        const index = path.join(dir, INDEX);
        const m = loadManuscript(index);
        assert.equal(exportText(m), exported, 'the same text as Export');
        assert.match(exported, /^# 1\. Aims\n\nOne two three four\.\[\^1\]/,
                     'the fixture exercises numbering and scaffolding');
        assert.equal(execFileSync(process.execPath, [SCRIPT, index],
                                  { encoding: 'utf8' }), exported);
        const r = report(m);
        assert.deepEqual(r.sections.map((s) => [s.label, s.words]),
                         [['Aims', 7], ['Plan', 5]],
                         'headings and footnote lines count, as on the board');
        const aims = r.sections[0].quota;
        assert.equal(aims.used, view.quotaReports.get('G-aaaaa').used);
        assert.equal(aims.over, true);
        assert.equal(r.total.quota.used, view.quotaReports.get(null).used);
        const map = cardMap(m);
        const row = (id) => map.find((x) => x.id === id);
        assert.equal(row('G-bbbbb').role, 'scaffolding');
        assert.equal(row('G-eeeee').leftOutUnder, 'G-ddddd');
        assert.equal(row('G-eeeee').printed, 0);
        assert.equal(row('G-ccccc').printed, 6, 'with its footnote line');
        assert.equal(row('G-ggggg').printed, 2, 'the note is given above');
        assert.equal(map.reduce((a, x) => a + x.printed, 0), r.total.words,
                     'the cards add up to the manuscript');
        assert.equal(row('G-aaaaa').number, '1.');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
