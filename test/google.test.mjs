// Tests for Google Docs review: the client file, signing in through the
// browser, Google's picker page, and reading a doc's comments and
// suggested changes. Google is stood in for; the browser is a fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const g = require('../src/google.js');
const http = require('http');
const crypto = require('crypto');

const CLIENT = g.readClient(JSON.stringify({ installed: {
    client_id: '9519-abc.apps.googleusercontent.com',
    client_secret: 's3cret', redirect_uris: ['http://localhost'],
    token_uri: 'https://oauth2.example/token',
    auth_uri: 'https://accounts.example/auth' } }));

test('the client file and a doc URL are read', () => {
    assert.equal(CLIENT.clientId, '9519-abc.apps.googleusercontent.com');
    assert.equal(CLIENT.projectNumber, '9519');
    assert.throws(() => g.readClient('{}'), /not an OAuth client/);
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789';
    assert.equal(g.docIdFromUrl(
        `https://docs.google.com/document/d/${id}/edit?tab=t.0`), id);
    assert.equal(g.docIdFromUrl(id), id);
    assert.equal(g.docIdFromUrl('https://example.com/x'), null);
    assert.equal(g.docUrl(id),
                 `https://docs.google.com/document/d/${id}/edit`);
});

test('signing in takes the code the browser brings back, with its ' +
     'state, and trades it for a token with the PKCE verifier',
     async () => {
    const asked = [];
    let opened = null;
    const request = async (req) => {
        asked.push(req);
        return { status: 200, json: { refresh_token: 'R', access_token: 'A',
                                      expires_in: 3600 } };
    };
    const openUrl = (url) => {
        opened = new URL(url);
        const back = opened.searchParams.get('redirect_uri');
        const state = opened.searchParams.get('state');
        // A page that did not start the sign-in is turned away first.
        fetch(`${back}/?code=nope&state=wrong`).then(() =>
            fetch(`${back}/?code=C0DE&state=${state}`));
    };
    const tok = await g.signIn({ client: CLIENT, request, openUrl, http,
                                 crypto, now: () => 1000 });
    assert.deepEqual(tok, { refresh_token: 'R', access_token: 'A',
                            expires_at: 1000 + 3600 * 1000 });
    assert.equal(opened.origin + opened.pathname,
                 'https://accounts.example/auth');
    assert.equal(opened.searchParams.get('scope'), g.SCOPE);
    assert.equal(opened.searchParams.get('access_type'), 'offline');
    assert.match(opened.searchParams.get('redirect_uri'),
                 /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(asked.length, 1);
    const body = new URLSearchParams(asked[0].body);
    assert.equal(body.get('code'), 'C0DE');
    assert.equal(body.get('grant_type'), 'authorization_code');
    const challenge = crypto.createHash('sha256')
        .update(body.get('code_verifier')).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(challenge, opened.searchParams.get('code_challenge'));
});

test('an access token is reused until near its end, then refreshed and ' +
     'kept; a refused refresh asks for signing in again', async () => {
    let calls = 0;
    const saved = [];
    const ok = async () => {
        calls++;
        return { status: 200, json: { access_token: 'A2',
                                      expires_in: 3600 } };
    };
    const save = async (t) => { saved.push(t); };
    const tok = { refresh_token: 'R', access_token: 'A1',
                  expires_at: 10 * 60000 };
    assert.equal(await g.accessToken({ client: CLIENT, tok, request: ok,
        save, now: () => 0 }), 'A1');
    assert.equal(calls, 0);
    assert.equal(await g.accessToken({ client: CLIENT, tok, request: ok,
        save, now: () => 10 * 60000 - 30000 }), 'A2');
    assert.equal(saved[0].refresh_token, 'R', 'the refresh token is kept');
    const refused = async () => ({ status: 400,
                                   json: { error: 'invalid_grant' } });
    await assert.rejects(g.accessToken({ client: CLIENT, tok: { ...tok,
        expires_at: 0 }, request: refused, save }), (e) => e.signIn &&
        /sign in again \(invalid_grant\)/.test(e.message));
    await assert.rejects(g.accessToken({ client: CLIENT, tok: null,
        request: ok, save }), (e) => e.signIn);
});

test('the picker page is served at a secret path with the token, key ' +
     'and project, and the doc picked there comes back', async () => {
    let page = '';
    const openUrl = async (url) => {
        page = await (await fetch(url)).text();
        const u = new URL(url);
        assert.equal((await fetch(`${u.origin}/picked?id=x`)).status, 404,
                     'not without the secret path');
        // What the picker says on the way is passed on as it happens.
        await fetch(`${url}/event?what=loaded`);
        await fetch(`${url}/event?what=${encodeURIComponent(
            'error: The API developer key is invalid.')}`);
        await fetch(`${url}/picked?id=DOC1&name=${encodeURIComponent(
            'RAC draft')}`);
    };
    const events = [];
    let base = '';
    const opened = (url) => {
        base = new URL(url).origin;
        return openUrl(url);
    };
    const got = await g.pick({ token: 'A', apiKey: 'K', client: CLIENT,
                               openUrl: opened, http, crypto, port: 27199,
                               onEvent: (e) => events.push(e) });
    assert.equal(base, 'http://localhost:27199',
                 'served from the one origin registered with Google');
    assert.deepEqual(got, { id: 'DOC1', name: 'RAC draft' });
    assert.deepEqual(events, ['loaded', 'error: The API developer key ' +
                              'is invalid.']);
    assert.match(page, /"token":"A"/);
    assert.match(page, /"key":"K"/);
    assert.match(page, /"app":"9519"/);
    assert.match(page, /apis\.google\.com\/js\/api\.js/);
    assert.match(page, /\/event\?what=/, 'the page reports what happens');
    assert.match(page, /setOrigin\(O\.origin\)/);
    assert.match(page, /"origin":"http:\/\/localhost:27199"/);
    assert.match(page, /Select/, 'and says to press Select');
    const cancelled = await g.pick({ token: 'A', apiKey: 'K',
        client: CLIENT, http, crypto, port: 0,
        openUrl: (url) => { fetch(`${url}/cancel`); } });
    assert.equal(cancelled, null);
});

const run = (content, ins = [], del = []) => ({ textRun: { content,
    suggestedInsertionIds: ins, suggestedDeletionIds: del } });

test('suggested changes come out with what they take out and put in, ' +
     'and the text around them as it stands', () => {
    const doc = { body: { content: [
        { paragraph: { elements: [
            run('Samples were collected '),
            run('between 2014 and 2023', [], ['s1']),
            run('from 2014 to 2023', ['s1']),
            run(' under the protocol.'),
            run(' All consented.', ['s2']),
            run('\n')] } },
        { table: { tableRows: [{ tableCells: [{ content: [
            { paragraph: { elements: [run('Total', [], ['s3']),
                                      run('\n')] } }] }] }] } }] } };
    assert.deepEqual(g.suggestionItems(doc, '2026-10-24'), [
        { kind: 'change', author: 'Google Docs suggestion',
          date: '2026-10-24', quote: 'between 2014 and 2023',
          insert: 'from 2014 to 2023', before: 'Samples were collected ',
          after: ' under the protocol.' },
        { kind: 'change', author: 'Google Docs suggestion',
          date: '2026-10-24', quote: '', insert: ' All consented.',
          before: ('Samples were collected between 2014 and 2023 ' +
                   'under the protocol.').slice(-40),
          after: '' },
        { kind: 'change', author: 'Google Docs suggestion',
          date: '2026-10-24', quote: 'Total', insert: '', before: '',
          after: '' }]);
});

test('open comments come out with their replies and passage; resolved ' +
     'and deleted ones do not', () => {
    const items = g.commentItems([
        { id: 'AAA1', content: 'How many?',
          createdTime: '2026-10-24T09:00:00Z',
          author: { displayName: 'Aly Karsan' },
          quotedFileContent: { value: 'patients&#39; marrow &amp; blood' },
          replies: [{ content: 'Will add.', author: { displayName: 'Derek' } },
                    { content: 'gone', deleted: true }] },
        { content: 'Done', resolved: true },
        { content: 'Removed', deleted: true }], 'D1');
    assert.deepEqual(items, [{ kind: 'comment', author: 'Aly Karsan',
        date: '2026-10-24', text: 'How many? Reply from Derek: Will add.',
        quote: 'patients\' marrow & blood', before: '', after: '',
        gid: 'AAA1', link: 'https://docs.google.com/document/d/D1/edit' +
            '?disco=AAA1' }]);
});

test('a doc\'s review is its comments, every page, then its suggested ' +
     'changes', async () => {
    const urls = [];
    const request = async ({ url, headers }) => {
        urls.push(url);
        assert.equal(headers.Authorization, 'Bearer T');
        if (/files\/D\?fields=/.test(url)) {
            return { status: 200, json: { name: 'RAC draft',
                mimeType: 'application/vnd.google-apps.document' } };
        }
        if (url.includes('docs.googleapis.com')) {
            return { status: 200, json: { title: 'RAC draft', body: {
                content: [{ paragraph: { elements: [run('a '),
                    run('b', ['s1']), run('\n')] } }] } } };
        }
        if (!url.includes('pageToken')) {
            return { status: 200, json: { nextPageToken: 'P2', comments: [
                { content: 'One', quotedFileContent: { value: 'a' } },
                { content: 'Old', resolved: true }] } };
        }
        return { status: 200, json: { comments: [{ content: 'Two' }] } };
    };
    const r = await g.fetchReview({ docId: 'D', token: 'T', request,
                                    today: new Date('2026-10-24') });
    assert.equal(r.title, 'RAC draft');
    assert.equal(r.resolved, 1);
    assert.deepEqual(r.items.map((x) => [x.kind, x.text || x.insert]),
                     [['comment', 'One'], ['comment', 'Two'],
                      ['change', 'b']]);
    assert.ok(urls.some((u) => /suggestionsViewMode=SUGGESTIONS_INLINE/
        .test(u)));
    const missing = async () => ({ status: 404, json: { error: {
        message: 'File not found' } } });
    await assert.rejects(g.fetchReview({ docId: 'D', token: 'T',
        request: missing }), /404: File not found/);
});

test('a second try at the picker closes the first, which wanted the same ' +
     'port', async () => {
    const first = g.pick({ token: 'A', apiKey: 'K', client: CLIENT, http,
                           crypto, port: 27198, openUrl: () => {} });
    await new Promise((r) => setTimeout(r, 30));
    const second = g.pick({ token: 'A', apiKey: 'K', client: CLIENT, http,
        crypto, port: 27198,
        openUrl: (url) => { fetch(`${url}/picked?id=D2&name=N`); } });
    await assert.rejects(first, /replaced by a new try/);
    assert.deepEqual(await second, { id: 'D2', name: 'N' });
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/' +
    '2006/main"';
const wrun = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;

/** A .docx with one comment and one tracked change, as Word saves it. */
function wordFile() {
    const d = require('../src/docx.js');
    const body = '<w:p>' + wrun('The cohort is ') +
        '<w:commentRangeStart w:id="0"/>' + wrun('paired') +
        '<w:commentRangeEnd w:id="0"/>' +
        '<w:r><w:commentReference w:id="0"/></w:r>' + wrun(' and ') +
        '<w:ins w:id="5" w:author="Aly Karsan" ' +
        'w:date="2026-10-24T10:00:00Z">' + wrun('large') + '</w:ins>' +
        wrun('.') + '</w:p>';
    const comments = `<w:comments ${W}><w:comment w:id="0" ` +
        'w:author="Aly Karsan" w:date="2026-10-24T09:00:00Z"><w:p>' +
        wrun('How many?') + '</w:p></w:comment></w:comments>';
    return d.writeZip([
        { name: 'word/document.xml', data: Buffer.from(
            `<w:document ${W}><w:body>${body}</w:body></w:document>`) },
        { name: 'word/comments.xml', data: Buffer.from(comments) }],
        require('zlib'));
}

test('a Word file in Drive is downloaded and read as a returned Word ' +
     'file, with Drive comments not already in it', async () => {
    const urls = [];
    const file = wordFile();
    const request = async ({ url, binary }) => {
        urls.push(url);
        if (/\?fields=name/.test(url)) {
            return { status: 200, json: { name: 'RAC 2027.docx',
                mimeType: 'application/vnd.openxmlformats-officedocument.' +
                    'wordprocessingml.document' } };
        }
        if (/alt=media/.test(url)) {
            assert.equal(binary, true);
            return { status: 200, buffer: file.buffer.slice(
                file.byteOffset, file.byteOffset + file.byteLength) };
        }
        return { status: 200, json: { comments: [
            { id: 'W1', content: 'How many?',
              author: { displayName: 'Aly Karsan' },
              quotedFileContent: { value: 'paired' } },
            { content: 'Only in Drive.', author: { displayName: 'R' },
              quotedFileContent: { value: 'cohort' } }] } };
    };
    const r = await g.fetchReview({ docId: 'D', token: 'T', request,
                                    zlib: require('zlib') });
    assert.equal(r.title, 'RAC 2027.docx');
    assert.ok(!urls.some((u) => u.includes('docs.googleapis.com')),
              'the Docs API is not asked about a Word file');
    assert.deepEqual(r.items.map((x) => [x.kind, x.author,
                                         x.text || x.insert]),
                     [['comment', 'Aly Karsan', 'How many?'],
                      ['change', 'Aly Karsan', 'large'],
                      ['comment', 'R', 'Only in Drive.']]);
    assert.equal(r.items[0].gid, 'W1',
                 'the file\'s comment takes the Drive comment\'s link');
    assert.match(r.items[0].link, /disco=W1$/);
    const pdf = async ({ url }) => (/\?fields=name/.test(url) ?
        { status: 200, json: { name: 'x.pdf',
                               mimeType: 'application/pdf' } } :
        { status: 200, json: { comments: [] } });
    await assert.rejects(g.fetchReview({ docId: 'D', token: 'T',
        request: pdf, zlib: require('zlib') }),
        /x\.pdf is not a Google Doc or a Word file/);
});
