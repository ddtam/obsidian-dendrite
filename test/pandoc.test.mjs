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

test('Zotero is asked with Node\'s http, which sends no browser headers',
     async () => {
    // Zotero drops a request carrying a browser User-Agent or an Origin
    // without answering (2026-10-16, checked with curl), so a page fetch
    // and Obsidian's requestUrl both read as Zotero being closed. A local
    // server stands in for Zotero here and refuses the same way.
    const http = require('http');
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.push({ headers: req.headers, body });
            if (/Mozilla/.test(req.headers['user-agent'] || '') ||
                req.headers.origin) {
                req.socket.destroy();
                return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ jsonrpc: '2.0',
                                     result: '@article{k, title = {T}}' }));
        });
    });
    require('./harness.cjs');
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
        const Plugin = require('../src/main.js');
        const deps = Plugin.prototype.pandocDeps.call(
            { pandocEnv: () => ({}) });
        assert.deepEqual(await p.fetchBib(['k'], port, deps),
                         { bib: '@article{k, title = {T}}' });
        assert.equal(JSON.parse(seen[0].body).method, 'item.export');
        assert.equal(seen[0].headers['user-agent'], undefined);
        assert.equal(seen[0].headers.origin, undefined);
    } finally {
        await new Promise((r) => server.close(r));
    }
    const Plugin = require('../src/main.js');
    const deps = Plugin.prototype.pandocDeps.call({ pandocEnv: () => ({}) });
    assert.deepEqual(await p.fetchBib(['k'], port, deps), { down: true },
                     'nothing listening is Zotero being closed');
});
