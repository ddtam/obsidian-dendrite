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
