// Tests for citations drawn in the board and the preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const c = require('../src/citations.js');

test('a citation\'s items, with prefix, locator and suppressed author',
     () => {
    assert.deepEqual(c.parseCitation('see @a2020, p. 3; -@b2021'), [
        { prefix: 'see', key: 'a2020', suppress: false, locator: ', p. 3' },
        { prefix: '', key: 'b2021', suppress: true, locator: '' }]);
    assert.equal(c.parseCitation('write to me@home'), null);
    assert.equal(c.parseCitation('no key here'), null);
});

test('citations found outside code, links and images', () => {
    const t = 'A [@a2020]. `[@code]` [@b2021](x) ![@c](i.png) ' +
        'B^[[@d2022]] [x @e]\n```\n[@f]\n```\n';
    const found = c.citationsIn(t).map((x) => [x.items[0].key, x.inNote]);
    // [x @e] is a citation with a prefix, as Pandoc reads it.
    assert.deepEqual(found, [['a2020', false], ['d2022', true],
                             ['e', false]]);
});

test('a CSL\'s format, superscript and brackets', () => {
    assert.equal(c.citationStyle(null).format, 'author-date');
    const v = c.citationStyle('<category citation-format="numeric"/>' +
        '<citation collapse="citation-number"><layout prefix="[" ' +
        'suffix="]" delimiter=","></layout></citation>');
    assert.deepEqual([v.format, v.sup, v.prefix, v.suffix],
                     ['numeric', false, '[', ']']);
    const sup = c.citationStyle('<category citation-format="numeric"/>' +
        '<citation><layout vertical-align="sup" delimiter=","/>' +
        '</citation>');
    assert.deepEqual([sup.sup, sup.prefix, sup.suffix], [true, '', '']);
});

test('numbers by first citation, collapsed into ranges', () => {
    const nums = c.citationNumbers(['[@a] [@b; @c]', '[@d] [@a]']);
    assert.deepEqual([...nums], [['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
    assert.equal(c.collapse([4, 1, 2, 3, 6]), '1–4,6');
    assert.equal(c.collapse([1, 2]), '1,2');
    const st = c.citationStyle('<category citation-format="numeric"/>');
    const items = c.parseCitation('@a; @b; @c');
    assert.equal(c.citationText(items, st, nums), '[1–3]');
    assert.equal(c.citationText(c.parseCitation('@a, p. 3'), st, nums),
                 '[1, p. 3]');
});

test('author-date and board labels from the keys', () => {
    const ad = c.citationStyle(null);
    const items = c.parseCitation('see @sollierCOMPASS2023, p. 2; ' +
                                  '-@haoDictionary2024');
    assert.equal(c.citationText(items, ad),
                 '(see Sollier 2023, p. 2; 2024)');
    assert.equal(c.citationText(c.parseCitation('@sollierCOMPASS2023'),
                                null), 'Sollier 2023');
});

test('a note style\'s citations made footnotes after the punctuation',
     () => {
    assert.equal(c.asFootnotes('Text [@a]. More^[[@b]] and [@c; @d], x.'),
                 'Text.^[[@a]] More^[[@b]] and,^[[@c; @d]] x.');
});

test('citations drawn in rendered text, code left alone', () => {
    const doc = new JSDOM('<p>PURPLE [@priestleyP2019]. <code>[@x]</code>' +
        '</p>').window.document;
    const p = doc.querySelector('p');
    assert.equal(c.drawCitations(p), 1);
    assert.equal(p.textContent, 'PURPLE Priestley 2019. [@x]');
    assert.equal(p.querySelector('.dendrite-cite').title,
                 '@priestleyP2019');
});
