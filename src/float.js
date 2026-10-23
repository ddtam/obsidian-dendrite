'use strict';
// Table and figure cards. A card's text stays plain markdown, its table
// or image and, around it, its caption; here it is split into the two to
// edit apart, and put back together, and edited in the card in a form
// as wide as the page's text: a table in the card editor, whose live
// preview edits it as a grid, or the figure's image shown large.

const TABLE_LINE = /^\s*\|/;
const IMAGE = /!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\)/;
const IMAGE_LINE = /^\s*(!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\))\s*$/;
// An image's file, by its extension.
const IMAGE_FILE = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?|avif)(\|[^\]]*)?$/i;
// A link alone on its line to an image file, which Obsidian's link
// search writes without the ! that makes it an embed.
const IMAGE_LINK_LINE = /^\s*\[\[([^\]]+)\]\]\s*$/;

/** The table a card set to Table starts with, to fill in. */
const STARTER_TABLE = '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |';

/**
 * A table or figure card's text as { caption, content }: for a table its
 * table lines, for a figure its first image; the rest, trimmed, is the
 * caption.
 */
function split(body, kind) {
    const lines = String(body || '').split('\n');
    let content = [];
    let rest = lines;
    if (kind === 'table') {
        content = lines.filter((l) => TABLE_LINE.test(l));
        rest = lines.filter((l) => !TABLE_LINE.test(l));
    } else {
        const k = lines.findIndex((l) => IMAGE_LINE.test(l) ||
            (IMAGE_LINK_LINE.test(l) &&
             IMAGE_FILE.test(IMAGE_LINK_LINE.exec(l)[1])));
        if (k >= 0) {
            content = [linkedImage(lines[k])];
            rest = lines.filter((l, i) => i !== k);
        }
    }
    return { caption: rest.join('\n').trim(), content: content.join('\n') };
}

/**
 * A card's text from its caption and content: a table under its caption,
 * a figure's image above it, as each prints.
 */
function compose(kind, caption, content) {
    const c = String(caption || '').trim();
    const t = String(content || '').trim();
    const parts = kind === 'table' ? [c, t] : [t, c];
    return parts.filter(Boolean).join('\n\n');
}

function embedFor(path) {
    return `![[${path}]]`;
}

/** An image link in pasted or dropped text, as an embed; null if none. */
function linkedImage(text) {
    const s = String(text || '');
    const m = IMAGE.exec(s);
    if (m) return m[0];
    const w = /\[\[([^\]]+)\]\]/.exec(s);
    return w ? embedFor(w[1]) : null;
}

const PAPER_IN = { letter: 8.5, a4: 210 / 25.4 };
const UNIT_IN = { pt: 1 / 72.27, mm: 1 / 25.4, cm: 1 / 2.54, in: 1 };

/**
 * The width of a page's text, paper less its margins, in CSS points: the
 * width a card's table or figure is shown at while it is edited.
 */
function textWidthPt(st) {
    const paper = PAPER_IN[st && st.paper] || PAPER_IN.letter;
    const m = /^\s*([\d.]+)\s*(pt|mm|cm|in)\s*$/.exec((st && st.margin) ||
                                                      '');
    const margin = m ? Number(m[1]) * UNIT_IN[m[2]] : 2.5 * UNIT_IN.cm;
    return (paper - 2 * margin) * 72;
}

/**
 * The editor for a table or figure card, behind the card editor's
 * interface (see editor.js). `opts`: value, kind, label ('Table 1'),
 * onChange, onBlur, onEscape, onAsText, render(md, el) to draw markdown,
 * image(file) resolving to a saved image's embed, for one pasted or
 * dropped, and makeEditor(value, { onChange, onBlur, onEscape }) giving
 * a card editor for each field.
 */
function floatEditor(opts) {
    const kind = opts.kind;
    let { caption, content } = split(opts.value, kind);
    const root = createDiv({ cls: `dendrite-float-edit is-${kind}` });
    const head = root.createDiv({ cls: 'dendrite-float-head' });
    head.createSpan({ text: `${opts.label || (kind === 'table' ? 'Table' :
        'Figure')} · editing` });
    const asText = head.createEl('a', { cls: 'dendrite-float-astext',
                                        text: 'Edit as text' });
    asText.addEventListener('mousedown', (e) => e.preventDefault());
    asText.addEventListener('click', (e) => {
        e.preventDefault();
        if (opts.onAsText) opts.onAsText();
    });
    const changed = () => opts.onChange();
    // A field: the card editor, Obsidian's where it has one, whose live
    // preview edits a table as a grid, given by `opts.makeEditor`; else a
    // text box. Answers { el, value, set(text), focus(atStart) }.
    const field = (label, cls, value, onInput) => {
        const wrap = root.createDiv({ cls: 'dendrite-float-field' +
            (cls ? ` ${cls}` : '') });
        wrap.createDiv({ cls: 'dendrite-float-label', text: label });
        if (opts.makeEditor) {
            const ed = opts.makeEditor(value, { onChange: () => {
                onInput(ed.value);
                changed();
            }, onBlur: () => opts.onBlur(), onEscape: () => opts.onEscape() });
            wrap.appendChild(ed.el);
            return { get value() { return ed.value; },
                     set(text) { ed.replace(text, 0); },
                     focus(atStart) { ed.focus(atStart); },
                     destroy() { ed.destroy(); } };
        }
        const ta = wrap.createEl('textarea', { cls: 'dendrite-float-input' });
        ta.rows = cls ? 6 : 2;
        ta.value = value;
        ta.addEventListener('input', () => {
            onInput(ta.value);
            changed();
        });
        ta.addEventListener('blur', () => opts.onBlur());
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                opts.onEscape();
            }
        });
        return { get value() { return ta.value; },
                 set(text) { ta.value = text; },
                 focus(atStart) {
                     ta.focus();
                     const at = atStart ? 0 : ta.value.length;
                     ta.setSelectionRange(at, at);
                 },
                 destroy() {} };
    };
    let cap = null;
    let table = null;
    let image = null;
    let shown = null;
    const draw = () => {
        if (!shown) return;
        shown.empty();
        if (!linkedImage(content)) {
            shown.createDiv({ cls: 'dendrite-float-missing',
                text: 'No image: type [[ in the Image field below to find ' +
                    'one, or paste or drop one.' });
            return;
        }
        opts.render(linkedImage(content), shown);
    };
    if (kind === 'table') {
        cap = field('Caption, printed above the table', null, caption,
                    (v) => { caption = v; });
        // The table as it prints, under its number, edited in place.
        root.createDiv({ cls: 'dendrite-float-number',
                         text: `${opts.label || 'Table'}.` });
        table = field('', 'dendrite-float-table', content,
                      (v) => { content = v; });
    } else {
        shown = root.createDiv({ cls: 'dendrite-float-shown is-image' });
        // Its image as a link, typed with the editor's link search ([[),
        // or filled in by an image pasted or dropped.
        image = field('Image: type [[ to find one, or paste or drop one',
                      'dendrite-float-image', content, (v) => {
                          // Saved as an embed, as the link search writes
                          // it without the !.
                          content = linkedImage(v) || v.trim();
                          draw();
                      });
        cap = field('Caption, printed below the figure', null, caption,
                    (v) => { caption = v; });
    }
    // A figure's image: one, replaced by what is pasted or dropped.
    const take = async (dt) => {
        if (kind !== 'figure' || !dt) return false;
        const file = [...(dt.files || [])].find((x) =>
            /^image\//.test(x.type));
        let embed = null;
        if (file && opts.image) embed = await opts.image(file);
        if (!embed) embed = linkedImage(dt.getData && dt.getData('text/plain'));
        if (!embed) return false;
        content = embed;
        if (image) image.set(embed);
        draw();
        changed();
        return true;
    };
    if (kind === 'figure') {
        // A pasted image, or text that is only an image's link, is the
        // figure; any other text pasted is the caption's.
        root.addEventListener('paste', async (e) => {
            const dt = e.clipboardData;
            if (!dt) return;
            const image = [...(dt.files || [])].some((x) =>
                /^image\//.test(x.type));
            const text = (dt.getData && dt.getData('text/plain')) || '';
            const link = linkedImage(text);
            if (!image && !(link && text.trim().replace(/^!/, '') ===
                            link.replace(/^!/, ''))) return;
            e.preventDefault();
            await take(dt);
        });
        root.addEventListener('dragover', (e) => e.preventDefault());
        root.addEventListener('drop', async (e) => {
            e.preventDefault();
            await take(e.dataTransfer);
        });
    }
    draw();
    return {
        kind: 'float',
        el: root,
        ta: null,
        get value() { return compose(kind, caption, content); },
        focus(atStart) { cap.focus(atStart); },
        selection() { return [0, 0]; },
        replace(text) {
            ({ caption, content } = split(text, kind));
            cap.set(caption);
            if (table) table.set(content);
            if (image) image.set(content);
            draw();
        },
        focusAt() { cap.focus(false); },
        caretRect() { return null; },
        rangeAt() { return null; },
        // For the tests: an image taken as if pasted or dropped.
        take,
        destroy() {
            cap.destroy();
            if (table) table.destroy();
            if (image) image.destroy();
            root.remove();
        },
    };
}

module.exports = { split, compose, embedFor, linkedImage, textWidthPt,
                   floatEditor, STARTER_TABLE };
