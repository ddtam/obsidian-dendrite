'use strict';
/*
 * Dendrite's pure core: everything that decides what is written to a note,
 * kept free of Obsidian so it can be tested in node. main.js wires it to
 * the vault and the view.
 *
 * The document model. A manuscript is an INDEX note whose body holds a
 * nested list of links, one per card, nesting giving the tree:
 *
 *     - [[R01-7kq2m|Aims]]
 *         - [[R01-c4x9p|Aim 1 rationale]]
 *
 * A CARD is an ordinary note named by an ID, `<prefix>-<suffix>`. The
 * index and the cards are the whole document; nothing about it is stored
 * anywhere else, so it survives the plugin.
 */

const INDENT = '    ';
const ITEM = /^(\s*)[-*+]\s+\[\[([^\]|#]+)(?:\|([^\]]*))?\]\]\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const PREFIX = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LEN = 5;
const LABEL_WORDS = 8;

/** Split a note into its frontmatter block (kept verbatim) and body. */
function splitFrontmatter(text) {
    const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m) return { fm: '', body: text };
    return { fm: m[0], body: text.slice(m[0].length) };
}

function makeNode(id, label, parent) {
    return { id, label: label || '', children: [], parent };
}

function makeRoot() {
    return makeNode(null, '', null);
}

/**
 * Parse an index body. The tree is the first run of link items; text
 * before and after it is kept verbatim, so a heading or a note to self in
 * the index survives every write. Blank lines inside the run are allowed.
 */
function parseIndex(body) {
    const lines = body.split('\n');
    let start = -1;
    let end = -1;
    for (let i = 0; i < lines.length; i++) {
        if (ITEM.test(lines[i])) {
            if (start < 0) start = i;
            end = i;
        } else if (start >= 0 && lines[i].trim() !== '') {
            break;
        }
    }
    const root = makeRoot();
    if (start < 0) {
        return { root, before: body, after: '' };
    }
    // The indent unit is the smallest non-zero indent, so tabs, two
    // spaces and four spaces all read; a jump of more than one level
    // under a parent is clamped to its child.
    const items = [];
    let unit = Infinity;
    for (let i = start; i <= end; i++) {
        const m = ITEM.exec(lines[i]);
        if (!m) continue;
        const width = m[1].replace(/\t/g, INDENT).length;
        if (width > 0) unit = Math.min(unit, width);
        items.push({ width, id: m[2].trim(), label: (m[3] || '').trim() });
    }
    if (!isFinite(unit)) unit = INDENT.length;
    const stack = [root];
    for (const it of items) {
        let depth = Math.round(it.width / unit);
        depth = Math.min(depth, stack.length - 1);
        stack.length = depth + 1;
        const parent = stack[depth];
        const node = makeNode(it.id, it.label, parent);
        parent.children.push(node);
        stack.push(node);
    }
    const before = lines.slice(0, start).join('\n');
    const after = lines.slice(end + 1).join('\n');
    return {
        root,
        before: start > 0 ? before + '\n' : '',
        after: end + 1 < lines.length ? '\n' + after : '',
    };
}

function cleanLabel(label) {
    return String(label || '').replace(/[[\]|\n\r]/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

function serialiseTree(root) {
    const out = [];
    const walk = (node, depth) => {
        for (const c of node.children) {
            const label = cleanLabel(c.label);
            out.push(INDENT.repeat(depth) + '- [[' + c.id +
                     (label ? '|' + label : '') + ']]');
            walk(c, depth + 1);
        }
    };
    walk(root, 0);
    return out.join('\n');
}

/** Rebuild an index note's text around a new tree, keeping the rest. */
function writeIndexText(text, root) {
    const { fm, body } = splitFrontmatter(text);
    const p = parseIndex(body);
    let before = p.before;
    if (!p.root.children.length && before && !before.endsWith('\n')) {
        before += '\n';
    }
    const list = serialiseTree(root);
    const after = p.root.children.length ? p.after : '';
    return fm + before + list + (list && !after ? '\n' : '') + after;
}

/**
 * A card's label: its heading line, else its first alias, else its first
 * words. Derived each time and never written into the card.
 */
function deriveLabel(body, aliases) {
    const lines = stripComments(body || '').split('\n')
        .map((l) => l.trim()).filter(Boolean);
    const first = lines[0] || '';
    const h = HEADING.exec(first);
    if (h) return cleanLabel(h[2]);
    const alias = Array.isArray(aliases) ? aliases[0] :
        (typeof aliases === 'string' ? aliases : null);
    if (alias) return cleanLabel(alias);
    if (!first) return '';
    const words = first.replace(/[*_`>#~=]/g, '')
        .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .split(/\s+/).filter(Boolean);
    const cut = words.slice(0, LABEL_WORDS).join(' ');
    return cleanLabel(words.length > LABEL_WORDS ? cut + '…' : cut);
}

/** Obsidian comments are planning beside the prose; export drops them. */
function stripComments(text) {
    return text.replace(/%%[\s\S]*?%%/g, '');
}

function validPrefix(prefix) {
    return PREFIX.test(prefix || '');
}

/**
 * A new card ID. The suffix is random rather than a running number so two
 * computers adding cards while out of sync cannot both create the same
 * file; `taken` says whether an ID is already in use here.
 */
function newId(prefix, taken, rand = Math.random) {
    for (let tries = 0; tries < 1000; tries++) {
        let s = '';
        for (let i = 0; i < ID_LEN; i++) {
            s += ID_CHARS[Math.floor(rand() * ID_CHARS.length)];
        }
        const id = prefix + '-' + s;
        if (!taken(id)) return id;
    }
    throw new Error('Dendrite: could not find a free card ID');
}

// ---- tree operations ----------------------------------------------------
// Each mutates the tree in place and returns true if anything changed.

function indexOf(node) {
    return node.parent.children.indexOf(node);
}

function insertSibling(node, newNode, below) {
    const sibs = node.parent.children;
    newNode.parent = node.parent;
    sibs.splice(indexOf(node) + (below ? 1 : 0), 0, newNode);
    return true;
}

function appendChild(parent, newNode) {
    newNode.parent = parent;
    parent.children.push(newNode);
    return true;
}

function moveWithin(node, delta) {
    const sibs = node.parent.children;
    const i = indexOf(node);
    const j = i + delta;
    if (j < 0 || j >= sibs.length) return false;
    sibs.splice(i, 1);
    sibs.splice(j, 0, node);
    return true;
}

/** Become the last child of the sibling above. */
function indent(node) {
    const i = indexOf(node);
    if (i === 0) return false;
    const target = node.parent.children[i - 1];
    node.parent.children.splice(i, 1);
    node.parent = target;
    target.children.push(node);
    return true;
}

/** Become the sibling just after the parent. */
function outdent(node) {
    const parent = node.parent;
    if (!parent.parent) return false;
    parent.children.splice(indexOf(node), 1);
    const gp = parent.parent;
    gp.children.splice(gp.children.indexOf(parent) + 1, 0, node);
    node.parent = gp;
    return true;
}

/**
 * Merge a card into the one above it: the card's children follow its
 * text to the end of that card's children. Returns the card merged into,
 * or null when there is no card above.
 */
function mergeIntoAbove(node) {
    const i = indexOf(node);
    if (i === 0) return null;
    const target = node.parent.children[i - 1];
    for (const c of node.children.slice()) appendChild(target, c);
    node.children = [];
    remove(node);
    return target;
}

/**
 * Merge a card into its parent: its children take its place among the
 * parent's children. Returns the parent, or null for a top-level card.
 */
function mergeIntoParent(node) {
    const parent = node.parent;
    if (!parent.id) return null;
    const i = indexOf(node);
    for (const c of node.children) c.parent = parent;
    parent.children.splice(i, 1, ...node.children);
    node.children = [];
    return parent;
}

/**
 * Move a card, with its branch, above or below another card, or to the
 * end of its children. Refused, returning false, onto itself or into its
 * own branch, which would detach the branch from the tree.
 */
function moveNode(node, target, where) {
    if (!node || !target || node === target) return false;
    for (let p = target; p; p = p.parent) if (p === node) return false;
    const sibs = node.parent.children;
    sibs.splice(sibs.indexOf(node), 1);
    if (where === 'child') {
        node.parent = target;
        target.children.push(node);
    } else {
        const ts = target.parent.children;
        ts.splice(ts.indexOf(target) + (where === 'below' ? 1 : 0), 0, node);
        node.parent = target.parent;
    }
    return true;
}

function remove(node) {
    node.parent.children.splice(indexOf(node), 1);
    return true;
}

function descendants(node) {
    const out = [];
    const walk = (n) => {
        for (const c of n.children) {
            out.push(c);
            walk(c);
        }
    };
    walk(node);
    return out;
}

function allNodes(root) {
    return descendants(root);
}

/**
 * Two texts compared line by line, as [op, line] in order: ' ' a line in
 * both, '-' only in the first, '+' only in the second.
 */
function lineDiff(a, b) {
    const x = a.split('\n');
    const y = b.split('\n');
    const n = x.length;
    const m = y.length;
    // Lengths of the longest common run of lines from i and j onward.
    const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 :
                Math.max(t[i + 1][j], t[i][j + 1]);
        }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (x[i] === y[j]) {
            out.push([' ', x[i++]]);
            j++;
        } else if (t[i + 1][j] >= t[i][j + 1]) {
            out.push(['-', x[i++]]);
        } else {
            out.push(['+', y[j++]]);
        }
    }
    while (i < n) out.push(['-', x[i++]]);
    while (j < m) out.push(['+', y[j++]]);
    return out;
}

/** Nodes grouped by depth, each column in reading order. */
function columns(root) {
    const cols = [];
    const walk = (n, d) => {
        for (const c of n.children) {
            c.depth = d;
            (cols[d] = cols[d] || []).push(c);
            walk(c, d + 1);
        }
    };
    walk(root, 0);
    return cols;
}

// ---- export ---------------------------------------------------------------

/**
 * What a card prints, by its role. A card's role is set in its
 * `dendrite_role` property or follows from its place in the tree:
 *
 *   section      its heading line prints; the rest of its text is notes
 *   prose        its heading line, if any, and its text print
 *   notes        nothing from the card or its branch prints
 *   scaffolding  nothing from the card prints; its children print in
 *                its place, a heading level up and numbered as if they
 *                were its siblings
 *
 * With no role set, a card with children is a section and a card without
 * them is prose. `roleOf(id)` returns the set role or null.
 */
const ROLES = ['section', 'prose', 'notes', 'scaffolding'];

function roleFor(node, roleOf) {
    const set = roleOf ? roleOf(node.id) : null;
    if (ROLES.includes(set)) return set;
    return node.children.length ? 'section' : 'prose';
}

/**
 * The manuscript as one segment per card, in reading order:
 * { id, depth, text, left }, where `text` is the markdown the card prints
 * and `left` the part of its text that does not print (its notes and
 * comments), for a preview that can show both. Headings are levelled by
 * depth below `headingTop` and numbered from `numbers` when given.
 */
function exportSegments(nodes, bodyOf, headingTop, numbers, roleOf) {
    const top = Math.max(1, Math.min(6, headingTop || 1));
    const segs = [];
    const heading = (id, text, depth) => '#'.repeat(Math.min(6, top + depth)) +
        ' ' + (numbers && numbers.has(id) ? numbers.get(id) + ' ' : '') +
        text;
    const comments = (raw) => (raw.match(/%%[\s\S]*?%%/g) || [])
        .map((c) => c.slice(2, -2).trim()).filter(Boolean).join('\n\n');
    const leftOut = (n, depth) => {
        segs.push({ id: n.id, depth, text: '',
                    left: (bodyOf(n.id) || '').trim() });
        for (const c of n.children) leftOut(c, depth + 1);
    };
    const walk = (node, depth) => {
        const raw = bodyOf(node.id) || '';
        const role = roleFor(node, roleOf);
        if (role === 'notes') {
            leftOut(node, depth);
            return;
        }
        if (role === 'scaffolding') {
            segs.push({ id: node.id, depth, text: '',
                        left: stripComments(raw).trim() });
            for (const c of node.children) walk(c, depth);
            return;
        }
        const body = stripComments(raw).trim();
        const lines = body ? body.split('\n') : [];
        const h = lines.length ? HEADING.exec(lines[0].trim()) : null;
        const rest = (h ? lines.slice(1) : lines).join('\n').trim();
        const out = [];
        if (h) out.push(heading(node.id, h[2], depth));
        let left = comments(raw);
        if (role === 'prose') {
            if (rest) out.push(rest);
        } else if (rest) {
            left = left ? rest + '\n\n' + left : rest;
        }
        segs.push({ id: node.id, depth, text: out.join('\n\n'), left });
        for (const c of node.children) walk(c, depth + 1);
    };
    for (const n of nodes) walk(n, 0);
    return segs;
}

/**
 * Footnotes across cards. Each card numbers its own, so two cards' [^1]
 * would collide once joined. Every reference is given a new number in
 * reading order across all the segments, and each segment's definitions,
 * with their indented continuation lines, are taken out of its text and
 * returned under their new numbers. Inline footnotes, ^[text], are
 * made numbered ones first, so all are numbered in one sequence. Notes
 * with the same text, such as one citation cited twice, become one note
 * that each reference points to. Code is left alone. Returns
 * { segments, notes }: the segments with references renumbered and
 * definitions removed, each also holding `notes`, the notes it is first
 * to give, `cardNotes`, every note it refers to, and `refs`, the numbers
 * it refers to in order of first reference; and every note, in order,
 * for the end of the document.
 */
function renumberFootnotes(segments) {
    let next = 0;
    const all = [];
    const byText = new Map();
    const given = new Set();
    const out = segments.map((seg) => {
        const local = new Map();
        const defs = new Map();
        const kept = [];
        const lines = inlineToReferences(seg.text || '').split('\n');
        let fence = null;
        let inDef = null;
        for (const line of lines) {
            const f = /^\s*(`{3,}|~{3,})/.exec(line);
            if (fence) {
                kept.push(line);
                if (f && f[1][0] === fence[0] &&
                    f[1].length >= fence.length) fence = null;
                continue;
            }
            if (f) {
                fence = f[1];
                inDef = null;
                kept.push(line);
                continue;
            }
            const d = /^\[\^([^\]\s]+)\]:\s?(.*)$/.exec(line);
            if (d) {
                inDef = d[1];
                defs.set(inDef, [d[2]]);
                continue;
            }
            if (inDef && (/^(\t| {2,})\S/.test(line) || line === '')) {
                defs.get(inDef).push(line);
                continue;
            }
            inDef = null;
            kept.push(line);
        }
        const textOf = (label) => defs.has(label) ?
            defs.get(label).join('\n').replace(/\s+$/, '') : null;
        const renum = (label) => {
            if (!local.has(label)) {
                const t = textOf(label);
                const key = t === null ? null : t.replace(/\s+/g, ' ').trim();
                let n = key !== null && byText.get(key);
                if (!n) {
                    n = ++next;
                    if (key) byText.set(key, n);
                }
                local.set(label, n);
            }
            return local.get(label);
        };
        // Each note's number, in the order the text first refers to it,
        // which is the order a renderer numbers them in.
        const refs = [];
        // References outside inline code, in reading order.
        const body = kept.join('\n').split(/(`[^`\n]*`)/).map((part) =>
            (part.startsWith('`') ? part : part.replace(
                /\[\^([^\]\s]+)\](?!:)/g,
                (m, label) => {
                    const n = renum(label);
                    if (!refs.includes(n)) refs.push(n);
                    return `[^${n}]`;
                }))).join('');
        const notes = [];
        const cardNotes = [];
        for (const label of defs.keys()) {
            // A definition nothing refers to still keeps its text.
            const n = renum(label);
            const note = { n, text: textOf(label) };
            if (!cardNotes.some((x) => x.n === n)) cardNotes.push(note);
            if (!given.has(n)) {
                given.add(n);
                notes.push(note);
            }
        }
        notes.sort((a, b) => a.n - b.n);
        cardNotes.sort((a, b) => a.n - b.n);
        all.push(...notes);
        return Object.assign({}, seg, {
            text: body.replace(/\n+$/, ''), notes, cardNotes, refs });
    });
    all.sort((a, b) => a.n - b.n);
    return { segments: out, notes: all };
}

function footnoteBlock(notes) {
    return notes.map((x) => `[^${x.n}]: ${x.text}`).join('\n');
}

/**
 * Inline footnotes, ^[text], made into numbered ones, so they are
 * numbered in reading order with the rest and can be gathered with them.
 * The note runs to the bracket that closes it, so ^[[@key]] is one note.
 * Code is left alone. Used by the preview only; export leaves inline
 * footnotes to Pandoc.
 */
function inlineToReferences(text) {
    let fence = null;
    let k = 0;
    const defs = [];
    const lines = (text || '').split('\n').map((line) => {
        const f = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (f && f[1][0] === fence[0] &&
                f[1].length >= fence.length) fence = null;
            return line;
        }
        if (f) {
            fence = f[1];
            return line;
        }
        let out = '';
        let i = 0;
        while (i < line.length) {
            if (line[i] === '`') {
                const end = line.indexOf('`', i + 1);
                if (end < 0) {
                    out += line.slice(i);
                    break;
                }
                out += line.slice(i, end + 1);
                i = end + 1;
                continue;
            }
            if (line[i] === '^' && line[i + 1] === '[') {
                let depth = 0;
                let j = i + 1;
                for (; j < line.length; j++) {
                    if (line[j] === '[') depth++;
                    else if (line[j] === ']' && --depth === 0) break;
                }
                if (j < line.length) {
                    const label = `dendrite-inline-${++k}`;
                    defs.push(`[^${label}]: ${line.slice(i + 2, j)}`);
                    out += `[^${label}]`;
                    i = j + 1;
                    continue;
                }
            }
            out += line[i++];
        }
        return out;
    });
    return defs.length ? lines.join('\n') + '\n\n' + defs.join('\n') :
        lines.join('\n');
}

/**
 * Where the preview shows footnotes. 'card': under each card, as
 * Obsidian renders them. 'section': gathered under each top-level
 * section, which starts at each segment of depth 0. 'end': all at the
 * end. In the gathered modes the notes are copied into a segment of
 * their own, { id, gathered: notes }, placed after the last segment of
 * its group; a group without notes gets none. Each segment keeps its
 * notes, which its references need to be drawn.
 */
function gatherFootnotes(segments, where) {
    if (where !== 'section' && where !== 'end') return segments;
    const out = [];
    let group = [];
    let first = null;
    const flush = () => {
        if (group.length) {
            out.push({ id: 'dendrite-notes:' + first, depth: 0, text: '',
                       left: '', gathered: group });
        }
        group = [];
    };
    for (const s of segments) {
        if (where === 'section' && s.depth === 0) {
            flush();
            first = s.id;
        }
        if (first === null) first = s.id;
        out.push(s);
        group.push(...(s.notes || []));
    }
    flush();
    return out;
}

/**
 * Tidy printed markdown the way the Linter plugin's blank-line rules do,
 * so exported text is clean whatever is inside the cards: a blank line
 * before and after every heading, runs of blank lines collapsed to one,
 * no trailing spaces, and one newline at the end. Fenced code is left
 * exactly as written. Only output is tidied; cards are never changed.
 */
function normaliseMarkdown(text) {
    const out = [];
    let fence = null;
    for (const raw of String(text).split('\n')) {
        const m = /^\s*(`{3,}|~{3,})/.exec(raw);
        if (fence) {
            out.push(raw);
            if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
                fence = null;
            }
            continue;
        }
        if (m) fence = m[1];
        const line = fence ? raw : raw.replace(/[ \t]+$/, '');
        const heading = !fence && HEADING.test(line);
        if (heading && out.length && out[out.length - 1] !== '') {
            out.push('');
        }
        if (line === '' && out.length && out[out.length - 1] === '') {
            continue;
        }
        if (out.length && out[out.length - 1] !== '' &&
            HEADING.test(out[out.length - 1]) && line !== '') {
            out.push('');
        }
        out.push(line);
    }
    while (out.length && out[0] === '') out.shift();
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.length ? out.join('\n') + '\n' : '';
}

/**
 * Assemble a manuscript: every card's printed text, in reading order, by
 * the roles above. Comments are dropped everywhere. `bodyOf(id)` returns a
 * card's body.
 */
function exportMarkdown(nodes, bodyOf, headingTop, numbers, roleOf) {
    const { segments, notes } = renumberFootnotes(
        exportSegments(nodes, bodyOf, headingTop, numbers, roleOf));
    const blocks = segments.map((s) => s.text).filter(Boolean);
    if (notes.length) blocks.push(footnoteBlock(notes));
    return normaliseMarkdown(blocks.join('\n\n'));
}

/**
 * Section numbers by position, as LaTeX numbers them: every card whose
 * text opens with a heading is numbered among its siblings that do, so
 * moving a section renumbers it. `hasHeading(id)` says which cards do;
 * a card whose role is notes, and its branch, are not numbered. A
 * scaffolding card, and a card with no heading, are replaced by their
 * children before counting, so a titled card under an untitled one takes
 * the next number at its level rather than starting again at 1.
 * Returns id -> `1.`, `1.2` and so on.
 */
function sectionNumbers(roots, hasHeading, roleOf) {
    const out = new Map();
    // A card left out of the manuscript takes no number, and neither
    // does anything in its branch.
    const spliced = (nodes) => nodes.flatMap((n) => {
        const role = roleFor(n, roleOf);
        if (role === 'notes') return [];
        if (role === 'scaffolding' || !hasHeading(n.id)) {
            return spliced(n.children);
        }
        return [n];
    });
    const walk = (nodes, prefix) => {
        spliced(nodes).forEach((n, k) => {
            const num = prefix ? `${prefix}.${k + 1}` : String(k + 1);
            out.set(n.id, prefix ? num : num + '.');
            walk(n.children, num);
        });
    };
    walk(roots, '');
    return out;
}

// ---- splitting and merging card text -------------------------------------

/**
 * Cut a card's text for a move to a new card. With a selection, the
 * selection moves; with a bare cursor, everything after it moves. The
 * text left behind is closed up so the cut leaves no run of blank lines.
 * Returns { keep, moved, at }, `at` being where the moved text was in
 * `keep`, or null when there is nothing to move.
 */
function splitText(body, start, end) {
    const a = Math.min(start, end);
    const b = start === end ? body.length : Math.max(start, end);
    const moved = body.slice(a, b).trim();
    if (!moved) return null;
    const before = body.slice(0, a);
    const after = body.slice(b);
    let keep;
    let at;
    if (!after.trim()) {
        keep = before.replace(/\s+$/, '');
        at = keep.length;
    } else if (!before.trim()) {
        keep = after.replace(/^\s+/, '');
        at = 0;
    } else if (/\n\s*$/.test(before) || /^\s*\n/.test(after)) {
        // The cut fell between lines: close up to one blank line.
        keep = before.replace(/\s+$/, '') + '\n\n' +
            after.replace(/^\s+/, '');
        at = before.replace(/\s+$/, '').length;
    } else {
        // The cut fell inside a line: join the two halves with a space.
        keep = before.replace(/[ \t]+$/, '') + ' ' +
            after.replace(/^[ \t]+/, '');
        at = before.replace(/[ \t]+$/, '').length;
    }
    return { keep, moved, at };
}

/** One card's text after another's, separated by a blank line. */
function mergeText(first, second) {
    const a = (first || '').replace(/\s+$/, '');
    const b = (second || '').replace(/^\s+/, '');
    return a && b ? a + '\n\n' + b : a || b;
}

// ---- column alignment ----------------------------------------------------

/**
 * Where a column showing a card taller than itself is moved to: the
 * card's top, `margin` below the column's. Null when the card fits.
 */
function tallTop(card, height, margin) {
    return card.height + 2 * margin > height ? card.top - margin : null;
}

/**
 * Where the active column is moved while its card is written in, from
 * the caret's top and bottom in the column. Typewriter: the caret's line
 * at the column's middle. Otherwise the column holds still while the
 * caret is at least `margin` inside it, and moves only enough to bring
 * it back.
 */
function caretOffset(caret, height, current, margin, typewriter) {
    const mid = (caret.top + caret.bottom) / 2;
    if (typewriter) return mid - height / 2;
    const m = Math.min(margin, (height - (caret.bottom - caret.top)) / 2);
    if (caret.top - m < current) return caret.top - m;
    if (caret.bottom + m > current + height) {
        return caret.bottom + m - height;
    }
    return current;
}

/**
 * Where each column scrolls to, Gingko-style. The active card's column
 * centres it, and each column to its left centres the ancestor it holds.
 * A column to the right centres the active card's descendants it holds;
 * if it holds none, it top-aligns a group of children with that group's
 * parent, choosing the parent nearest the previous column's anchor, so
 * children always sit beside their parent.
 *
 * `cols` is columns(root); `pos(id)` gives a card's { top, height } in
 * its column; `heights[d]` is column d's visible height. `own`, if
 * given, replaces the active card's centring in its own column, and the
 * columns to its right follow it. Returns the scrollTop for each column,
 * or null to leave a column alone.
 */
function alignColumns(cols, active, pos, heights, own = null) {
    const targets = cols.map(() => null);
    if (!active) return targets;
    const lineage = new Set([active.id]);
    for (let n = active.parent; n && n.id; n = n.parent) lineage.add(n.id);
    for (const d of descendants(active)) lineage.add(d.id);
    const centre = (nodes, d) => {
        const a = pos(nodes[0].id);
        const b = pos(nodes[nodes.length - 1].id);
        if (!a || !b) return null;
        return (a.top + b.top + b.height) / 2 - heights[d] / 2;
    };
    const anchor = [];
    for (let d = 0; d < cols.length; d++) {
        const inCol = cols[d].filter((n) => lineage.has(n.id));
        if (d === active.depth) {
            targets[d] = own !== null ? own : centre([active], d);
            anchor[d] = active;
        } else if (inCol.length) {
            targets[d] = centre(inCol, d);
            anchor[d] = inCol[0];
        } else if (d > active.depth && anchor[d - 1] &&
                   targets[d - 1] !== null) {
            const prev = cols[d - 1];
            const at = prev.indexOf(anchor[d - 1]);
            let best = null;
            prev.forEach((n, i) => {
                if (!n.children.length) return;
                const dist = Math.abs(i - at);
                if (!best || dist < best.dist) best = { n, dist };
            });
            if (!best) continue;
            const parent = pos(best.n.id);
            const first = pos(best.n.children[0].id);
            if (!parent || !first) continue;
            const onScreen = parent.top - targets[d - 1];
            targets[d] = first.top - onScreen;
            anchor[d] = best.n.children[0];
        }
    }
    return targets;
}

/**
 * The flow as one SVG path, so the bands and the tinted groups they open
 * into are filled once where they overlap, never doubled. Each pair is a
 * card's box and the box of the group holding its children, in the SVG's
 * coordinates, each with its corner radius `r`. The band leaves the card
 * from the straight part of its right edge, tucked under it, and arrives
 * level at the group's top-left and bottom-left points, so its edges run
 * straight on into the group's top and bottom edges. The group's left
 * corners are square, since the band covers that whole edge; its right
 * corners are rounded. All subpaths run clockwise, so the nonzero fill
 * joins them as one shape.
 */
function flowPath(pairs) {
    const f = (x) => Math.round(x * 10) / 10;
    const parts = [];
    for (const { card: a, group: b } of pairs) {
        const ra = Math.min(a.r || 0, (a.bottom - a.top) / 2);
        const rb = Math.min(b.r || 0, (b.right - b.left) / 2,
                            (b.bottom - b.top) / 2);
        const x1 = a.right - 1;
        const x2 = b.left + 1;
        const at = a.top + ra;
        const ab = a.bottom - ra;
        const bt = b.top;
        const bb = b.bottom;
        const mx = (a.right + b.left) / 2;
        parts.push(`M${f(x1)},${f(at)} C${f(mx)},${f(at)} ${f(mx)},${f(bt)} ` +
                   `${f(x2)},${f(bt)} L${f(x2)},${f(bb)} C${f(mx)},${f(bb)} ` +
                   `${f(mx)},${f(ab)} ${f(x1)},${f(ab)} Z`);
        // The group, clockwise from its top left: square on the left,
        // where the band joins, rounded on the right.
        const [l, r, t, btm] = [b.left, b.right, b.top, b.bottom];
        parts.push(`M${f(l)},${f(t)} H${f(r - rb)} ` +
                   `A${f(rb)},${f(rb)} 0 0 1 ${f(r)},${f(t + rb)} ` +
                   `V${f(btm - rb)} ` +
                   `A${f(rb)},${f(rb)} 0 0 1 ${f(r - rb)},${f(btm)} ` +
                   `H${f(l)} Z`);
    }
    return parts.join(' ');
}

/**
 * The thread: one ribbon per step of the active card's path, from a card
 * to the specific card it leads to in the next column, so which card a
 * card came from is unambiguous however deep the path. Each pair is two
 * card boxes; each ribbon runs from the straight part of one card's right
 * edge to the straight part of the next card's left edge, tucked under
 * both.
 */
function threadPath(pairs) {
    const f = (x) => Math.round(x * 10) / 10;
    const parts = [];
    for (const { from: a, to: b } of pairs) {
        const ra = Math.min(a.r || 0, (a.bottom - a.top) / 2);
        const rb = Math.min(b.r || 0, (b.bottom - b.top) / 2);
        const x1 = a.right - 1;
        const x2 = b.left + 1;
        const mx = (a.right + b.left) / 2;
        const [at, ab] = [a.top + ra, a.bottom - ra];
        const [bt, bb] = [b.top + rb, b.bottom - rb];
        parts.push(`M${f(x1)},${f(at)} C${f(mx)},${f(at)} ${f(mx)},${f(bt)} ` +
                   `${f(x2)},${f(bt)} L${f(x2)},${f(bb)} C${f(mx)},${f(bb)} ` +
                   `${f(mx)},${f(ab)} ${f(x1)},${f(ab)} Z`);
    }
    return parts.join(' ');
}

// ---- card status ------------------------------------------------------------

/**
 * A card's status describes its text. Cards that print their text carry
 * draft (the default), done or revise. A structural card carries no
 * status of its own except unsplit: text left behind when part of it was
 * moved into a child, which may be a split never finished.
 */
const STATUSES = ['draft', 'done', 'revise', 'unsplit'];
// How much work a status asks for, to find a branch's least-finished
// state: revise and unsplit are flags; draft is unfinished; done is done.
const URGENCY = { done: 0, draft: 1, revise: 2, unsplit: 2 };
// How mature text is, for a merge to keep the less mature of two.
const MATURITY = { revise: 0, draft: 1, done: 2 };

function isFlag(status) {
    return status === 'revise' || status === 'unsplit';
}

/** A card's text beyond its heading line and comments, trimmed. */
function leftover(body) {
    const lines = stripComments(body || '').trim().split('\n');
    if (lines.length && HEADING.test(lines[0].trim())) lines.shift();
    return lines.join('\n').trim();
}

/** The less mature of two statuses of printing text. */
function lowerStatus(a, b) {
    const x = MATURITY[a] === undefined ? 1 : MATURITY[a];
    const y = MATURITY[b] === undefined ? 1 : MATURITY[b];
    return x <= y ? (a || 'draft') : (b || 'draft');
}

/**
 * Every card's status, as shown. `statusOf(id)` is the set status or
 * null; `roleOf(id)` the set role or null. Returns
 *   { cards: Map id -> { prints, own, derived, below }, tally }
 * where `own` is a printing card's status (draft when unset) or a
 * structural card's unsplit, `derived` a structural card's least-finished
 * printing descendant, and `below` how many flagged cards its branch
 * holds. Left-out branches count for nothing. `tally` counts printing
 * cards by status, plus unsplit structural cards.
 */
function statusReport(root, statusOf, roleOf) {
    const cards = new Map();
    const tally = { revise: 0, unsplit: 0, draft: 0, done: 0 };
    const walk = (node) => {
        const role = roleFor(node, roleOf);
        if (role === 'notes') return null;
        const prints = role === 'prose';
        const set = statusOf(node.id);
        let own = null;
        if (prints) own = ['done', 'revise'].includes(set) ? set : 'draft';
        else if (set === 'unsplit') own = 'unsplit';
        if (own) tally[own] += 1;
        let worst = prints ? own : null;
        let below = 0;
        for (const c of node.children) {
            const r = walk(c);
            if (!r) continue;
            below += r.below + (isFlag(r.own) ? 1 : 0);
            const w = r.worst;
            if (w && (!worst || URGENCY[w] > URGENCY[worst])) worst = w;
        }
        const derived = prints ? null : (node.children.length ? worst : null);
        const info = { prints, own, derived, below,
                       worst: own && !prints ?
                           (worst && URGENCY[worst] > URGENCY[own] ?
                               worst : own) : worst };
        cards.set(node.id, info);
        return info;
    };
    for (const n of root.children) walk(n);
    return { cards, tally };
}

// ---- limits and counts ---------------------------------------------------

// An amount, which may be a fraction, then a unit.
const NUM = '\\d+(?:\\.\\d+)?';
const LIMIT = new RegExp(`^\\s*(${NUM}(?:\\s*/\\s*${NUM})?)\\s*` +
                         '(words?|characters?|chars?|pages?)\\s*$', 'i');

/** `12`, `0.5` or `1/4` as a number; NaN if unreadable. */
function parseAmount(text) {
    const parts = String(text).split('/').map((s) => Number(s.trim()));
    if (parts.length === 1) return parts[0];
    if (parts.length === 2 && parts[1]) return parts[0] / parts[1];
    return NaN;
}

/**
 * `500 words`, `2000 characters`, `1 page`, `1/4 page`; null if unset or
 * unreadable.
 */
function parseLimit(value) {
    if (value === null || value === undefined || value === '') return null;
    const m = LIMIT.exec(String(value));
    if (!m) return null;
    const amount = parseAmount(m[1]);
    if (!(amount > 0)) return null;
    const u = m[2].toLowerCase();
    const unit = u.startsWith('w') ? 'words' :
        (u.startsWith('p') ? 'pages' : 'characters');
    return { amount, unit };
}

/** A number for display: whole, or up to two decimals. */
function fmtNum(x) {
    return Number.isInteger(x) ? x.toLocaleString() :
        String(Math.round(x * 100) / 100);
}

function formatLimit(limit) {
    if (!limit) return '';
    const one = limit.amount === 1;
    const unit = limit.unit === 'pages' ? (one ? 'page' : 'pages') :
        limit.unit === 'words' ? (one ? 'word' : 'words') :
            (one ? 'character' : 'characters');
    return `${fmtNum(limit.amount)} ${unit}`;
}

/**
 * An amount in another unit. Pages convert through words per page and
 * characters through characters per word; both are estimates, so the
 * result says whether one was used.
 */
function convert(amount, from, to, wordsPerPage, charsPerWord) {
    if (from === to) return { value: amount, estimated: false };
    const wpp = wordsPerPage || 500;
    const cpw = charsPerWord || 6;
    const words = from === 'words' ? amount :
        from === 'pages' ? amount * wpp : amount / cpw;
    const value = to === 'words' ? words :
        to === 'pages' ? words / wpp : words * cpw;
    return { value, estimated: true };
}

/**
 * Quotas that waterfall down the tree. Each card with a quota is
 * measured against it, and against it are set the quotas of its nearest
 * descendants that carry one, its allocations. The manuscript's total,
 * if any, is the quota of the root.
 *
 * `quotaOf(id)` gives { amount, unit, required } or null; `countOf(nodes)`
 * gives { words, chars } for what export would write for those nodes.
 * Returns id -> report, with the root's under null:
 *   { quota, used, usedEstimated, allocated, allocatedEstimated, parts }
 * where allocated is null when nothing below carries a quota.
 */
function quotas(root, quotaOf, countOf, opts = {}) {
    const wpp = opts.wordsPerPage || 500;
    const cpw = opts.charsPerWord || 6;
    const out = new Map();
    const nearest = (node) => {
        const found = [];
        for (const c of node.children) {
            if (quotaOf(c.id)) found.push(c);
            else found.push(...nearest(c));
        }
        return found;
    };
    const report = (node, quota) => {
        const nodes = node.id ? [node] : node.children;
        const n = countOf(nodes);
        const used = measure(n, quota.unit, wpp);
        const parts = nearest(node);
        let allocated = null;
        let allocatedEstimated = false;
        if (parts.length) {
            allocated = 0;
            for (const p of parts) {
                const q = quotaOf(p.id);
                const c = convert(q.amount, q.unit, quota.unit, wpp, cpw);
                allocated += c.value;
                allocatedEstimated = allocatedEstimated || c.estimated;
            }
        }
        return { quota, used, usedEstimated: quota.unit === 'pages',
                 allocated, allocatedEstimated,
                 parts: parts.map((p) => p.id) };
    };
    if (opts.total) out.set(null, report(root, opts.total));
    for (const n of allNodes(root)) {
        const q = quotaOf(n.id);
        if (q) out.set(n.id, report(n, q));
    }
    return out;
}

/**
 * Words per page from an index's properties: the rate measured from the
 * last PDF export, else the one set by hand, else 500.
 */
function wordsPerPage(fm) {
    const measured = Number(fm.dendrite_measured_words_per_page);
    const set = Number(fm.dendrite_words_per_page);
    return { value: measured > 0 ? measured : (set > 0 ? set : 500),
             measured: measured > 0 ? measured : null };
}

/**
 * Words and characters in exported markdown, counting what a reader of
 * the output would see: markup, link targets and list markers are left
 * out, and a citation key counts as one word, since what it becomes
 * depends on the citation style.
 */
function countText(markdown, countSpaces) {
    const plain = stripComments(markdown)
        .replace(/!\[\[[^\]]*\]\]/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[(@[^\]]+)\]/g, 'cite')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/[*_`~=]+/g, '');
    const words = (plain.match(/\S+/g) || []).length;
    const collapsed = plain.replace(/\s+/g, ' ').trim();
    const chars = countSpaces ? collapsed.length :
        collapsed.replace(/ /g, '').length;
    return { words, chars };
}

/** A count in a limit's unit; pages are words over a words-per-page. */
function measure(count, unit, wordsPerPage) {
    if (unit === 'words') return count.words;
    if (unit === 'characters') return count.chars;
    return count.words / (wordsPerPage || 500);
}

// ---- find ------------------------------------------------------------------

/**
 * A find query as patterns. Plain text is words that must all appear in
 * a card, in any order, with "quoted text" kept as one exact phrase;
 * regex mode is one pattern. Returns { patterns, error }.
 */
function findPatterns(query, opts = {}) {
    const flags = 'g' + (opts.matchCase ? '' : 'i');
    const q = (query || '').trim();
    if (!q) return { patterns: [] };
    if (opts.regex) {
        try {
            return { patterns: [new RegExp(q, flags)] };
        } catch (err) {
            return { patterns: [], error: err.message };
        }
    }
    const terms = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(q)) !== null) {
        const t = m[1] !== undefined ? m[1] : m[2];
        if (t) terms.push(t);
    }
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { patterns: terms.map((t) => new RegExp(esc(t), flags)) };
}

/**
 * Every match of a query in reading order: `ids` in reading order,
 * `bodyOf(id)` a card's text. A card matches only when every pattern
 * does. Returns { matches: [{ id, start, end, comment }], error }, where
 * `comment` marks a match inside %% comments %%.
 */
function findMatches(ids, bodyOf, query, opts = {}) {
    const { patterns, error } = findPatterns(query, opts);
    const matches = [];
    if (!patterns.length) return { matches, error };
    // A card's own id, short or full, finds that card, as the first match
    // in it; { card: true } with no stretch of text.
    const q = (query || '').trim().toLowerCase();
    for (const id of ids) {
        if (q && (q === shortId(id).toLowerCase() ||
                  q === id.toLowerCase())) {
            matches.push({ id, start: 0, end: 0, comment: false,
                           card: true });
        }
        const body = bodyOf(id) || '';
        const found = [];
        let all = true;
        for (const p of patterns) {
            p.lastIndex = 0;
            let hit = false;
            let m;
            while ((m = p.exec(body)) !== null) {
                if (!m[0].length) {
                    p.lastIndex += 1;
                    continue;
                }
                hit = true;
                found.push({ start: m.index, end: m.index + m[0].length });
            }
            if (!hit) {
                all = false;
                break;
            }
        }
        if (!all) continue;
        const comments = [];
        const cre = /%%[\s\S]*?%%/g;
        let c;
        while ((c = cre.exec(body)) !== null) {
            comments.push([c.index, c.index + c[0].length]);
        }
        // In text order, overlaps dropped, so each stretch counts once.
        found.sort((a, b) => a.start - b.start || b.end - a.end);
        let last = -1;
        for (const f of found) {
            if (f.start < last) continue;
            last = f.end;
            matches.push({ id, start: f.start, end: f.end,
                           comment: comments.some(
                               ([a, b]) => f.start >= a && f.end <= b) });
        }
    }
    return { matches, error };
}

/** The part of a card id after the prefix: `DRAC-2026-lchl3` -> `lchl3`. */
function shortId(id) {
    const s = String(id || '');
    return s.slice(s.lastIndexOf('-') + 1);
}

module.exports = {
    findPatterns, findMatches, shortId,
    parseLimit, formatLimit, countText, wordsPerPage, measure,
    sectionNumbers,
    alignColumns, tallTop, caretOffset, parseAmount, convert, quotas, fmtNum,
    splitText, mergeText,
    mergeIntoAbove, mergeIntoParent, moveNode,
    flowPath, threadPath, exportSegments, roleFor, ROLES,
    STATUSES, isFlag, leftover, lowerStatus, statusReport,
    normaliseMarkdown, renumberFootnotes, footnoteBlock,
    inlineToReferences, gatherFootnotes,
    INDENT, splitFrontmatter, parseIndex, serialiseTree, writeIndexText,
    lineDiff,
    deriveLabel, stripComments, validPrefix, newId, makeNode, makeRoot,
    insertSibling, appendChild, moveWithin, indent, outdent, remove,
    descendants, allNodes, columns, exportMarkdown, cleanLabel,
};
