'use strict';
// Word's styles for an export, made from Pandoc's own reference document
// with the manuscript's font, size, line spacing, margins and paper, and
// all text black. A .docx is a zip of XML files; reading and writing one
// takes only what Word and Pandoc write, through Node's zlib, passed in.

const { Buffer } = require('buffer');

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** A zip's files, in order, as [{ name, data }]. */
function readZip(buf, zlib) {
    let end = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            end = i;
            break;
        }
    }
    if (end < 0) throw new Error('not a zip file');
    const count = buf.readUInt16LE(end + 10);
    let at = buf.readUInt32LE(end + 16);
    const out = [];
    for (let k = 0; k < count; k++) {
        if (buf.readUInt32LE(at) !== 0x02014b50) {
            throw new Error('damaged zip directory');
        }
        const method = buf.readUInt16LE(at + 10);
        const size = buf.readUInt32LE(at + 20);
        const nameLen = buf.readUInt16LE(at + 28);
        const extraLen = buf.readUInt16LE(at + 30);
        const noteLen = buf.readUInt16LE(at + 32);
        const local = buf.readUInt32LE(at + 42);
        const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
        const start = local + 30 + buf.readUInt16LE(local + 26) +
            buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + size);
        out.push({ name,
                   data: method === 8 ? zlib.inflateRawSync(raw) :
                       Buffer.from(raw) });
        at += 46 + nameLen + extraLen + noteLen;
    }
    return out;
}

/** A zip of [{ name, data }], each file deflated. */
function writeZip(files, zlib) {
    const parts = [];
    const dir = [];
    let offset = 0;
    for (const f of files) {
        const name = Buffer.from(f.name, 'utf8');
        const packed = zlib.deflateRawSync(f.data);
        const crc = crc32(f.data);
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);
        head.writeUInt16LE(20, 4);
        head.writeUInt16LE(0x0800, 6);
        head.writeUInt16LE(8, 8);
        head.writeUInt32LE(crc, 14);
        head.writeUInt32LE(packed.length, 18);
        head.writeUInt32LE(f.data.length, 22);
        head.writeUInt16LE(name.length, 26);
        parts.push(head, name, packed);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(0x0800, 8);
        entry.writeUInt16LE(8, 10);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(packed.length, 20);
        entry.writeUInt32LE(f.data.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt32LE(offset, 42);
        dir.push(entry, name);
        offset += head.length + name.length + packed.length;
    }
    const dirBuf = Buffer.concat(dir);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(dirBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, dirBuf, end]);
}

const PAGE_TWIPS = { letter: [12240, 15840], a4: [11906, 16838] };

const escapeXml = (s) => String(s).replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Word's styles.xml with the manuscript's look. `st`: font, fontSize
 * (points), lineSpacing (1.5 for one and a half). Text sizes are scaled
 * from Pandoc's 12 point body, so headings keep their proportions. A
 * table cell, set in the Compact style, stays single spaced, as in the
 * PDF.
 */
function styleXml(xml, st) {
    let out = xml.replace(/<w:color [^>]*\/>/g, '<w:color w:val="000000" />');
    if (st.font) {
        const f = escapeXml(st.font);
        out = out.replace(/<w:rFonts [^>]*w:asciiTheme="[^"]*"[^>]*\/>/g,
            `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" ` +
            `w:cs="${f}" />`);
    }
    if (st.fontSize && st.fontSize !== 12) {
        out = out.replace(/(<w:sz(?:Cs)? w:val=")(\d+)(")/g,
            (m, a, n, b) => a + Math.round(n * st.fontSize / 12) + b);
    }
    if (st.lineSpacing && Number(st.lineSpacing) !== 1) {
        const line = Math.round(240 * Number(st.lineSpacing));
        out = out.replace(/(<w:pPrDefault>\s*<w:pPr>\s*<w:spacing )/,
            `$1w:line="${line}" w:lineRule="auto" `);
        out = out.replace(
            /(<w:style [^>]*w:styleId="Compact"[^]*?<w:spacing )/,
            '$1w:line="240" w:lineRule="auto" ');
    }
    return out;
}

/**
 * Word's document.xml with the page size and margins as the last
 * section's, which Pandoc takes from a reference document. `marginPt`
 * in points; paper 'letter' or 'a4'.
 */
function pageXml(xml, st) {
    const [w, h] = PAGE_TWIPS[st.paper] || PAGE_TWIPS.letter;
    const m = Math.round((st.marginPt || 70.9) * 20);
    const sect = `<w:sectPr><w:pgSz w:w="${w}" w:h="${h}" />` +
        `<w:pgMar w:top="${m}" w:right="${m}" w:bottom="${m}" ` +
        `w:left="${m}" w:header="720" w:footer="720" w:gutter="0" />` +
        '</w:sectPr>';
    const bare = xml.replace(/<w:sectPr[^]*?<\/w:sectPr>/g, '');
    return bare.replace(/<\/w:body>/, sect + '</w:body>');
}

/**
 * Word's document.xml with each table of up to `maxRows` rows kept on one
 * page, as in the PDF: every paragraph in a row but the last is kept
 * with the next, and no row breaks across pages. Pandoc's caption is
 * already kept with its table.
 */
function keepTables(xml, maxRows = 30) {
    return xml.replace(/<w:tbl>[^]*?<\/w:tbl>/g, (tbl) => {
        const rows = tbl.match(/<w:tr[ >][^]*?<\/w:tr>/g) || [];
        if (rows.length < 2 || rows.length > maxRows) return tbl;
        let k = 0;
        return tbl.replace(/<w:tr[ >][^]*?<\/w:tr>/g, (tr) => {
            const last = ++k === rows.length;
            let out = tr.replace(/<w:trPr>/, '<w:trPr><w:cantSplit />');
            if (out === tr) {
                out = tr.replace(/^(<w:tr[^>]*>)/,
                                 '$1<w:trPr><w:cantSplit /></w:trPr>');
            }
            if (last) return out;
            // Word reads a paragraph's properties in a fixed order, the
            // style first and keep-with-next after it.
            return out.replace(/<w:p>(?!<w:pPr>)/g,
                               '<w:p><w:pPr></w:pPr>')
                .replace(/<w:pPr>(<w:pStyle [^>]*\/>)?/g,
                         (m, style) => '<w:pPr>' + (style || '') +
                             '<w:keepNext />');
        });
    });
}

/** Pandoc's reference .docx, `buf`, restyled for the manuscript. */
function reference(buf, st, zlib) {
    const files = readZip(buf, zlib).map((f) => {
        if (f.name === 'word/styles.xml') {
            return { name: f.name,
                     data: Buffer.from(styleXml(f.data.toString('utf8'), st),
                                       'utf8') };
        }
        if (f.name === 'word/document.xml') {
            return { name: f.name,
                     data: Buffer.from(pageXml(f.data.toString('utf8'), st),
                                       'utf8') };
        }
        return f;
    });
    return writeZip(files, zlib);
}

/** An exported .docx, `buf`, with its short tables kept on one page. */
function keepDocument(buf, zlib) {
    return writeZip(readZip(buf, zlib).map((f) => (
        f.name === 'word/document.xml' ?
            { name: f.name,
              data: Buffer.from(keepTables(f.data.toString('utf8')),
                                'utf8') } : f)), zlib);
}

module.exports = { crc32, readZip, writeZip, styleXml, pageXml, reference,
                   keepTables, keepDocument };
