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
                { result: JSON.stringify(keys.map((k) => zotero[k])) } :
                { error: { message: 'not found' } }) };
        },
    };
};

test('export fetches exactly the cited keys and runs Pandoc with them',
     async () => {
    const deps = fakeDeps({ smith2020: { id: 'smith2020', PMID: '1' },
                            lee2019: { id: 'lee2019' } });
    const r = await p.exportDocument({
        md: 'Text [@smith2020; @lee2019].', format: 'pdf',
        output: '/vault/exports/G.pdf', csl: '/vault/style.csl' }, deps);
    assert.deepEqual(r, { ok: true, keys: ['smith2020', 'lee2019'],
                          layout: null });
    const [cmd, args, files] = deps.runs[0];
    assert.equal(cmd, 'pandoc');
    assert.ok(args.includes('--citeproc'));
    assert.ok(args.includes('--pdf-engine=xelatex'));
    assert.equal(args[args.indexOf('--csl') + 1], '/vault/style.csl');
    const bib = args[args.indexOf('--bibliography') + 1];
    assert.match(bib, /\.json$/, 'CSL JSON, which Pandoc reads by name');
    assert.deepEqual(JSON.parse(files[bib]),
                     [{ id: 'smith2020', PMID: '1' }, { id: 'lee2019' }],
                     'with the PMID a style can print');
    assert.deepEqual(Object.keys(deps.files), [],
                     'temporary files are removed');
});

test('the reference list gets a heading, References unless the ' +
     'manuscript names another or none', () => {
    const base = { input: 'in.md', output: 'o.pdf', format: 'pdf',
                   bibliography: '/t/b.json' };
    const meta = (style) => {
        const a = p.pandocArgs(Object.assign({ style }, base));
        return a.filter((x, i) => a[i - 1] === '-M');
    };
    assert.deepEqual(meta(), ['reference-section-title=References']);
    assert.deepEqual(meta({ referencesTitle: 'Bibliography' }),
                     ['reference-section-title=Bibliography']);
    assert.deepEqual(meta({ referencesTitle: false }), []);
    assert.ok(!p.pandocArgs({ input: 'i', output: 'o', format: 'pdf' })
        .includes('-M'), 'no citations, no heading');
});

test('a key Zotero lacks is named and nothing is exported', async () => {
    const deps = fakeDeps({ smith2020: { id: 'smith2020' } });
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
                result: JSON.stringify([{ id: 'k', title: 'T' }]) }));
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
                         { bib: '[{"id":"k","title":"T"}]' });
        assert.deepEqual(JSON.parse(seen[0].body).params,
                         [['k'], 'Better CSL JSON']);
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

test('the manuscript\'s style reaches Pandoc: font, size, margin, paper, ' +
     'spacing, page numbers, defaults and Word\'s reference', () => {
    const base = { input: 'in.md', output: 'o.pdf', format: 'pdf' };
    const v = (args) => args.filter((a, i) => args[i - 1] === '-V');
    assert.deepEqual(v(p.pandocArgs(base)), ['geometry:margin=2.5cm'],
                     'nothing set: Pandoc\'s look, 2.5cm margins');
    const style = { font: 'Arial', fontSize: 10, margin: '2cm',
                    paper: 'a4', lineSpacing: 1.15, pageNumbers: false,
                    defaults: '/v/grant.yaml',
                    referenceDocx: '/v/ref.docx' };
    const pdf = p.pandocArgs(Object.assign({ style }, base));
    assert.deepEqual(v(pdf), ['geometry:margin=2cm', 'papersize=a4',
        'mainfont=Arial', 'fontsize=10pt', 'linestretch=1.15',
        'pagestyle=empty']);
    assert.equal(pdf[0], '--defaults=/v/grant.yaml',
                 'a defaults file first, so the settings win over it');
    assert.ok(!pdf.some((a) => a.startsWith('--reference-doc')));
    assert.ok(v(p.pandocArgs(Object.assign({}, base,
        { style: { fontSize: 9 } }))).includes('documentclass=extarticle'),
        'a size article lacks');
    const docx = p.pandocArgs({ input: 'in.md', output: 'o.docx',
                                format: 'docx', style });
    assert.ok(docx.includes('--reference-doc=/v/ref.docx'));
    assert.deepEqual(v(docx), [], 'PDF settings stay out of Word');
});

// A PDF as XeLaTeX writes one: its page objects and document information
// compressed into a stream, here with a plain object beside it.
const fakePdf = (pages, bodyEnd) => {
    const { deflateSync } = require('node:zlib');
    const objs = Array.from({ length: pages }, () =>
        '<< /Type /Page /Parent 2 0 R >>').join('\n') +
        `\n<< /Type /Pages /Count ${pages} >>` +
        (bodyEnd ? `\n<< /DendriteBodyEnd (${bodyEnd}) >>` : '');
    return Buffer.concat([
        Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /ObjStm >>\nstream\n'),
        deflateSync(Buffer.from(objs)),
        Buffer.from('\nendstream\nendobj\n3 0 obj\n<< /Length 4 >>\n' +
                    'stream\nabcd\nendstream\nendobj\n%%EOF\n')]);
};

test('a PDF\'s pages and the page its body ends on are read from its ' +
     'compressed objects', () => {
    const { inflateSync } = require('node:zlib');
    assert.deepEqual(p.pdfPages(fakePdf(10, 4), inflateSync),
                     { pages: 10, bodyEnd: 4 });
    assert.deepEqual(p.pdfPages(fakePdf(3, null), inflateSync),
                     { pages: 3, bodyEnd: null });
});

test('words per page are measured over the body, the last page as half',
     () => {
    assert.equal(p.measuredRate(1400, { pages: 10, bodyEnd: 4 }, true),
                 400, '1400 words over 3.5 pages, references left out');
    assert.equal(p.measuredRate(1400, { pages: 4, bodyEnd: null }, false),
                 400, 'no mark and nothing cited: every page is body');
    assert.equal(p.measuredRate(1400, { pages: 10, bodyEnd: null }, true),
                 null, 'no mark, and a reference list may follow');
    assert.equal(p.measuredRate(300, { pages: 1, bodyEnd: 1 }, false),
                 null, 'one page is too short to measure');
});

test('a PDF export marks the end of the body; Word gets no mark', async () => {
    const { inflateSync } = require('node:zlib');
    for (const format of ['pdf', 'docx']) {
        const deps = fakeDeps(null);
        let input = null;
        deps.run = async (cmd, args) => { input = deps.files[args[0]]; };
        deps.readFile = async () => fakePdf(6, 5);
        deps.inflate = inflateSync;
        const r = await p.exportDocument({ md: 'Text.', format,
                                           output: '/o.' + format }, deps);
        assert.equal(input.includes('/DendriteBodyEnd'), format === 'pdf');
        assert.deepEqual(r.layout, format === 'pdf' ?
            { pages: 6, bodyEnd: 5 } : null);
    }
});

test('a PDF puts one body line above the footnote rule, or the ' +
     'manuscript\'s own gap', async () => {
    assert.equal(p.footnoteGap({}), '12pt', '10pt type, single spaced');
    assert.equal(p.footnoteGap({ fontSize: 10, lineSpacing: 1.5 }), '18pt');
    assert.equal(p.footnoteGap({ footnoteGap: '14pt' }), '14pt');
    const { exportStyle } = require('../src/main.js');
    const gap = (v) => exportStyle({ dendrite_footnote_gap: v }).footnoteGap;
    assert.equal(gap(14), '14pt', 'a bare number is in points');
    assert.equal(gap('0.5cm'), '0.5cm');
    assert.equal(gap('wide'), null, 'not a length: the default');
    for (const format of ['pdf', 'docx']) {
        const deps = fakeDeps(null);
        let header = null;
        deps.run = async (cmd, args) => {
            const a = args.find((x) => x.startsWith('--include-in-header='));
            header = a ? deps.files[a.split('=')[1]] : null;
        };
        await p.exportDocument({ md: 'Text.', format, output: '/o.' + format,
            style: { fontSize: 10, lineSpacing: 1.5 } }, deps);
        assert.equal(header, format === 'pdf' ?
            '\\setlength{\\skip\\footins}{18pt plus 4pt minus 2pt}\n' :
            null);
    }
});
