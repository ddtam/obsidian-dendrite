// A reply in the reviewer's own Word file: replies under their comments,
// those dealt with resolved, and the text brought to the cards', tracked
// or written directly, the rest of their file left as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
require('./harness.cjs');
const wr = require('../src/wordreply.js');
const docx = require('../src/docx.js');
const wt = require('../src/wordtemplate.js');
const review = require('../src/review.js');
const main = require('../src/main.js');

const run = (t, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}` +
    `<w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (...runs) => `<w:p>${runs.join('')}</w:p>`;
const styled = (style, ...runs) => '<w:p><w:pPr><w:pStyle ' +
    `w:val="${style}"/></w:pPr>${runs.join('')}</w:p>`;
const cell = (...ps) => `<w:tc>${ps.join('')}</w:tc>`;
const table = (...rows) => '<w:tbl>' + rows.map((r) =>
    `<w:tr>${r.join('')}</w:tr>`).join('') + '</w:tbl>';
const doc = (...blocks) => '<w:document xmlns:w="w" xmlns:r="r">' +
    `<w:body>${blocks.join('')}</w:body></w:document>`;
const TYPES = '<Types><Override PartName="/word/document.xml"/></Types>';
const RELS = '<Relationships><Relationship Id="rId1" Type="x" ' +
    'Target="styles.xml"/></Relationships>';
const STYLES = '<w:styles><w:style w:styleId="Bibliography"/></w:styles>';

/** A .docx of `parts`, a map of name to XML. */
function file(parts) {
    const all = Object.assign({ '[Content_Types].xml': TYPES,
                                'word/_rels/document.xml.rels': RELS,
                                'word/styles.xml': STYLES }, parts);
    return docx.writeZip(Object.entries(all).map(([name, x]) =>
        ({ name, data: Buffer.from(x, 'utf8') })), zlib);
}

const read = (buf) => new Map(docx.readZip(buf, zlib)
    .map((f) => [f.name, f.data.toString('utf8')]));

/** Paragraph texts of a document, its tracked changes accepted. */
const accepted = (xml) => wr.paragraphs(wt.settled(xml))
    .map((p) => p.text).filter((t) => t.trim());

/** That `xml` holds the text of `parts`, joined, as it is. */
const has = (xml, ...parts) => assert.ok(xml.includes(parts.join('')),
                                         parts.join(''));

const TRACKED = { tracked: true, author: 'Derek Tam',
                  date: '2026-11-03T00:00:00Z' };

/** The reply's document, `theirs` and `fresh` documents' blocks. */
function replied(theirs, fresh, opts = TRACKED) {
    const r = wr.replyDocx(file({ 'word/document.xml': doc(...theirs) }),
                           file({ 'word/document.xml': doc(...fresh) }),
                           new Map(), opts, zlib);
    return { xml: read(r.buf).get('word/document.xml'), report: r.report };
}

test('edits are made a word at a time, punctuation with its word', () => {
    assert.deepEqual(wr.edits('the cat sat', 'the dog sat'),
                     [{ s: 4, e: 7, insert: 'dog' }]);
    assert.deepEqual(wr.edits('computational projects (CAD)',
                              'computational project(s)'),
                     [{ s: 14, e: 28, insert: 'project(s)' }]);
    assert.deepEqual(wr.edits('same', 'same'), []);
});

test('a changed paragraph is tracked in its own runs, formatting kept',
     () => {
    const { xml, report } = replied(
        [para(run('Storage will be managed '),
              run('designated data guardian,', '<w:b/>'),
              run(' Joshua Bridgers.'))],
        [para(run('Storage will be managed by Joshua Bridgers.'))]);
    assert.equal(report.changed, 1);
    assert.deepEqual(report.changes.map((c) => [c.kind, c.edits]),
                     [['changed', [{ s: 24, e: 49, insert: 'by' }]]]);
    has(xml, ' w:author="Derek Tam" w:date="2026-11-03T00:00:00Z">',
        '<w:r><w:rPr><w:b/></w:rPr><w:delText xml:space="preserve">',
        'designated data guardian,</w:delText>');
    assert.match(xml, /<w:del w:id="\d+" w:author="Derek Tam"/);
    has(xml, '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">by</w:t>');
    assert.match(xml, /<w:ins w:id="\d+" w:author="Derek Tam"/);
    assert.deepEqual(accepted(xml),
                     ['Storage will be managed by Joshua Bridgers.']);
});

test('written directly, the text is changed with no marks', () => {
    const { xml } = replied(
        [para(run('Storage will be managed '),
              run('designated data guardian,', '<w:b/>'),
              run(' Joshua Bridgers.'))],
        [para(run('Storage will be managed by Joshua Bridgers.'))],
        { tracked: false });
    assert.doesNotMatch(xml, /<w:(ins|del)\b/);
    assert.deepEqual(accepted(xml),
                     ['Storage will be managed by Joshua Bridgers.']);
});

test('their paragraph settings and untouched runs stay as they were', () => {
    const theirs = '<w:p w:rsidR="1"><w:pPr><w:spacing w:after="240"/>' +
        '</w:pPr><w:r w:rsidR="2"><w:t>Kept as is.</w:t></w:r>' +
        '<w:r><w:t xml:space="preserve"> Old end.</w:t></w:r></w:p>';
    const { xml } = replied([theirs],
                            [para(run('Kept as is. New end.'))]);
    assert.match(xml, /<w:p w:rsidR="1"><w:pPr><w:spacing w:after="240"\/>/);
    assert.match(xml, /<w:r w:rsidR="2"><w:t>Kept as is.<\/w:t><\/w:r>/);
});

test('a paragraph their file split in two, same words, is left', () => {
    const { xml, report } = replied(
        [para(run('CPU ')), para(run('(core-years)')), para(run('Next.'))],
        [para(run('CPU (core-years)')), para(run('Next.'))]);
    assert.equal(report.changed + report.removed + report.added, 0);
    assert.match(xml, /\(core-years\)/);
});

test('two like cells side by side are paired in order', () => {
    const row = (a, b) => [cell(para(run(a))), cell(para(run(b)))];
    const { xml, report } = replied(
        [table(row('Award', 'Portion'), row('$200,000', '$200,000'))],
        [table(row('Award', 'Portion'),
               row('CAD $200,000', 'CAD $200,000'))]);
    assert.equal(report.changed, 2);
    assert.equal(report.left.length, 0);
    assert.deepEqual(accepted(xml), ['Award', 'Portion', 'CAD $200,000',
                                     'CAD $200,000']);
});

test('a moved paragraph is left where the reviewer has it', () => {
    const { xml, report } = replied(
        [para(run('One.')), para(run('Moved.')), para(run('Two.'))],
        [para(run('One.')), para(run('Two.')), para(run('Moved.'))]);
    assert.equal(report.changed + report.removed + report.added, 0);
    assert.deepEqual(accepted(xml), ['One.', 'Moved.', 'Two.']);
});

test('a new paragraph goes in after the one before it, set as that is',
     () => {
    const { xml, report } = replied(
        [styled('Bibliography', run('1.\tAuthor A. Title.')),
         styled('Bibliography', run('2.\tAuthor C. Title.'))],
        [para(run('1.\tAuthor A. Title.')),
         para(run('2.\tAuthor B. New.')),
         para(run('3.\tAuthor C. Title.'))]);
    assert.equal(report.added, 1);
    assert.deepEqual(accepted(xml), ['1.\tAuthor A. Title.',
                                     '2.\tAuthor B. New.',
                                     '3.\tAuthor C. Title.']);
    assert.match(xml, new RegExp('<w:p><w:pPr><w:pStyle ' +
        'w:val="Bibliography"/><w:rPr><w:ins [^>]*/></w:rPr></w:pPr><w:ins '));
});

test('a paragraph gone from the cards is taken out, its mark too', () => {
    const { xml, report } = replied(
        [para(run('Keep.')), para(run('Drop this one.')),
         para(run('Also keep.'))],
        [para(run('Keep.')), para(run('Also keep.'))]);
    assert.equal(report.removed, 1);
    assert.deepEqual(report.changes, [{ kind: 'removed',
        was: 'Drop this one.', now: '',
        edits: [{ s: 0, e: 14, insert: '' }] }]);
    has(xml, '<w:delText xml:space="preserve">Drop this one.</w:delText>');
    assert.match(xml, /<w:pPr><w:rPr><w:del [^>]*\/><\/w:rPr><\/w:pPr>/);
    assert.deepEqual(accepted(xml), ['Keep.', 'Also keep.']);
});

test('what cannot be carried is said, not dropped', () => {
    const field = '<w:p>' + run('As in Table ') +
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText>SEQ Table</w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        '<w:r><w:t>4</w:t><w:fldChar w:fldCharType="end"/></w:r>' +
        run(' below.') + '</w:p>';
    const pending = '<w:p>' + run('The cohort is ') +
        '<w:ins w:id="1" w:author="Josh"><w:r><w:t>large and </w:t></w:r>' +
        '</w:ins>' + run('paired.') + '</w:p>';
    const { report } = replied(
        [field, pending, table([cell(para(run('A')))])],
        [para(run('As in Table 5 below.')),
         para(run('The cohort is large, paired.')),
         table([cell(para(run('A')))], [cell(para(run('New row')))])]);
    const why = report.left.map((x) => x.why).join(' | ');
    assert.match(why, /a field, a note or a picture/);
    assert.match(why, /tracked changes not yet accepted/);
    assert.match(why, /new text in a table/);
});

// A reviewer's comment on "known results", as Word writes one.
const COMMENTED = doc(para(
    run('We recover '), '<w:commentRangeStart w:id="1"/>',
    run('known results'), '<w:commentRangeEnd w:id="1"/>',
    '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>' +
    '<w:commentReference w:id="1"/></w:r>', run(' in two screens.')));
const COMMENTS = '<w:comments xmlns:w="w" xmlns:w14="w14">' +
    '<w:comment w:id="1" w:author="Josh Bridgers" ' +
    'w:date="2026-11-03T12:00:00Z">' +
    '<w:p w14:paraId="11111111"><w:r><w:t>Correct?</w:t></w:r></w:p>' +
    '</w:comment></w:comments>';
const EXT = '<w15:commentsEx xmlns:w15="w15"><w15:commentEx ' +
    'w15:paraId="11111111" w15:done="0"/></w15:commentsEx>';

test('a reply goes in under its comment, threaded, and resolves it', () => {
    const theirs = file({ 'word/document.xml': COMMENTED,
                          'word/comments.xml': COMMENTS,
                          'word/commentsExtended.xml': EXT });
    const answers = new Map([['1', { done: true, replies: [
        { author: 'Derek Tam', date: '2026-11-03', text: 'Yes, both.' }] }]]);
    const r = wr.replyDocx(theirs, null, answers, TRACKED, zlib);
    assert.deepEqual([r.report.replies, r.report.resolved], [1, 1]);
    const out = read(r.buf);
    const cs = wr.comments(out);
    assert.equal(cs.length, 2);
    assert.deepEqual([cs[1].author, cs[1].text, cs[1].parent],
                     ['Derek Tam', 'Yes, both.', '1']);
    assert.equal(cs[0].done, true);
    const d = out.get('word/document.xml');
    has(d, '<w:commentRangeStart w:id="1"/><w:commentRangeStart w:id="2"/>');
    has(d, '<w:commentRangeEnd w:id="1"/><w:commentRangeEnd w:id="2"/>');
    has(d, '<w:commentReference w:id="1"/></w:r><w:r><w:rPr><w:rStyle ',
        'w:val="CommentReference"/></w:rPr><w:commentReference w:id="2"/>');
    // Read back as the import reads it: the reply on the same passage.
    const items = review.readReview(r.buf, zlib);
    assert.deepEqual(items.map((x) => [x.author, x.text, x.quote]),
                     [['Josh Bridgers', 'Correct?', 'known results'],
                      ['Derek Tam', 'Yes, both.', 'known results']]);
    // Sent again, the reply already there is not added twice.
    const again = wr.replyDocx(r.buf, null, answers, TRACKED, zlib);
    assert.equal(again.report.replies, 0);
});

test('a file without threads gains them, registered', () => {
    const theirs = file({ 'word/document.xml': COMMENTED,
                          'word/comments.xml': COMMENTS.replace(
                              ' w14:paraId="11111111"', '') });
    const r = wr.replyDocx(theirs, null, new Map([['1', { done: false,
        replies: [{ author: 'Me', date: '2026-11-03', text: 'Yes.' }] }]]),
                           TRACKED, zlib);
    const out = read(r.buf);
    assert.match(out.get('[Content_Types].xml'),
                 /PartName="\/word\/commentsExtended.xml"/);
    assert.match(out.get('word/_rels/document.xml.rels'),
                 /Target="commentsExtended.xml"/);
    const cs = wr.comments(out);
    assert.ok(cs[0].paraId);
    assert.equal(cs[1].parent, '1');
});

test('replies for the reviewer: not Claude\'s, nor addressed elsewhere',
     () => {
    const comments = [{ id: '1', author: 'Josh Bridgers', text: 'Correct?' },
                      { id: '2', author: 'Josh Bridgers', text: 'Update.' },
                      { id: '3', author: 'Josh Bridgers', text: 'Unknown.' }];
    review.learnNames(['Josh Bridgers']);
    const open = [{ kind: 'review', author: 'Josh Bridgers',
                    text: 'Correct?', replies: [
                        { author: 'Claude', date: 'd', text: 'Looks right.' },
                        { author: 'Me', date: 'd', text: '@Claude check' },
                        { author: 'Me', date: 'd',
                          text: '@Josh Bridgers Yes, both.' },
                        { author: 'Me', date: 'd', text: 'Fixed.' }] }];
    const log = [{ action: 'resolve', keys: review.reviewKeys({
        kind: 'comment', author: 'Josh Bridgers', text: 'Update.' }),
                   replies: [{ author: 'Derek Tam', date: 'd',
                               text: 'Updated.' }] }];
    const a = main.wordWriteAnswers(comments, open, log, 'Derek Tam',
                                    new Set(['Me', 'Derek Tam']));
    assert.deepEqual(a.get('1'), { done: false, replies: [
        { author: 'Derek Tam', date: 'd', text: 'Yes, both.' },
        { author: 'Derek Tam', date: 'd', text: 'Fixed.' }] });
    assert.deepEqual(a.get('2'), { done: true, replies: [
        { author: 'Derek Tam', date: 'd', text: 'Updated.' }] });
    assert.equal(a.has('3'), false);
});

// Who last saved a file, as Word records it.
const CORE = '<cp:coreProperties><cp:lastModifiedBy>Josh Bridgers' +
    '</cp:lastModifiedBy><dcterms:modified>2026-11-03T20:25:00Z' +
    '</dcterms:modified></cp:coreProperties>';

test('edits made without tracking are found against what was sent, ' +
     'the reviewer\'s tracked ones and the writer\'s own set aside', () => {
    const sent = file({ 'word/document.xml': doc(
        para(run('Storage will be managed by Joshua Bridgers.')),
        para(run('Two perturbation screens and our data.')),
        para(run('Kept '), '<w:ins w:id="1" w:author="Derek Tam">',
             run('as I wrote it.'), '</w:ins>'),
        table([cell(para(run('CPU (core-years)')))])) });
    const back = file({ 'docProps/core.xml': CORE,
        'word/document.xml': doc(
            para(run('Storage will be managed designated data guardian, ' +
                     'Joshua Bridgers.')),
            para(run('Two perturbation screens '),
                 '<w:ins w:id="2" w:author="Josh Bridgers">',
                 run('(tracked) '), '</w:ins>', run('and our data.')),
            para(run('Kept '), '<w:ins w:id="1" w:author="Derek Tam">',
                 run('as I wrote it.'), '</w:ins>'),
            table([cell(para(run('CPU ')), para(run('(core-years)')))]),
            para(run('A paragraph of his own.'))) });
    const was = wr.sentText(sent, ['Derek Tam'], zlib);
    const items = wr.untrackedItems(back, was, zlib);
    assert.deepEqual(items.map((x) => [x.author, x.date, x.quote, x.insert,
                                       x.before, x.untracked]), [
        ['Josh Bridgers', '2026-11-03', 'by ',
         'designated data guardian, ', 'Storage will be managed ', true],
        ['Josh Bridgers', '2026-11-03', '', '¶ A paragraph of his own.',
         'CPU (core-years)', true]]);
    // Read as sent, the two share the paragraphs left as they were.
    assert.equal(wr.overlap(was, wr.sentText(back, ['Derek Tam'], zlib)),
                 2);
});
