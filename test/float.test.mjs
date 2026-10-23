// Tests for table and figure cards: a card's text as a caption and its
// table or image, and back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const f = require('../src/float.js');

test('a table card splits into its caption and its table, and back',
     () => {
    const body = '# Compute per year\nAs requested.\n\n| A | B |\n' +
        '| --- | --- |\n| 1 | 2 |\n';
    const s = f.split(body, 'table');
    assert.deepEqual(s, { caption: '# Compute per year\nAs requested.',
                          content: '| A | B |\n| --- | --- |\n| 1 | 2 |' });
    assert.equal(f.compose('table', s.caption, s.content),
                 '# Compute per year\nAs requested.\n\n| A | B |\n' +
                 '| --- | --- |\n| 1 | 2 |');
    assert.equal(f.compose('table', '', s.content), s.content);
    assert.deepEqual(f.split('Just words.', 'table'),
                     { caption: 'Just words.', content: '' });
});

test('a figure card holds one image: the first one is its image, any ' +
     'other kept with the caption, and the image prints above it', () => {
    const s = f.split('Clones over time.\n![[a.png]]\n![[b.png]]', 'figure');
    assert.equal(s.content, '![[a.png]]');
    assert.equal(s.caption, 'Clones over time.\n![[b.png]]');
    assert.equal(f.compose('figure', 'Clones over time.', '![[c.png]]'),
                 '![[c.png]]\n\nClones over time.');
    assert.equal(f.embedFor('figures/G-aaaaa.png'),
                 '![[figures/G-aaaaa.png]]');
    assert.equal(f.linkedImage('see ![[x y.png]] here'), '![[x y.png]]');
    assert.equal(f.linkedImage('[[x.png]]'), '![[x.png]]');
    assert.equal(f.linkedImage('![alt](pic.jpg)'), '![alt](pic.jpg)');
    assert.equal(f.linkedImage('no link'), null);
});

test('a starter table, and the printed width of a page\'s text', () => {
    assert.match(f.STARTER_TABLE, /^\| Column 1 \| Column 2 \|\n\| --- \|/);
    // US Letter less 2.5cm a side, in CSS points.
    assert.equal(Math.round(f.textWidthPt({ paper: 'letter',
                                            margin: '2.5cm' })), 470);
    assert.equal(Math.round(f.textWidthPt({ paper: 'a4', margin: '1in' })),
                 451);
});

test('a figure\'s image written as a plain link is taken as its image, ' +
     'and written back as an embed', () => {
    const s = f.split('[[umap.png]]\n\nClones.', 'figure');
    assert.deepEqual(s, { caption: 'Clones.', content: '![[umap.png]]' });
    assert.equal(f.compose('figure', s.caption, s.content),
                 '![[umap.png]]\n\nClones.');
    assert.equal(f.split('See [[notes]] here.', 'figure').content, '',
                 'a link to a note is not an image');
});
