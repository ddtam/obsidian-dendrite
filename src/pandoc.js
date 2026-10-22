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
 * The space above a PDF's footnote rule, as a TeX length: the
 * manuscript's own, else one body line, the font size times LaTeX's
 * 1.2 leading times the line spacing. LaTeX's default is 9pt at 10pt
 * type whatever the spacing, half a line at one and a half.
 */
function footnoteGap(st) {
    if (st.footnoteGap) return st.footnoteGap;
    const pt = (st.fontSize || 10) * 1.2 * (st.lineSpacing || 1);
    return `${Math.round(pt * 10) / 10}pt`;
}

/**
 * Pandoc's arguments for one export. `o.style` holds what the manuscript
 * sets: font, fontSize (points), margin, paper, lineSpacing, pageNumbers,
 * defaults (a Pandoc defaults file), referenceDocx (Word's styles) and
 * referencesTitle (the reference list's heading; false for none).
 * `o.header` is a file of LaTeX for the PDF's preamble, added to any a
 * defaults file brings. A defaults file comes first, so the manuscript's
 * own settings win.
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
        if (o.header) args.push(`--include-in-header=${o.header}`);
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

// Where the body ends, for measuring words per page without the reference
// list after it: a raw LaTeX block at the end of the body that puts the
// page number into the PDF's document information. XeLaTeX's driver reads
// it; other engines ignore it, and then no body end is found.
const BODY_END = '\n\n```{=latex}\n' +
    '\\special{pdf:docinfo << /DendriteBodyEnd (\\thepage) >>}\n```\n';

/**
 * The page count of a PDF, and the page its body ends on where the mark
 * above is present, else null. XeLaTeX compresses objects into streams,
 * so each stream is inflated with `inflate` (zlib's inflateSync) and
 * searched as well.
 */
function pdfPages(buf, inflate) {
    const raw = buf.toString('latin1');
    let all = raw;
    const re = /stream\r?\n/g;
    let m;
    while ((m = re.exec(raw))) {
        const start = m.index + m[0].length;
        const end = raw.indexOf('endstream', start);
        if (end < 0) break;
        try {
            all += '\n' + inflate(buf.subarray(start, end)).toString('latin1');
        } catch (err) {
            // Not a deflated stream, such as an image or a font.
        }
        re.lastIndex = end + 'endstream'.length;
    }
    const pages = (all.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
    const mark = /\/DendriteBodyEnd\s*\((\d+)\)/.exec(all);
    return { pages, bodyEnd: mark ? Number(mark[1]) : null };
}

/**
 * Export markdown to PDF or Word. `o` holds md, format ('pdf' | 'docx'),
 * output, csl, port, fallbackBib, pandoc, engine, resourcePath, resolve,
 * and style, as pandocArgs takes it.
 * Returns { ok, keys } or { error } with a message for the writer; for a
 * PDF, also `layout`: { pages, bodyEnd } as pdfPages reads them, or null.
 */
async function exportDocument(o, deps) {
    let text = toPandoc(o.md, o.resolve || (() => null));
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
    let header = null;
    if (o.format === 'pdf') {
        text += BODY_END;
        header = deps.join(dir, `dendrite-${Date.now()}-header.tex`);
        await deps.writeFile(header, '\\setlength{\\skip\\footins}{' +
            `${footnoteGap(o.style || {})} plus 4pt minus 2pt}\n`);
    }
    await deps.writeFile(input, text);
    const args = pandocArgs({ input, output: o.output, format: o.format,
                              engine: o.engine, bibliography, csl: o.csl,
                              resourcePath: o.resourcePath, header,
                              style: o.style });
    try {
        await deps.run(o.pandoc || 'pandoc', args);
    } catch (err) {
        const msg = String((err && (err.stderr || err.message)) || err)
            .trim().split('\n').slice(-6).join('\n');
        return { error: `Pandoc failed: ${msg}` };
    } finally {
        deps.remove(input);
        if (header) deps.remove(header);
        if (bibliography && bibliography !== o.fallbackBib) {
            deps.remove(bibliography);
        }
    }
    let layout = null;
    if (o.format === 'pdf' && deps.readFile && deps.inflate) {
        try {
            layout = pdfPages(await deps.readFile(o.output), deps.inflate);
        } catch (err) {
            layout = null;
        }
    }
    return { ok: true, keys, layout };
}

/**
 * Words per page measured from an exported PDF: the exported words over
 * the pages up to the body's end, the last counted as half full since
 * where it ends on that page is not known. Null when the body is too
 * short to measure or its end was not found and a reference list may
 * follow it.
 */
function measuredRate(words, layout, cited) {
    if (!layout || !words) return null;
    const end = layout.bodyEnd || (cited ? null : layout.pages);
    if (!end || end < 2) return null;
    return Math.round(words / (end - 0.5));
}

module.exports = { citekeys, toPandoc, fetchBib, pandocArgs, exportDocument,
                   pdfPages, measuredRate, footnoteGap, BODY_END };
