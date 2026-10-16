// Tests for PDF and Word export: citation keys, Obsidian syntax for
// Pandoc, and the export flow with Zotero and Pandoc stood in for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const p = require('../src/pandoc.js');

test('citation keys are found once each, emails are not keys', () => {
    assert.deepEqual(
        p.citekeys('As shown [@smith2020; @lee2019, p. 3] and @smith2020. ' +
                   'Mail me at a@b.org. See [-@jones2021].'),
        ['smith2020', 'lee2019', 'jones2021']);
    assert.deepEqual(p.citekeys('No citations.'), []);
});

test('Obsidian links, embeds and highlights are translated for Pandoc',
     () => {
    const out = p.toPandoc(
        'See [[Some Note|the note]] and [[Other#Part]]. ==Key== point.\n' +
        '![[fig.png|400]]\n![[Embedded note]]',
        (n) => (n === 'fig.png' ? '/vault/att/fig.png' : null));
    assert.equal(out, 'See the note and Part. Key point.\n' +
                 '![](</vault/att/fig.png>){width=400px}\nEmbedded note');
});

const fakeDeps = (zotero, opts = {}) => {
    const files = {};
    const runs = [];
    return {
        files, runs,
        tmpdir: () => '/tmp',
        join: (...a) => a.join('/'),
        writeFile: async (f, t) => { files[f] = t; },
        remove: (f) => { delete files[f]; },
        run: async (cmd, args) => {
            runs.push([cmd, args, { ...files }]);
            if (opts.pandocFails) {
                const e = new Error('x');
                e.stderr = 'xelatex not found';
                throw e;
            }
        },
        fetch: async (url, init) => {
            if (!zotero) throw new Error('connection refused');
            const keys = JSON.parse(init.body).params[0];
            const known = keys.every((k) => zotero[k]);
            return { json: async () => (known ?
                { result: keys.map((k) => zotero[k]).join('\n') } :
                { error: { message: 'not found' } }) };
        },
    };
};

test('export fetches exactly the cited keys and runs Pandoc with them',
     async () => {
    const deps = fakeDeps({ smith2020: '@article{smith2020}',
                            lee2019: '@book{lee2019}' });
    const r = await p.exportDocument({
        md: 'Text [@smith2020; @lee2019].', format: 'pdf',
        output: '/vault/exports/G.pdf', csl: '/vault/style.csl' }, deps);
    assert.deepEqual(r, { ok: true, keys: ['smith2020', 'lee2019'] });
    const [cmd, args, files] = deps.runs[0];
    assert.equal(cmd, 'pandoc');
    assert.ok(args.includes('--citeproc'));
    assert.ok(args.includes('--pdf-engine=xelatex'));
    assert.equal(args[args.indexOf('--csl') + 1], '/vault/style.csl');
    const bib = args[args.indexOf('--bibliography') + 1];
    assert.equal(files[bib], '@article{smith2020}\n@book{lee2019}');
    assert.deepEqual(Object.keys(deps.files), [],
                     'temporary files are removed');
});

test('a key Zotero lacks is named and nothing is exported', async () => {
    const deps = fakeDeps({ smith2020: '@article{smith2020}' });
    const r = await p.exportDocument({
        md: 'Text [@smith2020; @ghost2024].', format: 'docx',
        output: '/o.docx' }, deps);
    assert.match(r.error, /no item for @ghost2024/);
    assert.equal(deps.runs.length, 0);
});

test('with Zotero closed, the fallback .bib is used, or export stops',
     async () => {
    let deps = fakeDeps(null);
    let r = await p.exportDocument({ md: '[@a]', format: 'docx',
                                     output: '/o.docx' }, deps);
    assert.match(r.error, /Zotero did not answer on port 23119/);
    deps = fakeDeps(null);
    r = await p.exportDocument({ md: '[@a]', format: 'docx',
        output: '/o.docx', fallbackBib: '/lib.bib' }, deps);
    assert.ok(r.ok);
    const args = deps.runs[0][1];
    assert.equal(args[args.indexOf('--bibliography') + 1], '/lib.bib');
});

test('no citations: no Zotero call, no citeproc; Pandoc errors surface',
     async () => {
    let deps = fakeDeps(null);
    let r = await p.exportDocument({ md: 'Plain.', format: 'docx',
                                     output: '/o.docx' }, deps);
    assert.ok(r.ok);
    assert.ok(!deps.runs[0][1].includes('--citeproc'));
    deps = fakeDeps(null, { pandocFails: true });
    r = await p.exportDocument({ md: 'Plain.', format: 'pdf',
                                output: '/o.pdf' }, deps);
    assert.match(r.error, /Pandoc failed: xelatex not found/);
});

test('Zotero is asked through Obsidian, not the page', async () => {
    // In Obsidian a page fetch to Better BibTeX fails its cross-origin
    // check, which read as Zotero being closed (2026-10-16). The harness
    // has no cross-origin check, so this shows only that the request goes
    // through Obsidian's requestUrl, which makes none.
    const h = require('./harness.cjs');
    const Plugin = require('../src/main.js');
    const deps = Plugin.prototype.pandocDeps.call({ pandocEnv: () => ({}) });
    const before = h.requests.length;
    h.obsidian.respond = () => ({ status: 200,
        json: { jsonrpc: '2.0', result: '@article{k, title = {T}}' } });
    const got = await p.fetchBib(['k'], 23119, deps);
    assert.deepEqual(got, { bib: '@article{k, title = {T}}' });
    const req = h.requests[before];
    assert.equal(req.url, 'http://127.0.0.1:23119/better-bibtex/json-rpc');
    assert.equal(req.method, 'POST');
    assert.equal(req.throw, false);
    h.obsidian.respond = () => { throw new Error('ECONNREFUSED'); };
    assert.deepEqual(await p.fetchBib(['k'], 23119, deps), { down: true },
                     'a refused connection is still Zotero being closed');
});
