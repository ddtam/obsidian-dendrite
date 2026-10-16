'use strict';
/*
 * PDF and Word export through Pandoc, with citations resolved live from
 * Zotero. Everything that reaches outside the plugin (running Pandoc,
 * asking Zotero, writing temporary files) comes in through `deps`, so the
 * tests can stand in for each.
 *
 * Citations are written in cards as Pandoc keys, `[@key]`. At export,
 * exactly the keys used are fetched from Better BibTeX through Zotero's
 * local JSON-RPC endpoint, as CSL JSON, the form citation styles read,
 * which carries an item's PMID from its Extra field as `PMID`. A key the library does not hold stops the
 * export and is named, rather than rendering as "???" in the output.
 */

/** Every citation key in the text, once each, in order of first use. */
function citekeys(md) {
    const out = [];
    const seen = new Set();
    // A key follows `@` where `@` starts a word, as Pandoc reads it; an
    // email address is not a citation.
    const re = /(?<![\w.@])@([A-Za-z0-9_][\w:.#$%&+?<>~/-]*)/g;
    let m;
    while ((m = re.exec(md)) !== null) {
        const key = m[1].replace(/[.:,;?]+$/, '');
        if (key && !seen.has(key)) {
            seen.add(key);
            out.push(key);
        }
    }
    return out;
}

/**
 * Obsidian's syntax as Pandoc reads it: a link becomes its text, an
 * embedded image a Markdown image at its full path, and any other embed
 * its name, since a note cannot be embedded in a PDF. `resolve(name)`
 * returns an embed's absolute path, or null.
 */
function toPandoc(md, resolve) {
    return md
        .replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g,
            (all, name, alt) => {
                const path = resolve(name.trim());
                if (path && /\.(png|jpe?g|gif|svg|webp|pdf)$/i.test(path)) {
                    const width = alt && /^\d+$/.test(alt.trim()) ?
                        `{width=${alt.trim()}px}` : '';
                    return `![](<${path}>)${width}`;
                }
                return name.trim();
            })
        .replace(/\[\[([^\]|#]*)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g,
            (all, name, sub, alias) => (alias || sub || name).trim())
        .replace(/==([^=\n]+)==/g, '$1');
}

/**
 * Fetch the keys' items from Better BibTeX as CSL JSON. Returns { bib },
 * the JSON text of one array, or { missing } naming keys the library
 * does not hold, or { down } when Zotero does not answer.
 */
async function fetchBib(keys, port, deps) {
    const call = async (ks) => {
        const res = await deps.fetch(
            `http://127.0.0.1:${port}/better-bibtex/json-rpc`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'item.export',
                                       params: [ks, 'Better CSL JSON'] }),
            });
        return res.json();
    };
    const items = (r) => {
        if (!r || typeof r.result !== 'string') return null;
        try {
            const a = JSON.parse(r.result);
            return Array.isArray(a) ? a : null;
        } catch (err) {
            return null;
        }
    };
    let first;
    try {
        first = await call(keys);
    } catch (err) {
        return { down: true };
    }
    if (items(first)) return { bib: JSON.stringify(items(first)) };
    // One call failed as a whole; find which keys the library lacks.
    const missing = [];
    const all = [];
    for (const k of keys) {
        let r;
        try {
            r = await call([k]);
        } catch (err) {
            return { down: true };
        }
        if (items(r)) all.push(...items(r));
        else missing.push(k);
    }
    return missing.length ? { missing } : { bib: JSON.stringify(all) };
}

// Sizes LaTeX's article class takes; others need extarticle.
const ARTICLE_SIZES = [10, 11, 12];

/**
 * Pandoc's arguments for one export. `o.style` holds what the manuscript
 * sets: font, fontSize (points), margin, paper, lineSpacing, pageNumbers,
 * defaults (a Pandoc defaults file), referenceDocx (Word's styles) and
 * referencesTitle (the reference list's heading; false for none).
 * A defaults file comes first, so the manuscript's own settings win.
 */
function pandocArgs(o) {
    const st = o.style || {};
    const args = [o.input, '--from', 'markdown', '-o', o.output,
                  '--standalone'];
    if (st.defaults) args.unshift(`--defaults=${st.defaults}`);
    if (o.format === 'pdf') {
        args.push(`--pdf-engine=${o.engine || 'xelatex'}`,
                  '-V', `geometry:margin=${st.margin || '2.5cm'}`);
        if (st.paper) args.push('-V', `papersize=${st.paper}`);
        if (st.font) args.push('-V', `mainfont=${st.font}`);
        if (st.fontSize) {
            if (!ARTICLE_SIZES.includes(st.fontSize)) {
                args.push('-V', 'documentclass=extarticle');
            }
            args.push('-V', `fontsize=${st.fontSize}pt`);
        }
        if (st.lineSpacing) args.push('-V', `linestretch=${st.lineSpacing}`);
        if (st.pageNumbers === false) args.push('-V', 'pagestyle=empty');
    }
    if (o.format === 'docx' && st.referenceDocx) {
        args.push(`--reference-doc=${st.referenceDocx}`);
    }
    if (o.bibliography) {
        args.push('--citeproc', '--bibliography', o.bibliography);
        if (o.csl) args.push('--csl', o.csl);
        // A heading over the reference list, which Pandoc otherwise runs
        // on from the last paragraph; a style without a list prints none.
        if (st.referencesTitle !== false) {
            args.push('-M', 'reference-section-title=' +
                      (st.referencesTitle || 'References'));
        }
    }
    if (o.resourcePath) args.push('--resource-path', o.resourcePath);
    return args;
}

/**
 * Export markdown to PDF or Word. `o` holds md, format ('pdf' | 'docx'),
 * output, csl, port, fallbackBib, pandoc, engine, resourcePath, resolve,
 * and style, as pandocArgs takes it.
 * Returns { ok } or { error } with a message for the writer.
 */
async function exportDocument(o, deps) {
    const text = toPandoc(o.md, o.resolve || (() => null));
    const keys = citekeys(text);
    const dir = deps.tmpdir();
    const input = deps.join(dir, `dendrite-${Date.now()}.md`);
    let bibliography = null;
    if (keys.length) {
        const got = await fetchBib(keys, o.port || 23119, deps);
        if (got.missing) {
            return { error: 'Zotero has no item for ' +
                got.missing.map((k) => '@' + k).join(', ') +
                '. Nothing was exported.' };
        }
        if (got.down) {
            if (!o.fallbackBib) {
                return { error: 'Zotero did not answer on port ' +
                    `${o.port || 23119}: is it open, with Better BibTeX? ` +
                    'No fallback .bib is set in Dendrite\'s settings. ' +
                    'Nothing was exported.' };
            }
            bibliography = o.fallbackBib;
        } else {
            bibliography = deps.join(dir, `dendrite-${Date.now()}.json`);
            await deps.writeFile(bibliography, got.bib);
        }
    }
    await deps.writeFile(input, text);
    const args = pandocArgs({ input, output: o.output, format: o.format,
                              engine: o.engine, bibliography, csl: o.csl,
                              resourcePath: o.resourcePath,
                              style: o.style });
    try {
        await deps.run(o.pandoc || 'pandoc', args);
    } catch (err) {
        const msg = String((err && (err.stderr || err.message)) || err)
            .trim().split('\n').slice(-6).join('\n');
        return { error: `Pandoc failed: ${msg}` };
    } finally {
        deps.remove(input);
        if (bibliography && bibliography !== o.fallbackBib) {
            deps.remove(bibliography);
        }
    }
    return { ok: true, keys };
}

module.exports = { citekeys, toPandoc, fetchBib, pandocArgs, exportDocument };
