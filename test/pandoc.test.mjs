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
        if (format === 'pdf') {
            assert.ok(header.startsWith(
                '\\setlength{\\skip\\footins}{18pt plus 4pt minus 2pt}\n'));
        } else {
            assert.equal(header, null);
        }
    }
});

test('running headers and footers print on every page in the body\'s ' +
     'type, from left, centre and right slots', () => {
    const st = { header: { left: 'Derek Tam\n**Clonal R&D: 100% tracked**' },
                 fontSize: 10, lineSpacing: 1.5 };
    const tex = p.preamble(st);
    assert.ok(tex.includes('\\usepackage{fancyhdr}'));
    assert.ok(tex.includes('\\pagestyle{fancy}'));
    // Escaped for LaTeX; ** is bold; each line its own.
    assert.ok(tex.includes('\\fancyhead[L]{Derek Tam\\\\' +
        '\\textbf{Clonal R\\&D: 100\\% tracked}}'), tex);
    assert.ok(tex.includes('\\renewcommand{\\headrulewidth}{0pt}'));
    // No footer set: the page number stays at the foot's centre.
    assert.ok(tex.includes('\\fancyfoot[C]{\\thepage}'));
    // A slot that prints {page} takes over the page number.
    const own = p.preamble({ header: { right: 'Page {page} of {pages}' } });
    assert.ok(own.includes('\\fancyhead[R]{Page \\thepage{} of ' +
        '\\pageref*{LastPage}}'), own);
    assert.ok(own.includes('\\usepackage{lastpage}'));
    assert.ok(!own.includes('\\fancyfoot[C]{\\thepage}'));
    // A footer set is the footer, whole.
    const foot = p.preamble({ footer: { left: '*Confidential*' } });
    assert.ok(foot.includes('\\fancyfoot[L]{\\textit{Confidential}}'));
    assert.ok(!foot.includes('\\fancyfoot[C]{\\thepage}'));
    assert.ok(p.preamble({ header: { left: 'X' }, pageNumbers: false })
        .includes('\\fancyfoot[C]{}'));
    assert.ok(!p.preamble({}).includes('fancyhdr'), 'nothing set, none');
    // The margin is measured to the header's top and the footer's
    // bottom, so nothing is printed in it, with room for their lines.
    const v = (args) => args.filter((a, i) => args[i - 1] === '-V');
    const args = v(p.pandocArgs({ input: 'i', output: 'o.pdf',
                                  format: 'pdf', style: st }));
    assert.ok(args.includes('geometry:includehead'));
    assert.ok(args.includes('geometry:headheight=38pt'), args.join(' '));
    assert.ok(!args.includes('geometry:includefoot'),
              'page numbers alone sit in the margin, as before');
    assert.ok(v(p.pandocArgs({ input: 'i', output: 'o.pdf', format: 'pdf',
        style: { footer: { center: 'a\nb' } } }))
        .includes('geometry:includefoot'));
    assert.ok(!v(p.pandocArgs({ input: 'i', output: 'o.pdf', format: 'pdf',
        style: Object.assign({ pageNumbers: false }, st) }))
        .includes('pagestyle=empty'), 'the header\'s style decides');
    // In the margin instead: the text keeps its whole area.
    const inside = v(p.pandocArgs({ input: 'i', output: 'o.pdf',
        format: 'pdf', style: Object.assign({ headerInMargin: true,
            footer: { right: '{page}' } }, st) }));
    assert.ok(!inside.includes('geometry:includehead'));
    assert.ok(!inside.includes('geometry:includefoot'));
    assert.ok(inside.includes('geometry:headheight=38pt'),
              'still room for its lines');
    const { exportStyle } = require('../src/main.js');
    assert.equal(exportStyle({ dendrite_header_in_margin: true })
        .headerInMargin, true);
    const es = exportStyle({ dendrite_header_left: ['A', '**B**'],
                             dendrite_footer_right: '{page}',
                             dendrite_header_center: ' ' });
    assert.deepEqual(es.header, { left: 'A\n**B**' }, 'a list of lines');
    assert.deepEqual(es.footer, { right: '{page}' });
    assert.equal(exportStyle({}).header, null);
});

test('Pandoc missing from the search path is said plainly', async () => {
    const deps = fakeDeps(null);
    deps.run = async () => {
        throw Object.assign(new Error('spawn pandoc ENOENT'),
                            { code: 'ENOENT' });
    };
    const r = await p.exportDocument({ md: 'Plain.', format: 'docx',
                                       output: '/o.docx',
                                       pandoc: 'pandoc' }, deps);
    assert.match(r.error, /Pandoc was not found \(looked for "pandoc"\)/);
    assert.match(r.error, /full path/);
});

test('the search path keeps the platform\'s separator and its own ' +
     'variable name', () => {
    const win = p.searchPath({ Path: 'C:\\Windows', HOME: 'x' }, 'win32',
                             ['C:\\Pandoc']);
    assert.equal(win.Path, 'C:\\Windows;C:\\Pandoc');
    assert.ok(!('PATH' in win), 'no second PATH beside Path');
    const mac = p.searchPath({ PATH: '/usr/bin' }, 'darwin',
                             ['/opt/homebrew/bin', '/usr/bin']);
    assert.equal(mac.PATH, '/usr/bin:/opt/homebrew/bin');
    assert.equal(p.searchPath({}, 'linux', ['/a']).PATH, '/a');
});

test('conda installs in the home folder are searched', () => {
    const names = ['anaconda3-linux', 'miniconda3', 'miniforge3',
                   'mambaforge', 'projects', 'condarc'];
    assert.deepEqual(p.condaBins(names, '/home/u'),
                     ['/home/u/anaconda3-linux/bin', '/home/u/miniconda3/bin',
                      '/home/u/miniforge3/bin', '/home/u/mambaforge/bin']);
});

test('a table\'s and a figure\'s captions become Pandoc\'s own, so ' +
     'LaTeX keeps each with its table or figure', () => {
    const md = 'See Table 1.\n\n**Table 1.** Budget\n\n| Y | C |\n' +
        '| - | - |\n| 1 | 2 |\n\n![](<x.png>){width=300px}\n\n' +
        '**Figure 1.** Design [a] b.\n\n**Table 2.** Not before a table.\n';
    assert.equal(p.pandocCaptions(md),
        'See Table 1.\n\nTable: **Table 1.** Budget\n\n| Y | C |\n' +
        '| - | - |\n| 1 | 2 |\n\n' +
        '![**Figure 1.** Design \\[a\\] b.](<x.png>){width=300px}\n\n' +
        '**Table 2.** Not before a table.\n');
    const pre = p.preamble({});
    assert.match(pre, /\\usepackage\{caption\}/);
    assert.match(pre, /labelformat=empty/);
    assert.match(pre, /\\setlength\{\\LTcapwidth\}\{\\textwidth\}/);
    // Pandoc loads longtable only for a document with a table.
    assert.match(pre, /\\ifdefined\\LTcapwidth\\setlength\{\\LTcapwidth\}/);
});

test('a PDF\'s tables are single spaced inside, with rows set apart, ' +
     'and the table filter runs after citations are resolved', () => {
    const pre = p.preamble({ lineSpacing: 1.5 });
    assert.match(pre, /\\usepackage\{longtable,booktabs,array,calc,/,
                 'loaded for a table that reaches LaTeX raw');
    assert.match(pre, /\\AtBeginEnvironment\{longtable\}\{\\ifdefined/);
    assert.match(pre, /\\setstretch\{1\}/);
    const args = p.pandocArgs({ input: 'in.md', output: 'out.pdf',
                                format: 'pdf', bibliography: 'b.json',
                                tables: 't.lua',
                                style: { margin: '2.5cm', fontSize: 10 } });
    const at = (x) => args.findIndex((a) => a.startsWith(x));
    assert.ok(at('--lua-filter=t.lua') > at('--citeproc'));
    assert.ok(args.includes('dendrite-chars=94'), 'letter, 2.5cm, 10pt');
    assert.equal(p.lineChars({ margin: '1in', fontSize: 12, paper: 'a4' }),
                 75);
    const docx = p.pandocArgs({ input: 'in.md', output: 'out.docx',
                                format: 'docx', tables: 't.lua' });
    assert.ok(docx.includes('--lua-filter=t.lua'), 'Word too, for rules');
});

test('the table filter draws a rule for a row of dashes, widens a ' +
     'column to its longest word, and keeps a short table on one page',
     (t) => {
    const { spawnSync } = require('child_process');
    if (spawnSync('pandoc', ['--version']).status !== 0) {
        t.skip('pandoc is not installed');
        return;
    }
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dendrite-'));
    const lua = path.join(dir, 'tables.lua');
    fs.writeFileSync(lua, p.TABLES_LUA);
    const md = '## Storage\n\n### Details\n\n' +
        '| Data | Patients | Libraries |\n' +
        '| ----------------------------- | -------: | ' +
        '------------------------------------------------------------ |\n' +
        '| --- | --- | --- |\n' +
        '| WGS CRAMs | 175 | 534 (175 normal, 175 pre-, 175 post) |\n' +
        '| RNA CRAMs | - | 318 |\n' +
        '| ------- | | |\n' +
        '| **Total** | | 852 |\n';
    const run = (to) => spawnSync('pandoc', [
        '--from', 'markdown', '-t', to, `--lua-filter=${lua}`,
        '-M', 'dendrite-chars=94', '-o', path.join(dir, 'out.' + to)],
        { input: md, encoding: 'utf8' });
    const r = run('latex');
    const w = run('docx');
    const tex = fs.readFileSync(path.join(dir, 'out.latex'), 'utf8');
    const xml = spawnSync('unzip', ['-p', path.join(dir, 'out.docx'),
                                    'word/document.xml'],
                          { encoding: 'utf8' }).stdout;
    fs.rmSync(dir, { recursive: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(w.status, 0, w.stderr);
    assert.equal((tex.match(/\\midrule/g) || []).length, 2,
                 'under the header, and the row of dashes; the one ' +
                 'straight under the header is dropped');
    assert.match(tex, /RNA CRAMs & - & 318 \\\\\*\n\\midrule\n\\textbf/,
                 'one dash is a value; seven are a rule');
    assert.match(tex, /WGS CRAMs & 175 & .* \\\\\*\n/, 'no break after');
    const need = tex.indexOf('\\dendriteneed{');
    assert.ok(need >= 0 && need < tex.indexOf('Storage') &&
              tex.indexOf('\\dendriteneed{', need + 1) < 0,
              'room asked once, before the first of the headings');
    assert.match(tex, /\\raggedleft\n\\dendriteheadstrut\nPatients/,
                 'a right-aligned header too');
    const widths = [...tex.matchAll(/\\real\{([\d.]+)\}/g)]
        .map((m) => Number(m[1]));
    // 'Patients' at 1.2 letters each, plus one, of 94 less three gaps.
    assert.ok(widths[1] >= (8 * 1.2 + 1) / (94 - 7.5) - 1e-4,
              `Patients wide enough: ${widths}`);
    if (xml) {
        assert.match(xml, /w:lastRow="1"/, 'Word: the total row');
        assert.ok(!/>-------</.test(xml), 'Word: no row of dashes');
    }
});

test('a .docx is read and written as a zip', () => {
    const d = require('../src/docx.js');
    const zlib = require('zlib');
    assert.equal(d.crc32(Buffer.from('123456789')), 0xcbf43926);
    const files = [{ name: 'word/styles.xml', data: Buffer.from('<a/>') },
                   { name: 'é.txt', data: Buffer.from('x'.repeat(500)) }];
    const back = d.readZip(d.writeZip(files, zlib), zlib);
    assert.deepEqual(back.map((f) => [f.name, f.data.toString()]),
                     files.map((f) => [f.name, f.data.toString()]));
});

test('Word\'s styles take the manuscript\'s font, size, spacing and ' +
     'page, with all text black', () => {
    const d = require('../src/docx.js');
    const styles = '<w:docDefaults><w:rPrDefault><w:rPr>' +
        '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" />' +
        '<w:sz w:val="24" /><w:szCs w:val="24" /></w:rPr></w:rPrDefault>' +
        '<w:pPrDefault>\n  <w:pPr>\n    <w:spacing w:after="200" />' +
        '</w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:rPr>' +
        '<w:rFonts w:asciiTheme="majorHAnsi" />' +
        '<w:color w:val="345A8A" w:themeColor="accent1" />' +
        '<w:sz w:val="32" /></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Compact"><w:pPr>' +
        '<w:spacing w:before="36" w:after="36" /></w:pPr></w:style>' +
        '<w:style w:type="character" w:styleId="VerbatimChar"><w:rPr>' +
        '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" /></w:rPr>' +
        '</w:style>';
    const out = d.styleXml(styles, { font: 'Arial', fontSize: 10,
                                     lineSpacing: 1.5 });
    assert.ok(!/asciiTheme/.test(out), 'theme fonts replaced');
    assert.equal((out.match(/w:ascii="Arial"/g) || []).length, 2);
    assert.match(out, /w:ascii="Consolas"/, 'code keeps its own font');
    assert.match(out, /<w:color w:val="000000" \/>/);
    assert.ok(!/345A8A|themeColor/.test(out), 'no colour left');
    assert.match(out, /<w:sz w:val="20" \/>/, '12pt body becomes 10pt');
    assert.match(out, /<w:sz w:val="27" \/>/, 'a heading in proportion');
    assert.match(out, /<w:spacing w:line="360" w:lineRule="auto" w:after/,
                 'one and a half lines');
    assert.match(out, /styleId="Compact"><w:pPr><w:spacing w:line="240"/,
                 'table cells single spaced');
    const doc = d.pageXml('<w:body><w:p/><w:sectPr><w:pgSz/></w:sectPr>' +
                          '</w:body>', { marginPt: 70.9, paper: 'a4' });
    assert.equal(doc, '<w:body><w:p/><w:sectPr>' +
        '<w:pgSz w:w="11906" w:h="16838" /><w:pgMar w:top="1418" ' +
        'w:right="1418" w:bottom="1418" w:left="1418" w:header="720" ' +
        'w:footer="720" w:gutter="0" /></w:sectPr></w:body>');
});

test('Word export uses a reference document made from the manuscript\'s ' +
     'settings, unless the manuscript sets its own', async () => {
    const d = require('../src/docx.js');
    const zlib = require('zlib');
    const deps = fakeDeps(null);
    deps.zlib = zlib;
    const plain = d.writeZip([
        { name: 'word/styles.xml',
          data: Buffer.from('<w:color w:val="4F81BD" />') },
        { name: 'word/document.xml',
          data: Buffer.from('<w:body></w:body>') }], zlib);
    const run = deps.run;
    const row = (t) => `<w:tr><w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p>` +
        '</w:tc></w:tr>';
    deps.run = async (cmd, args) => {
        if (args.includes('--print-default-data-file')) {
            deps.files[args[args.indexOf('-o') + 1]] = plain;
            return;
        }
        await run(cmd, args);
        deps.files[args[args.indexOf('-o') + 1]] = d.writeZip([
            { name: 'word/document.xml',
              data: Buffer.from(`<w:body><w:tbl>${row('a')}${row('b')}` +
                                '</w:tbl></w:body>') }], zlib);
    };
    deps.readFile = async (f) => deps.files[f];
    const r = await p.exportDocument({
        md: 'Text.', format: 'docx', output: '/v/G.docx',
        style: { font: 'Arial', margin: '1in' } }, deps);
    assert.equal(r.ok, true);
    const [, args, files] = deps.runs[0];
    const ref = args.find((a) => a.startsWith('--reference-doc='))
        .slice('--reference-doc='.length);
    const made = d.readZip(files[ref], zlib);
    assert.equal(made[0].data.toString(), '<w:color w:val="000000" />');
    assert.match(made[1].data.toString(), /w:left="1445"/, 'one inch');
    assert.deepEqual(Object.keys(deps.files), ['/v/G.docx'],
                     'and it is removed');
    const doc = d.readZip(deps.files['/v/G.docx'], zlib)[0].data.toString();
    assert.equal(doc, '<w:body><w:tbl><w:tr><w:trPr><w:cantSplit />' +
        '</w:trPr><w:tc><w:p><w:pPr><w:keepNext /></w:pPr><w:r><w:t>a' +
        '</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:trPr><w:cantSplit />' +
        '</w:trPr><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr>' +
        '</w:tbl></w:body>', 'a short table is kept on one page');
    deps.runs.length = 0;
    await p.exportDocument({ md: 'Text.', format: 'docx',
                             output: '/v/G.docx',
                             style: { referenceDocx: '/v/mine.docx' } },
                           deps);
    assert.ok(deps.runs[0][1].includes('--reference-doc=/v/mine.docx'));
    assert.equal(deps.runs.length, 1, 'nothing made');
});

test('in Word, keep-with-next follows the paragraph\'s style, and a ' +
     'table longer than 30 rows may break', () => {
    const d = require('../src/docx.js');
    const p1 = '<w:p><w:pPr><w:pStyle w:val="Compact" /><w:jc w:val="left" />' +
        '</w:pPr></w:p>';
    const tbl = (n) => '<w:tbl>' +
        `<w:tr><w:trPr><w:tblHeader w:val="true" /></w:trPr>${p1}</w:tr>` +
        `<w:tr>${p1}</w:tr>`.repeat(n - 1) + '</w:tbl>';
    const out = d.keepTables(tbl(3));
    assert.equal((out.match(/<w:pStyle w:val="Compact" \/><w:keepNext \/>/g)
                  || []).length, 2, 'all rows but the last');
    assert.match(out, /<w:trPr><w:cantSplit \/><w:tblHeader/);
    assert.equal(d.keepTables(tbl(31)), tbl(31));
});
