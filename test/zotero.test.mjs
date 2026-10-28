// Tests for citations linked to their paper's PDF in Zotero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const z = require('../src/zotero.js');

const NOTE = '# Paper\n[pg 3](zotero://open-pdf/library/items/AB12CD34' +
    '?page=3&annotation=ZZ99)\n';

/** An app holding one literature note for `metzner2025`. */
function app(reads) {
    const f = { path: 'Lit/Metzner.md' };
    const card = { path: 'cards/G-aaaaa.md' };
    return {
        vault: {
            getMarkdownFiles: () => [f, card],
            cachedRead: async (x) => {
                reads.push(x.path);
                return x === f ? NOTE : '';
            },
        },
        metadataCache: {
            getFileCache: (x) => (x === f ?
                { frontmatter: { citekey: 'metzner2025' } } : {}),
        },
    };
}

test('a footnote\'s citekeys, only where it is citations alone', () => {
    assert.deepEqual(z.citekeys('[@a2020; @b2021]'), ['a2020', 'b2021']);
    assert.deepEqual(z.citekeys('See [@a2020].'), []);
});

test('footnotes are found by the number a renderer draws', () => {
    const md = 'A^[[@a2020]] b[^x] c^[Plain.] d[^x]\n\n[^x]: [@b2021]';
    const by = z.notesByNumber(md);
    assert.equal(by.get(1), '[@a2020]');
    assert.equal(by.get(2), '[@b2021]');
    assert.equal(by.get(3), 'Plain.');
});

test('a citation becomes a link to its paper\'s PDF, its note read once',
     async () => {
    const reads = [];
    const links = new z.PdfLinks(app(reads));
    assert.equal(links.get('metzner2025'), null, 'not known yet');
    await links.load(['metzner2025', 'nobody2020']);
    assert.equal(links.get('metzner2025'),
                 'zotero://open-pdf/library/items/AB12CD34');
    assert.equal(links.get('nobody2020'), null);
    await links.load(['metzner2025']);
    assert.deepEqual(reads, ['Lit/Metzner.md']);
    // The card's text is left as it is; only the drawn mark links.
    const doc = new JSDOM('<p>Screen<sup class="footnote-ref"><a ' +
        'class="footnote-link" href="#fn-1">[1]</a></sup> and<sup ' +
        'class="footnote-ref"><a class="footnote-link" href="#fn-2">[2]' +
        '</a></sup></p>').window.document;
    const p = doc.querySelector('p');
    await z.linkCitations(p,
        'Screen^[[@metzner2025]] and^[[@nobody2020]]', links);
    const [a, b] = p.querySelectorAll('a');
    assert.equal(a.getAttribute('href'),
                 'zotero://open-pdf/library/items/AB12CD34');
    assert.ok(!a.classList.contains('footnote-link'));
    assert.equal(b.getAttribute('href'), '#fn-2', 'no PDF: left alone');
    // A changed literature note is looked up afresh.
    links.changed({ path: 'x.md' }, { frontmatter: { citekey: 'k' } });
    assert.equal(links.links.size, 0);
});
