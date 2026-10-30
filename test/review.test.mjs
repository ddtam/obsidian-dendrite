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

/** A table row of Word cells, `marks` cell index to a tracked change. */
function row(cells, marks = {}) {
    const by = 'w:author="Aly Karsan" w:date="2026-10-25T10:00:00Z"';
    return '<w:tr>' + cells.map((c, k) => '<w:tc><w:p>' + (marks[k] ?
        `<w:del w:id="${k}" ${by}><w:r><w:delText>${c}</w:delText>` +
        `</w:r></w:del><w:ins w:id="${k + 50}" ${by}>` +
        run(marks[k]) + '</w:ins>' : run(c)) +
        '</w:p></w:tc>').join('') + '</w:tr>';
}

test('a change in a table cell or before a paragraph\'s first word is ' +
     'found from the text around it, a short one exactly', () => {
    const by = 'w:author="Aly Karsan" w:date="2026-10-25T10:00:00Z"';
    const body =
        `<w:p><w:ins w:id="1" ${by}>` + run('AML is deadly. ') +
        '</w:ins>' + run('Single-cell assays produce much data.') +
        '</w:p><w:tbl>' +
        row(['Data', 'Patients', 'Libraries']) +
        row(['WGS CRAMs', '175', '534 (175 normal)'], { 1: '200' }) +
        row(['RNA CRAMs', '156', '318 (156 pre-)'], { 1: '200' }) +
        row(['DOGMA-seq', '18', '36'], { 1: '51' }) +
        row(['Extra DOGMA-seq', '18', '20']) + '</w:tbl>';
    const buf = d.writeZip([{ name: 'word/document.xml',
        data: Buffer.from(`<w:document ${W}><w:body>${body}` +
                          '</w:body></w:document>') }], zlib);
    const cards = [
        { id: 'P', text: 'Some text before.\n\nSingle-cell assays ' +
          'produce much data.' },
        { id: 'T', text: '| Data | Patients | Libraries |\n' +
          '| --- | ---: | --- |\n' +
          '| WGS CRAMs | 175 | 534 (175 normal) |\n' +
          '| RNA CRAMs | 156 | 318 (156 pre-) |\n' +
          '| DOGMA-seq | 18 | 36 |\n' +
          '| Extra DOGMA-seq | 18 | 20 |\n' }];
    const items = r.readReview(buf, zlib);
    assert.deepEqual(items.map((x) => [x.quote, x.insert]),
                     [['', 'AML is deadly. '], ['175', '200'],
                      ['156', '200'], ['18', '51']]);
    const where = items.map((x) => {
        const at = r.locate(x, cards);
        if (!at) return null;
        const t = cards.find((c) => c.id === at.id).text;
        return [at.id, at.how, t.slice(at.start - 12, at.start) + '[' +
                t.slice(at.start, at.end) + ']'];
    });
    assert.deepEqual(where, [
        ['P', 'exact', 'xt before.\n\n[]'],
        ['T', 'exact', 'WGS CRAMs | [175]'],
        ['T', 'exact', 'RNA CRAMs | [156]'],
        ['T', 'exact', 'DOGMA-seq | [18]']]);
});

test('comments are written with their passage between markers, and ' +
     'read back', () => {
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
    assert.equal(out, 'The cohort is %%{2%%composed of **longitudinally ' +
        'paired** samples%%}2 [!review] Aly Karsan, 2026-10-23: Say how ' +
        'many % samples, not only patients.%%.\nSamples were collected ' +
        '%%{1%%between 2014 and 2023%%}1 [!suggest] Aly Karsan, ' +
        '2026-10-23: from 2014 to 2023%%.');
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
    assert.equal(r.removeItem(out, 1, true), 'The cohort is %%{2%%' +
        'composed of **longitudinally paired** samples%%}2 [!review] Aly ' +
        'Karsan, 2026-10-23: Say how many % samples, not only patients.' +
        '%%.\nSamples were collected from 2014 to 2023.', 'applied');
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

test('a comment on a passage that overlaps or sits inside one already ' +
     'in the card is held between markers, the one it overlaps too, so ' +
     'both keep their own text', () => {
    const had = '==of which 155 have paired RNA==%%[!review] Claude, ' +
        '2026-10-23: Hm.%%';
    const md = `Samples from 175 patients, ${had}. More.`;
    const by = { author: 'Aly Karsan 2', date: '2026-10-23' };
    const claude = '%%}1 [!review] Claude, 2026-10-23: Hm.%%';
    // Overlapping its start, as ", of which 155 have p".
    const over = r.addItems(md, [{ kind: 'suggest', ...by,
        start: md.indexOf(', ==of'), end: md.indexOf('aired'),
        text: ' and p', quote: ', of which 155 have p' }]);
    assert.equal(over, 'Samples from 175 patients%%{2%%, %%{1%%of which ' +
        '155 have p%%}2 [!suggest] Aly Karsan 2, 2026-10-23:  and p%%' +
        `aired RNA${claude}. More.`);
    assert.deepEqual(r.reviewItems(over).map((x) => [x.author, x.passage]),
        [['Aly Karsan 2', ', of which 155 have p'],
         ['Claude', 'of which 155 have paired RNA']]);
    assert.equal(r.stripReview(over), r.stripReview(md));
    // Brought in again: known as already in.
    assert.ok(r.alreadyIn(over, { kind: 'change', ...by,
        quote: ', of which 155 have p', insert: ' and p' }));
    // Wholly inside its passage.
    const s = md.indexOf('155');
    const inside = r.addItems(md, [{ kind: 'review', ...by, start: s,
        end: s + 3, text: 'Check.' }]);
    assert.equal(inside, 'Samples from 175 patients, %%{1%%of which ' +
        '%%{2%%155%%}2 [!review] Aly Karsan 2, 2026-10-23: Check.%% have ' +
        `paired RNA${claude}. More.`);
    // A point inside a highlighted passage goes after its comment.
    const point = r.addItems(md, [{ kind: 'review', ...by, start: s,
        end: s, text: 'Here.' }]);
    assert.equal(point, `Samples from 175 patients, ${had}%%[!review] ` +
        'Aly Karsan 2, 2026-10-23: Here.%%. More.');
});

test('a comment on a passage across a line or half of some bold is held ' +
     'between markers, kept out of a link', () => {
    const md = 'Half **bold text** here,\nsee [[Note|the note]] too.';
    const by = { author: 'R', date: '2026-10-24' };
    const out = r.addItems(md, [{ kind: 'review', ...by,
        start: md.indexOf('text'), end: md.indexOf('the note') + 3,
        text: 'Why?' }]);
    assert.equal(out, 'Half **bold %%{1%%text** here,\nsee [[Note|the ' +
        'note]]%%}1 [!review] R, 2026-10-24: Why?%% too.');
    assert.equal(r.reviewItems(out)[0].passage,
                 'text** here,\nsee [[Note|the note]]');
});

test('comments written with start and end markers may overlap: each is ' +
     'read with its passage, export keeps the text, and taking one out ' +
     'leaves the other whole', () => {
    const md = 'Samples, %%{1%%of which %%{2%%155 have p' +
        '%%}2 [!suggest] Aly Karsan 2, 2026-10-23:  and p%%' +
        'aired RNA%%}1 [!review] Claude, 2026-10-23: Hm.%%' +
        '%%[!reply] Me, 2026-10-24: Yes.%%. More ==text==' +
        '%%[!review] Joshua Bridgers, 2026-10-24: Old form.%%.';
    const items = r.reviewItems(md);
    assert.deepEqual(items.map((x) => [x.kind, x.author, x.passage,
                                       x.text, x.replies.length]), [
        ['suggest', 'Aly Karsan 2', '155 have p', ' and p', 0],
        ['review', 'Claude', 'of which 155 have paired RNA', 'Hm.', 1],
        ['review', 'Joshua Bridgers', 'text', 'Old form.', 0]]);
    assert.equal(r.stripReview(md),
                 'Samples, of which 155 have paired RNA. More text.');
    // Claude's taken out: Aly's markers stay, around the same text.
    const noClaude = r.removeItem(md, 1);
    assert.deepEqual(r.reviewItems(noClaude).map((x) => x.passage),
                     ['155 have p', 'text']);
    assert.equal(r.stripReview(noClaude), r.stripReview(md));
    // Aly's applied: her text in, Claude's comment around the result.
    const applied = r.removeItem(md, 0, true);
    assert.equal(r.stripReview(applied),
                 'Samples, of which and paired RNA. More text.');
    assert.deepEqual(r.reviewItems(applied).map((x) => x.passage),
                     ['of which and paired RNA', 'text']);
    // A reply goes after Claude's own note, not into Aly's.
    const replied = r.addReply(md, 1, { author: 'Me', date: '2026-10-25',
                                        text: 'Again.' });
    assert.deepEqual(r.reviewItems(replied)[1].replies.map((x) => x.text),
                     ['Yes.', 'Again.']);
    assert.equal(r.removeReply(replied, 1, 0).includes('Yes.'), false);
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
        '</mark><sup class="dendrite-review-n dendrite-item-0">1</sup> ' +
        'here.\n\nThen <span class="dendrite-review-old">old</span><span ' +
        'class="dendrite-review-new">new</span><sup class="dendrite-review-n' +
        ' is-suggest dendrite-item-1">2</sup> and a point.<sup class=' +
        '"dendrite-review-n dendrite-item-2">3</sup>');
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
    // Its buttons sit at the right of the name line, so the text below
    // runs the full width of the card rather than beside a column.
    const bar = notes[0].querySelector('.dendrite-review-main')
        .firstElementChild;
    assert.equal(bar.className, 'dendrite-review-acts');
    assert.equal(bar.nextElementSibling.className, 'dendrite-review-meta');
    assert.equal(notes[0].querySelectorAll(':scope > button').length, 0);
    for (const b of root.querySelectorAll('button')) b.click();
    assert.deepEqual(acts, [[0, 'resolve'], [1, 'apply'], [1, 'dismiss'],
                            [2, 'resolve']]);
    // Right-click on a comment: its own menu, through `act`.
    const menus = [];
    root.innerHTML = html.split('\n\n').map((x) => `<p>${x}</p>`).join('');
    r.decorate(root, r.reviewItems(md), () => {},
               (n, e) => menus.push(n));
    root.querySelectorAll('.dendrite-review-note')[2].dispatchEvent(
        new doc.defaultView.MouseEvent('contextmenu', { bubbles: true }));
    assert.deepEqual(menus, [2]);
});

test('overlapping comments are drawn as marks over their own text, ' +
     'nested where they overlap, and numbered at their notes', () => {
    const { JSDOM } = require('jsdom');
    const doc = new JSDOM('<div id="root"></div>').window.document;
    const md = 'Samples, %%{1%%of which **%%{2%%155** have p' +
        '%%}2 [!suggest] Aly, 2026-10-23:  and p%%' +
        'aired RNA%%}1 [!review] Claude, 2026-10-23: Hm.%%. End.';
    const colours = new Map([['Aly', 'green'], ['Claude', 'pink']]);
    const html = r.renderMarkdown(md, (who) => colours.get(who));
    // As Obsidian would render it.
    const root = doc.getElementById('root');
    root.innerHTML = '<p>' + html.replace(/\*\*(.*?)\*\*/,
                                          '<strong>$1</strong>') + '</p>';
    r.wrapPassages(root);
    const marked = (sel) => [...root.querySelectorAll(sel)]
        .map((x) => x.textContent).join('|');
    assert.equal(marked('mark.dendrite-review-mark.dendrite-rid-1'),
                 'of which |155| have p|aired RNA');
    assert.equal(marked('.dendrite-review-old.dendrite-rid-2'),
                 '155| have p');
    assert.ok(root.querySelector('mark.is-c-pink .dendrite-review-old' +
                                 '.is-c-green'), 'nested where they overlap');
    assert.equal(marked('.dendrite-review-new'), 'and p');
    assert.deepEqual([...root.querySelectorAll('sup.dendrite-review-n')]
        .map((x) => x.textContent), ['1', '2']);
    assert.equal(root.textContent, 'Samples, of which 155 have p and p1' +
                 'aired RNA2. End.');
    r.decorate(root, r.reviewItems(md), () => {});
    assert.equal(root.querySelectorAll('.dendrite-review-note').length, 2);
});

test('comments in the old highlighted form are converted to markers, ' +
     'once and one way, the text and the comments unchanged', () => {
    const md = 'A ==first==%%[!review] R, 2026-10-23: One.%%%%[!reply] ' +
        'Me, 2026-10-24: Ok.%% and %%{1%%x%%}1 [!review] S, 2026-10-23: ' +
        'Two.%% then ==old==%%[!suggest] R, 2026-10-24: new%%, and a ' +
        'point.%%[!review] R, 2026-10-24: Three.%%';
    assert.equal(r.oldComments(md), 2);
    const out = r.convertOld(md);
    assert.equal(out, 'A %%{2%%first%%}2 [!review] R, 2026-10-23: One.%%' +
        '%%[!reply] Me, 2026-10-24: Ok.%% and %%{1%%x%%}1 [!review] S, ' +
        '2026-10-23: Two.%% then %%{3%%old%%}3 [!suggest] R, 2026-10-24: ' +
        'new%%, and a point.%%[!review] R, 2026-10-24: Three.%%');
    assert.equal(r.oldComments(out), 0);
    assert.equal(r.stripReview(out), r.stripReview(md));
    const strip = (x) => ({ ...x, start: 0, end: 0, noteStart: 0,
                            open: undefined, id: undefined });
    assert.deepEqual(r.reviewItems(out).map(strip),
                     r.reviewItems(md).map(strip));
    assert.equal(r.convertOld(out), out, 'nothing left to convert');
});

test('in the card editor a comment\'s syntax is hidden: its start marker ' +
     'gone, its note and replies a numbered chip, its passage tinted, and ' +
     'typing kept out of them', () => {
    const md = 'A %%{1%%of %%{2%%155%%}2 [!suggest] Aly, 2026-10-23: 200%%' +
        ' have%%}1 [!review] Claude, 2026-10-23: Hm.%%%%[!reply] Me, ' +
        '2026-10-24: Yes.%% and ==old==%%[!review] Josh, 2026-10-24: Ok.%%.';
    const e = r.editorRanges(md);
    const show = ([a, b]) => md.slice(a, b);
    assert.deepEqual(e.hide.map(show), ['%%{1%%', '%%{2%%']);
    assert.deepEqual(e.chips.map((c) => [c.n, c.author, c.kind, show(
        [c.from, c.to])]), [
        [1, 'Aly', 'suggest', '%%}2 [!suggest] Aly, 2026-10-23: 200%%'],
        [2, 'Claude', 'review', '%%}1 [!review] Claude, 2026-10-23: Hm.%%' +
            '%%[!reply] Me, 2026-10-24: Yes.%%'],
        [3, 'Josh', 'review', '%%[!review] Josh, 2026-10-24: Ok.%%']]);
    assert.deepEqual(e.marks.map((m) => [m.author, show([m.from, m.to])]),
        [['Aly', '155'], ['Claude', 'of %%{2%%155%%}2 [!suggest] Aly, ' +
            '2026-10-23: 200%% have']]);
    assert.deepEqual(e.protect.map(show), [...e.hide, ...e.chips.map(
        (c) => [c.from, c.to])].sort((a, b) => a[0] - b[0]).map(show));
    // What the editor shows of each, under its paragraph and in its text.
    assert.deepEqual(e.chips.map((c) => [c.date, c.text, c.passage,
        c.replies.map((x) => x.text), c.first]), [
        ['2026-10-23', '200', true, [], true],
        ['2026-10-23', 'Hm.', true, ['Yes.'], true],
        ['2026-10-24', 'Ok.', true, [], true]]);
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

test('a comment\'s Google Docs link rides at the end of its text, and a ' +
     'comment is known by the same keys before and after it is written',
     () => {
    const url = 'https://docs.google.com/document/d/D1/edit?disco=AAA1';
    assert.deepEqual(r.noteLink(`How many? ${url}`),
                     { text: 'How many?', url });
    assert.deepEqual(r.noteLink('No link.'), { text: 'No link.', url: '' });
    const item = { kind: 'comment', author: 'Aly Karsan', text: 'How  many?',
                   gid: 'AAA1', link: url, quote: 'paired' };
    const md = r.addItems('The paired samples.', [{ kind: 'review',
        start: 4, end: 10, author: 'Aly Karsan', date: '2026-10-24',
        text: `How many? ${url}` }]);
    const [note] = r.reviewItems(md);
    const keys = r.reviewKeys(item);
    assert.ok(keys.includes('g:AAA1'));
    assert.ok(r.reviewKeys(note).some((k) => keys.includes(k)),
              'the note on the card answers to the item');
    assert.ok(r.alreadyIn(md, item), 'with its link, still the same');
    // A comment placed with its passage quoted is the same comment.
    const quoted = r.reviewItems('Text.%%[!review] Aly Karsan, ' +
        '2026-10-24: On “gone”, in an earlier version: How many?%%')[0];
    assert.ok(r.reviewKeys(quoted).some((k) =>
        r.reviewKeys({ ...item, gid: '' }).includes(k)));
    // A change, by what it takes out and puts in.
    const change = { kind: 'change', author: 'A', quote: 'large',
                     insert: 'big' };
    const sug = r.reviewItems(r.addItems('was large.', [{ kind: 'suggest',
        start: 4, end: 9, author: 'A', date: '2026-10-24', text: 'big',
        quote: 'large' }]))[0];
    // The same suggestion, in a card or as sent: one key; as sent it is
    // known too as the comment it would go in as.
    assert.equal(r.reviewKeys(sug)[0], r.reviewKeys(change)[0]);
    assert.notDeepEqual(r.reviewKeys({ ...change, insert: 'huge' }),
                        r.reviewKeys(change));
});

test('a comment already in a card without its Google Docs link gets it, ' +
     'and nothing else changes', () => {
    const url = 'https://docs.google.com/document/d/D/edit?disco=AAA1';
    const md = 'The ==cohort==%%[!review] Joshua Bridgers, 2026-10-22: ' +
        'How many?%% was large.';
    const item = { kind: 'comment', author: 'Joshua Bridgers',
                   text: 'How many?', gid: 'AAA1', link: url };
    assert.ok(r.needsLink(md, item));
    const out = r.addLink(md, item);
    assert.equal(out, 'The ==cohort==%%[!review] Joshua Bridgers, ' +
        `2026-10-22: How many? ${url}%% was large.`);
    assert.ok(!r.needsLink(out, item), 'linked once');
    assert.equal(r.addLink(out, item), out);
    assert.ok(!r.needsLink(md, { ...item, link: '' }), 'no link to give');
    assert.ok(!r.needsLink('Other text.', item), 'not in this card');
});

test('a comment on a Word file in Docs is known by its whole doco. id',
     () => {
    const url = 'https://docs.google.com/document/d/D/edit?disco=' +
        'doco.Qknvat1R-9aOjq3RpB5kKw';
    const note = r.reviewItems('A ==b==%%[!review] J, 2026-10-23: Why? ' +
        `${url}%%`)[0];
    assert.ok(r.reviewKeys(note).includes('g:doco.Qknvat1R-9aOjq3RpB5kKw'));
});

// Google Docs' own record of a doc's comments, as it keeps one inside a
// Word file it saves: protocol buffers, base64 in a custom XML part.
function pbField(n, value) {
    const varint = (x) => {
        const out = [];
        while (x > 127) {
            out.push((x % 128) | 128);
            x = Math.floor(x / 128);
        }
        out.push(x);
        return Buffer.from(out);
    };
    if (typeof value === 'number') {
        return Buffer.concat([varint(n * 8), varint(value)]);
    }
    const b = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    return Buffer.concat([varint(n * 8 + 2), varint(b.length), b]);
}
function googleRecord(docId, comments) {
    return Buffer.concat([pbField(1, '1.0'), ...comments.map((c) =>
        pbField(4, Buffer.concat([pbField(1, c.id), pbField(2,
            Buffer.concat([pbField(1, c.id),
                           pbField(4, Buffer.concat([pbField(1, 'text/plain'),
                                                     pbField(2, c.text)])),
                           pbField(6, c.ms)]))]))),
        pbField(14, docId)]);
}

test('a Word file saved by Google Docs gives each comment its Google ' +
     'link, one comment on several passages the same link', () => {
    const d = require('../src/docx.js');
    const W2 = W;
    const at = '2026-10-23T18:13:01Z';
    const ms = Date.parse(at) + 681;
    const range = (id, t) => `<w:commentRangeStart w:id="${id}"/>` +
        run(t) + `<w:commentRangeEnd w:id="${id}"/>` +
        `<w:r><w:commentReference w:id="${id}"/></w:r>`;
    const body = '<w:p>' + run('We sequenced ') + range(0, 'WGS CRAMs') +
        run(' and ') + range(1, 'scDNA panels') + run(' with ') +
        range(2, 'mash') + run('.') + '</w:p>';
    const note = (id, date, text) => `<w:comment w:id="${id}" ` +
        `w:author="Joshua Bridgers" w:date="${date}"><w:p>${run(text)}` +
        '</w:p></w:comment>';
    const comments = `<w:comments ${W2}>` +
        note(0, at, 'Inconsistent naming.') +
        note(1, at, 'Inconsistent naming.') +
        note(2, '2026-10-23T17:58:09Z', 'Which mash?') + '</w:comments>';
    const record = googleRecord('DOC1', [
        { id: 'doco.Wk1b', text: 'Inconsistent naming.', ms },
        { id: 'doco.Qknv', text: 'Which mash?',
          ms: Date.parse('2026-10-23T17:58:09Z') + 120 }]);
    const custom = '<?xml version="1.0"?><go:gDocsCustomXmlDataStorage ' +
        'xmlns:go="http://customooxmlschemas.google.com/"><go:docsCustomData' +
        ' roundtripDataSignature="x">' + record.toString('base64') +
        '</go:docsCustomData></go:gDocsCustomXmlDataStorage>';
    const file = d.writeZip([
        { name: 'word/document.xml', data: Buffer.from(
            `<w:document ${W2}><w:body>${body}</w:body></w:document>`) },
        { name: 'word/comments.xml', data: Buffer.from(comments) },
        { name: 'customXML/item1.xml', data: Buffer.from(custom) }], zlib);
    const items = r.readReview(file, zlib);
    const base = 'https://docs.google.com/document/d/DOC1/edit?disco=';
    assert.deepEqual(items.map((x) => [x.quote, x.gid, x.link]), [
        ['WGS CRAMs', 'doco.Wk1b', base + 'doco.Wk1b'],
        ['scDNA panels', 'doco.Wk1b', base + 'doco.Wk1b'],
        ['mash', 'doco.Qknv', base + 'doco.Qknv']]);
    // A Word file not from Google Docs: no links.
    assert.ok(r.readReview(returned(), zlib).every((x) => !x.link));
});

test('a Google comment on several passages of a card is one comment: ' +
     'one number for its passages, one callout, saying how many', () => {
    const { JSDOM } = require('jsdom');
    const doc = new JSDOM('<div id="root"></div>').window.document;
    const url = 'https://docs.google.com/document/d/D/edit?disco=doco.W';
    const n = (p, t, link) => `==${p}==%%[!review] J, 2026-10-23: ${t}` +
        (link ? ` ${url}` : '') + '%%';
    const md = `A ${n('one', 'Same.', true)} and ${n('two', 'Other.')} ` +
        `then ${n('three', 'Same.', true)}.`;
    const html = r.renderMarkdown(md);
    assert.deepEqual([...html.matchAll(/review-n dendrite-item-\d+">(\d+)</g)]
        .map((m) => m[1]),
                     ['1', '2', '1'], 'its passages share its number');
    const root = doc.getElementById('root');
    root.innerHTML = `<p>${html}</p>`;
    r.decorate(root, r.reviewItems(md), () => {});
    const notes = [...root.querySelectorAll('.dendrite-review-note')];
    assert.equal(notes.length, 2, 'one callout for the comment');
    assert.match(notes[0].textContent, /2 passages/);
    assert.equal(r.countComments(r.reviewItems(md)), 2);
});

/** A returned file with one comment on a numbered heading, as Docs does. */
function onHeading(inner) {
    const body =
        '<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr>' + inner +
        '</w:p><w:p>' + run('Fir is the selected cluster.') + '</w:p>';
    const comments = `<w:comments ${W}>` +
        '<w:comment w:id="6" w:author="J" w:date="2026-10-23T09:12:00Z">' +
        '<w:p>' + run('This section seems unnecessary.') + '</w:p>' +
        '</w:comment></w:comments>';
    return d.writeZip([
        { name: 'word/document.xml',
          data: Buffer.from(`<w:document ${W}><w:body>${body}` +
                            '</w:body></w:document>') },
        { name: 'word/comments.xml', data: Buffer.from(comments) }], zlib);
}

test('a comment on a numbered heading is placed on that heading\'s card, ' +
     'the number being the export\'s, not the card\'s text', () => {
    const whole = r.readReview(onHeading(
        '<w:commentRangeStart w:id="6"/>' + run('4.2.1 Cluster Selection') +
        '<w:commentRangeEnd w:id="6"/>' +
        '<w:r><w:commentReference w:id="6"/></w:r>'), zlib)[0];
    assert.equal(whole.quote, 'Cluster Selection');
    assert.equal(whole.heading, true);
    const contents = { id: 'G-table', text: '# Compute Requests\n\n' +
        '| Subsection | Content |\n| --- | --- |\n' +
        '| 4.2.1 | Cluster Selection |\n| 4.2.2 | Size of Request |' };
    const sizes = { id: 'G-sizes', text: 'Data held.\n\n| Data | TB |\n' +
        '| --- | --- |\n| WGS | 4.0 |\n| RNA | 2.3 |\n| DOGMA | 1.7 |\n' +
        '| scDNA | 11.0 |' };
    const heading = { id: 'G-head', text: '# Cluster Selection' };
    const at = r.locate(whole, [contents, sizes, heading]);
    assert.equal(at.id, 'G-head');
    assert.equal(heading.text.slice(at.start, at.end), 'Cluster Selection');
    // Without its card, not matched on the number's digits in a table.
    assert.equal(r.locate(whole, [contents, sizes]), null);
    // On part of the heading: the number is not the text before it.
    const part = r.readReview(onHeading(run('4.2.1 ') +
        '<w:commentRangeStart w:id="6"/>' + run('Cluster') +
        '<w:commentRangeEnd w:id="6"/>' +
        '<w:r><w:commentReference w:id="6"/></w:r>' + run(' Selection')),
        zlib)[0];
    assert.equal(part.before, '');
    assert.equal(r.locate(part, [contents, sizes, heading]).id, 'G-head');
});

test('reviewer colours: kept per manuscript as "Name: colour", a new ' +
     'reviewer given the next colour not taken, none moved', () => {
    const m = r.reviewerColours(['Joshua Bridgers: green', 'bad entry',
                                 'Aly Karsan: nope']);
    assert.deepEqual([...m], [['Joshua Bridgers', 'green']]);
    const out = r.assignColours(m, ['Aly Karsan', 'Joshua Bridgers',
                                    'Reviewer 2']);
    assert.equal(out.added, true);
    assert.deepEqual([...out.map], [['Joshua Bridgers', 'green'],
        ['Aly Karsan', 'blue'], ['Reviewer 2', 'purple']],
        'blue first, green skipped as taken');
    assert.deepEqual(r.colourList(out.map), ['Joshua Bridgers: green',
        'Aly Karsan: blue', 'Reviewer 2: purple']);
    assert.equal(r.assignColours(out.map, ['Aly Karsan']).added, false);
    // Past the eight, colours are used again.
    const many = r.assignColours(new Map(),
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']).map;
    assert.equal(many.get('i'), 'blue');
    // A name written as a link to the person's note is the note's name,
    // or the link's alias, the name as the comments give it.
    assert.deepEqual([...r.reviewerColours(['[[Aly Karsan]]: pink',
        '[[People/Josh B|Joshua Bridgers]]: cyan'])],
        [['Aly Karsan', 'pink'], ['Joshua Bridgers', 'cyan']]);
    assert.deepEqual(r.reviewerEntries(['[[People/Josh B|Joshua Bridgers]]: ' +
        'cyan', 'Claude: red']), [
        { name: 'Joshua Bridgers', note: 'People/Josh B', colour: 'cyan' },
        { name: 'Claude', note: null, colour: 'red' }]);
    assert.deepEqual(r.entryList([
        { name: 'Joshua Bridgers', note: 'People/Josh B', colour: 'cyan' },
        { name: 'Aly Karsan', note: 'Aly Karsan', colour: 'pink' },
        { name: 'Claude', note: null, colour: 'red' }]),
        ['[[People/Josh B|Joshua Bridgers]]: cyan', '[[Aly Karsan]]: pink',
         'Claude: red']);
    // Written back, a link stays a link.
    const prior = ['[[Aly Karsan]]: pink'];
    assert.deepEqual(r.colourList(new Map([['Aly Karsan', 'red'],
        ['Reviewer 2', 'blue']]), prior),
        ['[[Aly Karsan]]: red', 'Reviewer 2: blue']);
});

test('a reviewer\'s comments and suggested changes take their colour', () => {
    const md = 'A ==one==%%[!review] Aly Karsan, 2026-10-23: Why?%% and ' +
        '==two==%%[!suggest] Joshua Bridgers, 2026-10-23: 2%% and ' +
        '==three==%%[!review] Nobody, 2026-10-23: Eh.%%';
    const colours = new Map([['Aly Karsan', 'blue'],
                             ['Joshua Bridgers', 'green']]);
    const html = r.renderMarkdown(md, (who) => colours.get(who) || null);
    assert.match(html, /<mark class="dendrite-review-mark is-c-blue">one/);
    assert.match(html, /<span class="dendrite-review-old is-c-green">two/);
    assert.match(html, /<span class="dendrite-review-new is-c-green">2/);
    assert.match(html, /<mark class="dendrite-review-mark">three/,
                 'no colour: the default');
    assert.equal(r.reviewItems(md).map((x) => x.author).join(),
                 'Aly Karsan,Joshua Bridgers,Nobody');
});

test('replies follow the comment they answer, go with it when it is ' +
     'resolved, and never print', () => {
    const md = 'The ==cohort==%%[!review] Claude, 2026-10-23: Say how many.' +
        '%% is large.';
    const one = r.addReply(md, 0, { author: 'Derek Tam', date: '2026-10-24',
                                    text: '175 patients, in Methods.' });
    assert.equal(one, 'The ==cohort==%%[!review] Claude, 2026-10-23: Say ' +
        'how many.%%%%[!reply] Derek Tam, 2026-10-24: 175 patients, in ' +
        'Methods.%% is large.');
    const two = r.addReply(one, 0, { author: 'Claude', date: '2026-10-24',
                                     text: 'Thanks; noted.' });
    const it = r.reviewItems(two)[0];
    assert.deepEqual(it.replies.map((x) => [x.author, x.date, x.text]), [
        ['Derek Tam', '2026-10-24', '175 patients, in Methods.'],
        ['Claude', '2026-10-24', 'Thanks; noted.']]);
    assert.equal(two.slice(it.end), ' is large.', 'the whole thread');
    assert.equal(r.reviewItems(two).length, 1, 'a reply is not a comment');
    assert.equal(r.countComments(r.reviewItems(two)), 1);
    assert.equal(r.removeItem(two, 0), 'The cohort is large.');
    assert.equal(r.stripReview(two), 'The cohort is large.');
    assert.doesNotMatch(r.renderMarkdown(two), /reply/);
    // A reply taken back.
    assert.equal(r.removeReply(two, 0, 1), one);
    // A reply's text kept to one line, with no %%.
    assert.match(r.addReply(md, 0, { author: 'D', date: '2026-10-24',
        text: 'a\nb %% c' }), /%%\[!reply\] D, 2026-10-24: a b % c%%/);
});

test('the review endpoint answers GET /dendrite/threads with the ' +
     'plugin\'s threads for a manuscript, with its key only', async () => {
    const api = require('../src/reviewapi.js');
    const asked = [];
    const server = await api.start({
        port: 0, token: 'k3y',
        async submit() { return { status: 500, json: {} }; },
        async status() { return { status: 404, json: {} }; },
        async threads(prefix, opts) {
            asked.push([prefix, opts]);
            return { status: 200, json: { manuscript: prefix, threads: [] } };
        } });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (path, headers = {}) => {
        const res = await fetch(base + path, { headers });
        return [res.status, await res.json()];
    };
    try {
        const auth = { authorization: 'Bearer k3y' };
        assert.deepEqual(await call('/dendrite/threads?manuscript=G' +
            '&author=Claude&card=G-aaaaa', auth),
            [200, { manuscript: 'G', threads: [] }]);
        await call('/dendrite/threads?manuscript=G&resolved=1', auth);
        assert.deepEqual(asked, [
            ['G', { author: 'Claude', awaiting: null, card: 'G-aaaaa',
                    resolved: false }],
            ['G', { author: null, awaiting: null, card: null,
                    resolved: true }]]);
        assert.equal((await call('/dendrite/threads?manuscript=G'))[0], 401);
        assert.equal((await call('/dendrite/threads', auth))[0], 400,
                     'which manuscript');
    } finally {
        server.close();
    }
});

test('the review endpoint takes POST /dendrite/reply as JSON, with its ' +
     'key only', async () => {
    const api = require('../src/reviewapi.js');
    const got = [];
    const server = await api.start({
        port: 0, token: 'k3y',
        async submit() { return { status: 500, json: {} }; },
        async status() { return { status: 404, json: {} }; },
        async reply(data) {
            got.push(data);
            return { status: 201, json: { card: 'G-aaaaa' } };
        },
        async suggest(data) {
            got.push(data);
            return { status: 201, json: { done: [1], refused: [] } };
        } });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body, headers) => {
        const res = await fetch(base + '/dendrite/reply', { method: 'POST',
            headers, body });
        return [res.status, await res.json()];
    };
    const json = { authorization: 'Bearer k3y',
                   'content-type': 'application/json' };
    try {
        const sent = { manuscript: 'G', thread: 'G-aaaaa/1f', text: 'Yes.' };
        assert.deepEqual(await post(JSON.stringify(sent), json),
                         [201, { card: 'G-aaaaa' }]);
        assert.deepEqual(got, [sent]);
        assert.equal((await post('{}', { 'content-type':
            'application/json' }))[0], 401);
        assert.equal((await post('{', json))[0], 400);
        const res = await fetch(base + '/dendrite/suggest', {
            method: 'POST', headers: json, body: '{"items":[]}' });
        assert.deepEqual(await res.json(), { done: [1], refused: [] });
        assert.deepEqual(got[got.length - 1], { items: [] });
    } finally {
        server.close();
    }
});

test('what goes back to reviewers: their comments with the writer\'s ' +
     'replies to them, and nothing written by or to Claude', () => {
    const md = 'A ==b==%%[!review] Aly, 2026-10-23: Why?%%%%[!reply] ' +
        'Claude, 2026-10-27: Cite Sollier.%%%%[!reply] Derek Tam, ' +
        '2026-10-27: Done, see Methods.%% c ==d==%%[!review] Derek Tam, ' +
        '2026-10-27: Too long?%% e ==f==%%[!review] Claude, 2026-10-27: ' +
        'Say how many.%%.';
    const out = r.forReviewers(r.reviewItems(md),
                               new Set(['Derek Tam', 'Me']));
    assert.deepEqual(out.map((it) => [it.author, it.text,
        it.replies.map((x) => x.author)]),
        [['Aly', 'Why?', ['Derek Tam']]]);
});

test('a reply with no text is drawn at the end of its thread, in its ' +
     'writer\'s colour, as a mark that they read it and had nothing to ' +
     'add, with a reply to them', () => {
    const { JSDOM } = require('jsdom');
    const doc = new JSDOM('<div id="root"></div>').window.document;
    const md = 'A ==b==%%[!review] Aly, 2026-10-23: Typo.%%%%[!reply] ' +
        'Derek, 2026-10-24: Fixed.%%%%[!reply] Claude, 2026-10-27: %%.';
    const root = doc.getElementById('root');
    root.innerHTML = '<p>' + r.renderMarkdown(md) + '</p>';
    const menus = [];
    const acts = [];
    r.decorate(root, r.reviewItems(md), (...a) => acts.push(a),
               (n, e, k) => menus.push([n, k]),
               (who) => (who === 'Claude' ? 'purple' : null));
    const rows = [...root.querySelectorAll('.dendrite-review-reply')];
    assert.equal(rows.length, 2, 'the mark is the thread\'s last row');
    const seen = rows[1];
    assert.ok(seen.classList.contains('is-seen'));
    assert.ok(seen.classList.contains('is-c-purple'), 'Claude\'s colour');
    assert.equal(seen.querySelector('.dendrite-review-meta').textContent,
                 '✓ Claude · 27 Oct', 'a read mark');
    assert.equal(seen.querySelector('.dendrite-review-check').textContent
        .trim(), '✓', 'the check its own, to colour and place');
    assert.equal(root.querySelector('.dendrite-review-note > * > ' +
        '.dendrite-review-meta .dendrite-review-seen'), null,
    'not in the comment\'s name line');
    // Taken back from its own menu, as a reply is.
    seen.dispatchEvent(new doc.defaultView.MouseEvent('contextmenu',
                                                      { bubbles: true }));
    assert.deepEqual(menus, [[0, 1]]);
    // A reply to Claude: the box opens addressed, in plain sight.
    const to = seen.querySelector('button');
    assert.equal(to.textContent, 'Reply to Claude');
    to.click();
    const box = root.querySelector('.dendrite-review-reply-box');
    assert.equal(box.value, '@Claude ');
    box.value += 'Why not the other?';
    root.querySelector('.dendrite-review-reply-form .mod-cta').onclick();
    assert.deepEqual(acts, [[0, 'reply', '@Claude Why not the other?']]);
    assert.equal(rows[0].querySelector('button'), null,
                 'the writer\'s own reply has none');
});

test('a reply addressed to Claude shows it, Claude\'s name in Claude\'s ' +
     'colour, and is left out of what goes back to reviewers', () => {
    const { JSDOM } = require('jsdom');
    const doc = new JSDOM('<div id="root"></div>').window.document;
    const md = 'A ==b==%%[!review] Aly, 2026-10-23: Why?%%%%[!reply] ' +
        'Derek, 2026-10-27: @Claude Is she right?%%%%[!reply] Derek, ' +
        '2026-10-27: Fixed in Methods.%%.';
    const root = doc.getElementById('root');
    root.innerHTML = '<p>' + r.renderMarkdown(md) + '</p>';
    r.decorate(root, r.reviewItems(md), () => {}, null,
               (who) => (who === 'Claude' ? 'purple' : null));
    const rows = [...root.querySelectorAll('.dendrite-review-reply')];
    assert.equal(rows[0].querySelector('.dendrite-review-meta').textContent,
                 'Derek · 27 Oct');
    const said = rows[0].querySelector('.dendrite-review-text');
    assert.equal(said.textContent, '@Claude Is she right?');
    const to = said.querySelector('.dendrite-review-to');
    assert.equal(to.textContent, '@Claude');
    assert.ok(![...to.classList].some((c) => c.startsWith('is-c-')),
              'neutral, so it is not read as Claude\'s own');
    const out = r.forReviewers(r.reviewItems(md), new Set(['Derek']));
    assert.deepEqual(out[0].replies.map((x) => x.text),
                     ['Fixed in Methods.']);
});

test('a thread awaits Claude until Claude answers, and again only when ' +
     'someone replies to Claude; the writer\'s own, when addressed to ' +
     'Claude', () => {
    const self = new Set(['Derek', 'Me']);
    const at = (md) => r.reviewItems(md).map((it) =>
        r.awaits(it, 'Claude', self));
    const C = '%%[!reply] Claude, 2026-10-27: %%';
    const rev = (x) => `A ==b==%%[!review] Aly, 2026-10-23: Why?%%${x}.`;
    const own = (x) => 'A ==b==%%[!review] Derek, 2026-10-23: @Claude ' +
        `Why?%%${x}.`;
    const note = (x) => `A ==b==%%[!review] Derek, 2026-10-23: Why?%%${x}.`;
    assert.deepEqual(at(rev('')), [true], 'not answered');
    assert.deepEqual(at(rev(C)), [false], 'seen');
    assert.deepEqual(at(rev(C + '%%[!reply] Derek, 2026-10-28: Done.%%')),
                     [false], 'the writer answering the reviewer');
    assert.deepEqual(at(rev(C + '%%[!reply] Derek, 2026-10-28: @Claude ' +
        'Sure?%%')), [true], 'the writer asking Claude');
    assert.deepEqual(at(rev(C + '%%[!reply] Aly, 2026-10-28: Also.%%')),
                     [true], 'the reviewer again');
    assert.deepEqual(at(own('')), [true], 'the writer asks Claude');
    assert.deepEqual(at(own(C + '%%[!reply] Derek, 2026-10-28: And?%%')),
                     [true], 'the writer\'s own question, followed up');
    assert.deepEqual(at(note('')), [false], 'the writer\'s own note');
    assert.deepEqual(at(note('%%[!reply] Derek, 2026-10-28: More.%%')),
                     [false], 'and its follow-up');
    assert.deepEqual(at(note('%%[!reply] Derek, 2026-10-28: @Claude ' +
        'Ideas?%%')), [true], 'until Claude is asked in it');
    assert.deepEqual(at('A ==b==%%[!review] Claude, 2026-10-23: x%%.'),
                     [false], 'Claude\'s own comment');
});

test('Claude\'s last replies in a thread are replaced by one, and only ' +
     'when nobody has replied since', () => {
    const head = 'A ==b==%%[!review] Aly, 2026-10-23: 200+?%%';
    const old = '%%[!reply] Claude, 2026-10-27: Conflicts with 175.%%' +
        '%%[!reply] Claude, 2026-10-28: Correction: 200+ stands.%%';
    const now = { author: 'Claude', date: '2026-10-28',
                  text: '200+ is the expanded cohort; fine.' };
    assert.equal(r.replaceReplies(`${head}${old}.`, 0, 'Claude', now),
        `${head}%%[!reply] Claude, 2026-10-28: 200+ is the expanded ` +
        'cohort; fine.%%.');
    const seen = { author: 'Claude', date: '2026-10-28', text: '' };
    assert.equal(r.replaceReplies(`${head}${old}.`, 0, 'Claude', seen),
                 `${head}%%[!reply] Claude, 2026-10-28: %%.`,
                 'taken back: a seen mark');
    const derek = '%%[!reply] Derek, 2026-10-28: OK.%%';
    assert.equal(r.replaceReplies(`${head}${old}${derek}.`, 0, 'Claude',
                                  now), null, 'answered since');
    assert.equal(r.replaceReplies(`${head}.`, 0, 'Claude', now), null,
                 'nothing of Claude\'s');
});

test('a thread id stays the same as replies are added and differs ' +
     'between comments', () => {
    const md = 'A ==b==%%[!review] Me, 2026-10-27: Why?%% c ==d==' +
        '%%[!review] Me, 2026-10-27: Why?%%.';
    const [x, y] = r.reviewItems(md);
    assert.notEqual(r.threadId(x), r.threadId(y), 'same words');
    const z = r.reviewItems(r.addReply(md, 0, { author: 'Claude',
        date: '2026-10-27', text: 'Yes.' }))[0];
    assert.equal(r.threadId(z), r.threadId(x));
});

test('an edit that leaves a comment marking no text is found, with which ' +
     'comment it was', () => {
    const md = 'We %%{1%%sequenced 51 pairs%%}1 [!review] Aly, 2026-10-23: ' +
        'How many?%% and ==mapped==%%[!review] Josh, 2026-10-24: Which?%%.';
    assert.deepEqual(r.passagesLost(md, md.replace('sequenced 51 pairs',
                                                   'sequenced 52 pairs')),
                     [], 'its passage changed, not gone');
    const gone = md.replace('sequenced 51 pairs', '');
    assert.deepEqual(r.passagesLost(md, gone).map((x) => [x.n, x.author,
        x.text]), [[1, 'Aly', 'How many?']]);
    // An old comment whose highlight marks were deleted.
    const unmarked = md.replace('==mapped==', 'mapped');
    assert.deepEqual(r.passagesLost(md, unmarked).map((x) => x.author),
                     ['Josh']);
    // One already marking nothing is not found again.
    assert.deepEqual(r.passagesLost(gone, gone + ' More.'), []);
});

test('an insertion after a space goes after the space, as the reviewer ' +
     'put it, not against the word before', () => {
    // Aly Karsan's .docx: "each type of " then "genomic " inserted, then
    // "regulatory change has." It was placed against "of".
    const text = 'We propose a model that uses the central dogma as a ' +
        'framework for defining, in advance, the interconnected effects ' +
        'each type of regulatory change has. Assay outputs follow.';
    const cards = [{ id: 'DRAC-RAC-2026-37ely', text }];
    const item = { kind: 'suggest', quote: '', text: 'genomic ',
        before: 'defining, in advance, the interconnected effects each ' +
            'type of ',
        after: 'regulatory change has. Assay outputs follow.' };
    const at = r.locate(item, cards);
    assert.equal(text.slice(at.start, at.start + 10), 'regulatory');
    // Found only by most of its words, the same.
    const close = r.locate(Object.assign({}, item, {
        before: 'defining in advance the connected effects each type of ' }),
        cards);
    assert.equal(text.slice(close.start, close.start + 10), 'regulatory');
    // Text before that ends against the insertion keeps it there.
    const tight = r.locate(Object.assign({}, item, {
        before: 'the interconnected effects each type of', text: 's' }),
        [{ id: 'x', text: 'the interconnected effects each type of change' }]);
    assert.equal(tight.start, 'the interconnected effects each type of'
        .length);
});

test('a deletion that took a space with it takes the same space, so ' +
     'applying it leaves one', () => {
    // Aly Karsan's .docx: "from 200+ " inserted, "175 " deleted.
    const text = 'Applied to samples from 175 patients with paired WGS.';
    const cards = [{ id: 'x', text }];
    const del = { kind: 'suggest', quote: '175 ', text: '',
        before: 'Applied to samples from ', after: 'patients with paired' };
    const at = r.locate(del, cards);
    assert.equal(text.slice(at.start, at.end), '175 ');
    // Its space before instead, as at the end of a sentence.
    const end = r.locate({ kind: 'suggest', quote: ' nested', text: '',
        before: 'performed on a', after: '.' },
        [{ id: 'y', text: 'Also performed on a nested.' }]);
    assert.equal('Also performed on a nested.'.slice(end.start, end.end),
                 ' nested');
    // A comment's passage stays as it was.
    const note = r.locate({ kind: 'review', quote: '175 ',
        before: 'samples from ', after: 'patients' }, cards);
    assert.equal(text.slice(note.start, note.end), '175');
});

test('a suggestion that went in as a comment is known again as that ' +
     'suggestion, so once resolved it is not offered ticked', () => {
    const add = { kind: 'change', quote: '', author: 'Aly Karsan 2',
        insert: 'Acute myeloid leukemia (AML) is a deadly cancer. ' };
    const swap = { kind: 'change', quote: '175 ', insert: '200+ ',
        author: 'Aly Karsan 2' };
    for (const it of [add, swap]) {
        const asComment = { kind: 'review', author: it.author,
                            text: r.changeAsComment(it) };
        const s = r.reviewKeys(it).find((k) => k.startsWith('s:'));
        const c = r.reviewKeys(asComment).find((k) => k.startsWith('c:'));
        assert.ok(r.reviewKeys(asComment).includes(s),
                  'the comment knows the suggestion');
        assert.ok(r.reviewKeys(it).includes(c),
                  'the suggestion knows the comment, resolved before');
    }
    assert.equal(r.changeAsComment(add), 'Suggested adding “Acute ' +
        'myeloid leukemia (AML) is a deadly cancer.”. The text has ' +
        'changed here since it was sent.');
    // Kept as "replace … with …", where it could not go in as a change.
    const kept = { kind: 'review', author: 'Aly Karsan 2',
                   text: 'replace "175" with "200+"' };
    assert.ok(r.reviewKeys(kept).includes(r.reviewKeys(swap)[0]));
});

test('grey can be chosen for a reviewer, as for one\'s own comments, ' +
     'but is never given out', () => {
    assert.equal(r.REVIEWER_COLOURS[r.REVIEWER_COLOURS.length - 1], 'grey');
    assert.equal(r.reviewerColours(['Me: grey']).get('Me'), 'grey');
    assert.equal(r.colourCss('grey'), 'var(--text-muted)');
    assert.equal(r.colourCss('blue'), 'var(--color-blue)');
    // More reviewers than colours: given out round again, never grey.
    const names = Array.from({ length: 12 }, (_, k) => `R${k}`);
    const { map } = r.assignColours(new Map(), names);
    assert.ok(![...map.values()].includes('grey'));
});

test('a place in an earlier version is carried to the card that replaced ' +
     'it by the words the two share', () => {
    const was = 'Modern single-cell assays produce an immense volume of ' +
        'data. Multiple such assays are often used in tandem.';
    const now = 'Modern sequencing-based assays generate an immense volume ' +
        'of data. Multiple such assays are often used in tandem.';
    const al = r.alignWords(was, now);
    // A point: before the first word, and before "Multiple".
    assert.deepEqual(r.mapThrough(al, was, now, 0, 0), { start: 0, end: 0 });
    const k = was.indexOf('Multiple');
    assert.deepEqual(r.mapThrough(al, was, now, k, k),
        { start: now.indexOf('Multiple'), end: now.indexOf('Multiple') });
    // A passage still there, word for word, even starting inside a word.
    const p = was.indexOf('immense volume');
    const m = r.mapThrough(al, was, now, p, p + 'immense volume'.length);
    assert.equal(now.slice(m.start, m.end), 'immense volume');
    const q = was.indexOf('ften used');
    const mq = r.mapThrough(al, was, now, q, q + 'ften used'.length);
    assert.equal(now.slice(mq.start, mq.end), 'ften used');
    // One whose words are gone, or are no longer side by side: none.
    const g = was.indexOf('produce');
    assert.equal(r.mapThrough(al, was, now, g, g + 7), null);
    const h = was.indexOf('single-cell assays');
    assert.equal(r.mapThrough(al, was, now, h, h + 18), null);
});

test('applying a change leaves no doubled space, nor a space before ' +
     'punctuation, where it joins the text', () => {
    const A = 'Aly Karsan 2, 2026-10-23: ';
    // A deletion that missed the space before it.
    assert.equal(r.removeItem('more than 50 cases %%{5%%respectively%%}5 ' +
        `[!suggest] ${A}%%.`, 0, true), 'more than 50 cases.');
    // A replacement whose new text ends with the space after it.
    assert.equal(r.removeItem(`collected from %%{2%%175%%}2 [!suggest] ` +
        `${A}200+ %% AML patients.`, 0, true),
        'collected from 200+ AML patients.');
    // An addition starting with a space after one.
    assert.equal(r.removeItem(`the protocol. %%[!suggest] ${A} All ` +
        'consented.%%', 0, true), 'the protocol. All consented.');
    // Nothing to tidy: as it was.
    assert.equal(r.removeItem(`a %%{1%%b%%}1 [!suggest] ${A}c%% d.`, 0,
                              true), 'a c d.');
    // Dismissed, the passage is kept as it was, spaces and all.
    assert.equal(r.removeItem('cases %%{5%%respectively%%}5 ' +
        `[!suggest] ${A}%%.`, 0), 'cases respectively.');
});

test('each comment\'s number names which comment it is, though a Google ' +
     'comment on several passages shares one number', () => {
    const g = 'https://docs.google.com/document/d/x/edit?disco=doco.A1';
    const md = `%%{1%%WGS%%}1 [!review] Josh, 2026-10-23: Same. ${g}%% ` +
        `%%{2%%175%%}2 [!suggest] Aly, 2026-10-23: 200%% ` +
        `%%{3%%RNA%%}3 [!review] Josh, 2026-10-23: Same. ${g}%% ` +
        `%%{4%%18%%}4 [!suggest] Aly, 2026-10-23: 51%%`;
    const html = r.renderMarkdown(md);
    const sups = [...html.matchAll(
        /<sup class="([^"]*)">(\d+)<\/sup>/g)].map((m) => [
        (/dendrite-item-(\d+)/.exec(m[1]) || [])[1], m[2]]);
    assert.deepEqual(sups, [['0', '1'], ['1', '2'], ['2', '1'], ['3', '3']]);
});

test('pointing at a comment on a card marks its passages and dims the ' +
     'others, and pointing at a passage marks its comment', () => {
    const g = 'https://docs.google.com/document/d/x/edit?disco=doco.A1';
    const md = `%%{1%%WGS%%}1 [!review] Josh, 2026-10-23: Same. ${g}%% and ` +
        `%%{2%%RNA%%}2 [!review] Josh, 2026-10-23: Same. ${g}%% from ` +
        `%%{3%%18%%}3 [!suggest] Aly, 2026-10-23: 51%% patients.`;
    const { JSDOM } = require('jsdom');
    const doc = new JSDOM('<div id="root"></div>').window.document;
    const root = doc.getElementById('root');
    root.innerHTML = '<p>' + r.renderMarkdown(md) + '</p>';
    r.wrapPassages(root);
    const items = r.reviewItems(md);
    r.decorate(root, items, () => {});
    const notes = [...root.querySelectorAll('.dendrite-review-note')];
    assert.equal(notes.length, 2, "the Google comment once, and Aly's");
    const lit = () => [...root.querySelectorAll('.is-hover')]
        .filter((el) => el.tagName !== 'DIV').map((el) => el.textContent);
    notes[0].dispatchEvent(new doc.defaultView.MouseEvent('mouseenter'));
    assert.ok(root.classList.contains('has-hover'));
    assert.ok(notes[0].classList.contains('is-hover'));
    assert.ok(!notes[1].classList.contains('is-hover'), 'the other dims');
    assert.deepEqual(lit().filter((t) => t === 'WGS' || t === 'RNA'),
                     ['WGS', 'RNA'], 'both its passages');
    notes[0].dispatchEvent(new doc.defaultView.MouseEvent('mouseleave'));
    assert.deepEqual(lit(), []);
    // The other way: Aly's passage pointed at marks her comment.
    const old = root.querySelector('.dendrite-review-old');
    old.dispatchEvent(new doc.defaultView.MouseEvent('mouseenter'));
    assert.ok(notes[1].classList.contains('is-hover'));
    assert.ok(!notes[0].classList.contains('is-hover'));
    old.dispatchEvent(new doc.defaultView.MouseEvent('mouseleave'));
    assert.ok(!root.classList.contains('has-hover'));
});


test('a suggestion applied with its replies kept becomes a comment on ' +
     'its new text, saying what it replaced, with the replies under it',
() => {
    const sug = '%%{1%%will be stored%%}1 [!suggest] Joshua, 2026-10-20: ' +
        'is kept%%';
    const said = '%%[!reply] Claude, 2026-10-27: Drops the consent point.%%';
    const seen = '%%[!reply] Claude, 2026-10-26: %%';
    const md = `Data ${sug}${seen}${said} here.`;
    assert.deepEqual(r.keptReplies(r.reviewItems(md)[0])
        .map((x) => x.text), ['Drops the consent point.'],
    'a seen mark is not a reply to keep');
    assert.equal(r.applyKeeping(md, 0), 'Data %%{1%%is kept%%}1 ' +
        '[!review] Joshua, 2026-10-20: Applied. Was “will be stored”.%%' +
        `${said} here.`);
    assert.equal(r.applyKeeping(`Data ${sug}${seen} here.`, 0),
                 'Data is kept here.', 'only seen: applied as ever');
    const add = `Data%%[!suggest] Joshua, 2026-10-20:  safely%%${said}.`;
    assert.equal(r.applyKeeping(add, 0), 'Data %%{1%%safely%%}1 ' +
        '[!review] Joshua, 2026-10-20: Applied, as an addition.%%' +
        `${said}.`);
    const cut = `Data ${sug.replace(': is kept%%', ': %%')}${said} here.`;
    assert.equal(r.applyKeeping(cut, 0), 'Data%%[!review] Joshua, ' +
        '2026-10-20: Applied. Was “will be stored”.%%' + `${said} here.`,
    'a deletion: the comment where the text was');
});

test('a point in a card\'s drawn text is found in its markdown', () => {
    const md = '## Aims\n\nThe cohort is [[Cohort|175 patients]] ' +
        '%%{a1%%paired%%}a1 [!review] Aly, 2026-10-22: Sure?%% at ' +
        'diagnosis.\n\nThe cohort is large.';
    // The first "cohort", clicked before its "hort".
    assert.equal(r.offsetAt(md, 'Aims The co', 'hort is 175 patients'),
                 md.indexOf('hort'));
    // The second one, told apart by what follows it.
    assert.equal(r.offsetAt(md, 'diagnosis. The co', 'hort is large.'),
                 md.lastIndexOf('hort'));
    // In a comment's passage, and at the very end.
    assert.equal(r.offsetAt(md, '175 patients pai', 'red at'),
                 md.indexOf('red%%}'));
    assert.equal(r.offsetAt(md, 'is large.', ''), md.length);
    assert.equal(r.offsetAt(md, '', ''), null);
    assert.equal(r.offsetAt(md, 'zzzz', 'qqqq'), null);
});

test('the drawn text around a point leaves out what the card adds', () => {
    const { JSDOM } = require('jsdom');
    const doc = new JSDOM('<div id="b"><p>The <mark>cohort</mark><sup ' +
        'class="dendrite-review-n">1</sup> is paired.</p><div ' +
        'class="dendrite-review-notes">Aly: Sure?</div><p>Next.</p>' +
        '</div>').window.document;
    const b = doc.getElementById('b');
    const t = b.querySelector('p').lastChild;
    assert.deepEqual(r.textAround(b, t, 4),
                     { before: 'The cohort is ', after: 'paired. Next.' });
});

test('a comment\'s paragraph ends at a blank line or a new block', () => {
    const md = 'Samples were taken\nacross two timepoints.\n\n- One\n' +
        '- Two\n# Head\nText\n| a | b |\n| c | d |';
    assert.equal(r.paragraphEnd(md, 3), md.indexOf('.\n\n') + 1);
    assert.equal(r.paragraphEnd(md, md.indexOf('One')),
                 md.indexOf('\n- Two'));
    assert.equal(r.paragraphEnd(md, md.indexOf('Text')),
                 md.indexOf('\n| a'));
    assert.equal(r.paragraphEnd(md, md.indexOf('a |')),
                 md.indexOf('\n| c'));
    assert.equal(r.paragraphEnd(md, md.indexOf('c |')), md.length);
});

test('a reply suggesting the writer resolve a comment: written with its ' +
     'mark, read back as one, drawn as one, and the comment\'s Resolve ' +
     'lit until someone replies after it', () => {
    const md = 'The ==cohort==%%[!review] Aly, 2026-10-23: How many?%% is ' +
        'large.';
    const out = r.addReply(md, 0, { author: 'Claude', date: '2026-10-29',
        text: 'Methods now gives 42.', resolve: true });
    assert.match(out, /%%\[!reply\] Claude, 2026-10-29: \[resolve\] Methods/);
    const it = r.reviewItems(out)[0];
    assert.deepEqual(it.replies, [{ author: 'Claude', date: '2026-10-29',
        text: 'Methods now gives 42.', resolve: true }]);
    assert.ok(r.readyToResolve(it));
    const [act] = r.commentActions(it);
    assert.equal(act[0], 'resolve');
    assert.equal(act[3], 'Claude', 'lit, by whom');
    assert.match(act[2], /Claude thinks this is done/);
    const { JSDOM } = require('jsdom');
    const doc = new JSDOM('<div></div>').window.document;
    const row = r.replyRow(doc, it.replies[0]);
    assert.ok(row.classList.contains('is-resolve'));
    assert.match(row.textContent, /suggests resolving/);
    assert.match(row.textContent, /Methods now gives 42\./);
    // With no reason: still a suggestion, not a read mark.
    const bare = r.reviewItems(r.addReply(md, 0, { author: 'Claude',
        date: '2026-10-29', text: '', resolve: true }))[0];
    assert.ok(r.readyToResolve(bare));
    assert.ok(!r.replyRow(doc, bare.replies[0]).classList
        .contains('is-seen'));
    // Answered since: no longer standing.
    const after = r.reviewItems(r.addReply(out, 0, { author: 'Me',
        date: '2026-10-29', text: 'Not yet.' }))[0];
    assert.ok(!r.readyToResolve(after));
    assert.equal(r.commentActions(after)[0][3], undefined);
});

test('a reply being written is never lost to Escape or to its card being ' +
     'drawn again: Escape keeps what was typed, and a redraw puts the box ' +
     'back with it', () => {
    const { JSDOM } = require('jsdom');
    const win = new JSDOM('<div id="root"></div>').window;
    const doc = win.document;
    const md = 'The ==cohort==%%[!review] Aly, 2026-10-23: How many?%% is ' +
        'large.';
    const draw = () => {
        const root = doc.getElementById('root');
        root.innerHTML = `<p>${r.renderMarkdown(md)}</p>`;
        r.decorate(root, r.reviewItems(md), () => {}, null, null, null,
                   null, 'G-aaaaa');
        return root;
    };
    let root = draw();
    const reply = [...root.querySelectorAll('button')]
        .find((b) => b.textContent === 'Reply');
    reply.click();
    const box = () => root.querySelector('.dendrite-review-reply-box');
    box().value = 'Forty-two, in Methods';
    box().dispatchEvent(new win.Event('input'));
    const esc = new win.KeyboardEvent('keydown', { key: 'Escape',
        bubbles: true, cancelable: true });
    box().dispatchEvent(esc);
    assert.ok(esc.defaultPrevented, 'goes no further');
    assert.equal(box() && box().value, 'Forty-two, in Methods',
                 'kept, not thrown away');
    root = draw();
    assert.equal(box() && box().value, 'Forty-two, in Methods',
                 'back after a redraw');
    // Cancel is how a draft is thrown away; then a redraw has none.
    root.querySelector('.dendrite-review-reply-btns button:last-child')
        .click();
    assert.equal(box(), null);
    root = draw();
    assert.equal(box(), null, 'gone for good');
    // An empty box closes on Escape.
    [...root.querySelectorAll('button')]
        .find((b) => b.textContent === 'Reply').click();
    box().dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape',
        bubbles: true, cancelable: true }));
    assert.equal(box(), null);
});

test('a link to a card in a comment or reply, [[o5yps]] or with its own ' +
     'text, is drawn as a link; one to nothing found stays as written',
     () => {
    const { JSDOM } = require('jsdom');
    const doc = new JSDOM('<div></div>').window.document;
    const asked = [];
    const linkOf = (d, target, alias) => {
        asked.push([target, alias]);
        if (target === 'zzzzz') return null;
        const a = d.createElement('a');
        a.className = 'dendrite-card-ref';
        a.textContent = alias || target;
        return a;
    };
    const el = doc.createElement('div');
    r.fillAddressed(el, '@Claude See [[o5yps]], [[14px4|the table]] and ' +
                    '[[zzzzz]].', null, linkOf);
    assert.equal(el.textContent, '@Claude See o5yps, the table and ' +
                 '[[zzzzz]].');
    assert.deepEqual([...el.querySelectorAll('a.dendrite-card-ref')]
        .map((a) => a.textContent), ['o5yps', 'the table']);
    assert.deepEqual(asked, [['o5yps', undefined], ['14px4', 'the table'],
                             ['zzzzz', undefined]]);
    const row = r.replyRow(doc, { author: 'Claude', date: '2026-10-29',
        text: 'Moved to [[o5yps]].' }, null, null, linkOf);
    assert.ok(row.querySelector('a.dendrite-card-ref'));
});

test('a comment\'s thread folds to its first line and a count of its ' +
     'replies, folded or not as it was left, on the board open at first',
     () => {
    const { JSDOM } = require('jsdom');
    const win = new JSDOM('<div id="root"></div>').window;
    const doc = win.document;
    const md = 'The ==cohort==%%[!review] Aly, 2026-10-23: How many are ' +
        'there?%%%%[!reply] Me, 2026-10-24: Forty.%%%%[!reply] Claude, ' +
        '2026-10-24: Say so in Methods.%% is large.';
    const draw = () => {
        const root = doc.getElementById('root');
        root.innerHTML = `<p>${r.renderMarkdown(md)}</p>`;
        r.decorate(root, r.reviewItems(md), () => {}, null, null, null,
                   null, 'G-fold1');
        return root.querySelector('.dendrite-review-note');
    };
    let note = draw();
    assert.ok(!note.classList.contains('is-folded'), 'open on the board');
    const fold = note.querySelector('.dendrite-review-fold');
    assert.ok(fold, 'a fold toggle');
    fold.click();
    assert.ok(note.classList.contains('is-folded'));
    assert.equal(note.querySelector('.dendrite-review-count').textContent,
                 ' · 1 earlier reply');
    const rows = [...note.querySelectorAll('.dendrite-review-reply')];
    assert.deepEqual(rows.map((x) => x.classList.contains('is-latest')),
                     [false, true], 'the latest reply stays in full');
    note = draw();
    assert.ok(note.classList.contains('is-folded'), 'kept when redrawn');
    note.querySelector('.dendrite-review-fold').click();
    assert.ok(!note.classList.contains('is-folded'));
    // Folded at first where asked, as in the card editor.
    const other = doc.createElement('div');
    const it = r.reviewItems(md.replace('How many', 'How big'))[0];
    const meta = doc.createElement('div');
    other.append(meta);
    r.foldable(other, meta, it, true);
    assert.ok(other.classList.contains('is-folded'));
    // A comment with nothing under it and short text has no toggle.
    const bare = doc.createElement('div');
    const bm = doc.createElement('div');
    bare.append(bm);
    r.foldable(bare, bm, r.reviewItems('a ==b==%%[!review] A, ' +
        '2026-10-23: Short.%%')[0], true);
    assert.equal(bare.querySelector('.dendrite-review-fold'), null);
    assert.ok(!bare.classList.contains('is-folded'));
});

test('the same new text suggested for two places, told apart by the text ' +
     'around them, goes in at both; at the same place it is refused',
     () => {
    const md = '| Need | /project (TB) | Total |\n| --- | --- | --- |\n' +
        '| Storage | 55 | 55 |\n';
    const one = r.suggestInto(md, 'G-x', { quote: '55', replace: '84',
        before: 'Storage', after: '55', date: '2026-10-29' });
    assert.ok(one.md, one.reason);
    const two = r.suggestInto(one.md, 'G-x', { quote: '55', replace: '84',
        before: 'Storage 55', date: '2026-10-29' });
    assert.ok(two.md, two.reason);
    assert.equal(r.reviewItems(two.md).length, 2);
    const again = r.suggestInto(two.md, 'G-x', { quote: '55',
        replace: '84', before: 'Storage 55', date: '2026-10-29' });
    assert.equal(again.reason, 'already suggested');
});

test('a new table row is suggested after or before a row named by its ' +
     'first cell, drawn as a number with what it adds in its note, and ' +
     'applied as a line of its own', () => {
    const md = 'Storage.\n\n| Data | Files | TB | Note |\n' +
        '| --- | --- | --- | --- |\n| scDNA | 18 | 1.2 | measured |\n' +
        '| Public datasets | 4 | 3.0 | estimate |\n';
    const s = { row: ['MAESTER raw reads', '18', '1.06', 'measured'],
                before_row: 'Public datasets', date: '2026-10-29' };
    const out = r.suggestInto(md, 'G-x', s);
    assert.ok(out.md, out.reason);
    const lines = out.md.split('\n');
    assert.equal(lines.length, md.split('\n').length, 'no line added yet');
    assert.equal(lines[5], '| Public datasets | 4 | 3.0 | estimate' +
        '%%[!suggest] Claude, 2026-10-29: [row above] MAESTER raw reads ' +
        '\\| 18 \\| 1.06 \\| measured%% |');
    const it = r.reviewItems(out.md)[0];
    assert.deepEqual(r.rowSuggestion(it), { where: 'above',
        cells: ['MAESTER raw reads', '18', '1.06', 'measured'] });
    assert.equal(r.suggestionText(it), 'Suggests adding a row above: ' +
        'MAESTER raw reads | 18 | 1.06 | measured');
    // Drawn as its number only: nothing inline in the cell.
    const html = r.renderMarkdown(out.md);
    assert.doesNotMatch(html, /dendrite-review-new/);
    assert.match(html, /estimate<sup class="dendrite-review-n is-suggest/);
    // Applied: a line of its own above the row; dismissed: as it was.
    assert.equal(r.removeItem(out.md, 0, true), md.replace(
        '| Public datasets', '| MAESTER raw reads | 18 | 1.06 | ' +
        'measured |\n| Public datasets'));
    assert.equal(r.removeItem(out.md, 0), md);
    assert.equal(r.applyKeeping(out.md, 0), r.removeItem(out.md, 0, true));
    // After a row, by its whole printed text.
    const below = r.suggestInto(md, 'G-x', { row: ['a', 'b', 'c', 'd'],
        after_row: 'scDNA | 18 | 1.2 | measured', date: '2026-10-29' });
    assert.ok(below.md, below.reason);
    assert.ok(r.removeItem(below.md, 0, true).includes(
        '| scDNA | 18 | 1.2 | measured |\n| a | b | c | d |\n| Public'));
    // Refused: no such row, the wrong number of cells, sent twice.
    assert.match(r.suggestInto(md, 'G-x', { ...s, before_row: 'Nope' })
        .reason, /no table row/);
    assert.match(r.suggestInto(md, 'G-x', { ...s, row: ['a', 'b'] })
        .reason, /4 columns/);
    assert.equal(r.suggestInto(out.md, 'G-x', s).reason,
                 'already suggested');
});

test('a reviewer\'s own pending suggestion is found by its passage, and ' +
     'its text changed in place or the suggestion taken out; never one ' +
     'replied to or another reviewer\'s', () => {
    const md = 'Storage of ==6.0==%%[!suggest] Claude, 2026-10-28: ' +
        '18.0%% TB and ==54.5==%%[!suggest] Claude, 2026-10-28: 83.1%%' +
        '%%[!reply] Me, 2026-10-29: Why?%% TB, ==55==%%[!suggest] Aly, ' +
        '2026-10-28: 84%% in all.';
    const f = r.findSuggestion(md, { quote: '6.0', author: 'Claude' });
    assert.equal(f.n, 0);
    const out = r.reviseSuggestion(md, f.n, '17.1', '2026-10-29');
    assert.equal(out, md.replace('Claude, 2026-10-28: 18.0',
                                 'Claude, 2026-10-29: 17.1'));
    assert.equal(r.removeItem(md, f.n), md.replace(
        '==6.0==%%[!suggest] Claude, 2026-10-28: 18.0%%', '6.0'));
    assert.match(r.findSuggestion(md, { quote: '54.5', author: 'Claude' })
        .reason, /replied to/);
    assert.match(r.findSuggestion(md, { quote: '55', author: 'Claude' })
        .reason, /no pending suggestion/);
    assert.match(r.findSuggestion(md, { quote: '9.9', author: 'Claude' })
        .reason, /no pending suggestion/);
    // By what it suggests, where the passage alone does not say which.
    const two = 'A ==x==%%[!suggest] Claude, 2026-10-28: y%% and ==x==' +
        '%%[!suggest] Claude, 2026-10-28: z%%.';
    assert.match(r.findSuggestion(two, { quote: 'x', author: 'Claude' })
        .reason, /2 pending/);
    assert.equal(r.findSuggestion(two, { quote: 'x', was: 'z',
                                         author: 'Claude' }).n, 1);
});

test('the card editor leaves a table\'s comments to the table: nothing ' +
     'drawn or held in its rows, where Obsidian edits each cell in an ' +
     'editor of its own, and numbering still counts them', () => {
    const md = '%%{1%%Team%%}1 [!review] Aly, 2026-10-23: Why?%% sizes.\n\n' +
        '| Team | %%{3%%Multiomic Evidence Model%%}3 [!review] Claude, ' +
        '2026-10-29: Use one title.%% | Total |\n| --- | --: | --: |\n' +
        '| Members | 3 | 3 |\n\nAfter ==it==%%[!review] Aly, 2026-10-23: ' +
        'And?%%.';
    const e = r.editorRanges(md);
    const t0 = md.indexOf('| Team');
    const t1 = md.indexOf('\n\nAfter');
    const inside = ([a, b]) => a < t1 && b > t0;
    assert.deepEqual(e.chips.map((c) => c.n), [1, 3],
                     'the table\'s comment keeps its number, 2');
    for (const [k, list] of Object.entries({ hide: e.hide,
        protect: e.protect, chips: e.chips.map((c) => [c.from, c.to]),
        marks: e.marks.map((m) => [m.from, m.to]) })) {
        assert.ok(!list.some(inside), `no ${k} in the table`);
    }
});

test('a card with comments is drawn, and its comments keyed, where there ' +
     'is no Node Buffer, as on a phone', () => {
    const { JSDOM } = require('jsdom');
    const doc = new JSDOM('<div id="root"></div>').window.document;
    const md = 'The ==cohort==%%[!review] Aly, 2026-10-23: How many?%%' +
        '%%[!reply] Me, 2026-10-24: Forty.%%%%[!reply] Claude, ' +
        '2026-10-24: Say so.%% is large.';
    const keys = r.reviewKeys(r.reviewItems(md)[0]);
    const id = r.threadId(r.reviewItems(md)[0]);
    const was = globalThis.Buffer;
    globalThis.Buffer = undefined;
    try {
        const root = doc.getElementById('root');
        root.innerHTML = `<p>${r.renderMarkdown(md)}</p>`;
        r.decorate(root, r.reviewItems(md), () => {}, null, null, null,
                   null, 'G-phone');
        assert.ok(root.querySelector('.dendrite-review-note'));
        assert.deepEqual(r.reviewKeys(r.reviewItems(md)[0]), keys,
                         'the same keys as with Buffer');
        assert.equal(r.threadId(r.reviewItems(md)[0]), id);
    } finally {
        globalThis.Buffer = was;
    }
});

test('the comment list\'s filter: who wrote a comment, whose answer it ' +
     'waits for, and whether it is a comment or a suggestion', () => {
    const md = 'A ==one==%%[!review] Aly, 2026-10-23: Why?%% then ' +
        '==two==%%[!review] Aly, 2026-10-23: How?%%%%[!reply] Me, ' +
        '2026-10-24: Like so.%% then ==three==%%[!review] Me, ' +
        '2026-10-24: @Claude is this right?%% then ==four==%%[!review] ' +
        'Claude, 2026-10-24: Cite it.%%%%[!reply] Claude, 2026-10-25: ' +
        '[resolve] Done.%% and ==old==%%[!suggest] Aly, 2026-10-23: new%%.';
    const items = r.reviewItems(md);
    const self = new Set(['Derek', 'Me']);
    const pick = (f) => items.map((it, k) => k)
        .filter((k) => r.passesFilter(items[k], f, self));
    assert.deepEqual(pick({}), [0, 1, 2, 3, 4], 'no filter: all');
    assert.deepEqual(pick(null), [0, 1, 2, 3, 4]);
    assert.deepEqual(pick({ author: 'Aly' }), [0, 1, 4]);
    assert.deepEqual(pick({ author: 'me' }), [2]);
    assert.deepEqual(pick({ waiting: 'me' }), [0, 3, 4],
                     'someone else has the last word');
    assert.deepEqual(pick({ waiting: 'Claude' }), [2]);
    assert.deepEqual(pick({ waiting: 'resolve' }), [3]);
    assert.deepEqual(pick({ kind: 'suggest' }), [4]);
    assert.deepEqual(pick({ kind: 'comment', author: 'Aly' }), [0, 1]);
});

test('the preview draws only the comments a filter keeps, the rest as ' +
     'plain text, numbered from one, each still named by its index', () => {
    const md = 'A ==one==%%[!review] Aly, 2026-10-23: Why?%% then ' +
        '==old==%%[!suggest] R, 2026-10-24: new%% and %%{1%%held%%}1 ' +
        '[!review] R, 2026-10-24: Here.%% end.';
    const html = r.renderMarkdown(md, null, (k) => k === 2);
    assert.equal(html, 'A one then old and <span class="dendrite-review-' +
        'from dendrite-rid-1"></span>held<span class="dendrite-review-upto' +
        ' dendrite-rid-1"></span><sup class="dendrite-review-n ' +
        'dendrite-rid-1 dendrite-item-2">1</sup> end.');
    assert.equal(r.renderMarkdown(md, null, () => false),
                 'A one then old and held end.');
    assert.equal(r.renderMarkdown(md, null, () => true),
                 r.renderMarkdown(md), 'all kept: as without a filter');
});
