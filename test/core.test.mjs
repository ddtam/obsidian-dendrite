// Tests for the pure core: what Dendrite writes to notes. Run with
// `npm test`. Every write path to a note goes through these functions, so
// a change here that loses text or structure fails before a release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const c = require('../src/core.js');

const INDEX = [
    '---',
    'dendrite_prefix: R01',
    '---',
    '# R01 grant',
    '',
    'Planning paragraph kept above the tree.',
    '',
    '- [[R01-aaaaa|Aims]]',
    '    - [[R01-bbbbb|Aim 1]]',
    '        - [[R01-ccccc|Aim 1 rationale]]',
    '    - [[R01-ddddd]]',
    '- [[R01-eeeee|Significance]]',
    '',
    'Text after the tree.',
    '',
].join('\n');

test('parse reads nesting, ids and labels', () => {
    const { body } = c.splitFrontmatter(INDEX);
    const { root, before, after } = c.parseIndex(body);
    assert.equal(root.children.length, 2);
    const aims = root.children[0];
    assert.equal(aims.id, 'R01-aaaaa');
    assert.equal(aims.label, 'Aims');
    assert.deepEqual(aims.children.map((n) => n.id),
                     ['R01-bbbbb', 'R01-ddddd']);
    assert.equal(aims.children[0].children[0].label, 'Aim 1 rationale');
    assert.equal(aims.children[1].label, '');
    assert.match(before, /Planning paragraph/);
    assert.match(after, /Text after the tree/);
});

test('an unchanged tree rewrites the index byte for byte', () => {
    const { body } = c.splitFrontmatter(INDEX);
    const { root } = c.parseIndex(body);
    assert.equal(c.writeIndexText(INDEX, root), INDEX);
});

test('tabs and two-space indents read as nesting', () => {
    for (const ind of ['\t', '  ']) {
        const { root } = c.parseIndex(
            `- [[A-11111|a]]\n${ind}- [[A-22222|b]]\n${ind}${ind}` +
            '- [[A-33333|c]]\n- [[A-44444|d]]\n');
        assert.equal(root.children.length, 2, JSON.stringify(ind));
        assert.equal(root.children[0].children[0].children[0].id,
                     'A-33333');
    }
});

test('a write to an empty index appends the tree after its text', () => {
    const text = '---\ndendrite_prefix: X\n---\n# Title\n';
    const root = c.makeRoot();
    c.appendChild(root, c.makeNode('X-aaaaa', 'First', null));
    const out = c.writeIndexText(text, root);
    assert.equal(out, '---\ndendrite_prefix: X\n---\n# Title\n' +
                 '- [[X-aaaaa|First]]\n');
    const again = c.writeIndexText(out, c.parseIndex(
        c.splitFrontmatter(out).body).root);
    assert.equal(again, out);
});

test('labels lose characters that would break the link', () => {
    const root = c.makeRoot();
    c.appendChild(root, c.makeNode('X-aaaaa', 'a | b [c]', null));
    assert.equal(c.serialiseTree(root), '- [[X-aaaaa|a b c]]');
});

test('tree operations move nodes and keep parents consistent', () => {
    const { root } = c.parseIndex(c.splitFrontmatter(INDEX).body);
    const [aims, sig] = root.children;
    const aim1 = aims.children[0];
    const d = aims.children[1];
    assert.ok(c.moveWithin(d, -1));
    assert.deepEqual(aims.children.map((n) => n.id),
                     ['R01-ddddd', 'R01-bbbbb']);
    assert.ok(!c.moveWithin(d, -1));
    assert.ok(c.indent(aim1));
    assert.equal(aim1.parent, d);
    assert.ok(c.outdent(aim1));
    assert.equal(aim1.parent, aims);
    assert.deepEqual(aims.children.map((n) => n.id),
                     ['R01-ddddd', 'R01-bbbbb']);
    assert.ok(c.outdent(aim1));
    assert.deepEqual(root.children.map((n) => n.id),
                     ['R01-aaaaa', 'R01-bbbbb', 'R01-eeeee']);
    assert.ok(!c.outdent(sig));
    assert.ok(!c.indent(root.children[0]));
    for (const n of c.allNodes(root)) {
        assert.ok(n.parent.children.includes(n), n.id);
    }
});

test('labels come from the heading, then an alias, then first words', () => {
    assert.equal(c.deriveLabel('## Specific Aims\ntext', ['x']),
                 'Specific Aims');
    assert.equal(c.deriveLabel('Plain prose here.', ['Aim 1 rationale']),
                 'Aim 1 rationale');
    assert.equal(c.deriveLabel('One two three four five six seven ' +
                               'eight nine ten', null),
                 'One two three four five six seven eight…');
    assert.equal(c.deriveLabel('%% a note %%\nSee [[X|the paper]].', null),
                 'See the paper.');
    assert.equal(c.deriveLabel('', null), '');
});

test('IDs keep the prefix, avoid taken ones, and split at the last hyphen',
     () => {
    const seq = [0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5];
    let i = 0;
    const rand = () => seq[i++ % seq.length];
    const id = c.newId('GRANT-2026', (x) => x === 'GRANT-2026-aaaaa',
                       rand);
    assert.equal(id, 'GRANT-2026-sssss');
    assert.equal(id.slice(0, id.lastIndexOf('-')), 'GRANT-2026');
    assert.ok(c.validPrefix('GRANT-2026'));
    assert.ok(!c.validPrefix('GRANT 2026'));
    assert.ok(!c.validPrefix('-X'));
});

test('export: headings from sections, planning and comments dropped', () => {
    const { root } = c.parseIndex(c.splitFrontmatter(INDEX).body);
    const bodies = {
        'R01-aaaaa': '# Aims\nPlanning: two aims, one page.',
        'R01-bbbbb': '# Aim 1\nPlanning for aim 1.',
        'R01-ccccc': 'The method is %% check n %%robust.',
        'R01-ddddd': 'Untitled paragraph under Aims.',
        'R01-eeeee': '# Significance\nThe question matters.',
    };
    const out = c.exportMarkdown(root.children, (id) => bodies[id], 1);
    assert.equal(out, [
        '# Aims',
        '## Aim 1',
        'The method is robust.',
        'Untitled paragraph under Aims.',
        '# Significance',
        'The question matters.',
    ].join('\n\n') + '\n');
    // A branch exports from its own root at the top level.
    const aim1 = root.children[0].children[0];
    assert.equal(c.exportMarkdown([aim1], (id) => bodies[id], 2),
                 '## Aim 1\n\nThe method is robust.\n');
});

test('frontmatter is kept verbatim and never read as body', () => {
    const t = '---\naliases:\n  - x\n---\nBody\n';
    assert.deepEqual(c.splitFrontmatter(t),
                     { fm: '---\naliases:\n  - x\n---\n', body: 'Body\n' });
    assert.deepEqual(c.splitFrontmatter('No fm'), { fm: '', body: 'No fm' });
});

const ed = require('../src/textedit.js');
const apply = (t, r) => t.slice(0, r.start) + r.text + t.slice(r.end);

test('bold wraps the selection and unwraps it again', () => {
    const r = ed.wrap('a word b', 2, 6, '**');
    const t = apply('a word b', r);
    assert.equal(t, 'a **word** b');
    assert.equal(t.slice(r.selStart, r.selEnd), 'word');
    const back = ed.wrap(t, r.selStart, r.selEnd, '**');
    assert.equal(apply(t, back), 'a word b');
});

test('tab indents and shift-tab outdents every selected line', () => {
    const t = '- a\n- b\nc';
    const r = ed.shiftLines(t, 0, 6, false);
    const t2 = apply(t, r);
    assert.equal(t2, '    - a\n    - b\nc');
    assert.equal(apply(t2, ed.shiftLines(t2, r.selStart, r.selEnd, true)),
                 t);
    assert.equal(apply('\t- x', ed.shiftLines('\t- x', 1, 1, true)), '- x');
});

test('enter continues a list, numbers it, and ends it on an empty item',
     () => {
    const t = '- first';
    const r = ed.enter(t, t.length, t.length);
    assert.equal(apply(t, r), '- first\n- ');
    const n = '    3. third';
    assert.equal(apply(n, ed.enter(n, n.length, n.length)),
                 '    3. third\n    4. ');
    const k = '- [x] done';
    assert.equal(apply(k, ed.enter(k, k.length, k.length)),
                 '- [x] done\n- [ ] ');
    const empty = '- a\n- ';
    assert.equal(apply(empty, ed.enter(empty, empty.length, empty.length)),
                 '- a\n');
    assert.equal(ed.enter('plain', 5, 5), null);
});

test('limits parse in words, characters and pages', () => {
    assert.deepEqual(c.parseLimit('500 words'),
                     { amount: 500, unit: 'words' });
    assert.deepEqual(c.parseLimit('2000 chars'),
                     { amount: 2000, unit: 'characters' });
    assert.deepEqual(c.parseLimit('1 page'), { amount: 1, unit: 'pages' });
    assert.equal(c.parseLimit('lots'), null);
    assert.equal(c.parseLimit(''), null);
    assert.equal(c.formatLimit({ amount: 1, unit: 'pages' }), '1 page');
});

test('counts leave out markup, link targets and comments', () => {
    const md = '# Aims\n\n- The **method** is [[Note|robust]] ' +
        '[@smith2020] %% not this %%here.';
    const n = c.countText(md, true);
    assert.equal(n.words, 7);
    assert.equal(n.chars, 'Aims The method is robust cite here.'.length);
    assert.equal(c.countText(md, false).chars,
                 'AimsThemethodisrobustcitehere.'.length);
    assert.equal(c.measure({ words: 750, chars: 0 }, 'pages', 500), 1.5);
});

test('sections are numbered by position and renumber when moved', () => {
    const { root } = c.parseIndex(c.splitFrontmatter(INDEX).body);
    const heads = new Set(['R01-aaaaa', 'R01-bbbbb', 'R01-eeeee']);
    let nums = c.sectionNumbers(root.children, (id) => heads.has(id));
    assert.equal(nums.get('R01-aaaaa'), '1.');
    assert.equal(nums.get('R01-bbbbb'), '1.1');
    assert.equal(nums.get('R01-eeeee'), '2.');
    assert.equal(nums.has('R01-ccccc'), false);
    c.moveWithin(root.children[1], -1);
    nums = c.sectionNumbers(root.children, (id) => heads.has(id));
    assert.equal(nums.get('R01-eeeee'), '1.');
    assert.equal(nums.get('R01-bbbbb'), '2.1');
    const bodies = { 'R01-eeeee': '# Significance', 'R01-aaaaa': '# Aims',
                     'R01-bbbbb': '# Aim 1\nplan', 'R01-ccccc': 'Text.',
                     'R01-ddddd': '' };
    assert.equal(c.exportMarkdown(root.children, (id) => bodies[id], 1, nums),
                 '# 1. Significance\n\n# 2. Aims\n\n## 2.1 Aim 1\n\n' +
                 'Text.\n');
});

test('a column with nothing on the active path aligns children beside ' +
     'their parent', () => {
    // Column 0: A (children a1, a2), B (no children), C (child c1).
    const root = c.makeRoot();
    const [A, B, C] = ['A', 'B', 'C'].map((id) => c.makeNode(id, id, null));
    for (const n of [A, B, C]) c.appendChild(root, n);
    const [a1, a2] = ['a1', 'a2'].map((id) => c.makeNode(id, id, null));
    c.appendChild(A, a1);
    c.appendChild(A, a2);
    const c1 = c.makeNode('c1', 'c1', null);
    c.appendChild(C, c1);
    const cols = c.columns(root);
    // Each card 100 high; column 0 cards at 0, 100, 200; column 1 groups
    // a1 at 0, a2 at 100, c1 at 220.
    const top = { A: 0, B: 100, C: 200, a1: 0, a2: 100, c1: 220 };
    const pos = (id) => ({ top: top[id], height: 100 });
    // A active: its children centre in column 1.
    let t = c.alignColumns(cols, A, pos, [400, 400]);
    assert.equal(t[0], 50 - 200);
    assert.equal(t[1], 100 - 200);
    // B active, no children: the nearest parent's group is top-aligned
    // with it. A and C are equally near; the one above, A, is chosen.
    t = c.alignColumns(cols, B, pos, [400, 400]);
    assert.equal(t[0], 150 - 200);
    const aOnScreen = top.A - t[0];
    assert.equal(top.a1 - t[1], aOnScreen, 'a1 sits beside A');
    // C active: c1 centres beside it.
    t = c.alignColumns(cols, C, pos, [400, 400]);
    assert.equal(t[1], 270 - 200);
});

test('alignColumns: a tall card is placed by its caret or its top', () => {
    const A = { id: 'A', depth: 0, children: [], parent: null };
    const cols = [[A]];
    // A is 1000 high in a 400 column. Centring it puts its middle at the
    // column's middle, leaving the first 300 above the view.
    const pos = () => ({ top: 0, height: 1000 });
    let t = c.alignColumns(cols, A, pos, [400]);
    assert.equal(t[0], 300, 'centred, the top is out of view');
    assert.equal(c.tallTop({ top: 0, height: 1000 }, 400, 20), -20);
    assert.equal(c.tallTop({ top: 0, height: 300 }, 400, 20), null);
    t = c.alignColumns(cols, A, pos, [400], -20);
    assert.equal(t[0], -20, 'the given offset is used for the active card');

    // Typewriter: the caret's line sits at the middle wherever it is.
    const caret = { top: 40, bottom: 60 };
    assert.equal(c.caretOffset(caret, 400, 300, 30, true), 50 - 200);
    // Otherwise the column holds still while the caret is in view, and
    // moves only enough to bring it back.
    assert.equal(c.caretOffset({ top: 500, bottom: 520 }, 400, 300, 30,
                               false), 300);
    assert.equal(c.caretOffset(caret, 400, 300, 30, false), 10);
    assert.equal(c.caretOffset({ top: 900, bottom: 920 }, 400, 300, 30,
                               false), 920 + 30 - 400);
});

test('quotas: fractions, conversion and the waterfall of allocations', () => {
    assert.equal(c.parseAmount('1/4'), 0.25);
    assert.deepEqual(c.convert(0.5, 'pages', 'words', 500, 6),
                     { value: 250, estimated: true });
    assert.deepEqual(c.convert(60, 'characters', 'words', 500, 6),
                     { value: 10, estimated: true });
    assert.deepEqual(c.convert(3, 'words', 'words'),
                     { value: 3, estimated: false });

    // S3 (required, half a page) holds A and B, a quarter page each, and
    // M with no quota whose child C has 100 words.
    const root = c.makeRoot();
    const mk = (id, parent) => {
        const n = c.makeNode(id, id, null);
        c.appendChild(parent, n);
        return n;
    };
    const s3 = mk('S3', root);
    mk('A', s3);
    mk('B', s3);
    const m = mk('M', s3);
    mk('C', m);
    const q = {
        S3: { amount: 0.5, unit: 'pages', required: true },
        A: { amount: 0.25, unit: 'pages', required: false },
        B: { amount: 0.25, unit: 'pages', required: false },
        C: { amount: 100, unit: 'words', required: false },
    };
    const words = { S3: 1, A: 120, B: 80, M: 0, C: 30 };
    const countOf = (nodes) => {
        let w = 0;
        for (const n of nodes) {
            for (const x of [n, ...c.descendants(n)]) w += words[x.id];
        }
        return { words: w, chars: w * 6 };
    };
    const r = c.quotas(root, (id) => q[id] || null, countOf,
                       { wordsPerPage: 500, charsPerWord: 6,
                         total: { amount: 1, unit: 'pages' } });
    const s = r.get('S3');
    assert.deepEqual(s.parts, ['A', 'B', 'C'],
                     'the nearest quotas below, through M');
    assert.equal(s.allocated, 0.25 + 0.25 + 100 / 500);
    assert.ok(s.allocatedEstimated, 'words were converted to pages');
    assert.equal(s.used, 231 / 500);
    assert.ok(s.usedEstimated);
    assert.equal(r.get('A').used, 120 / 500);
    assert.equal(r.get('A').allocated, null, 'nothing below A');
    assert.equal(r.get('C').used, 30);
    assert.ok(!r.get('C').usedEstimated, 'words are counted, not estimated');
    assert.deepEqual(r.get(null).parts, ['S3']);
    assert.equal(r.get(null).allocated, 0.5);
    assert.equal(r.has('M'), false, 'a card without a quota has no report');
});

test('splitting moves a selection or the rest, and closes up the cut', () => {
    const body = 'First para.\n\nSecond para.\n\nThird para.';
    let r = c.splitText(body, 13, 25);
    assert.equal(r.moved, 'Second para.');
    assert.equal(r.keep, 'First para.\n\nThird para.');
    assert.equal(r.keep.slice(0, r.at), 'First para.');
    r = c.splitText(body, 13, 13);
    assert.equal(r.moved, 'Second para.\n\nThird para.', 'cursor: the rest');
    assert.equal(r.keep, 'First para.');
    r = c.splitText('One two three four.', 8, 14);
    assert.equal(r.moved, 'three');
    assert.equal(r.keep, 'One two four.', 'mid-line: one space');
    r = c.splitText(body, 0, 13);
    assert.equal(r.keep, 'Second para.\n\nThird para.');
    assert.equal(r.at, 0);
    assert.equal(c.splitText(body, body.length, body.length), null,
                 'nothing after the cursor');
    assert.equal(c.mergeText('A.\n\n', '\n\nB.'), 'A.\n\nB.');
    assert.equal(c.mergeText('', 'B.'), 'B.');
});

test('the flow is one path: a band per card and its group, joined', () => {
    const d = c.flowPath([{
        card: { left: 0, right: 100, top: 40, bottom: 120, r: 6 },
        group: { left: 130, right: 230, top: 0, bottom: 300, r: 6 },
    }]);
    const subpaths = d.split(' Z').filter((s) => s.trim());
    assert.equal(subpaths.length, 2, 'the band and the group');
    assert.match(d, /^M99,46 /, 'leaves the card under its edge, ' +
                 'below its rounded corner');
    assert.match(d, / 131,0 L131,300 /,
                 'arrives level at the group\'s top-left and bottom-left');
    assert.match(d, new RegExp('M130,0 H224 A6,6 0 0 1 230,6 V294 ' +
                               'A6,6 0 0 1 224,300 H130 Z'),
                 'the group is square on the left, rounded on the right');
    assert.equal(c.flowPath([]), '');
});

test('the thread runs card to card along the path', () => {
    const d = c.threadPath([
        { from: { left: 0, right: 100, top: 0, bottom: 60, r: 6 },
          to: { left: 140, right: 240, top: 200, bottom: 280, r: 6 } },
        { from: { left: 140, right: 240, top: 200, bottom: 280, r: 6 },
          to: { left: 280, right: 380, top: 90, bottom: 130, r: 6 } },
    ]);
    const steps = d.split(' Z').filter((s) => s.trim());
    assert.equal(steps.length, 2, 'one band per step');
    assert.match(steps[0], /^M99,6 .* 141,206 L141,274 /,
                 'from the straight part of one card\'s edge to the next');
});

test('cards carry no content-visibility, which stopped clicks reaching ' +
     'their footer', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../styles.css', import.meta.url),
                             'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /content-visibility/);
});

test('roles decide what a card prints, and segments show what is left out',
     () => {
    // Outline (no children yet, but marked a section), Aims (section by
    // having a child), its prose child, and a notes card with a child.
    const root = c.makeRoot();
    const mk = (id, parent) => {
        const n = c.makeNode(id, id, null);
        c.appendChild(parent, n);
        return n;
    };
    mk('O', root);
    const a = mk('A', root);
    mk('P', a);
    const nb = mk('N', root);
    mk('Q', nb);
    const bodies = {
        O: '# Research outline\nWhat will be done, not why.',
        A: '# Aims\nTwo aims. %% check the call %%',
        P: 'Prose for the aims.',
        N: '# Reviewer notes\nFix the budget.',
        Q: 'Under the notes.',
    };
    const roles = { O: 'section', N: 'notes' };
    const roleOf = (id) => roles[id] || null;
    const out = c.exportMarkdown(root.children, (id) => bodies[id], 1, null,
                                 roleOf);
    assert.equal(out, '# Research outline\n\n# Aims\n\n' +
                 'Prose for the aims.\n',
                 'an outline card prints its heading only, a notes card ' +
                 'and its branch print nothing');
    const segs = c.exportSegments(root.children, (id) => bodies[id], 1, null,
                                  roleOf);
    const by = Object.fromEntries(segs.map((s) => [s.id, s]));
    assert.deepEqual(segs.map((s) => s.id), ['O', 'A', 'P', 'N', 'Q'],
                     'every card has a segment, in reading order');
    assert.equal(by.O.left, 'What will be done, not why.');
    assert.equal(by.A.left, 'Two aims.\n\ncheck the call',
                 'notes then comments');
    assert.equal(by.P.left, '');
    assert.equal(by.N.text, '');
    assert.equal(by.N.left, '# Reviewer notes\nFix the budget.');
    assert.equal(by.Q.left, 'Under the notes.');
    // Without roles, an outline card with no children is prose.
    assert.match(c.exportMarkdown([root.children[0]], (id) => bodies[id], 1),
                 /What will be done/);
    // A notes card takes no section number.
    const nums = c.sectionNumbers(root.children, (id) => /^#/.test(bodies[id]),
                                  roleOf);
    assert.equal(nums.get('O'), '1.');
    assert.equal(nums.get('A'), '2.');
    assert.equal(nums.has('N'), false);
});

test('a titled card under an untitled one takes the next number at ' +
     'its level', () => {
    const root = c.makeRoot();
    const mk = (id, parent) => {
        const n = c.makeNode(id, id, null);
        c.appendChild(parent, n);
        return n;
    };
    mk('A', root);
    const b = mk('B', root);
    const cc = mk('C', b);
    mk('D', cc);
    mk('E', root);
    const titled = new Set(['A', 'C', 'D', 'E']);
    const nums = c.sectionNumbers(root.children, (id) => titled.has(id));
    assert.deepEqual(['A', 'C', 'D', 'E'].map((id) => nums.get(id)),
                     ['1.', '2.', '2.1', '3.']);
    assert.equal(nums.has('B'), false);
});

test('a scaffolding card prints nothing and its children take its place',
     () => {
    // 1 Background; 2 Why it matters (scaffolding) over two sections;
    // 3 Methods.
    const root = c.makeRoot();
    const mk = (id, parent) => {
        const n = c.makeNode(id, id, null);
        c.appendChild(parent, n);
        return n;
    };
    mk('B', root);
    const w = mk('W', root);
    const x = mk('X', w);
    mk('XP', x);
    mk('Y', w);
    mk('M', root);
    const bodies = {
        B: '# Background\nText.',
        W: '# Why is this research important?\nPlanning.',
        X: '# Clinical burden', XP: 'Burden prose.',
        Y: '# Gap in current methods\nGap prose.',
        M: '# Methods\nMethods prose.',
    };
    const roles = { W: 'scaffolding', Y: 'prose' };
    const roleOf = (id) => roles[id] || null;
    const nums = c.sectionNumbers(root.children,
                                  (id) => /^#/.test(bodies[id]), roleOf);
    assert.equal(nums.has('W'), false, 'the scaffolding card is unnumbered');
    assert.deepEqual(['B', 'X', 'Y', 'M'].map((id) => nums.get(id)),
                     ['1.', '2.', '3.', '4.'],
                     'its children are numbered in its place');
    const out = c.exportMarkdown(root.children, (id) => bodies[id], 1, null,
                                 roleOf);
    assert.equal(out, '# Background\n\nText.\n\n# Clinical burden\n\n' +
                 'Burden prose.\n\n# Gap in current methods\n\n' +
                 'Gap prose.\n\n# Methods\n\nMethods prose.\n',
                 'children print a heading level up');
    const segs = c.exportSegments(root.children, (id) => bodies[id], 1,
                                  null, roleOf);
    const by = Object.fromEntries(segs.map((s) => [s.id, s]));
    assert.equal(by.W.text, '');
    assert.equal(by.W.left, '# Why is this research important?\nPlanning.',
                 'the preview shows its text as left out');
    assert.equal(by.X.depth, 0);
    const r = c.statusReport(root, () => null, roleOf);
    assert.equal(r.cards.get('W').prints, false);
    assert.equal(r.cards.get('W').derived, 'draft',
                 'it still shows the status of the cards below');
});

test('status: printing cards carry their own, sections show the worst ' +
     'below, left-out branches do not count', () => {
    const root = c.makeRoot();
    const mk = (id, parent) => {
        const n = c.makeNode(id, id, null);
        c.appendChild(parent, n);
        return n;
    };
    const s = mk('S', root);
    mk('P1', s);
    mk('P2', s);
    const u = mk('U', s);
    mk('P3', u);
    const n = mk('N', root);
    mk('Q', n);
    const statuses = { P1: 'done', P2: 'revise', U: 'unsplit', P3: 'done',
                       Q: 'revise', S: 'done' };
    const roles = { N: 'notes' };
    const r = c.statusReport(root, (id) => statuses[id] || null,
                             (id) => roles[id] || null);
    const get = (id) => r.cards.get(id);
    assert.equal(get('P1').own, 'done');
    assert.equal(get('S').own, null, 'a section has no status of its own');
    assert.equal(get('S').derived, 'revise', 'the worst printing card below');
    assert.equal(get('S').below, 2, 'P2 to revise and U unsplit');
    assert.equal(get('U').own, 'unsplit');
    assert.equal(get('U').derived, 'done');
    assert.equal(r.cards.has('Q'), false, 'notes branches do not count');
    assert.deepEqual(r.tally, { revise: 1, unsplit: 1, draft: 0, done: 2 });
    assert.equal(c.leftover('# Head\nLeft behind. %% note %%'),
                 'Left behind.');
    assert.equal(c.leftover('# Head\n%% only a note %%'), '');
    assert.equal(c.lowerStatus('done', 'revise'), 'revise');
    assert.equal(c.lowerStatus('done', null), 'draft');
});

test('moving a card with its branch above, below or into another card',
     () => {
    const { root } = c.parseIndex(c.splitFrontmatter(INDEX).body);
    const [aims, sig] = root.children;
    const aim1 = aims.children[0];
    assert.ok(c.moveNode(sig, aims, 'above'));
    assert.deepEqual(root.children.map((n) => n.id),
                     ['R01-eeeee', 'R01-aaaaa']);
    assert.ok(c.moveNode(aims, sig, 'child'));
    assert.equal(aims.parent, sig);
    assert.equal(aim1.parent, aims, 'the branch moves with it');
    assert.ok(!c.moveNode(sig, aim1, 'below'), 'not into its own branch');
    assert.ok(!c.moveNode(sig, sig, 'child'), 'not onto itself');
    assert.ok(c.moveNode(aim1, sig, 'below'));
    assert.deepEqual(root.children.map((n) => n.id),
                     ['R01-eeeee', 'R01-bbbbb']);
    for (const n of c.allNodes(root)) {
        assert.ok(n.parent.children.includes(n), n.id);
    }
});

test('exported markdown is tidied like the Linter, code left alone', () => {
    const md = '# Aims   \nFirst line.\n\n\n\nSecond.\n## Sub\nText.\n' +
        '```r\nx <- 1   \n\n\n# not a heading\n```\nAfter.\n\n';
    assert.equal(c.normaliseMarkdown(md),
                 '# Aims\n\nFirst line.\n\nSecond.\n\n## Sub\n\nText.\n' +
                 '```r\nx <- 1   \n\n\n# not a heading\n```\nAfter.\n');
    assert.equal(c.normaliseMarkdown('\n\n'), '');
});

test('footnotes are renumbered across cards and gathered at the end', () => {
    const root = c.makeRoot();
    for (const id of ['A', 'B', 'C']) {
        c.appendChild(root, c.makeNode(id, id, null));
    }
    const bodies = {
        A: 'First claim[^1] and second[^2].\n\n[^1]: Note A1.\n' +
           '[^2]: Note A2,\n    continued.',
        B: 'Another claim[^1], an inline one^[inline], and `[^1]` in ' +
           'code.\n\n[^1]: Note B1.',
        C: 'Named[^smith].\n\n```\n[^1]: not a footnote\n```\n\n' +
           '[^smith]: Smith, named.',
    };
    const out = c.exportMarkdown(root.children, (id) => bodies[id], 1);
    assert.equal(out,
        'First claim[^1] and second[^2].\n\n' +
        'Another claim[^3], an inline one[^4], and `[^1]` in code.\n\n' +
        'Named[^5].\n\n```\n[^1]: not a footnote\n```\n\n' +
        '[^1]: Note A1.\n[^2]: Note A2,\n    continued.\n' +
        '[^3]: Note B1.\n[^4]: inline\n[^5]: Smith, named.\n',
        'an inline note is numbered with the rest');
    const r = c.renumberFootnotes([{ id: 'B', text: bodies.B }]);
    assert.deepEqual(r.segments[0].notes,
                     [{ n: 1, text: 'Note B1.' }, { n: 2, text: 'inline' }],
                     'each segment keeps its own notes for the preview');
});

test('footnotes with the same text become one note', () => {
    const root = c.makeRoot();
    for (const id of ['A', 'B']) c.appendChild(root, c.makeNode(id, id, null));
    const bodies = {
        A: 'Mash^[[@urbut2019]] and Metzner.[^m]\n\n[^m]: [@metzner2025]',
        B: 'Again mash^[[@urbut2019]], and^[[@urbut2019], p. 3] Metzner' +
           '^[[@metzner2025]].',
    };
    assert.equal(c.exportMarkdown(root.children, (id) => bodies[id], 1),
        'Mash[^1] and Metzner.[^2]\n\n' +
        'Again mash[^1], and[^3] Metzner[^2].\n\n' +
        '[^1]: [@urbut2019]\n[^2]: [@metzner2025]\n' +
        '[^3]: [@urbut2019], p. 3\n',
        'inline or numbered, the same text is one note; a page differs');
    const segs = c.renumberFootnotes(root.children.map((n) =>
        ({ id: n.id, text: bodies[n.id] }))).segments;
    assert.deepEqual(segs[1].notes, [{ n: 3, text: '[@urbut2019], p. 3' }],
                     'a card gives only the notes it is first to give');
    assert.deepEqual(segs[1].cardNotes.map((x) => x.n), [1, 2, 3],
                     'but renders every note it refers to');
    assert.deepEqual(segs[1].refs, [1, 3, 2], 'in order of reference');
});

test('the preview can gather footnotes by section or at the end, and ' +
     'numbers inline ones with the rest', () => {
    assert.equal(c.inlineToReferences(
        'As mash^[[@urbut2019], p. 3] does.[^1] `^[x]`\n' +
        '```\n^[y]\n```\n[^1]: Kept.'),
        'As mash[^dendrite-inline-1] does.[^1] `^[x]`\n```\n^[y]\n```\n' +
        '[^1]: Kept.\n\n[^dendrite-inline-1]: [@urbut2019], p. 3',
        'nested brackets close the note; code is left alone');
    const r = c.renumberFootnotes([
        { id: 'A', text: c.inlineToReferences('a^[[@k]] b[^x] c[^x]\n\n' +
                                              '[^x]: X.') },
        { id: 'B', text: 'd[^1]\n\n[^1]: Y.' }]).segments;
    assert.deepEqual(r.map((x) => x.refs), [[1, 2], [3]],
                     'reading order, inline included; each number once');
    assert.deepEqual(r[0].notes, [{ n: 1, text: '[@k]' },
                                  { n: 2, text: 'X.' }]);
    const segs = [
        { id: 'A', depth: 0, text: '# A', notes: [] },
        { id: 'B', depth: 1, text: 'b[^1]', notes: [{ n: 1, text: 'one' }] },
        { id: 'C', depth: 2, text: 'c[^2]', notes: [{ n: 2, text: 'two' }] },
        { id: 'D', depth: 0, text: '# D', notes: [] },
        { id: 'E', depth: 0, text: 'e[^3]', notes: [{ n: 3, text: 'three' }] },
    ];
    const shape = (out) => out.map((s) => s.gathered ?
        'notes:' + s.gathered.map((x) => x.n).join(',') : s.id);
    assert.deepEqual(shape(c.gatherFootnotes(segs, 'card')),
                     ['A', 'B', 'C', 'D', 'E'], 'card: unchanged');
    assert.deepEqual(shape(c.gatherFootnotes(segs, 'section')),
                     ['A', 'B', 'C', 'notes:1,2', 'D', 'E', 'notes:3'],
                     'section: after each top-level section with notes');
    assert.deepEqual(shape(c.gatherFootnotes(segs, 'end')),
                     ['A', 'B', 'C', 'D', 'E', 'notes:1,2,3']);
});

test('find: a card\'s short or full id finds that card', () => {
    assert.equal(c.shortId('DRAC-RAC-2026-lchl3'), 'lchl3');
    const bodies = { 'G-ab12c': 'Text.', 'G-zz9yy': 'Cites ab12c here.' };
    const ids = Object.keys(bodies);
    const run = (q) => c.findMatches(ids, (id) => bodies[id], q).matches
        .map((m) => m.id + (m.card ? ':card' : ':' + m.start));
    assert.deepEqual(run('ab12c'), ['G-ab12c:card', 'G-zz9yy:6']);
    assert.deepEqual(run(' g-AB12C '), ['G-ab12c:card'], 'the full id too');
    assert.deepEqual(run('ab12'), ['G-zz9yy:6'], 'only the whole id');
});

test('find: words must all be in a card, quotes keep a phrase, regex ' +
     'and case are options', () => {
    const bodies = {
        A: 'Clonal hematopoiesis with TET2 loss.',
        B: 'TET2 alone here. %% clonal note %%',
        C: 'Hematopoiesis that is clonal, and TET2.',
        D: 'Nothing.',
    };
    const ids = ['A', 'B', 'C', 'D'];
    const run = (q, o = {}) => c.findMatches(ids, (id) => bodies[id], q, o);
    const at = (r) => r.matches.map((m) => m.id + ':' +
        bodies[m.id].slice(m.start, m.end));
    assert.deepEqual(at(run('tet2 clonal')),
                     ['A:Clonal', 'A:TET2', 'B:TET2', 'B:clonal',
                      'C:clonal', 'C:TET2'],
                     'every word in the card, in text order, any case');
    assert.equal(run('tet2 clonal').matches.find(
        (m) => m.id === 'B' && /clonal/i.test(
            bodies.B.slice(m.start, m.end))).comment, true,
                 'a match inside a comment is marked');
    assert.deepEqual(at(run('"clonal hematopoiesis"')),
                     ['A:Clonal hematopoiesis'], 'a quoted phrase is exact');
    assert.deepEqual(at(run('Clonal', { matchCase: true })), ['A:Clonal']);
    assert.deepEqual(at(run('TET\\d (loss|alone)', { regex: true })),
                     ['A:TET2 loss', 'B:TET2 alone']);
    assert.match(run('(', { regex: true }).error, /./, 'a bad regex says so');
    assert.deepEqual(run('').matches, []);
    assert.deepEqual(run('x*', { regex: true }).matches, [],
                     'empty matches are skipped');
});

test('lineDiff marks lines only in one text, in order', () => {
    assert.deepEqual(c.lineDiff('a\nb\nc', 'a\nc\nd'),
                     [[' ', 'a'], ['-', 'b'], [' ', 'c'], ['+', 'd']]);
    assert.deepEqual(c.lineDiff('x', 'x'), [[' ', 'x']]);
});

test('charDiff marks the words and spaces only in one line', () => {
    // A trailing space is the whole difference.
    assert.deepEqual(c.charDiff('foo bar ', 'foo bar'),
                     [[['foo bar', false], [' ', true]],
                      [['foo bar', false]]]);
    assert.deepEqual(c.charDiff('the red fox', 'the brown fox'),
                     [[['the ', false], ['red', true], [' fox', false]],
                      [['the ', false], ['brown', true], [' fox', false]]]);
    assert.deepEqual(c.charDiff('same', 'same'),
                     [[['same', false]], [['same', false]]]);
    assert.deepEqual(c.charDiff('', 'new'), [[], [['new', true]]]);
});

// ---- tables and figures ----------------------------------------------------

const FLOATS = c.parseIndex([
    '- [[G-aaaaa|Aims]]',
    '\t- [[G-bbbbb|Text]]',
    '\t- [[G-ttttt|Budget]]',
    '\t\t- [[G-ccccc|Under the table]]',
    '\t- [[G-fffff|Design]]',
    '\t- [[G-sssss|Planning table]]',
    '- [[G-nnnnn|Notes]]',
    '\t- [[G-xxxxx|Hidden]]',
    '- [[G-uuuuu|Second]]',
].join('\n') + '\n').root;
const FLOAT_KINDS = { 'G-ttttt': 'table', 'G-fffff': 'figure',
                      'G-xxxxx': 'table', 'G-uuuuu': 'table',
                      'G-sssss': 'table' };
const FLOAT_ROLES = { 'G-nnnnn': 'notes', 'G-sssss': 'scaffolding',
                      'G-uuuuu': 'section' };
const floatKind = (id) => FLOAT_KINDS[id] || null;
const floatRole = c.withKinds((id) => FLOAT_ROLES[id] || null, floatKind);
const FLOAT_BODIES = {
    'G-aaaaa': '# Aims',
    'G-bbbbb': 'As [[G-ttttt]] shows, and [[fffff]] draws, with ' +
        '[[G-uuuuu|the second table]]. %%a comment%%',
    'G-ttttt': '# Budget by year\n\n| Year | Cost |\n| --- | --- |\n' +
        '| 1 | 10 |\n| 2 | 20 |\n\nCosts in $k.',
    'G-ccccc': 'After the table.',
    'G-fffff': '![[design.png]]\n\nStudy design.',
    'G-sssss': '| plan |\n| - |\n| x |',
    'G-xxxxx': '| a |\n| - |\n| 1 |',
    'G-uuuuu': '| b |\n| - |\n| 2 |',
};
const floatBody = (id) => FLOAT_BODIES[id] || '';
const floatOpts = { kindOf: floatKind };

test('a table or figure prints its full text, with cards below or set ' +
     'to heading only; left out or scaffolding, it prints nothing', () => {
    const node = (id) => c.allNodes(FLOATS).find((n) => n.id === id);
    assert.equal(c.roleFor(node('G-ttttt'), floatRole), 'prose');
    assert.equal(c.roleFor(node('G-uuuuu'), floatRole), 'prose');
    assert.equal(c.roleFor(node('G-sssss'), floatRole), 'scaffolding');
    assert.equal(c.roleFor(node('G-xxxxx'), floatRole), 'prose',
                 'its own role; the left-out branch decides');
});

test('tables and figures are numbered in reading order, apart; one that ' +
     'does not print takes no number', () => {
    const f = c.floatLabels(FLOATS.children, floatRole, floatKind);
    assert.deepEqual([...f], [['G-ttttt', 'Table 1'],
                              ['G-fffff', 'Figure 1'],
                              ['G-uuuuu', 'Table 2']]);
});

test('a table prints its caption above, numbered; a figure below', () => {
    const segs = c.exportSegments(FLOATS.children, floatBody, 1, null,
                                  floatRole, floatOpts);
    const text = (id) => segs.find((s) => s.id === id).text;
    assert.equal(text('G-ttttt'), '**Table 1.** Budget by year Costs ' +
        'in $k.\n\n| Year | Cost |\n| --- | --- |\n| 1 | 10 |\n| 2 | 20 |');
    assert.equal(text('G-ccccc'), 'After the table.');
    assert.equal(text('G-fffff'),
                 '![[design.png]]\n\n**Figure 1.** Study design.');
    assert.equal(text('G-uuuuu'), '**Table 2.**\n\n| b |\n| - |\n| 2 |');
    assert.equal(text('G-sssss'), '');
});

test('a link to a table or figure card prints its number; an alias ' +
     'prints as written', () => {
    const segs = c.exportSegments(FLOATS.children, floatBody, 1, null,
                                  floatRole, floatOpts);
    assert.equal(segs.find((s) => s.id === 'G-bbbbb').text,
                 'As [[G-ttttt|Table 1]] shows, and [[G-fffff|Figure 1]] ' +
                 'draws, with [[G-uuuuu|the second table]].');
    // Numbers come from the whole manuscript when a branch is exported.
    const floats = c.floatLabels(FLOATS.children, floatRole, floatKind);
    const part = c.exportSegments([FLOATS.children[2]], floatBody, 1, null,
                                  floatRole, { kindOf: floatKind, floats });
    assert.match(part[0].text, /^\*\*Table 2\.\*\*/);
});

test('a table or figure card takes no section number and has a status ' +
     'as prose does', () => {
    const nums = c.sectionNumbers(FLOATS.children, (id) =>
        /^#/.test(floatBody(id)), floatRole, floatKind);
    assert.ok(!nums.has('G-ttttt'));
    const r = c.statusReport({ children: FLOATS.children }, () => null,
                             floatRole);
    assert.equal(r.cards.get('G-ttttt').own, 'draft');
    assert.equal(r.cards.get('G-fffff').own, 'draft');
});

test('table rows count toward pages, not words; a figure is a third of ' +
     'a page unless its height says otherwise', () => {
    assert.deepEqual(c.countText('Two words.\n\n| a | b |\n| - | - |\n' +
                                 '| c | d |'),
                     { words: 2, chars: 9 });
    const heights = { 'G-uuuuu': 0.5 };
    const n = c.countManuscript(FLOATS.children, floatBody, floatRole,
                                false, { kindOf: floatKind,
                                         heightOf: (id) => heights[id] });
    // Table 1: 4 rows plus 2 lines of caption and spacing, at 46 lines a
    // page; the figure a third; Table 2 half a page, as set.
    assert.ok(Math.abs(n.pages - (6 / 46 + 1 / 3 + 0.5)) < 1e-9);
    assert.equal(c.measure(n, 'pages', 500), n.words / 500 + n.pages);
    assert.equal(c.measure(n, 'words', 500), n.words);
});

test('comment bubbles sit as near their marks as they can without ' +
     'overlapping, the current one level with its mark', () => {
    const { stackNotes } = c;
    // Apart: each level with its mark.
    assert.deepEqual(stackNotes([0, 100, 300], [40, 40, 40], -1, 10),
                     [0, 100, 300]);
    // Crowded: each pushed down below the one before.
    assert.deepEqual(stackNotes([0, 20, 30], [40, 40, 40], -1, 10),
                     [0, 50, 100]);
    // The current one level with its mark, those before it moved up.
    assert.deepEqual(stackNotes([100, 120, 130], [40, 40, 40], 2, 10),
                     [30, 80, 130]);
    assert.deepEqual(stackNotes([100, 120, 130], [40, 40, 40], 1, 10),
                     [70, 120, 170]);
    // Never above the document's start, where they could not be reached:
    // too near it, the bubbles stack down from it instead.
    assert.deepEqual(stackNotes([0, 20, 30], [40, 40, 40], 2, 10),
                     [0, 50, 100]);
    assert.deepEqual(stackNotes([], [], -1, 10), []);
});
