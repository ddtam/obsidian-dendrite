'use strict';
// A local HTTP endpoint where programs on this computer, such as an
// agent, submit review comments for a manuscript, as Better BibTeX
// answers Zotero requests on its own port. Nothing is written here: the
// plugin queues a review, and it is added only from the board.
//
//   POST /dendrite/review        { manuscript, title?, items: [...] }
//   GET  /dendrite/review/<id>   the review's state
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
    if (url.pathname === '/dendrite/review' && req.method === 'POST') {
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
        const out = await opts.submit(data);
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
 * { port, token, submit(data), status(id) }, each answering
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
