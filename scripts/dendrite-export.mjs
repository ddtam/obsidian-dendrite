#!/usr/bin/env node
// What a Dendrite manuscript exports, read from the files without
// Obsidian. It calls the plugin's own core functions, the ones Export,
// the preview and the quota bars use, so the role, numbering and footnote
// rules are never restated here. Read only: nothing is ever written.
//
//   node scripts/dendrite-export.mjs <index.md>            the markdown
//   node scripts/dendrite-export.mjs <index.md> --report   per section
//   node scripts/dendrite-export.mjs <index.md> --map      per card
//
// --json prints the report or map as JSON. --heading-top N overrides the
// level of the top headings; otherwise the index's dendrite_heading_top,
// then the plugin's setting in the vault, then 1.
//
// Two differences from Obsidian, both in reading the files rather than in
// the rules: a card is found by file name in the index's folder, then
// anywhere in the vault outside dot-folders, where Obsidian resolves a
// link through its cache; and properties are read as flat `key: value`
// lines, which is how Dendrite writes its own.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const core = require('../src/core.js');

/** Flat `key: value` properties, with quotes, booleans and numbers. */
export function readProps(text) {
    const fm = core.splitFrontmatter(text).fm;
    const out = {};
    for (const line of fm.split(/\r?\n/)) {
        const m = /^([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
        if (!m || m[2] === '') continue;
        let v = m[2];
        const q = /^(["'])(.*)\1$/.exec(v);
        if (q) v = q[2];
        else if (v === 'true' || v === 'false') v = v === 'true';
        else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
        out[m[1]] = v;
    }
    return out;
}

/** The vault holding a path: the nearest folder with `.obsidian`. */
function vaultOf(file) {
    let dir = path.dirname(path.resolve(file));
    while (dir !== path.dirname(dir)) {
        if (existsSync(path.join(dir, '.obsidian'))) return dir;
        dir = path.dirname(dir);
    }
    return null;
}

/** Every markdown file under a folder by name, skipping dot-folders. */
function filesByName(dir, out = new Map()) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) filesByName(p, out);
        else if (e.name.endsWith('.md')) {
            const id = e.name.slice(0, -3);
            if (!out.has(id)) out.set(id, p);
        }
    }
    return out;
}

/**
 * Everything the view knows about a manuscript, read from disk:
 * { root, ms, bodyOf, roleOf, quotaOf, numbers, missing }.
 */
export function loadManuscript(indexPath, opts = {}) {
    const text = readFileSync(indexPath, 'utf8');
    const fm = readProps(text);
    const root = core.parseIndex(core.splitFrontmatter(text).body).root;
    const vault = vaultOf(indexPath);
    const near = filesByName(path.dirname(path.resolve(indexPath)));
    let far = null;
    const fileOf = (id) => {
        if (near.has(id)) return near.get(id);
        if (!far && vault) far = filesByName(vault);
        return far ? far.get(id) || null : null;
    };
    const cards = new Map();
    const missing = [];
    for (const n of core.allNodes(root)) {
        const f = fileOf(n.id);
        if (!f) {
            missing.push(n.id);
            continue;
        }
        const raw = readFileSync(f, 'utf8');
        cards.set(n.id, { body: core.splitFrontmatter(raw).body,
                          props: readProps(raw) });
    }
    let headingTop = Number(opts.headingTop || fm.dendrite_heading_top);
    if (!(headingTop >= 1 && headingTop <= 6)) {
        const data = vault && path.join(vault,
            '.obsidian/plugins/dendrite/data.json');
        try {
            headingTop = JSON.parse(readFileSync(data, 'utf8')).headingTop;
        } catch (err) {
            headingTop = 1;
        }
        if (!(headingTop >= 1 && headingTop <= 6)) headingTop = 1;
    }
    const wpp = core.wordsPerPage(fm).value;
    const cpw = Number(fm.dendrite_chars_per_word);
    const ms = {
        limit: core.parseLimit(fm.dendrite_limit),
        limitRequired: fm.dendrite_limit_required === true,
        wordsPerPage: wpp,
        charsPerWord: cpw > 0 ? cpw : 6,
        countSpaces: fm.dendrite_count_spaces !== false,
        headingTop,
        number: fm.dendrite_number_sections === true,
    };
    const props = (id) => (cards.get(id) || {}).props || {};
    const bodyOf = (id) => (cards.has(id) ? cards.get(id).body : '');
    const roleOf = (id) => {
        const r = props(id).dendrite_role;
        return core.ROLES.includes(r) ? r : null;
    };
    const quotaOf = (id) => {
        const q = core.parseLimit(props(id).dendrite_limit);
        return q ? Object.assign(q, {
            required: props(id).dendrite_limit_required === true }) : null;
    };
    // As Obsidian's cache says it: the first block of the body a heading.
    const hasHeading = (id) => {
        const first = bodyOf(id).split('\n').find((l) => l.trim());
        return !!first && /^#{1,6}\s/.test(first);
    };
    const numbers = ms.number ?
        core.sectionNumbers(root.children, hasHeading, roleOf) : new Map();
    return { root, ms, bodyOf, roleOf, quotaOf, numbers, missing };
}

/** The markdown Export writes for the whole manuscript. */
export function exportText(m) {
    return core.exportMarkdown(m.root.children, m.bodyOf, m.ms.headingTop,
                               m.numbers, m.roleOf);
}

const count = (m, nodes) => core.countText(
    core.exportMarkdown(nodes, m.bodyOf, 1, null, m.roleOf),
    m.ms.countSpaces);

const quotaRow = (r) => (r ? {
    limit: core.formatLimit(r.quota), required: !!r.quota.required,
    used: r.used, usedEstimated: r.usedEstimated,
    over: r.used > r.quota.amount,
    allocated: r.allocated, allocatedEstimated: r.allocatedEstimated,
} : null);

/**
 * Per top-level card: printed words, pages at the manuscript's words per
 * page, and its quota as the board measures it; and the manuscript's.
 */
export function report(m) {
    const total = m.ms.limit ? Object.assign({}, m.ms.limit,
        { required: m.ms.limitRequired }) : null;
    const reports = core.quotas(m.root, m.quotaOf, (nodes) => count(m, nodes),
        { wordsPerPage: m.ms.wordsPerPage, charsPerWord: m.ms.charsPerWord,
          total });
    const all = count(m, m.root.children);
    return {
        wordsPerPage: m.ms.wordsPerPage,
        sections: m.root.children.map((n) => {
            const c = count(m, [n]);
            return { id: n.id, label: n.label,
                     number: m.numbers.get(n.id) || null,
                     role: core.roleFor(n, m.roleOf),
                     words: c.words, chars: c.chars,
                     pages: c.words / m.ms.wordsPerPage,
                     quota: quotaRow(reports.get(n.id)) };
        }),
        total: { words: all.words, chars: all.chars,
                 pages: all.words / m.ms.wordsPerPage,
                 quota: quotaRow(reports.get(null)) },
        missing: m.missing,
    };
}

/** Per card, in reading order: role, depth, number, printed and left. */
export function cardMap(m) {
    // Each card's printed text with the footnotes it is first to give,
    // so the cards' counts add up to the manuscript's.
    const segs = core.renumberFootnotes(core.exportSegments(
        m.root.children, m.bodyOf, m.ms.headingTop, m.numbers,
        m.roleOf)).segments;
    const byId = new Map(core.allNodes(m.root).map((n) => [n.id, n]));
    const leftBy = (n) => {
        for (let p = n.parent; p && p.id; p = p.parent) {
            if (core.roleFor(p, m.roleOf) === 'notes') return p.id;
        }
        return null;
    };
    return segs.map((s) => {
        const n = byId.get(s.id);
        const under = leftBy(n);
        const words = (t) => core.countText(t || '', m.ms.countSpaces).words;
        let depth = 0;
        for (let p = n.parent; p && p.id; p = p.parent) depth++;
        return { id: s.id, label: n.label, depth, printDepth: s.depth,
                 role: core.roleFor(n, m.roleOf),
                 roleSet: !!m.roleOf(s.id),
                 leftOutUnder: under,
                 number: m.numbers.get(s.id) || null,
                 printed: words(s.text + '\n\n' +
                                core.footnoteBlock(s.notes)),
                 leftOut: words(s.left) };
    });
}

const fmt = (x) => core.fmtNum(Math.round(x * 100) / 100);

function printReport(r) {
    const rows = [['Section', 'Number', 'Role', 'Words', 'Pages',
                   'Quota', 'Used', 'Allocated']];
    const q = (x) => (x ? [x.limit + (x.required ? ' (required)' : ''),
        (x.usedEstimated ? '~' : '') + fmt(x.used) + (x.over ? ' OVER' : ''),
        x.allocated === null ? '' :
            (x.allocatedEstimated ? '~' : '') + fmt(x.allocated)] :
        ['', '', '']);
    for (const s of r.sections) {
        rows.push([s.label || s.id, s.number || '', s.role, fmt(s.words),
                   '~' + fmt(s.pages), ...q(s.quota)]);
    }
    rows.push(['Total', '', '', fmt(r.total.words),
               '~' + fmt(r.total.pages), ...q(r.total.quota)]);
    const w = rows[0].map((_, i) => Math.max(...rows.map((x) =>
        String(x[i]).length)));
    for (const x of rows) {
        console.log(x.map((c, i) => String(c).padEnd(w[i])).join('  ')
            .trimEnd());
    }
    console.log(`Pages at ${r.wordsPerPage} words per page; ~ marks an ` +
                'estimate.');
}

function printMap(rows) {
    for (const x of rows) {
        const role = x.role + (x.roleSet ? '' : ' (auto)') +
            (x.leftOutUnder ? ` (under left-out ${x.leftOutUnder})` : '');
        console.log([x.id, 'depth ' + x.depth, role, x.number || '-',
                     `printed ${x.printed}`, `left out ${x.leftOut}`,
                     x.label].join('\t'));
    }
}

function main(argv) {
    const args = argv.slice(2);
    const flag = (f) => args.includes(f);
    const ht = args.indexOf('--heading-top');
    const index = args.find((a, i) => !a.startsWith('--') &&
        args[i - 1] !== '--heading-top');
    if (!index || flag('--help')) {
        console.error('usage: dendrite-export.mjs <index.md> ' +
                      '[--report | --map] [--json] [--heading-top N]');
        return index ? 0 : 2;
    }
    if (!existsSync(index) || !statSync(index).isFile()) {
        console.error(`no such index note: ${index}`);
        return 2;
    }
    const m = loadManuscript(index,
        { headingTop: ht >= 0 ? args[ht + 1] : null });
    for (const id of m.missing) {
        console.error(`warning: no file for card ${id}; it prints nothing`);
    }
    if (flag('--report')) {
        const r = report(m);
        if (flag('--json')) console.log(JSON.stringify(r, null, 2));
        else printReport(r);
    } else if (flag('--map')) {
        const rows = cardMap(m);
        if (flag('--json')) console.log(JSON.stringify(rows, null, 2));
        else printMap(rows);
    } else {
        process.stdout.write(exportText(m));
    }
    return 0;
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    process.exitCode = main(process.argv);
}
