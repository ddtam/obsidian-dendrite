'use strict';
// Google Docs for review: signing in as the user, choosing a doc with
// Google's file picker, and reading the doc's comments and suggested
// changes as review items. Desktop only. Every request goes from this
// computer to Google, with the `drive.file` permission, which reaches
// only files the user picked or Dendrite created.
//
// `request({ url, method, headers, body, contentType })` answers
// { status, json }; `openUrl(url)` opens the system browser.

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DOCS = 'https://docs.googleapis.com/v1/documents/';
const DRIVE = 'https://www.googleapis.com/drive/v3/files/';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const WAIT_MS = 10 * 60 * 1000;
// Where the picker page is served: Google grants a picked file only to
// a page from an origin registered on the Cloud project, and a
// registered origin names its port.
const PICKER_PORT = 27131;
const pickerOrigin = (port) => `http://localhost:${port}`;

/** The OAuth client from the JSON file Google Cloud gives. */
function readClient(text) {
    const d = JSON.parse(text);
    const c = d.installed || d.web;
    if (!c || !c.client_id) throw new Error('not an OAuth client file');
    return { clientId: c.client_id, clientSecret: c.client_secret || '',
             authUri: c.auth_uri || 'https://accounts.google.com/o/oauth2/auth',
             tokenUri: c.token_uri || 'https://oauth2.googleapis.com/token',
             // The number a client id starts with is its project's,
             // which the picker needs to grant the file to this app.
             projectNumber: c.client_id.split('-')[0] };
}

/** A doc's id from its URL, or the id itself. */
function docIdFromUrl(url) {
    const s = String(url || '').trim();
    const m = /\/document\/d\/([\w-]+)/.exec(s);
    if (m) return m[1];
    return /^[\w-]{20,}$/.test(s) ? s : null;
}

const docUrl = (id) => `https://docs.google.com/document/d/${id}/edit`;

function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
        .replace(/=+$/, '');
}

function pkce(crypto) {
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256')
        .update(verifier).digest());
    return { verifier, challenge };
}

function form(obj) {
    return Object.entries(obj).map(([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/**
 * A server on 127.0.0.1 for one exchange with the browser: `route(url,
 * res)` answers each request and returns a value to finish with, or
 * undefined to keep waiting. Resolves with { base, done }.
 */
function loopback(http, route, port = 0) {
    return new Promise((resolve, reject) => {
        let finish;
        let fail;
        const done = new Promise((y, n) => {
            finish = y;
            fail = n;
        });
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://127.0.0.1');
            let out;
            try {
                out = route(url, res);
            } catch (err) {
                res.writeHead(400, { 'content-type': 'text/plain' });
                res.end(String(err.message));
                return;
            }
            if (out !== undefined) finish(out);
        });
        const timer = setTimeout(() => fail(new Error(
            'no answer from the browser within 10 minutes')), WAIT_MS);
        if (timer.unref) timer.unref();
        done.then(() => {}, () => {}).finally(() => {
            clearTimeout(timer);
            server.close();
        });
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            resolve({ base: `http://127.0.0.1:${server.address().port}`,
                      done, close: () => fail(new Error('replaced by a ' +
                                                        'new try')) });
        });
    });
}

function page(res, text) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Dendrite</title>' +
            '<body style="font-family:sans-serif;margin:2em">' +
            `<p>${text}</p></body>`);
}

/**
 * Sign in as the user in the browser and answer the token record to
 * keep: { refresh_token, access_token, expires_at }.
 */
async function signIn({ client, request, openUrl, http, crypto,
                        now = Date.now }) {
    const { verifier, challenge } = pkce(crypto);
    const state = base64url(crypto.randomBytes(16));
    const { base, done } = await loopback(http, (url, res) => {
        if (url.pathname !== '/') return undefined;
        if (url.searchParams.get('state') !== state) {
            throw new Error('this sign-in was not started by Dendrite');
        }
        const err = url.searchParams.get('error');
        page(res, err ? `Sign-in did not finish (${err}). You can close ` +
             'this tab.' : 'Signed in. You can close this tab and go back ' +
             'to Obsidian.');
        return err ? { error: err } : { code: url.searchParams.get('code') };
    });
    openUrl(`${client.authUri}?` + form({
        client_id: client.clientId, redirect_uri: base,
        response_type: 'code', scope: SCOPE, access_type: 'offline',
        prompt: 'consent', state, code_challenge: challenge,
        code_challenge_method: 'S256' }));
    const got = await done;
    if (got.error) throw new Error(`Google said ${got.error}`);
    const res = await request({ url: client.tokenUri, method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: form({ code: got.code, client_id: client.clientId,
                     client_secret: client.clientSecret,
                     redirect_uri: base, grant_type: 'authorization_code',
                     code_verifier: verifier }) });
    if (res.status !== 200 || !res.json.refresh_token) {
        throw new Error('Google did not give a token' +
            (res.json && res.json.error ? ` (${res.json.error})` : ''));
    }
    return { refresh_token: res.json.refresh_token,
             access_token: res.json.access_token,
             expires_at: now() + (res.json.expires_in || 3600) * 1000 };
}

/**
 * A current access token from the kept record `tok`, refreshed when it
 * is about to run out; `save(tok)` keeps a refreshed one. Throws with
 * `signIn: true` when Google wants the user to sign in again.
 */
async function accessToken({ client, tok, request, save,
                             now = Date.now }) {
    if (!tok || !tok.refresh_token) {
        const e = new Error('not signed in to Google');
        e.signIn = true;
        throw e;
    }
    if (tok.access_token && tok.expires_at > now() + 60000) {
        return tok.access_token;
    }
    const res = await request({ url: client.tokenUri, method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: form({ client_id: client.clientId,
                     client_secret: client.clientSecret,
                     refresh_token: tok.refresh_token,
                     grant_type: 'refresh_token' }) });
    if (res.status !== 200) {
        const e = new Error('Google wants you to sign in again' +
            (res.json && res.json.error ? ` (${res.json.error})` : ''));
        e.signIn = true;
        throw e;
    }
    const next = Object.assign({}, tok, {
        access_token: res.json.access_token,
        expires_at: now() + (res.json.expires_in || 3600) * 1000 });
    await save(next);
    return next.access_token;
}

async function revoke({ tok, request }) {
    if (!tok || !tok.refresh_token) return;
    await request({ url: REVOKE, method: 'POST',
                    contentType: 'application/x-www-form-urlencoded',
                    body: form({ token: tok.refresh_token }) });
}

/** The picker page, with what it needs written in as JSON. */
function pickerPage(o) {
    const j = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
    return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Dendrite: link a Google Doc</title>
<style>body { font-family: sans-serif; margin: 2em; }</style>
</head><body>
<p id="m">Opening Google's file picker. Click the manuscript's doc, then
press Select, or double-click it.</p>
<script>
const O = ${j(o)};
function say(t) { document.getElementById('m').textContent = t; }
// Each step is told to Dendrite, which shows it in Obsidian.
function report(what) {
  fetch(O.back + '/event?what=' + encodeURIComponent(what))
    .catch(() => {});
}
window.addEventListener('error', (e) => report('error: ' + e.message));
function tell(path, text) {
  say(text);
  fetch(path).catch(() => say(text + ' Dendrite did not answer; is ' +
                              'Obsidian still open?'));
}
function onCallback(d) {
  const P = google.picker;
  const action = d[P.Response.ACTION];
  if (action === P.Action.PICKED) {
    const doc = d[P.Response.DOCUMENTS][0];
    tell(O.back + '/picked?id=' + encodeURIComponent(doc[P.Document.ID]) +
         '&name=' + encodeURIComponent(doc[P.Document.NAME]),
         'Linked ' + doc[P.Document.NAME] + '. You can close this tab ' +
         'and go back to Obsidian.');
  } else if (action === P.Action.CANCEL) {
    tell(O.back + '/cancel', 'Cancelled. You can close this tab.');
  } else {
    report(String(action));
  }
}
function onApi() {
  try {
    gapi.load('picker', { callback: () => {
      try {
        const P = google.picker;
        const view = new P.DocsView(P.ViewId.DOCUMENTS)
          .setMode(P.DocsViewMode.LIST);
        new P.PickerBuilder().addView(view).setOAuthToken(O.token)
          .setDeveloperKey(O.key).setAppId(O.app).setOrigin(O.origin)
          .setCallback(onCallback).build().setVisible(true);
      } catch (err) {
        say('The picker failed: ' + err.message);
        report('error: ' + err.message);
      }
    }, onerror: () => report('error: the picker library did not load') });
  } catch (err) {
    report('error: ' + err.message);
  }
}
</script>
<script async defer src="https://apis.google.com/js/api.js"
        onload="onApi()"
        onerror="say('Google\\'s picker could not load.');
                 report('error: apis.google.com did not load')"></script>
</body></html>`;
}

/**
 * Open Google's picker in the browser to choose a doc, which grants
 * Dendrite that doc; answers { id, name }, or null when cancelled. The
 * page is served at an unguessable path, since it holds the token, and
 * tells `onEvent(what)` each other thing the picker reports, its
 * errors included.
 */
// The picker page waiting for an answer, closed by a new try, since
// both would want the one port.
let picking = null;

async function pick({ token, apiKey, client, openUrl, http, crypto,
                      onEvent = () => {}, port = PICKER_PORT }) {
    if (picking) {
        picking();
        picking = null;
        // Its server closes once its wait has ended.
        await new Promise((r) => setTimeout(r, 50));
    }
    const secret = base64url(crypto.randomBytes(16));
    let back = '';
    let origin = '';
    const { base, done, close } = await loopback(http, (url, res) => {
        if (url.pathname === `/${secret}`) {
            res.writeHead(200, { 'content-type': 'text/html; ' +
                                 'charset=utf-8' });
            res.end(pickerPage({ token, key: apiKey,
                                 app: client.projectNumber, back,
                                 origin }));
            return undefined;
        }
        if (url.pathname === `/${secret}/event`) {
            onEvent(url.searchParams.get('what') || '');
            res.writeHead(204);
            res.end();
            return undefined;
        }
        if (url.pathname === `/${secret}/picked`) {
            page(res, 'Linked.');
            return { id: url.searchParams.get('id'),
                     name: url.searchParams.get('name') || '' };
        }
        if (url.pathname === `/${secret}/cancel`) {
            page(res, 'Cancelled.');
            return null;
        }
        res.writeHead(404);
        res.end();
        return undefined;
    }, port);
    picking = close;
    done.then(() => {}, () => {}).finally(() => {
        if (picking === close) picking = null;
    });
    back = `/${secret}`;
    // Opened as localhost, the name the registered origin uses; the
    // server answers on 127.0.0.1, where localhost leads.
    origin = port ? pickerOrigin(port) : base;
    openUrl(`${origin}/${secret}`);
    return done;
}

// ---- reading a doc's review ------------------------------------------

const CONTEXT = 40;

function unescapeHtml(s) {
    return String(s || '').replace(/&#(\d+);/g,
        (m, n) => String.fromCharCode(Number(n)))
        .replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * A doc's suggested changes, from the Docs API's document read with
 * suggestions inline, as review items of kind 'change': each with the
 * text it would take out (`quote`), put in (`insert`), and the doc's
 * text either side, dated `date`. The API does not say who suggested
 * a change, or when.
 */
function suggestionItems(doc, date = '') {
    const out = [];
    const paras = [];
    const walk = (content) => {
        for (const el of content || []) {
            if (el.paragraph) paras.push(el.paragraph);
            if (el.table) {
                for (const row of el.table.tableRows || []) {
                    for (const cell of row.tableCells || []) {
                        walk(cell.content);
                    }
                }
            }
        }
    };
    walk(doc.body && doc.body.content);
    for (const p of paras) {
        // The paragraph as it stands, without suggested insertions, with
        // where each suggestion's runs fall in it.
        let text = '';
        const sugg = new Map();
        for (const el of p.elements || []) {
            const run = el.textRun;
            if (!run) continue;
            const t = run.content.replace(/\n$/, '');
            const ins = run.suggestedInsertionIds || [];
            const del = run.suggestedDeletionIds || [];
            for (const id of [...ins, ...del]) {
                if (!sugg.has(id)) {
                    sugg.set(id, { start: text.length, end: text.length,
                                   quote: '', insert: '' });
                }
            }
            if (ins.length) {
                for (const id of ins) sugg.get(id).insert += t;
                continue;
            }
            for (const id of del) {
                const s = sugg.get(id);
                s.quote += t;
                s.end = text.length + t.length;
            }
            text += t;
        }
        for (const s of sugg.values()) {
            out.push({ kind: 'change', author: 'Google Docs suggestion',
                       date, quote: s.quote, insert: s.insert,
                       before: text.slice(Math.max(0, s.start - CONTEXT),
                                          s.start),
                       after: text.slice(s.end, s.end + CONTEXT) });
        }
    }
    return out;
}

/**
 * Open comments from the Drive API as review items: the comment, then
 * its replies, on the passage it was left on. Resolved and deleted ones
 * are left out.
 */
function commentItems(comments) {
    const out = [];
    for (const c of comments || []) {
        if (c.resolved || c.deleted) continue;
        const replies = (c.replies || []).filter((r) => !r.deleted &&
                                                  r.content)
            .map((r) => ` Reply from ${(r.author && r.author.displayName) ||
                'someone'}: ${r.content}`);
        out.push({ kind: 'comment',
                   author: (c.author && c.author.displayName) || '',
                   date: String(c.createdTime || '').slice(0, 10),
                   text: (c.content || '') + replies.join(''),
                   quote: unescapeHtml(c.quotedFileContent &&
                                       c.quotedFileContent.value),
                   before: '', after: '' });
    }
    return out;
}

async function getJson(request, url, token) {
    const res = await request({ url, headers: {
        Authorization: `Bearer ${token}` } });
    if (res.status !== 200) {
        const msg = res.json && res.json.error && res.json.error.message;
        const e = new Error(`Google answered ${res.status}` +
                            (msg ? `: ${msg}` : ''));
        e.status = res.status;
        throw e;
    }
    return res.json;
}

/**
 * A doc's open comments and suggested changes as review items, and its
 * title: { title, items, resolved }.
 */
async function fetchReview({ docId, token, request,
                             today = new Date() }) {
    const doc = await getJson(request, `${DOCS}${docId}?` +
        'suggestionsViewMode=SUGGESTIONS_INLINE', token);
    const comments = [];
    let pageToken = '';
    let resolved = 0;
    for (let k = 0; k < 50; k++) {
        const r = await getJson(request, `${DRIVE}${docId}/comments?` +
            form({ pageSize: 100, includeDeleted: false,
                   fields: 'nextPageToken,comments(id,content,' +
                       'createdTime,resolved,deleted,author(displayName),' +
                       'quotedFileContent(value),replies(content,deleted,' +
                       'author(displayName)))' }) +
            (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` :
             ''), token);
        for (const c of r.comments || []) {
            if (c.resolved) resolved++;
            comments.push(c);
        }
        if (!r.nextPageToken) break;
        pageToken = r.nextPageToken;
    }
    return { title: doc.title || '',
             items: [...commentItems(comments), ...suggestionItems(doc,
                 today.toISOString().slice(0, 10))],
             resolved };
}

module.exports = { SCOPE, PICKER_PORT, pickerOrigin, readClient,
                   docIdFromUrl, docUrl, pkce, signIn,
                   accessToken, revoke, pick, pickerPage, suggestionItems,
                   commentItems, fetchReview };
