'use strict';
// Review comments in the table grid of Obsidian's editor. Live preview
// draws a table as a grid whose cells are rendered on their own, out of
// reach of the editor's decorations, so a comment in a cell showed as
// nothing at all, its passage unmarked. Each cell holding a comment is
// drawn again here as the board draws it: its passage tinted, its number
// after it. The cell being typed in is an editor of its own, which the
// card editor gives the review extension (editor.js).

const review = require('./review.js');

/** A table row's cells as written, `\|` kept, with their offsets. */
function rowCells(line, at) {
    const cells = [];
    let i = 0;
    while (i < line.length && /\s/.test(line[i])) i++;
    if (line[i] === '|') i++;
    let start = i;
    const push = (end) => {
        const raw = line.slice(start, end);
        const lead = /^\s*/.exec(raw)[0].length;
        cells.push({ text: raw.trim(), start: at + start + lead });
    };
    for (; i < line.length; i++) {
        if (line[i] === '\\' && line[i + 1] === '|') {
            i++;
        } else if (line[i] === '|') {
            push(i);
            start = i + 1;
        }
    }
    if (line.slice(start).trim()) push(line.length);
    return cells;
}

/**
 * The cells of the table whose first line starts at `from` in `text`, a
 * row for each row drawn: the delimiter line left out.
 */
function tableRows(text, from) {
    const rows = [];
    let at = from;
    for (let k = 0; at <= text.length; k++) {
        const end = text.indexOf('\n', at);
        const line = text.slice(at, end < 0 ? text.length : end);
        if (!line.trim() || !line.includes('|')) break;
        if (k !== 1) rows.push(rowCells(line, at));
        if (end < 0) break;
        at = end + 1;
    }
    return rows;
}

/**
 * Draw again the cells holding a comment in the editor `cm`'s tables.
 * `draw(wrap, text, base)` fills a cell's wrapper from its text, its
 * comments numbered after the `base` before it in the card. A cell
 * already drawn from the same text is left; the one being typed in too.
 */
function markTableCells(cm, draw) {
    const text = cm.state.doc.toString();
    for (const w of cm.contentDOM.querySelectorAll('.cm-table-widget')) {
        let from;
        try {
            from = cm.state.doc.lineAt(cm.posAtDOM(w)).from;
        } catch (e) {
            continue;
        }
        const rows = tableRows(text, from);
        [...w.querySelectorAll('tr')].forEach((tr, r) => {
            [...tr.children].forEach((td, c) => {
                const cell = rows[r] && rows[r][c];
                const wrap = td.querySelector(':scope > .table-cell-wrapper');
                if (!cell || !wrap || td.querySelector('.cm-editor')) return;
                if (!/\[!(review|suggest)[\]|]/.test(cell.text)) return;
                const base = review.countComments(
                    review.reviewItems(text.slice(0, cell.start)));
                const key = `${base}:${cell.text}`;
                const drawn = wrap.querySelector(':scope > .dendrite-cell');
                if (drawn && drawn.dataset.key === key) return;
                draw(wrap, cell.text, base, key);
            });
        });
    }
}

/**
 * Fill a cell's wrapper with `nodes`, the cell as rendered from
 * review.renderMarkdown's text, its comments numbered after `base`.
 */
function fillCell(wrap, nodes, base, key) {
    const doc = wrap.ownerDocument;
    const span = doc.createElement('span');
    span.className = 'dendrite-cell';
    span.dataset.key = key;
    span.append(...nodes);
    for (const sup of span.querySelectorAll('sup.dendrite-review-n')) {
        sup.textContent = String(Number(sup.textContent) + base);
    }
    review.wrapPassages(span);
    wrap.replaceChildren(span);
}

module.exports = { rowCells, tableRows, markTableCells, fillCell };
