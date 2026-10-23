// Tests for review comments from a returned Word file: reading the
// .docx, finding each passage in the cards, and writing it into them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const r = require('../src/review.js');
const d = require('../src/docx.js');
const zlib = require('zlib');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/' +
    '2006/main"';
const run = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;

/** A returned file as Word writes one: runs split, ranges, revisions. */
function returned() {
    const body =
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>' +
        run('1.2 Cohort') + '</w:p>' +
        '<w:p>' + run('The cohort is ') +
        '<w:commentRangeStart w:id="0"/>' + run('composed of longi') +
        '<w:proofErr w:type="spellStart"/>' + run('tudinally paired samples') +
        '<w:commentRangeEnd w:id="0"/>' +
        '<w:r><w:commentReference w:id="0"/></w:r>' +
        run(' collected from 175 AML patients&#8217; marrow.') + '</w:p>' +
        '<w:p>' + run('Samples were collected ') +
        '<w:del w:id="5" w:author="Aly Karsan" ' +
        'w:date="2026-10-23T10:00:00Z"><w:r><w:delText>between 2014 and' +
        '</w:delText></w:r><w:r><w:delText xml:space="preserve"> 2023' +
        '</w:delText></w:r></w:del>' +
        '<w:ins w:id="6" w:author="Aly Karsan" ' +
        'w:date="2026-10-23T10:00:00Z">' + run('from 2014 to 2023') +
        '</w:ins>' + run(' under the biobank protocol.') +
        '<w:ins w:id="7" w:author="Reviewer 2" w:date="2026-10-24T09:00:00Z">' +
        run(' All consented.') + '</w:ins></w:p>' +
        '<w:p>' + run('Single-cell DNA covers 51 patients.') +
        '<w:commentRangeStart w:id="1"/><w:commentRangeEnd w:id="1"/>' +
        '<w:r><w:commentReference w:id="1"/></w:r></w:p>';
    const comments = `<w:comments ${W}>` +
        '<w:comment w:id="0" w:author="Aly Karsan" ' +
        'w:date="2026-10-23T09:12:00Z" w:initials="AK"><w:p>' +
        run('Say how many samples, ') + '</w:p><w:p>' +
        run('not only patients.') + '</w:p></w:comment>' +
        '<w:comment w:id="1" w:author="Reviewer 2" ' +
        'w:date="2026-10-24T08:00:00Z"><w:p>' +
        run('Which timepoints?') + '</w:p></w:comment></w:comments>';
    return d.writeZip([
        { name: 'word/document.xml',
          data: Buffer.from(`<w:document ${W}><w:body>${body}` +
                            '</w:body></w:document>') },
        { name: 'word/comments.xml', data: Buffer.from(comments) }], zlib);
}

test('a returned .docx gives its comments and tracked changes, each ' +
     'with the passage as it was sent', () => {
    const items = r.readReview(returned(), zlib);
    assert.deepEqual(items.map((x) => [x.kind, x.author, x.date]), [
        ['comment', 'Aly Karsan', '2026-10-23'],
        ['change', 'Aly Karsan', '2026-10-23'],
        ['change', 'Reviewer 2', '2026-10-24'],
        ['comment', 'Reviewer 2', '2026-10-24']]);
    const [c0, ch, add, c1] = items;
    assert.equal(c0.quote, 'composed of longitudinally paired samples',
                 'runs split mid-word are one passage');
    assert.equal(c0.text, 'Say how many samples, not only patients.');
    assert.equal(c0.before, 'The cohort is ');
    assert.equal(c0.after, ' collected from 175 AML patients’ marrow.');
    assert.equal(ch.quote, 'between 2014 and 2023', 'deleted text kept');
    assert.equal(ch.insert, 'from 2014 to 2023', 'one replacement');
    assert.equal(ch.after, ' under the biobank protocol.',
                 'inserted text is not part of what was sent');
    assert.deepEqual([add.quote, add.insert], ['', ' All consented.']);
    assert.equal(c1.quote, '', 'a comment on a point');
    assert.equal(c1.before, 'Single-cell DNA covers 51 patients.');
});

test('a card\'s printed text maps back to its markdown', () => {
    const md = '## Cohort\n\nThe **cohort** is [[G-aaaaa|composed]] of ' +
        'samples [@smith2020]^[a note] %%planning%% from ' +
        '[patients](http://x)\\_s.\n';
    const p = r.plainMap(md);
    assert.equal(p.text, 'Cohort\n\nThe cohort is composed of samples   ' +
        'from patients_s.\n');
    const k = p.text.indexOf('composed');
    assert.equal(md.slice(p.map[k], p.map[k] + 8), 'composed');
    const t = r.plainMap('| A | B |\n| --- | -: |\n| 1 | 2 |');
    assert.equal(t.text.replace(/\s+/g, ' ').trim(), 'A B 1 2');
});

test('each passage is found in its card, exactly or by most of its ' +
     'words, and a passage not found is not placed', () => {
    const cards = [
        { id: 'A', text: '## Cohort\n' },
        { id: 'B', text: 'The cohort is composed of **longitudinally ' +
          'paired** samples collected from 175 AML patients\' marrow.' },
        { id: 'C', text: 'Samples were collected between 2014 and 2023 ' +
          'under the biobank protocol.' },
        { id: 'D', text: 'Single-cell DNA now covers 52 patients in ' +
          'total.' }];
    const [c0, ch, add, c1] = r.readReview(returned(), zlib);
    const at = r.locate(c0, cards);
    assert.equal(at.id, 'B');
    assert.equal(at.how, 'exact', 'markup and quotes do not matter');
    assert.equal(cards[1].text.slice(at.start, at.end),
                 'composed of **longitudinally paired** samples');
    const atc = r.locate(ch, cards);
    assert.deepEqual([atc.id, atc.how,
                      cards[2].text.slice(atc.start, atc.end)],
                     ['C', 'exact', 'between 2014 and 2023']);
    const ata = r.locate(add, cards);
    assert.equal(ata.id, 'C');
    assert.equal(ata.start, ata.end, 'an insertion is a point');
    assert.equal(cards[2].text.slice(0, ata.start),
                 'Samples were collected between 2014 and 2023 under the ' +
                 'biobank protocol.');
    const at1 = r.locate(c1, cards);
    assert.equal(at1.id, 'D', 'found by most of its words');
    assert.equal(at1.how, 'close');
    assert.equal(r.locate({ quote: 'Nothing like this is in any card',
                            before: '', after: '' }, cards), null);
});

test('comments are written after their passage, highlighted where the ' +
     'markdown allows, and read back', () => {
    const md = 'The cohort is composed of **longitudinally paired** ' +
        'samples.\nSamples were collected between 2014 and 2023.';
    const s1 = md.indexOf('composed');
    const e1 = md.indexOf(' samples') + ' samples'.length;
    const s2 = md.indexOf('between');
    const e2 = md.indexOf('2023') + 4;
    const out = r.addItems(md, [
        { kind: 'review', start: s1, end: e1, author: 'Aly Karsan',
          date: '2026-10-23', text: 'Say how many %% samples,\nnot only ' +
          'patients.' },
        { kind: 'suggest', start: s2, end: e2, author: 'Aly Karsan',
          date: '2026-10-23', text: 'from 2014 to 2023' }]);
    assert.equal(out, 'The cohort is ==composed of **longitudinally ' +
        'paired** samples==%%[!review] Aly Karsan, 2026-10-23: Say how ' +
        'many % samples, not only patients.%%.\nSamples were collected ' +
        '==between 2014 and 2023==%%[!suggest] Aly Karsan, 2026-10-23: ' +
        'from 2014 to 2023%%.');
    const items = r.reviewItems(out);
    assert.deepEqual(items.map((x) => [x.kind, x.passage, x.author,
                                       x.date, x.text]), [
        ['review', 'composed of **longitudinally paired** samples',
         'Aly Karsan', '2026-10-23', 'Say how many % samples, not only ' +
         'patients.'],
        ['suggest', 'between 2014 and 2023', 'Aly Karsan', '2026-10-23',
         'from 2014 to 2023']]);
    assert.equal(r.stripReview(out), md.replace('%%', '%'),
                 'export prints the text as it was');
    assert.equal(r.removeItem(out, 1, true), 'The cohort is ==composed ' +
        'of **longitudinally paired** samples==%%[!review] Aly Karsan, ' +
        '2026-10-23: Say how many % samples, not only patients.%%.\n' +
        'Samples were collected from 2014 to 2023.', 'applied');
    assert.equal(r.removeItem(r.removeItem(out, 1), 0), md,
                 'resolved, the text is as it was');
});

test('a passage that cannot be highlighted as it is gets its comment ' +
     'after it, and a suggestion quotes what it would replace', () => {
    const md = 'Half **bold text** here.';
    const s = md.indexOf('bold');
    const out = r.addItems(md, [
        { kind: 'suggest', start: s, end: md.indexOf(' here'),
          author: 'R', date: '2026-10-24', text: 'strong words',
          quote: 'bold text' }]);
    assert.equal(out, 'Half **bold text**%%[!review] R, 2026-10-24: ' +
        'replace "bold text" with "strong words"%% here.');
});

test('export prints a commented passage without its highlight, and ' +
     'keeps highlights of the writer\'s own', () => {
    const c = require('../src/core.js');
    assert.equal(c.stripComments('A ==mine== and ==theirs==%%[!review] ' +
        'R, 2026-10-24: why?%% and ==old==%%[!suggest] R, 2026-10-24: ' +
        'new%%.'), 'A ==mine== and theirs and old.');
});

test('on the board a comment\'s passage is marked and numbered, with a ' +
     'callout under its paragraph whose buttons say which comment', () => {
    const { JSDOM } = require('jsdom');
    const doc = new JSDOM('<div id="root"></div>').window.document;
    const md = 'First ==passage==%%[!review] Aly Karsan, 2026-10-23: Why?' +
        '%% here.\n\nThen ==old==%%[!suggest] R, 2026-10-24: new%% and a ' +
        'point.%%[!review] R, 2026-10-24: Cite this.%%';
    const html = r.renderMarkdown(md);
    assert.equal(html, 'First <mark class="dendrite-review-mark">passage' +
        '</mark><sup class="dendrite-review-n">1</sup> here.\n\nThen ' +
        '<span class="dendrite-review-old">old</span><span ' +
        'class="dendrite-review-new">new</span><sup class="dendrite-review-n' +
        ' is-suggest">2</sup> and a point.<sup class="dendrite-review-n">3' +
        '</sup>');
    // As Obsidian would render it: one paragraph per block.
    const root = doc.getElementById('root');
    root.innerHTML = html.split('\n\n').map((x) => `<p>${x}</p>`).join('');
    const acts = [];
    r.decorate(root, r.reviewItems(md), (n, what) => acts.push([n, what]));
    const kids = [...root.children].map((e) => e.className || e.tagName);
    assert.deepEqual(kids, ['P', 'dendrite-review-notes', 'P',
                            'dendrite-review-notes']);
    const notes = root.querySelectorAll('.dendrite-review-note');
    assert.equal(notes[0].querySelector('.dendrite-review-meta').textContent,
                 'Aly Karsan · 23 Oct');
    assert.equal(notes[1].className, 'dendrite-review-note is-suggest');
    assert.equal(notes[1].querySelector('.dendrite-review-text').textContent,
                 'Suggests: new');
    for (const b of root.querySelectorAll('button')) b.click();
    assert.deepEqual(acts, [[0, 'resolve'], [1, 'apply'], [1, 'dismiss'],
                            [2, 'resolve']]);
});

test('a suggested insertion keeps its spaces, and applying it puts it ' +
     'in at its point', () => {
    const md = 'Under the biobank protocol.';
    const out = r.addItems(md, [{ kind: 'suggest', start: md.length,
        end: md.length, author: 'Reviewer 2', date: '2026-10-24',
        text: ' All consented.' }]);
    assert.equal(out, 'Under the biobank protocol.%%[!suggest] Reviewer 2, ' +
        '2026-10-24:  All consented.%%');
    assert.equal(r.reviewItems(out)[0].text, ' All consented.');
    assert.equal(r.removeItem(out, 0, true),
                 'Under the biobank protocol. All consented.');
    assert.equal(r.removeItem(out, 0), md, 'dismissed');
});

test('only what a card prints is searched: a section its heading line, ' +
     'notes and scaffolding nothing, with offsets kept', () => {
    const c = require('../src/core.js');
    const raw = '# Storage Details\n\n| 4.3.1 | Storage Details |';
    const sec = c.printedOnly(raw, 'section');
    assert.equal(sec.length, raw.length);
    assert.equal(sec.trimEnd(), '# Storage Details');
    assert.equal(c.printedOnly(raw, 'prose'), raw);
    assert.equal(c.printedOnly(raw, 'notes').trim(), '');
    assert.equal(c.printedOnly('No heading here.', 'section').trim(), '');
    const at = r.locate({ quote: 'Storage Details', before: '4.2.1 ',
                          after: '' },
                        [{ id: 'table', text: c.printedOnly(
                            '# Storage\n\n| 4.3.1 | Storage Details |',
                            'section') },
                         { id: 'head', text: '# Storage Details\n' }]);
    assert.equal(at.id, 'head');
});

test('a review file in JSON gives comments, each searched for only in ' +
     'the card it names when it names one', () => {
    const items = r.readReviewJson(JSON.stringify([
        { card: 'bbbbb', quote: 'paired samples', text: 'How many?',
          author: 'Claude', date: '2026-10-23' },
        { quote: 'paired samples', text: 'Anywhere.' },
        { card: 'G-aaaaa', quote: 'paired samples', text: 'Not here.' }]));
    assert.deepEqual(items[0], { kind: 'comment', card: 'bbbbb',
        quote: 'paired samples', before: '', after: '', text: 'How many?',
        author: 'Claude', date: '2026-10-23' });
    assert.equal(items[1].author, '');
    assert.match(items[1].date, /^\d{4}-\d\d-\d\d$/, 'no date: today');
    const cards = [{ id: 'G-aaaaa', text: 'Unrelated text here.' },
                   { id: 'G-ccccc', text: 'The paired samples, again.' },
                   { id: 'G-bbbbb', text: 'Longitudinally paired samples.' }];
    assert.equal(r.locate(items[0], cards).id, 'G-bbbbb', 'short id');
    assert.equal(r.locate(items[1], cards), null,
                 'in two cards and naming neither: not placed');
    assert.equal(r.locate(items[2], cards), null, 'not in the named card');
    assert.deepEqual(r.readReviewJson('{"items": []}'), []);
    assert.throws(() => r.readReviewJson('[{"quote": "x"}]'),
                  /item 1 has no text/);
    assert.throws(() => r.readReviewJson('{"a": 1}'), /a list of items/);
});

test('the review endpoint takes JSON only with its key, refuses web ' +
     'pages, and answers with what the plugin says', async () => {
    const api = require('../src/reviewapi.js');
    const got = [];
    const server = await api.start({
        port: 0, token: 'k3y',
        async submit(body) {
            got.push(body);
            return { status: 202, json: { id: 'r1', state: 'pending' } };
        },
        async status(id) {
            return id === 'r1' ? { status: 200, json: { state: 'added' } } :
                { status: 404, json: { error: 'no such review' } };
        } });
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = { authorization: 'Bearer k3y' };
    const json = { 'content-type': 'application/json' };
    const call = async (path, init = {}) => {
        const res = await fetch(base + path, init);
        return [res.status, await res.json()];
    };
    try {
        const body = JSON.stringify({ manuscript: 'G', items: [] });
        assert.deepEqual(await call('/dendrite/review', {
            method: 'POST', headers: { ...auth, ...json }, body }),
            [202, { id: 'r1', state: 'pending' }]);
        assert.deepEqual(got, [{ manuscript: 'G', items: [] }]);
        assert.equal((await call('/dendrite/review', {
            method: 'POST', headers: json, body }))[0], 401, 'no key');
        assert.equal((await call('/dendrite/review', {
            method: 'POST', headers: { authorization: 'Bearer no', ...json },
            body }))[0], 401, 'wrong key');
        assert.equal((await call('/dendrite/review', {
            method: 'POST', headers: { ...auth, ...json,
                                       origin: 'https://example.com' },
            body }))[0], 403, 'a web page');
        assert.equal((await call('/dendrite/review', {
            method: 'OPTIONS', headers: { origin: 'https://example.com' } }))
            [0], 403, 'no cross-origin preflight');
        assert.equal((await call('/dendrite/review', {
            method: 'POST', headers: { ...auth,
                                       'content-type': 'text/plain' },
            body }))[0], 415);
        assert.equal((await call('/dendrite/review', {
            method: 'POST', headers: { ...auth, ...json }, body: '{' }))
            [0], 400);
        assert.equal((await call('/dendrite/review', {
            method: 'POST', headers: { ...auth, ...json },
            body: 'x'.repeat((1 << 20) + 1) }))[0], 413);
        assert.deepEqual(await call('/dendrite/review/r1',
                                    { headers: auth }),
                         [200, { state: 'added' }]);
        assert.equal((await call('/dendrite/review/zz',
                                 { headers: auth }))[0], 404);
        assert.equal((await call('/elsewhere', { headers: auth }))[0], 404);
        assert.equal(got.length, 1, 'only the good request reached it');
    } finally {
        await new Promise((r) => server.close(r));
    }
    await assert.rejects(api.start({ port: -1, token: 'k' }));
});

test('a comment or change already in its card is known as one', () => {
    const md = 'The ==cohort==%%[!review] Claude, 2026-10-23: How many?%% ' +
        'was ==large==%%[!suggest] Aly Karsan, 2026-10-23: big%%.';
    const c = (text, author = 'Claude') => ({ kind: 'comment', author,
                                              text });
    assert.ok(r.alreadyIn(md, c('How many?')));
    assert.ok(r.alreadyIn(md, c('How  many?\n')), 'as it would be written');
    assert.ok(!r.alreadyIn(md, c('How many?', 'Aly Karsan')),
              'another reviewer\'s');
    assert.ok(!r.alreadyIn(md, c('How few?')));
    assert.ok(r.alreadyIn(md, { kind: 'change', author: 'Aly Karsan',
                                quote: 'large', insert: 'big' }));
    assert.ok(!r.alreadyIn(md, { kind: 'change', author: 'Aly Karsan',
                                 quote: 'large', insert: 'huge' }));
    assert.ok(r.alreadyIn('Text.%%[!review] Claude, 2026-10-23: On ' +
        '“gone”: Lost.%%', c('Lost.')), 'one added with its passage quoted');
});
