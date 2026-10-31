// A manuscript filled into a Word template: the template's instructions
// out, its headings matched to the manuscript's sections, its tables
// filled, what is unfilled left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wt = require('../src/wordtemplate.js');

const run = (t, italic = false) => `<w:r>${italic ? '<w:rPr><w:i/>' +
    '<w:color w:val="999999"/></w:rPr>' : ''}<w:t xml:space="preserve">` +
    `${t}</w:t></w:r>`;
const para = (...runs) => `<w:p>${runs.join('')}</w:p>`;
const cell = (...runs) => `<w:tc><w:tcPr><w:tcW w:w="100"/></w:tcPr>` +
    `${para(...runs)}</w:tc>`;
const row = (...cells) => `<w:tr>${cells.join('')}</w:tr>`;
const table = (...rows) => '<w:tbl><w:tblPr><w:tblStyle w:val="T"/>' +
    '</w:tblPr><w:tblGrid>' + '<w:gridCol w:w="100"/>'.repeat(
    (rows[0].match(/<w:tc>/g) || []).length) + '</w:tblGrid>' +
    rows.join('') + '</w:tbl>';
const doc = (...blocks) => '<w:document xmlns:w="w"><w:body>' +
    blocks.join('') + '<w:sectPr><w:titlePg/><w:pgNumType w:start="0"/>' +
    '</w:sectPr></w:body></w:document>';
const heading = (level, text) => '<w:p><w:pPr><w:pStyle w:val="Heading' +
    `${level}" /></w:pPr>${run(text)}</w:p>`;

const TEMPLATE = doc(
    para(run('Please remove this page', true)),
    table(row(cell(run('Important: remember', true)))),
    para(run('The Template', true)),
    para(run('Research Methods '), run('(max 7 pages)', true)),
    para(run('1. Outline '), run('(suggested 1 page)', true)),
    para(run('Focus on the work.', true)),
    para(run('2. Resources')),
    table(row(cell(run('Resource')), cell(run('Project 1')),
              cell(run('Project 2')), cell(run('Total'))),
          row(cell(run('Members')), cell(run('3', true)),
              cell(run('2', true)), cell(run('5', true))),
          row(cell(run('GPU')), cell(run('30', true)), cell(run('', true)),
              cell(run('30', true)))),
    para(run('#!/bin/bash')),
    para(run('3. Cloud')),
    para(run('Management '), run('(max 3 pages)', true)),
    para(run('4. Funding')));

test('the template\'s instructions come out: italic runs, the paragraphs ' +
     'they leave empty and one-row boxes all in italic, and what is ' +
     'before its start', () => {
    const { items, dropped } = wt.templateItems(
        wt.splitDocument(TEMPLATE).blocks, { startAt: 'The Template' });
    assert.equal(dropped, true);
    assert.deepEqual(items.map((x) => [x.kind, x.num || '',
        wt.textOf(x.xml).trim()]),
        [['part', '', 'Research Methods'],
         ['heading', '1', '1. Outline'],
         ['heading', '2', '2. Resources'],
         ['table', '', 'ResourceProject 1Project 2TotalMembers325GPU3030'],
         ['p', '', '#!/bin/bash'],
         ['heading', '3', '3. Cloud'],
         ['part', '', 'Management'],
         ['heading', '4', '4. Funding']]);
});

test('a template table is filled from the manuscript\'s: columns by ' +
     'header, a new one taking a column left over under its own name, ' +
     'rows by their first cell, and what neither uses gone', () => {
    const tpl = table(
        row(cell(run('Resource')), cell(run('Project 1')),
            cell(run('Project 2')), cell(run('Total'))),
        row(cell(run('Members')), cell(run('3', true)), cell(run('2', true)),
            cell(run('5', true))),
        row(cell(run('GPU')), cell(run('30', true)), cell(run('', true)),
            cell(run('30', true))));
    const src = table(
        row(cell(run('Resource')), cell(run('Evidence model')),
            cell(run('Total'))),
        row(cell(run('Members')), cell(run('4')), cell(run('4'))),
        row(cell(run('Storage (TB)')), cell(run('55')), cell(run('55'))));
    const out = wt.fillTable(tpl, src);
    const rows = wt.tableRows(out).map((r) => r.cells.map((c) => c.text));
    assert.deepEqual(rows, [['Resource', 'Evidence model', 'Total'],
                            ['Members', '4', '4'],
                            ['Storage (TB)', '55', '55']]);
    assert.equal((out.match(/<w:gridCol/g) || []).length, 3,
                 'the grid as the columns');
    assert.doesNotMatch(out, /999999/, 'no example colour on the values');
    assert.equal(wt.fillTable(tpl, table(row(cell(run('Other'))))), null,
                 'no header shared: not this table');
});

test('the filled body keeps the template\'s headings the manuscript ' +
     'fills, in its order, drops the rest with their parts, places a ' +
     'section with no heading after the one before it, and adds the ' +
     'references at the end', () => {
    const { items } = wt.templateItems(wt.splitDocument(TEMPLATE).blocks,
                                       { startAt: 'The Template' });
    const ms = wt.manuscriptSections(wt.splitDocument(doc(
        heading(1, '1. Outline'), para(run('We will.')),
        heading(2, '1.1 Goal'), para(run('A goal.')),
        heading(1, '2. Resources'),
        table(row(cell(run('Resource')), cell(run('Model')),
                  cell(run('Total'))),
              row(cell(run('Members')), cell(run('4')), cell(run('4')))),
        '<w:p><w:pPr><w:pStyle w:val="Bibliography" /></w:pPr>' +
        `${run('Ref one.')}</w:p>`)).blocks);
    const { blocks, report } = wt.fillBody(items, ms, {});
    const text = blocks.map((b) => wt.textOf(b).trim()).filter(Boolean);
    assert.deepEqual(text, ['Research Methods', '1. Outline', 'We will.',
        '1.1 Goal', 'A goal.', '2. Resources',
        'ResourceModelTotalMembers44', 'References', 'Ref one.']);
    assert.deepEqual(report.unplaced, ['1.1 Goal']);
    assert.deepEqual(report.dropped, ['3 cloud', '4 funding']);
    // 1.1, with no heading in the template, made like its headings: no
    // Pandoc heading style, and in roman.
    const goal = blocks.find((b) => wt.textOf(b).trim() === '1.1 Goal');
    assert.doesNotMatch(goal, /Heading2|<w:i\/>/);
    // The second part heading made like the first.
    const parts = wt.templateItems(wt.splitDocument(TEMPLATE).blocks,
        { startAt: 'The Template' }).items.filter((x) => x.kind === 'part');
    assert.equal(parts.length, 2);
});

test('placeholders are filled across runs, and a template whose first ' +
     'pages went counts its pages from 1 with no first page of its own',
     () => {
    const p = '<w:p><w:r><w:t>PI full</w:t></w:r><w:r><w:t> name' +
        '</w:t></w:r></w:p>';
    assert.equal(wt.textOf(wt.fillFields(p, { 'PI full name': 'Dr. A' })),
                 'Dr. A');
    const it = '<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>PI full name</w:t>' +
        '</w:r></w:p>';
    assert.doesNotMatch(wt.fillFields(it, { 'PI full name': 'Dr. A' }),
                        /<w:i\/>/, 'filled in roman');
    assert.equal(wt.firstPageGone('<w:sectPr><w:titlePg/><w:pgNumType ' +
        'w:start="0"/></w:sectPr>'), '<w:sectPr><w:pgNumType/></w:sectPr>');
});

test('one typeface at a least size throughout, and styles Pandoc names ' +
     'but did not add taken from its own', () => {
    const styles = '<w:styles><w:docDefaults><w:rPrDefault><w:rPr>' +
        '<w:rFonts w:ascii="Calibri"/><w:sz w:val="18"/></w:rPr>' +
        '</w:rPrDefault></w:docDefaults><w:style w:styleId="H">' +
        '<w:rPr><w:sz w:val="28"/></w:rPr></w:style></w:styles>';
    const out = wt.oneFont(styles, 'Arial', 10);
    assert.match(out, /w:ascii="Arial"/);
    assert.doesNotMatch(out, /Calibri/);
    assert.match(out, /<w:sz w:val="20"\/>/, 'raised to 10 pt');
    assert.match(out, /<w:sz w:val="28"\/>/, 'a larger size kept');
    const added = wt.withStyles('<w:styles></w:styles>',
        ['<w:pStyle w:val="Compact" />'],
        '<w:style w:styleId="Compact" w:default="1"><w:basedOn ' +
        'w:val="BodyText"/></w:style><w:style w:styleId="BodyText">' +
        '</w:style>');
    assert.match(added, /styleId="Compact"/);
    assert.match(added, /styleId="BodyText"/, 'with what it is based on');
    assert.doesNotMatch(added, /w:default/);
});

test('simple inline math becomes text in the body\'s font, the rest is ' +
     'left and listed, and dollars are not math', () => {
    assert.deepEqual(wt.plainMath('Sizes. $1\\text{ TB} = 10^{12}$ bytes.'),
                     { md: 'Sizes. 1 TB = 10^12^ bytes.', left: [] });
    assert.deepEqual(wt.plainMath('Cost $5 and $6 later'),
                     { md: 'Cost $5 and $6 later', left: [] });
    assert.deepEqual(wt.plainMath('n = $\\frac{a}{b}$').left,
                     ['\\frac{a}{b}']);
});

test('the template\'s blank lines between headings and text are kept, ' +
     'and text under an indented heading starts where it does', () => {
    const indented = '<w:p><w:pPr><w:ind w:left="720"/></w:pPr>' +
        run('2.1 Detail') + '</w:p>';
    const tpl = doc(para(run('1. Outline')), '<w:p></w:p>',
                    para(run('2. Resources')), '<w:p></w:p>', indented,
                    para(run('Fill this in.', true)));
    const { items } = wt.templateItems(wt.splitDocument(tpl).blocks);
    assert.deepEqual(items.map((x) => x.kind),
                     ['heading', 'gap', 'heading', 'gap', 'heading']);
    const ms = wt.manuscriptSections(wt.splitDocument(doc(
        heading(1, '1. Outline'), para(run('One.')),
        '<w:bookmarkEnd w:id="1" />', '<w:bookmarkStart w:id="2" w:name="r" />',
        heading(1, '2. Resources'),
        heading(2, '2.1 Detail'), para(run('Two.')),
        '<w:p><w:pPr><w:ind w:left="360"/></w:pPr>' + run('Item') +
        '</w:p>')).blocks);
    const { blocks } = wt.fillBody(items, ms, {});
    const shape = blocks.filter((b) => /^<w:(p|tbl)[ >]/.test(b))
        .map((b) => wt.textOf(b).trim() || '(blank)');
    assert.deepEqual(shape, ['1. Outline', 'One.', '(blank)',
        '2. Resources', '(blank)', '2.1 Detail', 'Two.', 'Item']);
    const two = blocks.find((b) => wt.textOf(b) === 'Two.');
    assert.match(two, /<w:ind w:left="720"\/>/);
    const item = blocks.find((b) => wt.textOf(b) === 'Item');
    assert.match(item, /<w:ind w:left="1080"\/>/, 'a list\'s own on top');
});

test('a table is set off by the template\'s blank line above its ' +
     'caption and below it', () => {
    const tpl = doc(para(run('1. Outline')), '<w:p></w:p>',
                    para(run('2. Data')));
    const { items } = wt.templateItems(wt.splitDocument(tpl).blocks);
    const caption = '<w:p><w:pPr><w:pStyle w:val="TableCaption" />' +
        '</w:pPr>' + run('Table 1. Sizes.') + '</w:p>';
    const ms = wt.manuscriptSections(wt.splitDocument(doc(
        heading(1, '1. Outline'), para(run('Before.')), caption,
        table(row(cell(run('A'))), row(cell(run('1')))),
        para(run('After.')), heading(1, '2. Data'))).blocks);
    const { blocks } = wt.fillBody(items, ms, {});
    const shape = blocks.filter((b) => /^<w:(p|tbl)[ >]/.test(b))
        .map((b) => wt.textOf(b).trim() || '(blank)');
    assert.deepEqual(shape, ['1. Outline', 'Before.', '(blank)',
        'Table 1. Sizes.', 'A1', '(blank)', 'After.', '(blank)', '2. Data']);
});

test('a table breaks between pages cleanly: no row splits, its header ' +
     'repeats and stays with the first row, its last two rows stay ' +
     'together, and it may break anywhere else', () => {
    const tr = (t) => '<w:tr><w:trPr><w:cantSplit w:val="0"/><w:tblHeader ' +
        `w:val="0"/></w:trPr>${cell(run(t))}</w:tr>`;
    const rows = wt.tidyTable('<w:tbl><w:tblPr/>' + tr('H') +
        Array.from({ length: 8 }, (x, i) => tr(String(i))).join('') +
        '</w:tbl>').match(/<w:tr>[^]*?<\/w:tr>/g);
    assert.ok(rows.every((r) => /<w:cantSplit\/>/.test(r)), 'no splits');
    assert.match(rows[0], /<w:tblHeader\/>/);
    assert.doesNotMatch(rows[1], /tblHeader/);
    const kept = rows.map((r) => /<w:keepNext\/>/.test(r));
    assert.deepEqual(kept, [true, true, false, false, false, false, false,
                            true, false]);
});

test('Pandoc\'s heading over the reference list is the list\'s one ' +
     'heading, not a section, and widow control is on throughout', () => {
    const { items } = wt.templateItems(wt.splitDocument(doc(
        para(run('1. Outline')))).blocks);
    const bib = '<w:p><w:pPr><w:pStyle w:val="Bibliography" /></w:pPr>' +
        run('1. Ref.') + '</w:p>';
    const ms = wt.manuscriptSections(wt.splitDocument(doc(
        heading(1, '1. Outline'), para(run('Text [1].')),
        heading(1, 'References'), bib)).blocks);
    assert.equal(ms.refsTitle, 'References');
    const { blocks, report } = wt.fillBody(items, ms, {});
    const text = blocks.map((b) => wt.textOf(b).trim()).filter(Boolean);
    assert.deepEqual(text, ['1. Outline', 'Text [1].', 'References',
                            '1. Ref.']);
    assert.deepEqual(report.unplaced, []);
    const styles = '<w:docDefaults><w:pPrDefault><w:pPr><w:widowControl ' +
        'w:val="0"/></w:pPr></w:pPrDefault></w:docDefaults>';
    assert.match(wt.widowControl(styles), /<w:widowControl\/>/);
    assert.match(wt.widowControl('<w:pPrDefault><w:pPr><w:spacing/>' +
        '</w:pPr></w:pPrDefault>'), /<w:pPr><w:widowControl\/>/);
});

test('a heading over a table stays with it: no blank line between them, ' +
     'and the blank line above a table is kept with the table', () => {
    const tpl = doc(para(run('1. Outline')), '<w:p></w:p>',
                    para(run('2. Team')));
    const { items } = wt.templateItems(wt.splitDocument(tpl).blocks);
    const caption = '<w:p><w:pPr><w:pStyle w:val="TableCaption" />' +
        '</w:pPr>' + run('Table 1. Team.') + '</w:p>';
    const ms = wt.manuscriptSections(wt.splitDocument(doc(
        heading(1, '1. Outline'), para(run('Text.')),
        heading(1, '2. Team'), caption,
        table(row(cell(run('Name'))), row(cell(run('Derek')))))).blocks);
    const { blocks } = wt.fillBody(items, ms, {});
    const shown = blocks.filter((b) => /^<w:(p|tbl)[ >]/.test(b));
    const shape = shown.map((b) => wt.textOf(b).trim() || '(blank)');
    assert.deepEqual(shape, ['1. Outline', 'Text.', '(blank)', '2. Team',
                             'Table 1. Team.', 'NameDerek', '(blank)']);
    // The heading, the blank line above it and the caption all kept
    // with what follows.
    for (const k of [2, 3, 4]) assert.match(shown[k], /<w:keepNext\/>/);
});

test('a column is at least as wide as its longest word, the room taken ' +
     'from the widest, the total kept', () => {
    const t = table(row(cell(run('Full Name')), cell(run('/nearline (TB)'))),
                    row(cell(run('Derek Tam')), cell(run('0'))));
    const out = wt.roomForWords(t, [4000, 600]);
    assert.equal(out[0] + out[1], 4600);
    assert.ok(out[1] >= '/nearline'.length * 125, 'the word fits');
    assert.ok(out[0] >= 'Derek'.length * 125);
    assert.deepEqual(wt.roomForWords(t, [400, 400]), [400, 400],
                     'no room for every word: as it was');
});

test('a manuscript table with no template counterpart takes the ' +
     'template table header\'s bold, italic and shading on its first row',
     () => {
    const model = '<w:tbl><w:tblPr><w:tblBorders/></w:tblPr><w:tr><w:tc>' +
        '<w:tcPr><w:shd w:fill="EEEEEE"/></w:tcPr><w:p><w:r><w:rPr><w:b/>' +
        '<w:i/></w:rPr><w:t>Head</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const src = table(row(cell(run('Data'))), row(cell(run('x'))));
    const out = wt.restyleTable(src, model);
    const [head, body] = wt.tableRows(out);
    assert.match(head.xml, /<w:b\/><w:i\/>/);
    assert.match(head.xml, /<w:shd w:fill="EEEEEE"\/>/);
    assert.doesNotMatch(body.xml, /<w:b\/>|<w:shd/, 'the body as it was');
    assert.match(out, /<w:tblBorders\/>/, 'the template\'s borders');
});
