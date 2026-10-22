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
 * Table and figure captions as Pandoc's own, so each is kept with its
 * table or figure: a `**Table 1.**` paragraph just before a table is
 * marked `Table:`, and a `**Figure 1.**` paragraph just after an image
 * on a line of its own becomes the image's caption.
 */
function pandocCaptions(md) {
    return md
        .replace(/^(\*\*Table \d+\.\*\*.*)\n\n(?=\s*\|)/gm,
                 'Table: $1\n\n')
        .replace(new RegExp('^!\\[\\]\\(([^)\\n]*)\\)(\\{[^}\\n]*\\})?' +
                            '\\n\\n(\\*\\*Figure \\d+\\.\\*\\*.*)$', 'gm'),
                 (all, src, attrs, cap) =>
                     `![${cap.replace(/[[\]]/g, '\\$&')}](${src})` +
                     (attrs || ''));
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
    return `${Math.round(bodyLine(st) * 10) / 10}pt`;
}

/** One line's text for LaTeX, its special characters escaped. */
function texEscape(t) {
    const named = { '\\': '\\textbackslash{}', '^': '\\textasciicircum{}',
                    '~': '\\textasciitilde{}' };
    return t.replace(/[\\{}$&#%_^~]/g, (c) => named[c] || '\\' + c);
}

/**
 * A header line as LaTeX: escaped, **bold** and *italic* kept, and
 * {page} and {pages} as the page number and the page count.
 */
function headerLine(line) {
    const t = texEscape(line.replace(/\{page\}/g, '\u0001')
                            .replace(/\{pages\}/g, '\u0002'));
    return t.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}')
        .replace(/\*(.+?)\*/g, '\\textit{$1}')
        .replace(/\u0001/g, '\\thepage{}')
        .replace(/\u0002/g, '\\pageref*{LastPage}');
}

/** The height of a body line, in points. */
function bodyLine(st) {
    return (st.fontSize || 10) * 1.2 * (st.lineSpacing || 1);
}

const SLOTS = { left: 'L', center: 'C', right: 'R' };

/** A header's or footer's slots, each its lines as LaTeX. */
function slotsTex(slots, cmd) {
    return Object.entries(SLOTS).map(([k, pos]) => {
        const text = slots && slots[k] ?
            slots[k].split('\n').map(headerLine).join('\\\\') : '';
        return text ? `\\${cmd}[${pos}]{${text}}` : null;
    }).filter(Boolean);
}

/** Whether any slot of a header or footer holds `re`. */
const anySlot = (st, re) => [st.header, st.footer].some((h) =>
    h && Object.values(h).some((t) => re.test(t)));

/** The most lines in any one slot, 0 for none. */
const slotLines = (slots) => Math.max(0, ...Object.values(slots || {})
    .map((t) => t.split('\n').length));

/**
 * LaTeX for a PDF's preamble: the space above the footnote rule and,
 * when the manuscript sets any, a running header and footer on every
 * page in the body's type, each with a left, centre and right slot.
 * Without a footer set, the page number stays at the foot's centre,
 * unless a slot prints {page} or page numbers are off.
 */
function preamble(st) {
    const out = ['\\setlength{\\skip\\footins}{' +
                 `${footnoteGap(st)} plus 4pt minus 2pt}`];
    if (st.header || st.footer) {
        const pages = st.pageNumbers !== false &&
            !anySlot(st, /\{page\}/);
        const foot = st.footer ? slotsTex(st.footer, 'fancyfoot') :
            [`\\fancyfoot[C]{${pages ? '\\thepage' : ''}}`];
        if (anySlot(st, /\{pages\}/)) out.push('\\usepackage{lastpage}');
        const style = ['\\fancyhf{}', ...slotsTex(st.header, 'fancyhead'),
                       ...foot, '\\renewcommand{\\headrulewidth}{0pt}'];
        // A page LaTeX sets plain, such as a title page, gets it too.
        out.push('\\usepackage{fancyhdr}', '\\pagestyle{fancy}', ...style,
                 '\\fancypagestyle{plain}{' + style.join('') + '}');
    }
    // Dendrite numbers tables and figures in their captions' text, so
    // LaTeX adds no label; a table's caption spans the text as a
    // figure's does. Pandoc loads longtable, which defines the table's
    // caption width, only for a document with a table.
    out.push('\\usepackage{caption}',
             '\\captionsetup{labelformat=empty,labelsep=none,' +
             'justification=raggedright,singlelinecheck=false}',
             '\\ifdefined\\LTcapwidth' +
             '\\setlength{\\LTcapwidth}{\\textwidth}\\fi');
    return out.join('\n') + '\n';
}

/**
 * Pandoc's arguments for one export. `o.style` holds what the manuscript
 * sets: font, fontSize (points), margin, paper, lineSpacing, pageNumbers,
 * defaults (a Pandoc defaults file), referenceDocx (Word's styles) and
 * referencesTitle (the reference list's heading; false for none),
 * header and footer, each { left, center, right } text or null, and
 * headerInMargin, true to print them in the margin.
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
        // The margin is measured to the header's top and a footer's
        // bottom, so nothing set is printed in it, with room for their
        // lines; or, where the format allows, they sit in the margin and
        // the text keeps its whole area. Page numbers alone sit in the
        // margin, as LaTeX puts them.
        const head = slotLines(st.header);
        const foot = slotLines(st.footer);
        const inside = !st.headerInMargin;
        if (head) {
            if (inside) args.push('-V', 'geometry:includehead');
            args.push('-V', `geometry:headheight=${Math.ceil(
                          head * bodyLine(st) + 2)}pt`,
                      '-V', 'geometry:headsep=12pt');
        }
        if (foot) {
            if (inside) args.push('-V', 'geometry:includefoot');
            args.push('-V', `geometry:footskip=${Math.ceil(
                          foot * bodyLine(st) + 12)}pt`);
        }
        if (!st.header && !st.footer && st.pageNumbers === false) {
            args.push('-V', 'pagestyle=empty');
        }
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
    let text = pandocCaptions(toPandoc(o.md, o.resolve || (() => null)));
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
        await deps.writeFile(header, preamble(o.style || {}));
    }
    await deps.writeFile(input, text);
    const args = pandocArgs({ input, output: o.output, format: o.format,
                              engine: o.engine, bibliography, csl: o.csl,
                              resourcePath: o.resourcePath, header,
                              style: o.style });
    try {
        await deps.run(o.pandoc || 'pandoc', args);
    } catch (err) {
        return { error: pandocError(err, o.pandoc || 'pandoc') };
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
 * follow it. `floatPages`, the pages estimated for tables and figures,
 * are not text and are taken off.
 */
function measuredRate(words, layout, cited, floatPages = 0) {
    if (!layout || !words) return null;
    const end = layout.bodyEnd || (cited ? null : layout.pages);
    if (!end || end < 2) return null;
    const text = end - 0.5 - floatPages;
    return text >= 1 ? Math.round(words / text) : null;
}

/**
 * What went wrong running Pandoc, for a notice: the program not found
 * said as such, since the system's ENOENT names no remedy; otherwise the
 * end of what Pandoc printed.
 */
function pandocError(err, cmd) {
    if (err && err.code === 'ENOENT') {
        return `Pandoc was not found (looked for "${cmd}"). Install it, ` +
            'or set its full path under Pandoc in Dendrite\'s settings: ' +
            '"which pandoc" in a terminal prints it, "where pandoc" on ' +
            'Windows.';
    }
    const msg = String((err && (err.stderr || err.message)) || err)
        .trim().split('\n').slice(-6).join('\n');
    return `Pandoc failed: ${msg}`;
}

/**
 * The environment Pandoc runs with: `env` with `extra` folders added to
 * its search path, in the variable's own spelling (Path on Windows) and
 * with the platform's separator.
 */
function searchPath(env, platform, extra) {
    const out = Object.assign({}, env);
    const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ||
        'PATH';
    const sep = platform === 'win32' ? ';' : ':';
    const parts = String(out[key] || '').split(sep).filter(Boolean);
    for (const d of extra) if (!parts.includes(d)) parts.push(d);
    out[key] = parts.join(sep);
    return out;
}

/**
 * The bin folders of conda installs among a home folder's entries
 * `names`, where Pandoc is often installed and a desktop app does not
 * look.
 */
function condaBins(names, home) {
    return names.filter((n) =>
        /^(ana|mini)conda\d*(-|$)|^(miniforge|mambaforge)\d*(-|$)/.test(n))
        .map((n) => `${home}/${n}/bin`);
}

module.exports = { citekeys, pandocCaptions, pandocError, searchPath,
                   condaBins, toPandoc,
                   fetchBib, pandocArgs, exportDocument, pdfPages,
                   measuredRate, footnoteGap, preamble, BODY_END };
