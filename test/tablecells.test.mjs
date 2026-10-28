// Tests for review comments in the table grid of the card editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const t = require('../src/tablecells.js');
const review = require('../src/review.js');

const CELL = '%%{a1%%WGS CRAMs%%}a1 [!review] Joshua, 2026-10-23: ' +
    'Inconsistent.%%';

test('a table row splits into its cells, with their offsets', () => {
    const line = '| A | x \\| y |  |';
    const cells = t.rowCells(line, 10);
    assert.deepEqual(cells.map((c) => c.text), ['A', 'x \\| y', '']);
    assert.equal(line.slice(cells[1].start - 10).slice(0, 6), 'x \\| y');
    const md = 'Cap.\n\n| H | I |\n| - | - |\n| 1 | 2 |\n\nAfter';
    const rows = t.tableRows(md, md.indexOf('|'));
    assert.deepEqual(rows.map((r) => r.map((c) => c.text)),
                     [['H', 'I'], ['1', '2']]);
    assert.equal(md.slice(rows[1][1].start, rows[1][1].start + 1), '2');
});

test('a comment in a table cell of the editor is drawn, its passage ' +
     'marked and numbered after the comments before it', () => {
    const md = 'Sizes %%[!review] Aly, 2026-10-22: Fine.%%\n\n' +
        '| Data | TB |\n| --- | --- |\n| ' + CELL + ' | 21 |\n';
    const dom = new JSDOM('<div class="cm-content"><div ' +
        'class="cm-table-widget"><table><tr><th><div ' +
        'class="table-cell-wrapper">Data</div></th><th><div ' +
        'class="table-cell-wrapper">TB</div></th></tr><tr><td><div ' +
        'class="table-cell-wrapper">WGS CRAMs</div></td><td><div ' +
        'class="table-cell-wrapper">21</div></td></tr></table></div>' +
        '</div>');
    const doc = dom.window.document;
    const content = doc.querySelector('.cm-content');
    const at = md.indexOf('| Data');
    const cm = {
        contentDOM: content,
        posAtDOM: () => at + 3,
        state: { doc: { toString: () => md,
                        lineAt: (p) => ({ from: md.lastIndexOf('\n',
                            p - 1) + 1 }) } },
    };
    let drawn = 0;
    const draw = (wrap, text, base, key) => {
        drawn++;
        const tmp = doc.createElement('div');
        tmp.innerHTML = review.renderMarkdown(text);
        t.fillCell(wrap, [...tmp.childNodes], base, key);
    };
    t.markTableCells(cm, draw);
    const cell = doc.querySelectorAll('td .table-cell-wrapper')[0];
    assert.equal(drawn, 1);
    assert.equal(cell.textContent, 'WGS CRAMs2');
    assert.ok(cell.querySelector('.dendrite-review-from'));
    assert.equal(cell.querySelector('sup.dendrite-review-n').textContent,
                 '2');
    // Drawn once: the same text again leaves it.
    t.markTableCells(cm, draw);
    assert.equal(drawn, 1);
});
