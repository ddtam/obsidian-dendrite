'use strict';
// A local HTTP endpoint where programs on this computer, such as an
// agent, submit review comments for a manuscript, as Better BibTeX
// answers Zotero requests on its own port. Nothing is written here: the
// plugin queues a review, and it is added only from the board. A reply
// is written at once: it names its comment, so there is nothing to place.
// So is a suggested change found exactly: it is applied or dismissed
// from the board, which is its approval.
//
//   POST /dendrite/review        { manuscript, title?, items: [...] }
//   GET  /dendrite/threads?manuscript=<prefix>[&author=<name>]
//        [&awaiting=<name>][&card=<id>][&resolved=1]
//        the manuscript's open comments, each with its id and replies, and
//        the text of their cards, so a reviewer can read them in context
//        and what was answered; `author=me` is the
//        writer's own, and `awaiting` keeps those waiting for that name:
//        not answered by them, or replied to since by a reviewer, by the
//        writer on their own comment, or as `@<name> ...`; and `card`
//        keeps to that card and those under it; `resolved=1` adds the
//        comments dealt with, from the manuscript's review log; read only.
//        Also `versions`, each card's version, a hash of its text, and
//        `board_open`, `device`, this computer's name, and `sync`, each
//        card the open board has not settled by this device's own
//        history: [{ card, state, since, device }], `older_copy`,
//        `typing_kept`, `editing`, `index_older` with card null, or
//        `behind`: the review log has a change to it from another device
//        that its card here does not show yet, board open or not.
//        `status=1` gives only those, without threads
//   Writes (reply, suggest, revise) are refused on a card that is
//        `older_copy`, `typing_kept` or `behind`, and, given `base`, a version
//        read, where the card has changed since; `editing` is written
//        into the open editor
//   POST /dendrite/reply         { manuscript, thread, text, author? }
//        a reply written under the comment whose id is `thread`, at
//        once, as `author`, Claude if not given; up to 500 characters.
//        With `seen: true` and no text, a reply with no text, saying the
//        comment was read and there is nothing to add; `threads`, a list
//        of ids, in place of `thread` for several at once. With
//        `replace: true`, it takes the place of the writer's replies at
//        the end of the thread, a seen mark taking them back, and is
//        refused where someone has replied since. With `resolve: true`,
//        a reply suggesting the writer resolve the comment, its text
//        saying why; refused on a suggested change
//   POST /dendrite/suggest       { manuscript, items: [{ card, quote,
//        replace, before?, after?, author? }] }
//        suggested changes, each written at once where its quote is
//        found exactly in its card, once or once given the text around
//        it, and refused anywhere less sure; `replace` "" to delete.
//        An item { card, row: [cells], after_row | before_row } suggests
//        a table row beside the row named by its first cell or whole
//        text, applied as a line of its own
//
//   POST /dendrite/revise        { manuscript, title?, items: [{ card,
//        quote, was?, before?, after?, replace } or { card, quote, ...,
//        withdraw: true }] }
//        changes to the sender's own pending suggestions, queued as a
//        review is, each accepted or not on the board; one replied to
//        is refused. Answers { id, state, found, missing, superseded }.
//        An earlier pending request for the same suggestions gives them
//        up to it, closing as `superseded` once it has none left; one
//        whose suggestions are gone from their cards closes as `stale`
//   POST /dendrite/withdraw      { manuscript, batch, author? }
//        a pending review or request closed by its sender as
//        `withdrawn`; refused (409) once decided, or (403) where any of
//        its items is not `author`'s, Claude if not given
//   GET  /dendrite/review/<id>   { id, kind, state, manuscript, title,
//        received, decided, items: [{ card, quote, ..., state }],
//        closed: [{ card, quote, ..., state, reason?, by? }] }: each
//        item waiting or as the request was decided, and those closed
//        before it, as `stale` or `superseded`
//
// Every request carries `Authorization: Bearer <key>`. A request with an
// Origin header comes from a web page and is refused, and no CORS header
// is ever sent, so a page cannot reach it through the browser.

const MAX_BODY = 1 << 20;

function send(res, status, json) {
    const body = JSON.stringify(json);
    res.writeHead(status, { 'content-type': 'application/json',
                            'content-length': Buffer.byteLength(body) });
    res.end(body);
}

/** The request's body as text, or null once it is over `MAX_BODY`. */
function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const parts = [];
        req.on('data', (c) => {
            size += c.length;
            if (size <= MAX_BODY) parts.push(c);
        });
        req.on('end', () => resolve(size > MAX_BODY ? null :
            Buffer.concat(parts).toString('utf8')));
        req.on('error', reject);
    });
}

async function handle(opts, req, res) {
    if (req.headers.origin) {
        return send(res, 403, { error: 'requests from web pages are ' +
                                       'refused' });
    }
    if (req.headers.authorization !== `Bearer ${opts.token}`) {
        return send(res, 401, { error: 'missing or wrong key; it is in ' +
                                       'the discovery file' });
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const take = { '/dendrite/review': opts.submit,
                   '/dendrite/reply': opts.reply,
                   '/dendrite/suggest': opts.suggest,
                   '/dendrite/revise': opts.revise,
                   '/dendrite/withdraw': opts.withdraw }[url.pathname];
    if (take && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] ||
                                         '')) {
            return send(res, 415, { error: 'send application/json' });
        }
        const text = await readBody(req);
        if (text === null) {
            return send(res, 413, { error: 'over 1 MB' });
        }
        let data;
        try {
            data = JSON.parse(text);
        } catch (err) {
            return send(res, 400, { error: `not JSON: ${err.message}` });
        }
        const out = await take(data);
        return send(res, out.status, out.json);
    }
    if (url.pathname === '/dendrite/threads' && req.method === 'GET' &&
        opts.threads) {
        const prefix = (url.searchParams.get('manuscript') || '').trim();
        if (!prefix) {
            return send(res, 400, { error: 'say which manuscript, by its ' +
                                           'prefix, as ?manuscript=' });
        }
        const q = (k) => url.searchParams.get(k) || null;
        const out = await opts.threads(prefix, { author: q('author'),
            awaiting: q('awaiting'), card: q('card'),
            resolved: !!q('resolved'), status: !!q('status') });
        return send(res, out.status, out.json);
    }
    const m = /^\/dendrite\/review\/([\w-]+)$/.exec(url.pathname);
    if (m && req.method === 'GET') {
        const out = await opts.status(m[1]);
        return send(res, out.status, out.json);
    }
    return send(res, 404, { error: 'not found' });
}

/**
 * Listen on 127.0.0.1:`port` (0 for any free port); resolves with the
 * server once listening, rejects when the port cannot be had. `opts`:
 * { port, token, submit(data), status(id), threads(prefix, { author,
 * awaiting, card }), reply(data), suggest(data) }, each answering
 * { status, json }.
 */
function start(opts, http = require('http')) {
    return new Promise((resolve, reject) => {
        let server;
        try {
            server = http.createServer((req, res) => {
                handle(opts, req, res).catch((err) => {
                    if (!res.headersSent) {
                        send(res, 500, { error: String(err.message) });
                    }
                });
            });
            server.once('error', reject);
            server.listen(opts.port, '127.0.0.1', () => {
                server.off('error', reject);
                resolve(server);
            });
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { start, MAX_BODY };
