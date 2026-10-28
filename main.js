/* Dendrite: bundled from src/ by esbuild; edit src/, not this file. */
"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/core.js
var require_core = __commonJS({
  "src/core.js"(exports2, module2) {
    "use strict";
    var INDENT = "    ";
    var ITEM = /^(\s*)[-*+]\s+\[\[([^\]|#]+)(?:\|([^\]]*))?\]\]\s*$/;
    var HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
    var PREFIX = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
    var ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
    var ID_LEN = 5;
    var LABEL_WORDS = 8;
    function splitFrontmatter(text) {
      const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
      if (!m) return { fm: "", body: text };
      return { fm: m[0], body: text.slice(m[0].length) };
    }
    function makeNode(id, label, parent) {
      return { id, label: label || "", children: [], parent };
    }
    function makeRoot() {
      return makeNode(null, "", null);
    }
    function parseIndex(body) {
      const lines = body.split("\n");
      let start = -1;
      let end = -1;
      for (let i = 0; i < lines.length; i++) {
        if (ITEM.test(lines[i])) {
          if (start < 0) start = i;
          end = i;
        } else if (start >= 0 && lines[i].trim() !== "") {
          break;
        }
      }
      const root = makeRoot();
      if (start < 0) {
        return { root, before: body, after: "" };
      }
      const items = [];
      let unit = Infinity;
      for (let i = start; i <= end; i++) {
        const m = ITEM.exec(lines[i]);
        if (!m) continue;
        const width = m[1].replace(/\t/g, INDENT).length;
        if (width > 0) unit = Math.min(unit, width);
        items.push({ width, id: m[2].trim(), label: (m[3] || "").trim() });
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
      const before = lines.slice(0, start).join("\n");
      const after = lines.slice(end + 1).join("\n");
      return {
        root,
        before: start > 0 ? before + "\n" : "",
        after: end + 1 < lines.length ? "\n" + after : ""
      };
    }
    function cleanLabel(label) {
      return String(label || "").replace(/[[\]|\n\r]/g, " ").replace(/\s+/g, " ").trim();
    }
    function serialiseTree(root) {
      const out = [];
      const walk = (node, depth) => {
        for (const c of node.children) {
          const label = cleanLabel(c.label);
          out.push(INDENT.repeat(depth) + "- [[" + c.id + (label ? "|" + label : "") + "]]");
          walk(c, depth + 1);
        }
      };
      walk(root, 0);
      return out.join("\n");
    }
    function writeIndexText(text, root) {
      const { fm, body } = splitFrontmatter(text);
      const p = parseIndex(body);
      let before = p.before;
      if (!p.root.children.length && before && !before.endsWith("\n")) {
        before += "\n";
      }
      const list = serialiseTree(root);
      const after = p.root.children.length ? p.after : "";
      return fm + before + list + (list && !after ? "\n" : "") + after;
    }
    function deriveLabel(body, aliases) {
      const lines = stripComments(body || "").split("\n").map((l) => l.trim()).filter(Boolean);
      const first = lines[0] || "";
      const h = HEADING.exec(first);
      if (h) return cleanLabel(h[2]);
      const alias = Array.isArray(aliases) ? aliases[0] : typeof aliases === "string" ? aliases : null;
      if (alias) return cleanLabel(alias);
      if (!first) return "";
      const words = first.replace(/[*_`>#~=]/g, "").replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").split(/\s+/).filter(Boolean);
      const cut = words.slice(0, LABEL_WORDS).join(" ");
      return cleanLabel(words.length > LABEL_WORDS ? cut + "\u2026" : cut);
    }
    function stripComments(text) {
      return text.replace(/==([^=\n]+?)==(?=%%\[!(?:review|suggest)\])/g, "$1").replace(/%%[\s\S]*?%%/g, "");
    }
    function validPrefix(prefix) {
      return PREFIX.test(prefix || "");
    }
    function newId(prefix, taken, rand = Math.random) {
      for (let tries = 0; tries < 1e3; tries++) {
        let s = "";
        for (let i = 0; i < ID_LEN; i++) {
          s += ID_CHARS[Math.floor(rand() * ID_CHARS.length)];
        }
        const id = prefix + "-" + s;
        if (!taken(id)) return id;
      }
      throw new Error("Dendrite: could not find a free card ID");
    }
    function withPrefix(id, from, to) {
      const head = from + "-";
      const rest = id.slice(head.length);
      return id.startsWith(head) && rest.length === ID_LEN && [...rest].every((c) => ID_CHARS.includes(c)) ? to + "-" + rest : id;
    }
    function formerPrefixes(fm) {
      const v = fm && fm.dendrite_former_prefixes;
      const list = Array.isArray(v) ? v : v ? [v] : [];
      return list.map((x) => String(x).trim()).filter(validPrefix);
    }
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
    function indent(node) {
      const i = indexOf(node);
      if (i === 0) return false;
      const target = node.parent.children[i - 1];
      node.parent.children.splice(i, 1);
      node.parent = target;
      target.children.push(node);
      return true;
    }
    function outdent(node) {
      const parent = node.parent;
      if (!parent.parent) return false;
      parent.children.splice(indexOf(node), 1);
      const gp = parent.parent;
      gp.children.splice(gp.children.indexOf(parent) + 1, 0, node);
      node.parent = gp;
      return true;
    }
    function mergeIntoAbove(node) {
      const i = indexOf(node);
      if (i === 0) return null;
      const target = node.parent.children[i - 1];
      for (const c of node.children.slice()) appendChild(target, c);
      node.children = [];
      remove(node);
      return target;
    }
    function mergeIntoParent(node) {
      const parent = node.parent;
      if (!parent.id) return null;
      const i = indexOf(node);
      for (const c of node.children) c.parent = parent;
      parent.children.splice(i, 1, ...node.children);
      node.children = [];
      return parent;
    }
    function moveNode(node, target, where) {
      if (!node || !target || node === target) return false;
      for (let p = target; p; p = p.parent) if (p === node) return false;
      const sibs = node.parent.children;
      sibs.splice(sibs.indexOf(node), 1);
      if (where === "child") {
        node.parent = target;
        target.children.push(node);
      } else {
        const ts = target.parent.children;
        ts.splice(ts.indexOf(target) + (where === "below" ? 1 : 0), 0, node);
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
    function lineDiff(a, b) {
      const x = a.split("\n");
      const y = b.split("\n");
      const n = x.length;
      const m = y.length;
      const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i2 = n - 1; i2 >= 0; i2--) {
        for (let j2 = m - 1; j2 >= 0; j2--) {
          t[i2][j2] = x[i2] === y[j2] ? t[i2 + 1][j2 + 1] + 1 : Math.max(t[i2 + 1][j2], t[i2][j2 + 1]);
        }
      }
      const out = [];
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (x[i] === y[j]) {
          out.push([" ", x[i++]]);
          j++;
        } else if (t[i + 1][j] >= t[i][j + 1]) {
          out.push(["-", x[i++]]);
        } else {
          out.push(["+", y[j++]]);
        }
      }
      while (i < n) out.push(["-", x[i++]]);
      while (j < m) out.push(["+", y[j++]]);
      return out;
    }
    var CHAR_DIFF_LIMIT = 25e4;
    function charDiff(a, b) {
      const split = (s) => s.match(/\s+|[\p{L}\p{N}_]+|./gsu) || [];
      const x = split(a);
      const y = split(b);
      let p = 0;
      while (p < x.length && p < y.length && x[p] === y[p]) p++;
      let q = 0;
      while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
      const xm = x.slice(p, x.length - q);
      const ym = y.slice(p, y.length - q);
      const keepX = xm.map(() => false);
      const keepY = ym.map(() => false);
      if (xm.length * ym.length <= CHAR_DIFF_LIMIT) {
        const n = xm.length;
        const m = ym.length;
        const t = Array.from(
          { length: n + 1 },
          () => new Uint32Array(m + 1)
        );
        for (let i = n - 1; i >= 0; i--) {
          for (let j = m - 1; j >= 0; j--) {
            t[i][j] = xm[i] === ym[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
          }
        }
        for (let i = 0, j = 0; i < n && j < m; ) {
          if (xm[i] === ym[j]) {
            keepX[i++] = true;
            keepY[j++] = true;
          } else if (t[i + 1][j] >= t[i][j + 1]) {
            i++;
          } else {
            j++;
          }
        }
      }
      const segs = (all, keep) => {
        const out = [];
        all.forEach((tok, i) => {
          const k = i - p;
          const changed = k >= 0 && k < keep.length && !keep[k];
          const last = out[out.length - 1];
          if (last && last[1] === changed) last[0] += tok;
          else out.push([tok, changed]);
        });
        return out;
      };
      return [segs(x, keepX), segs(y, keepY)];
    }
    var TREE = { up: (n) => n.parent, kids: (n) => n.children };
    function columns(root, kids = (n) => n.children) {
      const cols = [];
      const walk = (n, d) => {
        for (const c of kids(n)) {
          c.depth = d;
          (cols[d] = cols[d] || []).push(c);
          walk(c, d + 1);
        }
      };
      walk(root, 0);
      return cols;
    }
    var ROLES = ["section", "prose", "notes", "scaffolding"];
    function cardRole(fm) {
      if (!fm) return null;
      if (fm.dendrite_superseded) return "notes";
      return ROLES.includes(fm.dendrite_role) ? fm.dendrite_role : null;
    }
    function roleFor(node, roleOf) {
      const set = roleOf ? roleOf(node.id) : null;
      if (ROLES.includes(set)) return set;
      return node.children.length ? "section" : "prose";
    }
    var KINDS = ["table", "figure"];
    function withKinds(roleOf, kindOf) {
      return (id) => {
        const role = roleOf(id);
        if (!KINDS.includes(kindOf(id))) return role;
        return role === "notes" || role === "scaffolding" ? role : "prose";
      };
    }
    function floatLabels(nodes, roleOf, kindOf) {
      const out = /* @__PURE__ */ new Map();
      const next = { table: 0, figure: 0 };
      const walk = (node) => {
        const role = roleFor(node, roleOf);
        if (role === "notes") return;
        const kind = kindOf ? kindOf(node.id) : null;
        if (role !== "scaffolding" && KINDS.includes(kind)) {
          next[kind] += 1;
          out.set(node.id, (kind === "table" ? "Table " : "Figure ") + next[kind]);
        }
        for (const c of node.children) walk(c);
      };
      for (const n of nodes) walk(n);
      return out;
    }
    var TABLE_LINE = /^\s*\|/;
    var IMAGE_LINE = /^\s*!\[(\[[^\]]*\]|[^\]]*\]\([^)]*\))\]?\s*$/;
    function floatText(body, kind, label) {
      const lines = body.split("\n");
      const isBody = (l) => kind === "table" ? TABLE_LINE.test(l) : IMAGE_LINE.test(l);
      const content = lines.filter(isBody).join("\n");
      const caption = lines.filter((l) => !isBody(l)).map((l) => l.trim().replace(/^#{1,6}\s+/, "")).filter(Boolean).join(" ");
      const head = `**${label}.**` + (caption ? " " + caption : "");
      const parts = kind === "table" ? [head, content] : [content, head];
      return parts.filter(Boolean).join("\n\n");
    }
    function floatRefs(text, floats) {
      if (!floats.size || !text) return text;
      const byShort = /* @__PURE__ */ new Map();
      for (const id of floats.keys()) byShort.set(shortId(id), id);
      return text.replace(/\[\[([^\]|#]+)\]\]/g, (all, name) => {
        const n = name.trim();
        const id = floats.has(n) ? n : byShort.get(n);
        return id ? `[[${id}|${floats.get(id)}]]` : all;
      });
    }
    function exportSegments(nodes, bodyOf, headingTop, numbers, roleOf, opts = {}) {
      const kindOf = opts.kindOf || (() => null);
      const floats = opts.floats || floatLabels(nodes, roleOf, kindOf);
      const top = Math.max(1, Math.min(6, headingTop || 1));
      const segs = [];
      const heading = (id, text, depth) => "#".repeat(Math.min(6, top + depth)) + " " + (numbers && numbers.has(id) ? numbers.get(id) + " " : "") + text;
      const comments = (raw) => (raw.match(/%%[\s\S]*?%%/g) || []).map((c) => c.slice(2, -2).trim().replace(/^\}[a-z0-9]+\s+/, "")).filter((c) => c && !/^\{[a-z0-9]+$/.test(c)).join("\n\n");
      const leftOut = (n, depth) => {
        segs.push({
          id: n.id,
          depth,
          text: "",
          left: (bodyOf(n.id) || "").trim()
        });
        for (const c of n.children) leftOut(c, depth + 1);
      };
      const walk = (node, depth) => {
        const raw = bodyOf(node.id) || "";
        const role = roleFor(node, roleOf);
        if (role === "notes") {
          leftOut(node, depth);
          return;
        }
        if (role === "scaffolding") {
          segs.push({
            id: node.id,
            depth,
            text: "",
            left: stripComments(raw).trim()
          });
          for (const c of node.children) walk(c, depth);
          return;
        }
        const body = stripComments(raw).trim();
        if (floats.has(node.id)) {
          segs.push({
            id: node.id,
            depth,
            left: comments(raw),
            text: floatText(
              body,
              kindOf(node.id),
              floats.get(node.id)
            )
          });
          for (const c of node.children) walk(c, depth + 1);
          return;
        }
        const lines = body ? body.split("\n") : [];
        const h = lines.length ? HEADING.exec(lines[0].trim()) : null;
        const rest = (h ? lines.slice(1) : lines).join("\n").trim();
        const out = [];
        if (h) out.push(heading(node.id, h[2], depth));
        let left = comments(raw);
        if (role === "prose") {
          if (rest) out.push(rest);
        } else if (rest) {
          left = left ? rest + "\n\n" + left : rest;
        }
        segs.push({ id: node.id, depth, text: out.join("\n\n"), left });
        for (const c of node.children) walk(c, depth + 1);
      };
      for (const n of nodes) walk(n, 0);
      for (const s of segs) {
        s.text = floatRefs(s.text, floats);
        s.left = floatRefs(s.left, floats);
      }
      return segs;
    }
    function printedOnly(raw, role) {
      const blank = (t) => t.replace(/[^\n]/g, " ");
      if (role === "prose") return raw;
      if (role !== "section") return blank(raw);
      const m = /^(\s*)([^\n]*)/.exec(raw);
      if (!HEADING.exec(m[2].trim())) return blank(raw);
      const end = m[0].length;
      return raw.slice(0, end) + blank(raw.slice(end));
    }
    function renumberFootnotes(segments) {
      let next = 0;
      const all = [];
      const byText = /* @__PURE__ */ new Map();
      const given = /* @__PURE__ */ new Set();
      const out = segments.map((seg) => {
        const local = /* @__PURE__ */ new Map();
        const defs = /* @__PURE__ */ new Map();
        const kept = [];
        const lines = inlineToReferences(seg.text || "").split("\n");
        let fence = null;
        let inDef = null;
        for (const line of lines) {
          const f = /^\s*(`{3,}|~{3,})/.exec(line);
          if (fence) {
            kept.push(line);
            if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
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
          if (inDef && (/^(\t| {2,})\S/.test(line) || line === "")) {
            defs.get(inDef).push(line);
            continue;
          }
          inDef = null;
          kept.push(line);
        }
        const textOf = (label) => defs.has(label) ? defs.get(label).join("\n").replace(/\s+$/, "") : null;
        const renum = (label) => {
          if (!local.has(label)) {
            const t = textOf(label);
            const key = t === null ? null : t.replace(/\s+/g, " ").trim();
            let n = key !== null && byText.get(key);
            if (!n) {
              n = ++next;
              if (key) byText.set(key, n);
            }
            local.set(label, n);
          }
          return local.get(label);
        };
        const refs = [];
        const body = kept.join("\n").split(/(`[^`\n]*`)/).map((part) => part.startsWith("`") ? part : part.replace(
          /\[\^([^\]\s]+)\](?!:)/g,
          (m, label) => {
            const n = renum(label);
            if (!refs.includes(n)) refs.push(n);
            return `[^${n}]`;
          }
        )).join("");
        const notes = [];
        const cardNotes = [];
        for (const label of defs.keys()) {
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
          text: body.replace(/\n+$/, ""),
          notes,
          cardNotes,
          refs
        });
      });
      all.sort((a, b) => a.n - b.n);
      return { segments: out, notes: all };
    }
    function footnoteBlock(notes) {
      return notes.map((x) => `[^${x.n}]: ${x.text}`).join("\n");
    }
    function inlineFootnotes(text) {
      const out = [];
      let fence = null;
      let at = 0;
      for (const line of (text || "").split("\n")) {
        const start = at;
        at += line.length + 1;
        const f = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fence) {
          if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
          continue;
        }
        if (f) {
          fence = f[1];
          continue;
        }
        let i = 0;
        while (i < line.length) {
          if (line[i] === "`") {
            const end = line.indexOf("`", i + 1);
            if (end < 0) break;
            i = end + 1;
            continue;
          }
          if (line[i] === "^" && line[i + 1] === "[") {
            let depth = 0;
            let j = i + 1;
            for (; j < line.length; j++) {
              if (line[j] === "[") depth++;
              else if (line[j] === "]" && --depth === 0) break;
            }
            if (j < line.length) {
              out.push({
                from: start + i,
                to: start + j + 1,
                note: line.slice(i + 2, j)
              });
              i = j + 1;
              continue;
            }
          }
          i++;
        }
      }
      return out;
    }
    function inlineToReferences(text) {
      const notes = inlineFootnotes(text);
      if (!notes.length) return text || "";
      let out = "";
      let at = 0;
      const defs = notes.map((n, k) => {
        const label = `dendrite-inline-${k + 1}`;
        out += text.slice(at, n.from) + `[^${label}]`;
        at = n.to;
        return `[^${label}]: ${n.note}`;
      });
      return out + text.slice(at) + "\n\n" + defs.join("\n");
    }
    function footnoteLabel(note) {
      const t = (note || "").trim();
      if (!/^(\[[^\]]*@[^\]]*\]\s*)+$/.test(t)) return null;
      const keys = [...t.matchAll(/@([\w:.#$%&+?<>~/-]+)/g)].map((m) => m[1]);
      if (!keys.length) return null;
      const name = (k) => {
        const who = (/^[a-z]+/.exec(k) || /^[^\d]+/.exec(k) || [k])[0];
        const year = (/(\d{4})[a-z]?$/.exec(k) || [])[1];
        const shown = who.charAt(0).toUpperCase() + who.slice(1);
        return year ? `${shown} ${year}` : shown;
      };
      return keys.length > 2 ? `${name(keys[0])} +${keys.length - 1}` : keys.map(name).join("; ");
    }
    function gatherFootnotes(segments, where) {
      if (where !== "section" && where !== "end") return segments;
      const out = [];
      let group = [];
      let first = null;
      const flush = () => {
        if (group.length) {
          out.push({
            id: "dendrite-notes:" + first,
            depth: 0,
            text: "",
            left: "",
            gathered: group
          });
        }
        group = [];
      };
      for (const s of segments) {
        if (where === "section" && s.depth === 0) {
          flush();
          first = s.id;
        }
        if (first === null) first = s.id;
        out.push(s);
        group.push(...s.notes || []);
      }
      flush();
      return out;
    }
    function normaliseMarkdown(text) {
      const out = [];
      let fence = null;
      for (const raw of String(text).split("\n")) {
        const m = /^\s*(`{3,}|~{3,})/.exec(raw);
        if (fence) {
          out.push(raw);
          if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
            fence = null;
          }
          continue;
        }
        if (m) fence = m[1];
        const line = fence ? raw : raw.replace(/[ \t]+$/, "");
        const heading = !fence && HEADING.test(line);
        if (heading && out.length && out[out.length - 1] !== "") {
          out.push("");
        }
        if (line === "" && out.length && out[out.length - 1] === "") {
          continue;
        }
        if (out.length && out[out.length - 1] !== "" && HEADING.test(out[out.length - 1]) && line !== "") {
          out.push("");
        }
        out.push(line);
      }
      while (out.length && out[0] === "") out.shift();
      while (out.length && out[out.length - 1] === "") out.pop();
      return out.length ? out.join("\n") + "\n" : "";
    }
    function exportMarkdown(nodes, bodyOf, headingTop, numbers, roleOf, opts = {}) {
      const { segments, notes } = renumberFootnotes(
        exportSegments(nodes, bodyOf, headingTop, numbers, roleOf, opts)
      );
      const blocks = segments.map((s) => s.text).filter(Boolean);
      if (notes.length) blocks.push(footnoteBlock(notes));
      return normaliseMarkdown(blocks.join("\n\n"));
    }
    function sectionNumbers(roots, hasHeading, roleOf, kindOf) {
      const out = /* @__PURE__ */ new Map();
      const isFloat = (id) => !!kindOf && KINDS.includes(kindOf(id));
      const spliced = (nodes) => nodes.flatMap((n) => {
        const role = roleFor(n, roleOf);
        if (role === "notes") return [];
        if (role === "scaffolding" || !hasHeading(n.id) || isFloat(n.id)) {
          return spliced(n.children);
        }
        return [n];
      });
      const walk = (nodes, prefix) => {
        spliced(nodes).forEach((n, k) => {
          const num = prefix ? `${prefix}.${k + 1}` : String(k + 1);
          out.set(n.id, prefix ? num : num + ".");
          walk(n.children, num);
        });
      };
      walk(roots, "");
      return out;
    }
    function stackNotes(anchors, heights, current, gap) {
      const n = anchors.length;
      if (!n) return [];
      const down = (from, first) => {
        const top2 = new Array(n);
        top2[from] = first;
        for (let i = from + 1; i < n; i++) {
          top2[i] = Math.max(anchors[i], top2[i - 1] + heights[i - 1] + gap);
        }
        return top2;
      };
      if (current < 0 || current >= n) return down(0, Math.max(0, anchors[0]));
      const top = down(current, anchors[current]);
      for (let i = current - 1; i >= 0; i--) {
        top[i] = Math.min(anchors[i], top[i + 1] - heights[i] - gap);
      }
      return top[0] < 0 ? down(0, Math.max(0, anchors[0])) : top;
    }
    function placeComments(anchors, heights, gap) {
      const tops = [];
      const knots = [[0, 0]];
      let off = 0;
      let below = -gap;
      anchors.forEach((a, i) => {
        const c = Math.max(a + off, below + gap);
        off = c - a;
        tops.push(c);
        knots.push([c, a]);
        below = c + heights[i];
      });
      return { tops, knots };
    }
    function textAt(s, knots) {
      for (let k = 1; k < knots.length; k++) {
        const [c0, t0] = knots[k - 1];
        const [c1, t1] = knots[k];
        if (s <= c1) {
          return c1 === c0 ? t1 : t0 + (s - c0) * (t1 - t0) / (c1 - c0);
        }
      }
      const [c, t] = knots[knots.length - 1];
      return t + (s - c);
    }
    function scrollFor(t, knots) {
      for (let k = 1; k < knots.length; k++) {
        const [c0, t0] = knots[k - 1];
        const [c1, t1] = knots[k];
        if (t <= t1) {
          return t1 === t0 ? c0 : c0 + (t - t0) * (c1 - c0) / (t1 - t0);
        }
      }
      const [c, tl] = knots[knots.length - 1];
      return c + (t - tl);
    }
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
        keep = before.replace(/\s+$/, "");
        at = keep.length;
      } else if (!before.trim()) {
        keep = after.replace(/^\s+/, "");
        at = 0;
      } else if (/\n\s*$/.test(before) || /^\s*\n/.test(after)) {
        keep = before.replace(/\s+$/, "") + "\n\n" + after.replace(/^\s+/, "");
        at = before.replace(/\s+$/, "").length;
      } else {
        keep = before.replace(/[ \t]+$/, "") + " " + after.replace(/^[ \t]+/, "");
        at = before.replace(/[ \t]+$/, "").length;
      }
      return { keep, moved, at };
    }
    function mergeText(first, second) {
      const a = (first || "").replace(/\s+$/, "");
      const b = (second || "").replace(/^\s+/, "");
      return a && b ? a + "\n\n" + b : a || b;
    }
    function tallTop(card, height, margin) {
      return card.height + 2 * margin > height ? card.top - margin : null;
    }
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
    function fitHeights(points, least, slope) {
      if (points.length < least) return null;
      const n = points.length;
      const mx = points.reduce((t, p) => t + p[0], 0) / n;
      const my = points.reduce((t, p) => t + p[1], 0) / n;
      let sxx = 0;
      let sxy = 0;
      for (const [x, y] of points) {
        sxx += (x - mx) * (x - mx);
        sxy += (x - mx) * (y - my);
      }
      const b = sxx > 0 && sxy > 0 ? sxy / sxx : slope;
      return { a: my - b * mx, b };
    }
    function alignColumns(cols, active, pos, heights, own = null, tree = TREE) {
      const targets = cols.map(() => null);
      if (!active) return targets;
      const lineage = /* @__PURE__ */ new Set([active.id]);
      for (let n = tree.up(active); n && n.id; n = tree.up(n)) {
        lineage.add(n.id);
      }
      const below = (n) => {
        for (const c of tree.kids(n)) {
          lineage.add(c.id);
          below(c);
        }
      };
      below(active);
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
        } else if (d > active.depth && anchor[d - 1] && targets[d - 1] !== null) {
          const prev = cols[d - 1];
          const at = prev.indexOf(anchor[d - 1]);
          let best = null;
          prev.forEach((n, i) => {
            if (!tree.kids(n).length) return;
            const dist = Math.abs(i - at);
            if (!best || dist < best.dist) best = { n, dist };
          });
          if (!best) continue;
          const parent = pos(best.n.id);
          const first = pos(tree.kids(best.n)[0].id);
          if (!parent || !first) continue;
          const onScreen = parent.top - targets[d - 1];
          targets[d] = first.top - onScreen;
          anchor[d] = tree.kids(best.n)[0];
        }
      }
      return targets;
    }
    function flowPath(pairs) {
      const f = (x) => Math.round(x * 10) / 10;
      const parts = [];
      for (const { card: a, group: b } of pairs) {
        const ra = Math.min(a.r || 0, (a.bottom - a.top) / 2);
        const rb = Math.min(
          b.r || 0,
          (b.right - b.left) / 2,
          (b.bottom - b.top) / 2
        );
        const x1 = a.right - 1;
        const x2 = b.left + 1;
        const at = a.top + ra;
        const ab = a.bottom - ra;
        const bt = b.top;
        const bb = b.bottom;
        const mx = (a.right + b.left) / 2;
        parts.push(`M${f(x1)},${f(at)} C${f(mx)},${f(at)} ${f(mx)},${f(bt)} ${f(x2)},${f(bt)} L${f(x2)},${f(bb)} C${f(mx)},${f(bb)} ${f(mx)},${f(ab)} ${f(x1)},${f(ab)} Z`);
        const [l, r, t, btm] = [b.left, b.right, b.top, b.bottom];
        parts.push(`M${f(l)},${f(t)} H${f(r - rb)} A${f(rb)},${f(rb)} 0 0 1 ${f(r)},${f(t + rb)} V${f(btm - rb)} A${f(rb)},${f(rb)} 0 0 1 ${f(r - rb)},${f(btm)} H${f(l)} Z`);
      }
      return parts.join(" ");
    }
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
        parts.push(`M${f(x1)},${f(at)} C${f(mx)},${f(at)} ${f(mx)},${f(bt)} ${f(x2)},${f(bt)} L${f(x2)},${f(bb)} C${f(mx)},${f(bb)} ${f(mx)},${f(ab)} ${f(x1)},${f(ab)} Z`);
      }
      return parts.join(" ");
    }
    var STATUSES = ["draft", "done", "revise", "unsplit"];
    var URGENCY = { done: 0, draft: 1, revise: 2, unsplit: 2 };
    var MATURITY = { revise: 0, draft: 1, done: 2 };
    function isFlag(status) {
      return status === "revise" || status === "unsplit";
    }
    function leftover(body) {
      const lines = stripComments(body || "").trim().split("\n");
      if (lines.length && HEADING.test(lines[0].trim())) lines.shift();
      return lines.join("\n").trim();
    }
    function lowerStatus(a, b) {
      const x = MATURITY[a] === void 0 ? 1 : MATURITY[a];
      const y = MATURITY[b] === void 0 ? 1 : MATURITY[b];
      return x <= y ? a || "draft" : b || "draft";
    }
    function statusReport(root, statusOf, roleOf, commentsOf = () => 0) {
      const cards = /* @__PURE__ */ new Map();
      const tally = { revise: 0, unsplit: 0, draft: 0, done: 0 };
      const walk = (node) => {
        const role = roleFor(node, roleOf);
        if (role === "notes") return null;
        const prints = role === "prose";
        const set = statusOf(node.id);
        let own = null;
        if (prints) {
          own = commentsOf(node.id) > 0 || set === "revise" ? "revise" : set === "done" ? "done" : "draft";
        } else if (set === "unsplit") own = "unsplit";
        else if (commentsOf(node.id) > 0) own = "revise";
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
        const derived = prints ? null : node.children.length ? worst : null;
        const info = {
          prints,
          own,
          derived,
          below,
          worst: own && !prints ? worst && URGENCY[worst] > URGENCY[own] ? worst : own : worst
        };
        cards.set(node.id, info);
        return info;
      };
      for (const n of root.children) walk(n);
      return { cards, tally };
    }
    var NUM = "\\d+(?:\\.\\d+)?";
    var LIMIT = new RegExp(`^\\s*(${NUM}(?:\\s*/\\s*${NUM})?)\\s*(words?|characters?|chars?|pages?)\\s*$`, "i");
    function parseAmount(text) {
      const parts = String(text).split("/").map((s) => Number(s.trim()));
      if (parts.length === 1) return parts[0];
      if (parts.length === 2 && parts[1]) return parts[0] / parts[1];
      return NaN;
    }
    function parseLimit(value) {
      if (value === null || value === void 0 || value === "") return null;
      const m = LIMIT.exec(String(value));
      if (!m) return null;
      const amount = parseAmount(m[1]);
      if (!(amount > 0)) return null;
      const u = m[2].toLowerCase();
      const unit = u.startsWith("w") ? "words" : u.startsWith("p") ? "pages" : "characters";
      return { amount, unit };
    }
    function fmtNum(x) {
      return Number.isInteger(x) ? x.toLocaleString() : String(Math.round(x * 100) / 100);
    }
    function formatLimit(limit) {
      if (!limit) return "";
      const one = limit.amount === 1;
      const unit = limit.unit === "pages" ? one ? "page" : "pages" : limit.unit === "words" ? one ? "word" : "words" : one ? "character" : "characters";
      return `${fmtNum(limit.amount)} ${unit}`;
    }
    function convert(amount, from, to, wordsPerPage2, charsPerWord) {
      if (from === to) return { value: amount, estimated: false };
      const wpp = wordsPerPage2 || 500;
      const cpw = charsPerWord || 6;
      const words = from === "words" ? amount : from === "pages" ? amount * wpp : amount / cpw;
      const value = to === "words" ? words : to === "pages" ? words / wpp : words * cpw;
      return { value, estimated: true };
    }
    function quotas(root, quotaOf, countOf, opts = {}) {
      const wpp = opts.wordsPerPage || 500;
      const cpw = opts.charsPerWord || 6;
      const out = /* @__PURE__ */ new Map();
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
        return {
          quota,
          used,
          usedEstimated: quota.unit === "pages",
          allocated,
          allocatedEstimated,
          parts: parts.map((p) => p.id)
        };
      };
      if (opts.total) out.set(null, report(root, opts.total));
      for (const n of allNodes(root)) {
        const q = quotaOf(n.id);
        if (q) out.set(n.id, report(n, q));
      }
      return out;
    }
    function wordsPerPage(fm) {
      const measured = Number(fm.dendrite_measured_words_per_page);
      const set = Number(fm.dendrite_words_per_page);
      return {
        value: measured > 0 ? measured : set > 0 ? set : 500,
        measured: measured > 0 ? measured : null
      };
    }
    function countText(markdown, countSpaces) {
      const plain = stripComments(markdown).replace(/^\s*\|.*$/gm, " ").replace(/!\[\[[^\]]*\]\]/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[(@[^\]]+)\]/g, "cite").replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/gm, "").replace(/^\s*>\s?/gm, "").replace(/[*_`~=]+/g, "");
      const words = (plain.match(/\S+/g) || []).length;
      const collapsed = plain.replace(/\s+/g, " ").trim();
      const chars = countSpaces ? collapsed.length : collapsed.replace(/ /g, "").length;
      return { words, chars };
    }
    function measure(count, unit, wordsPerPage2) {
      if (unit === "words") return count.words;
      if (unit === "characters") return count.chars;
      return count.words / (wordsPerPage2 || 500) + (count.pages || 0);
    }
    var LINES_PER_PAGE = 46;
    var FIGURE_PAGE = 1 / 3;
    function countManuscript(nodes, bodyOf, roleOf, countSpaces, opts = {}) {
      const segs = exportSegments(nodes, bodyOf, 1, null, roleOf, opts);
      const { segments, notes } = renumberFootnotes(segs);
      const blocks = segments.map((x) => x.text).filter(Boolean);
      if (notes.length) blocks.push(footnoteBlock(notes));
      const n = countText(
        normaliseMarkdown(blocks.join("\n\n")),
        countSpaces
      );
      const heightOf = opts.heightOf || (() => null);
      let pages = 0;
      for (const sg of segs) {
        if (!sg.text) continue;
        const set = Number(heightOf(sg.id));
        if (set > 0) {
          pages += set;
          continue;
        }
        const lines = sg.text.split("\n");
        let run = 0;
        for (const l of [...lines, ""]) {
          if (TABLE_LINE.test(l)) {
            run += 1;
          } else if (run) {
            pages += (run + 2) / LINES_PER_PAGE;
            run = 0;
          }
          if (IMAGE_LINE.test(l)) pages += FIGURE_PAGE;
        }
      }
      return { words: n.words, chars: n.chars, pages };
    }
    function findPatterns(query, opts = {}) {
      const flags = "g" + (opts.matchCase ? "" : "i");
      const q = (query || "").trim();
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
        const t = m[1] !== void 0 ? m[1] : m[2];
        if (t) terms.push(t);
      }
      const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return { patterns: terms.map((t) => new RegExp(esc(t), flags)) };
    }
    var REVIEW_NOTE = new RegExp("%%(?:\\}[a-z0-9]+\\s+)?\\[!(review|suggest|reply)\\]\\s*([^%\\n]*?),\\s*\\d{4}-\\d{2}-\\d{2}:\\s?([\\s\\S]*?)%%", "g");
    function reviewText(body) {
      const out = [];
      REVIEW_NOTE.lastIndex = 0;
      let m;
      while ((m = REVIEW_NOTE.exec(body)) !== null) {
        const who = m.index + m[0].indexOf(m[2], 3);
        out.push([who, who + m[2].length, m[1]]);
        const at = m.index + m[0].length - 2 - m[3].length;
        const link = /\s+https?:\/\/\S+\s*$/.exec(m[3]);
        out.push([at, at + (link ? link.index : m[3].length), m[1]]);
      }
      return out;
    }
    function findMatches(ids, bodyOf, query, opts = {}) {
      const { patterns, error } = findPatterns(query, opts);
      const matches = [];
      if (!patterns.length) return { matches, error };
      const q = (query || "").trim().toLowerCase();
      for (const id of ids) {
        if (q && (q === shortId(id).toLowerCase() || q === id.toLowerCase())) {
          matches.push({
            id,
            start: 0,
            end: 0,
            comment: false,
            card: true
          });
        }
        const body = bodyOf(id) || "";
        const printed = opts.printed ? opts.printed(id, body) : null;
        if (printed && !printed.length) continue;
        const shown = reviewText(body);
        const notes = [];
        REVIEW_NOTE.lastIndex = 0;
        let rn;
        while ((rn = REVIEW_NOTE.exec(body)) !== null) {
          notes.push([rn.index, rn.index + rn[0].length]);
        }
        const counts = (a, b) => (!printed || printed.some(([x, y]) => a >= x && b <= y)) && (!notes.some(([x, y]) => a < y && b > x) || shown.some(([x, y]) => a >= x && b <= y));
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
            const end = m.index + m[0].length;
            if (!counts(m.index, end)) continue;
            hit = true;
            found.push({ start: m.index, end });
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
        found.sort((a, b) => a.start - b.start || b.end - a.end);
        let last = -1;
        for (const f of found) {
          if (f.start < last) continue;
          last = f.end;
          matches.push({
            id,
            start: f.start,
            end: f.end,
            comment: comments.some(
              ([a, b]) => f.start >= a && f.end <= b
            ),
            note: shown.some(([a, b, kind]) => kind !== "suggest" && f.start >= a && f.end <= b)
          });
        }
      }
      return { matches, error };
    }
    function printedRanges(body, role) {
      const text = String(body || "");
      let keep = [];
      if (role === "prose") keep = [[0, text.length]];
      else if (role === "section") {
        const m = /^\s*/.exec(text);
        const start = m[0].length;
        const nl = text.indexOf("\n", start);
        const end = nl < 0 ? text.length : nl;
        if (HEADING.test(text.slice(start, end))) keep = [[start, end]];
      }
      const out = [];
      const cre = /%%[\s\S]*?%%/g;
      for (const [a, b] of keep) {
        let at = a;
        cre.lastIndex = 0;
        let c;
        while ((c = cre.exec(text)) !== null) {
          const cs = c.index;
          const ce = cs + c[0].length;
          if (ce <= at || cs >= b) continue;
          if (cs > at) out.push([at, cs]);
          at = Math.max(at, ce);
        }
        if (at < b) out.push([at, b]);
      }
      return out;
    }
    function roundFingerprints(root, bodyOf, roleOf, crc) {
      const out = {};
      const walk = (node) => {
        const role = roleFor(node, roleOf);
        if (role === "notes") return;
        const body = bodyOf(node.id) || "";
        const text = printedRanges(body, role).map(([a, b]) => body.slice(a, b)).join("");
        if (text.trim()) out[node.id] = crc(text);
        node.children.forEach(walk);
      };
      root.children.forEach(walk);
      return out;
    }
    function changedSince(sent, now) {
      return new Set(Object.keys(now).filter((id) => sent[id] !== now[id]));
    }
    function shortId(id) {
      const s = String(id || "");
      return s.slice(s.lastIndexOf("-") + 1);
    }
    module2.exports = {
      findPatterns,
      findMatches,
      printedRanges,
      shortId,
      roundFingerprints,
      changedSince,
      parseLimit,
      formatLimit,
      countText,
      wordsPerPage,
      measure,
      sectionNumbers,
      alignColumns,
      fitHeights,
      tallTop,
      caretOffset,
      parseAmount,
      convert,
      quotas,
      fmtNum,
      splitText,
      mergeText,
      mergeIntoAbove,
      mergeIntoParent,
      moveNode,
      flowPath,
      threadPath,
      exportSegments,
      roleFor,
      cardRole,
      ROLES,
      KINDS,
      stackNotes,
      placeComments,
      textAt,
      scrollFor,
      withKinds,
      floatLabels,
      countManuscript,
      STATUSES,
      isFlag,
      leftover,
      lowerStatus,
      statusReport,
      normaliseMarkdown,
      renumberFootnotes,
      footnoteBlock,
      inlineToReferences,
      inlineFootnotes,
      footnoteLabel,
      gatherFootnotes,
      INDENT,
      splitFrontmatter,
      parseIndex,
      serialiseTree,
      writeIndexText,
      lineDiff,
      charDiff,
      printedOnly,
      deriveLabel,
      stripComments,
      validPrefix,
      newId,
      withPrefix,
      formerPrefixes,
      makeNode,
      makeRoot,
      insertSibling,
      appendChild,
      moveWithin,
      indent,
      outdent,
      remove,
      descendants,
      allNodes,
      columns,
      exportMarkdown,
      cleanLabel
    };
  }
});

// src/textedit.js
var require_textedit = __commonJS({
  "src/textedit.js"(exports2, module2) {
    "use strict";
    var INDENT = "    ";
    var LIST = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[.\]\s+)?/;
    function lineStart(text, i) {
      return text.lastIndexOf("\n", i - 1) + 1;
    }
    function lineEnd(text, i) {
      const j = text.indexOf("\n", i);
      return j < 0 ? text.length : j;
    }
    function wrap(text, s, e, mark) {
      const sel = text.slice(s, e);
      const n = mark.length;
      if (text.slice(s - n, s) === mark && text.slice(e, e + n) === mark) {
        return {
          start: s - n,
          end: e + n,
          text: sel,
          selStart: s - n,
          selEnd: e - n
        };
      }
      return {
        start: s,
        end: e,
        text: mark + sel + mark,
        selStart: s + n,
        selEnd: e + n
      };
    }
    function shiftLines(text, s, e, outdent) {
      const a = lineStart(text, s);
      const b = lineEnd(text, e > s && text[e - 1] === "\n" ? e - 1 : e);
      const lines = text.slice(a, b).split("\n");
      let firstDelta = 0;
      let total = 0;
      const out = lines.map((line, i) => {
        let delta;
        let next;
        if (outdent) {
          const m = /^( {1,4}|\t)/.exec(line);
          delta = m ? -m[0].length : 0;
          next = line.slice(-delta);
        } else {
          delta = INDENT.length;
          next = INDENT + line;
        }
        if (i === 0) firstDelta = delta;
        total += delta;
        return next;
      });
      return {
        start: a,
        end: b,
        text: out.join("\n"),
        selStart: Math.max(a, s + firstDelta),
        selEnd: Math.max(a, e + total)
      };
    }
    function enter(text, s, e) {
      if (s !== e) return null;
      const a = lineStart(text, s);
      const line = text.slice(a, lineEnd(text, s));
      const m = LIST.exec(line);
      if (!m) return null;
      if (line.trim() === m[0].trim()) {
        return {
          start: a,
          end: a + line.length,
          text: "",
          selStart: a,
          selEnd: a
        };
      }
      const marker = m[3] ? String(Number(m[3]) + 1) + m[4] : m[2];
      const task = m[6] ? "[ ] " : "";
      const insert = "\n" + m[1] + marker + m[5] + task;
      return {
        start: s,
        end: s,
        text: insert,
        selStart: s + insert.length,
        selEnd: s + insert.length
      };
    }
    module2.exports = { wrap, shiftLines, enter };
  }
});

// src/docx.js
var require_docx = __commonJS({
  "src/docx.js"(exports2, module2) {
    "use strict";
    var nodeBuffer = () => require("buffer").Buffer;
    var CRC_TABLE = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
          c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
        }
        t[n] = c >>> 0;
      }
      return t;
    })();
    function crc32(buf) {
      let c = 4294967295;
      for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ c >>> 8;
      return (c ^ 4294967295) >>> 0;
    }
    function readZip(buf, zlib) {
      let end = -1;
      for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 101010256) {
          end = i;
          break;
        }
      }
      if (end < 0) throw new Error("not a zip file");
      const count = buf.readUInt16LE(end + 10);
      let at = buf.readUInt32LE(end + 16);
      const out = [];
      for (let k = 0; k < count; k++) {
        if (buf.readUInt32LE(at) !== 33639248) {
          throw new Error("damaged zip directory");
        }
        const method = buf.readUInt16LE(at + 10);
        const size = buf.readUInt32LE(at + 20);
        const nameLen = buf.readUInt16LE(at + 28);
        const extraLen = buf.readUInt16LE(at + 30);
        const noteLen = buf.readUInt16LE(at + 32);
        const local = buf.readUInt32LE(at + 42);
        const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + size);
        out.push({
          name,
          data: method === 8 ? zlib.inflateRawSync(raw) : nodeBuffer().from(raw)
        });
        at += 46 + nameLen + extraLen + noteLen;
      }
      return out;
    }
    function writeZip(files, zlib) {
      const parts = [];
      const dir = [];
      let offset = 0;
      for (const f of files) {
        const name = nodeBuffer().from(f.name, "utf8");
        const packed = zlib.deflateRawSync(f.data);
        const crc = crc32(f.data);
        const head = nodeBuffer().alloc(30);
        head.writeUInt32LE(67324752, 0);
        head.writeUInt16LE(20, 4);
        head.writeUInt16LE(2048, 6);
        head.writeUInt16LE(8, 8);
        head.writeUInt32LE(crc, 14);
        head.writeUInt32LE(packed.length, 18);
        head.writeUInt32LE(f.data.length, 22);
        head.writeUInt16LE(name.length, 26);
        parts.push(head, name, packed);
        const entry = nodeBuffer().alloc(46);
        entry.writeUInt32LE(33639248, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(2048, 8);
        entry.writeUInt16LE(8, 10);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(packed.length, 20);
        entry.writeUInt32LE(f.data.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt32LE(offset, 42);
        dir.push(entry, name);
        offset += head.length + name.length + packed.length;
      }
      const dirBuf = nodeBuffer().concat(dir);
      const end = nodeBuffer().alloc(22);
      end.writeUInt32LE(101010256, 0);
      end.writeUInt16LE(files.length, 8);
      end.writeUInt16LE(files.length, 10);
      end.writeUInt32LE(dirBuf.length, 12);
      end.writeUInt32LE(offset, 16);
      return nodeBuffer().concat([...parts, dirBuf, end]);
    }
    var PAGE_TWIPS = { letter: [12240, 15840], a4: [11906, 16838] };
    var escapeXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    function styleXml(xml, st) {
      let out = xml.replace(/<w:color [^>]*\/>/g, '<w:color w:val="000000" />');
      if (st.font) {
        const f = escapeXml(st.font);
        out = out.replace(
          /<w:rFonts [^>]*w:asciiTheme="[^"]*"[^>]*\/>/g,
          `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}" />`
        );
      }
      if (st.fontSize && st.fontSize !== 12) {
        out = out.replace(
          /(<w:sz(?:Cs)? w:val=")(\d+)(")/g,
          (m, a, n, b) => a + Math.round(n * st.fontSize / 12) + b
        );
      }
      if (st.lineSpacing && Number(st.lineSpacing) !== 1) {
        const line = Math.round(240 * Number(st.lineSpacing));
        out = out.replace(
          /(<w:pPrDefault>\s*<w:pPr>\s*<w:spacing )/,
          `$1w:line="${line}" w:lineRule="auto" `
        );
        out = out.replace(
          /(<w:style [^>]*w:styleId="Compact"[^]*?<w:spacing )/,
          '$1w:line="240" w:lineRule="auto" '
        );
      }
      return out;
    }
    function pageXml(xml, st) {
      const [w, h] = PAGE_TWIPS[st.paper] || PAGE_TWIPS.letter;
      const m = Math.round((st.marginPt || 70.9) * 20);
      const sect = `<w:sectPr><w:pgSz w:w="${w}" w:h="${h}" /><w:pgMar w:top="${m}" w:right="${m}" w:bottom="${m}" w:left="${m}" w:header="720" w:footer="720" w:gutter="0" /></w:sectPr>`;
      const bare = xml.replace(/<w:sectPr[^]*?<\/w:sectPr>/g, "");
      return bare.replace(/<\/w:body>/, sect + "</w:body>");
    }
    function keepTables(xml, maxRows = 30) {
      return xml.replace(/<w:tbl>[^]*?<\/w:tbl>/g, (tbl) => {
        const rows = tbl.match(/<w:tr[ >][^]*?<\/w:tr>/g) || [];
        if (rows.length < 2 || rows.length > maxRows) return tbl;
        let k = 0;
        return tbl.replace(/<w:tr[ >][^]*?<\/w:tr>/g, (tr) => {
          const last = ++k === rows.length;
          let out = tr.replace(/<w:trPr>/, "<w:trPr><w:cantSplit />");
          if (out === tr) {
            out = tr.replace(
              /^(<w:tr[^>]*>)/,
              "$1<w:trPr><w:cantSplit /></w:trPr>"
            );
          }
          if (last) return out;
          return out.replace(
            /<w:p>(?!<w:pPr>)/g,
            "<w:p><w:pPr></w:pPr>"
          ).replace(
            /<w:pPr>(<w:pStyle [^>]*\/>)?/g,
            (m, style) => "<w:pPr>" + (style || "") + "<w:keepNext />"
          );
        });
      });
    }
    function reference(buf, st, zlib) {
      const files = readZip(buf, zlib).map((f) => {
        if (f.name === "word/styles.xml") {
          return {
            name: f.name,
            data: nodeBuffer().from(
              styleXml(f.data.toString("utf8"), st),
              "utf8"
            )
          };
        }
        if (f.name === "word/document.xml") {
          return {
            name: f.name,
            data: nodeBuffer().from(
              pageXml(f.data.toString("utf8"), st),
              "utf8"
            )
          };
        }
        return f;
      });
      return writeZip(files, zlib);
    }
    function keepDocument(buf, zlib) {
      return writeZip(
        readZip(buf, zlib).map((f) => f.name === "word/document.xml" ? {
          name: f.name,
          data: nodeBuffer().from(
            keepTables(f.data.toString("utf8")),
            "utf8"
          )
        } : f),
        zlib
      );
    }
    module2.exports = {
      crc32,
      readZip,
      writeZip,
      styleXml,
      pageXml,
      reference,
      keepTables,
      keepDocument
    };
  }
});

// src/review.js
var require_review = __commonJS({
  "src/review.js"(exports2, module2) {
    "use strict";
    var docx = require_docx();
    var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    function decode(s) {
      return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
        if (e[0] === "#") {
          const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return String.fromCodePoint(n);
        }
        return ENTITIES[e] !== void 0 ? ENTITIES[e] : m;
      });
    }
    function attr(attrs, name) {
      const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
      return m ? decode(m[1]) : null;
    }
    function* tokens(xml) {
      const re = /<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g;
      let m;
      while (m = re.exec(xml)) {
        if (m[5] !== void 0) yield { text: m[5] };
        else {
          yield {
            close: !!m[1],
            name: m[2],
            attrs: m[3],
            empty: !!m[4]
          };
        }
      }
    }
    var day = (iso) => iso ? iso.slice(0, 10) : "";
    var SECTION_NUMBER = /^\s*\d+(?:\.\d+)*\.?\s+/;
    function readBody(xml) {
      const paras = [];
      const ranges = /* @__PURE__ */ new Map();
      let para = null;
      let ins = null;
      let del = null;
      let inText = false;
      let cells = 0;
      const pos = () => ({ p: paras.length, o: para ? para.text.length : 0 });
      const addText = (t) => {
        if (!para) return;
        if (ins) {
          const last = para.changes[para.changes.length - 1];
          const at = para.text.length;
          if (last && last.author === ins.author && last.end === at) {
            last.insert += t;
          } else {
            para.changes.push({
              start: at,
              end: at,
              insert: t,
              author: ins.author,
              date: ins.date
            });
          }
          return;
        }
        const start = para.text.length;
        para.text += t;
        if (del) {
          const last = para.changes[para.changes.length - 1];
          if (last && last.author === del.author && last.end === start && !last.insert) {
            last.end = para.text.length;
          } else {
            para.changes.push({
              start,
              end: para.text.length,
              insert: "",
              author: del.author,
              date: del.date
            });
          }
        }
      };
      const unnumber = (p, k) => {
        const m = SECTION_NUMBER.exec(p.text);
        if (!m) return;
        const n = m[0].length;
        const back = (o) => Math.max(0, o - n);
        p.text = p.text.slice(n);
        for (const c of p.changes) {
          c.start = back(c.start);
          c.end = back(c.end);
        }
        for (const r of ranges.values()) {
          for (const at of [r.start, r.end]) {
            if (at && at.p === k) at.o = back(at.o);
          }
        }
      };
      for (const tk of tokens(xml)) {
        if (tk.text !== void 0) {
          if (inText) addText(decode(tk.text));
          continue;
        }
        const { name, close, empty, attrs } = tk;
        if (name === "w:p") {
          if (close) {
            if (para && para.heading) unnumber(para, paras.length);
            if (para) paras.push(para);
            para = null;
          } else if (!empty) {
            para = { text: "", changes: [], ...cells ? { cell: true } : {} };
          }
        } else if (name === "w:tc" && !empty) {
          cells += close ? -1 : 1;
        } else if (name === "w:pStyle" && para) {
          if (/^(heading\s*\d|title)$/i.test(attr(attrs, "w:val"))) {
            para.heading = true;
          }
        } else if (name === "w:ins" || name === "w:moveTo") {
          if (!empty) {
            ins = close ? null : {
              author: attr(attrs, "w:author"),
              date: day(attr(attrs, "w:date"))
            };
          }
        } else if (name === "w:del" || name === "w:moveFrom") {
          if (!empty) {
            del = close ? null : {
              author: attr(attrs, "w:author"),
              date: day(attr(attrs, "w:date"))
            };
          }
        } else if (name === "w:t" || name === "w:delText") {
          inText = !close && !empty;
        } else if ((name === "w:tab" || name === "w:br") && !close) {
          addText(name === "w:tab" ? "	" : " ");
        } else if (name === "w:commentRangeStart" || name === "w:commentRangeEnd") {
          const id = attr(attrs, "w:id");
          const r = ranges.get(id) || {};
          r[name === "w:commentRangeStart" ? "start" : "end"] = pos();
          ranges.set(id, r);
        } else if (name === "w:commentReference") {
          const id = attr(attrs, "w:id");
          const r = ranges.get(id) || {};
          if (!r.start) r.start = pos();
          if (!r.end) r.end = pos();
          ranges.set(id, r);
        }
      }
      for (const p of paras) {
        const out = [];
        for (const c of p.changes) {
          const last = out[out.length - 1];
          if (last && !last.insert && c.start === c.end && c.start === last.end && c.author === last.author) {
            last.insert = c.insert;
          } else {
            out.push(c);
          }
        }
        p.changes = out;
      }
      return { paras, ranges };
    }
    function readComments(xml) {
      const out = /* @__PURE__ */ new Map();
      let cur = null;
      let inText = false;
      let paras = [];
      for (const tk of tokens(xml || "")) {
        if (tk.text !== void 0) {
          if (cur && inText) {
            paras[paras.length - 1] += decode(tk.text);
          }
          continue;
        }
        if (tk.name === "w:comment") {
          if (tk.close) {
            out.set(cur.id, {
              author: cur.author,
              date: cur.date,
              when: cur.when,
              text: paras.map((x) => x.trim()).filter(Boolean).join(" ")
            });
            cur = null;
          } else {
            cur = {
              id: attr(tk.attrs, "w:id"),
              author: attr(tk.attrs, "w:author"),
              date: day(attr(tk.attrs, "w:date")),
              when: attr(tk.attrs, "w:date") || ""
            };
            paras = [];
          }
        } else if (tk.name === "w:p" && cur && !tk.close) {
          paras.push("");
        } else if (tk.name === "w:t") {
          inText = !tk.close && !tk.empty;
        }
      }
      return out;
    }
    var CONTEXT = 60;
    function readReview(buf, zlib) {
      const files = new Map(docx.readZip(buf, zlib).map((f) => [f.name, f.data.toString("utf8")]));
      const body = files.get("word/document.xml");
      if (!body) throw new Error("not a Word document");
      const { paras, ranges } = readBody(body);
      const notes = readComments(files.get("word/comments.xml"));
      const around = (p, s, q, e) => {
        let before = paras[p].text.slice(0, s);
        let after = paras[q].text.slice(e);
        for (let k = p - 1; paras[p].cell && k >= 0 && paras[k].cell && before.length < CONTEXT; k--) {
          before = `${paras[k].text} ${before}`;
        }
        for (let k = q + 1; paras[q].cell && k < paras.length && paras[k].cell && after.length < CONTEXT; k++) {
          after = `${after} ${paras[k].text}`;
        }
        return {
          before: tail(before, CONTEXT),
          after: after.slice(0, CONTEXT)
        };
      };
      const items = [];
      for (const [id, note] of notes) {
        const r = ranges.get(id);
        if (!r || !r.start || !paras[r.start.p]) continue;
        const end = r.end && paras[r.end.p] ? r.end : r.start;
        let quote = "";
        if (end.p === r.start.p) {
          quote = paras[r.start.p].text.slice(r.start.o, end.o);
        } else {
          const parts = [paras[r.start.p].text.slice(r.start.o)];
          for (let k = r.start.p + 1; k < end.p; k++) {
            parts.push(paras[k].text);
          }
          parts.push(paras[end.p].text.slice(0, end.o));
          quote = parts.join("\n");
        }
        items.push({
          kind: "comment",
          author: note.author,
          date: note.date,
          when: note.when,
          text: note.text,
          quote,
          ...around(r.start.p, r.start.o, end.p, end.o),
          at: [r.start.p, r.start.o],
          ...paras[r.start.p].heading ? { heading: true } : {}
        });
      }
      paras.forEach((p, k) => {
        for (const c of p.changes) {
          items.push({
            kind: "change",
            author: c.author,
            date: c.date,
            quote: p.text.slice(c.start, c.end),
            insert: c.insert,
            ...around(k, c.start, k, c.end),
            at: [k, c.start]
          });
        }
      });
      items.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
      linkGoogle(items, googleData(files));
      return items;
    }
    function protoFields(buf) {
      const out = [];
      let i = 0;
      const varint = () => {
        let v = 0;
        let scale = 1;
        for (; ; ) {
          const c = buf[i++];
          if (c === void 0) throw new Error("truncated");
          v += (c & 127) * scale;
          scale *= 128;
          if (c < 128) return v;
        }
      };
      while (i < buf.length) {
        const key = varint();
        const field = Math.floor(key / 8);
        const type = key % 8;
        if (type === 0) out.push([field, varint()]);
        else if (type === 2) {
          const n = varint();
          out.push([field, buf.subarray(i, i + n)]);
          i += n;
        } else if (type === 1) i += 8;
        else if (type === 5) i += 4;
        else throw new Error("unknown wire type");
      }
      return out;
    }
    function googleData(files) {
      for (const [name, xml] of files) {
        if (!/^customxml\//i.test(name)) continue;
        const m = /<go:docsCustomData[^>]*>([^<]+)</.exec(xml);
        if (!m) continue;
        try {
          const top = protoFields(Buffer.from(m[1], "base64"));
          const get = (fields, n) => (fields.find((f) => f[0] === n) || [])[1];
          const str = (b) => b ? Buffer.from(b).toString("utf8") : "";
          const comments = [];
          for (const [f, v] of top) {
            if (f !== 4 || typeof v === "number") continue;
            const rec = protoFields(v);
            const body = get(rec, 2);
            if (!body) continue;
            const b = protoFields(body);
            const text = (k) => {
              const part = get(b, k);
              return part ? str(get(protoFields(part), 2)) : "";
            };
            comments.push({
              id: str(get(rec, 1)),
              text: text(4) || text(3).replace(/<[^>]+>/g, ""),
              ms: get(b, 6) || 0
            });
          }
          return { docId: str(get(top, 14)), comments };
        } catch (err) {
          return null;
        }
      }
      return null;
    }
    function linkGoogle(items, g) {
      if (!g || !g.docId) return;
      const flatText = (t) => String(t || "").replace(/\s+/g, " ").trim();
      const groups = /* @__PURE__ */ new Map();
      for (const it of items) {
        if (it.kind !== "comment") continue;
        const key = `${it.author}\0${flatText(it.text)}\0` + (it.when || it.date);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
      }
      const used = /* @__PURE__ */ new Set();
      for (const group of groups.values()) {
        const it = group[0];
        const when = Date.parse(it.when || "");
        const near = g.comments.filter((c) => !used.has(c.id) && flatText(c.text) === flatText(it.text) && (!when || !c.ms || Math.abs(c.ms - when) < 12e4)).sort((a, b) => Math.abs(a.ms - when) - Math.abs(b.ms - when));
        if (!near.length) continue;
        used.add(near[0].id);
        const link = `https://docs.google.com/document/d/${g.docId}/edit?disco=${near[0].id}`;
        for (const x of group) Object.assign(x, { gid: near[0].id, link });
      }
    }
    function readReviewJson(text, today = /* @__PURE__ */ new Date()) {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : null;
      if (!list) throw new Error("not a list of items");
      const str = (v) => v == null ? "" : String(v);
      return list.map((x, k) => {
        if (!x || typeof x !== "object" || !str(x.text).trim()) {
          throw new Error(`item ${k + 1} has no text`);
        }
        const item = { kind: "comment" };
        if (x.card) item.card = str(x.card);
        return Object.assign(item, {
          quote: str(x.quote),
          before: str(x.before),
          after: str(x.after),
          text: str(x.text),
          author: str(x.author),
          date: str(x.date) || today.toISOString().slice(0, 10)
        });
      });
    }
    function plainMap(md) {
      let text = "";
      const map = [];
      const keep = (from, to) => {
        for (let k = from; k < to; k++) {
          text += md[k];
          map.push(k);
        }
      };
      const skipBracket = (i2) => {
        let depth = 0;
        for (let k = i2; k < md.length; k++) {
          if (md[k] === "[") depth++;
          else if (md[k] === "]" && --depth === 0) return k + 1;
        }
        return md.length;
      };
      let i = 0;
      let lineStart = true;
      while (i < md.length) {
        if (lineStart) {
          const rest = md.slice(i);
          const line = /^[^\n]*/.exec(rest)[0];
          if (/^\s*\|?\s*:?-{3,}/.test(line) && /\|/.test(line) || /^\[\^[^\]]+\]:/.test(line)) {
            i += line.length;
            continue;
          }
          const lead = new RegExp("^(\\s*(?:#{1,6}\\s+|>\\s?|[-*+]\\s+(?:\\[.\\]\\s+)?|\\d+[.)]\\s+))+").exec(line);
          if (lead) i += lead[0].length;
          lineStart = false;
          continue;
        }
        const c = md[i];
        if (c === "\n") {
          keep(i, i + 1);
          i++;
          lineStart = true;
          continue;
        }
        if (md.startsWith("%%", i)) {
          const end = md.indexOf("%%", i + 2);
          i = end < 0 ? md.length : end + 2;
          continue;
        }
        if (md.startsWith("[[", i)) {
          const end = md.indexOf("]]", i);
          if (end > 0) {
            const inner = md.slice(i + 2, end);
            const bar = inner.lastIndexOf("|");
            const shown = bar >= 0 ? i + 2 + bar + 1 : i + 2;
            const hash = bar >= 0 ? -1 : inner.indexOf("#");
            keep(shown, hash >= 0 ? i + 2 + hash : end);
            i = end + 2;
            continue;
          }
        }
        if (md.startsWith("^[", i)) {
          i = skipBracket(i + 1);
          continue;
        }
        if (c === "[" && (md[i + 1] === "@" || md[i + 1] === "^" || /^\[-?@/.test(md.slice(i, i + 3)))) {
          i = skipBracket(i);
          continue;
        }
        if (c === "[") {
          const close = skipBracket(i);
          if (md[close] === "(") {
            const end = md.indexOf(")", close);
            const inner = plainMap(md.slice(i + 1, close - 1));
            for (let k = 0; k < inner.text.length; k++) {
              text += inner.text[k];
              map.push(i + 1 + inner.map[k]);
            }
            i = end < 0 ? md.length : end + 1;
            continue;
          }
        }
        if (c === "\\" && i + 1 < md.length) {
          keep(i + 1, i + 2);
          i += 2;
          continue;
        }
        if (c === "<") {
          const end = md.indexOf(">", i);
          if (end > 0 && /^<\/?[a-z]/i.test(md.slice(i, i + 3))) {
            i = end + 1;
            continue;
          }
        }
        if ("*`~=".includes(c)) {
          i++;
          continue;
        }
        if (c === "_" && !(/\w/.test(md[i - 1] || "") && /\w/.test(md[i + 1] || ""))) {
          i++;
          continue;
        }
        if (c === "|") {
          text += " ";
          map.push(i);
          i++;
          continue;
        }
        keep(i, i + 1);
        i++;
      }
      return { text, map };
    }
    var QUOTES = {
      "\u2018": "'",
      "\u2019": "'",
      "\u201C": '"',
      "\u201D": '"',
      "\u2013": "-",
      "\u2014": "-",
      "\xA0": " "
    };
    function normalise(s) {
      let out = "";
      const map = [];
      let space = true;
      for (let k = 0; k < s.length; k++) {
        let c = QUOTES[s[k]] || s[k];
        if (/\s/.test(c)) {
          if (space) continue;
          c = " ";
          space = true;
        } else {
          space = false;
        }
        out += c.toLowerCase();
        map.push(k);
      }
      if (out.endsWith(" ")) {
        out = out.slice(0, -1);
        map.pop();
      }
      return { text: out, map };
    }
    var words = (s) => {
      const out = [];
      const re = /[\p{L}\p{N}]+/gu;
      let m;
      while (m = re.exec(s)) out.push({ w: m[0], at: m.index });
      return out;
    };
    function alignWords(wasText, nowText) {
      const was = words(wasText);
      const now = words(nowText);
      const low = (l) => l.map((x) => x.w.toLowerCase());
      return { was, now, match: lcs(low(was), low(now)).match };
    }
    function mapThrough(al, wasText, nowText, start, end) {
      const { was, now, match } = al;
      if (start === end) {
        for (let i = 0; i < was.length; i++) {
          if (was[i].at + was[i].w.length > start && match[i] >= 0 && was[i].at >= start) {
            return { start: now[match[i]].at, end: now[match[i]].at };
          }
        }
        for (let i = was.length - 1; i >= 0; i--) {
          if (was[i].at < start && match[i] >= 0) {
            const k = now[match[i]].at + now[match[i]].w.length;
            return { start: k, end: k };
          }
        }
        return null;
      }
      const inside = [];
      for (let i = 0; i < was.length; i++) {
        if (was[i].at < end && was[i].at + was[i].w.length > start) {
          inside.push(i);
        }
      }
      if (!inside.length) return null;
      for (let k = 0; k < inside.length; k++) {
        const j = match[inside[k]];
        if (j < 0 || k && j !== match[inside[k - 1]] + 1) return null;
      }
      const first = was[inside[0]];
      const last = was[inside[inside.length - 1]];
      const a = now[match[inside[0]]].at + Math.max(0, start - first.at);
      const lastNow = now[match[inside[inside.length - 1]]];
      const b = lastNow.at + Math.min(
        lastNow.w.length,
        end - last.at
      );
      const same = (x) => normalise(x).text;
      if (b <= a || same(nowText.slice(a, b)) !== same(wasText.slice(start, end))) return null;
      return { start: a, end: b };
    }
    function lcs(a, b) {
      const n = a.length;
      const m = b.length;
      const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
      for (let i2 = n - 1; i2 >= 0; i2--) {
        for (let j2 = m - 1; j2 >= 0; j2--) {
          dp[i2][j2] = a[i2] === b[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
        }
      }
      const match = new Array(n).fill(-1);
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          match[i] = j;
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          i++;
        } else {
          j++;
        }
      }
      return { length: dp[0][0], match };
    }
    var tail = (s, n) => s.slice(Math.max(0, s.length - n));
    function locate(item, cards) {
      if (item.card) {
        const short = (x) => String(x).slice(String(x).lastIndexOf("-") + 1);
        const k2 = short(item.card);
        cards = cards.filter((c) => short(c.id) === k2);
      }
      if (item.heading && item.quote) {
        const want = normalise(item.quote).text;
        cards = cards.filter((c) => String(c.text).split("\n").some((l) => /^#{1,6}\s/.test(l) && normalise(l.replace(/^#+\s*/, "")).text.includes(want)));
        if (!cards.length) return null;
      }
      const prepared = cards.map((c) => {
        const plain = plainMap(c.text);
        const norm = normalise(plain.text);
        return {
          id: c.id,
          plain,
          norm,
          src: (k2) => plain.map[norm.map[k2]]
        };
      });
      const quote = normalise(item.quote || "").text;
      const before = normalise(item.before || "").text;
      const after = normalise(item.after || "").text;
      const gap = !quote && /\s$/.test(item.before || "");
      const past = (c, k2) => {
        while (gap && c.norm.text[k2] === " ") k2++;
        return k2;
      };
      const wide = item.kind === "suggest" && quote;
      const grow = (c, s, e) => {
        if (wide && /\s$/.test(item.quote) && c.norm.text[e] === " ") e++;
        else if (wide && /^\s/.test(item.quote) && c.norm.text[s - 1] === " ") s--;
        return [s, e];
      };
      const found = [];
      const head = !quote && !before ? after.slice(0, 30) : "";
      const probe = quote || head || tail(before, 30);
      const least = probe.length >= 3 ? 0 : 8;
      if (probe.length >= 3 || quote && (before || after)) {
        for (const c of prepared) {
          let k2 = c.norm.text.indexOf(probe);
          while (k2 >= 0) {
            const s = quote || head ? k2 : k2 + probe.length;
            const e = quote ? k2 + probe.length : s;
            let score = 0;
            const pre2 = c.norm.text.slice(0, s);
            const post = c.norm.text.slice(e);
            const b = before.trimEnd();
            const a = after.trimStart();
            while (score < b.length && pre2.trimEnd()[pre2.trimEnd().length - 1 - score] === b[b.length - 1 - score]) score++;
            let sa = 0;
            while (sa < a.length && post.trimStart()[sa] === a[sa]) sa++;
            if (score + sa >= least) {
              found.push({ c, s, e, score: score + sa });
            }
            k2 = c.norm.text.indexOf(probe, k2 + 1);
          }
        }
      }
      if (found.length) {
        found.sort((x, y) => y.score - x.score);
        const best2 = found[0];
        if (found.length === 1 || best2.score > found[1].score) {
          if (!quote && !head) {
            const k2 = past(best2.c, best2.s);
            return place(best2.c, k2, k2, "exact");
          }
          return place(best2.c, ...grow(best2.c, best2.s, best2.e), "exact");
        }
      }
      const qw = words(quote);
      const bw = words(before).slice(-8);
      const aw = words(after).slice(0, 8);
      const query = [...bw, ...qw, ...aw].map((x) => x.w);
      if (query.length < 3) return null;
      const scored = prepared.map((c) => {
        const cw = words(c.norm.text);
        const r = lcs(query, cw.map((x) => x.w));
        return { c, cw, r, score: r.length / query.length };
      }).sort((x, y) => y.score - x.score);
      const best = scored[0];
      const next = scored[1];
      if (!best || best.score < 0.6 || next && best.score - next.score < 0.15) {
        return null;
      }
      const inQuote = best.r.match.slice(bw.length, bw.length + qw.length).filter((j) => j >= 0);
      if (qw.length && inQuote.length >= Math.ceil(qw.length / 2)) {
        const first = best.cw[inQuote[0]];
        const last = best.cw[inQuote[inQuote.length - 1]];
        return place(best.c, ...grow(
          best.c,
          first.at,
          last.at + last.w.length
        ), "close");
      }
      const pre = best.r.match.slice(0, bw.length).filter((j) => j >= 0);
      if (!pre.length) {
        const post = best.r.match.slice(bw.length + qw.length).filter((j) => j >= 0);
        if (!post.length || bw.length) return null;
        const w2 = best.cw[post[0]];
        return place(best.c, w2.at, w2.at, "close");
      }
      const w = best.cw[pre[pre.length - 1]];
      const k = past(best.c, w.at + w.w.length);
      return place(best.c, k, k, "close");
    }
    function place(c, s, e, how) {
      const start = s < c.norm.map.length ? c.src(s) : c.plain.map[c.plain.map.length - 1] + 1;
      const end = e > s ? c.src(e - 1) + 1 : start;
      return { id: c.id, start, end: e > s ? end : start, how };
    }
    var SCAN = new RegExp("%%\\{([a-z0-9]+)%%|(?:==([^=\\n]+?)==)?%%(?:\\}([a-z0-9]+)\\s+)?\\[!(review|suggest)\\]\\s*([\\s\\S]*?)%%((?:%%\\[!reply\\][\\s\\S]*?%%)*)", "g");
    function scan(md) {
      const opens = /* @__PURE__ */ new Map();
      const items = [];
      const syntax = [];
      SCAN.lastIndex = 0;
      let m;
      while (m = SCAN.exec(md)) {
        const at = m.index;
        const end = at + m[0].length;
        if (m[1] !== void 0) {
          opens.set(m[1], { start: at, end });
          syntax.push([at, end]);
          continue;
        }
        const [, , old, id, kind, body, replies] = m;
        const noteStart = old !== void 0 ? at + old.length + 4 : at;
        if (old !== void 0) syntax.push([at, at + 2]);
        syntax.push([old !== void 0 ? noteStart - 2 : noteStart, end]);
        const open = id !== void 0 && opens.get(id) || null;
        items.push({
          kind,
          old,
          id: open ? id : void 0,
          open,
          start: open ? open.start : at,
          noteStart,
          end,
          body,
          replies
        });
      }
      return { items, syntax };
    }
    function without(md, s, e, syntax) {
      let out = "";
      let at = s;
      for (const [a, b] of syntax) {
        if (b <= at || a >= e) continue;
        if (a > at) out += md.slice(at, a);
        at = Math.max(at, b);
      }
      return out + md.slice(at, Math.max(at, e));
    }
    var REPLY = /%%\[!reply\]\s*([\s\S]*?)%%/g;
    var HEAD = /^(.*?),\s*(\d{4}-\d{2}-\d{2}):\s?([\s\S]*)$/;
    function readReplies(chunk) {
      const out = [];
      REPLY.lastIndex = 0;
      let m;
      while (m = REPLY.exec(chunk || "")) {
        const h = HEAD.exec(m[1].replace(/^\s+/, ""));
        out.push({
          author: h ? h[1] : "",
          date: h ? h[2] : "",
          text: (h ? h[3] : m[1]).trim()
        });
      }
      return out;
    }
    function reviewItems(md) {
      const { items, syntax } = scan(md);
      return items.map((x) => {
        const h = HEAD.exec(x.body.replace(/^\s+/, ""));
        return {
          kind: x.kind,
          passage: x.open ? without(md, x.open.end, x.noteStart, syntax) : x.old || "",
          author: h ? h[1] : "",
          date: h ? h[2] : "",
          text: h ? x.kind === "suggest" ? h[3] : h[3].trim() : x.body.trim(),
          replies: readReplies(x.replies),
          start: x.start,
          end: x.end,
          noteStart: x.noteStart,
          ...x.open ? { id: x.id, open: x.open } : {}
        };
      });
    }
    function addReply(md, n, reply) {
      const it = reviewItems(md)[n];
      if (!it) return md;
      const note = `%%[!reply] ${clean(reply.author) || "Me"}, ${reply.date}: ${clean(reply.text)}%%`;
      return md.slice(0, it.end) + note + md.slice(it.end);
    }
    function threadId(it) {
      return docx.crc32(Buffer.from(
        [
          it.kind,
          it.author,
          it.date,
          flat(it.passage || ""),
          flat(it.text || "")
        ].join("\0"),
        "utf8"
      )).toString(16);
    }
    function threadIds(items) {
      const seen = /* @__PURE__ */ new Map();
      return items.map((it) => {
        const id = threadId(it);
        const k = (seen.get(id) || 0) + 1;
        seen.set(id, k);
        return k === 1 ? id : `${id}.${k}`;
      });
    }
    var TO = /^@(\S+)\s+([\s\S]*)$/;
    function addressed(r) {
      const m = TO.exec(r.text || "");
      return m ? { to: m[1], text: m[2] } : { to: null, text: r.text || "" };
    }
    function awaits(it, name, self) {
      const rs = it.replies || [];
      const to = (x) => addressed(x).to === name;
      const mine = self.has(it.author);
      const asked = it.author === name || mine && to(it);
      if (mine && !asked && !rs.some(to)) return false;
      let j = rs.length - 1;
      while (j >= 0 && rs[j].author !== name) j--;
      if (j < 0 && it.author !== name) return true;
      return rs.slice(j + 1).some((r) => asked || !self.has(r.author) || to(r));
    }
    function fillAddressed(el, text, colourOf = null) {
      const { to, text: rest } = addressed({ text });
      if (!to) {
        el.textContent = text;
        return;
      }
      const doc = el.ownerDocument;
      const at = doc.createElement("span");
      const c = colourOf && colourOf(to);
      at.className = "dendrite-review-to" + (c ? ` is-c-${c}` : "");
      at.textContent = `@${to}`;
      el.textContent = "";
      el.append(at, ` ${rest}`);
    }
    function replyRow(doc, r, nameOf = null, colourOf = null) {
      const el = doc.createElement("div");
      const rc = colourOf && colourOf(r.author || "Me");
      const seen = !String(r.text || "").trim();
      el.className = "dendrite-review-reply" + (seen ? " is-seen" : "") + (rc ? ` is-c-${rc}` : "");
      const by = doc.createElement("div");
      by.className = "dendrite-review-meta";
      const b = doc.createElement("b");
      shownAs(b, r.author || "Me", nameOf);
      if (seen) {
        const tick = doc.createElement("span");
        tick.className = "dendrite-review-check";
        tick.textContent = "\u2713 ";
        by.append(tick);
      }
      by.append(b, ` \xB7 ${shortDate(r.date)}`);
      el.append(by);
      if (seen) {
        el.title = `${b.textContent} read this on ${shortDate(r.date)} and had nothing to add`;
        return el;
      }
      const said = doc.createElement("div");
      said.className = "dendrite-review-text";
      fillAddressed(said, r.text, colourOf);
      el.append(said);
      return el;
    }
    function forReviewers(items, self) {
      const mine = (who) => self.has(who) || who === "Claude";
      return items.filter((it) => !mine(it.author)).map((it) => ({
        ...it,
        replies: (it.replies || []).filter((r) => r.author !== "Claude" && addressed(r).to !== "Claude")
      }));
    }
    function replaceReplies(md, n, name, reply) {
      const it = reviewItems(md)[n];
      const rs = it ? it.replies : [];
      let k = rs.length;
      while (k > 0 && rs[k - 1].author === name) k--;
      if (k === rs.length) return null;
      let out = md;
      for (let x = rs.length - 1; x >= k; x--) out = removeReply(out, n, x);
      return addReply(out, n, reply);
    }
    function removeReply(md, n, k) {
      const it = reviewItems(md)[n];
      if (!it) return md;
      const whole = md.slice(it.noteStart, it.end);
      REPLY.lastIndex = 0;
      let m;
      let i = 0;
      while (m = REPLY.exec(whole)) {
        if (whole.slice(0, m.index).endsWith("%%") && i++ === k) {
          return md.slice(0, it.noteStart + m.index) + md.slice(it.noteStart + m.index + m[0].length);
        }
      }
      return md;
    }
    var clean = (s, edges = false) => {
      const t = String(s || "").replace(/%%/g, "%").replace(/\s*\n\s*/g, " ");
      return edges ? t : t.trim();
    };
    var looseText = (passage, text) => `replace "${clean(passage)}" with "${clean(text)}"`;
    var LINK = /\s+(https:\/\/docs\.google\.com\/\S+)$/;
    function noteLink(text) {
      const m = LINK.exec(String(text || ""));
      return m ? { text: text.slice(0, m.index), url: m[1] } : { text: String(text || ""), url: "" };
    }
    var flat = (t) => clean(t).replace(/\s+/g, " ");
    function reviewKeys(it) {
      const author = clean(it.author) || "Reviewer";
      const keys = [];
      const hash = (s) => docx.crc32(Buffer.from(s, "utf8")).toString(16);
      const change = (out, put) => "s:" + hash(`${author}\0${flat(out)}\0${flat(put)}`);
      const comment = (text2) => "c:" + hash(`${author}\0${flat(text2).replace(/^On “[^”]*”(?:, in an earlier version)?: /, "")}`);
      if (it.kind === "change" || it.kind === "suggest") {
        const out = it.kind === "change" ? it.quote : it.passage;
        const put = it.kind === "change" ? it.insert : it.text;
        keys.push(change(out, put));
        if (it.kind === "change") keys.push(comment(changeAsComment(it)));
        return keys;
      }
      const { text, url } = noteLink(it.text);
      const gid = it.gid || (/[?&]disco=([\w.-]+)/.exec(url || it.link || "") || [])[1];
      if (gid) keys.push(`g:${gid}`);
      keys.push(comment(text));
      const bare = flat(text).replace(
        /^On “[^”]*”(?:, in an earlier version)?: /,
        ""
      );
      const was = WENT_IN.map((re) => re.exec(bare)).find(Boolean);
      if (was) keys.push(change(
        was[2] === void 0 ? "" : was[1],
        was[2] === void 0 ? was[1] : was[2]
      ));
      return keys;
    }
    function changeAsComment(it) {
      return (it.quote ? `Suggested replacing \u201C${it.quote}\u201D with \u201C${String(it.insert || "").trim()}\u201D` : `Suggested adding \u201C${String(it.insert || "").trim()}\u201D`) + ". The text has changed here since it was sent.";
    }
    var CHANGED = "\\. The text has changed here since it was sent\\.$";
    var WENT_IN = [
      new RegExp(`^Suggested adding \u201C(.*)\u201D${CHANGED}`),
      new RegExp(`^Suggested replacing \u201C(.*)\u201D with \u201C(.*)\u201D${CHANGED}`),
      /^replace "(.*)" with "(.*)"$/
    ];
    function linkless(md, item) {
      if (!item.link || item.kind === "change") return null;
      const author = clean(item.author) || "Reviewer";
      const text = flat(item.text);
      return reviewItems(md).find((x) => {
        if (x.kind === "suggest" || x.author !== author) return false;
        const { text: said, url } = noteLink(x.text);
        if (url) return false;
        const had = flat(said);
        return had === text || had.endsWith(`: ${text}`);
      }) || null;
    }
    function needsLink(md, item) {
      return !!linkless(md, item);
    }
    function addLink(md, item) {
      const x = linkless(md, item);
      if (!x) return md;
      const seg = md.slice(x.start, x.end);
      return md.slice(0, x.start) + seg.slice(0, -2) + ` ${item.link}%%` + md.slice(x.end);
    }
    function alreadyIn(md, item) {
      const author = clean(item.author) || "Reviewer";
      const keys = reviewKeys(item);
      return reviewItems(md).some((x) => {
        if (item.gid && reviewKeys(x).includes(`g:${item.gid}`)) {
          return true;
        }
        if (x.author !== author) return false;
        if (item.kind === "change") {
          return x.kind === "suggest" ? x.text === clean(item.insert, true) : x.text === looseText(item.quote, item.insert);
        }
        const text = flat(item.text);
        const had = flat(noteLink(x.text).text);
        return had === text || had.endsWith(`: ${text}`) || reviewKeys(x).some((k) => keys.includes(k));
      });
    }
    function suggestInto(md, id, s) {
      const author = clean(s.author) || "Claude";
      if (typeof s.replace !== "string") {
        return { reason: 'no replace: the new text, or "" to delete' };
      }
      const quote = String(s.quote || "");
      if (!quote.trim()) return { reason: "no quote" };
      if (alreadyIn(md, {
        kind: "change",
        author,
        quote,
        insert: s.replace
      })) {
        return { reason: "already suggested" };
      }
      const at = locate({
        kind: "suggest",
        quote,
        before: s.before,
        after: s.after
      }, [{ id, text: md }]);
      if (!at || at.how !== "exact") {
        const hay = normalise(plainMap(md).text).text;
        const want = normalise(quote).text;
        let n = 0;
        for (let k = hay.indexOf(want); k >= 0; k = hay.indexOf(want, k + 1)) n++;
        return { reason: n > 1 ? `found ${n} times, so more than once; send before or after to say which` : "not found exactly in the card" };
      }
      return { md: addItems(md, [{
        kind: "suggest",
        start: at.start,
        end: at.end,
        author,
        date: s.date,
        text: s.replace
      }]) };
    }
    function itemText(kind, passage, author, date, text) {
      const note = `%%[!${kind}] ${clean(author) || "Reviewer"}, ${date}: ${clean(text, kind === "suggest")}%%`;
      return passage ? `==${passage}==${note}` : note;
    }
    function addItems(md, adds) {
      const pending = [...adds].map((a) => ({ ...a })).sort((a, b) => b.end - a.end || b.start - a.start);
      let out = md;
      const edit = (pos, del, ins) => {
        out = out.slice(0, pos) + ins + out.slice(pos + del);
        const move = (p) => p <= pos ? p : p >= pos + del ? p + ins.length - del : pos + ins.length;
        for (const a of pending) {
          a.start = move(a.start);
          a.end = move(a.end);
        }
      };
      while (pending.length) {
        const a = pending[0];
        const point = a.end === a.start;
        const items = reviewItems(out);
        const over = items.filter((x) => point ? x.start < a.end && a.end < x.end : a.start < x.end && x.start < a.end);
        const markable = !point && (a.kind !== "suggest" || balanced(stripReview(out.slice(a.start, a.end))));
        let text = a.text;
        let kind = a.kind;
        if (markable) {
          for (const x of over.filter((y) => !y.open).sort((p, q) => q.start - p.start)) {
            const id2 = nextId(out);
            edit(x.noteStart - 2, 4, `%%}${id2} `);
            edit(x.start, 2, `%%{${id2}%%`);
          }
          snapOut(out, a);
          const id = nextId(out);
          edit(a.end, 0, itemText(kind, "", a.author, a.date, text).replace(/^%%/, `%%}${id} `));
          edit(a.start, 0, `%%{${id}%%`);
          pending.shift();
          continue;
        }
        const loose = kind === "suggest" && !point;
        if (loose) {
          text = looseText(a.quote || out.slice(a.start, a.end), a.text);
          kind = "review";
        }
        const inside = items.filter((x) => x.open ? x.noteStart < a.end && a.end < x.end : x.start < a.end && a.end < x.end);
        const at = Math.max(a.end, ...inside.map((x) => x.end));
        edit(at, 0, itemText(kind, "", a.author, a.date, text));
        pending.shift();
      }
      return out;
    }
    function oldComments(md) {
      return scan(md).items.filter((x) => x.old !== void 0).length;
    }
    function convertOld(md) {
      const olds = scan(md).items.filter((x) => x.old !== void 0);
      const first = Number(nextId(md));
      let out = md;
      for (let k = olds.length - 1; k >= 0; k--) {
        const x = olds[k];
        const id = String(first + k);
        out = out.slice(0, x.noteStart - 2) + `%%}${id} ` + out.slice(x.noteStart + 2);
        out = out.slice(0, x.start) + `%%{${id}%%` + out.slice(x.start + 2);
      }
      return out;
    }
    function nextId(md) {
      let n = 0;
      for (const m of md.matchAll(/%%[{}](\d+)/g)) n = Math.max(n, +m[1]);
      return String(n + 1);
    }
    function balanced(t) {
      const count = (re) => (t.match(re) || []).length;
      return count(/\*\*/g) % 2 === 0 && count(/`/g) % 2 === 0 && count(/\[\[/g) === count(/\]\]/g) && count(/\[/g) === count(/\]/g);
    }
    function snapOut(md, a) {
      const spans = scan(md).syntax.slice();
      const re = /\[\[[^\]\n]*\]\]|`[^`\n]*`|\^?\[[@^-][^\]\n]*\]|<[^>\n]+>/g;
      let m;
      while (m = re.exec(md)) spans.push([m.index, m.index + m[0].length]);
      for (const [s, e] of spans) {
        if (s < a.start && a.start < e) a.start = s;
        if (s < a.end && a.end < e) a.end = e;
      }
    }
    function removeItem(md, n, apply = false) {
      const it = reviewItems(md)[n];
      if (!it) return md;
      if (apply && it.kind === "suggest") return applied(md, it).out;
      if (!it.open) return md.slice(0, it.start) + it.passage + md.slice(it.end);
      return md.slice(0, it.open.start) + md.slice(it.open.end, it.noteStart) + md.slice(it.end);
    }
    function applied(md, it) {
      if (!it.open) {
        const out2 = md.slice(0, it.start) + it.text + md.slice(it.end);
        return tidySpan(out2, it.start, it.start + it.text.length);
      }
      const { syntax } = scan(md);
      const kept = syntax.filter(([a, b]) => a >= it.open.end && b <= it.noteStart).map(([a, b]) => md.slice(a, b)).join("");
      const out = md.slice(0, it.open.start) + it.text + kept + md.slice(it.end);
      const s = it.open.start;
      return tidySpan(out, s, s + it.text.length + kept.length);
    }
    function keptReplies(it) {
      return (it.replies || []).filter((x) => x.text);
    }
    function applyKeeping(md, n) {
      const it = reviewItems(md)[n];
      if (!it || it.kind !== "suggest" || !keptReplies(it).length) {
        return removeItem(md, n, true);
      }
      let { out, start, end } = applied(md, it);
      while (start < end && /\s/.test(out[start])) start++;
      while (end > start && /\s/.test(out[end - 1])) end--;
      const text = it.passage.trim() ? `Applied. Was \u201C${clean(it.passage)}\u201D.` : "Applied, as an addition.";
      out = addItems(out, [{
        kind: "review",
        start,
        end,
        author: it.author,
        date: it.date,
        text
      }]);
      const k = reviewItems(out).findIndex((x) => x.kind === "review" && x.author === (clean(it.author) || "Reviewer") && x.text === text && x.start >= start - 2);
      for (const x of keptReplies(it)) out = addReply(out, k, x);
      return out;
    }
    function tidySpan(out, start, end) {
      if (out[end - 1] === " " && /^[ .,;:!?)]/.test(out.slice(end))) {
        out = out.slice(0, end - 1) + out.slice(end);
        if (start >= end) start--;
        end--;
      }
      if (out[start - 1] === " " && out[start] === " ") {
        out = out.slice(0, start - 1) + out.slice(start);
        start--;
        end--;
      }
      return { out, start, end };
    }
    function editorRanges(md) {
      const items = reviewItems(md);
      const hide = items.filter((x) => x.open).map((x) => [x.open.start, x.open.end]).sort((a, b) => a[0] - b[0]);
      const numbers = /* @__PURE__ */ new Map();
      let n = 0;
      const firsts = firstOfComment(items);
      const chips = items.map((x, i) => {
        const g = googleOf(x);
        let num = g && numbers.get(g);
        if (!num) {
          num = ++n;
          if (g) numbers.set(g, num);
        }
        return {
          from: x.noteStart,
          to: x.end,
          n: num,
          author: x.author,
          date: x.date,
          kind: x.kind,
          text: x.text,
          passage: !!x.passage,
          replies: x.replies,
          first: firsts[i] === i
        };
      });
      const marks = items.filter((x) => x.open).map((x) => ({
        from: x.open.end,
        to: x.noteStart,
        author: x.author,
        kind: x.kind
      }));
      const protect = [...hide, ...chips.map((c) => [c.from, c.to])].sort((a, b) => a[0] - b[0]);
      return { hide, chips, marks, protect };
    }
    function passagesLost(before, after) {
      const key = (x) => `${x.kind}\0${x.author}\0${x.date}\0` + x.text;
      const had = /* @__PURE__ */ new Map();
      for (const x of reviewItems(before)) {
        if (!x.passage.trim()) continue;
        had.set(key(x), (had.get(key(x)) || 0) + 1);
      }
      const lost = [];
      reviewItems(after).forEach((x, i) => {
        const k = key(x);
        if (x.passage.trim() || !had.get(k)) return;
        had.set(k, had.get(k) - 1);
        lost.push({ n: i + 1, author: x.author, text: x.text });
      });
      return lost;
    }
    function stripReview(md) {
      return without(md, 0, md.length, scan(md).syntax);
    }
    var MONTHS = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec"
    ];
    function shortDate(iso) {
      const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso || "");
      return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1]}` : iso || "";
    }
    function googleOf(it) {
      if (it.kind === "suggest" || it.kind === "change") return null;
      return reviewKeys(it).find((k) => k.startsWith("g:")) || null;
    }
    function firstOfComment(items) {
      const seen = /* @__PURE__ */ new Map();
      return items.map((it, i) => {
        const g = googleOf(it);
        if (!g) return i;
        if (!seen.has(g)) seen.set(g, i);
        return seen.get(g);
      });
    }
    function countComments(items) {
      return firstOfComment(items).filter((f, i) => f === i).length;
    }
    function renderMarkdown(md, colourOf = null) {
      let n = 0;
      const numbers = /* @__PURE__ */ new Map();
      const { items } = scan(md);
      const byId = new Map(items.filter((x) => x.id).map((x) => [x.id, x]));
      const tintOf = (body) => {
        const h = HEAD.exec(body.replace(/^\s+/, ""));
        const c = colourOf && h ? colourOf(h[1]) : null;
        return c ? ` is-c-${c}` : "";
      };
      SCAN.lastIndex = 0;
      let item = -1;
      return md.replace(SCAN, (m, openId, passage, id, kind, body) => {
        if (openId !== void 0) {
          const it = byId.get(openId);
          if (!it) return "";
          return `<span class="dendrite-review-from dendrite-rid-${openId}${it.kind === "suggest" ? " is-suggest" : ""}${tintOf(it.body)}"></span>`;
        }
        const g = kind === "review" ? googleOf({ kind, text: (HEAD.exec(body.replace(/^\s+/, "")) || [])[3] || body }) : null;
        let num;
        if (g && numbers.has(g)) num = numbers.get(g);
        else {
          num = ++n;
          if (g) numbers.set(g, num);
        }
        const h = HEAD.exec(body.replace(/^\s+/, ""));
        const text = h ? h[3] : body.trim();
        const tint = tintOf(body);
        const marked = id !== void 0 && byId.has(id);
        const rid = marked ? ` dendrite-rid-${id}` : "";
        const cls = (kind === "suggest" ? " is-suggest" : "") + tint;
        item++;
        const sup = `<sup class="dendrite-review-n${cls}${rid} dendrite-item-${item}">${num}</sup>`;
        const upto = marked ? `<span class="dendrite-review-upto${rid}"></span>` : "";
        if (kind === "suggest" && (marked || !passage)) {
          if (marked && !text) return upto + sup;
          const lead = /^\s*/.exec(text)[0];
          const gap = lead && marked ? `<span class="dendrite-review-lead">${lead}</span>` : lead;
          return `${upto}${gap}<span class="dendrite-review-new${tint}${rid}">${text.slice(lead.length)}</span>${sup}`;
        }
        if (marked) return upto + sup;
        if (!passage) return sup;
        if (kind === "suggest") {
          const added = text ? `<span class="dendrite-review-new${tint}">${text}</span>` : "";
          return `<span class="dendrite-review-old${tint}">${passage}</span>` + added + sup;
        }
        return `<mark class="dendrite-review-mark${tint}">${passage}</mark>` + sup;
      });
    }
    function passageEls(root, n) {
      const sup = root.querySelector(`sup.dendrite-item-${n}`);
      if (!sup) return [];
      const rid = [...sup.classList].find((c) => c.startsWith("dendrite-rid-"));
      if (rid) {
        return [...root.querySelectorAll(`.${rid}`)].filter((x) => !/\bdendrite-review-(from|upto)\b/.test(x.className));
      }
      const out = [sup];
      for (let p = sup.previousElementSibling; p && /\bdendrite-review-(mark|old|new)\b/.test(p.className); p = p.previousElementSibling) out.unshift(p);
      return out;
    }
    function wrapPassages(root) {
      const doc = root.ownerDocument;
      const SHOW_TEXT = 4;
      for (const from of root.querySelectorAll("span.dendrite-review-from")) {
        const rid = [...from.classList].find((c) => c.startsWith("dendrite-rid-"));
        const upto = rid && root.querySelector(
          `span.dendrite-review-upto.${rid}`
        );
        if (!upto) continue;
        const texts = [];
        const walk = doc.createTreeWalker(root, SHOW_TEXT);
        for (let t = walk.nextNode(); t; t = walk.nextNode()) {
          if (!(from.compareDocumentPosition(t) & 4) || !(upto.compareDocumentPosition(t) & 2)) continue;
          if (t.parentElement.closest("sup.dendrite-review-n, .dendrite-review-new, .dendrite-review-lead")) continue;
          if (!t.nodeValue.trim() && t.nodeValue.includes("\n")) continue;
          texts.push(t);
        }
        const suggest = from.classList.contains("is-suggest");
        const tint = [...from.classList].filter((c) => c.startsWith("is-c-"));
        for (const t of texts) {
          const w = doc.createElement(suggest ? "span" : "mark");
          w.className = [suggest ? "dendrite-review-old" : "dendrite-review-mark", ...tint, rid].join(" ");
          t.parentNode.insertBefore(w, t);
          w.appendChild(t);
        }
      }
    }
    var REVIEWER_COLOURS = [
      "blue",
      "green",
      "purple",
      "orange",
      "cyan",
      "pink",
      "yellow",
      "red",
      "grey"
    ];
    var GIVEN_COLOURS = REVIEWER_COLOURS.filter((c) => c !== "grey");
    function colourCss(c) {
      return c === "grey" ? "var(--text-muted)" : `var(--color-${c})`;
    }
    function reviewerColours(list) {
      const out = /* @__PURE__ */ new Map();
      for (const [name, , c] of colourEntries(list)) {
        if (REVIEWER_COLOURS.includes(c)) out.set(name, c);
      }
      return out;
    }
    function colourEntries(list) {
      const out = [];
      for (const x of Array.isArray(list) ? list : []) {
        const m = /^(.+):\s*([a-z]+)\s*$/.exec(String(x).trim());
        if (!m) continue;
        const written = m[1].trim();
        const link = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/.exec(written);
        const note = link ? link[1].trim() : null;
        const name = link ? (link[2] || "").trim() || note.split("/").pop() : written;
        out.push([name, written, m[2], note]);
      }
      return out;
    }
    function reviewerNames(list) {
      const out = /* @__PURE__ */ new Map();
      for (const [name, , , note] of colourEntries(list)) {
        if (note) out.set(name, note.split("/").pop());
      }
      return out;
    }
    function reviewerEntries(list) {
      return colourEntries(list).filter(([, , c]) => REVIEWER_COLOURS.includes(c)).map(([name, , colour, note]) => ({ name, note, colour }));
    }
    function entryList(entries) {
      return entries.map(({ name, note, colour }) => {
        if (!note) return `${name}: ${colour}`;
        const base = note.split("/").pop();
        return `[[${note}${base === name ? "" : `|${name}`}]]: ${colour}`;
      });
    }
    function colourList(map, prior = []) {
      const written = new Map(colourEntries(prior).map(([n, w]) => [n, w]));
      return [...map].map(([name, c]) => `${written.get(name) || name}: ${c}`);
    }
    function assignColours(map, names) {
      const out = new Map(map);
      let added = false;
      for (const name of names) {
        if (!name || out.has(name)) continue;
        const taken = new Set(out.values());
        out.set(name, GIVEN_COLOURS.find((c) => !taken.has(c)) || GIVEN_COLOURS[out.size % GIVEN_COLOURS.length]);
        added = true;
      }
      return { map: out, added };
    }
    function commentActions(it) {
      return it.kind === "suggest" ? [["apply", "Apply\u2026", ""], ["dismiss", "Dismiss", ""]] : [["resolve", "Resolve", "Dealt with: taken out, and not brought back by a pull"]];
    }
    function commentMenu(it) {
      return [...commentActions(it).map(([what, label]) => [what, label, false]), ["delete", "Delete from Dendrite", true]];
    }
    function replyBox(parent, send, typing = null, start = "") {
      const doc = parent.ownerDocument;
      const old = parent.querySelector(":scope > .dendrite-review-reply-form");
      if (old) {
        old.querySelector("textarea").focus();
        return old;
      }
      const form = doc.createElement("div");
      form.className = "dendrite-review-reply-form";
      const box = doc.createElement("textarea");
      box.className = "dendrite-review-reply-box";
      box.rows = 2;
      box.placeholder = "Reply";
      box.value = start;
      const row = doc.createElement("div");
      row.className = "dendrite-review-reply-btns";
      const go = doc.createElement("button");
      go.className = "dendrite-review-btn mod-cta";
      go.textContent = "Send";
      const no = doc.createElement("button");
      no.className = "dendrite-review-btn";
      no.textContent = "Cancel";
      const done = () => {
        box.blur();
        form.remove();
      };
      go.onclick = async (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const t = box.value.trim();
        if (!t) return;
        done();
        await send(t);
      };
      no.onclick = (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        done();
      };
      box.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          go.onclick();
        } else if (e.key === "Escape") {
          e.preventDefault();
          done();
        }
        e.stopPropagation();
      });
      for (const ev of ["click", "dblclick", "pointerdown"]) {
        form.addEventListener(ev, (e) => e.stopPropagation());
      }
      row.append(go, no);
      form.append(box, row);
      parent.append(form);
      if (typing) typing(box);
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      return form;
    }
    function shownAs(el, name, nameOf) {
      const shown = nameOf && nameOf(name) || name;
      el.textContent = shown;
      if (shown !== name) el.title = `As written: ${name}`;
    }
    function decorate(root, items, act, onMenu = null, colourOf = null, typing = null, nameOf = null) {
      const nums = [...root.querySelectorAll("sup.dendrite-review-n")];
      const doc = root.ownerDocument;
      const blocks = /* @__PURE__ */ new Map();
      const blockOf = (el) => {
        let b = el;
        while (b.parentElement && b.parentElement !== root) {
          b = b.parentElement;
        }
        return b.parentElement === root ? b : null;
      };
      const first = firstOfComment(items);
      const passages = (i) => first.filter((f) => f === i).length;
      items.forEach((it, i) => {
        if (first[i] !== i) return;
        const sup = nums[i];
        const b = sup ? blockOf(sup) : null;
        if (!blocks.has(b)) blocks.set(b, []);
        blocks.get(b).push(i);
      });
      const noteOf2 = /* @__PURE__ */ new Map();
      for (const [b, list] of blocks) {
        const box = doc.createElement("div");
        box.className = "dendrite-review-notes";
        for (const i of list) {
          const it = items[i];
          const note = doc.createElement("div");
          const c = colourOf && colourOf(it.author || "Reviewer");
          note.className = "dendrite-review-note" + (it.kind === "suggest" ? " is-suggest" : "") + (c ? ` is-c-${c}` : "");
          const n = doc.createElement("span");
          n.className = "dendrite-review-n";
          n.textContent = nums[i] ? nums[i].textContent : String(i + 1);
          const main = doc.createElement("div");
          main.className = "dendrite-review-main";
          const meta = doc.createElement("div");
          meta.className = "dendrite-review-meta";
          const who = doc.createElement("b");
          shownAs(who, it.author || "Reviewer", nameOf);
          meta.append(who, ` \xB7 ${shortDate(it.date)}`);
          if (passages(i) > 1) meta.append(` \xB7 ${passages(i)} passages`);
          const text = doc.createElement("div");
          text.className = "dendrite-review-text";
          const { text: said, url } = noteLink(it.text);
          if (url && it.kind !== "suggest") {
            const a = doc.createElement("a");
            a.className = "dendrite-review-link";
            a.href = url;
            a.textContent = "\u2197";
            a.title = "Open this comment in Google Docs";
            a.target = "_blank";
            a.rel = "noopener nofollow";
            a.addEventListener("click", (e) => e.stopPropagation());
            meta.append(" ", a);
          }
          if (it.kind !== "suggest") fillAddressed(text, said, colourOf);
          else text.textContent = !it.text.trim() ? "Suggests deleting this." : it.passage ? `Suggests: ${it.text.trim()}` : `Suggests adding: ${it.text.trim()}`;
          main.append(meta, text);
          (it.replies || []).forEach((r, k) => {
            const el = replyRow(doc, r, nameOf, colourOf);
            if (onMenu) {
              el.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                onMenu(i, e, k);
              });
            }
            if (r.author === "Claude") {
              const btn = doc.createElement("button");
              btn.className = "dendrite-review-btn";
              btn.textContent = "Reply to Claude";
              btn.title = "For Claude only: not sent to the reviewer";
              btn.addEventListener("click", (e) => {
                e.stopPropagation();
                replyBox(
                  main,
                  (t) => act(i, "reply", t),
                  typing,
                  "@Claude "
                );
              });
              const bar2 = doc.createElement("span");
              bar2.className = "dendrite-review-acts";
              bar2.append(btn);
              el.prepend(bar2);
            }
            main.append(el);
          });
          note.append(n, main);
          const buttons = [
            ...commentActions(it),
            ["reply", "Reply", "Answer this comment"]
          ];
          if (onMenu) {
            note.addEventListener("contextmenu", (e) => {
              e.preventDefault();
              e.stopPropagation();
              onMenu(i, e);
            });
          }
          const bar = doc.createElement("span");
          bar.className = "dendrite-review-acts";
          main.prepend(bar);
          for (const [what, label, tip] of buttons) {
            const btn = doc.createElement("button");
            btn.className = "dendrite-review-btn";
            btn.textContent = label;
            if (tip) btn.title = tip;
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              if (what === "reply") replyBox(main, (t) => act(i, "reply", t), typing);
              else act(i, what);
            });
            bar.append(btn);
          }
          box.append(note);
          noteOf2.set(i, note);
        }
        if (b) b.after(box);
        else root.append(box);
      }
      const hover = (i, on) => {
        root.classList.toggle("has-hover", on);
        const note = noteOf2.get(i);
        if (note) note.classList.toggle("is-hover", on);
        items.forEach((_, j) => {
          if (first[j] !== i) return;
          for (const el of passageEls(root, j)) {
            el.classList.toggle("is-hover", on);
          }
        });
      };
      for (const [i, note] of noteOf2) {
        note.addEventListener("mouseenter", () => hover(i, true));
        note.addEventListener("mouseleave", () => hover(i, false));
      }
      items.forEach((_, j) => {
        for (const el of passageEls(root, j)) {
          el.addEventListener("mouseenter", () => hover(first[j], true));
          el.addEventListener("mouseleave", () => hover(first[j], false));
        }
      });
    }
    module2.exports = {
      readReview,
      readReviewJson,
      readBody,
      readComments,
      reviewerNames,
      shownAs,
      wrapPassages,
      editorRanges,
      passagesLost,
      changeAsComment,
      alignWords,
      mapThrough,
      passageEls,
      oldComments,
      convertOld,
      plainMap,
      normalise,
      locate,
      reviewItems,
      alreadyIn,
      noteLink,
      reviewKeys,
      needsLink,
      addLink,
      commentActions,
      commentMenu,
      googleData,
      googleOf,
      REVIEWER_COLOURS,
      colourCss,
      reviewerColours,
      colourList,
      assignColours,
      reviewerEntries,
      entryList,
      addReply,
      removeReply,
      replyBox,
      threadId,
      threadIds,
      forReviewers,
      replyRow,
      addressed,
      awaits,
      replaceReplies,
      fillAddressed,
      suggestInto,
      firstOfComment,
      countComments,
      itemText,
      addItems,
      removeItem,
      applyKeeping,
      keptReplies,
      stripReview,
      renderMarkdown,
      decorate,
      shortDate
    };
  }
});

// src/cmreview.js
var require_cmreview = __commonJS({
  "src/cmreview.js"(exports2, module2) {
    "use strict";
    var review2 = require_review();
    function reviewExtension(colourOf = () => null, nameOf = (x) => x, onLost = () => {
    }) {
      const { Decoration, EditorView, WidgetType } = require("@codemirror/view");
      const { StateField, EditorState } = require("@codemirror/state");
      class Chip extends WidgetType {
        constructor(c) {
          super();
          this.c = c;
        }
        eq(other) {
          const a = this.c;
          const b = other.c;
          return a.n === b.n && a.author === b.author && a.kind === b.kind && a.text === b.text;
        }
        toDOM(view) {
          const c = this.c;
          const doc = view.dom.ownerDocument;
          const el = doc.createElement("sup");
          const tint = colourOf(c.author);
          el.className = "dendrite-review-n dendrite-cm-chip" + (c.kind === "suggest" ? " is-suggest" : "") + (tint ? ` is-c-${tint}` : "");
          el.textContent = String(c.n);
          const said = c.kind === "suggest" ? c.text.trim() ? `suggests: ${c.text.trim()}` : "suggests deleting this" : c.text;
          el.title = `${nameOf(c.author) || "Reviewer"}: ${said}`;
          if (c.kind !== "suggest" || !c.text.trim()) return el;
          const wrap = doc.createElement("span");
          wrap.className = "dendrite-cm-suggestion";
          const lead = /^\s*/.exec(c.text)[0];
          if (lead) wrap.append(lead);
          const added = doc.createElement("span");
          added.className = "dendrite-review-new" + (tint ? ` is-c-${tint}` : "");
          added.textContent = c.text.slice(lead.length);
          wrap.append(added, el);
          return wrap;
        }
        ignoreEvent() {
          return false;
        }
      }
      class Notes extends WidgetType {
        constructor(list) {
          super();
          this.list = list;
          this.key = JSON.stringify(list);
        }
        eq(other) {
          return this.key === other.key;
        }
        toDOM(view) {
          const doc = view.dom.ownerDocument;
          const div = (cls, parent) => {
            const el = doc.createElement("div");
            el.className = cls;
            if (parent) parent.append(el);
            return el;
          };
          const box = div("dendrite-review-notes dendrite-cm-notes");
          for (const c of this.list) {
            const tint = colourOf(c.author);
            const note = div("dendrite-review-note" + (c.kind === "suggest" ? " is-suggest" : "") + (tint ? ` is-c-${tint}` : ""), box);
            const n = doc.createElement("span");
            n.className = "dendrite-review-n";
            n.textContent = String(c.n);
            note.append(n);
            const main = div("dendrite-review-main", note);
            const meta = div("dendrite-review-meta", main);
            const who = doc.createElement("b");
            review2.shownAs(who, c.author || "Reviewer", nameOf);
            meta.append(who, ` \xB7 ${review2.shortDate(c.date)}`);
            const { text: said } = review2.noteLink(c.text);
            const shown = div("dendrite-review-text", main);
            if (c.kind !== "suggest") {
              review2.fillAddressed(shown, said, colourOf);
            } else {
              shown.textContent = !c.text.trim() ? "Suggests deleting this." : c.passage ? `Suggests: ${c.text.trim()}` : `Suggests adding: ${c.text.trim()}`;
            }
            for (const r of c.replies || []) {
              main.append(review2.replyRow(doc, r, nameOf, colourOf));
            }
          }
          return box;
        }
        ignoreEvent() {
          return true;
        }
      }
      const build = (state) => {
        const r = review2.editorRanges(state.doc.toString());
        const atomic = [];
        const all = [];
        const under = /* @__PURE__ */ new Map();
        for (const c of r.chips) {
          if (!c.first) continue;
          const end = state.doc.lineAt(c.to).to;
          if (!under.has(end)) under.set(end, []);
          under.get(end).push(c);
        }
        for (const [end, list] of under) {
          all.push(Decoration.widget({
            widget: new Notes(list),
            block: true,
            side: 1
          }).range(end));
        }
        for (const [from, to] of r.hide) {
          atomic.push(Decoration.replace({}).range(from, to));
        }
        for (const c of r.chips) {
          atomic.push(Decoration.replace({ widget: new Chip(c) }).range(c.from, c.to));
        }
        for (const m of r.marks) {
          if (m.to <= m.from) continue;
          const tint = colourOf(m.author);
          all.push(Decoration.mark({ class: "dendrite-cm-passage" + (m.kind === "suggest" ? " is-suggest" : "") + (tint ? ` is-c-${tint}` : "") }).range(m.from, m.to));
        }
        const hidden = Decoration.set(atomic, true);
        return {
          hidden,
          all: Decoration.set([...atomic, ...all], true),
          protect: r.protect
        };
      };
      const field = StateField.define({
        create: build,
        update: (value, tr) => tr.docChanged ? build(tr.state) : value,
        provide: (f) => [
          EditorView.decorations.from(f, (v) => v.all),
          EditorView.atomicRanges.of((view) => view.state.field(f).hidden)
        ]
      });
      const user = (tr) => ["input", "delete", "move"].some((e) => tr.isUserEvent(e));
      const step = EditorState.transactionFilter.of((tr) => {
        const sel = tr.startState.selection.main;
        if (!tr.isUserEvent("delete") || !sel.empty) return tr;
        const { protect } = tr.startState.field(field);
        let to = null;
        tr.changes.iterChangedRanges((from, end) => {
          for (const [s, e] of protect) {
            if (to === null && s < end && from < e) {
              to = from < sel.head ? s : e;
            }
          }
        });
        return to === null ? tr : { selection: { anchor: to } };
      });
      const keep = EditorState.changeFilter.of((tr) => {
        if (!user(tr)) return true;
        const { protect } = tr.startState.field(field);
        return protect.length ? protect.flat() : true;
      });
      const watch = EditorView.updateListener.of((u) => {
        if (!u.docChanged || !u.transactions.some(user)) return;
        const lost = review2.passagesLost(
          u.startState.doc.toString(),
          u.state.doc.toString()
        );
        if (lost.length) onLost(lost);
      });
      return [field, step, keep, watch];
    }
    module2.exports = { reviewExtension };
  }
});

// src/cmfootnotes.js
var require_cmfootnotes = __commonJS({
  "src/cmfootnotes.js"(exports2, module2) {
    "use strict";
    var core2 = require_core();
    var review2 = require_review();
    function footnoteExtension() {
      const { Decoration, EditorView, WidgetType } = require("@codemirror/view");
      const { StateField } = require("@codemirror/state");
      class Chip extends WidgetType {
        constructor(label, note) {
          super();
          this.label = label;
          this.note = note;
        }
        eq(other) {
          return this.label === other.label && this.note === other.note;
        }
        toDOM(view) {
          const el = view.dom.ownerDocument.createElement("sup");
          el.className = "dendrite-cm-footnote";
          el.textContent = this.label;
          el.title = this.note;
          return el;
        }
        // A click goes through, so the cursor lands at the footnote and
        // opens it.
        ignoreEvent() {
          return false;
        }
      }
      const build = (state) => {
        const md = state.doc.toString();
        const held = review2.editorRanges(md).protect;
        const sel = state.selection.ranges;
        const out = [];
        core2.inlineFootnotes(md).forEach((n, k) => {
          if (held.some(([a, b]) => a < n.to && n.from < b)) return;
          if (sel.some((r) => r.from <= n.to && n.from <= r.to)) return;
          const label = core2.footnoteLabel(n.note) || String(k + 1);
          out.push(Decoration.replace({ widget: new Chip(label, n.note) }).range(n.from, n.to));
        });
        return Decoration.set(out);
      };
      return StateField.define({
        create: build,
        update: (value, tr) => tr.docChanged || tr.selection ? build(tr.state) : value,
        provide: (f) => EditorView.decorations.from(f)
      });
    }
    module2.exports = { footnoteExtension };
  }
});

// src/editor.js
var require_editor = __commonJS({
  "src/editor.js"(exports2, module2) {
    "use strict";
    var { Scope: Scope2 } = require("obsidian");
    var { reviewExtension } = require_cmreview();
    var { footnoteExtension } = require_cmfootnotes();
    var EditorClass = null;
    var resolveFailed = false;
    function markdownEditorClass(app) {
      if (EditorClass || resolveFailed) return EditorClass;
      try {
        const embed = app.embedRegistry.embedByExtension.md(
          { app, containerEl: createDiv(), state: {} },
          null,
          ""
        );
        embed.editable = true;
        embed.showEditor();
        const proto = Object.getPrototypeOf(
          Object.getPrototypeOf(embed.editMode)
        );
        embed.unload();
        EditorClass = proto && proto.constructor;
        if (typeof EditorClass !== "function") throw new Error("no class");
      } catch (err) {
        resolveFailed = true;
        EditorClass = null;
        console.warn("Dendrite: Obsidian's editor is unavailable; cards use the text box.", err);
      }
      return EditorClass;
    }
    function obsidianEditor(app, parent, opts) {
      const Base = markdownEditorClass(app);
      if (!Base) return null;
      class CardEditor extends Base {
        constructor(container) {
          super(app, container, {
            app,
            onMarkdownScroll: () => {
            },
            getMode: () => "source"
          });
          this.cardOpts = opts;
          this.scope = new Scope2(app.scope);
          this.scope.register([], "Escape", () => {
            opts.onEscape();
            return false;
          });
          if (opts.onUndo) {
            this.scope.register(["Mod"], "z", () => !opts.onUndo());
          }
          if (opts.onRedo) {
            for (const [mods, key] of [
              [["Mod", "Shift"], "z"],
              [["Mod"], "y"]
            ]) {
              this.scope.register(mods, key, () => !opts.onRedo());
            }
          }
          if (opts.onFind) {
            this.scope.register(["Mod"], "f", () => {
              opts.onFind();
              return false;
            });
          }
          this.owner.editMode = this;
          this.owner.editor = this.editor;
          this.owner.file = opts.file;
          this.set(opts.value || "", false);
          const content = this.editor.cm.contentDOM;
          content.addEventListener("focusin", () => {
            app.keymap.pushScope(this.scope);
            app.workspace.activeEditor = this.owner;
          });
          content.addEventListener("blur", () => {
            app.keymap.popScope(this.scope);
            if (this._loaded) opts.onBlur();
          });
          const ws = app.workspace;
          const original = ws.setActiveLeaf;
          const self = this;
          const hasFocus = () => {
            const cm = self.editor && self.editor.cm;
            if (!cm) return false;
            const dom = cm.contentDOM;
            return !!cm.hasFocus || !!dom && dom.contains(dom.ownerDocument.activeElement);
          };
          const patched = function(...args) {
            if (hasFocus()) return void 0;
            return original.apply(this, args);
          };
          ws.setActiveLeaf = patched;
          this.register(() => {
            if (ws.setActiveLeaf === patched) ws.setActiveLeaf = original;
          });
        }
        // Review comments and inline footnotes drawn in place of their
        // syntax; the editor as Obsidian makes it should that fail.
        buildLocalExtensions() {
          const base = super.buildLocalExtensions();
          try {
            return [
              ...base,
              reviewExtension(
                opts.colourOf,
                opts.nameOf,
                opts.onLost
              ),
              footnoteExtension()
            ];
          } catch (err) {
            console.warn("Dendrite: review comments and footnotes are shown as text in the editor.", err);
            return base;
          }
        }
        onUpdate(update, changed) {
          super.onUpdate(update, changed);
          if (changed) this.cardOpts.onChange();
          if (this.cardOpts.onRedraw) this.cardOpts.onRedraw();
        }
        onunload() {
          super.onunload();
          app.keymap.popScope(this.scope);
          if (app.workspace.activeEditor === this.owner) {
            app.workspace.activeEditor = null;
          }
        }
      }
      const el = createDiv({ cls: "dendrite-cm" });
      let ed;
      try {
        ed = new CardEditor(el);
        parent.addChild(ed);
        if (!ed.editor || !ed.editor.cm) throw new Error("no CodeMirror");
      } catch (err) {
        console.warn("Dendrite: Obsidian's editor failed to start; using the text box.", err);
        if (ed) {
          try {
            parent.removeChild(ed);
          } catch (e) {
          }
        }
        return null;
      }
      return {
        kind: "obsidian",
        el,
        get value() {
          return ed.editor.cm.state.doc.toString();
        },
        focus(atStart) {
          const editor = ed.editor;
          editor.focus();
          if (atStart) {
            editor.setCursor({ line: 0, ch: 0 });
          } else {
            const last = editor.lastLine();
            editor.setCursor({
              line: last,
              ch: editor.getLine(last).length
            });
          }
        },
        selection() {
          const editor = ed.editor;
          return [
            editor.posToOffset(editor.getCursor("from")),
            editor.posToOffset(editor.getCursor("to"))
          ];
        },
        replace(text, at) {
          ed.editor.setValue(text);
          this.focusAt(at);
        },
        // The text changed to `text` where it differs, in one step of
        // the editor's history, the caret and selection moved with it.
        update(text) {
          const [a, b, put] = differ(this.value, text);
          ed.editor.replaceRange(
            put,
            ed.editor.offsetToPos(a),
            ed.editor.offsetToPos(b)
          );
        },
        focusAt(at, to = at) {
          const editor = ed.editor;
          editor.focus();
          editor.setSelection(
            editor.offsetToPos(at),
            editor.offsetToPos(to)
          );
        },
        caretRect() {
          const cm = ed.editor.cm;
          const r = cm.coordsAtPos(cm.state.selection.main.head);
          return r ? { top: r.top, bottom: r.bottom } : null;
        },
        rangeAt(start, end) {
          const cm = ed.editor.cm;
          const vp = cm.viewport;
          if (!cm.domAtPos || vp && (start < vp.from || end > vp.to)) {
            return null;
          }
          try {
            const a = cm.domAtPos(start);
            const b = cm.domAtPos(end);
            const r = el.ownerDocument.createRange();
            r.setStart(a.node, a.offset);
            r.setEnd(b.node, b.offset);
            return r;
          } catch (err) {
            return null;
          }
        },
        destroy() {
          parent.removeChild(ed);
        }
      };
    }
    function differ(now, then) {
      let a = 0;
      while (a < now.length && a < then.length && now[a] === then[a]) a++;
      let b = 0;
      while (b < now.length - a && b < then.length - a && now[now.length - 1 - b] === then[then.length - 1 - b]) b++;
      return [a, now.length - b, then.slice(a, then.length - b)];
    }
    function textEditor(opts) {
      const ta = createEl("textarea", { cls: "dendrite-editor" });
      ta.value = opts.value || "";
      const fit = () => {
        ta.style.height = "auto";
        ta.style.height = ta.scrollHeight + "px";
      };
      ta.addEventListener("input", () => {
        fit();
        opts.onChange();
      });
      ta.addEventListener("blur", () => opts.onBlur());
      return {
        kind: "text",
        el: ta,
        ta,
        get value() {
          return ta.value;
        },
        focus(atStart) {
          fit();
          ta.focus();
          const at = atStart ? 0 : ta.value.length;
          ta.setSelectionRange(at, at);
        },
        selection() {
          return [ta.selectionStart, ta.selectionEnd];
        },
        replace(text, at) {
          ta.value = text;
          fit();
          this.focusAt(at);
        },
        update(text) {
          const [a, b, put] = differ(ta.value, text);
          ta.setRangeText(put, a, b, "preserve");
          fit();
        },
        focusAt(at, to = at) {
          ta.focus();
          ta.setSelectionRange(at, to);
        },
        caretRect() {
          return textCaret(ta);
        },
        // A text box's text is not in the page's text, so nothing in it
        // can be painted; find selects its match instead.
        rangeAt() {
          return null;
        },
        destroy() {
          ta.remove();
        }
      };
    }
    function textCaret(ta) {
      const doc = ta.ownerDocument;
      const cs = doc.defaultView.getComputedStyle(ta);
      const copy = doc.createElement("div");
      for (const p of [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "letterSpacing",
        "tabSize",
        "boxSizing",
        "paddingTop",
        "paddingLeft",
        "paddingRight",
        "borderTopWidth",
        "borderLeftWidth",
        "borderRightWidth"
      ]) {
        copy.style[p] = cs[p];
      }
      copy.style.position = "absolute";
      copy.style.visibility = "hidden";
      copy.style.whiteSpace = "pre-wrap";
      copy.style.overflowWrap = "break-word";
      copy.style.width = ta.offsetWidth + "px";
      copy.textContent = ta.value.slice(0, ta.selectionEnd);
      const mark = doc.createElement("span");
      mark.textContent = "\u200B";
      copy.appendChild(mark);
      doc.body.appendChild(copy);
      const top = ta.getBoundingClientRect().top + mark.offsetTop - ta.scrollTop;
      const height = mark.offsetHeight;
      copy.remove();
      return { top, bottom: top + height };
    }
    function cardEditor2(app, parent, opts, useObsidian) {
      return useObsidian && obsidianEditor(app, parent, opts) || textEditor(opts);
    }
    function resetForTests() {
      EditorClass = null;
      resolveFailed = false;
    }
    module2.exports = { cardEditor: cardEditor2, textEditor, resetForTests };
  }
});

// src/pandoc.js
var require_pandoc = __commonJS({
  "src/pandoc.js"(exports2, module2) {
    "use strict";
    var docx = require_docx();
    function citekeys(md) {
      const out = [];
      const seen = /* @__PURE__ */ new Set();
      const re = /(?<![\w.@])@([A-Za-z0-9_][\w:.#$%&+?<>~/-]*)/g;
      let m;
      while ((m = re.exec(md)) !== null) {
        const key = m[1].replace(/[.:,;?]+$/, "");
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push(key);
        }
      }
      return out;
    }
    function toPandoc(md, resolve) {
      return md.replace(
        /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g,
        (all, name, alt) => {
          const path = resolve(name.trim());
          if (path && /\.(png|jpe?g|gif|svg|webp|pdf)$/i.test(path)) {
            const width = alt && /^\d+$/.test(alt.trim()) ? `{width=${alt.trim()}px}` : "";
            return `![](<${path}>)${width}`;
          }
          return name.trim();
        }
      ).replace(
        /\[\[([^\]|#]*)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g,
        (all, name, sub, alias) => (alias || sub || name).trim()
      ).replace(/==([^=\n]+)==/g, "$1");
    }
    function pandocCaptions(md) {
      return md.replace(
        /^(\*\*Table \d+\.\*\*.*)\n\n(?=\s*\|)/gm,
        "Table: $1\n\n"
      ).replace(
        new RegExp("^!\\[\\]\\(([^)\\n]*)\\)(\\{[^}\\n]*\\})?\\n\\n(\\*\\*Figure \\d+\\.\\*\\*.*)$", "gm"),
        (all, src, attrs, cap) => `![${cap.replace(/[[\]]/g, "\\$&")}](${src})` + (attrs || "")
      );
    }
    async function fetchBib(keys, port, deps) {
      const call = async (ks) => {
        const res = await deps.fetch(
          `http://127.0.0.1:${port}/better-bibtex/json-rpc`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "item.export",
              params: [ks, "Better CSL JSON"]
            })
          }
        );
        return res.json();
      };
      const items = (r) => {
        if (!r || typeof r.result !== "string") return null;
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
    var ARTICLE_SIZES = [10, 11, 12];
    function footnoteGap(st) {
      if (st.footnoteGap) return st.footnoteGap;
      return `${Math.round(bodyLine(st) * 10) / 10}pt`;
    }
    function texEscape(t) {
      const named = {
        "\\": "\\textbackslash{}",
        "^": "\\textasciicircum{}",
        "~": "\\textasciitilde{}"
      };
      return t.replace(/[\\{}$&#%_^~]/g, (c) => named[c] || "\\" + c);
    }
    function headerLine(line) {
      const t = texEscape(line.replace(/\{page\}/g, "").replace(/\{pages\}/g, ""));
      return t.replace(/\*\*(.+?)\*\*/g, "\\textbf{$1}").replace(/\*(.+?)\*/g, "\\textit{$1}").replace(/\u0001/g, "\\thepage{}").replace(/\u0002/g, "\\pageref*{LastPage}");
    }
    function bodyLine(st) {
      return (st.fontSize || 10) * 1.2 * (st.lineSpacing || 1);
    }
    var SLOTS = { left: "L", center: "C", right: "R" };
    function slotsTex(slots2, cmd) {
      return Object.entries(SLOTS).map(([k, pos]) => {
        const text = slots2 && slots2[k] ? slots2[k].split("\n").map(headerLine).join("\\\\") : "";
        return text ? `\\${cmd}[${pos}]{${text}}` : null;
      }).filter(Boolean);
    }
    var anySlot = (st, re) => [st.header, st.footer].some((h) => h && Object.values(h).some((t) => re.test(t)));
    var slotLines = (slots2) => Math.max(0, ...Object.values(slots2 || {}).map((t) => t.split("\n").length));
    function preamble(st) {
      const out = [`\\setlength{\\skip\\footins}{${footnoteGap(st)} plus 4pt minus 2pt}`];
      if (st.header || st.footer) {
        const pages = st.pageNumbers !== false && !anySlot(st, /\{page\}/);
        const foot = st.footer ? slotsTex(st.footer, "fancyfoot") : [`\\fancyfoot[C]{${pages ? "\\thepage" : ""}}`];
        if (anySlot(st, /\{pages\}/)) out.push("\\usepackage{lastpage}");
        const style = [
          "\\fancyhf{}",
          ...slotsTex(st.header, "fancyhead"),
          ...foot,
          "\\renewcommand{\\headrulewidth}{0pt}"
        ];
        out.push(
          "\\usepackage{fancyhdr}",
          "\\pagestyle{fancy}",
          ...style,
          "\\fancypagestyle{plain}{" + style.join("") + "}"
        );
      }
      out.push(
        "\\usepackage{caption}",
        "\\captionsetup{labelformat=empty,labelsep=none,justification=raggedright,singlelinecheck=false}",
        "\\ifdefined\\LTcapwidth\\setlength{\\LTcapwidth}{\\textwidth}\\fi"
      );
      out.push(
        "\\usepackage{longtable,booktabs,array,calc,etoolbox}",
        "\\AtBeginEnvironment{longtable}{\\ifdefined\\setstretch\\setstretch{1}\\fi\\renewcommand{\\arraystretch}{1.6}}",
        "\\newcommand{\\dendriteheadstrut}{\\vrule width0pt height\\arraystretch\\ht\\strutbox\\relax}"
      );
      out.push("\\makeatletter\\newcommand{\\dendriteneed}[1]{\\par\\begingroup\\dimen@=1.2\\dimexpr\\f@size pt\\relax\\dimen@=#1\\dimen@\\dimen@ii=\\pagegoal\\advance\\dimen@ii-\\pagetotal\\ifdim\\dimen@>\\dimen@ii\\ifdim\\dimen@ii>\\z@\\vfil\\fi\\break\\fi\\endgroup}\\makeatother");
      return out.join("\n") + "\n";
    }
    var TABLES_LUA = String.raw`local chars = 90
local KEEP_ROWS = 30

local function cellText(c) return pandoc.utils.stringify(c.contents) end

local function longestWord(s)
  local m = 0
  for w in s:gmatch('%S+') do m = math.max(m, utf8.len(w) or #w) end
  return m
end

local function rowsOf(t)
  local all = {}
  for _, r in ipairs(t.head.rows) do table.insert(all, r) end
  for _, b in ipairs(t.bodies) do
    for _, r in ipairs(b.body) do table.insert(all, r) end
  end
  for _, r in ipairs(t.foot.rows) do table.insert(all, r) end
  return all
end

local function widen(t)
  local n = #t.colspecs
  if n == 0 or not t.colspecs[1][2] then return end
  local word = {}
  for i = 1, n do word[i] = 1 end
  for _, r in ipairs(rowsOf(t)) do
    local i = 1
    for _, c in ipairs(r.cells) do
      if word[i] then
        word[i] = math.max(word[i], longestWord(cellText(c)))
      end
      i = i + c.col_span
    end
  end
  -- Widths are fractions of the line less the gaps between columns.
  local avail = chars - n * 2.5
  local min, sum = {}, 0
  for i = 1, n do
    min[i] = math.min(1, (word[i] * 1.2 + 1) / avail)
    sum = sum + min[i]
  end
  if sum >= 1 then return end
  local w, give, take = {}, 0, 0
  for i = 1, n do
    w[i] = t.colspecs[i][2]
    if w[i] < min[i] then
      give = give + min[i] - w[i]
      w[i] = min[i]
    else
      take = take + w[i] - min[i]
    end
  end
  if give == 0 or take == 0 then return end
  for i = 1, n do
    if w[i] > min[i] then
      w[i] = w[i] - give * (w[i] - min[i]) / take
    end
    t.colspecs[i] = { t.colspecs[i][1], w[i] }
  end
end

-- About how many single-spaced lines a table takes: each row its
-- tallest cell's wrapped lines and the space rows are set apart by,
-- with its caption and rules. A table that may break is counted to
-- its first rows only.
local function tableLines(t)
  widen(t)
  local n = #t.colspecs
  local avail = chars - n * 2.5
  local function rowLines(r)
    local most, i = 1, 1
    for _, c in ipairs(r.cells) do
      local w = t.colspecs[i] and t.colspecs[i][2]
      local len = utf8.len(cellText(c)) or 0
      if w and w > 0 then
        most = math.max(most, math.ceil(len / (w * avail)))
      end
      i = i + c.col_span
    end
    return most + 0.6
  end
  local rows = {}
  for _, r in ipairs(t.head.rows) do table.insert(rows, r) end
  local body = 0
  for _, b in ipairs(t.bodies) do
    for _, r in ipairs(b.body) do
      table.insert(rows, r)
      body = body + 1
    end
  end
  for _, r in ipairs(t.foot.rows) do table.insert(rows, r) end
  local count = #rows
  if body > KEEP_ROWS then count = math.min(count, #t.head.rows + 3) end
  local lines = 3
  for k = 1, count do lines = lines + rowLines(rows[k]) end
  local caption = utf8.len(pandoc.utils.stringify(t.caption.long)) or 0
  return lines + math.ceil(caption / chars)
end

-- A row of three or more dashes, '| --- | --- |', is a rule across the
-- table. Pandoc reads --- as an em dash, -- as an en dash.
local function isRule(r)
  local any = false
  for _, c in ipairs(r.cells) do
    local s = cellText(c)
    if s ~= '' then
      local d = (s:gsub('\u{2014}', '---'):gsub('\u{2013}', '--'))
      if not d:match('^:?%-+:?$') then return false end
      if #(d:gsub(':', '')) >= 3 then any = true end
    end
  end
  return any
end

local RULE = '\\dendriterule'

-- In LaTeX a rule row becomes \midrule; in Word, which draws no rule
-- between rows, one before the last row makes that row the table's
-- total row. A rule under the header or after the last row is dropped,
-- since a rule is drawn there already.
local function rules(t, latex)
  for _, b in ipairs(t.bodies) do
    local out = pandoc.List()
    local ruled = nil
    for k, r in ipairs(b.body) do
      if not isRule(r) then
        out:insert(r)
      elseif #out > 0 and k < #b.body then
        if latex then
          for n, c in ipairs(r.cells) do
            c.contents = n == 1 and
              { pandoc.Plain({ pandoc.RawInline('latex', RULE) }) } or {}
          end
          out:insert(r)
        else
          ruled = #out
        end
      end
    end
    if ruled and ruled == #out - 1 and #t.foot.rows == 0 then
      t.foot.rows:insert(out:remove(#out))
    end
    b.body = out
  end
end

local HEAD = '\\begin{minipage}%[b%]{\\linewidth}\\%a+\n'

local function write(t)
  if not pandoc.write then return t end
  local tex = pandoc.write(pandoc.Pandoc({ t }), 'latex')
  -- A header cell is set bottom-aligned in a box, so a header of two
  -- lines rises to the rule above it; its first line is given a row's.
  tex = tex:gsub(HEAD, '%0\\dendriteheadstrut\n')
  local rows = 0
  for _, b in ipairs(t.bodies) do rows = rows + #b.body end
  if rows <= KEEP_ROWS then tex = tex:gsub(' \\\\\n', ' \\\\*\n') end
  tex = tex:gsub(RULE:gsub('%p', '%%%0') .. '[^\n]*\n', '\\midrule\n')
  return pandoc.RawBlock('latex', tex)
end

return {
  { Meta = function(m)
      local c = m['dendrite-chars']
      if c then chars = tonumber(pandoc.utils.stringify(c)) or chars end
    end },
  -- Headings straight before a table are kept with it: before the
  -- first of them, room is asked for the headings and the table, or for
  -- its first rows if it may break.
  { Blocks = function(blocks)
      if not FORMAT:match('latex') then return nil end
      local out = pandoc.List()
      local i = 1
      while i <= #blocks do
        local j = i
        while j <= #blocks and blocks[j].t == 'Header' do j = j + 1 end
        if j > i and j <= #blocks and blocks[j].t == 'Table' then
          local need = (j - i) * 3 + tableLines(blocks[j])
          out:insert(pandoc.RawBlock('latex', string.format(
            '\\dendriteneed{%.1f}', need)))
        end
        for k = i, math.max(i, j - 1) do out:insert(blocks[k]) end
        i = math.max(i, j - 1) + 1
      end
      return out
    end },
  { Table = function(t)
      local latex = FORMAT:match('latex') ~= nil
      widen(t)
      rules(t, latex)
      if latex then return write(t) end
      return t
    end },
}
`;
    var PAPER_PT = { letter: 612, a4: 595.3 };
    var UNIT_PT = { pt: 1, mm: 2.8453, cm: 28.453, in: 72.27 };
    function lineChars(st) {
      const width = PAPER_PT[st.paper] || PAPER_PT.letter;
      return Math.round((width - 2 * marginPt(st)) / ((st.fontSize || 10) / 2));
    }
    function restyledReference(buf, style, zlib) {
      return docx.reference(buf, {
        font: style.font,
        fontSize: style.fontSize || 10,
        lineSpacing: style.lineSpacing,
        paper: style.paper,
        marginPt: marginPt(style)
      }, zlib);
    }
    function marginPt(st) {
      const m = /^\s*([\d.]+)\s*(pt|mm|cm|in)\s*$/.exec(st.margin || "");
      return m ? Number(m[1]) * UNIT_PT[m[2]] : 2.5 * UNIT_PT.cm;
    }
    function pandocArgs(o) {
      const st = o.style || {};
      const args = [
        o.input,
        "--from",
        "markdown",
        "-o",
        o.output,
        "--standalone"
      ];
      if (st.defaults) args.unshift(`--defaults=${st.defaults}`);
      if (o.format === "pdf") {
        args.push(
          `--pdf-engine=${o.engine || "xelatex"}`,
          "-V",
          `geometry:margin=${st.margin || "2.5cm"}`
        );
        if (st.paper) args.push("-V", `papersize=${st.paper}`);
        if (st.font) args.push("-V", `mainfont=${st.font}`);
        if (st.fontSize) {
          if (!ARTICLE_SIZES.includes(st.fontSize)) {
            args.push("-V", "documentclass=extarticle");
          }
          args.push("-V", `fontsize=${st.fontSize}pt`);
        }
        if (st.lineSpacing) args.push("-V", `linestretch=${st.lineSpacing}`);
        const head = slotLines(st.header);
        const foot = slotLines(st.footer);
        const inside = !st.headerInMargin;
        if (head) {
          if (inside) args.push("-V", "geometry:includehead");
          args.push(
            "-V",
            `geometry:headheight=${Math.ceil(
              head * bodyLine(st) + 2
            )}pt`,
            "-V",
            "geometry:headsep=12pt"
          );
        }
        if (foot) {
          if (inside) args.push("-V", "geometry:includefoot");
          args.push("-V", `geometry:footskip=${Math.ceil(
            foot * bodyLine(st) + 12
          )}pt`);
        }
        if (!st.header && !st.footer && st.pageNumbers === false) {
          args.push("-V", "pagestyle=empty");
        }
        if (o.header) args.push(`--include-in-header=${o.header}`);
      }
      if (o.format === "docx" && st.referenceDocx) {
        args.push(`--reference-doc=${st.referenceDocx}`);
      }
      if (o.bibliography) {
        args.push("--citeproc", "--bibliography", o.bibliography);
        if (o.csl) args.push("--csl", o.csl);
        if (st.referencesTitle !== false) {
          args.push("-M", "reference-section-title=" + (st.referencesTitle || "References"));
        }
      }
      if (o.resourcePath) args.push("--resource-path", o.resourcePath);
      if (o.tables) {
        args.push(
          `--lua-filter=${o.tables}`,
          "-M",
          `dendrite-chars=${lineChars(st)}`
        );
      }
      return args;
    }
    var BODY_END = "\n\n```{=latex}\n\\special{pdf:docinfo << /DendriteBodyEnd (\\thepage) >>}\n```\n";
    function pdfPages(buf, inflate) {
      const raw = buf.toString("latin1");
      let all = raw;
      const re = /stream\r?\n/g;
      let m;
      while (m = re.exec(raw)) {
        const start = m.index + m[0].length;
        const end = raw.indexOf("endstream", start);
        if (end < 0) break;
        try {
          all += "\n" + inflate(buf.subarray(start, end)).toString("latin1");
        } catch (err) {
        }
        re.lastIndex = end + "endstream".length;
      }
      const pages = (all.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
      const mark = /\/DendriteBodyEnd\s*\((\d+)\)/.exec(all);
      return { pages, bodyEnd: mark ? Number(mark[1]) : null };
    }
    async function exportDocument(o, deps) {
      let text = pandocCaptions(toPandoc(o.md, o.resolve || (() => null)));
      const keys = citekeys(text);
      const dir = deps.tmpdir();
      const input = deps.join(dir, `dendrite-${Date.now()}.md`);
      let bibliography = null;
      if (keys.length) {
        const got = await fetchBib(keys, o.port || 23119, deps);
        if (got.missing) {
          return { error: "Zotero has no item for " + got.missing.map((k) => "@" + k).join(", ") + ". Nothing was exported." };
        }
        if (got.down) {
          if (!o.fallbackBib) {
            return { error: `Zotero did not answer on port ${o.port || 23119}: is it open, with Better BibTeX? No fallback .bib is set in Dendrite's settings. Nothing was exported.` };
          }
          bibliography = o.fallbackBib;
        } else {
          bibliography = deps.join(dir, `dendrite-${Date.now()}.json`);
          await deps.writeFile(bibliography, got.bib);
        }
      }
      let header = null;
      let tables = null;
      if (o.format === "pdf") {
        text += BODY_END;
        header = deps.join(dir, `dendrite-${Date.now()}-header.tex`);
        await deps.writeFile(header, preamble(o.style || {}));
      }
      if (o.format === "pdf" || o.format === "docx") {
        tables = deps.join(dir, `dendrite-${Date.now()}-tables.lua`);
        await deps.writeFile(tables, TABLES_LUA);
      }
      let style = o.style || {};
      let reference = null;
      if (o.format === "docx" && !style.referenceDocx && deps.zlib) {
        reference = deps.join(dir, `dendrite-${Date.now()}-reference.docx`);
        try {
          await deps.run(o.pandoc || "pandoc", [
            "-o",
            reference,
            "--print-default-data-file",
            "reference.docx"
          ]);
          await deps.writeFile(reference, restyledReference(
            await deps.readFile(reference),
            style,
            deps.zlib
          ));
          style = Object.assign({}, style, { referenceDocx: reference });
        } catch (err) {
          deps.remove(reference);
          reference = null;
        }
      }
      await deps.writeFile(input, text);
      const args = pandocArgs({
        input,
        output: o.output,
        format: o.format,
        engine: o.engine,
        bibliography,
        csl: o.csl,
        resourcePath: o.resourcePath,
        header,
        tables,
        style
      });
      try {
        await deps.run(o.pandoc || "pandoc", args);
        if (o.format === "docx" && deps.zlib) {
          try {
            await deps.writeFile(o.output, docx.keepDocument(
              await deps.readFile(o.output),
              deps.zlib
            ));
          } catch (err) {
          }
        }
      } catch (err) {
        return { error: pandocError(err, o.pandoc || "pandoc") };
      } finally {
        deps.remove(input);
        if (header) deps.remove(header);
        if (tables) deps.remove(tables);
        if (reference) deps.remove(reference);
        if (bibliography && bibliography !== o.fallbackBib) {
          deps.remove(bibliography);
        }
      }
      let layout = null;
      if (o.format === "pdf" && deps.readFile && deps.inflate) {
        try {
          layout = pdfPages(await deps.readFile(o.output), deps.inflate);
        } catch (err) {
          layout = null;
        }
      }
      return { ok: true, keys, layout };
    }
    function measuredRate(words, layout, cited, floatPages = 0) {
      if (!layout || !words) return null;
      const end = layout.bodyEnd || (cited ? null : layout.pages);
      if (!end || end < 2) return null;
      const text = end - 0.5 - floatPages;
      return text >= 1 ? Math.round(words / text) : null;
    }
    function pandocError(err, cmd) {
      if (err && err.code === "ENOENT") {
        return `Pandoc was not found (looked for "${cmd}"). Install it, or set its full path under Pandoc in Dendrite's settings: "which pandoc" in a terminal prints it, "where pandoc" on Windows.`;
      }
      const msg = String(err && (err.stderr || err.message) || err).trim().split("\n").slice(-6).join("\n");
      return `Pandoc failed: ${msg}`;
    }
    function searchPath(env, platform, extra) {
      const out = Object.assign({}, env);
      const key = Object.keys(out).find((k) => k.toUpperCase() === "PATH") || "PATH";
      const sep = platform === "win32" ? ";" : ":";
      const parts = String(out[key] || "").split(sep).filter(Boolean);
      for (const d of extra) if (!parts.includes(d)) parts.push(d);
      out[key] = parts.join(sep);
      return out;
    }
    function condaBins(names, home) {
      return names.filter((n) => /^(ana|mini)conda\d*(-|$)|^(miniforge|mambaforge)\d*(-|$)/.test(n)).map((n) => `${home}/${n}/bin`);
    }
    module2.exports = {
      citekeys,
      pandocCaptions,
      pandocError,
      searchPath,
      condaBins,
      toPandoc,
      TABLES_LUA,
      lineChars,
      restyledReference,
      fetchBib,
      pandocArgs,
      exportDocument,
      pdfPages,
      measuredRate,
      footnoteGap,
      preamble,
      BODY_END
    };
  }
});

// src/google.js
var require_google = __commonJS({
  "src/google.js"(exports2, module2) {
    "use strict";
    var SCOPE = "https://www.googleapis.com/auth/drive.file";
    var DOCS = "https://docs.googleapis.com/v1/documents/";
    var DRIVE = "https://www.googleapis.com/drive/v3/files/";
    var REVOKE = "https://oauth2.googleapis.com/revoke";
    var WAIT_MS = 10 * 60 * 1e3;
    var PICKER_PORT = 27131;
    var pickerOrigin = (port) => `http://localhost:${port}`;
    function readClient(text) {
      const d = JSON.parse(text);
      const c = d.installed || d.web;
      if (!c || !c.client_id) throw new Error("not an OAuth client file");
      return {
        clientId: c.client_id,
        clientSecret: c.client_secret || "",
        authUri: c.auth_uri || "https://accounts.google.com/o/oauth2/auth",
        tokenUri: c.token_uri || "https://oauth2.googleapis.com/token",
        // The number a client id starts with is its project's,
        // which the picker needs to grant the file to this app.
        projectNumber: c.client_id.split("-")[0]
      };
    }
    function docIdFromUrl(url) {
      const s = String(url || "").trim();
      const m = /\/document\/d\/([\w-]+)/.exec(s);
      if (m) return m[1];
      return /^[\w-]{20,}$/.test(s) ? s : null;
    }
    var docUrl = (id) => `https://docs.google.com/document/d/${id}/edit`;
    function base64url(buf) {
      return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function pkce(crypto) {
      const verifier = base64url(crypto.randomBytes(48));
      const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
      return { verifier, challenge };
    }
    function form(obj) {
      return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    }
    function loopback(http, route, port = 0) {
      return new Promise((resolve, reject) => {
        let finish;
        let fail;
        const done = new Promise((y, n) => {
          finish = y;
          fail = n;
        });
        const server = http.createServer((req, res) => {
          const url = new URL(req.url, "http://127.0.0.1");
          let out;
          try {
            out = route(url, res);
          } catch (err) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end(String(err.message));
            return;
          }
          if (out !== void 0) finish(out);
        });
        const timer = setTimeout(() => fail(new Error(
          "no answer from the browser within 10 minutes"
        )), WAIT_MS);
        if (timer.unref) timer.unref();
        done.then(() => {
        }, () => {
        }).finally(() => {
          clearTimeout(timer);
          server.close();
        });
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          resolve({
            base: `http://127.0.0.1:${server.address().port}`,
            done,
            close: () => fail(new Error("replaced by a new try"))
          });
        });
      });
    }
    function page(res, text) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>Dendrite</title><body style="font-family:sans-serif;margin:2em"><p>${text}</p></body>`);
    }
    async function signIn({
      client,
      request,
      openUrl,
      http,
      crypto,
      now = Date.now
    }) {
      const { verifier, challenge } = pkce(crypto);
      const state = base64url(crypto.randomBytes(16));
      const { base, done } = await loopback(http, (url, res2) => {
        if (url.pathname !== "/") return void 0;
        if (url.searchParams.get("state") !== state) {
          throw new Error("this sign-in was not started by Dendrite");
        }
        const err = url.searchParams.get("error");
        page(res2, err ? `Sign-in did not finish (${err}). You can close this tab.` : "Signed in. You can close this tab and go back to Obsidian.");
        return err ? { error: err } : { code: url.searchParams.get("code") };
      });
      openUrl(`${client.authUri}?` + form({
        client_id: client.clientId,
        redirect_uri: base,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256"
      }));
      const got = await done;
      if (got.error) throw new Error(`Google said ${got.error}`);
      const res = await request({
        url: client.tokenUri,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: form({
          code: got.code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: base,
          grant_type: "authorization_code",
          code_verifier: verifier
        })
      });
      if (res.status !== 200 || !res.json.refresh_token) {
        throw new Error("Google did not give a token" + (res.json && res.json.error ? ` (${res.json.error})` : ""));
      }
      return {
        refresh_token: res.json.refresh_token,
        access_token: res.json.access_token,
        expires_at: now() + (res.json.expires_in || 3600) * 1e3
      };
    }
    async function accessToken({
      client,
      tok,
      request,
      save,
      now = Date.now
    }) {
      if (!tok || !tok.refresh_token) {
        const e = new Error("not signed in to Google");
        e.signIn = true;
        throw e;
      }
      if (tok.access_token && tok.expires_at > now() + 6e4) {
        return tok.access_token;
      }
      const res = await request({
        url: client.tokenUri,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: form({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          refresh_token: tok.refresh_token,
          grant_type: "refresh_token"
        })
      });
      if (res.status !== 200) {
        const e = new Error("Google wants you to sign in again" + (res.json && res.json.error ? ` (${res.json.error})` : ""));
        e.signIn = true;
        throw e;
      }
      const next = Object.assign({}, tok, {
        access_token: res.json.access_token,
        expires_at: now() + (res.json.expires_in || 3600) * 1e3
      });
      await save(next);
      return next.access_token;
    }
    async function revoke({ tok, request }) {
      if (!tok || !tok.refresh_token) return;
      await request({
        url: REVOKE,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: form({ token: tok.refresh_token })
      });
    }
    function pickerPage(o) {
      const j = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
      return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Dendrite: link a Google Doc</title>
<style>body { font-family: sans-serif; margin: 2em; }</style>
</head><body>
<p id="m">Opening Google's file picker. Click the manuscript's doc, then
press Select, or double-click it.</p>
<p style="color:#777">If nothing happens after Select, as in Firefox,
copy this page's address into Chrome or Edge, signed in to the same
Google account, and choose the doc there.</p>
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
<\/script>
<script async defer src="https://apis.google.com/js/api.js"
        onload="onApi()"
        onerror="say('Google\\'s picker could not load.');
                 report('error: apis.google.com did not load')"><\/script>
</body></html>`;
    }
    var picking = null;
    async function pick({
      token,
      apiKey,
      client,
      openUrl,
      http,
      crypto,
      onEvent = () => {
      },
      port = PICKER_PORT
    }) {
      if (picking) {
        picking();
        picking = null;
        await new Promise((r) => setTimeout(r, 50));
      }
      const secret = base64url(crypto.randomBytes(16));
      let back = "";
      let origin = "";
      const { base, done, close } = await loopback(http, (url, res) => {
        if (url.pathname === `/${secret}`) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(pickerPage({
            token,
            key: apiKey,
            app: client.projectNumber,
            back,
            origin
          }));
          return void 0;
        }
        if (url.pathname === `/${secret}/event`) {
          onEvent(url.searchParams.get("what") || "");
          res.writeHead(204);
          res.end();
          return void 0;
        }
        if (url.pathname === `/${secret}/picked`) {
          page(res, "Linked.");
          return {
            id: url.searchParams.get("id"),
            name: url.searchParams.get("name") || ""
          };
        }
        if (url.pathname === `/${secret}/cancel`) {
          page(res, "Cancelled.");
          return null;
        }
        res.writeHead(404);
        res.end();
        return void 0;
      }, port);
      picking = close;
      done.then(() => {
      }, () => {
      }).finally(() => {
        if (picking === close) picking = null;
      });
      back = `/${secret}`;
      origin = port ? pickerOrigin(port) : base;
      openUrl(`${origin}/${secret}`);
      return done;
    }
    var CONTEXT = 40;
    function unescapeHtml(s) {
      return String(s || "").replace(
        /&#(\d+);/g,
        (m, n) => String.fromCharCode(Number(n))
      ).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    }
    function suggestionItems(doc, date = "") {
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
        let text = "";
        const sugg = /* @__PURE__ */ new Map();
        for (const el of p.elements || []) {
          const run = el.textRun;
          if (!run) continue;
          const t = run.content.replace(/\n$/, "");
          const ins = run.suggestedInsertionIds || [];
          const del = run.suggestedDeletionIds || [];
          for (const id of [...ins, ...del]) {
            if (!sugg.has(id)) {
              sugg.set(id, {
                start: text.length,
                end: text.length,
                quote: "",
                insert: ""
              });
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
          out.push({
            kind: "change",
            author: "Google Docs suggestion",
            date,
            quote: s.quote,
            insert: s.insert,
            before: text.slice(
              Math.max(0, s.start - CONTEXT),
              s.start
            ),
            after: text.slice(s.end, s.end + CONTEXT)
          });
        }
      }
      return out;
    }
    function commentItems(comments, docId = "") {
      const out = [];
      for (const c of comments || []) {
        if (c.resolved || c.deleted) continue;
        const replies = (c.replies || []).filter((r) => !r.deleted && r.content).map((r) => ` Reply from ${r.author && r.author.displayName || "someone"}: ${r.content}`);
        out.push({
          kind: "comment",
          author: c.author && c.author.displayName || "",
          date: String(c.createdTime || "").slice(0, 10),
          text: (c.content || "") + replies.join(""),
          quote: unescapeHtml(c.quotedFileContent && c.quotedFileContent.value),
          before: "",
          after: "",
          ...c.id ? { gid: c.id, link: docId ? `${docUrl(docId)}?disco=${c.id}` : "" } : {}
        });
      }
      return out;
    }
    async function getJson(request, url, token) {
      const res = await request({ url, headers: {
        Authorization: `Bearer ${token}`
      } });
      if (res.status !== 200) {
        const msg = res.json && res.json.error && res.json.error.message;
        const e = new Error(`Google answered ${res.status}` + (msg ? `: ${msg}` : ""));
        e.status = res.status;
        throw e;
      }
      return res.json;
    }
    var GDOC = "application/vnd.google-apps.document";
    var DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    async function driveComments(request, docId, token) {
      const comments = [];
      let pageToken = "";
      for (let k = 0; k < 50; k++) {
        const r = await getJson(request, `${DRIVE}${docId}/comments?` + form({
          pageSize: 100,
          includeDeleted: false,
          fields: "nextPageToken,comments(id,content,createdTime,resolved,deleted,author(displayName),quotedFileContent(value),replies(content,deleted,author(displayName)))"
        }) + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""), token);
        comments.push(...r.comments || []);
        if (!r.nextPageToken) break;
        pageToken = r.nextPageToken;
      }
      return comments;
    }
    async function fetchReview({
      docId,
      token,
      request,
      zlib,
      today = /* @__PURE__ */ new Date()
    }) {
      const meta = await getJson(request, `${DRIVE}${docId}?fields=name,mimeType`, token);
      const comments = await driveComments(request, docId, token);
      const resolved = comments.filter((c) => c.resolved).length;
      const drive = commentItems(comments, docId);
      if (meta.mimeType === GDOC) {
        const doc = await getJson(request, `${DOCS}${docId}?suggestionsViewMode=SUGGESTIONS_INLINE`, token);
        return {
          title: meta.name || doc.title || "",
          resolved,
          items: [...drive, ...suggestionItems(
            doc,
            today.toISOString().slice(0, 10)
          )]
        };
      }
      if (meta.mimeType !== DOCX) {
        throw new Error(`${meta.name || "the linked file"} is not a Google Doc or a Word file`);
      }
      const res = await request({
        url: `${DRIVE}${docId}?alt=media`,
        headers: { Authorization: `Bearer ${token}` },
        binary: true
      });
      if (res.status !== 200 || !res.buffer) {
        const e = new Error(`Google answered ${res.status} for the file`);
        e.status = res.status;
        throw e;
      }
      const word = require_review().readReview(
        Buffer.from(res.buffer),
        zlib
      );
      const flat = (t) => String(t || "").replace(/\s+/g, " ").trim();
      const inWord = new Map(word.filter((w) => w.kind === "comment").map((w) => [`${w.author}\0${flat(w.text)}`, w]));
      const extra = [];
      for (const c of drive) {
        const w = inWord.get(`${c.author}\0${flat(c.text)}`);
        if (w) Object.assign(w, { gid: c.gid, link: c.link });
        else extra.push(c);
      }
      return { title: meta.name || "", resolved, items: [...word, ...extra] };
    }
    module2.exports = {
      SCOPE,
      PICKER_PORT,
      pickerOrigin,
      readClient,
      docIdFromUrl,
      docUrl,
      pkce,
      signIn,
      accessToken,
      revoke,
      pick,
      pickerPage,
      suggestionItems,
      commentItems,
      fetchReview
    };
  }
});

// src/float.js
var require_float = __commonJS({
  "src/float.js"(exports2, module2) {
    "use strict";
    var TABLE_LINE = /^\s*\|/;
    var IMAGE = /!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\)/;
    var IMAGE_LINE = /^\s*(!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\))\s*$/;
    var IMAGE_FILE = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?|avif)(\|[^\]]*)?$/i;
    var IMAGE_LINK_LINE = /^\s*\[\[([^\]]+)\]\]\s*$/;
    var STARTER_TABLE = "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |";
    function split(body, kind) {
      const lines = String(body || "").split("\n");
      let content = [];
      let rest = lines;
      if (kind === "table") {
        content = lines.filter((l) => TABLE_LINE.test(l));
        rest = lines.filter((l) => !TABLE_LINE.test(l));
      } else {
        const k = lines.findIndex((l) => IMAGE_LINE.test(l) || IMAGE_LINK_LINE.test(l) && IMAGE_FILE.test(IMAGE_LINK_LINE.exec(l)[1]));
        if (k >= 0) {
          content = [linkedImage(lines[k])];
          rest = lines.filter((l, i) => i !== k);
        }
      }
      return { caption: rest.join("\n").trim(), content: content.join("\n") };
    }
    function compose(kind, caption, content) {
      const c = String(caption || "").trim();
      const t = String(content || "").trim();
      const parts = kind === "table" ? [c, t] : [t, c];
      return parts.filter(Boolean).join("\n\n");
    }
    function embedFor(path) {
      return `![[${path}]]`;
    }
    function imageTarget(embed) {
      const s = String(embed || "").trim();
      const wiki = /^!?\[\[([^\]|#]+)/.exec(s);
      if (wiki) return wiki[1].trim();
      const md = /^!?\[[^\]]*\]\(([^)]+)\)/.exec(s);
      return md ? md[1].trim() : s;
    }
    function linkedImage(text) {
      const s = String(text || "");
      const m = IMAGE.exec(s);
      if (m) return m[0];
      const w = /\[\[([^\]]+)\]\]/.exec(s);
      return w ? embedFor(w[1]) : null;
    }
    var PAPER_IN = { letter: 8.5, a4: 210 / 25.4 };
    var UNIT_IN = { pt: 1 / 72.27, mm: 1 / 25.4, cm: 1 / 2.54, in: 1 };
    function textWidthPt(st) {
      const paper = PAPER_IN[st && st.paper] || PAPER_IN.letter;
      const m = /^\s*([\d.]+)\s*(pt|mm|cm|in)\s*$/.exec(st && st.margin || "");
      const margin = m ? Number(m[1]) * UNIT_IN[m[2]] : 2.5 * UNIT_IN.cm;
      return (paper - 2 * margin) * 72;
    }
    function floatEditor(opts) {
      const kind = opts.kind;
      let { caption, content } = split(opts.value, kind);
      const root = createDiv({ cls: `dendrite-float-edit is-${kind}` });
      const head = root.createDiv({ cls: "dendrite-float-head" });
      head.createSpan({ text: `${opts.label || (kind === "table" ? "Table" : "Figure")} \xB7 editing` });
      const asText = head.createEl("a", {
        cls: "dendrite-float-astext",
        text: "Edit as text"
      });
      asText.addEventListener("mousedown", (e) => e.preventDefault());
      asText.addEventListener("click", (e) => {
        e.preventDefault();
        if (opts.onAsText) opts.onAsText();
      });
      const changed = () => opts.onChange();
      const field = (label, cls, value, onInput) => {
        const left = () => opts.onBlur();
        const wrap = root.createDiv({ cls: "dendrite-float-field" + (cls ? ` ${cls}` : "") });
        wrap.createDiv({ cls: "dendrite-float-label", text: label });
        if (opts.makeEditor) {
          const ed = opts.makeEditor(value, { onChange: () => {
            onInput(ed.value);
            changed();
          }, onBlur: left, onEscape: () => opts.onEscape() });
          wrap.appendChild(ed.el);
          return {
            get value() {
              return ed.value;
            },
            set(text) {
              ed.replace(text, 0);
            },
            focus(atStart) {
              ed.focus(atStart);
            },
            destroy() {
              ed.destroy();
            }
          };
        }
        const ta = wrap.createEl("textarea", { cls: "dendrite-float-input" });
        ta.rows = cls ? 6 : 2;
        ta.value = value;
        ta.addEventListener("input", () => {
          onInput(ta.value);
          changed();
        });
        ta.addEventListener("blur", left);
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            opts.onEscape();
          }
        });
        return {
          get value() {
            return ta.value;
          },
          set(text) {
            ta.value = text;
          },
          focus(atStart) {
            ta.focus();
            const at = atStart ? 0 : ta.value.length;
            ta.setSelectionRange(at, at);
          },
          destroy() {
          }
        };
      };
      let cap = null;
      let table = null;
      let image = null;
      let shown = null;
      const draw = () => {
        if (!shown) return;
        shown.empty();
        if (!linkedImage(content)) {
          shown.createDiv({
            cls: "dendrite-float-missing",
            text: "No image: type [[ in the Image field below to find one, or paste or drop one."
          });
          return;
        }
        opts.render(linkedImage(content), shown);
      };
      if (kind === "table") {
        cap = field(
          "Caption, printed above the table",
          null,
          caption,
          (v) => {
            caption = v;
          }
        );
        root.createDiv({
          cls: "dendrite-float-number",
          text: `${opts.label || "Table"}.`
        });
        table = field(
          "",
          "dendrite-float-table",
          content,
          (v) => {
            content = v;
          }
        );
      } else {
        shown = root.createDiv({ cls: "dendrite-float-shown is-image" });
        const wrap = root.createDiv({ cls: "dendrite-float-field dendrite-float-image" });
        wrap.createDiv({
          cls: "dendrite-float-label",
          text: "Image: search for one, or paste or drop one"
        });
        const input = wrap.createEl("input", {
          type: "text",
          cls: "dendrite-float-input"
        });
        input.placeholder = "Image file name";
        input.value = imageTarget(content);
        const choose = (v) => {
          const t = String(v || "").trim();
          content = !t ? "" : linkedImage(t) || embedFor(t);
          input.value = imageTarget(content);
          draw();
          changed();
        };
        input.addEventListener("change", () => choose(input.value));
        input.addEventListener("blur", () => opts.onBlur());
        input.addEventListener("keydown", (e) => {
          if (e.key === "Escape" && !e.defaultPrevented) {
            e.preventDefault();
            opts.onEscape();
          }
        });
        if (opts.findImage) opts.findImage(input, (link) => choose(link));
        image = {
          set(text) {
            input.value = imageTarget(text);
          },
          destroy() {
          }
        };
        cap = field(
          "Caption, printed below the figure",
          null,
          caption,
          (v) => {
            caption = v;
          }
        );
      }
      const take = async (dt) => {
        if (kind !== "figure" || !dt) return false;
        const file = [...dt.files || []].find((x) => /^image\//.test(x.type));
        let embed = null;
        if (file && opts.image) embed = await opts.image(file);
        if (!embed) embed = linkedImage(dt.getData && dt.getData("text/plain"));
        if (!embed) return false;
        content = embed;
        if (image) image.set(embed);
        draw();
        changed();
        return true;
      };
      if (kind === "figure") {
        root.addEventListener("paste", async (e) => {
          const dt = e.clipboardData;
          if (!dt) return;
          const image2 = [...dt.files || []].some((x) => /^image\//.test(x.type));
          const text = dt.getData && dt.getData("text/plain") || "";
          const link = linkedImage(text);
          if (!image2 && !(link && text.trim().replace(/^!/, "") === link.replace(/^!/, ""))) return;
          e.preventDefault();
          await take(dt);
        });
        root.addEventListener("dragover", (e) => e.preventDefault());
        root.addEventListener("drop", async (e) => {
          e.preventDefault();
          await take(e.dataTransfer);
        });
      }
      draw();
      return {
        kind: "float",
        el: root,
        ta: null,
        get value() {
          return compose(kind, caption, content);
        },
        focus(atStart) {
          cap.focus(atStart);
        },
        selection() {
          return [0, 0];
        },
        replace(text) {
          ({ caption, content } = split(text, kind));
          cap.set(caption);
          if (table) table.set(content);
          if (image) image.set(content);
          draw();
        },
        focusAt() {
          cap.focus(false);
        },
        caretRect() {
          return null;
        },
        rangeAt() {
          return null;
        },
        // For the tests: an image taken as if pasted or dropped.
        take,
        destroy() {
          cap.destroy();
          if (table) table.destroy();
          if (image) image.destroy();
          root.remove();
        }
      };
    }
    module2.exports = {
      split,
      compose,
      embedFor,
      linkedImage,
      imageTarget,
      textWidthPt,
      floatEditor,
      STARTER_TABLE
    };
  }
});

// src/timing.js
var require_timing = __commonJS({
  "src/timing.js"(exports2, module2) {
    "use strict";
    var stats = /* @__PURE__ */ new Map();
    var long = { n: 0, total: 0, max: 0 };
    var frames = { n: 0, total: 0, max: 0, layout: 0, scripts: /* @__PURE__ */ new Map() };
    var watched = /* @__PURE__ */ new WeakSet();
    var on = false;
    var now = () => typeof performance !== "undefined" ? performance.now() : Date.now();
    function setOn(value) {
      on = !!value;
      if (!on) {
        stats.clear();
        clearLong();
      }
    }
    function clearLong() {
      Object.assign(long, { n: 0, total: 0, max: 0 });
      Object.assign(frames, { n: 0, total: 0, max: 0, layout: 0 });
      frames.scripts.clear();
    }
    function isOn() {
      return on;
    }
    function record(step, ms) {
      if (!on) return;
      const s = stats.get(step) || { n: 0, total: 0, max: 0 };
      s.n++;
      s.total += ms;
      s.max = Math.max(s.max, ms);
      stats.set(step, s);
    }
    function wrap(proto, prefix, names) {
      for (const name of names) {
        const fn = proto[name];
        if (typeof fn !== "function") {
          throw new Error(`timing: no method ${prefix}.${name}`);
        }
        const step = `${prefix}.${name}`;
        proto[name] = function(...args) {
          if (!on) return fn.apply(this, args);
          const t0 = now();
          let out;
          try {
            out = fn.apply(this, args);
          } catch (err) {
            record(step, now() - t0);
            throw err;
          }
          if (out && typeof out.then === "function") {
            return out.finally(() => record(step, now() - t0));
          }
          record(step, now() - t0);
          return out;
        };
      }
    }
    function frame(e) {
      frames.n++;
      frames.total += e.duration;
      frames.max = Math.max(frames.max, e.duration);
      if (e.styleAndLayoutStart > 0) {
        frames.layout += e.startTime + e.duration - e.styleAndLayoutStart;
      }
      for (const s of e.scripts || []) {
        const url = String(s.sourceURL || "");
        const source = url.slice(url.lastIndexOf("/") + 1) || "(unknown)";
        frames.scripts.set(
          source,
          (frames.scripts.get(source) || 0) + s.duration
        );
      }
    }
    function watch(win) {
      if (!win || watched.has(win) || !win.PerformanceObserver) return;
      watched.add(win);
      const observe = (type, each) => {
        try {
          new win.PerformanceObserver((list) => {
            if (on) list.getEntries().forEach(each);
          }).observe({ type, buffered: false });
        } catch (err) {
        }
      };
      observe("longtask", (e) => {
        long.n++;
        long.total += e.duration;
        long.max = Math.max(long.max, e.duration);
      });
      observe("long-animation-frame", frame);
    }
    var round = (x) => Math.round(x * 10) / 10;
    function take() {
      if (!stats.size && !long.n && !frames.n) return null;
      const steps = [...stats].map(([step, s]) => ({
        step,
        n: s.n,
        total_ms: round(s.total),
        max_ms: round(s.max)
      })).sort((a, b) => b.total_ms - a.total_ms);
      const longtasks = {
        n: long.n,
        total_ms: round(long.total),
        max_ms: round(long.max)
      };
      const scripts = [...frames.scripts].map(([source, ms]) => ({ source, ms: round(ms) })).sort((a, b) => b.ms - a.ms).slice(0, 8);
      const longframes = {
        n: frames.n,
        total_ms: round(frames.total),
        max_ms: round(frames.max),
        layout_ms: round(frames.layout),
        scripts
      };
      stats.clear();
      clearLong();
      return { steps, longtasks, frames: longframes };
    }
    module2.exports = { setOn, isOn, record, wrap, watch, take, frame };
  }
});

// src/history.js
var require_history = __commonJS({
  "src/history.js"(exports2, module2) {
    "use strict";
    var KEEP = 20;
    var WINDOW_MS = 10 * 60 * 1e3;
    function hash(s) {
      let h1 = 3735928559;
      let h2 = 1103547991;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
      }
      h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
      h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
      return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }
    function memoryStore() {
      const m = /* @__PURE__ */ new Map();
      return {
        async get(k) {
          return m.has(k) ? structuredClone(m.get(k)) : null;
        },
        async set(k, v) {
          m.set(k, structuredClone(v));
        }
      };
    }
    function idbStore2(name = "dendrite-history") {
      const idb = typeof indexedDB !== "undefined" ? indexedDB : null;
      if (!idb) return memoryStore();
      let db = null;
      const open = () => db || (db = new Promise((resolve, reject) => {
        const req = idb.open(name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore("cards");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
      const run = async (mode, fn) => {
        const d = await open();
        return new Promise((resolve, reject) => {
          const tx = d.transaction("cards", mode);
          const req = fn(tx.objectStore("cards"));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => reject(tx.error);
        });
      };
      return {
        async get(k) {
          const v = await run("readonly", (s) => s.get(k));
          return v === void 0 ? null : v;
        },
        async set(k, v) {
          await run("readwrite", (s) => s.put(v, k));
        }
      };
    }
    var History2 = class {
      constructor(store = memoryStore(), now = () => Date.now()) {
        this.store = store;
        this.now = now;
        this.queue = /* @__PURE__ */ new Map();
      }
      serial(key, fn) {
        const prev = this.queue.get(key) || Promise.resolve();
        const next = prev.then(fn, fn);
        this.queue.set(key, next.catch(() => {
        }));
        return next;
      }
      /**
       * Record a card's text, compared by `compared` (its body, so a status
       * change alone is not a version). `outside` means Dendrite did not
       * write it. Returns 'reverted' when an outside text matches an older
       * version, else null.
       */
      observe(key, text, compared, outside) {
        return this.serial(key, async () => {
          const h = hash(compared);
          const rec = await this.store.get(key) || { versions: [], text: null, reverted: null };
          const v = rec.versions;
          const last = v[v.length - 1];
          if (rec.reverted) {
            if (last && last.h === h) {
              rec.reverted = null;
              rec.text = text;
              await this.store.set(key, rec);
            }
            return rec.reverted ? "reverted" : null;
          }
          if (last && last.h === h) {
            if (rec.text !== text) {
              rec.text = text;
              await this.store.set(key, rec);
            }
            return null;
          }
          if (outside && v.slice(0, -1).some((x) => x.h === h)) {
            rec.reverted = { h, at: this.now() };
            await this.store.set(key, rec);
            return "reverted";
          }
          const t = this.now();
          const o = !!outside;
          if (last && t - last.t < WINDOW_MS) {
            Object.assign(last, { h, s: t, o });
          } else v.push({ h, t, s: t, o });
          if (v.length > KEEP) v.splice(0, v.length - KEEP);
          rec.text = text;
          await this.store.set(key, rec);
          return null;
        });
      }
      /** The newest text recorded for a card gone back, else null. */
      async newer(key) {
        const rec = await this.store.get(key);
        return rec && rec.reverted ? rec.text : null;
      }
      /**
       * For a card gone back: the newest text recorded, with where and when
       * the newest version and the matched earlier one were seen. Null
       * when the card has not gone back.
       */
      async detail(key) {
        const rec = await this.store.get(key);
        if (!rec || !rec.reverted) return null;
        const v = rec.versions;
        const seen = (x) => x && { at: x.s || x.t, outside: x.o };
        const match = [...v].reverse().find((x) => x.h === rec.reverted.h);
        return {
          text: rec.text,
          before: seen(v[v.length - 1]),
          now: seen(match)
        };
      }
      /**
       * A note renamed: its versions follow it to `key` from `from`, unless
       * `key` has its own already.
       */
      adopt(key, from) {
        return this.serial(key, async () => {
          if (key === from || await this.store.get(key)) return;
          const rec = await this.store.get(from);
          if (rec) await this.store.set(key, rec);
        });
      }
      /** Accept the card's current text as its newest version. */
      keep(key, text, compared) {
        return this.serial(key, async () => {
          const rec = await this.store.get(key);
          if (!rec) return;
          rec.reverted = null;
          const t = this.now();
          rec.versions.push({ h: hash(compared), t, s: t, o: true });
          if (rec.versions.length > KEEP) {
            rec.versions.splice(0, rec.versions.length - KEEP);
          }
          rec.text = text;
          await this.store.set(key, rec);
        });
      }
    };
    module2.exports = { History: History2, hash, memoryStore, idbStore: idbStore2, KEEP, WINDOW_MS };
  }
});

// src/reviewapi.js
var require_reviewapi = __commonJS({
  "src/reviewapi.js"(exports2, module2) {
    "use strict";
    var MAX_BODY = 1 << 20;
    function send(res, status, json) {
      const body = JSON.stringify(json);
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      });
      res.end(body);
    }
    function readBody(req) {
      return new Promise((resolve, reject) => {
        let size = 0;
        const parts = [];
        req.on("data", (c) => {
          size += c.length;
          if (size <= MAX_BODY) parts.push(c);
        });
        req.on("end", () => resolve(size > MAX_BODY ? null : Buffer.concat(parts).toString("utf8")));
        req.on("error", reject);
      });
    }
    async function handle(opts, req, res) {
      if (req.headers.origin) {
        return send(res, 403, { error: "requests from web pages are refused" });
      }
      if (req.headers.authorization !== `Bearer ${opts.token}`) {
        return send(res, 401, { error: "missing or wrong key; it is in the discovery file" });
      }
      const url = new URL(req.url, "http://127.0.0.1");
      const take = {
        "/dendrite/review": opts.submit,
        "/dendrite/reply": opts.reply,
        "/dendrite/suggest": opts.suggest
      }[url.pathname];
      if (take && req.method === "POST") {
        if (!/^application\/json\b/.test(req.headers["content-type"] || "")) {
          return send(res, 415, { error: "send application/json" });
        }
        const text = await readBody(req);
        if (text === null) {
          return send(res, 413, { error: "over 1 MB" });
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
      if (url.pathname === "/dendrite/threads" && req.method === "GET" && opts.threads) {
        const prefix = (url.searchParams.get("manuscript") || "").trim();
        if (!prefix) {
          return send(res, 400, { error: "say which manuscript, by its prefix, as ?manuscript=" });
        }
        const q = (k) => url.searchParams.get(k) || null;
        const out = await opts.threads(prefix, {
          author: q("author"),
          awaiting: q("awaiting"),
          card: q("card")
        });
        return send(res, out.status, out.json);
      }
      const m = /^\/dendrite\/review\/([\w-]+)$/.exec(url.pathname);
      if (m && req.method === "GET") {
        const out = await opts.status(m[1]);
        return send(res, out.status, out.json);
      }
      return send(res, 404, { error: "not found" });
    }
    function start(opts, http = require("http")) {
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
          server.once("error", reject);
          server.listen(opts.port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve(server);
          });
        } catch (err) {
          reject(err);
        }
      });
    }
    module2.exports = { start, MAX_BODY };
  }
});

// src/profile.js
var require_profile = __commonJS({
  "src/profile.js"(exports2, module2) {
    "use strict";
    var timing2 = require_timing();
    var PHASE_WAIT = 1500;
    var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    function allowed(app, file) {
      const c = file && app.metadataCache.getFileCache(file);
      return !!(c && c.frontmatter && c.frontmatter.dendrite_profile === true);
    }
    async function profile(view, hooks) {
      const app = view.app;
      const saves = hooks.saves || 12;
      const every = hooks.every === void 0 ? 400 : hooks.every;
      const wait = hooks.wait === void 0 ? PHASE_WAIT : hooks.wait;
      const first = view.root.children[0];
      const card = first && view.cardFile(first.id);
      if (!card) throw new Error("the manuscript has no card to save into");
      const base = await app.vault.read(card);
      const was = timing2.isOn();
      const rows = [];
      const phase = async (name, run) => {
        timing2.take();
        const t0 = performance.now();
        await run();
        const ran = performance.now() - t0;
        await sleep(wait);
        const got = timing2.take() || { steps: [] };
        rows.push(Object.assign({
          phase: name,
          ran_ms: Math.round(ran)
        }, got, {
          steps: got.steps.slice(0, 10)
        }));
      };
      const save = async () => {
        for (let k = 1; k <= saves; k++) {
          await app.vault.modify(card, base + "\nProfile " + "x".repeat(k));
          await sleep(every);
        }
      };
      timing2.setOn(true);
      timing2.watch(view.contentEl.ownerDocument.defaultView);
      let preview = null;
      try {
        await phase("redraw the board", () => view.render());
        await phase("open the preview", async () => {
          preview = await hooks.openPreview();
        });
        await phase(`${saves} saves, preview open`, save);
        await phase("scroll the preview", async () => {
          const doc = preview && preview.contentEl.querySelector(
            ".dendrite-preview-doc"
          );
          for (let k = 0; k < 40 && doc; k++) {
            doc.scrollTop += 120;
            await sleep(16);
          }
        });
        await phase("close the preview", () => hooks.closePreview());
        await phase(`${saves} saves, preview closed`, save);
      } finally {
        await app.vault.modify(card, base);
        timing2.take();
        timing2.setOn(was);
      }
      return rows;
    }
    module2.exports = { allowed, profile };
  }
});

// src/main.js
var {
  ItemView,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownRenderer,
  Component,
  Modal,
  Notice,
  TFile,
  TFolder,
  Scope,
  setIcon,
  Platform,
  normalizePath,
  Keymap,
  requestUrl,
  AbstractInputSuggest,
  prepareFuzzySearch
} = require("obsidian");
var core = require_core();
var textedit = require_textedit();
var { cardEditor } = require_editor();
var pandoc = require_pandoc();
var review = require_review();
var google = require_google();
var float = require_float();
var timing = require_timing();
var { History, idbStore } = require_history();
var VIEW = "dendrite-view";
var ROLE_ITEMS = [
  ["section", "Prints its heading only", "heading", "1"],
  ["prose", "Prints its full text", "text", "2"],
  ["scaffolding", "Scaffolding: prints its children only", "layers", "3"],
  ["notes", "Left out of the manuscript", "eye-off", "4"]
];
var KIND_ITEMS = [
  [null, "Text", "type"],
  ["table", "Table: numbered, caption above", "table"],
  ["figure", "Figure: numbered, caption below", "image"]
];
var BRANCH_ROLE_NAMES = {
  "": "print automatically",
  section: "heading only",
  prose: "full text",
  scaffolding: "scaffolding",
  notes: "left out"
};
var ROLE_KEYS = new Map([
  ["0", null],
  ...ROLE_ITEMS.map((r) => [r[3], r[0]])
]);
var STATUS_ITEMS = [
  ["draft", "Status: draft", "pencil-line", "1"],
  ["done", "Status: done", "check", "2"],
  ["revise", "Status: revise", "flag", "3"]
];
var PREVIEW = "dendrite-preview";
var NOTES_AT = {
  section: "Footnotes collected under each section",
  end: "Footnotes collected at the end",
  card: "Footnotes under each card"
};
var DEFAULTS = {
  writingFolder: "Writing",
  headingTop: 1,
  cardWidth: 480,
  autosaveMs: 600,
  openInDendrite: true,
  vimKeys: true,
  manageLinter: true,
  lintCards: true,
  obsidianEditor: true,
  typewriter: true,
  pandocPath: "pandoc",
  pdfEngine: "xelatex",
  zoteroPort: 23119,
  fallbackBib: "",
  // Values added to the type property of index notes and cards, so file
  // lists and colour rules can tell a manuscript from its cards. The
  // index's is a link, giving manuscripts a type page; a card's is plain
  // text, keeping hundreds of cards out of the vault's links. Empty
  // writes none.
  indexType: "[[dendrite index]]",
  cardType: "dendrite card",
  // The Linter ignore entry Dendrite added itself, if any, so that only
  // that entry is ever removed again.
  linterAdded: null,
  // Reviews from programs on this computer, over a local port with a
  // key; off until turned on. Desktop only.
  reviewApi: false,
  reviewApiPort: 27130,
  reviewApiKey: "",
  // The name a reply to a review comment is signed with.
  replyName: "",
  // How a diff is shown: unified until side by side is picked.
  diffMode: "unified",
  // How you are shown where your replies are, and in what is sent out.
  presentName: "",
  recordTimings: false,
  // A notice for each time the board is moved sideways other than by
  // hand, naming what moved it.
  showBoardMoves: false,
  // Reviews submitted, pending until added or ignored on the board,
  // and the latest ones decided, so a submitter can ask.
  reviewQueue: [],
  // Google Docs: the OAuth client's JSON and the Picker API key, as
  // pasted, so every desktop the vault syncs to can sign in. Each
  // computer keeps its own sign-in token, outside the vault.
  googleClientJson: "",
  googlePickerKey: ""
};
var LINTER_ID = "obsidian-linter";
var CARD_UNSAFE_RULES = [
  "file-name-heading",
  "capitalize-headings",
  "no-bare-urls",
  "remove-multiple-spaces"
];
var CARD_NAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-[a-z0-9]{5}$/;
var UNDO_DEPTH = 50;
var CARD_MARGIN = 24;
var LABEL_IDLE_MS = 3e3;
function prefixOf(app, file) {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  const p = fm && fm.dendrite_prefix;
  return p ? String(p).trim() : null;
}
function isIndex(app, file) {
  return file instanceof TFile && file.extension === "md" && !!prefixOf(app, file);
}
function indexPrefix(text) {
  const m = /^dendrite_prefix:[ \t]*["']?([^"'\n]*?)["']?[ \t]*$/m.exec(core.splitFrontmatter(text).fm);
  return m ? m[1].trim() : null;
}
function formersOf(app, file) {
  return core.formerPrefixes(
    app.metadataCache.getFileCache(file)?.frontmatter
  );
}
function prefixesInUse(app, except = null) {
  const out = /* @__PURE__ */ new Set();
  for (const f of app.vault.getMarkdownFiles()) {
    const p = f !== except && prefixOf(app, f);
    if (!p) continue;
    out.add(p.toLowerCase());
    for (const q of formersOf(app, f)) out.add(q.toLowerCase());
  }
  return out;
}
function successorOf(app, prefix) {
  if (!prefix) return null;
  return app.vault.getMarkdownFiles().find((f) => {
    const p = prefixOf(app, f);
    return p && p !== prefix && formersOf(app, f).includes(prefix);
  }) || null;
}
var PATH_PROPS = [
  "dendrite_csl",
  "dendrite_pandoc_defaults",
  "dendrite_reference_docx"
];
function configDir() {
  const env = typeof process !== "undefined" && process.env && process.env.DENDRITE_CONFIG_DIR;
  if (env) return env;
  try {
    return require("path").join(
      require("os").homedir(),
      ".config",
      "dendrite"
    );
  } catch (err) {
    return "~/.config/dendrite";
  }
}
function configFile(name) {
  try {
    return require("path").join(configDir(), name);
  } catch (err) {
    return `${configDir()}/${name}`;
  }
}
function vaultFile(vault, name) {
  const safe = String(vault).replace(/[^\w .-]/g, "_").replace(/^\./, "_") || "_";
  return configFile(`vaults/${safe}/${name}`);
}
function discoveryPath(vault) {
  return vaultFile(vault, "review-api.json");
}
async function googleRequest(req) {
  const res = await requestUrl({
    url: req.url,
    method: req.method || "GET",
    headers: req.headers,
    body: req.body,
    contentType: req.contentType,
    throw: false
  });
  if (req.binary) return { status: res.status, buffer: res.arrayBuffer };
  let json = null;
  try {
    json = res.json;
  } catch (err) {
    json = null;
  }
  return { status: res.status, json };
}
function openExternal(url) {
  try {
    require("electron").shell.openExternal(url);
  } catch (err) {
    window.open(url);
  }
}
var stuckNotices = /* @__PURE__ */ new Map();
function stickyNotice(key, text) {
  const old = stuckNotices.get(key);
  if (old) old.hide();
  const n = new Notice(text, 0);
  stuckNotices.set(key, n);
  return n;
}
function dismissNotices() {
  const n = stuckNotices.size;
  for (const x of stuckNotices.values()) x.hide();
  stuckNotices.clear();
  return n;
}
function noteOf(app, cache, id, from) {
  const had = cache.get(id);
  if (had && had.basename === id && app.vault.getAbstractFileByPath(had.path) === had) return had;
  const f = app.metadataCache.getFirstLinkpathDest(id, from);
  if (f instanceof TFile) {
    cache.set(id, f);
    return f;
  }
  cache.delete(id);
  return null;
}
function setStyles(el, styles) {
  for (const [k, v] of Object.entries(styles)) {
    if (el.style[k] !== v) el.style[k] = v;
  }
}
var DRAW_REACH = 2;
var DRAW_BATCH = 8;
var SLOT_FRAME = 118;
var SLOT_PADDING = 28;
var SLOT_CHAR = 8;
var SLOT_LINE = 24;
var HEIGHT_SAMPLES = 8;
var LONG_MOVE = 1.5;
var EMPTY_REACH = 5;
function idleDrawer(winOf, next, busy) {
  let handle = null;
  let stopped = false;
  const run = async () => {
    handle = null;
    if (stopped) return;
    if (busy()) {
      handle = { timer: winOf().setTimeout(run, 250) };
      return;
    }
    const job = next();
    if (!job) return;
    try {
      await job;
    } catch (err) {
      console.error("Dendrite: drawing while idle failed", err);
    }
    schedule();
  };
  const schedule = () => {
    if (stopped || handle) return;
    const win = winOf();
    handle = win.requestIdleCallback ? { idle: win.requestIdleCallback(run) } : { timer: win.setTimeout(run, 200) };
  };
  const stop = () => {
    stopped = true;
    if (!handle) return;
    const win = winOf();
    if (handle.idle !== void 0) win.cancelIdleCallback(handle.idle);
    else win.clearTimeout(handle.timer);
    handle = null;
  };
  return { schedule, stop };
}
function externalLinks(el) {
  for (const a of el.querySelectorAll("a.dendrite-review-link")) {
    a.target = "_blank";
    a.rel = "noopener nofollow";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openExternal(a.href);
    });
  }
}
function dendriteMenu(icons = true) {
  const { Menu } = require("obsidian");
  return styleMenu(new Menu(), icons);
}
function ownKeys(app, el) {
  const scope = new Scope(app.scope);
  el.addEventListener("focus", () => {
    if (app.keymap) app.keymap.pushScope(scope);
  });
  el.addEventListener("blur", () => {
    if (app.keymap) app.keymap.popScope(scope);
  });
}
var MAX_REPLY = 500;
var REFUSED = -2;
function withReply(body, n, reply) {
  const { replace, ...r } = reply;
  return replace ? review.replaceReplies(body, n, r.author, r) : review.addReply(body, n, r);
}
function localDay(d = /* @__PURE__ */ new Date()) {
  const two = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
function colourTitle(c) {
  const doc = typeof activeDocument !== "undefined" ? activeDocument : document;
  const frag = doc.createDocumentFragment();
  const chip = frag.appendChild(doc.createElement("span"));
  chip.className = "dendrite-colour-chip";
  chip.style.setProperty("--dendrite-chip", review.colourCss(c));
  frag.append(c[0].toUpperCase() + c.slice(1));
  return frag;
}
function showCommentMenu(items, event, act, colours = null) {
  const m = dendriteMenu(false);
  for (const [what, label, warn] of items) {
    m.addItem((i) => {
      i.setTitle(label).onClick(() => act(what));
      if (warn && typeof i.setWarning === "function") i.setWarning(true);
    });
  }
  if (colours) {
    m.addSeparator();
    m.addItem((i) => {
      i.setTitle(`Colour for ${colours.author}`);
      const sub = i.setSubmenu();
      for (const c of review.REVIEWER_COLOURS) {
        sub.addItem((x) => {
          x.setTitle(colourTitle(c)).onClick(() => colours.pick(c));
          if (typeof x.setChecked === "function") {
            x.setChecked(c === colours.current);
          }
        });
      }
    });
  }
  if (event && m.showAtMouseEvent) m.showAtMouseEvent(event);
  return m;
}
function openInImageToolkit(app, e) {
  const img = e.target;
  if (!img || img.tagName !== "IMG") return false;
  const kit = app.plugins && app.plugins.plugins && app.plugins.plugins["obsidian-image-toolkit"];
  if (!kit || typeof kit.clickImage !== "function") return false;
  kit.clickImage(e);
  return true;
}
function narrowSplit(leaf, share = 1 / 3) {
  let item = leaf;
  while (item && item.parent && !(item.parent.direction === "vertical" && (item.parent.children || []).length > 1)) item = item.parent;
  const split = item && item.parent;
  if (!split || typeof item.setDimension !== "function") return false;
  const rest = split.children.filter((c) => c !== item);
  item.setDimension(100 * share);
  for (const c of rest) {
    if (typeof c.setDimension === "function") {
      c.setDimension(100 * (1 - share) / rest.length);
    }
  }
  return true;
}
function styleMenu(m, icons) {
  if (m.dom && m.dom.addClass) m.dom.addClass("dendrite-menu");
  if (!icons && typeof m.setNoIcon === "function") m.setNoIcon();
  m.dendriteIcons = icons;
  return m;
}
function barSwitch(bar, title, views, now, pick) {
  const seg = bar.createDiv({ cls: "dendrite-seg" });
  seg.setAttr("aria-label", title);
  for (const [value, label, tip] of views) {
    const b = seg.createEl(
      "button",
      { cls: "dendrite-bar-btn dendrite-seg-btn", text: label }
    );
    b.setAttr("aria-label", tip);
    b.toggleClass("is-on", now === value);
    b.onclick = () => {
      if (value === now) return;
      now = value;
      for (const x of seg.children) {
        x.toggleClass("is-on", x === b);
      }
      pick(value);
    };
  }
  return seg;
}
function barButton(bar, icon, label, title, fn, menu = false) {
  const b = bar.createEl("button", { cls: "dendrite-bar-btn" });
  setIcon(b.createSpan({ cls: "dendrite-bar-icon" }), icon);
  if (label) b.createSpan({ text: label });
  if (menu) {
    b.addClass("is-menu");
    setIcon(b.createSpan({ cls: "dendrite-bar-caret" }), "chevron-down");
  }
  b.setAttr("aria-label", title);
  b.onclick = fn;
  return b;
}
function reviewAuthors(items) {
  return [...new Set(items.map((x) => x.author || "Reviewer"))].join(", ");
}
function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
}
var DendriteView = class extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null;
    this.root = core.makeRoot();
    this.byId = /* @__PURE__ */ new Map();
    this.active = null;
    this.lastChild = /* @__PURE__ */ new Map();
    this.cardEls = /* @__PURE__ */ new Map();
    this.rendered = /* @__PURE__ */ new Map();
    this.editing = null;
    this.undo = [];
    this.redo = [];
    this.texts = /* @__PURE__ */ new Map();
    this.selfWrites = /* @__PURE__ */ new Set();
    this.reloadTimer = null;
    this.indexList = null;
    this.indexText = null;
    this.dropBase = null;
    this.dropped = /* @__PURE__ */ new Map();
    this.indexReverted = false;
    this.revertedAt = /* @__PURE__ */ new Map();
    this.held = /* @__PURE__ */ new Map();
    this.versionInfo = /* @__PURE__ */ new Map();
    this.labelTimer = null;
    this.ownBodies = /* @__PURE__ */ new Map();
    this.reverted = /* @__PURE__ */ new Set();
    this.printOnly = false;
    this.shown = null;
    this.renaming = false;
    this.loadedPrefix = null;
    this.arriving = 0;
    this.oldCopies = [];
    this.renameTimer = null;
    this.copiesTimer = null;
    this.inbox = [];
    this.picked = /* @__PURE__ */ new Set();
    this.fannedId = null;
    this.fanEl = null;
    this.fanReady = Promise.resolve();
    this.fanComps = [];
    this.history = plugin.history || new History();
    this.scope = new Scope(this.app.scope);
    this.registerKeys();
  }
  getViewType() {
    return VIEW;
  }
  getIcon() {
    return "list-tree";
  }
  getDisplayText() {
    return this.file ? this.file.basename : "Dendrite";
  }
  getState() {
    return {
      file: this.file ? this.file.path : null,
      printOnly: this.printOnly
    };
  }
  async setState(state, result) {
    const f = state && state.file && this.app.vault.getAbstractFileByPath(state.file);
    if (f instanceof TFile) {
      this.file = f;
      if (state.printOnly !== void 0) {
        this.printOnly = !!state.printOnly;
      }
      await this.reload();
      const next = successorOf(this.app, this.loadedPrefix);
      if (next) {
        await this.follow(next);
        return super.setState(state, result);
      }
      if (state.card && this.byId.has(state.card)) {
        this.active = state.card;
        this.applyActive(false);
      }
      this.contentEl.focus();
    }
    return super.setState(state, result);
  }
  async onOpen() {
    this.contentEl.addClass("dendrite");
    this.contentEl.tabIndex = 0;
    this.observer = new IntersectionObserver(
      (entries) => this.onVisible(entries),
      { root: null, rootMargin: "600px 200px" }
    );
    this.resizer = new ResizeObserver((entries) => this.onResize(entries));
    this.registerEvent(this.app.vault.on(
      "modify",
      (f) => this.onModify(f)
    ));
    for (const e of ["create", "delete", "rename"]) {
      this.registerEvent(this.app.vault.on(e, () => {
        if (this.notes) this.notes.clear();
      }));
    }
    this.registerEvent(this.app.vault.on("rename", (f, old) => {
      if (this.file && f === this.file) {
        this.leaf.updateHeader();
        this.history.adopt(
          this.historyKey(null),
          this.historyKey(null, old)
        );
      } else if (f instanceof TFile && !this.renaming) {
        this.onRenameCard(f, old);
        this.scheduleRenameChecks();
      }
    }));
    this.registerEvent(this.app.vault.on("create", (f) => {
      if (!(f instanceof TFile) || this.renaming || !this.file) return;
      if (this.byId.has(f.basename)) {
        this.invalidate(f.basename);
        this.renderCard(f.basename);
      }
      this.scheduleRenameChecks();
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      if (this.renaming) return;
      if (f === this.file) {
        const next = successorOf(this.app, this.loadedPrefix);
        if (next) this.follow(next);
        else this.leaf.detach();
        return;
      }
      if (f instanceof TFile) this.scheduleRenameChecks();
      if (f instanceof TFile && this.dropped.has(f.basename)) {
        this.dropped.delete(f.basename);
        if (!this.dropped.size) this.dropBase = null;
        this.flagIndex();
      } else if (f instanceof TFile && this.byId.has(f.basename)) {
        this.invalidate(f.basename);
        this.renderCard(f.basename);
      }
    }));
    this.registerEvent(this.app.metadataCache.on(
      "changed",
      (f) => this.onMetadata(f)
    ));
    this.registerDomEvent(
      this.contentEl,
      "click",
      (e) => this.onClick(e)
    );
    if (this.app.workspace.on) {
      this.registerEvent(this.app.workspace.on(
        "layout-change",
        () => this.showPreviewOn()
      ));
    }
    this.registerDomEvent(
      this.contentEl,
      "keydown",
      (e) => this.onNavKey(e)
    );
    this.registerDomEvent(
      this.contentEl,
      "pointerdown",
      (e) => this.onDragDown(e)
    );
    this.dragMove = (e) => this.onDragMove(e);
    this.dragUp = (e) => this.onDragUp(e);
    this.dragCancel = () => this.cancelDrag();
    this.registerDomEvent(this.contentEl, "contextmenu", async (e) => {
      const card = e.target.closest(".dendrite-card");
      if (!card || e.target.closest("textarea, .dendrite-cm")) return;
      e.preventDefault();
      await this.select(card.dataset.id, false);
      this.cardMenu(card, e);
    });
    this.registerDomEvent(this.contentEl, "dblclick", (e) => {
      const card = e.target.closest(".dendrite-card");
      if (card && !this.editing) this.startEdit(card.dataset.id);
    });
    this.registerDomEvent(
      window,
      "beforeunload",
      () => {
        this.flush();
      }
    );
  }
  async onClose() {
    if (this.idleDraw) this.idleDraw.stop();
    clearTimeout(this.renameTimer);
    clearTimeout(this.copiesTimer);
    for (const c of this.fanComps.splice(0)) c.unload();
    this.cancelDrag();
    this.hideQuotaTip();
    this.closeQuotaEditor();
    await this.flush();
    if (this.observer) this.observer.disconnect();
    if (this.resizer) this.resizer.disconnect();
    for (const r of this.rendered.values()) r.comp.unload();
    this.rendered.clear();
  }
  // ---- loading ---------------------------------------------------------
  async reload() {
    if (!this.file) return;
    const text = await this.app.vault.read(this.file);
    this.loadText(text);
    this.loadedPrefix = indexPrefix(text);
    this.checkArriving(false);
    this.scheduleOldCopies();
    this.render(true);
    this.refreshInbox();
    this.versionsChecked = this.checkVersions().catch((err) => console.error("Dendrite: version check failed", err));
  }
  /**
   * Add the index's and every card's type value, where missing. Run
   * from a command, never on opening, since every device would make
   * the same writes at once.
   */
  async sweepTypes() {
    const s = this.plugin.settings;
    if (s.indexType && this.file) {
      await addType(this.app, this.file, s.indexType);
    }
    if (!s.cardType) return;
    for (const n of core.allNodes(this.root)) {
      const f = this.cardFile(n.id);
      if (f) await addType(this.app, f, s.cardType);
    }
  }
  loadText(text) {
    const { body } = core.splitFrontmatter(text);
    this.root = core.parseIndex(body).root;
    this.indexList = core.serialiseTree(this.root);
    if (!this.dropBase) this.indexText = text;
    this.reindex();
    if (!this.active || !this.byId.has(this.active)) {
      const first = this.root.children[0];
      this.active = first ? first.id : null;
    }
  }
  reindex() {
    this.byId.clear();
    for (const n of core.allNodes(this.root)) this.byId.set(n.id, n);
  }
  prefix() {
    return this.file ? prefixOf(this.app, this.file) : null;
  }
  /**
   * The document and window the board is in. Dendrite can sit in a
   * popout window, whose document is not the global one, so anything
   * placed on the page, or measured or listened for there, goes
   * through these.
   */
  pageDoc() {
    return this.contentEl.ownerDocument || document;
  }
  pageWin() {
    return this.pageDoc().defaultView || window;
  }
  cardsFolder() {
    const dir = this.file.parent ? this.file.parent.path : "";
    return normalizePath((dir && dir !== "/" ? dir + "/" : "") + "cards");
  }
  cardFile(id) {
    this.notes = this.notes || /* @__PURE__ */ new Map();
    return noteOf(
      this.app,
      this.notes,
      id,
      this.file ? this.file.path : ""
    );
  }
  // ---- the print-only view ----------------------------------------------
  /**
   * The cards that print, each where it prints: a card left out goes
   * with its branch, and a scaffolding card's children take its place
   * under its parent, as export prints them a level up. So each column
   * is a heading level of the printed document.
   */
  shownTree() {
    const roleOf = (x) => this.printRoleOf(x);
    const parent = /* @__PURE__ */ new Map();
    const kids = /* @__PURE__ */ new Map();
    const walk = (n, under) => {
      const out = [];
      for (const c of n.children) {
        if (!this.printOnly) {
          if (this.isSuperseded(c.id)) continue;
          parent.set(c.id, under);
          kids.set(c.id, walk(c, c));
          out.push(c);
          continue;
        }
        const role = core.roleFor(c, roleOf);
        if (role === "notes") continue;
        if (role === "scaffolding") {
          out.push(...walk(c, under));
          continue;
        }
        parent.set(c.id, under);
        kids.set(c.id, walk(c, c));
        out.push(c);
      }
      return out;
    };
    kids.set(null, walk(this.root, this.root));
    return { parent, kids };
  }
  /** A shown tree as text, to tell when it changes. */
  shownKey(t) {
    return [...t.parent].map(([id, p]) => `${id}<${p.id}`).join(" ");
  }
  /** A card's children as the board shows them. */
  kidsOf(n) {
    return this.shown ? this.shown.kids.get(n.id) || [] : n.children;
  }
  /** A card's parent as the board shows it. */
  upOf(n) {
    return this.shown ? this.shown.parent.get(n.id) || null : n.parent;
  }
  /** Every card shown below one, in order. */
  shownBelow(node) {
    const out = [];
    const walk = (n) => {
      for (const c of this.kidsOf(n)) {
        out.push(c);
        walk(c);
      }
    };
    walk(node);
    return out;
  }
  /** The shown card nearest a hidden one: the next that prints. */
  nearestShown(id) {
    const all = core.allNodes(this.root);
    const at = all.findIndex((n) => n.id === id);
    const shown = (n) => this.shown.parent.has(n.id);
    const pick = all.slice(at + 1).find(shown) || all.slice(0, Math.max(at, 0)).reverse().find(shown);
    return pick ? pick.id : null;
  }
  togglePrintOnly() {
    this.printOnly = !this.printOnly;
    if (this.editing) this.endEdit();
    this.render();
    this.app.workspace.requestSaveLayout();
  }
  /** True, with a notice, when the print-only view is on. */
  refuseInPrintView() {
    if (!this.printOnly) return false;
    new Notice('Dendrite: the print-only view shows the cards where they print, not where they sit in the index, so the structure is changed with every card shown. Click "Printed" in the bar to show them.', 8e3);
    return true;
  }
  // ---- rendering -------------------------------------------------------
  /**
   * Draw the board again. `outside` is a rebuild for a change made
   * elsewhere, such as a sync, which leaves a board scrolled by hand
   * where it was scrolled to rather than centring the active card.
   */
  render(outside = false) {
    const held = outside && this.scrolledByHand && this.board ? this.scrollState() : null;
    const ed = this.editing;
    const focused = this.pageDoc().activeElement;
    const keep = ed && ed.editor.el.contains(focused) && ed.editor.selection();
    const f = this.find;
    const typing = f && f.input === focused && [f.input.selectionStart, f.input.selectionEnd];
    this.drawBoard(held);
    if (keep && this.editing === ed && ed.editor.el.isConnected) {
      ed.editor.focusAt(keep[0], keep[1]);
    }
    if (this.find) {
      this.renderFind();
      if (typing) {
        this.find.input.focus();
        this.find.input.setSelectionRange(typing[0], typing[1]);
      }
    }
  }
  drawBoard(held = null) {
    const el = this.contentEl;
    if (this.observer) this.observer.disconnect();
    if (this.resizer) this.resizer.disconnect();
    this.keepFilled = /* @__PURE__ */ new Set();
    for (const [id] of this.liveCards()) this.keepFilled.add(id);
    el.empty();
    this.cardEls.clear();
    el.style.setProperty(
      "--dendrite-card-width",
      this.plugin.settings.cardWidth + "px"
    );
    if (!this.file) {
      el.createDiv({
        cls: "dendrite-empty",
        text: "Open an index note in Dendrite."
      });
      return;
    }
    this.renderBar(el);
    const stage = el.createDiv({ cls: "dendrite-stage" });
    const board = stage.createDiv({ cls: "dendrite-board" });
    this.board = board;
    this.nativeScroll = !!Platform.isMobile;
    board.toggleClass("is-native-scroll", this.nativeScroll);
    const NS = "http://www.w3.org/2000/svg";
    this.flowSvg = this.pageDoc().createElementNS(NS, "svg");
    this.flowSvg.classList.add("dendrite-flow");
    board.appendChild(this.flowSvg);
    this.colInners = [];
    this.offsets = [];
    board.addEventListener("scroll", (e) => {
      if (e.target === board) return;
      const col = e.target;
      if (!this.nativeScroll && col.scrollTop && col.classList.contains("dendrite-col")) {
        const d = Number(col.dataset.depth);
        const by = col.scrollTop;
        col.scrollTop = 0;
        this.setColOffset(d, this.colOffset(d) + by);
      }
      this.scheduleFlow();
      this.drawWhenIdle();
    }, true);
    for (const t of ["copy", "cut"]) {
      board.addEventListener(t, () => this.holdBoardScroll(), true);
    }
    if (!this.nativeScroll) {
      board.addEventListener(
        "wheel",
        (e) => this.onWheel(e),
        { passive: false }
      );
    } else {
      board.addEventListener("touchmove", () => {
        this.scrolledByHand = true;
      }, { passive: true });
    }
    this.watchBoardMoves(board);
    board.addEventListener("pointerdown", (e) => {
      if (e.target === board) this.scrolledByHand = true;
    });
    const pinned = stage.createDiv({ cls: "dendrite-pinned" });
    this.renderOrphans(pinned);
    this.renderOldComments(pinned);
    if (this.resizer) this.resizer.observe(board);
    board.toggleClass("is-print-only", this.printOnly);
    this.shown = this.shownTree();
    if (this.shown && this.active && !this.shown.parent.has(this.active)) {
      this.active = this.nearestShown(this.active);
    }
    const cols = core.columns(this.root, (n) => this.kidsOf(n));
    this.cols = cols;
    if (!cols.length) {
      const empty = board.createDiv({ cls: "dendrite-empty" });
      empty.createSpan({ text: "No cards yet. " });
      const b = empty.createEl("button", { text: "Add the first card" });
      b.onclick = () => this.insert("first");
      return;
    }
    cols.forEach((nodes, d) => {
      const col = board.createDiv({ cls: "dendrite-col" });
      col.dataset.depth = String(d);
      const inner = col.createDiv({ cls: "dendrite-col-inner" });
      this.colInners[d] = inner;
      this.offsets[d] = 0;
      inner.createDiv({ cls: "dendrite-spacer" });
      let group = null;
      let parent;
      for (const n of nodes) {
        if (!group || this.upOf(n) !== parent) {
          group = inner.createDiv({ cls: "dendrite-group" });
          parent = this.upOf(n);
        }
        this.renderShell(group, n);
      }
      inner.createDiv({ cls: "dendrite-spacer" });
    });
    this.keepFilled = null;
    this.fanReady = this.renderFan(stage);
    if (held) {
      this.highlight();
      this.restoreScroll(held);
    } else {
      this.applyActive(false);
    }
    this.announceScroll();
    this.updateNumbers();
    this.updateRoles();
    this.updateStatuses();
    this.updateCounts();
    this.scheduleChanged();
  }
  renderBar(el) {
    const bar = el.createDiv({ cls: "dendrite-bar" });
    const btn = (icon, label, title, fn, menu) => barButton(bar, icon, label, title, fn, menu);
    btn(
      "settings",
      "",
      "This manuscript's settings",
      () => this.openManuscriptSettings()
    );
    btn(
      "file-text",
      "",
      "Open the index note as markdown",
      () => this.plugin.openAsMarkdown(this.file)
    ).addClass("dendrite-bar-gap");
    btn("undo-2", "Undo", "Undo the last change to the tree: moves, new and deleted cards, roles and statuses (Ctrl+Z). A card's text is undone inside the card.", () => this.doUndo());
    btn("redo-2", "Redo", "Redo what was undone (Ctrl+Shift+Z or Ctrl+Y)", () => this.doRedo()).addClass("dendrite-bar-gap");
    this.previewBtn = btn(
      "scroll-text",
      "Preview",
      "Show what export would print beside the board, or close it",
      async () => {
        await this.plugin.togglePreview(this.file);
        this.showPreviewOn();
      }
    );
    this.previewBtn.addClass("is-toggle");
    this.showPreviewOn();
    barSwitch(
      bar,
      "Which cards the board shows",
      [
        [false, "All", "Show every card"],
        [true, "Printed", "Show only the cards that print, each where it prints, headings by their heading line alone"]
      ],
      this.printOnly,
      (on) => {
        if (this.printOnly !== on) this.togglePrintOnly();
      }
    );
    btn("file-output", "Export", "Export the manuscript to markdown, PDF or Word", (e) => this.exportMenu(null, e), true).addClass("dendrite-bar-gap-before");
    this.reviewBtn = btn("inbox", "Review", "Bring in review comments: from the linked Google Doc, a returned Word file, or programs", (e) => this.reviewMenu(e), true);
    this.showInboxBadge();
    this.modeEl = bar.createDiv({ cls: "dendrite-mode" });
    this.showMode();
    this.totalEl = bar.createDiv({ cls: "dendrite-total" });
    this.statusEl = bar.createDiv({ cls: "dendrite-tally" });
  }
  /**
   * Card notes in cards/ that the index does not link, in a panel
   * floating over the board's top right, each to add or to delete.
   */
  async renderOrphans(stage) {
    const files = this.unlinkedCards();
    if (!files.length) return;
    const panel = stage.createDiv({ cls: "dendrite-orphans" });
    const head = panel.createDiv({ cls: "dendrite-orphans-head" });
    head.createSpan({ text: `${files.length} card note(s) not in the index` });
    const list = panel.createDiv({ cls: "dendrite-orphans-list" });
    const empty = [];
    for (const f of files) {
      const body = core.splitFrontmatter(
        await this.app.vault.cachedRead(f)
      ).body;
      if (!body.trim()) empty.push(f);
      const row = list.createDiv({ cls: "dendrite-orphan" });
      row.createSpan({
        cls: "dendrite-orphan-label",
        text: core.deriveLabel(body, null) || "empty"
      });
      const add = row.createEl("button", { text: "Add" });
      add.setAttr("aria-label", "Add at the end of the index");
      add.onclick = () => this.adopt([f]);
      const del = row.createEl("button", {
        cls: "mod-warning",
        text: "Delete"
      });
      del.setAttr("aria-label", "Move the note to the trash");
      del.onclick = () => this.trashOrphans([f]);
    }
    const foot = panel.createDiv({ cls: "dendrite-orphans-foot" });
    const all = foot.createEl("button", { text: "Add all" });
    all.onclick = () => this.adopt(files);
    if (empty.length) {
      const b = foot.createEl("button", {
        cls: "mod-warning",
        text: `Delete ${empty.length} empty`
      });
      b.onclick = () => this.trashOrphans(empty);
    }
  }
  /**
   * Review comments still in the old form, ==passage== then its note,
   * offered a one-way conversion to markers, the form Dendrite now
   * writes, in a panel over the board.
   */
  async renderOldComments(pinned) {
    await this.loadBodies();
    let n = 0;
    let cards = 0;
    for (const b of this.bodies.values()) {
      if (b.old === void 0) b.old = review.oldComments(b.body);
      n += b.old;
      if (b.old) cards++;
    }
    if (!n || !this.contentEl.contains(pinned)) return;
    const panel = pinned.createDiv({
      cls: "dendrite-orphans dendrite-old-comments"
    });
    panel.createDiv({
      cls: "dendrite-orphans-head",
      text: `${n} review comment${n === 1 ? "" : "s"} in ${cards} card${cards === 1 ? "" : "s"} are in the old style`
    });
    panel.createDiv({
      cls: "dendrite-old-comments-desc",
      text: "Converting holds each passage between markers, which lets comments overlap and draws them alike everywhere. It is one way: a device still on an older Dendrite shows converted comments without their passages. The text itself does not change, and Undo takes it back."
    });
    const foot = panel.createDiv({ cls: "dendrite-orphans-foot" });
    const go = foot.createEl("button", {
      cls: "mod-cta",
      text: "Convert"
    });
    go.onclick = () => this.convertOldComments();
  }
  /** Every card's old-form comments converted to markers, one undo. */
  async convertOldComments() {
    if (this.editing) await this.endEdit();
    const restores = [];
    let n = 0;
    for (const node of core.allNodes(this.root)) {
      const f = this.cardFile(node.id);
      if (!f) continue;
      const data = await this.app.vault.read(f);
      const { body } = core.splitFrontmatter(data);
      const k = review.oldComments(body);
      if (!k) continue;
      const next = review.convertOld(body);
      const out = await this.writeCard(f, (d) => core.splitFrontmatter(d).fm + next);
      restores.push({
        path: f.path,
        text: data,
        ifBody: core.splitFrontmatter(out).body
      });
      n += k;
      this.invalidate(node.id);
    }
    if (restores.length) {
      this.pushUndo({
        active: this.active,
        files: [],
        text: true,
        restores
      });
    }
    new Notice(`Dendrite: converted ${n} review comment${n === 1 ? "" : "s"} to the new style.`);
    this.render();
  }
  async trashOrphans(files) {
    for (const f of files) await this.app.fileManager.trashFile(f);
    this.render();
  }
  /**
   * A card's place on the board. Far from the view it is a slot, one
   * empty element as tall as the card was when last drawn, or as its
   * text is estimated to be, so the board keeps its shape while holding
   * a handful of elements per card instead of its full frame; near the
   * view it is filled (fillFrame). A card filled before the board was
   * rebuilt, or being written, is filled again at once.
   */
  renderShell(group, n) {
    const card = group.createDiv({ cls: "dendrite-card" });
    card.dataset.id = n.id;
    if (this.kidsOf(n).length) card.addClass("has-children");
    this.cardEls.set(n.id, card);
    if (this.editing && this.editing.id === n.id || this.keepFilled && this.keepFilled.has(n.id)) {
      this.fillFrame(n.id);
    } else {
      this.makeSlot(n.id, card);
    }
    if (this.observer && !card.hasClass("is-slot")) {
      this.observer.observe(card);
    }
    if (this.resizer) this.resizer.observe(card);
  }
  /** A card emptied to its slot, at the height it is to keep. */
  makeSlot(id, card) {
    card.addClass("is-slot");
    card.style.height = `${this.slotHeight(id)}px`;
    if (this.observer) this.observer.observe(card);
    this.drawWhenIdle();
  }
  /**
   * How tall a card's slot is: as tall as the card was when last
   * drawn, or, never drawn, an estimate from its text's length.
   */
  slotHeight(id) {
    const known = this.heights && this.heights.get(id);
    if (known) return known;
    const lines = this.slotLines(id);
    const fit = this.heightFit();
    if (fit) return Math.max(SLOT_LINE, Math.round(fit.a + fit.b * lines));
    return SLOT_FRAME + lines * SLOT_LINE;
  }
  /** How many lines a card's text would take, roughly: its length. */
  slotLines(id) {
    const b = this.bodies && this.bodies.get(id);
    const chars = b ? b.body.length : 0;
    const perLine = Math.max(20, (this.plugin.settings.cardWidth - SLOT_PADDING) / SLOT_CHAR);
    return Math.max(1, Math.ceil(chars / perLine));
  }
  /** A drawn card's height, kept for its slot and learnt from. */
  learnHeight(id, h) {
    if (!id || !h) return;
    this.heights = this.heights || /* @__PURE__ */ new Map();
    this.heights.set(id, h);
    if (!this.bodies || !this.bodies.has(id)) return;
    this.samples = this.samples || /* @__PURE__ */ new Map();
    this.samples.set(id, [this.slotLines(id), h]);
    this.fit = null;
  }
  /**
   * Height against lines, fitted by least squares over the cards drawn,
   * as { a, b }: so a slot never drawn is estimated from how this
   * manuscript's cards come out in this font and width. Null until
   * HEIGHT_SAMPLES cards are measured.
   */
  heightFit() {
    if (!this.fit) {
      this.fit = core.fitHeights([...(this.samples || /* @__PURE__ */ new Map()).values()], HEIGHT_SAMPLES, SLOT_LINE);
    }
    return this.fit;
  }
  /**
   * A slot filled with the card's frame: its role icon and grip, its
   * text, drawn or waiting to be, and its footer, then each thing shown
   * on a card (decorateCard). The card, or undefined.
   */
  fillFrame(id) {
    const card = this.cardEls.get(id);
    const n = this.byId.get(id);
    if (!card || !n) return card;
    if (card.childElementCount && !card.hasClass("is-slot")) return card;
    const was = card.style.height;
    card.removeClass("is-slot");
    card.style.height = "";
    const grip = card.createDiv({ cls: "dendrite-grip" });
    grip.createSpan({ cls: "dendrite-role-icon" });
    setIcon(
      grip.createSpan({ cls: "dendrite-grip-icon" }),
      "grip-vertical"
    );
    const body = card.createDiv({ cls: "dendrite-card-body" });
    const cached = this.rendered.get(n.id);
    const f = this.cardFile(n.id);
    if (this.editing && this.editing.id === n.id) {
      body.appendChild(this.editing.editor.el);
      card.addClass("is-editing");
      card.toggleClass(
        "has-obsidian-editor",
        this.editing.editor.kind === "obsidian"
      );
    } else if (cached && f && cached.mtime === f.stat.mtime) {
      body.appendChild(cached.el);
    } else {
      body.createDiv({ cls: "dendrite-placeholder" });
      if (was) card.style.minHeight = was;
      card.addClass("is-pending");
      this.drawWhenIdle();
    }
    const foot = card.createDiv({ cls: "dendrite-card-foot" });
    this.renderQuotaWidget(foot, n.id);
    const tag = foot.createSpan({
      cls: "dendrite-id",
      text: core.shortId(n.id)
    });
    tag.setAttr("aria-label", `${n.id}: click to copy ${core.shortId(n.id)}`);
    tag.addEventListener("click", (e) => {
      e.stopPropagation();
      this.copyId(n.id);
    });
    this.decorateCard(id, card);
    return card;
  }
  /**
   * Cards far from the view emptied back to their slots, keeping their
   * heights; never the active card, the one being written, dragged or
   * with its versions fanned out. All are measured before any is
   * emptied, so the board is laid out once.
   */
  emptyFar(ids) {
    this.heights = this.heights || /* @__PURE__ */ new Map();
    const keep = (id) => id === this.active || id === this.fannedId || this.editing && this.editing.id === id || this.drag && this.drag.id === id;
    const cards = ids.filter((id) => !keep(id)).map((id) => [id, this.cardEls.get(id)]).filter(([, c]) => c && !c.hasClass("is-slot"));
    const tall = cards.map(([, c]) => c.offsetHeight);
    cards.forEach(([id, card], i) => {
      if (tall[i]) this.heights.set(id, tall[i]);
      this.invalidate(id);
      card.empty();
      card.removeClass("is-pending");
      this.makeSlot(id, card);
    });
    return cards.length;
  }
  /**
   * What every drawn card shows, put on one just filled: its number,
   * role, status chips, quota, the classes of the active path and the
   * cards picked, and the active card's tools.
   */
  decorateCard(id, card) {
    this.numberCard(id, card);
    this.roleCard(id, card);
    this.statusCard(id, card);
    this.stackOpenCard(id, card);
    this.fillQuota(card, id);
    card.toggleClass("is-active", id === this.active);
    card.toggleClass("is-lineage", !!(this.lineage && this.lineage.has(id)));
    card.toggleClass("is-picked", !!(this.picked && this.picked.has(id)));
    if (id === this.active) this.renderToolbar();
    if (this.find) {
      this.findCard(id, card);
      this.schedulePaintFind();
    }
  }
  /** Find's marks painted again once, after the cards being filled. */
  schedulePaintFind() {
    if (this.paintFrame) return;
    this.paintFrame = this.pageWin().requestAnimationFrame(() => {
      this.paintFrame = null;
      if (this.find) this.paintFind();
    });
  }
  /** The cards drawn as frames, not slots: [id, card]. */
  *liveCards() {
    for (const [id, card] of this.cardEls) {
      if (!card.hasClass("is-slot")) yield [id, card];
    }
  }
  onVisible(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = e.target.dataset.id;
      this.observer.unobserve(e.target);
      if (e.target.hasClass("is-pending") || e.target.hasClass("is-slot")) this.renderCard(id);
    }
  }
  /**
   * Cards not yet in view drawn while the board is idle, so moving to
   * one, or scrolling to it, does not stop to draw it (idleDrawer).
   */
  drawWhenIdle() {
    if (!this.idleDraw) {
      this.idleDraw = idleDrawer(
        () => this.pageWin(),
        () => this.nextToDraw(),
        () => !!this.anim || Date.now() - (this.plugin.typedAt || 0) < 1e3
      );
    }
    this.idleDraw.schedule();
  }
  /**
   * The waiting cards nearest the board's middle, up to DRAW_BATCH,
   * drawn together; or null. Only a card within two screens of what the
   * board shows is drawn, or the
   * child of a card it shows, since moving to that card brings its
   * children into view: so a long manuscript keeps only the part around
   * the reader drawn, and moving or scrolling draws around the new
   * place (DRAW_REACH).
   */
  nextToDraw() {
    if (!this.board) return null;
    this.undrawable = this.undrawable || /* @__PURE__ */ new WeakSet();
    const box = this.board.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const reachX = box.width / 2 + box.width;
    const reachY = box.height / 2 + DRAW_REACH * box.height;
    const rects = /* @__PURE__ */ new Map();
    const kids = /* @__PURE__ */ new Set();
    for (const [id, el] of this.cardEls) {
      const r = el.getBoundingClientRect();
      rects.set(id, r);
      const shown = r.bottom >= box.top && r.top <= box.bottom && r.right >= box.left && r.left <= box.right;
      const node = shown && this.byId.get(id);
      if (node) for (const k of this.kidsOf(node)) kids.add(k.id);
    }
    const near = [];
    const far = [];
    for (const [id, el] of this.cardEls) {
      const r = rects.get(id);
      const dx = Math.abs(r.left + r.width / 2 - cx);
      const dy = Math.abs(r.top + r.height / 2 - cy);
      const waiting = el.hasClass("is-pending") || el.hasClass("is-slot");
      if (!waiting) {
        if ((dx > box.width * (EMPTY_REACH + 0.5) || dy > box.height * (EMPTY_REACH + 0.5)) && !kids.has(id)) far.push(id);
        continue;
      }
      if (this.undrawable.has(el) || this.editing && this.editing.id === id) continue;
      if ((dx > reachX || dy > reachY) && !kids.has(id)) continue;
      near.push([Math.hypot(dx, dy), id, el]);
    }
    if (!near.length) {
      if (far.length) this.emptyFar(far);
      return null;
    }
    near.sort((a, b) => a[0] - b[0]);
    this.drawingIdle = (this.drawingIdle || 0) + 1;
    return Promise.all(near.slice(0, DRAW_BATCH).map(([, id, el]) => (
      // One that fails, or is still waiting after, is not tried
      // again until the board is redrawn.
      this.renderCard(id).then(() => {
        if (el.hasClass("is-slot") || el.hasClass("is-pending")) {
          this.undrawable.add(el);
        }
      }, (err) => {
        this.undrawable.add(el);
        console.error("Dendrite: a card could not be drawn", err);
      })
    ))).finally(() => {
      this.drawingIdle--;
    });
  }
  invalidate(id) {
    const r = this.rendered.get(id);
    if (r) {
      r.comp.unload();
      this.rendered.delete(id);
    }
  }
  async renderCard(id) {
    const card = this.cardEls.get(id);
    if (!card || this.editing && this.editing.id === id) return;
    if (card.hasClass("is-slot")) {
      this.fillFrame(id);
      if (!card.hasClass("is-pending")) return;
    }
    const body = card.querySelector(".dendrite-card-body");
    const f = this.cardFile(id);
    if (!f) {
      card.removeClass("is-pending");
      card.addClass("is-missing");
      body.empty();
      body.createDiv({
        cls: "dendrite-placeholder",
        text: `Missing note: ${id}`
      });
      return;
    }
    const cached = this.rendered.get(id);
    if (cached && cached.mtime === f.stat.mtime) {
      body.empty();
      body.appendChild(cached.el);
      card.removeClass("is-pending");
      return;
    }
    const text = core.splitFrontmatter(
      await this.app.vault.cachedRead(f)
    ).body;
    const comp = new Component();
    comp.load();
    const out = createDiv({ cls: "dendrite-md markdown-rendered" });
    const notes = review.reviewItems(text);
    this.openComments = this.openComments || /* @__PURE__ */ new Map();
    const count = review.countComments(notes);
    if ((this.openComments.get(id) || 0) !== count) {
      this.openComments.set(id, count);
      this.scheduleStatuses();
    }
    const kind = this.kindOf(id);
    const shown = kind === "figure" && !notes.length ? float.compose(
      "figure",
      float.split(text, "figure").caption,
      float.split(text, "figure").content
    ) : text;
    this.noteReviewers(id, notes);
    if (text.trim()) {
      await MarkdownRenderer.render(
        this.app,
        notes.length ? review.renderMarkdown(text, this.colourOf()) : shown,
        out,
        f.path,
        comp
      );
      if (notes.length) {
        review.wrapPassages(out);
        review.decorate(
          out,
          notes,
          (n, what, arg) => this.reviewAction(id, n, what, arg),
          (n, e, k) => this.commentMenu(id, n, e, k),
          this.colourOf(),
          (el) => ownKeys(this.app, el),
          this.nameOf()
        );
        externalLinks(out);
      }
    } else if (!kind) {
      out.createDiv({
        cls: "dendrite-placeholder",
        text: "Empty card"
      });
    }
    if (kind) {
      const parts = float.split(text, kind);
      const missing = (t) => createDiv({
        cls: "dendrite-float-missing",
        text: t
      });
      if (!parts.content) {
        out.prepend(missing(kind === "figure" ? "No image: paste, drop or link one" : "No table yet"));
      }
      if (!parts.caption) out.append(missing("No caption"));
    }
    this.invalidate(id);
    this.rendered.set(id, { el: out, comp, mtime: f.stat.mtime });
    const now = this.cardEls.get(id);
    if (now && !(this.editing && this.editing.id === id)) {
      const b = now.querySelector(".dendrite-card-body");
      b.empty();
      b.appendChild(out);
      now.removeClass("is-pending");
      now.removeClass("is-missing");
      now.style.minHeight = "";
      if (this.lineage && this.lineage.has(id) && !this.scrolledByHand && !this.drawingIdle) {
        this.centre(!!this.anim);
      }
      this.scheduleFlow();
      if (this.find) this.paintFind();
    }
  }
  /** Highlight the active card's lineage and bring it into view. */
  applyActive(smooth = true) {
    const card = this.active && this.cardEls.get(this.active);
    if (card && card.hasClass("is-slot")) this.renderCard(this.active);
    this.highlight();
    this.centre(smooth);
  }
  highlight() {
    if (!this.board) return;
    const node = this.active && this.byId.get(this.active);
    const lineage = /* @__PURE__ */ new Set();
    if (node) {
      for (let n = node; n && n.id; n = this.upOf(n)) lineage.add(n.id);
      for (const d of this.shownBelow(node)) lineage.add(d.id);
    }
    this.lineage = lineage;
    if (this.plugin.previewActive) {
      this.plugin.previewActive(this.file, this.active);
    }
    this.board.toggleClass("has-active", !!node);
    for (const [id, el] of this.cardEls) {
      el.toggleClass("is-active", id === this.active);
      el.toggleClass("is-lineage", lineage.has(id));
      el.toggleClass("is-picked", this.picked.has(id));
    }
    this.renderToolbar();
    this.scheduleFlow();
  }
  onResize(entries = []) {
    this.anchorColumns(entries);
    for (const e of entries) {
      const card = e.target;
      const size = e.borderBoxSize && e.borderBoxSize[0];
      if (!size || !card.classList.contains("dendrite-card") || card.classList.contains("is-slot") || card.classList.contains("is-pending") || card.classList.contains("is-editing")) continue;
      this.learnHeight(card.dataset.id, size.blockSize);
    }
    if (!this.scrolledByHand) this.centre(!!this.anim);
    if (this.nativeScroll || this.scrolledByHand) this.drawFlow();
  }
  /**
   * Each column kept where it shows when a card beginning above its view
   * changes height, as when one is filled or drawn: the columns move by
   * transform, outside the browser's own scroll anchoring, so a column
   * scrolled by hand jumped as the cards above it were drawn. The column
   * moves by the change, here before painting. A phone's columns scroll
   * natively and are anchored by the browser.
   */
  anchorColumns(entries) {
    if (this.nativeScroll) return;
    this.seenHeights = this.seenHeights || /* @__PURE__ */ new WeakMap();
    const shift = /* @__PURE__ */ new Map();
    for (const e of entries) {
      const card = e.target;
      const size = e.borderBoxSize && e.borderBoxSize[0];
      if (!size || !card.classList.contains("dendrite-card")) continue;
      const was = this.seenHeights.get(card);
      this.seenHeights.set(card, size.blockSize);
      if (was === void 0 || was === size.blockSize) continue;
      const col = card.closest(".dendrite-col");
      if (!col) continue;
      const d = Number(col.dataset.depth);
      if (card.offsetTop < this.colOffset(d)) {
        shift.set(d, (shift.get(d) || 0) + size.blockSize - was);
      }
    }
    for (const [d, by] of shift) {
      this.setColOffset(d, this.colOffset(d) + by);
    }
  }
  scheduleFlow() {
    if (this.flowFrame) return;
    this.flowFrame = this.pageWin().requestAnimationFrame(() => {
      this.flowFrame = null;
      this.drawFlow();
    });
  }
  /**
   * Gingko's flow: a band from the right edge of each card on the active
   * path, from the root down to the active card, widening to the left
   * edge of the group holding its children in the next column.
   */
  drawFlow() {
    const svg = this.flowSvg;
    if (!svg || !this.board) return;
    this.placeFan();
    this.placeFloat();
    const node = this.active && this.byId.get(this.active);
    const cols = this.board.querySelectorAll(".dendrite-col");
    const last = cols[cols.length - 1];
    const width = `${last ? last.offsetLeft + last.offsetWidth : 0}px`;
    const height = `${this.board.clientHeight}px`;
    const box = this.board.getBoundingClientRect();
    const sx = this.board.scrollLeft;
    const rel = (el) => this.flowBox(el, box, sx);
    const pairs = [];
    const steps = [];
    const groups = /* @__PURE__ */ new Set();
    for (let n = node; n && n.id; n = this.upOf(n)) {
      const card = this.cardEls.get(n.id);
      if (!card) continue;
      const parent = this.upOf(n);
      if (parent && parent.id) {
        const up = this.cardEls.get(parent.id);
        if (up) steps.push({ from: rel(up), to: rel(card) });
      }
      const kids = this.kidsOf(n);
      if (!kids.length) continue;
      const child = this.cardEls.get(kids[0].id);
      const group = child && child.parentElement;
      if (!group) continue;
      groups.add(group);
      pairs.push({ card: rel(card), group: rel(group) });
    }
    for (const g of this.board.querySelectorAll(".is-flow")) {
      if (!groups.has(g)) g.classList.remove("is-flow");
    }
    for (const g of groups) {
      if (!g.classList.contains("is-flow")) g.classList.add("is-flow");
    }
    if (svg.style.width !== width) svg.style.width = width;
    if (svg.style.height !== height) svg.style.height = height;
    this.flowPath(
      svg,
      "dendrite-flow-context",
      node ? core.flowPath(pairs) : ""
    );
    this.flowPath(
      svg,
      "dendrite-flow-thread",
      node ? core.threadPath(steps) : ""
    );
  }
  /** One of the flow's two shapes, given its path, or removed. */
  flowPath(svg, cls, d) {
    let path = svg.querySelector(`.${cls}`);
    if (!d) {
      if (path) path.remove();
      return;
    }
    if (!path) {
      const NS = "http://www.w3.org/2000/svg";
      path = this.pageDoc().createElementNS(NS, "path");
      path.setAttribute("class", cls);
      if (cls === "dendrite-flow-context") svg.prepend(path);
      else svg.appendChild(path);
    }
    if (path.getAttribute("d") !== d) path.setAttribute("d", d);
  }
  /**
   * An element's box for the flow, in the board's content coordinates
   * (`box` the board's rect, `sx` its scroll). A card with old versions
   * starts at the top of its stack, the room above it its margin holds.
   */
  flowBox(el, box, sx) {
    const r = el.getBoundingClientRect();
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    const lift = el.classList.contains("has-stack") ? parseFloat(cs.marginTop) || 0 : 0;
    return {
      left: r.left - box.left + sx,
      right: r.right - box.left + sx,
      top: r.top - box.top - lift,
      bottom: r.bottom - box.top,
      r: parseFloat(cs.borderTopLeftRadius) || 0
    };
  }
  /**
   * Centre the active card, horizontally and vertically, and in every
   * other column the part of its lineage that column holds.
   */
  centre(smooth = true, typed = false) {
    if (!this.board) return;
    this.scrolledByHand = false;
    const node = this.active && this.byId.get(this.active);
    if (!node) return;
    const behavior = smooth ? "smooth" : "auto";
    const cols = this.board.querySelectorAll(".dendrite-col");
    const pos = (id) => {
      const el = this.cardEls.get(id);
      return el ? { top: el.offsetTop, height: el.offsetHeight } : null;
    };
    const heights = [...cols].map((c) => c.clientHeight);
    const own = this.ownOffset(
      node,
      pos(node.id),
      heights[node.depth],
      typed
    );
    this.placed = node.id;
    const targets = core.alignColumns(
      this.cols,
      node,
      pos,
      heights,
      own,
      { up: (n) => this.upOf(n), kids: (n) => this.kidsOf(n) }
    );
    if (this.nativeScroll) {
      cols.forEach((col2, d) => {
        if (targets[d] !== null) {
          col2.scrollTo({ top: targets[d], behavior });
        }
      });
    } else {
      this.animateOffsets(targets, smooth);
    }
    const col = cols[node.depth];
    if (col) {
      const left = col.offsetLeft - (this.board.clientWidth - col.offsetWidth) / 2;
      this.tellCentred(left);
      const wide = this.board.clientWidth;
      const by = left - this.board.scrollLeft;
      if (smooth && wide && Math.abs(by) > LONG_MOVE * wide) {
        this.board.scrollTo({
          left: left - Math.sign(by) * wide,
          behavior: "auto"
        });
      }
      this.board.scrollTo({ left, behavior });
    }
    this.drawWhenIdle();
  }
  /** With Say what moves the board on, a centring that moves it. */
  tellCentred(left) {
    this.centredAt = Date.now();
    if (!this.plugin.settings.showBoardMoves) return;
    const max = this.board.scrollWidth - this.board.clientWidth;
    const to = Math.max(0, Math.min(max, left));
    const by = Math.round(to - this.board.scrollLeft);
    if (Math.abs(by) < 20) return;
    new Notice(`Dendrite centred the board, ${by} px: ` + callers(new Error().stack).join(" \u2190 "), 1e4);
  }
  /**
   * With Say what moves the board on, the board moved sideways with no
   * touch, wheel or centring in the last moments.
   */
  watchBoardMoves(board) {
    let rest = board.scrollLeft;
    const handAt = () => {
      this.handAt = Date.now();
    };
    for (const t of [
      "touchstart",
      "touchmove",
      "touchend",
      "wheel",
      "pointerdown"
    ]) {
      board.addEventListener(t, handAt, { passive: true });
    }
    board.addEventListener("scroll", (e) => {
      if (e.target !== board) return;
      const now = Date.now();
      const quiet = now - (this.handAt || 0) > 3e3 && now - (this.centredAt || 0) > 1500;
      if (!quiet) {
        rest = board.scrollLeft;
        return;
      }
      const by = Math.round(board.scrollLeft - rest);
      if (Math.abs(by) < 20) return;
      rest = board.scrollLeft;
      if (!this.plugin.settings.showBoardMoves) return;
      new Notice(`Dendrite: the board moved ${by} px sideways with no touch and no centring.`, 1e4);
    });
  }
  /**
   * Where the active card's own column goes, or null to centre the card.
   * While it is written in, only typing moves it, by the caret: to the
   * column's middle in typewriter mode, otherwise into view, with a
   * card that fits still centred. Anything else, such as a card beside
   * it redrawn, leaves it where it is, so text never moves under a
   * click. A card taller than its column shows its top when moved to,
   * and stays where it is after that.
   */
  ownOffset(node, box, height, typed) {
    if (!box || !height) return null;
    const d = node.depth;
    const ed = this.editing;
    const typewriter = this.plugin.settings.typewriter !== false;
    const tall = core.tallTop(box, height, CARD_MARGIN) !== null;
    if (ed && ed.id === node.id && !typed) return this.colOffset(d);
    if (ed && ed.id === node.id && (typewriter || tall) && ed.editor.caretRect && this.colInners[d]) {
      const r = ed.editor.caretRect();
      if (r) {
        const base = this.colInners[d].getBoundingClientRect().top;
        const caret = { top: r.top - base, bottom: r.bottom - base };
        return core.caretOffset(
          caret,
          height,
          this.colOffset(d),
          CARD_MARGIN,
          typewriter
        );
      }
    }
    if (!tall) return null;
    if (this.placed === node.id) {
      const cur = this.colOffset(d);
      return Math.max(box.top - CARD_MARGIN, Math.min(
        cur,
        box.top + box.height + CARD_MARGIN - height
      ));
    }
    return core.tallTop(box, height, CARD_MARGIN);
  }
  /**
   * Move the active column to the caret once the editor has drawn. Most
   * keys leave the caret on its line and the card its height, and then
   * nothing would move: the board is laid out again, every column
   * measured and the flow redrawn, only when one of them changes.
   */
  followCaret() {
    if (this.caretFrame) return;
    const win = this.pageWin();
    this.caretFrame = win.requestAnimationFrame(() => {
      this.caretFrame = null;
      const ed = this.editing;
      if (!ed) return;
      if (this.caretAt && this.caretAt === this.caretKey(ed)) return;
      this.centre(false, true);
      this.caretAt = this.caretKey(ed);
    });
  }
  /**
   * Where editor `ed`'s caret is on screen, and its card's height; null
   * when the caret cannot be read, so the board is laid out every time.
   */
  caretKey(ed) {
    let r = null;
    try {
      r = ed.editor.caretRect && ed.editor.caretRect();
    } catch (err) {
      return null;
    }
    const card = this.cardEls.get(ed.id);
    return r && card ? `${ed.id}:${Math.round(r.top)}:${card.offsetHeight}` : null;
  }
  /** A column's scroll position, however it is scrolled. */
  /** Where the board and each column are scrolled to. */
  scrollState() {
    const cols = this.board.querySelectorAll(".dendrite-col");
    return {
      left: this.board.scrollLeft,
      cols: [...cols].map((c, d) => this.colOffset(d))
    };
  }
  /** The board and its columns scrolled back to `held`, by hand. */
  restoreScroll(held) {
    this.board.scrollLeft = held.left;
    held.cols.forEach((y, d) => this.setColOffset(d, y));
    this.scrolledByHand = true;
    this.scheduleFlow();
  }
  colOffset(d) {
    const cols = this.board.querySelectorAll(".dendrite-col");
    if (this.nativeScroll) return cols[d] ? cols[d].scrollTop : 0;
    return this.offsets[d] || 0;
  }
  /** Scroll a column to `y`, clamped to its content. */
  setColOffset(d, y) {
    const col = this.board.querySelectorAll(".dendrite-col")[d];
    const inner = this.colInners[d];
    if (!col || !inner) return;
    const max = Math.max(0, inner.scrollHeight - col.clientHeight);
    const v = Math.max(0, Math.min(max, y));
    if (this.nativeScroll) {
      col.scrollTop = v;
      return;
    }
    this.offsets[d] = v;
    inner.style.transform = `translateY(${-v}px)`;
    this.announceScroll();
  }
  /**
   * Columns move by transform, which the browser does not count as a
   * scroll, so popups that close on scroll, such as another plugin's
   * citation tooltip, would stay behind. A scroll event says the
   * content moved; the board's own scroll listener ignores it.
   */
  announceScroll() {
    if (!this.board) return;
    const win = this.pageWin();
    this.board.dispatchEvent(new win.Event("scroll"));
  }
  /**
   * Move columns to their targets, easing over a few frames, with the
   * flow redrawn in each frame so it never trails the cards.
   */
  animateOffsets(targets, smooth) {
    if (this.anim) this.pageWin().cancelAnimationFrame(this.anim);
    this.anim = null;
    const from = targets.map((_, d) => this.colOffset(d));
    const screen = this.board.clientHeight;
    targets.forEach((y, d) => {
      if (!smooth || y === null || !screen) return;
      if (Math.abs(y - from[d]) > LONG_MOVE * screen) {
        from[d] = y - Math.sign(y - from[d]) * screen;
      }
    });
    if (!smooth) {
      targets.forEach((y, d) => {
        if (y !== null) this.setColOffset(d, y);
      });
      this.drawFlow();
      return;
    }
    let start = null;
    const DURATION = 220;
    const step = (now) => {
      if (start === null) start = now;
      const k = Math.min(1, Math.max(0, (now - start) / DURATION));
      const e = 1 - Math.pow(1 - k, 3);
      targets.forEach((y, d) => {
        if (y !== null) {
          this.setColOffset(d, from[d] + (y - from[d]) * e);
        }
      });
      this.drawFlow();
      this.anim = k < 1 ? this.pageWin().requestAnimationFrame(step) : null;
    };
    this.anim = this.pageWin().requestAnimationFrame(step);
  }
  /**
   * Keep the board's horizontal scroll where it is for a moment. The
   * handler that scrolls it copies a second time once the board has
   * moved, so a copy during a hold extends that hold rather than
   * holding the board where it was moved to.
   */
  holdBoardScroll() {
    const board = this.board;
    const win = this.pageWin();
    if (this.boardHold && this.boardHold.board === board) {
      win.clearTimeout(this.boardHold.timer);
    } else {
      const x = board.scrollLeft;
      const hold = (e) => {
        if (e.target === board && board.scrollLeft !== x) {
          board.scrollLeft = x;
        }
      };
      board.addEventListener("scroll", hold);
      this.boardHold = { board, hold };
    }
    const held = this.boardHold;
    held.timer = win.setTimeout(() => {
      board.removeEventListener("scroll", held.hold);
      if (this.boardHold === held) this.boardHold = null;
    }, 300);
  }
  /** The wheel scrolls the column under it, flow redrawn the same frame. */
  onWheel(e) {
    if (e.ctrlKey) return;
    const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (horizontal) {
      this.scrolledByHand = true;
      return;
    }
    const col = e.target.closest && e.target.closest(".dendrite-col");
    if (!col) return;
    e.preventDefault();
    if (this.anim) {
      this.pageWin().cancelAnimationFrame(this.anim);
      this.anim = null;
    }
    const d = Number(col.dataset.depth);
    this.scrolledByHand = true;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? col.clientHeight : 1;
    this.setColOffset(d, this.colOffset(d) + e.deltaY * unit);
    this.drawFlow();
    this.drawWhenIdle();
  }
  /** A link to the card, to paste where a table or figure is cited. */
  async copyRef(id) {
    const ref = `[[${id}]]`;
    try {
      await this.pageWin().navigator.clipboard.writeText(ref);
      new Notice(`Copied ${ref}`);
    } catch (err) {
      new Notice(`Could not copy ${ref}`);
    }
  }
  async copyId(id) {
    const short = core.shortId(id);
    try {
      await this.pageWin().navigator.clipboard.writeText(short);
      new Notice(`Copied ${short}`);
    } catch (err) {
      new Notice(`Could not copy ${short}`);
    }
  }
  renderToolbar() {
    if (this.toolbar) this.toolbar.remove();
    this.toolbar = null;
    const card = this.active && this.cardEls.get(this.active);
    if (!card || this.editing || card.hasClass("is-slot")) return;
    const foot = card.querySelector(":scope > .dendrite-card-foot") || card.createDiv({ cls: "dendrite-card-foot" });
    const t = foot.createDiv({ cls: "dendrite-toolbar" });
    const btn = (icon, title, fn) => {
      const b = t.createEl("button", { cls: "clickable-icon" });
      setIcon(b, icon);
      b.setAttr("aria-label", title);
      b.onclick = (e) => {
        e.stopPropagation();
        fn();
      };
    };
    btn("pencil", "Edit (Enter)", () => this.startEdit(this.active));
    btn(
      "arrow-down-to-line",
      "New card below (Ctrl+\u2193)",
      () => this.insert("below")
    );
    btn(
      "corner-down-right",
      "New child card (Ctrl+\u2192)",
      () => this.insert("child")
    );
    btn(
      "sliders-horizontal",
      "Card properties: label and limit",
      () => new CardModal(this, this.active).open()
    );
    btn("more-horizontal", "More", () => this.cardMenu(t));
    this.toolbar = t;
  }
  /** The role choices for a card, the current one checked. */
  addRoleItems(m, id) {
    const role = this.roleOf(id);
    const node = this.byId.get(id);
    const auto = node && node.children.length ? "heading only" : "full text";
    for (const [value, title, icon, key] of [
      [null, `Prints automatically (${auto})`, "wand", "0"],
      ...ROLE_ITEMS
    ]) {
      m.addItem((i) => {
        i.setTitle(this.menuLabel(title, key)).setIcon(icon).onClick(() => this.setRole(id, value));
        if (typeof i.setChecked === "function") {
          i.setChecked(role === value);
          tickBeforeKey(i);
        }
      });
    }
    m.addSeparator();
    const kind = this.kindOf(id);
    for (const [value, title, icon] of KIND_ITEMS) {
      m.addItem((i) => {
        i.setTitle(title).setIcon(icon).onClick(() => this.setKind(id, value));
        if (typeof i.setChecked === "function") {
          i.setChecked(kind === value);
        }
      });
    }
    if (node && node.children.length) this.addBranchItems(m, id);
  }
  /**
   * Roles for a card and everything below it, in a submenu where
   * Obsidian has them, else as items of their own. Statuses for the
   * cards below are with the card's own, at the top of its menu.
   */
  addBranchItems(m, id) {
    let sub = null;
    m.addSeparator();
    m.addItem((i) => {
      i.setTitle("Whole branch");
      if (typeof i.setSubmenu === "function") sub = i.setSubmenu();
    });
    if (sub) styleMenu(sub, true);
    const into = sub || m;
    const lead = sub ? "" : "Whole branch: ";
    for (const [value, title, icon] of [[null, "Prints automatically", "wand"], ...ROLE_ITEMS]) {
      into.addItem((i) => i.setTitle(lead + title).setIcon(icon).onClick(() => this.setBranch(id, "role", value)));
    }
  }
  /**
   * Set a role on a card and every card below it, or a status on every
   * card below it that prints its text, as one step to undo.
   */
  async setBranch(id, what, value) {
    const node = this.byId.get(id);
    if (!node) return;
    const roleOf = (x) => this.printRoleOf(x);
    const key = what === "role" ? "dendrite_role" : "dendrite_status";
    const restores = [];
    const cards = what === "status" ? core.descendants(node) : [node, ...core.descendants(node)];
    for (const c of cards) {
      const f = this.cardFile(c.id);
      if (!f) continue;
      if (what === "status" && core.roleFor(c, roleOf) !== "prose") {
        continue;
      }
      const cur = what === "role" ? this.roleOf(c.id) : this.statusOf(c.id);
      if ((cur || null) === (value || null)) continue;
      const data = await this.app.vault.read(f);
      restores.push({
        path: f.path,
        text: data,
        ifBody: core.splitFrontmatter(data).body
      });
      await writeProps(this.app, f, { [key]: value || null });
    }
    if (what === "role") await this.sweepStatuses();
    const n = restores.length;
    if (n) {
      this.pushUndo({
        active: this.active,
        files: [],
        created: [],
        restores,
        text: false
      });
    }
    const name = what === "role" ? BRANCH_ROLE_NAMES[value || ""] : value;
    const where = what === "role" ? "in the branch" : "below";
    new Notice(n ? `Dendrite: ${n} card${n === 1 ? "" : "s"} ${where} set to ${name}.` : what === "role" ? `Dendrite: the branch is already ${name}.` : `Dendrite: the cards below are already ${name}.`);
  }
  /**
   * A menu item's title with its key as a chip at the right. The chip
   * draws its key from data-key, so the title's text stays the title.
   */
  menuLabel(title, key) {
    const doc = this.pageDoc();
    const label = doc.createDocumentFragment();
    const row = label.appendChild(doc.createElement("span"));
    row.className = "dendrite-menu-row";
    row.appendChild(doc.createElement("span")).textContent = title;
    const chip = row.appendChild(doc.createElement("span"));
    chip.className = "dendrite-menu-key";
    chip.dataset.key = key;
    for (const part of key.split("+")) {
      const k = chip.appendChild(doc.createElement("kbd"));
      k.className = "dendrite-kbd";
      k.dataset.k = part;
    }
    return label;
  }
  /** The role choices alone, from a card's corner icon. */
  roleMenu(id, anchor) {
    const m = dendriteMenu();
    this.addRoleItems(m, id);
    const r = anchor.getBoundingClientRect();
    m.showAtPosition({ x: r.left, y: r.bottom }, this.pageDoc());
  }
  cardMenu(anchor, event) {
    if (this.picked.size > 1 && this.picked.has(this.active)) {
      this.pickedMenu(anchor, event);
      return;
    }
    const m = dendriteMenu();
    const id = this.active;
    const node = this.byId.get(id);
    const submenu = (title, icons = true) => {
      let sub = null;
      m.addItem((i) => {
        i.setTitle(title);
        if (typeof i.setSubmenu === "function") sub = i.setSubmenu();
      });
      if (sub) styleMenu(sub, icons);
      const lead = sub ? "" : `${title}: `;
      const into = sub || m;
      return { into, item: (t, ic, fn, key) => into.addItem((i) => {
        i.setTitle(key ? this.menuLabel(lead + t, key) : lead + t).onClick(fn);
        if (ic) i.setIcon(ic);
      }) };
    };
    const item = (title, icon, fn) => m.addItem((i) => {
      i.setTitle(title).onClick(fn);
      if (icon) i.setIcon(icon);
    });
    const info = this.statusInfo && this.statusInfo.get(id);
    if (info && info.prints) {
      for (const [value, title, icon, key] of STATUS_ITEMS) {
        m.addItem((i) => {
          i.setTitle(this.menuLabel(title, `Ctrl+${key}`)).setIcon(icon).onClick(() => this.markStatus(id, value));
          if (typeof i.setChecked === "function") {
            i.setChecked(info.own === value);
            tickBeforeKey(i);
          }
        });
      }
      if (node && this.kidsOf(node).length) {
        let sub = null;
        m.addItem((i) => {
          i.setTitle("Cards below");
          if (typeof i.setSubmenu === "function") {
            sub = i.setSubmenu();
          }
        });
        if (sub) styleMenu(sub, true);
        for (const [value, title, icon] of STATUS_ITEMS) {
          (sub || m).addItem((i) => i.setTitle(sub ? title : title.replace("Status", "Cards below")).setIcon(icon).onClick(() => this.setBranch(id, "status", value)));
        }
      }
      m.addSeparator();
    } else if (info && info.own === "unsplit") {
      item(
        "Keep the leftover text as notes",
        "check",
        () => this.markStatus(id, null)
      );
      m.addSeparator();
    } else if (info && info.derived) {
      for (const [value, title, icon] of STATUS_ITEMS) {
        m.addItem((i) => {
          i.setTitle(title.replace("Status", "Cards below")).setIcon(icon).onClick(() => this.setBranch(id, "status", value));
          if (typeof i.setChecked === "function") {
            i.setChecked(info.derived === value);
          }
        });
      }
      m.addSeparator();
    }
    this.addRoleItems(submenu("Prints as").into, id);
    const versions = submenu("Versions", false);
    versions.item(
      "New version of this card",
      null,
      () => this.promote(id)
    );
    if (node && node.parent && node.parent.id) {
      const up = node.parent.id;
      versions.item(
        "Replace the parent card with this one",
        null,
        () => this.promote(up, id)
      );
    }
    if (this.stackOf(id).length) {
      versions.item(
        this.fannedId === id ? "Hide old versions" : "Show old versions",
        null,
        () => this.toggleFan(id)
      );
      versions.item(
        "Make an old version current, or delete one\u2026",
        null,
        () => this.openStack(id)
      );
    }
    const structure = submenu("Structure");
    structure.item(
      "New card above",
      null,
      () => this.insert("above"),
      "Ctrl+\u2191"
    );
    structure.item(
      "Move up",
      null,
      () => this.structural("up"),
      "Alt+\u2191"
    );
    structure.item(
      "Move down",
      null,
      () => this.structural("down"),
      "Alt+\u2193"
    );
    structure.item(
      "Indent",
      null,
      () => this.structural("indent"),
      "Alt+\u2192"
    );
    structure.item(
      "Outdent",
      null,
      () => this.structural("outdent"),
      "Alt+\u2190"
    );
    structure.into.addSeparator();
    structure.item(
      "Merge into the card above",
      "merge",
      () => this.merge("above")
    );
    structure.item(
      "Merge into the parent card",
      "git-merge",
      () => this.merge("parent")
    );
    m.addSeparator();
    const exp = submenu("Export this branch", false);
    const formats = [["Markdown", "md"]];
    if (Platform.isDesktopApp) {
      formats.push(["PDF", "pdf"], ["Word", "docx"]);
    }
    for (const [title, fmt] of formats) {
      exp.item(title, null, () => this.exportTo(node, fmt));
    }
    item(
      "Card properties\u2026",
      "sliders-horizontal",
      () => new CardModal(this, id).open()
    );
    item("Copy reference", "link", () => this.copyRef(id));
    item("Open card note", null, () => {
      const f = this.cardFile(id);
      if (f) this.plugin.openAsMarkdown(f);
    });
    m.addSeparator();
    m.addItem((i) => {
      i.setTitle(this.menuLabel(
        "Delete card and its children",
        "Ctrl+Backspace"
      )).setIcon("trash-2").onClick(() => this.deleteActive());
      if (typeof i.setWarning === "function") i.setWarning(true);
    });
    if (event) {
      m.showAtMouseEvent(event);
      return;
    }
    const r = anchor.getBoundingClientRect();
    m.showAtPosition({ x: r.left, y: r.bottom }, this.pageDoc());
  }
  // ---- interaction -----------------------------------------------------
  onClick(e) {
    if (this.justDragged) {
      this.justDragged = false;
      return;
    }
    if (openInImageToolkit(this.app, e)) return;
    if (this.pressInText) {
      this.pressInText = false;
      return;
    }
    const link = e.target.closest("a.internal-link");
    if (link) {
      e.preventDefault();
      const href = link.getAttr("data-href") || link.getAttr("href");
      this.app.workspace.openLinkText(
        href,
        this.file.path,
        Keymap.isModEvent(e)
      );
      return;
    }
    if (e.target.closest(".dendrite-toolbar, textarea, .dendrite-cm, button, .dendrite-quota, .dendrite-id, .dendrite-float-edit")) {
      return;
    }
    const grip = e.target.closest(".dendrite-grip");
    if (grip) {
      const id = grip.parentElement.dataset.id;
      this.select(id, false).then(() => this.roleMenu(id, grip));
      return;
    }
    const card = e.target.closest(".dendrite-card");
    if (card) {
      const id = card.dataset.id;
      if (e.ctrlKey || e.metaKey) this.pickToggle(id);
      else if (e.shiftKey) this.pickRun(id);
      else {
        this.clearPicked();
        this.select(id);
      }
    }
    this.contentEl.focus();
  }
  // ---- picking several cards --------------------------------------
  /** Pick a card, or let it go, with the active card picked as well. */
  pickToggle(id) {
    if (!this.picked.size && this.active && this.active !== id) {
      this.picked.add(this.active);
    }
    if (this.picked.has(id)) this.picked.delete(id);
    else this.picked.add(id);
    this.showPicked();
  }
  /**
   * Pick the run of cards from the active one to `id`, both included:
   * cards side by side under one parent, as the board shows them.
   */
  pickRun(id) {
    const from = this.active && this.byId.get(this.active);
    const to = this.byId.get(id);
    if (!from || !to) return;
    if (from.parent !== to.parent) {
      new Notice("Dendrite: a run is of cards side by side under one parent.");
      return;
    }
    const sibs = this.kidsOf(from.parent);
    const a = sibs.indexOf(from);
    const b = sibs.indexOf(to);
    if (a < 0 || b < 0) return;
    this.picked = new Set(sibs.slice(Math.min(a, b), Math.max(a, b) + 1).map((n) => n.id));
    this.showPicked();
  }
  clearPicked() {
    if (!this.picked.size) return;
    this.picked.clear();
    this.showPicked();
  }
  showPicked() {
    for (const [id, el] of this.cardEls) {
      el.toggleClass("is-picked", this.picked.has(id));
    }
  }
  /** The picked cards, in reading order. */
  pickedInOrder() {
    return core.allNodes(this.root).filter((n) => this.picked.has(n.id));
  }
  /**
   * Put the picked cards under a new card in the first one's place,
   * in order: `kind` 'section', a card with a heading to write, which
   * numbers them below it; or 'scaffolding', which only groups them,
   * so they print and number as before. Only cards side by side under
   * one parent are grouped. One step to undo.
   */
  async groupPicked(kind) {
    const nodes = this.pickedInOrder();
    if (!nodes.length) return;
    const parent = nodes[0].parent;
    if (!nodes.every((n) => n.parent === parent)) {
      new Notice("Dendrite: only cards side by side under one parent are grouped.");
      return;
    }
    if (this.refuseWhileArriving() || this.refuseInPrintView()) return;
    const prefix = this.prefix();
    if (!prefix || !core.validPrefix(prefix)) {
      new Notice("Dendrite: set a valid dendrite_prefix first.");
      return;
    }
    if (this.editing) await this.endEdit();
    const body = kind === "section" ? "# " : "";
    const id = core.newId(prefix, (x) => this.taken(x));
    const made = await this.createCardFile(id, body);
    if (kind === "scaffolding") {
      await writeProps(this.app, made, { dendrite_role: "scaffolding" });
    }
    this.snapshot([], [{ path: made.path, body }]);
    const fresh = core.makeNode(id, "", null);
    core.insertSibling(nodes[0], fresh, false);
    for (const n of nodes) {
      core.remove(n);
      core.appendChild(fresh, n);
    }
    this.reindex();
    this.active = id;
    this.picked.clear();
    if (!await this.writeIndex()) {
      this.undo.pop();
      await this.app.fileManager.trashFile(made);
      return;
    }
    await this.sweepStatuses();
    this.render();
    if (kind === "section") await this.startEdit(id);
  }
  /**
   * Set a role or a status on every picked card, a status only where
   * the card prints its text; one step to undo.
   */
  async setPicked(what, value) {
    const roleOf = (x) => this.printRoleOf(x);
    const key = what === "role" ? "dendrite_role" : "dendrite_status";
    const restores = [];
    for (const n2 of this.pickedInOrder()) {
      const f = this.cardFile(n2.id);
      if (!f) continue;
      if (what === "status" && core.roleFor(n2, roleOf) !== "prose") {
        continue;
      }
      const cur = what === "role" ? this.roleOf(n2.id) : this.statusOf(n2.id);
      if ((cur || null) === (value || null)) continue;
      const data = await this.app.vault.read(f);
      restores.push({
        path: f.path,
        text: data,
        ifBody: core.splitFrontmatter(data).body
      });
      await writeProps(this.app, f, { [key]: value || null });
    }
    if (what === "role") await this.sweepStatuses();
    if (restores.length) {
      this.pushUndo({
        active: this.active,
        files: [],
        created: [],
        restores,
        text: false
      });
    }
    const n = restores.length;
    new Notice(`Dendrite: ${n} picked card${n === 1 ? "" : "s"} set to ${what === "role" ? BRANCH_ROLE_NAMES[value || ""] : value}.`);
  }
  /** Delete every picked card and the cards below it; one undo. */
  async deletePicked() {
    const tops = this.pickedInOrder().filter((n) => {
      for (let p = n.parent; p && p.id; p = p.parent) {
        if (this.picked.has(p.id)) return false;
      }
      return true;
    });
    if (!tops.length || this.refuseWhileArriving() || this.refuseInPrintView()) return;
    if (this.editing) await this.endEdit();
    const doomed = tops.flatMap((n) => [n, ...core.descendants(n)]);
    const files = [];
    for (const n of doomed) {
      const f = this.cardFile(n.id);
      if (f) files.push({
        path: f.path,
        data: await this.app.vault.read(f)
      });
    }
    this.snapshot(files);
    const gone = new Set(doomed.map((n) => n.id));
    const after = core.allNodes(this.root).find((n) => !gone.has(n.id) && core.allNodes(this.root).indexOf(n) > core.allNodes(this.root).indexOf(tops[0]));
    for (const n of tops) core.remove(n);
    this.reindex();
    this.picked.clear();
    this.active = after ? after.id : (this.root.children[0] || {}).id || null;
    if (!await this.writeIndex()) {
      this.undo.pop();
      return;
    }
    for (const n of doomed) {
      const f = this.cardFile(n.id);
      this.invalidate(n.id);
      if (f) await this.app.fileManager.trashFile(f);
    }
    await this.sweepStatuses();
    this.render();
    new Notice(`Dendrite: deleted ${doomed.length} card(s). Ctrl+Z in the view restores them.`);
  }
  /** The menu for the picked cards, from any of them. */
  pickedMenu(anchor, event) {
    const m = dendriteMenu();
    const n = this.picked.size;
    m.addItem((i) => {
      i.setTitle(`${n} cards picked`);
      if (typeof i.setIsLabel === "function") i.setIsLabel(true);
      else if (typeof i.setDisabled === "function") i.setDisabled(true);
    });
    m.addSeparator();
    for (const [value, title, icon] of STATUS_ITEMS) {
      m.addItem((i) => i.setTitle(title).setIcon(icon).onClick(() => this.setPicked("status", value)));
    }
    m.addSeparator();
    let sub = null;
    m.addItem((i) => {
      i.setTitle("Prints as");
      if (typeof i.setSubmenu === "function") sub = i.setSubmenu();
    });
    if (sub) styleMenu(sub, true);
    for (const [value, title, icon] of [[null, "Prints automatically", "wand"], ...ROLE_ITEMS]) {
      (sub || m).addItem((i) => i.setTitle(sub ? title : `Prints as: ${title}`).setIcon(icon).onClick(() => this.setPicked("role", value)));
    }
    m.addItem((i) => i.setTitle(this.menuLabel(
      "Group into a new card\u2026",
      "Ctrl+G"
    )).setIcon("folder-plus").onClick(() => new GroupModal(this).open()));
    m.addSeparator();
    m.addItem((i) => {
      i.setTitle(`Delete ${n} cards and their children`).setIcon("trash-2").onClick(() => this.deletePicked());
      if (typeof i.setWarning === "function") i.setWarning(true);
    });
    if (event) {
      m.showAtMouseEvent(event);
      return;
    }
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      m.showAtPosition({ x: r.left, y: r.bottom }, this.pageDoc());
    }
  }
  /**
   * Make a card the active one. `move` false highlights it without
   * scrolling, so a menu opened on it stays beside it.
   */
  async select(id, move = true) {
    if (id && !this.picked.has(id)) this.clearPicked();
    if (!id || id === this.active) return;
    if (this.editing) await this.endEdit();
    const node = this.byId.get(id);
    const parent = node && this.upOf(node);
    if (parent && parent.id) this.lastChild.set(parent.id, id);
    this.active = id;
    const card = move && this.cardEls.get(id);
    if (card && (card.hasClass("is-slot") || card.hasClass("is-pending"))) {
      await this.renderCard(id);
      if (this.active !== id) return;
    }
    if (move) this.applyActive();
    else this.highlight();
  }
  navigate(dir) {
    const node = this.active && this.byId.get(this.active);
    if (!node) return;
    if (dir === "left") {
      const parent = this.upOf(node);
      if (parent && parent.id) this.select(parent.id);
    } else if (dir === "right") {
      const kids = this.kidsOf(node);
      if (!kids.length) return;
      const last = this.lastChild.get(node.id);
      const pick = kids.find((c) => c.id === last) || kids[0];
      this.select(pick.id);
    } else {
      const col = this.cols[node.depth];
      const i = col.indexOf(node) + (dir === "up" ? -1 : 1);
      if (i >= 0 && i < col.length) this.select(col[i].id);
    }
  }
  registerKeys() {
    const s = this.scope;
    const nav = (dir) => () => {
      if (this.editing) return true;
      this.navigate(dir);
      return false;
    };
    for (const [key, dir] of [
      ["ArrowUp", "up"],
      ["ArrowDown", "down"],
      ["ArrowLeft", "left"],
      ["ArrowRight", "right"]
    ]) {
      s.register([], key, nav(dir));
    }
    s.register([], "Enter", () => {
      if (this.editing) return this.editKey("enter");
      if (this.active) this.startEdit(this.active);
      return false;
    });
    s.register(["Mod"], "b", () => this.editKey("bold"));
    s.register(["Mod"], "i", () => this.editKey("italic"));
    for (const [value, , , key] of STATUS_ITEMS) {
      s.register(["Mod"], key, () => {
        if (this.editing || !this.active) return true;
        this.setStatusByKey(value);
        return false;
      });
    }
    s.register([], "Tab", () => this.editKey("indent"));
    s.register(["Shift"], "Tab", () => this.editKey("outdent"));
    s.register([], "Escape", () => {
      if (this.drag && this.drag.started) {
        this.cancelDrag();
        return false;
      }
      if (this.editing) {
        this.endEdit();
        return false;
      }
      if (this.picked.size) {
        this.clearPicked();
        return false;
      }
      if (this.fannedId) {
        this.toggleFan(this.fannedId);
        return false;
      }
      if (this.find) {
        this.closeFind();
        return false;
      }
      return false;
    });
    s.register(["Mod"], "Enter", () => {
      if (this.editing) return true;
      if (this.active) this.startEdit(this.active);
      return false;
    });
    for (const [key, where] of [
      ["ArrowDown", "below"],
      ["j", "below"],
      ["ArrowUp", "above"],
      ["k", "above"],
      ["ArrowRight", "child"],
      ["l", "child"]
    ]) {
      s.register(["Mod"], key, () => {
        if (this.editing) return true;
        this.insert(where);
        return false;
      });
    }
    for (const [key, op] of [
      ["ArrowUp", "up"],
      ["ArrowDown", "down"],
      ["ArrowRight", "indent"],
      ["ArrowLeft", "outdent"]
    ]) {
      s.register(["Alt"], key, () => {
        if (this.editing) return true;
        this.structural(op);
        return false;
      });
    }
    s.register(["Mod"], "Backspace", () => {
      if (this.editing) return true;
      this.deleteActive();
      return false;
    });
    s.register(["Mod"], "f", () => {
      this.openFind();
      return false;
    });
    s.register(["Mod"], "z", () => {
      if (this.undoInEditor()) return false;
      if (this.editing) return true;
      this.doUndo();
      return false;
    });
    for (const [mods, key] of [[["Mod", "Shift"], "z"], [["Mod"], "y"]]) {
      s.register(mods, key, () => {
        if (this.redoInEditor()) return false;
        if (this.editing) return true;
        this.doRedo();
        return false;
      });
    }
  }
  // ---- dragging cards -------------------------------------------------
  onDragDown(e) {
    this.pressInText = !!(e.target.closest && e.target.closest(".dendrite-cm, textarea, input"));
    if (e.button !== 0 || e.pointerType === "touch") return;
    const card = e.target.closest(".dendrite-card");
    if (!card || this.printOnly) return;
    const grip = e.target.closest(".dendrite-grip");
    if (!grip) {
      if (card.dataset.id === this.active) return;
      if (e.target.closest("a, button, input, textarea, .dendrite-cm, .dendrite-quota, .dendrite-toolbar, .dendrite-id")) return;
    }
    e.preventDefault();
    this.cancelDrag();
    const win = this.pageWin();
    this.drag = {
      id: card.dataset.id,
      x: e.clientX,
      y: e.clientY,
      started: false,
      target: null,
      win
    };
    win.addEventListener("pointermove", this.dragMove);
    win.addEventListener("pointerup", this.dragUp);
    win.addEventListener("pointercancel", this.dragCancel);
  }
  onDragMove(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
      d.started = true;
      const node = this.byId.get(d.id);
      d.ghost = this.pageDoc().body.createDiv({
        cls: "dendrite-ghost",
        text: node ? node.label || node.id : d.id
      });
      const src = this.cardEls.get(d.id);
      if (src) src.addClass("is-dragging");
      this.board.addClass("is-dragging-card");
      const sel = this.pageWin().getSelection();
      if (sel) sel.removeAllRanges();
    }
    e.preventDefault();
    d.ghost.style.left = e.clientX + 12 + "px";
    d.ghost.style.top = e.clientY + 12 + "px";
    this.showDropTarget(this.dropTargetAt(e.clientX, e.clientY));
    this.autoScroll(e.clientX, e.clientY);
  }
  async onDragUp(e) {
    const d = this.drag;
    if (!d) return;
    const target = d.started ? d.target : null;
    if (d.started) {
      e.preventDefault();
      this.justDragged = true;
      setTimeout(() => {
        this.justDragged = false;
      }, 0);
    }
    this.cancelDrag();
    if (target) await this.dropCard(d.id, target.id, target.where);
  }
  cancelDrag() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    d.win.removeEventListener("pointermove", this.dragMove);
    d.win.removeEventListener("pointerup", this.dragUp);
    d.win.removeEventListener("pointercancel", this.dragCancel);
    if (d.ghost) d.ghost.remove();
    if (this.board) this.board.removeClass("is-dragging-card");
    this.showDropTarget(null);
    const src = this.cardEls.get(d.id);
    if (src) src.removeClass("is-dragging");
  }
  /**
   * Where a card dropped at a point would go: over a card's right edge,
   * its last child; over its top half, above it; else below it. Null
   * over nothing, or over the dragged card's own branch.
   */
  dropTargetAt(x, y) {
    const d = this.drag;
    const doc = this.pageDoc();
    const el = doc.elementFromPoint ? doc.elementFromPoint(x, y) : null;
    const card = el && el.closest && el.closest(".dendrite-card");
    if (!d || !card) return null;
    const node = this.byId.get(d.id);
    const target = this.byId.get(card.dataset.id);
    if (!node || !target) return null;
    for (let p = target; p; p = p.parent) if (p === node) return null;
    const r = card.getBoundingClientRect();
    const where = x > r.right - r.width * 0.25 ? "child" : y < r.top + r.height / 2 ? "above" : "below";
    return { id: target.id, where };
  }
  showDropTarget(t) {
    if (this.drag) this.drag.target = t;
    for (const el2 of this.cardEls.values()) {
      el2.removeClass("drop-above");
      el2.removeClass("drop-below");
      el2.removeClass("drop-child");
    }
    const el = t && this.cardEls.get(t.id);
    if (el) el.addClass(`drop-${t.where}`);
  }
  /** Near a column's top or bottom, or the board's sides, scroll. */
  autoScroll(x, y) {
    const EDGE = 48;
    const STEP = 14;
    this.board.querySelectorAll(".dendrite-col").forEach((col, d) => {
      const r = col.getBoundingClientRect();
      if (x < r.left || x > r.right) return;
      if (y < r.top + EDGE) {
        this.setColOffset(d, this.colOffset(d) - STEP);
      } else if (y > r.bottom - EDGE) {
        this.setColOffset(d, this.colOffset(d) + STEP);
      }
    });
    this.drawFlow();
    const b = this.board.getBoundingClientRect();
    if (x < b.left + EDGE) this.board.scrollLeft -= STEP;
    else if (x > b.right - EDGE) this.board.scrollLeft += STEP;
  }
  /** Drop a card, with its branch, above, below or into another. */
  async dropCard(id, targetId, where) {
    if (this.editing) await this.endEdit();
    const node = this.byId.get(id);
    const target = this.byId.get(targetId);
    const before = core.serialiseTree(this.root);
    if (!core.moveNode(node, target, where)) return;
    this.pushUndo({ tree: before, active: id, files: [] });
    this.active = id;
    await this.writeIndex();
    await this.sweepStatuses();
    this.render();
  }
  // ---- editing ---------------------------------------------------------
  /** Run a text command in the editor; true lets the key through. */
  editKey(cmd) {
    const ed = this.editing;
    if (!ed) return cmd !== "indent" && cmd !== "outdent";
    if (!ed.ta) return true;
    const ta = ed.ta;
    const v = ta.value;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const r = cmd === "bold" ? textedit.wrap(v, s, e, "**") : cmd === "italic" ? textedit.wrap(v, s, e, "*") : cmd === "indent" ? textedit.shiftLines(v, s, e, false) : cmd === "outdent" ? textedit.shiftLines(v, s, e, true) : textedit.enter(v, s, e);
    if (!r) return true;
    ta.focus();
    ta.setSelectionRange(r.start, r.end);
    let done = false;
    try {
      done = r.text ? this.pageDoc().execCommand("insertText", false, r.text) : r.start === r.end || this.pageDoc().execCommand("delete");
    } catch (err) {
      done = false;
    }
    if (!done) {
      ta.setRangeText(r.text, r.start, r.end, "end");
      ta.dispatchEvent(new Event("input"));
    }
    ta.setSelectionRange(r.selStart, r.selEnd);
    return false;
  }
  async startEdit(id, atStart = false) {
    if (this.refuseWhileArriving()) return;
    if (this.editing) {
      if (this.editing.id === id) return;
      await this.endEdit();
    }
    if (id !== this.active) {
      this.active = id;
      this.applyActive();
    }
    let f = this.cardFile(id);
    if (!f) f = await this.createCardFile(id);
    const raw = await this.app.vault.read(f);
    const ed = {
      id,
      file: f,
      dirty: false,
      timer: null,
      saving: Promise.resolve(),
      before: core.splitFrontmatter(raw).body
    };
    ed.saved = ed.before;
    const kind = this.kindOf(id);
    const asFloat = !!kind && this.asTextOnce !== id;
    this.asTextOnce = null;
    const handlers = {
      value: core.splitFrontmatter(raw).body,
      file: f,
      onChange: () => {
        ed.dirty = true;
        ed.changed = true;
        if (!ed.applying) ed.stepped = false;
        ed.fresh = false;
        this.followCaret();
        this.scheduleCounts();
        clearTimeout(ed.timer);
        ed.timer = setTimeout(
          () => this.save(ed),
          this.plugin.settings.autosaveMs
        );
        this.plugin.typedAt = Date.now();
      },
      onBlur: () => {
        this.save(ed);
      },
      onEscape: () => {
        this.endEdit();
      },
      onFind: () => {
        this.openFind();
      },
      onRedraw: () => {
        if (this.find) this.paintFind();
      },
      onUndo: () => this.undoInEditor(),
      onRedo: () => this.redoInEditor()
    };
    const editor = asFloat ? float.floatEditor(Object.assign(handlers, {
      kind,
      label: this.floatOpts().floats.get(id) || (kind === "table" ? "Table" : "Figure"),
      onAsText: () => this.editAsText(id),
      render: (md, el) => this.renderInto(md, el, f.path),
      image: (file) => this.saveFigureImage(id, file),
      // Images found by name, linked as Obsidian links them.
      findImage: (input, pick) => noteSuggest(this.app, input, (img) => pick(this.app.metadataCache.getFirstLinkpathDest(
        img.name,
        f.path
      ) === img ? img.name : img.path), true),
      // Each field in the card editor: Obsidian's live preview
      // edits a table as a grid, rows, columns and alignment from
      // its own menu.
      makeEditor: (value, h) => this.newEditor({
        value,
        file: f,
        onChange: h.onChange,
        onBlur: h.onBlur,
        onEscape: h.onEscape,
        onFind: () => this.openFind(),
        onRedraw: () => {
        },
        onUndo: () => false,
        onRedo: () => false
      })
    })) : this.newEditor(handlers);
    ed.editor = editor;
    ed.ta = editor.ta || null;
    this.editing = ed;
    this.caretAt = null;
    const card = this.fillFrame(id);
    if (card && editor.kind === "float") {
      this.mountFloat(card, editor);
    } else if (card) {
      const body = card.querySelector(".dendrite-card-body");
      body.empty();
      body.appendChild(editor.el);
      card.addClass("is-editing");
      card.toggleClass("has-obsidian-editor", editor.kind === "obsidian");
      card.removeClass("is-pending");
    }
    this.renderToolbar();
    this.focusEditor(editor, atStart);
    this.showMode();
    if (this.find) this.paintFind();
  }
  /** A card's editor: Obsidian's, unless the settings say not. */
  newEditor(handlers) {
    const colours = this.colourOf();
    const nameOf = this.nameOf();
    return cardEditor(
      this.app,
      this,
      Object.assign({
        colourOf: (who) => colours(who || "Reviewer"),
        nameOf,
        onLost: (lost) => {
          const clip = (t) => t.length > 40 ? `${t.slice(0, 39).trim()}\u2026` : t;
          const said = lost.map((x) => `${x.n} (${nameOf(
            x.author || "Reviewer"
          )}: "${clip(x.text.trim())}")`);
          new Notice(`Dendrite: comment${lost.length === 1 ? "" : "s"} ${said.join(", ")} no longer mark${lost.length === 1 ? "s" : ""} any text. Undo puts the text back.`, 1e4);
        }
      }, handlers),
      this.plugin.settings.obsidianEditor !== false
    );
  }
  /** The caret into a card's new editor, at its start or its end. */
  focusEditor(editor, atStart) {
    editor.focus(atStart);
  }
  /** Write the editor's text to its card, keeping the frontmatter. */
  save(ed) {
    clearTimeout(ed.timer);
    if (!ed.dirty) return ed.saving;
    ed.dirty = false;
    const text = ed.editor.value;
    ed.saved = text;
    ed.saving = ed.saving.then(() => this.writeCard(
      ed.file,
      (data) => core.splitFrontmatter(data).fm + text
    )).then(() => {
      if (this.noteLabel(ed.id, text)) this.scheduleLabels();
    }).catch((err) => {
      ed.dirty = true;
      console.error("Dendrite: save failed", err);
      new Notice("Dendrite could not save the card; the text is still in the editor.");
    });
    return ed.saving;
  }
  async flush() {
    if (this.editing) await this.save(this.editing);
    await this.writeLabels();
  }
  async endEdit() {
    const ed = this.editing;
    if (!ed) return;
    await this.save(ed);
    this.editing = null;
    ed.editor.destroy();
    await this.writeLabels();
    if (ed.changed) await this.clearFinishedSplit(ed.file);
    const node = this.byId.get(ed.id);
    if (ed.changed && node && !this.statusOf(ed.id) && core.roleFor(node, (x) => this.printRoleOf(x)) === "prose") {
      await this.setStatus(ed.id, "draft");
    }
    if (ed.changed) await this.plugin.lintCard(ed.file);
    if (ed.changed && !ed.recorded) {
      const after = core.splitFrontmatter(
        await this.app.vault.read(ed.file)
      ).body;
      this.recordVisit(ed.id, ed.before, after);
    }
    this.invalidate(ed.id);
    const card = this.cardEls.get(ed.id);
    if (card) {
      card.removeClass("is-editing");
      card.removeClass("has-obsidian-editor");
      card.removeClass("is-float-editing");
      card.addClass("is-pending");
      const body = card.querySelector(".dendrite-card-body");
      if (body) body.style.minHeight = "";
    }
    this.unmountFloat();
    await this.renderCard(ed.id);
    this.renderToolbar();
    this.showMode();
    this.contentEl.focus();
  }
  // ---- tables and figures, edited wide --------------------------------
  /**
   * A table or figure card's editor, drawn over the board where the card
   * is, as wide as the page's text, since a column is narrower than what
   * it holds. The card keeps its place and grows to the editor's height,
   * so the cards below move down for it.
   */
  mountFloat(card, editor) {
    const stage = this.board && this.board.parentElement;
    if (!stage) return;
    const st = this.manuscript().style || {};
    const el = editor.el;
    el.style.width = `${Math.round(float.textWidthPt(st))}pt`;
    el.style.setProperty(
      "--dendrite-float-size",
      `${st.fontSize || 10}pt`
    );
    if (st.font) el.style.setProperty("--dendrite-float-font", st.font);
    stage.appendChild(el);
    card.addClass("is-editing");
    card.addClass("is-float-editing");
    card.removeClass("is-pending");
    const body = card.querySelector(".dendrite-card-body");
    if (body) body.empty();
    this.floatEl = el;
    this.floatCard = card;
    if (typeof ResizeObserver !== "undefined") {
      this.floatSizer = new ResizeObserver(() => this.placeFloat());
      this.floatSizer.observe(el);
    }
    this.placeFloat();
  }
  unmountFloat() {
    if (this.floatSizer) this.floatSizer.disconnect();
    this.floatSizer = null;
    if (this.floatComp) this.floatComp.unload();
    this.floatComp = null;
    this.floatEl = null;
    this.floatCard = null;
  }
  /** Keep the wide editor over its card as the columns move. */
  placeFloat() {
    const el = this.floatEl;
    const card = this.floatCard;
    if (!el || !card || !el.parentElement) return;
    const stage = el.parentElement.getBoundingClientRect();
    const r = card.getBoundingClientRect();
    const left = Math.max(0, r.left - stage.left);
    setStyles(el, {
      left: `${left}px`,
      top: `${r.top - stage.top}px`,
      maxWidth: `${Math.max(
        r.width,
        stage.width - left - 12
      )}px`
    });
    const body = card.querySelector(".dendrite-card-body");
    const extra = r.height - (body ? body.offsetHeight : 0);
    const high = el.offsetHeight;
    if (body && high) {
      setStyles(body, { minHeight: `${Math.max(0, high - extra)}px` });
    }
  }
  /** The card's text in the plain editor, for this visit. */
  async editAsText(id) {
    this.asTextOnce = id;
    if (this.editing) await this.endEdit();
    this.asTextOnce = id;
    await this.startEdit(id);
  }
  /** Markdown drawn into a table or figure editor. */
  async renderInto(md, el, path) {
    if (!this.floatComp) {
      this.floatComp = new Component();
      this.floatComp.load();
    }
    await MarkdownRenderer.render(
      this.app,
      md,
      el,
      path,
      this.floatComp
    );
  }
  /**
   * An image pasted or dropped on a figure card, saved in figures/ in
   * the manuscript's folder, named for the card, never over another
   * file; answers its embed.
   */
  async saveFigureImage(id, file) {
    const parent = this.file.parent ? this.file.parent.path : "";
    const folder = normalizePath(`${parent}/figures`);
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
    const ext = (/\.([a-z0-9]+)$/i.exec(file.name || "") || [null, (file.type || "image/png").split("/")[1] || "png"])[1].toLowerCase();
    let name = `${id}.${ext}`;
    for (let k = 2; this.app.vault.getAbstractFileByPath(
      `${folder}/${name}`
    ); k++) {
      name = `${id}-${k}.${ext}`;
    }
    await this.app.vault.createBinary(
      `${folder}/${name}`,
      await file.arrayBuffer()
    );
    return float.embedFor(`figures/${name}`);
  }
  showMode() {
    if (!this.modeEl) return;
    this.modeEl.setText(this.editing ? "INSERT" : "NORMAL");
    this.modeEl.toggleClass("is-insert", !!this.editing);
  }
  /**
   * Vim-style keys in normal mode, when no card is being edited. Plain
   * letters are bound to nothing else here, so they are handled from
   * the pane's own keydown rather than registered in Obsidian's scope.
   */
  onNavKey(e) {
    if (this.editing || e.defaultPrevented) return;
    if (e.target.closest("input, textarea, select, .dendrite-cm")) return;
    if (this.arrowKey(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.picked.size) this.clearPicked();
      else if (this.fannedId) this.toggleFan(this.fannedId);
      else if (this.find) this.closeFind();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "g" && this.picked.size) {
      e.preventDefault();
      new GroupModal(this).open();
      return;
    }
    const code = /^(?:Digit|Numpad)(\d)$/.exec(e.code || "");
    const digit = code ? code[1] : /^\d$/.test(e.key) ? e.key : null;
    const mod = e.ctrlKey || e.metaKey;
    const status = mod && !e.shiftKey && !e.altKey && digit && STATUS_ITEMS.find((r) => r[3] === digit);
    if (status) {
      if (!this.active) return;
      e.preventDefault();
      this.setStatusByKey(status[0]);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const statusKey = {
      "]": () => this.nextFlagged(1),
      "[": () => this.nextFlagged(-1),
      "+": () => this.stepStatus(true),
      "=": () => this.stepStatus(true),
      "-": () => this.stepStatus(false)
    }[e.key];
    if (statusKey) {
      e.preventDefault();
      statusKey();
      return;
    }
    if (!e.shiftKey && ROLE_KEYS.has(digit) && this.active) {
      e.preventDefault();
      this.setRole(this.active, ROLE_KEYS.get(digit));
      return;
    }
    if (!this.plugin.settings.vimKeys) return;
    const prev = this.pendingKey;
    this.pendingKey = null;
    const k = e.key;
    const act = {
      "/": () => this.openFind(),
      h: () => this.navigate("left"),
      j: () => this.navigate("down"),
      k: () => this.navigate("up"),
      l: () => this.navigate("right"),
      i: () => this.active && this.startEdit(this.active, true),
      a: () => this.active && this.startEdit(this.active),
      o: () => this.insert("below"),
      O: () => this.insert("above"),
      n: () => this.insert(this.active ? "child" : "first"),
      J: () => this.structural("down"),
      K: () => this.structural("up"),
      ">": () => this.structural("indent"),
      "<": () => this.structural("outdent"),
      u: () => this.doUndo(),
      G: () => this.columnEnd(false)
    }[k];
    if (k === "d" || k === "g") {
      e.preventDefault();
      if (prev === k) {
        if (k === "d") this.deleteActive();
        else this.columnEnd(true);
      } else {
        this.pendingKey = k;
      }
      return;
    }
    if (!act) return;
    e.preventDefault();
    act();
  }
  /** Arrows, Alt and Ctrl arrows, and Enter; true if handled. */
  arrowKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Enter" && !mod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (this.active) this.startEdit(this.active);
      return true;
    }
    const vim = { j: "below", k: "above", l: "child" }[e.key];
    if (vim && mod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.insert(vim);
      return true;
    }
    const dir = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right"
    }[e.key];
    if (!dir || e.shiftKey) return false;
    let act = null;
    if (e.altKey && !mod) {
      const op = {
        up: "up",
        down: "down",
        left: "outdent",
        right: "indent"
      }[dir];
      act = () => this.structural(op);
    } else if (mod && !e.altKey) {
      const where = { up: "above", down: "below", right: "child" }[dir];
      if (where) act = () => this.insert(where);
    } else if (!mod && !e.altKey) {
      act = () => this.navigate(dir);
    }
    if (!act) return false;
    e.preventDefault();
    act();
    return true;
  }
  columnEnd(top) {
    const node = this.active && this.byId.get(this.active);
    const col = node ? this.cols[node.depth] : this.cols[0];
    if (!col || !col.length) return;
    this.select((top ? col[0] : col[col.length - 1]).id);
  }
  /** Follow a card's label in memory; true if it changed. */
  noteLabel(id, body) {
    const node = this.byId.get(id);
    if (!node) return false;
    const f = this.cardFile(id);
    const fm = f && this.app.metadataCache.getFileCache(f)?.frontmatter;
    const label = core.deriveLabel(body, fm && fm.aliases);
    if (label === node.label) return false;
    node.label = label;
    return true;
  }
  async syncLabel(id, body) {
    if (this.noteLabel(id, body)) await this.writeIndex();
  }
  /** Write labels once typing pauses. */
  scheduleLabels() {
    clearTimeout(this.labelTimer);
    this.labelTimer = setTimeout(
      () => this.writeLabels(),
      this.labelIdleMs || LABEL_IDLE_MS
    );
  }
  /** Write the index if a label in memory differs from it. */
  async writeLabels() {
    clearTimeout(this.labelTimer);
    this.labelTimer = null;
    if (!this.file || this.indexList === null) return;
    if (core.serialiseTree(this.root) !== this.indexList) {
      await this.writeIndex();
    }
  }
  // ---- structure -------------------------------------------------------
  /**
   * Record a step for undo. A new step ends any redo, since the steps
   * it would redo no longer follow from the current state.
   */
  pushUndo(entry) {
    this.undo.push(entry);
    if (this.undo.length > UNDO_DEPTH) this.undo.shift();
    this.redo = [];
  }
  snapshot(files = [], created = []) {
    this.pushUndo({
      tree: core.serialiseTree(this.root),
      active: this.active,
      files,
      created
    });
  }
  async writeIndex() {
    const root = this.root;
    clearTimeout(this.labelTimer);
    if (this.refuseWhileArriving()) {
      await this.reload();
      return false;
    }
    let stale = false;
    await this.app.vault.process(this.file, (data) => {
      const disk = core.serialiseTree(
        core.parseIndex(core.splitFrontmatter(data).body).root
      );
      if (this.indexList !== null && disk !== this.indexList) {
        stale = true;
        return data;
      }
      const out = core.writeIndexText(data, root);
      this.indexText = out;
      this.selfWrites.add(out);
      if (this.selfWrites.size > 20) {
        this.selfWrites.delete(this.selfWrites.values().next().value);
      }
      return out;
    });
    if (stale) {
      new Notice("Dendrite: the index changed outside this board since it was read, from a sync or another editor. It has been read again; the last change was not written, so make it again.", 1e4);
      await this.reload();
      return false;
    }
    this.indexList = core.serialiseTree(root);
    return true;
  }
  /** Write a card's note, known as Dendrite's own when it arrives. */
  async writeCard(f, fn) {
    let out = null;
    await this.app.vault.process(f, (data) => {
      out = fn(data);
      this.ownBodies.set(f.path, core.splitFrontmatter(out).body);
      return out;
    });
    return out;
  }
  async createCardFile(id, text = "") {
    const folder = this.cardsFolder();
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
    const f = await this.app.vault.create(
      normalizePath(`${folder}/${id}.md`),
      text
    );
    if (this.plugin.settings.cardType) {
      await addType(this.app, f, this.plugin.settings.cardType);
    }
    return f;
  }
  /**
   * Move the selection, or everything after the cursor, out of the card
   * being edited into a new card below it or a new last child. The new
   * card is written and indexed before the text leaves the original, so
   * a failure part-way leaves the text twice, never nowhere.
   */
  async moveSelection(where) {
    const ed = this.editing;
    if (!ed || this.refuseInPrintView()) return;
    const prefix = this.prefix();
    if (!prefix || !core.validPrefix(prefix)) {
      new Notice("Dendrite: set a valid dendrite_prefix first.");
      return;
    }
    const original = ed.editor.value;
    const [s, e] = ed.editor.selection();
    const cut = core.splitText(original, s, e);
    if (!cut) {
      new Notice("Dendrite: nothing selected, and nothing after the cursor, to move.");
      return;
    }
    const node = this.byId.get(ed.id);
    if (!node) return;
    const before = core.serialiseTree(this.root);
    await this.save(ed);
    this.recordVisit(ed.id, ed.before, original);
    const srcText = await this.app.vault.read(ed.file);
    const srcStatus = core.roleFor(node, (x) => this.printRoleOf(x)) === "prose" ? this.statusOf(ed.id) : null;
    const set = this.roleOf(ed.id);
    const role = set && set !== "section" ? set : null;
    const prints = !role || role === "prose";
    const id = core.newId(prefix, (x) => this.taken(x));
    const made = await this.createCardFile(id, cut.moved);
    await writeProps(this.app, made, {
      dendrite_role: role,
      dendrite_status: prints ? srcStatus || "draft" : null
    });
    const fresh = core.makeNode(
      id,
      core.deriveLabel(cut.moved, null),
      null
    );
    if (where === "child") core.appendChild(node, fresh);
    else core.insertSibling(node, fresh, true);
    this.byId.set(id, fresh);
    if (!await this.writeIndex()) {
      await this.app.fileManager.trashFile(made);
      return;
    }
    ed.editor.replace(cut.keep, cut.at);
    ed.dirty = true;
    ed.changed = true;
    await this.save(ed);
    ed.before = cut.keep;
    if (where === "child" && core.roleFor(node, (x) => this.printRoleOf(x)) !== "prose") {
      await this.setStatus(
        ed.id,
        core.leftover(cut.keep) ? "unsplit" : null
      );
    }
    this.pushUndo({
      tree: before,
      active: ed.id,
      files: [],
      created: [{ path: made.path, body: cut.moved }],
      restores: [{
        path: ed.file.path,
        body: original,
        ifBody: cut.keep,
        text: srcText
      }]
    });
    this.render();
    ed.editor.focusAt(cut.at);
  }
  /**
   * Merge the active card into the card above it, or into its parent.
   * The receiving card is written with both texts before the merged
   * card's note goes to the trash.
   */
  async merge(kind) {
    if (this.refuseInPrintView()) return;
    const node = this.active && this.byId.get(this.active);
    if (!node) return;
    if (this.editing) await this.endEdit();
    const i = node.parent.children.indexOf(node);
    const target = kind === "above" ? i > 0 ? node.parent.children[i - 1] : null : node.parent.id ? node.parent : null;
    if (!target) {
      new Notice(kind === "above" ? "Dendrite: no card above this one to merge into." : "Dendrite: a top-level card has no parent to merge into.");
      return;
    }
    const src = this.cardFile(node.id);
    const dst = this.cardFile(target.id);
    if (!src || !dst) {
      new Notice("Dendrite: a card note is missing; nothing merged.");
      return;
    }
    const srcText = await this.app.vault.read(src);
    const dstText = await this.app.vault.read(dst);
    const dstBody = core.splitFrontmatter(dstText).body;
    const mergedStatus = core.lowerStatus(
      this.statusOf(node.id),
      this.statusOf(target.id)
    );
    const merged = core.mergeText(
      dstBody,
      core.splitFrontmatter(srcText).body
    );
    const before = core.serialiseTree(this.root);
    await this.writeCard(
      dst,
      (data) => core.splitFrontmatter(data).fm + merged
    );
    if (kind === "above") core.mergeIntoAbove(node);
    else {
      core.mergeIntoParent(node);
      core.remove(node);
    }
    this.reindex();
    this.active = target.id;
    if (!await this.writeIndex()) {
      await this.writeCard(dst, () => dstText);
      return;
    }
    this.invalidate(node.id);
    this.invalidate(target.id);
    await this.app.fileManager.trashFile(src);
    this.pushUndo({
      tree: before,
      active: node.id,
      files: [{ path: src.path, data: srcText }],
      created: [],
      restores: [{
        path: dst.path,
        body: dstBody,
        ifBody: merged,
        text: dstText
      }]
    });
    await this.syncLabel(target.id, merged);
    if (core.roleFor(target, (x) => this.printRoleOf(x)) === "prose") {
      await this.setStatus(target.id, mergedStatus);
    }
    await this.sweepStatuses();
    this.render();
  }
  taken(id) {
    return this.byId.has(id) || !!this.app.metadataCache.getFirstLinkpathDest(id, "") || !!this.app.vault.getAbstractFileByPath(
      normalizePath(`${this.cardsFolder()}/${id}.md`)
    );
  }
  async insert(where) {
    if (this.refuseWhileArriving() || this.refuseInPrintView()) return;
    const prefix = this.prefix();
    if (!prefix || !core.validPrefix(prefix)) {
      new Notice("Dendrite: set a valid dendrite_prefix in the index note's properties first.");
      return;
    }
    if (this.editing) await this.endEdit();
    const node = this.active && this.byId.get(this.active);
    const id = core.newId(prefix, (x) => this.taken(x));
    const made = await this.createCardFile(id);
    this.snapshot([], [made.path]);
    const fresh = core.makeNode(id, "", null);
    if (!node || where === "first") {
      core.appendChild(this.root, fresh);
    } else if (where === "child") {
      core.appendChild(node, fresh);
    } else {
      core.insertSibling(node, fresh, where === "below");
    }
    this.byId.set(id, fresh);
    this.active = id;
    if (!await this.writeIndex()) {
      this.undo.pop();
      await this.app.fileManager.trashFile(made);
      return;
    }
    await this.sweepStatuses();
    this.render();
    await this.startEdit(id);
    if (this.editing && this.editing.id === id) this.editing.fresh = true;
  }
  /** A visit's change to a card's text, for its own history. */
  recordVisit(id, before, after) {
    if (after === before) return;
    let t = this.texts.get(id);
    if (!t) this.texts.set(id, t = { undo: [], redo: [] });
    t.undo.push({ before, after });
    if (t.undo.length > UNDO_DEPTH) t.undo.shift();
    t.redo = [];
  }
  /**
   * Ctrl+Z in a card once this visit's own typing is undone, or before
   * any: the card steps back a whole earlier visit, its text as it was
   * before that visit. A new card still empty is taken back instead.
   * False when the editor's own undo applies.
   */
  undoInEditor() {
    if (this.undoEmptyNew()) return true;
    const ed = this.editing;
    if (!ed || ed.editor.value.trim() !== ed.before.trim()) return false;
    const t = this.texts.get(ed.id);
    const top = t && t.undo[t.undo.length - 1];
    if (!top) return false;
    if (top.after.trim() !== ed.before.trim()) {
      new Notice("Dendrite: this card's text changed since its last visit, by a split, merge or sync, so its earlier text is not undone here.");
      return true;
    }
    t.undo.pop();
    t.redo.push(top);
    this.applyStep(ed, top.before);
    return true;
  }
  /**
   * Ctrl+Shift+Z or Ctrl+Y in a card right after stepping back through
   * its history: the visit comes back. False when the editor's own
   * redo applies.
   */
  redoInEditor() {
    const ed = this.editing;
    if (!ed || !ed.stepped) return false;
    const t = this.texts.get(ed.id);
    const top = t && t.redo[t.redo.length - 1];
    if (!top || top.before.trim() !== ed.editor.value.trim()) {
      return false;
    }
    t.redo.pop();
    t.undo.push(top);
    this.applyStep(ed, top.after);
    return true;
  }
  /** Put a step's text in the editor; this visit starts from it. */
  applyStep(ed, text) {
    ed.applying = true;
    try {
      ed.editor.replace(text, text.length);
    } finally {
      ed.applying = false;
    }
    ed.before = text;
    ed.dirty = true;
    ed.changed = true;
    ed.fresh = false;
    ed.stepped = true;
    this.save(ed);
  }
  /**
   * Ctrl+Z in a card just made and still empty: undo making it, since
   * the text has nothing of its own to undo. False otherwise.
   */
  undoEmptyNew() {
    const ed = this.editing;
    if (!ed || !ed.fresh || ed.editor.value.trim()) return false;
    (async () => {
      await this.endEdit();
      await this.doUndo();
    })();
    return true;
  }
  async structural(op) {
    if (this.refuseInPrintView()) return;
    const node = this.active && this.byId.get(this.active);
    if (!node) return;
    if (this.editing) await this.endEdit();
    const before = core.serialiseTree(this.root);
    const past = (d) => {
      const sibs = node.parent.children;
      let j = sibs.indexOf(node) + d;
      while (sibs[j] && this.isSuperseded(sibs[j].id)) j += d;
      if (!sibs[j]) return false;
      const to = sibs[j];
      core.remove(node);
      core.insertSibling(to, node, d > 0);
      return true;
    };
    const fn = {
      up: () => past(-1),
      down: () => past(1),
      indent: () => core.indent(node),
      outdent: () => core.outdent(node)
    }[op];
    if (!fn || !fn()) return;
    this.pushUndo({ tree: before, active: this.active, files: [] });
    await this.writeIndex();
    await this.sweepStatuses();
    this.render();
  }
  // ---- stacks: a card's old versions, kept under it -------------------
  /** Whether a card is an old version, kept in another's stack. */
  isSuperseded(id) {
    return !!this.cardProps(id).dendrite_superseded;
  }
  /** A card's old versions, newest first. */
  stackOf(id) {
    const node = this.byId.get(id);
    return node ? node.children.filter((c) => this.isSuperseded(c.id)) : [];
  }
  /**
   * Put `byId`, a card under `topId` or one of its old versions, in
   * its place, or with no `byId` a new empty card: it takes the place,
   * the cards below and the stack, and the card it replaces goes to
   * the top of the stack, hidden and printing nothing. One step to
   * undo.
   */
  async promote(topId, byId = null) {
    if (this.refuseWhileArriving() || this.refuseInPrintView()) return;
    const top = this.byId.get(topId);
    if (!top || this.isSuperseded(topId)) return;
    let by = byId ? this.byId.get(byId) : null;
    if (byId && (!by || by.parent !== top)) return;
    if (this.editing) await this.endEdit();
    const set = this.cardProps(topId).dendrite_role;
    const shownBelow = top.children.filter((c) => c !== by && !this.isSuperseded(c.id));
    const role = core.ROLES.includes(set) ? set : shownBelow.length ? "section" : "prose";
    const kind = this.kindOf(topId);
    let made = null;
    if (!by) {
      const prefix = this.prefix();
      if (!prefix || !core.validPrefix(prefix)) {
        new Notice("Dendrite: set a valid dendrite_prefix first.");
        return;
      }
      const id = core.newId(prefix, (x) => this.taken(x));
      made = await this.createCardFile(id);
      by = core.makeNode(id, "", null);
    }
    const restores = [];
    for (const n of made ? [top] : [top, by]) {
      const f = this.cardFile(n.id);
      if (!f) continue;
      const data = await this.app.vault.read(f);
      restores.push({
        path: f.path,
        text: data,
        ifBody: core.splitFrontmatter(data).body
      });
    }
    const before = core.serialiseTree(this.root);
    if (by.parent) core.remove(by);
    core.insertSibling(top, by, false);
    const shown = top.children.filter((c) => !this.isSuperseded(c.id));
    const stacked = top.children.filter((c) => this.isSuperseded(c.id));
    core.remove(top);
    top.children = [];
    for (const c of [...shown, top, ...stacked]) core.appendChild(by, c);
    this.reindex();
    this.active = by.id;
    this.pushUndo({
      tree: before,
      active: topId,
      files: [],
      created: made ? [made.path] : [],
      restores,
      text: false
    });
    if (!await this.writeIndex()) {
      this.undo.pop();
      if (made) await this.app.fileManager.trashFile(made);
      return;
    }
    const d = /* @__PURE__ */ new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await writeProps(
      this.app,
      this.cardFile(topId),
      { dendrite_superseded: today }
    );
    const props = { dendrite_superseded: null };
    if (!core.ROLES.includes(this.cardProps(by.id).dendrite_role)) {
      props.dendrite_role = role;
    }
    if (kind && !this.kindOf(by.id)) props.dendrite_kind = kind;
    await writeProps(this.app, this.cardFile(by.id), props);
    this.invalidate(topId);
    this.invalidate(by.id);
    await this.sweepStatuses();
    this.render();
    if (made) {
      await this.startEdit(by.id);
      if (this.editing && this.editing.id === by.id) {
        this.editing.fresh = true;
      }
    }
  }
  /**
   * Open review comments and suggested changes on a card's old
   * versions, shown on the card: its versions chip says how many, in
   * the revise colour, and its stack's edges take that colour, so they
   * are not left unresolved under it. Read after the board is drawn.
   */
  async markOpenStacks() {
    const counts = /* @__PURE__ */ new Map();
    for (const [id, card] of this.cardEls) {
      const stack = this.stackOf(id);
      if (!stack.length) {
        card.removeClass("has-stack-open");
        continue;
      }
      let open = 0;
      for (const v of stack) {
        const f = this.cardFile(v.id);
        if (!f) continue;
        open += review.countComments(review.reviewItems(
          core.splitFrontmatter(
            await this.app.vault.cachedRead(f)
          ).body
        ));
      }
      counts.set(id, open);
    }
    this.stackOpen = counts;
    for (const id of counts.keys()) {
      const card = this.cardEls.get(id);
      if (card) this.stackOpenCard(id, card);
    }
  }
  /**
   * A stacked card's open comments, from the last markOpenStacks: its
   * edges flagged and the count on its versions chip.
   */
  stackOpenCard(id, card) {
    const all = this.stackOpen && this.stackOpen.get(id);
    if (all === void 0) return;
    const open = this.fannedId === id ? 0 : all;
    card.toggleClass("has-stack-open", open > 0);
    const s = card.querySelector(`[data-stack="${id}"]`);
    if (!s) return;
    const n = this.stackOf(id).length + 1;
    s.setText(`${n} versions` + (open ? ` \xB7 ${open} open` : ""));
    s.toggleClass("is-revise", open > 0);
    const colour = open && this.plugin.statusColour && this.plugin.statusColour("revise");
    if (colour) s.style.setProperty("--dendrite-chip", colour);
    else s.style.removeProperty("--dendrite-chip");
  }
  /** An old version taken out of a stack, its note to the trash. */
  async deleteVersion(id) {
    const node = this.byId.get(id);
    if (!node || !this.isSuperseded(id) || this.refuseWhileArriving()) return;
    const doomed = [node, ...core.descendants(node)];
    const files = [];
    for (const n of doomed) {
      const f = this.cardFile(n.id);
      if (f) files.push({
        path: f.path,
        data: await this.app.vault.read(f)
      });
    }
    this.snapshot(files);
    core.remove(node);
    this.reindex();
    if (!await this.writeIndex()) {
      this.undo.pop();
      return;
    }
    for (const n of doomed) {
      const f = this.cardFile(n.id);
      this.invalidate(n.id);
      if (f) await this.app.fileManager.trashFile(f);
    }
    this.render();
  }
  openStack(id) {
    new StackModal(this, id).open();
  }
  /**
   * Fan a card's old versions out to its right, or fold them away; one
   * card's at a time.
   */
  toggleFan(id) {
    this.fannedId = this.fannedId === id ? null : id;
    this.render();
    return this.fanReady;
  }
  /**
   * The fanned card's old versions in a column floating over the next
   * column to its right, newest first beside the card, scrolled through
   * up and down: the columns to its left stay in view.
   */
  async renderFan(stage) {
    for (const c of this.fanComps.splice(0)) c.unload();
    this.fanEl = null;
    const id = this.fannedId;
    const stack = id && !this.printOnly && this.cardEls.has(id) ? this.stackOf(id) : [];
    if (!stack.length) {
      this.fannedId = null;
      return;
    }
    const fan = stage.createDiv({ cls: "dendrite-fan" });
    this.fanEl = fan;
    const head = fan.createDiv({ cls: "dendrite-fan-head" });
    head.createSpan({ text: `${stack.length} old version${stack.length === 1 ? "" : "s"}, newest first` });
    const b = head.createEl("button", { cls: "dendrite-fan-btn" });
    setIcon(b, "x");
    b.setAttr("aria-label", "Fold the old versions away");
    b.onclick = () => this.toggleFan(id);
    const row = fan.createDiv({ cls: "dendrite-fan-row" });
    this.placeFan();
    await Promise.all(stack.map((old) => this.renderVersion(row, old.id)));
    this.placeFan();
  }
  /**
   * Keep the fan in the column right of its card as the columns move:
   * its newest version where a card of that column would sit, level
   * with the card, of the card's width, so their text lines up.
   */
  placeFan() {
    const fan = this.fanEl;
    const card = fan && this.cardEls.get(this.fannedId);
    if (!fan || !card || !fan.parentElement) return;
    const stage = fan.parentElement.getBoundingClientRect();
    const r = card.getBoundingClientRect();
    const col = card.closest(".dendrite-col");
    const gap = col ? col.getBoundingClientRect().right - r.right : 12;
    const first = fan.querySelector(".dendrite-version");
    const f = fan.getBoundingClientRect();
    const v = first ? first.getBoundingClientRect() : f;
    const inX = v.left - f.left;
    const inY = v.top - f.top;
    const top = Math.max(8, r.top - stage.top - inY);
    setStyles(fan, {
      left: `${r.right - stage.left + 2 * gap - inX}px`,
      top: `${top}px`,
      width: `${r.width + 2 * inX}px`,
      maxHeight: `${Math.max(160, stage.height - top - 8)}px`
    });
  }
  /**
   * An old version in the fan: read only, with its review comments,
   * which can be resolved from it. Not a card on the board, so it is
   * never selected or edited.
   */
  async renderVersion(group, id) {
    const el = group.createDiv({ cls: "dendrite-version" });
    el.dataset.id = id;
    el.createDiv({
      cls: "dendrite-version-head",
      text: `Replaced ${this.cardProps(id).dendrite_superseded}, card ${core.shortId(id)}`
    });
    const body = el.createDiv({ cls: "dendrite-card-body" });
    const f = this.cardFile(id);
    if (!f) return;
    const text = core.splitFrontmatter(
      await this.app.vault.read(f)
    ).body;
    const comp = new Component();
    comp.load();
    this.fanComps.push(comp);
    const out = body.createDiv({ cls: "dendrite-md markdown-rendered" });
    const notes = review.reviewItems(text);
    el.toggleClass("has-open", notes.length > 0);
    if (notes.length) {
      const chip = el.createDiv({ cls: "dendrite-status" }).createSpan({
        cls: "dendrite-status-chip is-revise",
        text: `${review.countComments(notes)} open \u2691`
      });
      const colour = this.plugin.statusColour && this.plugin.statusColour("revise");
      if (colour) chip.style.setProperty("--dendrite-chip", colour);
    }
    if (!text.trim()) {
      out.createDiv({
        cls: "dendrite-placeholder",
        text: "Empty card"
      });
      return;
    }
    await MarkdownRenderer.render(
      this.app,
      notes.length ? review.renderMarkdown(text, this.colourOf()) : text,
      out,
      f.path,
      comp
    );
    if (notes.length) {
      review.wrapPassages(out);
      review.decorate(
        out,
        notes,
        (n, what, arg) => this.reviewAction(id, n, what, arg),
        (n, e, k) => this.commentMenu(id, n, e, k),
        this.colourOf(),
        (el2) => ownKeys(this.app, el2),
        this.nameOf()
      );
      externalLinks(out);
    }
  }
  async deleteActive() {
    const node = this.active && this.byId.get(this.active);
    if (!node || this.refuseWhileArriving() || this.refuseInPrintView()) return;
    if (this.editing) await this.endEdit();
    const doomed = [node, ...core.descendants(node)];
    const files = [];
    for (const n of doomed) {
      const f = this.cardFile(n.id);
      if (f) files.push({
        path: f.path,
        data: await this.app.vault.read(f)
      });
    }
    this.snapshot(files);
    const sibs = node.parent.children;
    const i = sibs.indexOf(node);
    const next = sibs[i + 1] || sibs[i - 1] || (node.parent.id ? node.parent : null);
    core.remove(node);
    this.reindex();
    this.active = next ? next.id : null;
    if (!await this.writeIndex()) {
      this.undo.pop();
      return;
    }
    for (const n of doomed) {
      const f = this.cardFile(n.id);
      this.invalidate(n.id);
      if (f) await this.app.fileManager.trashFile(f);
    }
    await this.sweepStatuses();
    this.render();
    new Notice(`Dendrite: deleted ${doomed.length} card(s). Ctrl+Z in the view restores them.`);
  }
  // Leaving a card records its visit first, which is a new step and so
  // ends any redo; the histories are read only after that.
  async doUndo() {
    if (this.editing) await this.endEdit();
    await this.stepHistory(this.undo, this.redo, "undo");
  }
  async doRedo() {
    if (this.editing) await this.endEdit();
    await this.stepHistory(this.redo, this.undo, "redo");
  }
  /**
   * Take the latest step from one history and apply it, recording on
   * the other how to reverse what was done: undo feeds redo and redo
   * feeds undo. Only what was applied is recorded, so a card left alone
   * because it changed since is not touched by the reverse either.
   */
  async stepHistory(from, to, what) {
    const snap = from.pop();
    if (!snap) {
      new Notice(`Dendrite: nothing to ${what} on the board. A card's text is undone and redone inside the card.`);
      return;
    }
    const vault = this.app.vault;
    const bodyOf = (data) => core.splitFrontmatter(data).body;
    const inv = {
      active: this.active,
      files: [],
      created: [],
      restores: [],
      text: snap.text
    };
    if (snap.tree !== void 0) {
      inv.tree = core.serialiseTree(this.root);
    }
    for (const { path, data } of snap.files || []) {
      if (!vault.getAbstractFileByPath(path)) {
        await vault.create(path, data);
        inv.created.push({ path, body: bodyOf(data) });
      }
    }
    for (const entry of snap.created || []) {
      const path = typeof entry === "string" ? entry : entry.path;
      const expect = typeof entry === "string" ? "" : entry.body;
      const f = vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) continue;
      const data = await vault.read(f);
      const t = this.texts.get(f.basename);
      const typed = t && t.undo.length && t.undo[t.undo.length - 1].after.trim();
      const body = bodyOf(data).trim();
      if (body === expect.trim() || typed && body === typed) {
        this.invalidate(f.basename);
        await this.app.fileManager.trashFile(f);
        inv.files.push({ path, data });
      }
    }
    for (const r of snap.restores || []) {
      const f = vault.getAbstractFileByPath(r.path);
      if (!(f instanceof TFile)) continue;
      const data = await vault.read(f);
      if (bodyOf(data).trim() !== r.ifBody.trim()) {
        if (snap.text) {
          new Notice(`Dendrite: the card changed since, so its text was not ${what === "undo" ? "undone" : "redone"}.`);
        }
        continue;
      }
      const next = await this.writeCard(f, (d) => r.text !== void 0 ? r.text : core.splitFrontmatter(d).fm + r.body);
      inv.restores.push({
        path: r.path,
        text: data,
        ifBody: bodyOf(next)
      });
      this.invalidate(f.basename);
    }
    if (snap.index) {
      const data = await vault.read(this.file);
      if (data === snap.index.ifText) {
        this.selfWrites.add(snap.index.text);
        await vault.process(this.file, () => snap.index.text);
        inv.index = { text: data, ifText: snap.index.text };
        this.indexText = data;
        this.checkDropped(snap.index.text);
        this.loadText(snap.index.text);
      } else {
        new Notice(`Dendrite: the index changed since, so it was not ${what === "undo" ? "undone" : "redone"}.`);
      }
    }
    if (snap.tree !== void 0) {
      this.root = core.parseIndex(snap.tree + "\n").root;
      this.reindex();
    }
    if (this.byId.has(snap.active)) this.active = snap.active;
    if (snap.tree !== void 0) await this.writeIndex();
    to.push(inv);
    if (to.length > UNDO_DEPTH) to.shift();
    this.render();
  }
  unlinkedCards() {
    const folder = this.app.vault.getAbstractFileByPath(
      this.cardsFolder()
    );
    if (!(folder instanceof TFolder)) return [];
    return folder.children.filter((f) => f instanceof TFile && f.extension === "md" && !this.byId.has(f.basename));
  }
  async adopt(files) {
    this.snapshot();
    for (const f of files) {
      const n = core.makeNode(f.basename, "", null);
      core.appendChild(this.root, n);
      const body = core.splitFrontmatter(
        await this.app.vault.cachedRead(f)
      ).body;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      n.label = core.deriveLabel(body, fm && fm.aliases);
    }
    this.reindex();
    await this.writeIndex();
    this.render();
  }
  // ---- changes from outside the view -----------------------------------
  async onModify(f) {
    if (!(f instanceof TFile) || !this.file) return;
    this.scheduleChanged();
    if (f === this.file) {
      const text2 = await this.app.vault.cachedRead(f);
      if (this.selfWrites.delete(text2)) {
        this.indexText = text2;
        await this.checkVersion(null, text2, true);
        return;
      }
      if (this.renaming) return;
      if (indexPrefix(text2) !== this.loadedPrefix) {
        if (this.editing) await this.endEdit();
        this.dropped.clear();
        this.dropBase = null;
        this.indexText = text2;
        this.flagIndex();
        new Notice(`Dendrite: ${this.file.basename} was renamed on another device, to the prefix ${indexPrefix(text2)}. The board follows it as its cards arrive.`, 1e4);
      } else {
        this.checkDropped(text2);
      }
      await this.checkVersion(null, text2, false);
      if (this.root && core.writeIndexText(text2, this.root) === text2) {
        this.indexList = core.serialiseTree(this.root);
        return;
      }
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => this.reload(), 300);
      return;
    }
    const id = f.basename;
    if (!this.byId.has(id)) return;
    const text = await this.app.vault.cachedRead(f);
    const body = core.splitFrontmatter(text).body;
    const own = this.ownBodies.get(f.path) === body;
    if (own) this.ownBodies.delete(f.path);
    await this.checkVersion(id, text, own);
    if (this.find) this.scheduleFind(true);
    if (this.editing && this.editing.id === id) {
      if (!own) await this.syncedWhileEditing(this.editing, text);
      return;
    }
    this.invalidate(id);
    const card = this.cardEls.get(id);
    if (card && card.hasClass("is-slot")) {
      if (this.heights) this.heights.delete(id);
      card.style.height = `${this.slotHeight(id)}px`;
    } else if (card) {
      card.addClass("is-pending");
      this.renderCard(id);
    }
  }
  /**
   * A sync changed the note of the card being edited. With no unsaved
   * typing the editor opens again on the new text, so a later save
   * cannot write the old text back over it. With unsaved typing nothing
   * is saved: the editor closes on the note as it came, and the card is
   * marked with the typing to put back.
   */
  async syncedWhileEditing(ed, text) {
    const { fm, body } = core.splitFrontmatter(text);
    if (ed.editor.value === body) return;
    clearTimeout(ed.timer);
    if (ed.changed) this.recordVisit(ed.id, ed.before, ed.saved);
    ed.recorded = true;
    if (ed.dirty) {
      ed.dirty = false;
      this.held.set(ed.id, fm + ed.editor.value);
      await this.endEdit();
      this.reverted.add(ed.id);
      this.revertedAt.set(ed.id, Date.now());
      const node = this.byId.get(ed.id);
      stickyNotice(
        `card:${this.file.path}:${ed.id}`,
        `Dendrite: Card ${core.shortId(ed.id)}` + (node && node.label ? ` (${node.label})` : "") + ' changed outside Dendrite while you were typing in it, usually from a sync. Your typing was not saved over it. Click "typing kept" on the card to compare and choose.'
      );
      this.updateStatuses();
      return;
    }
    const at = Math.min(ed.editor.selection()[0], body.length);
    await this.endEdit();
    await this.startEdit(ed.id);
    if (this.editing && this.editing.id === ed.id) {
      this.editing.editor.focusAt(at);
    }
  }
  async onMetadata(f) {
    if (!(f instanceof TFile) || this.renaming) return;
    if (f !== this.file && this.loadedPrefix && isIndex(this.app, f) && prefixOf(this.app, f) !== this.loadedPrefix && formersOf(this.app, f).includes(this.loadedPrefix)) {
      await this.follow(f);
      return;
    }
    if (f === this.file) {
      this.checkArriving();
      const was = review.colourList(this.reviewers());
      this.reviewerMap = null;
      if (review.colourList(this.reviewers()).join("\n") !== was.join("\n")) {
        this.recolour();
      }
      this.updateNumbers();
      this.updateCounts();
      return;
    }
    if (!this.byId.has(f.basename)) return;
    this.scheduleCardMeta();
    if (this.editing && this.editing.id === f.basename) return;
    const body = core.splitFrontmatter(
      await this.app.vault.cachedRead(f)
    ).body;
    this.noteLabel(f.basename, body);
  }
  /**
   * Numbers, roles, statuses and counts brought up to date once, after
   * the cards' notes changed: each is worked out over the whole
   * manuscript, and Obsidian indexing the 2,900 notes of the deep test
   * manuscript ran them about 180 times in 10 s, 2 to 3 s of work.
   */
  scheduleCardMeta() {
    if (this.metaFrame) return;
    this.metaFrame = this.pageWin().requestAnimationFrame(() => {
      this.metaFrame = null;
      if (!this.board) return;
      this.updateNumbers();
      this.updateRoles();
      this.updateStatuses();
      this.scheduleCounts();
    });
  }
  // ---- versions going back ---------------------------------------------
  historyKey(id, path = this.file.path) {
    const vault = this.app.appId || this.app.vault.getName && this.app.vault.getName() || "vault";
    return `${vault}/${id === null ? "index:" + path : id}`;
  }
  /**
   * Record a note's text in this device's history and notice when a
   * text from outside matches an earlier version: a sync putting back
   * an old copy. A card is compared by its body, the index whole.
   */
  async checkVersion(id, text, own) {
    const compared = id === null ? text : core.splitFrontmatter(text).body;
    const f = id === null ? this.file : this.cardFile(id);
    const active = this.app.workspace.activeEditor;
    const here = own || !!(active && f && active.file === f);
    let r;
    try {
      r = await this.history.observe(
        this.historyKey(id),
        text,
        compared,
        !here
      );
    } catch (err) {
      console.error("Dendrite: version history failed", err);
      return;
    }
    const key = id === null ? "index" : id;
    if (id === null) this.indexReverted = r === "reverted";
    const on = r === "reverted" || this.held.has(id) || id === null && this.dropped.size > 0;
    if (r === "reverted" && !this.versionInfo.has(key)) {
      try {
        const d = await this.history.detail(this.historyKey(id));
        if (d) this.versionInfo.set(key, d);
      } catch (err) {
        console.error("Dendrite: version history failed", err);
      }
    } else if (r !== "reverted") {
      this.versionInfo.delete(key);
    }
    if (on === this.reverted.has(key)) return;
    if (!on) {
      this.reverted.delete(key);
    } else if (r !== "reverted") {
      this.reverted.add(key);
      this.revertedAt.set(key, Date.now());
    } else {
      this.reverted.add(key);
      this.revertedAt.set(key, Date.now());
      const node = id && this.byId.get(id);
      const name = id === null ? "The index" : `Card ${core.shortId(id)}` + (node && node.label ? ` (${node.label})` : "");
      stickyNotice(
        `card:${this.file.path}:${key}`,
        `Dendrite: ${name} changed outside Dendrite to text this device had before, usually an old copy from a sync. Nothing was written. Click "older copy" on ${id === null ? "the bar" : "the card"} to compare and choose.`
      );
    }
    this.updateStatuses();
  }
  /**
   * An index from outside that leaves out cards whose notes still
   * exist. Deleting a card on a board deletes its note, so this is a
   * sync merging or putting back an old copy, which this device may
   * never have seen and so cannot match in its history. Held as the
   * index going back, with the text before it to restore, until the
   * cards are listed again or their notes deleted.
   */
  checkDropped(text) {
    const active = this.app.workspace.activeEditor;
    const here = !!(active && active.file === this.file);
    const base = this.dropBase || this.indexText;
    const ids = (t) => core.allNodes(core.parseIndex(
      core.splitFrontmatter(t).body
    ).root);
    const listed = new Set(ids(text).map((n) => n.id));
    const gone = here || !base ? [] : ids(base).filter((n) => !listed.has(n.id) && this.cardFile(n.id));
    const was = this.dropped.size;
    this.dropped = new Map(gone.map((n) => [n.id, n.label]));
    if (gone.length) {
      this.dropBase = base;
    } else {
      this.dropBase = null;
      this.indexText = text;
    }
    if (gone.length && !was) {
      this.revertedAt.set("index", Date.now());
      const names = gone.slice(0, 5).map((n) => core.shortId(n.id) + (n.label ? ` (${n.label})` : "")).join(", ");
      const more = gone.length > 5 ? `, and ${gone.length - 5} more` : "";
      stickyNotice(
        `gone:${this.file.path}`,
        `Dendrite: the index changed outside Dendrite and no longer lists ${gone.length} card${gone.length === 1 ? "" : "s"} whose notes still exist: ${names}${more}. This is probably a sync of an old copy. Nothing was written. Click "older copy" on the bar to compare and choose.`
      );
    }
    this.flagIndex();
  }
  /** Show the index as gone back while either check says so. */
  flagIndex() {
    const on = this.indexReverted || this.dropped.size > 0;
    if (on === this.reverted.has("index")) return;
    if (on) this.reverted.add("index");
    else this.reverted.delete("index");
    this.updateStatuses();
  }
  /** Every note's version, on opening: a sync may have run meanwhile. */
  async checkVersions() {
    if (!this.file) return;
    await this.checkVersion(
      null,
      await this.app.vault.cachedRead(this.file),
      false
    );
    for (const n of core.allNodes(this.root)) {
      const f = this.cardFile(n.id);
      if (!f) continue;
      await this.checkVersion(
        n.id,
        await this.app.vault.cachedRead(f),
        false
      );
    }
  }
  /** What happened to a note marked as gone back, and the choices. */
  reviewVersion(id) {
    new VersionModal(this, id).open();
  }
  /**
   * The text a note marked as gone back held before: the index as this
   * board last saw it, or the newest version this device recorded.
   */
  async newerText(id) {
    if (id === null && this.dropBase) return this.dropBase;
    if (this.held.has(id)) return this.held.get(id);
    const info = this.versionInfo.get(id === null ? "index" : id);
    if (info) return info.text;
    const text = await this.history.newer(this.historyKey(id));
    return text === void 0 ? null : text;
  }
  /** Put back the text a note held before it was marked. */
  async restoreNewer(id) {
    const f = id === null ? this.file : this.cardFile(id);
    const text = f && await this.newerText(id);
    if (text === null || text === void 0) {
      new Notice("Dendrite: no newer version is recorded here.");
      return;
    }
    const now = await this.app.vault.read(f);
    if (id === null) {
      this.dropBase = null;
      this.dropped.clear();
      this.selfWrites.add(text);
      await this.app.vault.process(f, () => text);
      this.pushUndo({
        active: this.active,
        files: [],
        text: true,
        index: { text: now, ifText: text }
      });
      await this.checkVersion(null, text, true);
      await this.reload();
      return;
    }
    if (this.editing && this.editing.id === id) await this.endEdit();
    this.held.delete(id);
    await this.writeCard(f, () => text);
    this.pushUndo({
      active: id,
      files: [],
      text: true,
      restores: [{
        path: f.path,
        text: now,
        ifBody: core.splitFrontmatter(text).body
      }]
    });
    await this.checkVersion(id, text, true);
    this.invalidate(id);
    await this.renderCard(id);
  }
  async keepVersion(id) {
    const f = id === null ? this.file : this.cardFile(id);
    if (!f) return;
    const text = await this.app.vault.read(f);
    await this.history.keep(
      this.historyKey(id),
      text,
      id === null ? text : core.splitFrontmatter(text).body
    );
    if (id === null) {
      this.dropBase = null;
      this.dropped.clear();
      this.indexText = text;
      this.indexReverted = false;
    }
    this.held.delete(id);
    this.versionInfo.delete(id === null ? "index" : id);
    this.reverted.delete(id === null ? "index" : id);
    this.updateStatuses();
  }
  onRenameCard(f, oldPath) {
    const old = oldPath.split("/").pop().replace(/\.md$/, "");
    const node = this.byId.get(old);
    if (!node || f.basename === old) return;
    this.byId.delete(old);
    node.id = f.basename;
    this.byId.set(node.id, node);
    if (this.active === old) this.active = node.id;
    this.invalidate(old);
  }
  // ---- renaming the manuscript ------------------------------------------
  /** The prefixes this manuscript had before, from its index. */
  formers() {
    return this.file ? formersOf(this.app, this.file) : [];
  }
  /**
   * The index's new path, and its folder's when the folder has the
   * index's name, as a manuscript made here does.
   */
  renameTargets(name) {
    const dir = this.file.parent ? this.file.parent.path : "/";
    const top = !dir || dir === "/";
    const parts = top ? [] : dir.split("/");
    const moveFolder = !top && parts[parts.length - 1] === this.file.basename && name !== this.file.basename;
    const newDir = moveFolder ? normalizePath([...parts.slice(0, -1), name].join("/")) : dir;
    return {
      dir,
      newDir,
      moveFolder,
      index: normalizePath((top ? "" : dir + "/") + name + ".md")
    };
  }
  /** Why the manuscript cannot be renamed so, or null. */
  renameProblem(title, prefix) {
    const name = safeName(title);
    if (!name) return "give the manuscript a title.";
    if (!core.validPrefix(prefix)) {
      return "a prefix is letters, digits and single hyphens.";
    }
    const now = this.prefix();
    if (prefix !== now && prefix.toLowerCase() === now.toLowerCase()) {
      return "a prefix that differs only in capitals is not supported, since some systems treat the file names as the same.";
    }
    const mine = [now, ...this.formers()].map((p) => p.toLowerCase());
    if (!mine.includes(prefix.toLowerCase()) && prefixesInUse(this.app, this.file).has(prefix.toLowerCase())) {
      return `the prefix ${prefix} is already used by another manuscript.`;
    }
    if (this.reverted.size || this.oldCopies.length) {
      return "something on the board is marked as an older or old copy. Compare and choose first.";
    }
    const t = this.renameTargets(name);
    if (name !== this.file.basename && this.app.vault.getAbstractFileByPath(t.index)) {
      return `${t.index} already exists.`;
    }
    if (t.moveFolder && this.app.vault.getAbstractFileByPath(t.newDir)) {
      return `${t.newDir} already exists.`;
    }
    if (name === this.file.basename && prefix === now && !this.renamePlan(prefix).moves.length) {
      return "that is already its title and prefix.";
    }
    return null;
  }
  /**
   * Each card note to rename to `prefix`: its note under this or an
   * earlier prefix, where the note under the new name is not there
   * yet. A card with notes under both names is a clash.
   */
  renamePlan(prefix) {
    const from = [this.prefix(), ...this.formers()].filter((p) => p !== prefix);
    const to = (id) => from.reduce((x, p) => core.withPrefix(x, p, prefix), id);
    const moves = [];
    const clashes = [];
    for (const n of core.allNodes(this.root)) {
      const id = to(n.id);
      const have = /* @__PURE__ */ new Set();
      for (const old of [n.id, ...from.map((p) => `${p}-${core.shortId(id)}`)]) {
        const f = old !== id && this.cardFile(old);
        if (f) have.add(f);
      }
      if (!have.size) continue;
      if (have.size > 1 || this.cardFile(id)) clashes.push(id);
      else moves.push({ file: [...have][0], id });
    }
    return { from, to, moves, clashes };
  }
  /**
   * Rename the manuscript: every card note to the new prefix, the
   * index's list and prefix, the index note, and its folder when the
   * folder has the index's name. The old prefix is recorded on the
   * index first, as dendrite_former_prefixes, so a board on another
   * device follows the rename as a sync brings it and tells an old
   * copy that comes back later from a card. Run again with the same
   * title and prefix, it finishes a rename cut short.
   */
  async renameManuscript(title, prefix) {
    const problem = this.renameProblem(title, prefix);
    if (problem) {
      new Notice("Dendrite: not renamed: " + problem, 1e4);
      return false;
    }
    if (this.editing) await this.endEdit();
    await this.flush();
    const name = safeName(title);
    const plan = this.renamePlan(prefix);
    if (plan.clashes.length) {
      stickyNotice(
        `rename:${this.file.path}`,
        "Dendrite: not renamed: these cards have a note under both the old and the new name: " + plan.clashes.join(", ") + ". Keep one of each first."
      );
      return false;
    }
    const target = this.renameTargets(name);
    const old = this.prefix();
    const indexKey = this.historyKey(null);
    const roundsWas = this.roundsPath();
    const fm = this.app.fileManager;
    this.renaming = true;
    let failed = null;
    try {
      const formers = [.../* @__PURE__ */ new Set([...this.formers(), old])].filter((p) => p !== prefix);
      await writeProps(this.app, this.file, {
        dendrite_former_prefixes: formers.length ? formers : null
      });
      for (const m of plan.moves) {
        await fm.renameFile(m.file, normalizePath(
          `${m.file.parent.path}/${m.id}.md`
        ));
      }
      for (const n of core.allNodes(this.root)) n.id = plan.to(n.id);
      this.reindex();
      if (this.active) this.active = plan.to(this.active);
      await this.app.vault.process(
        this.file,
        (data) => core.writeIndexText(data, this.root)
      );
      await writeProps(
        this.app,
        this.file,
        { dendrite_prefix: prefix }
      );
      await this.renameRounds(roundsWas, plan.to);
      for (const n of core.allNodes(this.root)) {
        for (const p of plan.from) {
          await this.history.adopt(
            this.historyKey(n.id),
            this.historyKey(`${p}-${core.shortId(n.id)}`)
          );
        }
      }
      if (name !== this.file.basename) {
        await fm.renameFile(this.file, target.index);
        const rounds = this.app.vault.getAbstractFileByPath(
          roundsWas
        );
        if (rounds instanceof TFile && !this.app.vault.getAbstractFileByPath(
          this.roundsPath()
        )) {
          await fm.renameFile(rounds, this.roundsPath());
        }
      }
      if (target.moveFolder) {
        await fm.renameFile(
          this.app.vault.getAbstractFileByPath(target.dir),
          target.newDir
        );
        await fm.processFrontMatter(this.file, (props) => {
          for (const k of PATH_PROPS) {
            const v = props[k];
            if (typeof v === "string" && v.startsWith(target.dir + "/")) {
              props[k] = target.newDir + v.slice(target.dir.length);
            }
          }
        });
      }
      await this.history.adopt(this.historyKey(null), indexKey);
    } catch (err) {
      console.error("Dendrite: rename failed", err);
      failed = err;
    } finally {
      this.renaming = false;
      this.undo = [];
      this.redo = [];
      this.texts.clear();
      this.leaf.updateHeader();
      await this.reload();
    }
    if (failed) {
      stickyNotice(
        `rename:${this.file.path}`,
        "Dendrite: the rename stopped part way: " + failed.message + ". Rename again with the same title and prefix to finish it."
      );
      return false;
    }
    new Notice(`Dendrite: renamed to ${name}, cards ${prefix}-\u2026, ${plan.moves.length} card notes renamed.`, 1e4);
    return true;
  }
  /** Show `f`, the index this manuscript was renamed to. */
  async follow(f) {
    if (this.editing) await this.endEdit();
    const was = this.file ? this.file.basename : "";
    this.undo = [];
    this.redo = [];
    this.texts.clear();
    this.reverted.clear();
    this.held.clear();
    this.versionInfo.clear();
    this.dropped.clear();
    this.dropBase = null;
    this.indexReverted = false;
    this.file = f;
    this.leaf.updateHeader();
    await this.reload();
    new Notice(`Dendrite: ${was} was renamed to ${f.basename} on another device; the board shows it under its new name.`, 1e4);
    if (this.app.workspace.requestSaveLayout) {
      this.app.workspace.requestSaveLayout();
    }
  }
  scheduleRenameChecks() {
    clearTimeout(this.renameTimer);
    this.renameTimer = setTimeout(() => this.checkArriving(), 200);
    this.scheduleOldCopies();
  }
  /**
   * Count the cards listed under the new prefix whose notes still
   * carry an earlier one: a rename from another device arriving.
   * While any are, the board changes nothing.
   */
  checkArriving(tell = true) {
    if (!this.file || this.renaming) return;
    const now = this.prefix();
    const formers = this.formers().filter((p) => p !== now);
    let n = 0;
    for (const node of formers.length ? core.allNodes(this.root) : []) {
      if (this.cardFile(node.id)) continue;
      const s = core.shortId(node.id);
      if (formers.some((p) => this.cardFile(`${p}-${s}`))) n++;
    }
    const was = this.arriving;
    this.arriving = n;
    if (n === was) return;
    if (n && this.editing) this.endEdit();
    if (!n && tell) {
      new Notice("Dendrite: the rename has arrived; every card is here under its new name.");
      this.render();
    }
    this.updateStatuses();
  }
  refuseWhileArriving() {
    if (!this.arriving || this.renaming) return false;
    new Notice(`Dendrite: ${this.arriving} card${this.arriving === 1 ? "" : "s"} renamed on another device ${this.arriving === 1 ? "has" : "have"} not arrived yet, so the board changes nothing until they do. If they never arrive, rename again from the settings with the same title and prefix.`, 1e4);
    return true;
  }
  scheduleOldCopies() {
    clearTimeout(this.copiesTimer);
    this.copiesTimer = setTimeout(() => this.checkOldCopies(), 5e3);
  }
  /**
   * Notes under a name this manuscript had before a rename: its index,
   * or a card whose note under the new name exists or which the index
   * no longer lists. A device that had not seen the rename brought
   * them back. They are reported, never used.
   */
  checkOldCopies() {
    if (!this.file || this.renaming) return;
    const now = this.prefix();
    const formers = this.formers().filter((p) => p !== now);
    const out = [];
    for (const f of formers.length ? this.app.vault.getMarkdownFiles() : []) {
      if (f === this.file) continue;
      const p = prefixOf(this.app, f);
      if (p && formers.includes(p)) {
        out.push({ file: f, id: null });
        continue;
      }
      const q = formers.find((x) => core.withPrefix(f.basename, x, now) !== f.basename);
      if (!q) continue;
      const id = core.withPrefix(f.basename, q, now);
      if (this.cardFile(id) || !this.byId.has(id)) {
        out.push({ file: f, id: this.byId.has(id) ? id : null });
      }
    }
    const before = new Set(this.oldCopies.map((c) => c.file.path));
    this.oldCopies = out;
    const fresh = out.filter((c) => !before.has(c.file.path));
    if (fresh.length) {
      const names = fresh.slice(0, 5).map((c) => c.file.basename).join(", ");
      const more = fresh.length > 5 ? `, and ${fresh.length - 5} more` : "";
      stickyNotice(
        `copies:${this.file.path}`,
        `Dendrite: ${fresh.length} note${fresh.length === 1 ? "" : "s"} under this manuscript's name before its rename came back, probably from a device that had not synced: ${names}${more}. They are not used. Click "old copies" on the bar to see them.`
      );
    }
    if (fresh.length || before.size !== out.length) {
      this.updateStatuses();
    }
  }
  // ---- manuscript settings, numbering and counts ------------------------
  /** The manuscript's settings, from its index note's properties. */
  manuscript() {
    const fm = this.file && this.app.metadataCache.getFileCache(this.file)?.frontmatter || {};
    const top = Number(fm.dendrite_heading_top);
    const wpp = core.wordsPerPage(fm);
    const cpw = Number(fm.dendrite_chars_per_word);
    return {
      prefix: this.prefix(),
      limit: core.parseLimit(fm.dendrite_limit),
      limitRequired: fm.dendrite_limit_required === true,
      charsPerWord: cpw > 0 ? cpw : 6,
      countSpaces: fm.dendrite_count_spaces !== false,
      wordsPerPage: wpp.value,
      wordsPerPageMeasured: wpp.measured,
      headingTop: top >= 1 && top <= 6 ? top : this.plugin.settings.headingTop,
      number: fm.dendrite_number_sections === true,
      csl: typeof fm.dendrite_csl === "string" && fm.dendrite_csl.trim() ? fm.dendrite_csl.trim() : null,
      style: exportStyle(fm)
    };
  }
  cardProps(id) {
    const f = this.cardFile(id);
    return f && this.app.metadataCache.getFileCache(f)?.frontmatter || {};
  }
  /** Whether a card's text opens with a heading, from Obsidian's cache. */
  hasHeading(id) {
    if (this.editing && this.editing.id === id) {
      return /^\s*#{1,6}\s/.test(this.editing.editor.value);
    }
    const f = this.cardFile(id);
    const sections = f && this.app.metadataCache.getFileCache(f)?.sections;
    const first = (sections || []).find((s) => s.type !== "yaml");
    return !!first && first.type === "heading";
  }
  numbers() {
    if (!this.manuscript().number) return /* @__PURE__ */ new Map();
    return core.sectionNumbers(
      this.root.children,
      (id) => this.hasHeading(id),
      (id) => this.printRoleOf(id),
      (id) => this.kindOf(id)
    );
  }
  /** Show each section card's number, updated in place. */
  updateNumbers() {
    this.nums = this.numbers();
    for (const [id, card] of this.liveCards()) this.numberCard(id, card);
  }
  /** A card's section number, from the last updateNumbers. */
  numberCard(id, card) {
    let badge = card.querySelector(":scope > .dendrite-num");
    const num = this.nums && this.nums.get(id);
    if (!num) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = createDiv({ cls: "dendrite-num" });
      card.prepend(badge);
    }
    badge.setText(num);
  }
  scheduleCounts() {
    clearTimeout(this.countTimer);
    this.countTimer = setTimeout(() => this.updateCounts(), 400);
  }
  /**
   * Count what each limited card's branch would export, and the whole
   * manuscript, and show them against their limits. Card text is read
   * only when some limit is set, so a manuscript without limits pays
   * nothing for this.
   */
  /** A card's role, if set: section, prose or notes. */
  roleOf(id) {
    return core.cardRole(this.cardProps(id));
  }
  /** A card's kind, if set: table or figure. */
  kindOf(id) {
    const k = this.cardProps(id).dendrite_kind;
    return core.KINDS.includes(k) ? k : null;
  }
  /** The role a card prints by, its kind applied. */
  printRoleOf(id) {
    return core.withKinds(
      (x) => this.roleOf(x),
      (x) => this.kindOf(x)
    )(id);
  }
  /** What export needs to number tables and figures. */
  floatOpts(heights = false) {
    const kindOf = (x) => this.kindOf(x);
    const opts = { kindOf, floats: core.floatLabels(
      this.root.children,
      (x) => this.printRoleOf(x),
      kindOf
    ) };
    if (heights) {
      opts.heightOf = (x) => core.parseAmount(this.cardProps(x).dendrite_height);
    }
    return opts;
  }
  /**
   * Set a card's kind; a card set to Table without one starts with a
   * table to fill in. One step to undo.
   */
  async setKind(id, kind) {
    const f = this.cardFile(id);
    if (!f) return;
    const data = await this.app.vault.read(f);
    await writeProps(this.app, f, { dendrite_kind: kind });
    let body = core.splitFrontmatter(data).body;
    if (kind === "table" && !float.split(body, "table").content) {
      body = float.compose("table", body, float.STARTER_TABLE);
      await this.writeCard(f, (d) => core.splitFrontmatter(d).fm + body);
    }
    this.pushUndo({
      active: this.active,
      files: [],
      created: [],
      restores: [{
        path: f.path,
        text: data,
        ifBody: body
      }],
      text: false
    });
    this.invalidate(id);
    await this.renderCard(id);
    await this.sweepStatuses();
  }
  async setRole(id, role) {
    const f = this.cardFile(id);
    if (f) await writeProps(this.app, f, { dendrite_role: role });
    await this.sweepStatuses();
  }
  // ---- card status ----------------------------------------------------
  /** A card's set status: draft, done, revise or unsplit. */
  statusOf(id) {
    const s = this.cardProps(id).dendrite_status;
    return core.STATUSES.includes(s) ? s : null;
  }
  /**
   * Write a status, draft included, so every printing card says what it
   * is without Dendrite; null removes it, from a card that does not
   * print.
   */
  /** A status from the keyboard, for a card whose text prints. */
  async setStatusByKey(status) {
    const node = this.byId.get(this.active);
    if (!node) return;
    if (core.roleFor(node, (x) => this.printRoleOf(x)) !== "prose") {
      new Notice("Dendrite: a structural card takes its status from the cards below it.");
      return;
    }
    await this.markStatus(this.active, status);
  }
  /**
   * Ask for a returned Word file, or a JSON list of review comments,
   * then show what it says and where in the cards, to choose which to
   * add.
   */
  importReview() {
    const input = this.pageDoc().createElement("input");
    input.type = "file";
    input.accept = ".docx,.json,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/json";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      await this.reviewFrom(file.name, await file.arrayBuffer());
    };
    input.click();
  }
  /** The Google Doc this manuscript is linked to, or null. */
  gdocUrl() {
    const fm = this.file && this.app.metadataCache.getFileCache(this.file)?.frontmatter;
    return fm && typeof fm.dendrite_gdoc === "string" ? fm.dendrite_gdoc : null;
  }
  /**
   * Bring in the linked Google Doc's open comments and suggested
   * changes through the review dialog, as from a returned Word file.
   */
  async pullGdoc() {
    const url = this.gdocUrl();
    if (!url) {
      new Notice("Dendrite: link a Google Doc in the manuscript's settings first.");
      return null;
    }
    let r;
    try {
      r = await this.plugin.gdocReview(url);
    } catch (err) {
      new Notice(`Dendrite: could not read the Google Doc (${err.message}).`, 1e4);
      return null;
    }
    if (!r) return null;
    if (!r.items.length) {
      new Notice(`Dendrite: ${r.title || "the doc"} has no open comments or suggested changes` + (r.resolved ? `; ${r.resolved} resolved left out.` : "."));
      return null;
    }
    return this.reviewModal(
      `${r.title || "Google Doc"} (Google Docs)`,
      r.items
    );
  }
  /**
   * Keys of the review comments and changes resolved, applied or
   * dismissed in this manuscript, kept on its index.
   */
  reviewDone() {
    const fm = this.file && this.app.metadataCache.getFileCache(this.file)?.frontmatter;
    const d = fm && fm.dendrite_review_done;
    return Array.isArray(d) ? d.map(String) : [];
  }
  /** Remember a comment or change as dealt with, by its keys. */
  async rememberDone(item) {
    if (!this.file) return;
    const keys = review.reviewKeys(item);
    await this.app.fileManager.processFrontMatter(this.file, (fm) => {
      const had = Array.isArray(fm.dendrite_review_done) ? fm.dendrite_review_done.map(String) : [];
      const all = [...had.filter((k) => !keys.includes(k)), ...keys];
      fm.dendrite_review_done = all.slice(-1e3);
    });
  }
  /** Every old version kept in a stack, with its whole text. */
  async oldVersionCards() {
    const bodies = await this.loadBodies();
    return core.allNodes(this.root).filter((n) => this.isSuperseded(n.id) && bodies.has(n.id)).map((n) => ({ id: n.id, text: bodies.get(n.id) }));
  }
  /** The end of a card's printed text, as where a comment goes. */
  endOf(id, cards) {
    const text = (cards.find((c) => c.id === id) || { text: "" }).text.trimEnd();
    return { id, start: text.length, end: text.length };
  }
  /**
   * Where review comments come in from: the linked Google Doc, a file,
   * and reviews programs sent that wait to be added.
   */
  reviewMenu(event) {
    const m = dendriteMenu(false);
    const linked = this.gdocUrl();
    if (linked) {
      m.addItem((i) => i.setTitle("Pull from Google Docs").onClick(() => this.pullGdoc()));
    }
    if (Platform.isDesktopApp) {
      if (linked) {
        m.addItem((i) => i.setTitle("Open the linked doc").onClick(() => openExternal(linked)));
      }
      m.addItem((i) => i.setTitle(linked ? "Change the linked doc\u2026" : "Link a Google Doc\u2026").onClick(() => this.plugin.linkGdoc(this.file)));
    }
    m.addSeparator();
    m.addItem((i) => i.setTitle("Import a Word or JSON file\u2026").onClick(() => this.importReview()));
    m.addItem((i) => i.setTitle("Reviewers\u2026").onClick(() => new ReviewersModal(this).open()));
    m.addItem((i) => i.setTitle("Mark as sent for review\u2026").onClick(() => new RoundModal(this).open()));
    if (this.inbox.length) {
      m.addSeparator();
      for (const entry of this.inbox) {
        m.addItem((i) => i.setTitle(`${entry.title}: ${entry.items.length} from ` + reviewAuthors(entry.items)).onClick(() => this.openInbox(entry)));
      }
    }
    if (event && m.showAtMouseEvent) m.showAtMouseEvent(event);
    return m;
  }
  openManuscriptSettings() {
    new ManuscriptModal(this).open();
  }
  /** Light the Preview button while this manuscript's preview is open. */
  showPreviewOn() {
    if (this.previewBtn && this.plugin.previewOpen) {
      this.previewBtn.toggleClass(
        "is-on",
        this.plugin.previewOpen(this.file)
      );
    }
  }
  /** Submitted reviews for this manuscript, waiting on the bar. */
  refreshInbox() {
    const q = this.plugin.reviewQueue ? this.plugin.reviewQueue() : [];
    const prefixes = [this.prefix(), ...this.formers()].filter(Boolean);
    const out = q.filter((r) => r.state === "pending" && prefixes.includes(r.manuscript));
    const key = (l) => l.map((r) => r.id).join(" ");
    const changed = key(out) !== key(this.inbox);
    this.inbox = out;
    this.showInboxBadge();
    if (changed) this.updateStatuses();
  }
  /** How many reviews wait to be added, on the Review button. */
  showInboxBadge() {
    const b = this.reviewBtn;
    if (!b) return;
    const old = b.querySelector(".dendrite-bar-badge");
    if (old) old.remove();
    const n = (this.inbox || []).length;
    if (!n) return;
    const badge = b.createSpan({
      cls: "dendrite-bar-badge",
      text: String(n)
    });
    badge.setAttr("aria-label", `${n} review${n === 1 ? "" : "s"} waiting to be added`);
  }
  /** Show a submitted review's comments to add, or ignore it. */
  async openInbox(entry) {
    return this.reviewModal(entry.title, entry.items, entry);
  }
  /** A submitted review added or ignored: not offered again. */
  async takeInbox(entry, state) {
    if (this.plugin.settleReview) {
      await this.plugin.settleReview(entry.id, state);
    }
    this.refreshInbox();
  }
  /** Show the review in a file, `data` its bytes, to choose from. */
  async reviewFrom(name, data) {
    const buf = require("buffer").Buffer.from(data);
    const json = /\.json$/i.test(name);
    let items;
    try {
      items = json ? review.readReviewJson(buf.toString("utf8")) : review.readReview(buf, require("zlib"));
    } catch (err) {
      new Notice(`Dendrite: ${name} could not be read as ${json ? "a review list" : "a Word file"} (${err.message}).`);
      return null;
    }
    if (!items.length) {
      new Notice(`Dendrite: ${name} has no comments${json ? "" : " or tracked changes"}.`);
      return null;
    }
    return this.reviewModal(name, items);
  }
  /**
   * Show review items, each with where in the cards it was found, to
   * choose which to add; `inbox`, the submitted review they came from.
   */
  async reviewModal(name, items, inbox = null) {
    const cards = await this.reviewCards();
    const old = await this.oldVersionCards();
    const doneKeys = new Set(this.reviewDone());
    const bodies = /* @__PURE__ */ new Map();
    const body = async (id) => {
      if (!bodies.has(id)) {
        const f = this.cardFile(id);
        bodies.set(id, f ? core.splitFrontmatter(
          await this.app.vault.read(f)
        ).body : "");
      }
      return bodies.get(id);
    };
    const rows = [];
    const aligned = /* @__PURE__ */ new Map();
    for (const item of items) {
      const at = this.placeReview(item, cards, old, aligned);
      let dup = false;
      if (at) {
        const texts = [await body(at.id)];
        for (const v of this.stackOf(at.id)) {
          texts.push(await body(v.id));
        }
        dup = review.alreadyIn(texts.join("\n\n"), item);
      }
      const done = !dup && review.reviewKeys(item).some((k) => doneKeys.has(k));
      let relink = null;
      if (dup && at && item.link) {
        for (const cid of [at.id, ...this.stackOf(at.id).map((v) => v.id)]) {
          if (review.needsLink(await body(cid), item)) {
            relink = cid;
            break;
          }
        }
      }
      rows.push({
        item,
        at,
        dup,
        done,
        relink: !!relink,
        relinkId: relink,
        use: !!at && !dup && !done
      });
    }
    const modal = new ReviewImportModal(this, name, rows, inbox);
    modal.open();
    return modal;
  }
  /**
   * Where a review item goes, `cards` the cards as they print and `old`
   * their earlier versions, `aligned` keeping each pair of versions
   * lined up once: { id, start, end, how }, or null. As it was sent to
   * a current card, 'exact'. Else as it was sent to an earlier version,
   * carried to the card that replaced it where its text is still there
   * (review.mapThrough), 'mapped': a change is not put on a version
   * that does not print. Else found by most of its words, 'close'. Else
   * in an earlier version only, at the end of the card that replaced
   * it, its passage to be quoted, 'old'.
   */
  placeReview(item, cards, old, aligned = /* @__PURE__ */ new Map()) {
    const at = review.locate(item, cards);
    if (at && at.how === "exact") return at;
    const o = review.locate(item, old);
    const top = o && this.byId.get(o.id) && this.byId.get(o.id).parent;
    if (o && o.how === "exact" && top && top.id) {
      const was = old.find((c) => c.id === o.id);
      const now = cards.find((c) => c.id === top.id);
      if (was && now) {
        const key = `${o.id}\0${top.id}`;
        if (!aligned.has(key)) {
          aligned.set(key, review.alignWords(was.text, now.text));
        }
        const m = review.mapThrough(
          aligned.get(key),
          was.text,
          now.text,
          o.start,
          o.end
        );
        if (m) {
          return {
            id: top.id,
            start: m.start,
            end: m.end,
            how: "mapped",
            from: o.id
          };
        }
      }
    }
    if (at) return at;
    if (top && top.id) {
      return Object.assign(
        this.endOf(top.id, cards),
        { how: "old", from: o.id }
      );
    }
    return null;
  }
  /**
   * Every card's text, in reading order, for finding passages in: only
   * what export prints, since that is what a reviewer was sent; the
   * rest blanked, so offsets still point into the card.
   */
  async reviewCards() {
    await this.flush();
    const bodies = await this.loadBodies();
    const roleOf = (x) => this.printRoleOf(x);
    return core.allNodes(this.root).filter((n) => bodies.has(n.id)).map((n) => ({ id: n.id, text: core.printedOnly(
      bodies.get(n.id),
      core.roleFor(n, roleOf)
    ) }));
  }
  /**
   * Write the chosen comments and changes into their cards, each card
   * found again in its text as it is now; one step to undo. The cards
   * show revise while the comments are open. A change goes in as one to
   * apply only where its passage is still exactly as it was sent.
   */
  async addReview(rows, fallback, relinks = []) {
    const cards = await this.reviewCards();
    const old = await this.oldVersionCards();
    const aligned = /* @__PURE__ */ new Map();
    const byId = /* @__PURE__ */ new Map();
    let placed = 0;
    let missed = 0;
    for (const row of rows) {
      const item = row.item;
      let at = this.placeReview(item, cards, old, aligned);
      let add;
      if (!at && !row.at && fallback) {
        at = Object.assign(
          this.endOf(fallback.id, cards),
          { how: "none" }
        );
      }
      if (!at) {
        missed++;
        continue;
      }
      const quoted = !item.quote ? "" : at.how === "none" ? `On \u201C${item.quote}\u201D: ` : at.how === "old" ? `On \u201C${item.quote}\u201D, in an earlier version: ` : "";
      if (item.kind === "comment") {
        add = { kind: "review", text: quoted + item.text + (item.link ? ` ${item.link}` : "") };
      } else if (at.how === "exact" || at.how === "mapped" || !item.quote && at.how === "close") {
        add = {
          kind: "suggest",
          text: item.insert,
          quote: item.quote
        };
      } else {
        add = {
          kind: "review",
          text: quoted + review.changeAsComment(item)
        };
      }
      Object.assign(add, {
        start: at.how === "none" || at.how === "old" ? at.end : at.start,
        end: at.end,
        author: item.author,
        date: item.date
      });
      if (!byId.has(at.id)) byId.set(at.id, []);
      byId.get(at.id).push(add);
      placed++;
    }
    const restores = [];
    const linked = /* @__PURE__ */ new Map();
    for (const row of relinks) {
      if (!linked.has(row.relinkId)) linked.set(row.relinkId, []);
      linked.get(row.relinkId).push(row.item);
    }
    for (const [id, items] of linked) {
      if (byId.has(id)) continue;
      const f = this.cardFile(id);
      if (!f) continue;
      const data = await this.app.vault.read(f);
      const out = await this.writeCard(f, (d) => {
        const { fm, body } = core.splitFrontmatter(d);
        return fm + items.reduce(
          (md, it) => review.addLink(md, it),
          body
        );
      });
      restores.push({
        path: f.path,
        text: data,
        ifBody: core.splitFrontmatter(out).body
      });
      this.invalidate(id);
      if (this.cardEls.has(id)) await this.renderCard(id);
    }
    for (const [id, adds] of byId) {
      const f = this.cardFile(id);
      if (!f) continue;
      const data = await this.app.vault.read(f);
      const relinked = linked.get(id) || [];
      const out = await this.writeCard(f, (d) => {
        const { fm, body } = core.splitFrontmatter(d);
        return fm + relinked.reduce((md, it) => review.addLink(md, it), review.addItems(body, adds));
      });
      restores.push({
        path: f.path,
        text: data,
        ifBody: core.splitFrontmatter(out).body
      });
      this.invalidate(id);
      await this.renderCard(id);
    }
    if (restores.length) {
      this.pushUndo({
        active: this.active,
        files: [],
        text: true,
        restores
      });
    }
    const n = restores.length;
    new Notice(`Dendrite: ${placed} added to ${n} card${n === 1 ? "" : "s"}` + (missed ? `; ${missed} no longer found, left out.` : "."));
  }
  /**
   * A review comment's button: resolve or dismiss takes the comment
   * out and leaves the passage; apply shows the card with the change
   * first. One step to undo either way.
   */
  /** A review comment's right-click menu, Delete from Dendrite in it. */
  commentMenu(id, n, event, reply = null) {
    const f = this.cardFile(id);
    if (!f) return;
    this.app.vault.cachedRead(f).then((data) => {
      const it = review.reviewItems(core.splitFrontmatter(data).body)[n];
      if (!it) return;
      if (reply !== null && reply !== void 0) {
        showCommentMenu(
          [["unreply", "Delete reply", true]],
          event,
          () => this.reviewAction(id, n, "unreply", reply)
        );
        return;
      }
      const who = it.author || "Reviewer";
      showCommentMenu(
        review.commentMenu(it),
        event,
        (what) => this.reviewAction(id, n, what),
        {
          author: this.nameOf()(who),
          current: this.colourOf()(who),
          pick: (c) => this.setReviewerColour(who, c)
        }
      );
    });
  }
  // ---- a colour per reviewer -------------------------------------------
  /** The manuscript's reviewer colours, as kept in its index. */
  reviewers() {
    if (!this.reviewerMap) {
      const fm = this.file && this.app.metadataCache.getFileCache(this.file)?.frontmatter || {};
      this.reviewerMap = review.reviewerColours(
        fm.dendrite_reviewer_colours
      );
    }
    return this.reviewerMap;
  }
  /**
   * The names your replies are signed with: the name set, and Me, the
   * name a reply is signed with when none is, as earlier ones were.
   */
  selfNames() {
    return /* @__PURE__ */ new Set([this.plugin.settings.replyName || "Me", "Me"]);
  }
  colourOf() {
    const map = this.reviewers();
    const me = this.plugin.settings.replyName || "Me";
    const mine = this.selfNames();
    return (who) => mine.has(who) && map.has(me) ? map.get(me) : map.get(who) || null;
  }
  /**
   * Your names other than the one you sign with now: Me, once you sign
   * with your name, which is given no colour of its own.
   */
  otherSelves() {
    const me = this.plugin.settings.replyName || "Me";
    return [...this.selfNames()].filter((x) => x !== me);
  }
  /** A reviewer name as the person it is linked to, or as it is. */
  nameOf() {
    const fm = this.file && this.app.metadataCache.getFileCache(this.file)?.frontmatter;
    const names = review.reviewerNames(
      fm && fm.dendrite_reviewer_colours
    );
    const mine = this.selfNames();
    const shown = this.plugin.settings.presentName;
    return (who) => shown && mine.has(who) ? shown : names.get(who) || who;
  }
  /**
   * The reviewers of a card's comments, noted as it is drawn; one not
   * yet given a colour is given one, once the cards drawn now are.
   */
  noteReviewers(id, notes) {
    this.reviewersOf = this.reviewersOf || /* @__PURE__ */ new Map();
    const names = [...new Set(notes.flatMap((x) => [
      x.author || "Reviewer",
      ...(x.replies || []).map((r) => r.author || "Me")
    ]))];
    this.reviewersOf.set(id, names);
    const map = this.reviewers();
    if (names.some((x) => !map.has(x)) && !this.colourTimer) {
      this.colourTimer = this.pageWin().setTimeout(() => {
        this.colourTimer = null;
        this.assignReviewers();
      }, 0);
    }
  }
  /**
   * Colours for the reviewers not yet given one, in reading order, so
   * the first to comment in the manuscript is given the first colour;
   * written to the index, and their comments drawn again in them.
   */
  async assignReviewers() {
    const names = [];
    for (const n of core.allNodes(this.root)) {
      names.push(...(this.reviewersOf || /* @__PURE__ */ new Map()).get(n.id) || []);
    }
    const others = this.otherSelves();
    const { map, added } = review.assignColours(
      this.reviewers(),
      names.filter((x) => !others.includes(x))
    );
    if (added) await this.saveReviewers(map);
  }
  /** Reviewers [{ name, note, colour }] kept, as the dialog sets them. */
  async saveEntries(entries) {
    if (!this.file) return;
    this.reviewerMap = new Map(entries.map((e) => [e.name, e.colour]));
    await writeProps(
      this.app,
      this.file,
      { dendrite_reviewer_colours: review.entryList(entries) }
    );
    this.recolour();
  }
  /** A reviewer's colour, and so every name linked to their note. */
  async setReviewerColour(who, colour) {
    const fm = this.app.metadataCache.getFileCache(this.file)?.frontmatter || {};
    const kept = review.reviewerEntries(fm.dendrite_reviewer_colours);
    const note = (kept.find((e) => e.name === who) || {}).note;
    const map = new Map(this.reviewers());
    map.set(who, colour);
    for (const e of kept) {
      if (note && e.note === note) map.set(e.name, colour);
    }
    await this.saveReviewers(map);
  }
  async saveReviewers(map) {
    if (!this.file) return;
    const fm = this.app.metadataCache.getFileCache(this.file)?.frontmatter || {};
    const list = review.colourList(map, fm.dendrite_reviewer_colours);
    this.reviewerMap = map;
    await writeProps(
      this.app,
      this.file,
      { dendrite_reviewer_colours: list }
    );
    this.recolour();
  }
  /** The cards with comments drawn again in their reviewers' colours. */
  recolour() {
    for (const [id, names] of this.reviewersOf || /* @__PURE__ */ new Map()) {
      if (!names.length) continue;
      this.invalidate(id);
      const card = this.cardEls.get(id);
      if (card && !card.hasClass("is-slot")) this.renderCard(id);
    }
  }
  /**
   * Take a Google comment, known by `gid` ('g:' and its id), out of
   * every card it is on, old versions too, its passages left as they
   * were; one step to undo.
   */
  async resolveEverywhere(gid) {
    const restores = [];
    for (const node of core.allNodes(this.root)) {
      const f = this.cardFile(node.id);
      if (!f) continue;
      const data = await this.app.vault.read(f);
      const { body } = core.splitFrontmatter(data);
      const hits = review.reviewItems(body).map((x, k) => review.reviewKeys(x).includes(gid) ? k : -1).filter((k) => k >= 0);
      if (!hits.length) continue;
      let next = body;
      for (const k of hits.reverse()) next = review.removeItem(next, k);
      const out = await this.writeCard(f, (d) => core.splitFrontmatter(d).fm + next);
      restores.push({
        path: f.path,
        text: data,
        ifBody: core.splitFrontmatter(out).body
      });
      this.invalidate(node.id);
      if (this.cardEls.has(node.id)) await this.renderCard(node.id);
    }
    if (restores.length) {
      this.pushUndo({
        active: this.active,
        files: [],
        text: true,
        restores
      });
    }
    if (this.fannedId) {
      this.render();
      await this.fanReady;
    }
  }
  /**
   * A comment of the writer's own, `said`, on the passage selected in
   * the card being typed in, signed with their reply name; false when
   * nothing is selected. A change to the text, in the editor's history.
   */
  commentOnSelection(said, range = null) {
    const ed = this.editing;
    if (!ed || !ed.editor.update || !String(said || "").trim()) {
      return false;
    }
    const [a, b] = range || ed.editor.selection();
    if (a === b) return false;
    const body = ed.editor.value;
    ed.editor.update(review.addItems(body, [{
      kind: "review",
      start: a,
      end: b,
      date: localDay(),
      text: said,
      author: this.plugin.settings.replyName || "Me"
    }]));
    ed.dirty = true;
    ed.changed = true;
    this.save(ed);
    return true;
  }
  /** Asks for a comment on the selected passage, then adds it. */
  askComment() {
    const ed = this.editing;
    const range = ed && ed.editor.update ? ed.editor.selection() : null;
    if (!range || range[0] === range[1]) {
      new Notice("Dendrite: select the passage to comment on.");
      return;
    }
    new CommentModal(this.app, (said) => this.commentOnSelection(said, range)).open();
  }
  /**
   * A reply from a program to the comment `tid` on card `id`; its
   * index, or -1 when there is no such comment. In the card's editor if
   * it is being typed in, which stays open, as a change to the text.
   */
  async replyFrom(id, tid, reply) {
    const ed = this.editing;
    if (ed && ed.id === id && ed.editor.update) {
      const body2 = ed.editor.value;
      const n2 = review.threadIds(review.reviewItems(body2)).indexOf(tid);
      if (n2 < 0) return n2;
      const out2 = withReply(body2, n2, reply);
      if (out2 === null) return REFUSED;
      ed.editor.update(out2);
      ed.dirty = true;
      ed.changed = true;
      await this.save(ed);
      return n2;
    }
    const f = this.cardFile(id);
    if (!f) return -1;
    const { body } = core.splitFrontmatter(await this.app.vault.read(f));
    const n = review.threadIds(review.reviewItems(body)).indexOf(tid);
    if (n < 0) return n;
    const out = withReply(body, n, reply);
    if (out === null) return REFUSED;
    await this.reviewAction(id, n, "text", out);
    return n;
  }
  /**
   * A suggested change from a program on card `id`; why it was not
   * added, or null. In the card's editor if it is being typed in.
   */
  async suggestIn(id, item) {
    const ed = this.editing;
    if (ed && ed.id === id && ed.editor.update) {
      const out2 = review.suggestInto(ed.editor.value, id, item);
      if (out2.reason) return out2.reason;
      ed.editor.update(out2.md);
      ed.dirty = true;
      ed.changed = true;
      await this.save(ed);
      return null;
    }
    const f = this.cardFile(id);
    if (!f) return `no card ${id}`;
    const { body } = core.splitFrontmatter(await this.app.vault.read(f));
    const out = review.suggestInto(body, id, item);
    if (out.reason) return out.reason;
    await this.reviewAction(id, 0, "text", out.md);
    return null;
  }
  async reviewAction(id, n, what, arg = null) {
    const f = this.cardFile(id);
    if (!f) return;
    if (this.editing && this.editing.id === id) await this.endEdit();
    const data = await this.app.vault.read(f);
    const { fm, body } = core.splitFrontmatter(data);
    const write = async (text) => {
      const out = await this.writeCard(f, () => fm + text);
      this.pushUndo({
        active: id,
        files: [],
        text: true,
        restores: [{
          path: f.path,
          text: data,
          ifBody: core.splitFrontmatter(out).body
        }]
      });
      this.invalidate(id);
      await this.renderCard(id);
      if (!this.cardEls.has(id)) {
        this.render();
        await this.fanReady;
      }
    };
    const item = review.reviewItems(body)[n];
    if (what === "text") {
      await write(arg);
      return;
    }
    if (what === "reply") {
      await write(review.addReply(body, n, typeof arg === "object" ? arg : {
        author: this.plugin.settings.replyName || "Me",
        date: localDay(),
        text: arg
      }));
      return;
    }
    if (what === "unreply") {
      await write(review.removeReply(body, n, arg));
      return;
    }
    if (what === "apply") {
      const after = review.removeItem(body, n, true);
      const done = (text) => async () => {
        await write(text);
        if (item) await this.rememberDone(item);
      };
      const replies = item ? review.keptReplies(item) : [];
      new SuggestModal(
        this,
        id,
        body,
        after,
        done(after),
        item && this.colourOf()(item.author || "Reviewer"),
        replies,
        replies.length ? done(review.applyKeeping(body, n)) : null
      ).open();
      return;
    }
    const gid = what === "resolve" && item && review.reviewKeys(item).find((k) => k.startsWith("g:"));
    if (gid) {
      await this.resolveEverywhere(gid);
      await this.rememberDone(item);
      return;
    }
    await write(review.removeItem(body, n));
    if (item && what !== "delete") await this.rememberDone(item);
  }
  async setStatus(id, status) {
    const f = this.cardFile(id);
    if (!f) return;
    if ((this.statusOf(id) || null) === (status || null)) return;
    await writeProps(this.app, f, { dendrite_status: status || null });
  }
  /** A status set by hand: a key, a menu or a chip. One undo step. */
  async markStatus(id, status) {
    const f = this.cardFile(id);
    if (!f || (this.statusOf(id) || null) === (status || null)) return;
    const data = await this.app.vault.read(f);
    await this.setStatus(id, status);
    this.pushUndo({
      active: this.active,
      files: [],
      created: [],
      restores: [{
        path: f.path,
        text: data,
        ifBody: core.splitFrontmatter(data).body
      }],
      text: false
    });
  }
  /**
   * Show each card's status at its top right, beside the role icon,
   * and the counts in the bar.
   * A printing card shows its own status, a structural card the least
   * finished state below it and how many cards there are flagged.
   */
  // ---- review rounds ---------------------------------------------------
  /** The review rounds' file, beside the index: Grant.rounds.json. */
  roundsPath() {
    return this.file ? this.file.path.replace(/\.md$/, "") + ".rounds.json" : null;
  }
  async readRounds() {
    const f = this.app.vault.getAbstractFileByPath(this.roundsPath());
    if (!(f instanceof TFile)) return [];
    try {
      const data = JSON.parse(await this.app.vault.read(f));
      return Array.isArray(data.rounds) ? data.rounds : [];
    } catch (err) {
      return [];
    }
  }
  /** What each card prints now, fingerprinted as a round keeps it. */
  async fingerprints() {
    const bodies = await this.loadBodies();
    const crc = require_docx().crc32;
    return core.roundFingerprints(
      this.root,
      (id) => bodies.get(id),
      (id) => this.printRoleOf(id),
      (t) => String(crc(Buffer.from(t, "utf8")))
    );
  }
  /**
   * A review round: the manuscript as sent, today, to `to`, kept in
   * the rounds' file so the board can show what changed since.
   */
  async recordRound(to) {
    const rounds = await this.readRounds();
    rounds.push({
      date: localDay(),
      to: String(to || "").trim(),
      cards: await this.fingerprints()
    });
    const path = this.roundsPath();
    const text = JSON.stringify({ rounds }, null, 2) + "\n";
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.vault.modify(f, text);
    else await this.app.vault.create(path, text);
    await this.updateChanged();
  }
  /**
   * The review rounds' cards under their new ids, `to(id)`, for a
   * rename, so none reads as changed since it was sent.
   */
  async renameRounds(path, to) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    await this.app.vault.process(f, (data) => {
      let d;
      try {
        d = JSON.parse(data);
      } catch (err) {
        return data;
      }
      for (const r of Array.isArray(d.rounds) ? d.rounds : []) {
        r.cards = Object.fromEntries(Object.entries(r.cards || {}).map(([id, crc]) => [to(id), crc]));
      }
      return JSON.stringify(d, null, 2) + "\n";
    });
  }
  /** After an export: a notice offering to mark it as sent. */
  offerRound() {
    const frag = this.pageDoc().createDocumentFragment();
    const el = createDiv({ text: "Dendrite: sent this for review? " });
    const b = el.createEl("button", { text: "Mark as sent for review\u2026" });
    b.addEventListener("click", () => new RoundModal(this).open());
    frag.append(el);
    new Notice(frag, 15e3);
  }
  scheduleChanged() {
    clearTimeout(this.changedTimer);
    this.changedTimer = setTimeout(() => this.updateChanged(), 500);
  }
  /** Which cards' printed text changed since the latest round. */
  async updateChanged() {
    if (!this.root) return;
    const rounds = await this.readRounds();
    const last = rounds[rounds.length - 1];
    const before = this.changed;
    this.changed = last ? {
      date: last.date,
      to: last.to,
      ids: core.changedSince(
        last.cards || {},
        await this.fingerprints()
      )
    } : null;
    const key = (c) => c ? `${c.date}|${[...c.ids].join(",")}` : "";
    if (key(before) !== key(this.changed)) this.updateStatuses();
  }
  /** Statuses shown again once, after the cards being drawn. */
  scheduleStatuses() {
    if (this.statusTimer) return;
    this.statusTimer = this.pageWin().setTimeout(() => {
      this.statusTimer = null;
      this.updateStatuses();
    }, 0);
  }
  /** A card's status chips, flag and stack edges, from statusInfo. */
  statusCard(id, card) {
    if (!this.statusInfo) return;
    const old = card.querySelector(":scope > .dendrite-status");
    if (old) old.remove();
    card.removeClass("is-flagged");
    const info = this.statusInfo.get(id) || { prints: false, own: null, below: 0 };
    const chip = createDiv({ cls: "dendrite-status" });
    const show = (status, text) => {
      const s = chip.createSpan({ cls: `dendrite-status-chip is-${status}`, text });
      const colour = this.plugin.statusColour(status);
      if (colour) s.style.setProperty("--dendrite-chip", colour);
      return s;
    };
    if (this.reverted.has(id)) {
      const held = this.held.has(id);
      const s = show("reverted", held ? "typing kept \u27F2" : "older copy \u27F2");
      s.setAttr("aria-label", held ? "Changed outside Dendrite while you were typing in it. Click to compare and choose; your typing is not written until you do" : "Changed outside Dendrite to text this card had before. Click to compare and choose; nothing is written until you do");
      s.onclick = (e) => {
        e.stopPropagation();
        this.reviewVersion(id);
      };
    }
    if (this.changed && this.changed.ids.has(id)) {
      const s = show("changed", "changed since " + review.shortDate(this.changed.date));
      s.setAttr("aria-label", "What this card prints changed since it was sent to " + (this.changed.to || "review"));
    }
    if (info.own === "done") show("done", "done \u2713");
    else if (info.own === "revise") show("revise", "revise \u2691");
    else if (info.own === "unsplit") show("unsplit", "unsplit");
    if (!info.prints && info.below > 0) {
      show("revise", `${info.below} to revise \u2691`);
    } else if (!info.prints && info.derived === "done" && !info.own) {
      show("done", "done \u2713");
    }
    const stack = this.stackOf(id).length;
    card.toggleClass("has-stack", stack > 0);
    card.toggleClass("has-stacks", stack > 1);
    card.toggleClass("is-fanned", stack > 0 && this.fannedId === id);
    if (stack) {
      const s = show("stack", `${stack + 1} versions`);
      s.dataset.stack = id;
      s.toggleClass("is-on", this.fannedId === id);
      s.setAttr("aria-label", this.fannedId === id ? "Click to fold the old versions away" : "Earlier versions of this card, kept and not printed. Click to fan them out to its right");
      s.onclick = (e) => {
        e.stopPropagation();
        return this.toggleFan(id);
      };
    }
    if (core.isFlag(info.own)) card.addClass("is-flagged");
    if (!chip.childElementCount) return;
    card.appendChild(chip);
  }
  updateStatuses() {
    if (!this.board) return;
    const open = this.openComments || /* @__PURE__ */ new Map();
    const comments = (id) => {
      if (open.has(id)) return open.get(id);
      const b = this.bodies && this.bodies.get(id);
      if (!b) return 0;
      if (b.comments === void 0) {
        b.comments = review.countComments(review.reviewItems(b.body));
      }
      return b.comments;
    };
    const report = core.statusReport(
      this.root,
      (id) => this.statusOf(id),
      (id) => this.printRoleOf(id),
      comments
    );
    this.statusInfo = report.cards;
    for (const [id, card] of this.liveCards()) this.statusCard(id, card);
    this.stackOpenReady = this.markOpenStacks();
    if (this.statusEl) {
      const t = report.tally;
      const parts = [];
      if (t.revise) parts.push(`${t.revise} revise`);
      if (t.unsplit) parts.push(`${t.unsplit} unsplit`);
      parts.push(`${t.draft} draft`, `${t.done} done`);
      const ch = this.changed;
      if (ch && ch.ids.size) {
        parts.push(`${ch.ids.size} changed since sent ` + review.shortDate(ch.date));
      }
      this.statusEl.setText(parts.join(" \xB7 "));
      this.statusEl.toggleClass("has-flags", t.revise + t.unsplit > 0);
      if (this.reverted.has("index")) {
        const s = this.statusEl.createSpan({
          cls: "dendrite-status-chip is-reverted",
          text: "index: older copy \u27F2"
        });
        s.setAttr("aria-label", "The index changed outside Dendrite to an older copy. Click to compare and choose; nothing is written until you do");
        s.onclick = () => this.reviewVersion(null);
      }
      if (this.arriving) {
        const s = this.statusEl.createSpan({
          cls: "dendrite-status-chip is-reverted",
          text: `renaming: ${this.arriving} to arrive`
        });
        s.setAttr("aria-label", "Renamed on another device; some card notes have not arrived under their new names. The board changes nothing until they do");
        s.onclick = () => this.refuseWhileArriving();
      }
      for (const entry of this.inbox) {
        const s = this.statusEl.createSpan({
          cls: "dendrite-status-chip is-revise",
          text: `review: ${entry.items.length} from ` + reviewAuthors(entry.items)
        });
        s.setAttr("aria-label", `${entry.title}, submitted ${entry.received.slice(0, 10)}. Click to see its comments and choose which to add; nothing is written until you do`);
        s.onclick = () => this.openInbox(entry);
      }
      if (this.oldCopies.length) {
        const n = this.oldCopies.length;
        const s = this.statusEl.createSpan({
          cls: "dendrite-status-chip is-reverted",
          text: `${n} old cop${n === 1 ? "y" : "ies"} \u27F2`
        });
        s.setAttr("aria-label", "Notes under this manuscript's name before its rename, brought back by a sync. Click to see them");
        s.onclick = () => new OldCopiesModal(this).open();
      }
    }
    if (this.plugin.previewStatuses) {
      this.plugin.previewStatuses(this.file);
    }
  }
  /**
   * Status belongs to text that prints. A card that no longer prints
   * loses draft, done or revise; a card that prints again loses unsplit;
   * an unsplit card with nothing left behind loses unsplit.
   */
  async sweepStatuses() {
    for (const n of core.allNodes(this.root)) {
      if (!this.cardFile(n.id)) continue;
      const s = this.statusOf(n.id);
      const prints = core.roleFor(n, (id) => this.printRoleOf(id)) === "prose";
      if (prints && (!s || s === "unsplit")) {
        await this.setStatus(n.id, "draft");
      } else if (!prints && s && s !== "unsplit") {
        await this.setStatus(n.id, null);
      }
    }
  }
  /** Clear unsplit once the card holds only its heading and comments. */
  async clearFinishedSplit(file) {
    if (!(file instanceof TFile)) return;
    if (this.statusOf(file.basename) !== "unsplit") return;
    const body = core.splitFrontmatter(
      await this.app.vault.cachedRead(file)
    ).body;
    if (!core.leftover(body)) await this.setStatus(file.basename, null);
  }
  /** The next or previous card in reading order that is flagged. */
  nextFlagged(dir, test = (info) => core.isFlag(info.own)) {
    const order = core.allNodes(this.root).filter((n) => {
      const info = this.statusInfo && this.statusInfo.get(n.id);
      return info && test(info);
    });
    if (!order.length) {
      new Notice("Dendrite: no cards to go to.");
      return;
    }
    const all = core.allNodes(this.root);
    const at = all.findIndex((n) => n.id === this.active);
    const pick = dir > 0 ? order.find((n) => all.indexOf(n) > at) || order[0] : [...order].reverse().find((n) => all.indexOf(n) < at) || order[order.length - 1];
    this.select(pick.id);
  }
  /** + marks a printing card done; - sends it to revise. */
  async stepStatus(up) {
    const node = this.active && this.byId.get(this.active);
    if (!node) return;
    if (this.statusOf(node.id) === "unsplit") {
      if (up) await this.markStatus(node.id, null);
      return;
    }
    if (core.roleFor(node, (x) => this.printRoleOf(x)) !== "prose") {
      new Notice("Dendrite: a structural card takes its status from the cards below it.");
      return;
    }
    await this.markStatus(this.active, up ? "done" : "revise");
  }
  /** Mark cards that print nothing, and where a role was set by hand. */
  updateRoles() {
    if (this.shown && this.shownKey(this.shownTree()) !== this.shownKey(this.shown)) {
      this.render();
      return;
    }
    for (const [id, card] of this.liveCards()) this.roleCard(id, card);
  }
  /** A card's role: its classes, and its icon in the corner. */
  roleCard(id, card) {
    const node = this.byId.get(id);
    if (!node) return;
    let out = false;
    for (let n = node; n && n.id; n = n.parent) {
      if (core.roleFor(n, (x) => this.printRoleOf(x)) === "notes") {
        out = true;
        break;
      }
    }
    card.toggleClass("is-left-out", out);
    card.toggleClass(
      "is-heading-only",
      this.roleOf(id) === "section"
    );
    card.toggleClass("is-prints-heading", !out && core.roleFor(node, (x) => this.printRoleOf(x)) === "section");
    const set = this.roleOf(id);
    let role = out ? "notes" : core.roleFor(node, (x) => this.printRoleOf(x));
    const auto = out ? set !== "notes" : !set;
    const kind = this.kindOf(id);
    if (kind && role === "prose") role = kind;
    const grip = card.querySelector(":scope > .dendrite-grip");
    if (grip && grip.dataset.role !== role) {
      grip.dataset.role = role;
      const icon = grip.querySelector(".dendrite-role-icon");
      icon.empty();
      setIcon(icon, (ROLE_ITEMS.find((r) => r[0] === role) || KIND_ITEMS.find((r) => r[0] === role))[2]);
    }
    if (grip) {
      grip.toggleClass("is-auto", auto);
      const what = (ROLE_ITEMS.find((r) => r[0] === role) || KIND_ITEMS.find((r) => r[0] === role))[1];
      grip.setAttr("aria-label", what + (auto && !kind ? " (automatic)" : "") + ". Click to change; drag to move the card.");
    }
    card.toggleClass(
      "is-scaffolding",
      this.roleOf(id) === "scaffolding"
    );
  }
  /** A card's quota, with whether the call requires it. */
  quotaOf(id) {
    const fm = this.cardProps(id);
    const q = core.parseLimit(fm.dendrite_limit);
    return q ? Object.assign(q, {
      required: fm.dendrite_limit_required === true
    }) : null;
  }
  /**
   * Each card with a quota shows what it uses against it and what the
   * quotas below it allocate; the bar does the same for the manuscript
   * total. Over a hard limit is an error, over a soft limit a warning.
   * Card text is read only when some quota is set.
   */
  async updateCounts() {
    if (!this.file || !this.board) return;
    const ms = this.manuscript();
    this.quotaReports = /* @__PURE__ */ new Map();
    if (this.totalEl) this.totalEl.empty();
    const any = ms.limit || core.allNodes(this.root).some(
      (n) => this.quotaOf(n.id)
    );
    if (!any) {
      for (const [id, card] of this.liveCards()) {
        this.fillQuota(card, id);
      }
      return;
    }
    const bodies = await this.loadBodies();
    const bodyOf = (id) => this.editing && this.editing.id === id ? this.editing.editor.value : bodies.get(id);
    const floats = this.floatOpts(true);
    const countOf = (nodes) => core.countManuscript(
      nodes,
      bodyOf,
      (id) => this.printRoleOf(id),
      ms.countSpaces,
      floats
    );
    const total = ms.limit ? Object.assign(
      {},
      ms.limit,
      { required: ms.limitRequired }
    ) : null;
    const reports = core.quotas(
      this.root,
      (id) => this.quotaOf(id),
      countOf,
      {
        wordsPerPage: ms.wordsPerPage,
        charsPerWord: ms.charsPerWord,
        total
      }
    );
    this.quotaReports = reports;
    for (const [id, card] of this.liveCards()) this.fillQuota(card, id);
    if (!this.totalEl) return;
    const top = reports.get(null);
    if (top) {
      this.showQuota(this.totalEl, top);
    } else {
      const n = countOf(this.root.children);
      this.totalEl.setText(`${n.words.toLocaleString()} words`);
    }
  }
  /**
   * A card's quota at its bottom left: a target and a bar filled to its
   * use. Details fade in on hover; a click edits the quota. A card
   * without one shows the target only on hover, to offer setting one.
   */
  renderQuotaWidget(foot, id) {
    const w = foot.createDiv({ cls: "dendrite-quota is-empty" });
    setIcon(w.createSpan({ cls: "dendrite-quota-icon" }), "target");
    const bar = w.createDiv({ cls: "dendrite-quota-bar" });
    bar.createDiv({ cls: "dendrite-quota-fill" });
    w.addEventListener("mouseenter", () => this.showQuotaTip(id, w));
    w.addEventListener("mouseleave", () => this.hideQuotaTip());
    w.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hideQuotaTip();
      this.editQuota(id, w);
    });
    const r = this.quotaReports && this.quotaReports.get(id);
    if (r) this.fillQuota(foot.parentElement, id);
  }
  fillQuota(card, id) {
    const w = card.querySelector(
      ":scope > .dendrite-card-foot > .dendrite-quota"
    );
    if (!w) return;
    const r = this.quotaReports && this.quotaReports.get(id);
    w.removeClass("is-over-required");
    w.removeClass("is-over-target");
    w.toggleClass("is-empty", !r);
    if (!r) return;
    const kind = r.quota.required ? "required" : "target";
    const share = r.used / r.quota.amount;
    const over = share > 1 || r.allocated !== null && r.allocated > r.quota.amount;
    if (over) w.addClass(`is-over-${kind}`);
    w.toggleClass("is-required", r.quota.required);
    w.querySelector(".dendrite-quota-fill").style.width = Math.min(100, Math.round(share * 100)) + "%";
  }
  showQuotaTip(id, anchor) {
    this.hideQuotaTip();
    const tip = this.pageDoc().body.createDiv(
      { cls: "dendrite-quota-tip" }
    );
    const r = this.quotaReports && this.quotaReports.get(id);
    if (r) this.showQuota(tip, r);
    const a = anchor.getBoundingClientRect();
    tip.style.left = a.left + "px";
    tip.style.top = a.top - 6 + "px";
    this.quotaTip = tip;
    this.pageWin().requestAnimationFrame(() => tip.addClass("is-shown"));
    return this.showCounts(tip, id);
  }
  /**
   * What a card prints, then with the cards below it where that
   * differs, as characters, words and pages, quota or none.
   */
  async showCounts(tip, id) {
    const node = this.byId.get(id);
    if (!node) return;
    const ms = this.manuscript();
    const bodies = await this.loadBodies();
    if (this.quotaTip !== tip) return;
    const bodyOf = (x) => this.editing && this.editing.id === x ? this.editing.editor.value : bodies.get(x);
    const roleOf = (x) => this.printRoleOf(x);
    const floats = this.floatOpts();
    const own = core.exportSegments(
      [node],
      bodyOf,
      1,
      null,
      roleOf,
      floats
    ).find((s) => s.id === id);
    const rows = [[
      "This card",
      core.countText(own ? own.text : "", ms.countSpaces)
    ]];
    if (node.children.length) {
      rows.push(["With cards below", core.countText(
        core.exportMarkdown([node], bodyOf, 1, null, roleOf, floats),
        ms.countSpaces
      )]);
    }
    const table = tip.createEl("table", { cls: "dendrite-count-table" });
    const head = table.createEl("tr");
    for (const h of ["", "Chars", "Words", "Pages"]) {
      head.createEl("th", { text: h });
    }
    for (const [label, n] of rows) {
      const tr = table.createEl("tr");
      const pages = Math.round(n.words / ms.wordsPerPage * 100) / 100;
      for (const v of [
        label,
        n.chars.toLocaleString(),
        n.words.toLocaleString(),
        "~" + core.fmtNum(pages)
      ]) {
        tr.createEl("td", { text: v });
      }
    }
  }
  hideQuotaTip() {
    if (this.quotaTip) this.quotaTip.remove();
    this.quotaTip = null;
  }
  /** A small editor for a card's quota, beside its target. */
  editQuota(id, anchor) {
    this.closeQuotaEditor();
    const f = this.cardFile(id);
    if (!f) return;
    const fm = this.cardProps(id);
    const q = core.parseLimit(fm.dendrite_limit);
    const pop = this.pageDoc().body.createDiv(
      { cls: "dendrite-quota-pop" }
    );
    const amount = pop.createEl("input", { type: "text" });
    amount.placeholder = "500, or 1/4";
    amount.value = q ? core.fmtNum(q.amount) : "";
    const unit = pop.createEl("select");
    for (const u of ["words", "characters", "pages"]) {
      unit.createEl("option", { text: u, value: u });
    }
    unit.value = q ? q.unit : "words";
    const label = pop.createEl("label", { cls: "dendrite-quota-req" });
    const req = label.createEl("input", { type: "checkbox" });
    req.checked = fm.dendrite_limit_required === true;
    label.createSpan({ text: "hard limit" });
    const row = pop.createDiv({ cls: "dendrite-quota-actions" });
    const save = row.createEl("button", {
      cls: "mod-cta",
      text: "Save"
    });
    const clear = row.createEl("button", { text: "Remove" });
    const a = anchor.getBoundingClientRect();
    pop.style.left = a.left + "px";
    pop.style.top = a.bottom + 4 + "px";
    const write = async (remove) => {
      const n = core.parseAmount(amount.value);
      const ok = !remove && amount.value.trim() && n > 0;
      await writeProps(this.app, f, {
        dendrite_limit: ok ? core.formatLimit({ amount: n, unit: unit.value }) : null,
        dendrite_limit_required: ok && req.checked ? true : null
      });
      this.closeQuotaEditor();
    };
    save.onclick = () => write(false);
    clear.onclick = () => write(true);
    const scope = new Scope(this.app.scope);
    scope.register([], "Enter", () => {
      write(false);
      return false;
    });
    scope.register([], "Escape", () => {
      this.closeQuotaEditor();
      return false;
    });
    if (this.app.keymap) this.app.keymap.pushScope(scope);
    const outside = (e) => {
      if (!pop.contains(e.target)) this.closeQuotaEditor();
    };
    const doc = this.pageDoc();
    setTimeout(() => doc.addEventListener("mousedown", outside), 0);
    this.quotaPop = { pop, scope, outside, doc };
    amount.focus();
    amount.select();
  }
  closeQuotaEditor() {
    const q = this.quotaPop;
    if (!q) return;
    this.quotaPop = null;
    if (this.app.keymap) this.app.keymap.popScope(q.scope);
    q.doc.removeEventListener("mousedown", q.outside);
    q.pop.remove();
    this.contentEl.focus();
  }
  showQuota(el, r) {
    const q = r.quota;
    const kind = q.required ? "required" : "target";
    const tilde = (est) => est ? "~" : "";
    const used = el.createDiv({ cls: "dendrite-quota-line" });
    used.setText(`${tilde(r.usedEstimated)}${core.fmtNum(r.used)} / ${core.formatLimit(q)}`);
    used.createSpan({
      cls: "dendrite-quota-kind",
      text: q.required ? "hard limit" : "soft limit"
    });
    if (r.used > q.amount) used.addClass(`is-over-${kind}`);
    if (r.allocated === null) return;
    const alloc = el.createDiv({ cls: "dendrite-quota-line dendrite-quota-alloc" });
    const left = q.amount - r.allocated;
    alloc.setText(left >= 0 ? `${tilde(r.allocatedEstimated)}${core.fmtNum(r.allocated)} allocated, ${core.fmtNum(left)} free` : `${tilde(r.allocatedEstimated)}${core.fmtNum(r.allocated)} allocated, ${core.fmtNum(-left)} over`);
    if (left < 0) alloc.addClass(`is-over-${kind}`);
    el.setAttr("aria-label", r.usedEstimated || r.allocatedEstimated ? "Figures marked ~ are estimates, from words per page or characters per word in the manuscript settings." : "");
  }
  async loadBodies() {
    this.bodies = this.bodies || /* @__PURE__ */ new Map();
    let read = false;
    for (const n of core.allNodes(this.root)) {
      const f = this.cardFile(n.id);
      if (!f) continue;
      const had = this.bodies.get(n.id);
      if (had && had.mtime === f.stat.mtime) continue;
      const text = await this.app.vault.cachedRead(f);
      this.bodies.set(n.id, {
        mtime: f.stat.mtime,
        body: core.splitFrontmatter(text).body
      });
      read = true;
    }
    if (read) this.scheduleStatuses();
    const out = /* @__PURE__ */ new Map();
    for (const [id, b] of this.bodies) out.set(id, b.body);
    return out;
  }
  // ---- find ------------------------------------------------------------
  /**
   * Open the find bar, or focus it when open. Find searches the cards'
   * notes, not the page, since cards far from view are not rendered.
   */
  openFind() {
    if (!this.find) {
      const ed = this.editing;
      this.find = {
        query: "",
        matchCase: false,
        regex: false,
        branch: null,
        matches: [],
        index: -1,
        error: null,
        token: 0,
        returnTo: ed ? { id: ed.id, sel: ed.editor.selection() } : null
      };
      this.renderFind();
    }
    const input = this.find.input;
    input.focus();
    input.select();
  }
  /** The find bar, under the view's bar. */
  renderFind() {
    const f = this.find;
    const bar = this.contentEl.querySelector(":scope > .dendrite-bar");
    if (!f || !bar) return;
    if (f.el) f.el.remove();
    const row = createDiv({ cls: "dendrite-find" });
    bar.insertAdjacentElement("afterend", row);
    f.el = row;
    const input = row.createEl("input", { type: "text" });
    input.placeholder = 'Find in cards: words, "a phrase"';
    input.value = f.query;
    input.spellcheck = false;
    f.input = input;
    input.addEventListener("input", () => {
      f.query = input.value;
      this.scheduleFind(false);
    });
    const toggle = (key, icon, title, on) => {
      const b = row.createEl("button", { cls: "dendrite-find-opt" });
      setIcon(b, icon);
      b.setAttr("aria-label", title);
      b.toggleClass("is-on", !!f[key]);
      b.onclick = () => {
        f[key] = on();
        b.toggleClass("is-on", !!f[key]);
        this.runFind(false);
        input.focus();
      };
    };
    toggle(
      "matchCase",
      "case-sensitive",
      "Match case",
      () => !f.matchCase
    );
    toggle("regex", "regex", "Regular expression", () => !f.regex);
    toggle(
      "printed",
      "printer",
      "Only text that prints",
      () => !f.printed
    );
    toggle(
      "branch",
      "git-branch",
      "Only the selected card's branch",
      () => f.branch ? null : this.active
    );
    f.countEl = row.createSpan({ cls: "dendrite-find-count" });
    const btn = (icon, title, fn) => {
      const b = row.createEl("button", { cls: "dendrite-find-opt" });
      setIcon(b, icon);
      b.setAttr("aria-label", title);
      b.onclick = fn;
    };
    btn(
      "chevron-up",
      "Previous match (Shift+Enter)",
      () => this.findStep(-1)
    );
    btn("chevron-down", "Next match (Enter)", () => this.findStep(1));
    btn("x", "Close (Escape)", () => this.closeFind());
    const scope = new Scope(this.app.scope);
    scope.register([], "Enter", () => {
      this.findStep(1);
      return false;
    });
    scope.register(["Shift"], "Enter", () => {
      this.findStep(-1);
      return false;
    });
    scope.register(["Mod"], "Enter", () => {
      this.editAtMatch();
      return false;
    });
    scope.register([], "Escape", () => {
      this.closeFind();
      return false;
    });
    scope.register(["Mod"], "f", () => {
      input.select();
      return false;
    });
    f.scope = scope;
    input.addEventListener("keydown", (e) => {
      if (e.defaultPrevented || e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") this.closeFind();
      else if (e.key === "Enter" && mod) this.editAtMatch();
      else if (e.key === "Enter") this.findStep(e.shiftKey ? -1 : 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    input.addEventListener("focus", () => {
      if (this.app.keymap) this.app.keymap.pushScope(scope);
    });
    input.addEventListener("blur", () => {
      if (this.app.keymap) this.app.keymap.popScope(scope);
    });
    this.showFind();
  }
  scheduleFind(keep) {
    clearTimeout(this.findTimer);
    this.findTimer = setTimeout(() => this.runFind(keep), 80);
  }
  /**
   * Search every card, or the branch find was narrowed to. With `keep`
   * the current match stays where it is, as after an edit; otherwise
   * find goes to the first match at or after the selected card.
   */
  async runFind(keep) {
    const f = this.find;
    if (!f) return;
    const token = ++f.token;
    const bodies = await this.loadBodies();
    if (this.find !== f || token !== f.token) return;
    const ed = this.editing;
    const bodyOf = (id) => ed && ed.id === id ? ed.editor.value : bodies.get(id);
    const top = f.branch && this.byId.get(f.branch);
    const nodes = (top ? [top, ...core.descendants(top)] : core.allNodes(this.root)).filter((n) => !this.shown || this.shown.parent.has(n.id));
    const ids = nodes.map((n) => n.id);
    const r = core.findMatches(ids, bodyOf, f.query, Object.assign(
      {},
      f,
      { printed: f.printed ? this.printedOf() : null }
    ));
    const was = f.matches[f.index];
    f.matches = r.matches;
    f.error = r.error || null;
    if (!f.matches.length) {
      f.index = -1;
    } else if (keep && was) {
      const k = f.matches.findIndex((m) => m.id === was.id && m.start >= was.start);
      f.index = k >= 0 ? k : Math.min(f.index, f.matches.length - 1);
    } else {
      const order = new Map(ids.map((id, k2) => [id, k2]));
      const here = order.has(this.active) ? order.get(this.active) : 0;
      const k = f.matches.findIndex((m) => order.get(m.id) >= here);
      f.index = k >= 0 ? k : 0;
    }
    if (!keep && f.index >= 0) await this.goToMatch(f.index);
    else this.showFind();
  }
  /**
   * What a card prints, for find: its text by its role, nothing in a
   * left-out branch.
   */
  printedOf() {
    const roleOf = (x) => this.printRoleOf(x);
    const out = /* @__PURE__ */ new Set();
    const walk = (node) => {
      if (core.roleFor(node, roleOf) === "notes") {
        for (const d of [node, ...core.descendants(node)]) {
          out.add(d.id);
        }
        return;
      }
      node.children.forEach(walk);
    };
    this.root.children.forEach(walk);
    return (id, body) => {
      const node = this.byId.get(id);
      if (!node || out.has(id)) return [];
      return core.printedRanges(body, core.roleFor(node, roleOf));
    };
  }
  /** Count, fading, the matches below each card, and highlights. */
  showFind() {
    const f = this.find;
    if (!f || !this.board) return;
    const n = f.matches.length;
    const per = /* @__PURE__ */ new Map();
    for (const m of f.matches) per.set(m.id, (per.get(m.id) || 0) + 1);
    if (f.countEl) {
      const comments = f.matches.filter((m) => m.comment).length;
      f.countEl.setText(f.error ? "Not a valid pattern" : !f.query.trim() ? "" : !n ? "No matches" : `${f.index + 1} of ${n} in ${per.size} card` + (per.size === 1 ? "" : "s") + (comments ? `, ${comments} in comments` : ""));
      f.countEl.toggleClass("is-error", !!f.error);
    }
    const on = !!f.query.trim() && !f.error;
    this.board.toggleClass("is-finding", on);
    const below = /* @__PURE__ */ new Map();
    for (const [id, k] of per) {
      const node = this.byId.get(id);
      for (let p = node && this.upOf(node); p && p.id; p = this.upOf(p)) {
        below.set(p.id, (below.get(p.id) || 0) + k);
      }
    }
    this.findShown = { on, per, below };
    for (const [id, card] of this.cardEls) this.findCard(id, card);
    this.paintFind();
  }
  /**
   * A card marked as a match or not, and, drawn, how many matches its
   * branch holds below it; a slot gets the count once filled.
   */
  findCard(id, card) {
    const s = this.findShown;
    const on = !!(s && s.on && this.find);
    card.toggleClass("is-match", on && s.per.has(id));
    if (card.hasClass("is-slot")) return;
    const old = card.querySelector(":scope > .dendrite-find-below");
    if (old) old.remove();
    if (on && s.below.get(id)) {
      const chip = card.createDiv({
        cls: "dendrite-find-below",
        text: `${s.below.get(id)} below`
      });
      chip.setAttr("aria-label", "Matches in this card's branch");
    }
  }
  /** Step to the next match, or back with -1, wrapping round. */
  async findStep(dir) {
    const f = this.find;
    if (!f || !f.matches.length) return;
    const n = f.matches.length;
    await this.goToMatch((f.index + dir + n) % n);
  }
  async goToMatch(i) {
    const f = this.find;
    const m = f && f.matches[i];
    if (!m) return;
    f.index = i;
    if (this.editing && this.editing.id !== m.id) await this.endEdit();
    if (this.find !== f) return;
    if (this.active !== m.id) {
      const node = this.byId.get(m.id);
      const parent = node && this.upOf(node);
      if (parent && parent.id) this.lastChild.set(parent.id, m.id);
      this.active = m.id;
    }
    this.applyActive();
    this.showFind();
    if (f.input && f.input.isConnected) f.input.focus();
  }
  /** Edit the card holding the current match, with the match selected. */
  async editAtMatch() {
    const f = this.find;
    const m = f && f.matches[f.index];
    if (!m) return;
    await this.startEdit(m.id);
    if (this.editing && this.editing.id === m.id && !m.card) {
      this.editing.editor.focusAt(m.start, m.end);
    }
  }
  closeFind() {
    const f = this.find;
    if (!f) return;
    this.find = null;
    clearTimeout(this.findTimer);
    if (this.app.keymap && f.scope) this.app.keymap.popScope(f.scope);
    if (f.el) f.el.remove();
    if (this.board) this.board.removeClass("is-finding");
    for (const card of this.cardEls.values()) {
      card.removeClass("is-match");
      const chip = card.querySelector(":scope > .dendrite-find-below");
      if (chip) chip.remove();
    }
    this.paintFind();
    const back = f.returnTo;
    if (back && this.editing && this.editing.id === back.id) {
      this.editing.editor.focusAt(back.sel[0], back.sel[1]);
    } else {
      this.contentEl.focus();
    }
  }
  /**
   * Highlight matches in the rendered cards, without changing them:
   * the browser's highlight registry paints ranges over the text. The
   * query is run again over each card's rendered text, since markdown
   * syntax does not render; the current match is the same-numbered
   * match in its card.
   */
  paintFind() {
    const f = this.find;
    for (const [id, card] of this.liveCards()) {
      const tag = card.querySelector(".dendrite-id");
      if (!tag) continue;
      const m = f && f.matches.find((x) => x.card && x.id === id);
      tag.toggleClass("is-match", !!m);
      tag.toggleClass("is-current", !!m && m === f.matches[f.index]);
    }
    const win = this.pageWin();
    const reg = win.CSS && win.CSS.highlights;
    if (!reg || typeof win.Highlight !== "function") return;
    reg.delete("dendrite-find");
    reg.delete("dendrite-find-current");
    if (!f || !f.matches.length) return;
    const { patterns } = core.findPatterns(f.query, f);
    const cur = f.matches[f.index];
    const nth = cur && !cur.card ? f.matches.filter((m) => m.id === cur.id && !m.card && !!m.note === !!cur.note && m.start < cur.start).length : -1;
    const doc = this.pageDoc();
    const all = [];
    let current = null;
    const ids = new Set(f.matches.map((m) => m.id));
    for (const id of ids) {
      const card = this.cardEls.get(id);
      const ed = this.editing;
      if (ed && ed.id === id) {
        this.paintEditing(ed, patterns, id === (cur && cur.id) ? nth : -1, all, (r) => {
          current = r;
        });
        continue;
      }
      const md = card && card.querySelector(".dendrite-md");
      if (!md) continue;
      const nodes = [];
      let text = "";
      const walker = doc.createTreeWalker(md, 4);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        nodes.push({ t, at: text.length });
        text += t.data;
      }
      const spans = [];
      for (const p of patterns) {
        p.lastIndex = 0;
        let m;
        while ((m = p.exec(text)) !== null) {
          if (!m[0].length) {
            p.lastIndex += 1;
            continue;
          }
          spans.push([m.index, m.index + m[0].length]);
        }
      }
      spans.sort((a, b) => a[0] - b[0]);
      const point = (k) => {
        let i = nodes.length - 1;
        while (i > 0 && nodes[i].at > k) i -= 1;
        return [nodes[i].t, k - nodes[i].at];
      };
      const inNote = (r) => {
        const el = r.startContainer.parentElement;
        return !!(el && el.closest(".dendrite-review-notes"));
      };
      const seen = { true: 0, false: 0 };
      for (const [a, b] of spans) {
        const r = doc.createRange();
        r.setStart(...point(a));
        r.setEnd(...point(b));
        const note = inNote(r);
        const k = seen[note]++;
        if (id === (cur && cur.id) && note === !!cur.note && k === nth) current = r;
        else all.push(r);
      }
    }
    reg.set("dendrite-find", new win.Highlight(...all));
    if (current) {
      reg.set("dendrite-find-current", new win.Highlight(current));
    }
  }
  /** Find's matches in the editor of the card being written. */
  paintEditing(ed, patterns, nth, all, setCurrent) {
    const text = ed.editor.value;
    const spans = [];
    for (const p of patterns) {
      p.lastIndex = 0;
      let m;
      while ((m = p.exec(text)) !== null) {
        if (!m[0].length) {
          p.lastIndex += 1;
          continue;
        }
        spans.push([m.index, m.index + m[0].length]);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    spans.forEach(([a, b], k) => {
      const r = ed.editor.rangeAt(a, b);
      if (!r) return;
      if (k === nth) setCurrent(r);
      else all.push(r);
    });
  }
  // ---- export ----------------------------------------------------------
  /** Export, the whole manuscript or a branch, as chosen from a menu. */
  exportMenu(node, event) {
    const m = dendriteMenu(false);
    m.addItem((i) => i.setTitle("Markdown").onClick(() => this.exportTo(node, "md")));
    if (Platform.isDesktopApp) {
      m.addItem((i) => i.setTitle("PDF").onClick(() => this.exportTo(node, "pdf")));
      m.addItem((i) => i.setTitle("Word").onClick(() => this.exportTo(node, "docx")));
    }
    if (event) m.showAtMouseEvent(event);
  }
  /**
   * Export the manuscript, or one branch, to `exports/` beside the index:
   * markdown always, PDF and Word through Pandoc on the desktop, with
   * citations fetched from Zotero. Exports stay in the vault so a PDF
   * opens beside the board and travels with the vault's sync.
   */
  async exportTo(node, format = "md") {
    await this.flush();
    if (this.refuseWhileArriving()) return null;
    if (this.reverted.size) {
      const names = [...this.reverted].map((k) => k === "index" ? "the index" : core.shortId(k));
      new Notice("Dendrite: not exported, since " + names.join(", ") + ' changed to an older copy. Click "older copy" to compare and choose first.', 1e4);
      return null;
    }
    const scope = node ? [node] : this.root.children;
    const ids = node ? [node, ...core.descendants(node)] : core.allNodes(this.root);
    const bodies = /* @__PURE__ */ new Map();
    for (const n of ids) {
      const f = this.cardFile(n.id);
      if (f) {
        bodies.set(n.id, core.splitFrontmatter(
          await this.app.vault.cachedRead(f)
        ).body);
      }
    }
    const ms = this.manuscript();
    const floats = this.floatOpts(true);
    const text = core.exportMarkdown(
      scope,
      (id) => bodies.get(id),
      ms.headingTop,
      this.numbers(),
      (id) => this.printRoleOf(id),
      floats
    );
    const dir = normalizePath(
      (this.file.parent.path === "/" ? "" : this.file.parent.path + "/") + "exports"
    );
    if (!this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir);
    }
    const name = safeName(this.file.basename + (node ? " - " + (node.label || node.id) : ""));
    if (format !== "md") {
      await this.exportPandoc(text, format, dir, name, ms, !node);
      return;
    }
    const path = normalizePath(`${dir}/${name}.md`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    let out;
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, text);
      out = existing;
    } else {
      out = await this.app.vault.create(path, text);
    }
    await this.app.workspace.getLeaf("tab").openFile(out);
    new Notice(`Dendrite: exported to ${path}`);
  }
  /**
   * Write a reference.docx beside the index, never over one that
   * exists: Pandoc's, with the manuscript's font, size, spacing and page
   * and black text, as an export without one uses. Returns its path
   * from the vault root, or null.
   */
  async makeReferenceDocx() {
    const nodePath = require("path");
    const base = this.app.vault.adapter.getBasePath ? this.app.vault.adapter.getBasePath() : "";
    const parent = this.file.parent && this.file.parent.path !== "/" ? this.file.parent.path + "/" : "";
    const rel = normalizePath(parent + "reference.docx");
    if (this.app.vault.getAbstractFileByPath(rel)) {
      new Notice(`Dendrite: ${rel} already exists; it is used as is.`);
      return rel;
    }
    const deps = this.plugin.pandocDeps();
    const out = nodePath.join(base, rel);
    try {
      await deps.run(
        this.plugin.settings.pandocPath || "pandoc",
        [
          "-o",
          out,
          "--print-default-data-file",
          "reference.docx"
        ]
      );
      await deps.writeFile(out, pandoc.restyledReference(
        await deps.readFile(out),
        this.manuscript().style,
        deps.zlib
      ));
    } catch (err) {
      new Notice("Dendrite: could not write reference.docx. " + pandoc.pandocError(
        err,
        this.plugin.settings.pandocPath || "pandoc"
      ));
      return null;
    }
    new Notice(`Dendrite: wrote ${rel}. Open it in Word, set the Normal and heading styles, and save.`);
    return rel;
  }
  async exportPandoc(text, format, dir, name, ms, whole) {
    const s = this.plugin.settings;
    const base = this.app.vault.adapter.getBasePath ? this.app.vault.adapter.getBasePath() : "";
    const nodePath = require("path");
    const rel = normalizePath(`${dir}/${name}.${format}`);
    const output = nodePath.join(base, rel);
    const csl = ms.csl ? nodePath.join(base, ms.csl) : null;
    const inVault = (p) => p ? nodePath.join(base, p) : null;
    const style = Object.assign({}, ms.style, {
      defaults: inVault(ms.style.defaults),
      referenceDocx: inVault(ms.style.referenceDocx)
    });
    const notice = new Notice("Dendrite: exporting to " + (format === "pdf" ? "PDF" : "Word") + "\u2026", 0);
    const result = await pandoc.exportDocument({
      md: text,
      format,
      output,
      csl,
      style,
      port: s.zoteroPort,
      fallbackBib: s.fallbackBib || null,
      pandoc: s.pandocPath || "pandoc",
      engine: format === "pdf" ? s.pdfEngine || "xelatex" : null,
      resourcePath: base,
      resolve: (link) => {
        const f = this.app.metadataCache.getFirstLinkpathDest(
          link,
          this.file.path
        );
        return f ? nodePath.join(base, f.path) : null;
      }
    }, this.plugin.pandocDeps());
    notice.hide();
    if (result.error) {
      new Notice(`Dendrite: ${result.error}`, 12e3);
      return;
    }
    const cites = result.keys.length ? ` with ${result.keys.length} citation(s)` : "";
    new Notice(`Dendrite: exported to ${rel}${cites}.`);
    if (whole) this.offerRound();
    const bodies = whole ? await this.loadBodies() : null;
    const counted = whole ? core.countManuscript(
      this.root.children,
      (id) => bodies.get(id),
      (id) => this.printRoleOf(id),
      ms.countSpaces,
      this.floatOpts(true)
    ) : null;
    const rate = whole ? pandoc.measuredRate(
      counted.words,
      result.layout,
      result.keys.length > 0,
      counted.pages
    ) : null;
    if (rate && rate !== ms.wordsPerPageMeasured) {
      await writeProps(
        this.app,
        this.file,
        { dendrite_measured_words_per_page: rate }
      );
    }
    await this.plugin.showExport(rel, output, format);
  }
};
var DendritePreview = class extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null;
    this.showLeft = false;
    this.notesAt = "section";
    this.showComments = false;
    this.reviewList = [];
    this.reviewAt = -1;
    this.blocks = /* @__PURE__ */ new Map();
    this.segs = /* @__PURE__ */ new Map();
    this.bodies = /* @__PURE__ */ new Map();
    this.active = null;
  }
  getViewType() {
    return PREVIEW;
  }
  getIcon() {
    return "scroll-text";
  }
  getDisplayText() {
    return this.file ? `Preview: ${this.file.basename}` : "Dendrite preview";
  }
  getState() {
    return {
      file: this.file ? this.file.path : null,
      showLeft: this.showLeft,
      notesAt: this.notesAt,
      showComments: this.showComments
    };
  }
  async setState(state, result) {
    const f = state && state.file && this.app.vault.getAbstractFileByPath(state.file);
    this.showLeft = !!(state && state.showLeft);
    this.showComments = !!(state && state.showComments);
    this.notesAt = NOTES_AT[state && state.notesAt] ? state.notesAt : "section";
    if (f instanceof TFile) {
      this.file = f;
      this.build();
      await this.refresh();
    }
    return super.setState(state, result);
  }
  async onOpen() {
    this.contentEl.addClass("dendrite-preview");
    this.observer = new IntersectionObserver(
      (entries) => this.onVisible(entries),
      { root: null, rootMargin: "800px 0px" }
    );
    const changed = (f) => {
      if (!(f instanceof TFile) || !this.file) return;
      if (f === this.file || this.segs.has(f.basename)) {
        this.scheduleRefresh();
      }
    };
    this.registerEvent(this.app.vault.on("modify", changed));
    this.registerEvent(this.app.metadataCache.on("changed", changed));
    for (const e of ["create", "delete", "rename"]) {
      this.registerEvent(this.app.vault.on(e, () => {
        if (this.notes) this.notes.clear();
      }));
    }
    this.registerEvent(this.app.vault.on("rename", (f) => {
      if (f === this.file) this.leaf.updateHeader();
      else changed(f);
    }));
    this.registerDomEvent(this.contentEl, "click", (e) => {
      if (openInImageToolkit(this.app, e)) return;
      const b = e.target.closest(".dendrite-pblock");
      if (b && !b.dataset.notes && this.file) {
        this.plugin.focusCard(this.file, b.dataset.id, false);
      }
    });
    this.registerDomEvent(this.contentEl, "dblclick", (e) => {
      const b = e.target.closest(".dendrite-pblock");
      if (b && !b.dataset.notes && this.file) {
        this.plugin.focusCard(this.file, b.dataset.id, true);
      }
    });
  }
  async onClose() {
    if (this.idleDraw) this.idleDraw.stop();
    if (this.observer) this.observer.disconnect();
    if (this.resizer) this.resizer.disconnect();
    for (const b of this.blocks.values()) {
      if (b.comp) b.comp.unload();
    }
    this.blocks.clear();
  }
  build() {
    const el = this.contentEl;
    el.empty();
    this.blocks.clear();
    const bar = el.createDiv({ cls: "dendrite-bar" });
    barSwitch(
      bar,
      "Which text the preview shows",
      [
        [true, "All", "Also show, dimmed, the text that does not print: notes and comments"],
        [false, "Printed", "Show only the text that prints"]
      ],
      this.showLeft,
      (v) => {
        this.showLeft = v;
        this.app.workspace.requestSaveLayout();
        this.refresh();
      }
    );
    const comments = barButton(
      bar,
      "message-square",
      "Comments",
      "Show review comments and suggested changes beside the text, as Word and Google Docs do, to go through them one by one",
      () => {
        this.showComments = !this.showComments;
        comments.toggleClass("is-on", this.showComments);
        this.reviewAt = -1;
        this.app.workspace.requestSaveLayout();
        this.refresh();
      }
    );
    comments.addClass("is-toggle");
    comments.toggleClass("is-on", this.showComments);
    this.navEl = bar.createDiv({ cls: "dendrite-pcomments-nav" });
    const navBtn = (icon, label, d) => barButton(
      this.navEl,
      icon,
      "",
      label,
      () => this.stepComment(d)
    );
    navBtn("chevron-left", "Previous comment", -1);
    this.posEl = this.navEl.createSpan(
      { cls: "dendrite-pcomments-pos" }
    );
    navBtn("chevron-right", "Next comment", 1);
    const notes = barButton(
      bar,
      "list-end",
      "Footnotes",
      "Where footnotes are shown",
      (e) => {
        const m = dendriteMenu(false);
        for (const [v, label] of Object.entries(NOTES_AT)) {
          m.addItem((i) => {
            i.setTitle(label).onClick(() => {
              this.notesAt = v;
              this.app.workspace.requestSaveLayout();
              this.refresh();
            });
            if (typeof i.setChecked === "function") {
              i.setChecked(this.notesAt === v);
            }
          });
        }
        if (e && m.showAtMouseEvent) m.showAtMouseEvent(e);
      },
      true
    );
    notes.addClass("dendrite-bar-gap-before");
    this.doc = el.createDiv({ cls: "dendrite-preview-doc markdown-preview-view markdown-rendered" });
    this.doc.addEventListener("mouseover", (e) => this.hoverComment(this.commentAt(e.target)));
    this.doc.addEventListener("wheel", (e) => {
      const knots = this.showComments && this.commentKnots;
      if (!knots || e.ctrlKey || !e.deltaY || e.target.closest(".dendrite-pgutter")) return;
      const line = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.doc.clientHeight : 1;
      const t = core.textAt(this.doc.scrollTop, knots);
      const to = core.scrollFor(Math.max(0, t + e.deltaY * line), knots);
      e.preventDefault();
      this.doc.scrollTop = Math.max(0, to);
    }, { passive: false });
    this.doc.addEventListener("scroll", () => {
      this.drawWhenIdle();
      if (this.shiftFrame) return;
      const win = this.doc.ownerDocument.defaultView;
      this.shiftFrame = win.requestAnimationFrame(() => {
        this.shiftFrame = null;
        this.keepPace();
      });
    });
    if (this.resizer) this.resizer.disconnect();
    if (typeof ResizeObserver !== "undefined") {
      this.resizer = new ResizeObserver(() => {
        if (this.fitFrame) return;
        const win = this.doc.ownerDocument.defaultView;
        this.fitFrame = win.requestAnimationFrame(() => {
          this.fitFrame = null;
          this.fitComments();
        });
      });
      this.resizer.observe(this.doc);
    }
  }
  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 300);
  }
  cardFile(id) {
    this.notes = this.notes || /* @__PURE__ */ new Map();
    return noteOf(this.app, this.notes, id, this.file.path);
  }
  /** Draw the preview again, saying so if it fails rather than blank. */
  async refresh() {
    try {
      await this.refreshNow();
    } catch (err) {
      this.failed(err);
    }
    this.drawWhenIdle();
  }
  /** A failure to draw, shown once while the preview is open. */
  failed(err) {
    console.error("Dendrite: the preview could not draw", err);
    if (this.failShown) return;
    this.failShown = true;
    new Notice(`Dendrite: the preview could not draw: ${err && err.message || err}`, 15e3);
  }
  /**
   * Parts drawn while the preview is idle, as well as when they scroll
   * into view, so a scroll or a card selected on the board does not
   * stop to draw them; and so they are drawn where the observer is
   * never told they are in view, as on an iPad (idleDrawer).
   */
  drawWhenIdle() {
    if (!this.idleDraw) {
      this.idleDraw = idleDrawer(
        () => this.doc && this.doc.ownerDocument.defaultView || window,
        () => this.nextToDraw(),
        () => Date.now() - (this.plugin.typedAt || 0) < 1e3
      );
    }
    this.idleDraw.schedule();
  }
  /**
   * The waiting parts nearest the middle of the view, up to
   * DRAW_BATCH, drawn together; or null. Only parts within DRAW_REACH
   * screens of the view are drawn, so a long document keeps only the
   * part around the reader drawn; with none of those waiting, drawn
   * parts beyond EMPTY_REACH screens are emptied, keeping their
   * heights. The drawn parts' heights, read on the way, are learnt
   * from for those never drawn (partHeight).
   */
  nextToDraw() {
    if (!this.doc) return null;
    const v = this.doc.getBoundingClientRect();
    if (!v.width || !v.height) return null;
    const mid = v.top + v.height / 2;
    const reach = v.height / 2 + DRAW_REACH * v.height;
    const away = v.height / 2 + EMPTY_REACH * v.height;
    this.samples = this.samples || /* @__PURE__ */ new Map();
    const near = [];
    const far = [];
    for (const [id, b] of this.blocks) {
      if (b.el.hasClass("is-empty") || !this.doc.contains(b.el)) {
        continue;
      }
      const r = b.el.getBoundingClientRect();
      const d = Math.abs(r.top + r.height / 2 - mid);
      if (!b.el.hasClass("is-pending")) {
        if (r.height && b.lines) {
          this.samples.set(id, [b.lines, r.height]);
          this.fit = null;
        }
        if (d > away && id !== this.active) far.push([id, r.height]);
        continue;
      }
      if (d <= reach) near.push([d, id]);
    }
    if (!near.length) {
      for (const [id, h] of far) this.emptyPart(id, h);
      return null;
    }
    near.sort((a, b) => a[0] - b[0]);
    return Promise.all(near.slice(0, DRAW_BATCH).map(([, id]) => this.renderBlock(id).catch((err) => this.failed(err))));
  }
  /** How many lines a part's text would take, roughly: its length. */
  partLines(s) {
    const chars = (s.text || "").length + (s.gathered ? 200 : 0);
    const perLine = Math.max(20, (this.textWidth || 600) / SLOT_CHAR);
    return Math.max(1, Math.ceil(chars / perLine));
  }
  /**
   * How tall a part waiting to be drawn is: as tall as when last drawn
   * with the same text, or, from the parts drawn so far, as its length
   * suggests (core.fitHeights).
   */
  partHeight(b) {
    if (b.measured && b.measured.key === b.key) return b.measured.h;
    if (!this.fit) {
      this.fit = core.fitHeights([...(this.samples || /* @__PURE__ */ new Map()).values()], HEIGHT_SAMPLES, SLOT_LINE);
    }
    const lines = b.lines || 1;
    return Math.max(SLOT_LINE, Math.round(this.fit ? this.fit.a + this.fit.b * lines : lines * SLOT_LINE + 16));
  }
  /** A drawn part emptied to wait again, at the height it was drawn. */
  emptyPart(id, h) {
    const b = this.blocks.get(id);
    if (!b || b.el.hasClass("is-pending")) return;
    if (h) b.measured = { key: b.key, h };
    if (b.comp) b.comp.unload();
    b.comp = null;
    b.el.empty();
    b.el.addClass("is-pending");
    setStyles(b.el, { height: `${this.partHeight(b)}px` });
    if (this.observer) this.observer.observe(b.el);
  }
  async refreshNow() {
    if (!this.file || !this.doc) return;
    this.textWidth = this.doc.clientWidth;
    const text = await this.app.vault.cachedRead(this.file);
    const root = core.parseIndex(core.splitFrontmatter(text).body).root;
    const fm = this.app.metadataCache.getFileCache(this.file)?.frontmatter || {};
    this.colours = review.reviewerColours(fm.dendrite_reviewer_colours);
    const signed = (this.plugin.settings || {}).replyName;
    if (signed && signed !== "Me" && this.colours.has(signed)) {
      this.colours.set("Me", this.colours.get(signed));
    }
    this.names = review.reviewerNames(fm.dendrite_reviewer_colours);
    const s = this.plugin.settings || {};
    if (s.presentName) {
      this.names.set(s.replyName || "Me", s.presentName);
      this.names.set("Me", s.presentName);
    }
    const colourOf = (who) => this.colours.get(who) || null;
    const top = Number(fm.dendrite_heading_top);
    const headingTop = top >= 1 && top <= 6 ? top : this.plugin.settings.headingTop;
    for (const n of core.allNodes(root)) {
      const f = this.cardFile(n.id);
      if (!f) continue;
      const had = this.bodies.get(n.id);
      if (had && had.mtime === f.stat.mtime) continue;
      this.bodies.set(n.id, { mtime: f.stat.mtime, body: core.splitFrontmatter(await this.app.vault.cachedRead(f)).body });
    }
    const props = (id) => {
      const f = this.cardFile(id);
      return f && this.app.metadataCache.getFileCache(f)?.frontmatter || {};
    };
    const kindOf = (id) => {
      const k = props(id).dendrite_kind;
      return core.KINDS.includes(k) ? k : null;
    };
    const roleOf = core.withKinds(
      (id) => core.cardRole(props(id)),
      kindOf
    );
    const hasHeading = (id) => {
      const f = this.cardFile(id);
      const s2 = f && this.app.metadataCache.getFileCache(f)?.sections;
      const first = (s2 || []).find((x) => x.type !== "yaml");
      return !!first && first.type === "heading";
    };
    const numbers = fm.dendrite_number_sections === true ? core.sectionNumbers(
      root.children,
      hasHeading,
      roleOf,
      kindOf
    ) : null;
    const segs = core.gatherFootnotes(
      core.renumberFootnotes(
        core.exportSegments(root.children, (id) => {
          const b = this.bodies.get(id);
          if (!b) return "";
          return this.showComments ? review.renderMarkdown(b.body, colourOf) : b.body;
        }, headingTop, numbers, roleOf, { kindOf })
      ).segments,
      this.notesAt
    );
    const statusOf = (id) => {
      const s2 = props(id).dendrite_status;
      return core.STATUSES.includes(s2) ? s2 : null;
    };
    const report = core.statusReport(root, statusOf, roleOf, (id) => {
      const b = this.bodies.get(id);
      return b ? review.countComments(review.reviewItems(b.body)) : 0;
    });
    this.flags = /* @__PURE__ */ new Map();
    for (const [id, info] of report.cards) {
      if (core.isFlag(info.own)) {
        this.flags.set(id, this.plugin.statusColour ? this.plugin.statusColour(info.own) : null);
      }
    }
    this.renderSegments(segs);
    this.listComments(segs);
  }
  /**
   * Every review comment the document prints, in reading order: those
   * whose number is in a printed card's text. A comment in a part of a
   * card that does not print, as under a heading-only card's heading,
   * is left out, as the document leaves it.
   */
  listComments(segs) {
    const list = [];
    if (this.showComments) {
      for (const sg of segs) {
        if (!sg.text || sg.gathered) continue;
        const body = (this.bodies.get(sg.id) || {}).body || "";
        const items = review.reviewItems(body);
        const shown = new Set([...sg.text.matchAll(
          /\bdendrite-item-(\d+)\b/g
        )].map((m) => Number(m[1])));
        items.forEach((item, n) => {
          if (!shown.has(n)) return;
          const g = review.googleOf(item);
          const had = g && list.find((x) => x.g === g);
          if (had) had.parts.push({ id: sg.id, n });
          else list.push({
            id: sg.id,
            n,
            item,
            g,
            parts: [{ id: sg.id, n }]
          });
        });
      }
    }
    const was = this.reviewList[this.reviewAt];
    const key = (x) => `${x.id}\0${review.reviewKeys(x.item)[0]}`;
    this.reviewList = list;
    let moved = false;
    if (was) {
      const k = list.findIndex((x) => key(x) === key(was));
      if (k >= 0) this.reviewAt = k;
      else moved = true;
    }
    if (this.reviewAt >= list.length) this.reviewAt = list.length - 1;
    this.doc.toggleClass("has-comments", this.showComments);
    if (!this.showComments) this.commentKnots = null;
    if (!this.showComments && this.gutterEl) {
      this.gutterEl.remove();
      this.gutterEl = null;
    } else if (this.gutterEl) {
      const keep = new Set(list.map((x) => `${x.id}\0${x.n}`));
      for (const el of [...this.gutterEl.children]) {
        if (!keep.has(`${el.dataset.id}\0${el.dataset.n}`)) {
          el.remove();
        }
      }
    }
    this.fitComments();
    this.navEl.toggleClass("is-hidden", !this.showComments);
    this.showPos();
    if (moved && this.reviewAt >= 0) this.goComment();
  }
  showPos() {
    const n = this.reviewList.length;
    this.posEl.setText(!n ? "No comments" : this.reviewAt < 0 ? `${n} comment${n === 1 ? "" : "s"}` : `${this.reviewAt + 1} of ${n}`);
    const cur = this.reviewList[this.reviewAt];
    for (const el of this.doc.querySelectorAll(".is-current")) {
      el.removeClass("is-current");
    }
    if (!cur) return;
    const b = this.blocks.get(cur.id);
    if (!b) return;
    const bubble = this.bubbleOf(cur.id, cur.n);
    if (bubble) bubble.addClass("is-current");
    for (const el of this.passagesOf(cur)) el.addClass("is-current");
    this.scheduleBubbles();
  }
  bubbleOf(id, n) {
    return this.gutterEl ? [...this.gutterEl.children].find((el) => el.dataset.id === id && Number(el.dataset.n) === n) || null : null;
  }
  /** Every passage of a comment's entry, in every card it is on. */
  passagesOf(entry) {
    return (entry.parts || [{ id: entry.id, n: entry.n }]).flatMap((p) => {
      const b = this.blocks.get(p.id);
      return b ? this.passageOf(b.el, p.n) : [];
    });
  }
  /**
   * The comment, of reviewList, whose passage or number `el` is in:
   * its number's index, found from a passage by the id it is held by,
   * or, in the old form, by the number after it; or null.
   */
  commentAt(el) {
    const at = el && el.closest && el.closest(
      "sup.dendrite-review-n, mark.dendrite-review-mark, .dendrite-review-old, .dendrite-review-new"
    );
    const block = at && at.closest(".dendrite-pblock");
    if (!block) return null;
    let sup = at.matches("sup") ? at : null;
    const rid = !sup && [...at.classList].find((c) => c.startsWith("dendrite-rid-"));
    if (rid) sup = block.querySelector(`sup.${rid}`);
    for (let x = at; !sup && x; x = x.nextElementSibling) {
      if (x.matches("sup.dendrite-review-n")) sup = x;
    }
    const k = sup && [...sup.classList].find((c) => c.startsWith("dendrite-item-"));
    if (!k) return null;
    const n = Number(k.slice("dendrite-item-".length));
    const id = block.dataset.id;
    return this.reviewList.find((x) => x.parts.some((p) => p.id === id && p.n === n)) || null;
  }
  /** One comment marked, its bubble and passages, or none, `entry`. */
  hoverComment(entry) {
    if (entry === this.hovered) return;
    const mark = (x, on) => {
      if (!x) return;
      for (const p of this.passagesOf(x)) p.toggleClass("is-hover", on);
      const b = this.bubbleOf(x.id, x.n);
      if (b) b.toggleClass("is-hover", on);
    };
    mark(this.hovered, false);
    this.hovered = entry;
    mark(entry, true);
    if (this.gutterEl) this.gutterEl.toggleClass("has-hover", !!entry);
  }
  /** A comment's passage in a card's drawn text, `n` its index. */
  passageOf(el, n) {
    return review.passageEls(el, n);
  }
  /**
   * Go to the next comment, or the one before, round from the end:
   * its card is drawn if it was not yet, its bubble brought into view,
   * and the card selected on the board.
   */
  async stepComment(d) {
    const list = this.reviewList;
    if (!list.length) return;
    this.reviewAt = this.reviewAt < 0 ? d > 0 ? 0 : list.length - 1 : (this.reviewAt + d + list.length) % list.length;
    await this.goComment();
  }
  /** Whether an element is wholly within the preview's view. */
  inView(el) {
    if (!this.doc) return false;
    const v = this.doc.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return v.height > 0 && r.top >= v.top && r.bottom <= v.bottom;
  }
  /** Bring the comment gone to into view, and select its card. */
  async goComment() {
    const cur = this.reviewList[this.reviewAt];
    if (!cur) return;
    const b = this.blocks.get(cur.id);
    if (b && b.el.hasClass("is-pending")) await this.renderBlock(cur.id);
    this.showPos();
    const at = b && this.passageOf(b.el, cur.n)[0];
    if (at && !this.inView(at)) {
      let t = 0;
      for (let e = at; e && e !== this.doc; e = e.offsetParent) {
        t += e.offsetTop;
      }
      if (!this.scrollToText(t, this.doc.clientHeight / 3) && at.scrollIntoView) {
        at.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
    if (this.file) this.plugin.focusCard(this.file, cur.id, false);
  }
  /**
   * The gutter right of the text that holds every card's comments, one
   * for the document, so the text keeps its own spacing.
   */
  gutter() {
    if (!this.gutterEl || this.gutterEl.parentElement !== this.doc) {
      this.gutterEl = this.doc.createDiv({ cls: "dendrite-pgutter" });
    }
    return this.gutterEl;
  }
  /** A card's review comments as bubbles in the gutter. */
  drawBubbles(id) {
    const gutter = this.gutter();
    for (const el of [...gutter.querySelectorAll(".dendrite-pbubble")]) {
      if (el.dataset.id === id) el.remove();
    }
    const body = (this.bodies.get(id) || {}).body || "";
    const items = review.reviewItems(body);
    const mark = (entry, on) => {
      for (const p of this.passagesOf(entry)) {
        p.toggleClass("is-hover", on);
      }
    };
    for (const entry of this.reviewList.filter((x) => x.id === id)) {
      const { n } = entry;
      const it = items[n];
      const c = this.colours && this.colours.get(it.author || "Reviewer");
      const el = gutter.createDiv({ cls: "dendrite-pbubble" + (it.kind === "suggest" ? " is-suggest" : "") + (c ? ` is-c-${c}` : "") });
      el.dataset.id = id;
      el.dataset.n = String(n);
      el.addEventListener("mouseenter", () => mark(entry, true));
      el.addEventListener("mouseleave", () => mark(entry, false));
      el.addEventListener("click", (e) => {
        if (e.target.closest("button, a")) return;
        e.stopPropagation();
        const k = this.reviewList.findIndex((x) => x.id === id && x.n === n);
        if (k < 0) return;
        this.reviewAt = k;
        this.goComment();
      });
      const meta = el.createDiv({ cls: "dendrite-review-meta" });
      review.shownAs(
        meta.createEl("b"),
        it.author || "Reviewer",
        (who) => this.names.get(who)
      );
      meta.appendText(` \xB7 ${review.shortDate(it.date)}`);
      if (entry.parts.length > 1) {
        meta.appendText(` \xB7 ${entry.parts.length} passages`);
      }
      const { text, url } = review.noteLink(it.text);
      if (url && it.kind !== "suggest") {
        meta.appendText(" ");
        const a = meta.createEl("a", {
          cls: "dendrite-review-link",
          text: "\u2197"
        });
        a.href = url;
        a.title = "Open this comment in Google Docs";
        externalLinks(meta);
      }
      const shown = el.createDiv({ cls: "dendrite-pbubble-text" });
      if (it.kind !== "suggest") {
        review.fillAddressed(
          shown,
          text,
          (who) => this.colours && this.colours.get(who)
        );
      } else {
        shown.textContent = !it.text.trim() ? "Suggests deleting this." : it.passage ? `Suggests: ${it.text.trim()}` : `Suggests adding: ${it.text.trim()}`;
      }
      for (const r of it.replies || []) {
        el.appendChild(review.replyRow(
          el.ownerDocument,
          r,
          (who) => this.names.get(who),
          (who) => this.colours && this.colours.get(who)
        ));
      }
      const row = el.createDiv({ cls: "dendrite-pbubble-btns" });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const who = it.author || "Reviewer";
        showCommentMenu(review.commentMenu(it), e, (what) => {
          if (this.plugin.reviewFromPreview) {
            this.plugin.reviewFromPreview(this.file, id, n, what);
          }
        }, this.plugin.reviewerColourFor ? {
          author: this.names.get(who) || who,
          current: c,
          pick: (to) => this.plugin.reviewerColourFor(
            this.file,
            who,
            to
          )
        } : null);
      });
      for (const [what, label, tip] of review.commentActions(it)) {
        const btn = row.createEl("button", { text: label });
        if (tip) btn.title = tip;
        btn.onclick = async (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          if (this.plugin.reviewFromPreview) {
            await this.plugin.reviewFromPreview(
              this.file,
              id,
              n,
              what
            );
          }
        };
      }
      const answer = row.createEl("button", { text: "Reply" });
      answer.title = "Answer this comment";
      answer.addEventListener("click", (e) => {
        e.stopPropagation();
        review.replyBox(el, async (t) => {
          if (this.plugin.reviewFromPreview) {
            await this.plugin.reviewFromPreview(
              this.file,
              id,
              n,
              "reply",
              t
            );
          }
        }, (box) => ownKeys(this.app, box));
        this.scheduleBubbles();
      });
    }
    const order = new Map(this.reviewList.map((x, k) => [`${x.id}\0${x.n}`, k]));
    const key = (el) => order.get(`${el.dataset.id}\0${el.dataset.n}`) ?? 1e9;
    for (const el of [...gutter.children].sort((a, b) => key(a) - key(b))) {
      gutter.appendChild(el);
    }
    this.fadeBubbles();
    this.scheduleBubbles();
    this.showPos();
  }
  scheduleBubbles() {
    if (this.bubbleFrame || !this.doc) return;
    const win = this.doc.ownerDocument.defaultView;
    this.bubbleFrame = win.requestAnimationFrame(() => {
      this.bubbleFrame = null;
      this.layoutBubbles();
    });
  }
  /**
   * Place the bubbles in their column, each level with its passage, a
   * crowded run pushed down (core.placeComments), and keep the column
   * long enough for them. Positions are read without the text's offset
   * (offsetTop ignores transforms), which is the scroll's to set.
   */
  layoutBubbles() {
    const gutter = this.gutterEl;
    const doc = this.doc;
    if (!gutter || !doc) return;
    const bubbles = [...gutter.querySelectorAll(".dendrite-pbubble")];
    const topIn = (el) => {
      let y = 0;
      for (let e = el; e && e !== doc; e = e.offsetParent) {
        y += e.offsetTop;
      }
      return y;
    };
    const anchors = bubbles.map((el) => {
      const b = this.blocks.get(el.dataset.id);
      const sup = b && this.passageOf(b.el, Number(el.dataset.n)).slice(-1)[0];
      const at = sup || b && b.el;
      return at ? topIn(at) : 0;
    });
    const heights = bubbles.map((el) => el.offsetHeight);
    const placed = core.placeComments(anchors, heights, 8);
    bubbles.forEach((el, k) => {
      el.style.top = `${placed.tops[k]}px`;
    });
    this.commentKnots = placed.knots;
    const last = [...this.blocks.values()].map((b) => b.el).filter((el) => el.parentElement === doc).slice(-1)[0];
    const end = last ? topIn(last) + last.offsetHeight : 0;
    const [c, t] = placed.knots[placed.knots.length - 1];
    gutter.style.minHeight = `${Math.max(0, end + c - t)}px`;
    this.keepPace();
  }
  /**
   * The text kept level with the comment column as it scrolls: moved
   * down by how far it lags the scroll, slower through a crowded run
   * of comments (core.textAt).
   */
  keepPace() {
    const doc = this.doc;
    if (!doc) return;
    const knots = this.showComments && this.commentKnots;
    const lag = knots ? doc.scrollTop - core.textAt(
      doc.scrollTop,
      knots
    ) : 0;
    doc.style.setProperty("--dendrite-lag", `${Math.round(lag)}px`);
  }
  /**
   * Scroll so the text at `t`, from the top of the text, shows `y`
   * below the preview's top; smooth, the comment column following.
   */
  scrollToText(t, y) {
    const doc = this.doc;
    const knots = this.commentKnots;
    if (!doc || !knots || !doc.clientHeight || !doc.scrollTo) {
      return false;
    }
    this.glideTo(Math.max(0, core.scrollFor(t - y, knots)));
    return true;
  }
  /**
   * Which bubble the column is laid out from: the comment gone to,
   * level with its mark; else the selected card's first comment, level
   * with the card's top; else none, -1.
   */
  bubbleFocus(bubbles) {
    const cur = this.reviewList[this.reviewAt];
    if (cur && (!this.active || cur.id === this.active)) {
      const k2 = bubbles.findIndex((el) => el.dataset.id === cur.id && Number(el.dataset.n) === cur.n);
      if (k2 >= 0) return { index: k2, at: "mark" };
    }
    const k = bubbles.findIndex((el) => el.dataset.id === this.active);
    return k >= 0 ? { index: k, at: "card" } : { index: -1, at: null };
  }
  /**
   * A card selected: the other cards' comments fade, when it has
   * comments of its own to set apart.
   */
  fadeBubbles() {
    const gutter = this.gutterEl;
    if (!gutter) return;
    const bubbles = [...gutter.querySelectorAll(".dendrite-pbubble")];
    const mine = bubbles.some((el) => el.dataset.id === this.active);
    for (const el of bubbles) {
      el.toggleClass("is-faded", mine && el.dataset.id !== this.active);
    }
  }
  /**
   * Lay the bubbles out again for the text as it now runs. The widths
   * themselves, the text's and the gutter's, are the stylesheet's,
   * worked out from the pane's width as it changes, so a pane being
   * resized moves them smoothly.
   */
  fitComments() {
    if (!this.doc) return;
    if (!this.showComments) {
      this.keepPace();
      return;
    }
    this.layoutBubbles();
  }
  renderSegments(segs) {
    this.segs = new Map(segs.map((s) => [s.id, s]));
    for (const [id, b] of this.blocks) {
      if (!this.segs.has(id)) {
        if (b.comp) b.comp.unload();
        b.el.remove();
        this.blocks.delete(id);
        if (this.gutterEl) {
          for (const el of [...this.gutterEl.children]) {
            if (el.dataset.id === id) el.remove();
          }
        }
      }
    }
    let prev = null;
    const said = (id) => !this.showComments ? "" : JSON.stringify(
      review.reviewItems((this.bodies.get(id) || {}).body || "").map((x) => [x.text, x.replies])
    );
    for (const s of segs) {
      const key = (this.showComments ? "c\0" : "") + s.text + "\0" + said(s.id) + "\0" + core.footnoteBlock(s.cardNotes || []) + "\0" + (this.showLeft ? s.left : "") + "\0" + this.notesAt + "\0" + (s.gathered ? core.footnoteBlock(s.gathered) : "");
      let b = this.blocks.get(s.id);
      if (!b) {
        const el = createDiv({ cls: "dendrite-pblock" });
        el.dataset.id = s.id;
        if (s.gathered) {
          el.addClass("dendrite-pnotes");
          el.dataset.notes = "true";
        }
        b = { el, key: null, comp: null };
        this.blocks.set(s.id, b);
      }
      const empty = !s.text && !(this.showLeft && s.left) && !s.gathered;
      b.el.toggleClass("is-empty", empty);
      b.el.toggleClass("is-left-out-only", !s.text);
      if (b.key !== key) {
        b.key = key;
        b.el.addClass("is-pending");
        if (this.observer && !empty) this.observer.observe(b.el);
      }
      b.lines = this.partLines(s);
      if (b.el.hasClass("is-pending")) {
        setStyles(b.el, { height: empty ? "" : `${this.partHeight(b)}px` });
      }
      b.el.toggleClass("is-active", s.id === this.active);
      const flag = this.flags && this.flags.has(s.id);
      b.el.toggleClass("is-flagged", !!flag);
      if (flag && this.flags.get(s.id)) {
        b.el.style.setProperty(
          "--dendrite-chip",
          this.flags.get(s.id)
        );
      }
      const at = prev ? prev.nextSibling : this.doc.firstChild;
      if (at !== b.el) this.doc.insertBefore(b.el, at);
      prev = b.el;
    }
  }
  onVisible(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      this.observer.unobserve(e.target);
      if (e.target.hasClass("is-pending")) {
        this.renderBlock(e.target.dataset.id).catch((err) => this.failed(err));
      }
    }
  }
  async renderBlock(id) {
    const b = this.blocks.get(id);
    const s = this.segs.get(id);
    if (!b || !s) return;
    b.el.removeClass("is-pending");
    if (b.comp) b.comp.unload();
    b.comp = new Component();
    b.comp.load();
    b.el.empty();
    b.el.removeClass("has-bubbles");
    b.el.style.minHeight = "";
    b.el.style.height = "";
    const f = this.cardFile(id);
    const path = f ? f.path : this.file.path;
    if (s.gathered) {
      await this.renderNotes(s.gathered, b);
      return;
    }
    if (s.text) {
      const notes = s.cardNotes && s.cardNotes.length ? "\n\n" + core.footnoteBlock(s.cardNotes) : "";
      await MarkdownRenderer.render(
        this.app,
        core.normaliseMarkdown(s.text + notes),
        b.el.createDiv(),
        path,
        b.comp
      );
      review.wrapPassages(b.el);
      b.el.toggleClass("is-notes-gathered", this.notesAt !== "card");
      if (this.notesAt !== "card") renumberRefs(b.el, s.refs || []);
    }
    if (this.showLeft && s.left) {
      await MarkdownRenderer.render(
        this.app,
        s.left,
        b.el.createDiv({ cls: "dendrite-left-out" }),
        path,
        b.comp
      );
    }
    if (this.showComments && s.text) this.drawBubbles(id);
    else this.scheduleBubbles();
  }
  /**
   * A gathered list of footnotes, rendered by Obsidian as a card's own
   * would be, then numbered as the document numbers them. The
   * references it needs to render are removed after.
   */
  async renderNotes(notes, b) {
    const md = notes.map((x) => `[^${x.n}]`).join(" ") + "\n\n" + core.footnoteBlock(notes);
    const el = b.el.createDiv();
    await MarkdownRenderer.render(
      this.app,
      md,
      el,
      this.file.path,
      b.comp
    );
    const items = el.querySelectorAll(".footnotes li");
    items.forEach((li, i) => {
      if (notes[i]) li.setAttribute("value", String(notes[i].n));
    });
    for (const r of [...el.querySelectorAll(".footnote-ref")]) {
      const p = r.closest("p");
      if (p && !p.closest(".footnotes")) p.remove();
    }
  }
  /**
   * Highlight the board's active card here, and bring it to the middle
   * of the preview, where the text around it can be read.
   */
  highlight(id) {
    this.active = id;
    for (const [bid, b2] of this.blocks) {
      b2.el.toggleClass("is-active", bid === id);
    }
    this.drawWhenIdle();
    this.fadeBubbles();
    this.scheduleBubbles();
    const b = this.blocks.get(id);
    if (b) {
      const view = this.doc ? this.doc.clientHeight : 0;
      const tall = view && b.el.offsetHeight > view * 0.8;
      const y = tall ? 16 : (view - b.el.offsetHeight) / 2;
      const done = this.showComments && this.scrollToText(b.el.offsetTop, y);
      if (!done && this.doc && this.doc.scrollTo) {
        this.glideTo(Math.max(0, b.el.offsetTop - y));
      }
    }
  }
  /**
   * Scroll the text to `top`, smoothly. From far away it jumps to within
   * a screen first and slides the rest: a long smooth scroll brought
   * every part it passed into view, each drawn only to leave it.
   */
  glideTo(top) {
    const doc = this.doc;
    const screen = doc.clientHeight;
    const by = top - doc.scrollTop;
    if (screen && Math.abs(by) > LONG_MOVE * screen) {
      doc.scrollTop = top - Math.sign(by) * screen;
    }
    doc.scrollTo({ top, behavior: "smooth" });
  }
};
function textProp(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function slots(fm, which) {
  const out = {};
  for (const k of ["left", "center", "right"]) {
    let v = fm[`dendrite_${which}_${k}`];
    if (Array.isArray(v)) v = v.map(String).join("\n");
    v = textProp(v);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
function exportStyle(fm) {
  const size = parseFloat(String(fm.dendrite_font_size || ""));
  const spacing = Number(fm.dendrite_line_spacing);
  let margin = textProp(String(fm.dendrite_margin || ""));
  if (margin && /^\d+(\.\d+)?$/.test(margin)) margin += "cm";
  let gap = String(fm.dendrite_footnote_gap ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(gap)) gap += "pt";
  if (!/^\d+(\.\d+)?(pt|bp|mm|cm|in|em|ex)$/.test(gap)) gap = null;
  return {
    font: textProp(fm.dendrite_font),
    fontSize: size > 0 ? size : null,
    margin,
    paper: ["letter", "a4"].includes(fm.dendrite_paper) ? fm.dendrite_paper : null,
    lineSpacing: spacing > 0 ? spacing : null,
    pageNumbers: fm.dendrite_page_numbers !== false,
    defaults: textProp(fm.dendrite_pandoc_defaults),
    referenceDocx: textProp(fm.dendrite_reference_docx),
    referencesTitle: fm.dendrite_references_title === false ? false : textProp(fm.dendrite_references_title),
    footnoteGap: gap,
    header: slots(fm, "header"),
    footer: slots(fm, "footer"),
    headerInMargin: fm.dendrite_header_in_margin === true
  };
}
function nodeRequest(url, init) {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const body = init.body || "";
    const req = http.request(url, {
      method: init.method,
      headers: Object.assign(
        {},
        init.headers,
        { "Content-Length": Buffer.byteLength(body) }
      ),
      timeout: 3e4
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        data += c;
      });
      res.on("end", () => resolve({
        status: res.statusCode,
        json: async () => JSON.parse(data)
      }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(body);
  });
}
function tickBeforeKey(item) {
  const dom = item.dom;
  const tick = item.checkIconEl || dom && dom.querySelector(":scope > .menu-item-icon.mod-checked");
  const key = dom && dom.querySelector(".dendrite-menu-key");
  if (tick && key) key.before(tick);
}
function renumberRefs(el, refs) {
  for (const a of el.querySelectorAll(".footnote-ref a, a.footnote-ref")) {
    a.textContent = a.textContent.replace(/\d+/, (d) => String(refs[Number(d) - 1] || d));
  }
}
function quotaSetting(container, name, desc, current, required, draft) {
  let amount = current ? core.fmtNum(current.amount) : "";
  let unit = current ? current.unit : "words";
  let req = !!required;
  const emit = () => {
    const n = core.parseAmount(amount);
    const ok = amount.trim() && n > 0;
    draft.dendrite_limit = ok ? core.formatLimit({ amount: n, unit }) : null;
    draft.dendrite_limit_required = ok && req ? true : null;
  };
  new Setting(container).setName(name).setDesc(desc).addText((t) => t.setPlaceholder("none, or 500, or 1/4").setValue(amount).onChange((v) => {
    amount = v;
    emit();
  })).addDropdown((d) => d.addOption("words", "words").addOption("characters", "characters").addOption("pages", "pages").setValue(unit).onChange((v) => {
    unit = v;
    emit();
  }));
  new Setting(container).setName("Hard limit").setDesc("On: a limit that cannot be exceeded, such as one a call sets, shown red when exceeded. Off: a soft limit, your own allocation, shown amber.").addToggle((tg) => tg.setValue(req).onChange((v) => {
    req = v;
    emit();
  }));
}
var ManuscriptModal = class _ManuscriptModal extends Modal {
  constructor(view) {
    super(view.app);
    this.view = view;
  }
  /**
   * The manuscript's settings in tabs, one shown at a time, all written
   * together by Save. It opens on the tab last used.
   */
  onOpen() {
    const { contentEl } = this;
    const view = this.view;
    const ms = view.manuscript();
    const st = ms.style;
    const draft = {};
    this.modalEl.addClass("dendrite-ms-modal");
    this.titleEl.setText(`${view.file.basename}: Settings`);
    const body = contentEl.createDiv({ cls: "dendrite-ms-body" });
    const tabs = body.createDiv({ cls: "dendrite-ms-tabs" });
    const panes = body.createDiv({ cls: "dendrite-ms-panes" });
    const sections = [];
    const show = (name) => {
      for (const sec of sections) {
        sec.tab.toggleClass("is-active", sec.name === name);
        sec.pane.toggleClass("is-hidden", sec.name !== name);
      }
      _ManuscriptModal.lastTab = name;
    };
    const section = (name, icon, intro) => {
      const tab = tabs.createEl("button", { cls: "dendrite-ms-tab" });
      setIcon(tab.createSpan({ cls: "dendrite-ms-tab-icon" }), icon);
      tab.createSpan({ text: name });
      tab.onclick = () => show(name);
      const pane = panes.createDiv({ cls: "dendrite-ms-pane" });
      pane.dataset.tab = name;
      if (intro) pane.createEl("p", {
        cls: "dendrite-ms-intro",
        text: intro
      });
      sections.push({ name, tab, pane });
      return pane;
    };
    const text = (el2, name, desc, value, key, placeholder) => new Setting(el2).setName(name).setDesc(desc).addText((t) => t.setPlaceholder(placeholder || "").setValue(value === null || value === void 0 ? "" : String(value)).onChange((v) => {
      draft[key] = v.trim() || null;
    }));
    let el = section("Manuscript", "book-open");
    new Setting(el).setName("Title and prefix").setDesc(`The index is ${view.file.basename}, and card IDs start ${ms.prefix}. Renaming changes both, with every card note and the folder.`).addButton((b) => b.setButtonText("Rename\u2026").onClick(() => {
      this.close();
      new RenameModal(view).open();
    }));
    new Setting(el).setName("Number sections by position").setDesc("Write headings without numbers; sections are numbered from where they sit, and renumber when moved.").addToggle((tg) => tg.setValue(ms.number).onChange((v) => {
      draft.dendrite_number_sections = v;
    }));
    new Setting(el).setName("Top section heading level").setDesc("Export writes top-level sections at this level.").addDropdown((d) => {
      for (let i = 1; i <= 4; i++) d.addOption(String(i), "H" + i);
      d.setValue(String(ms.headingTop)).onChange((v) => {
        draft.dendrite_heading_top = Number(v);
      });
    });
    el = section("Length", "ruler", "The whole manuscript's quota, shown in the top bar against what it uses and what its sections allocate, and how words, characters and pages are counted.");
    quotaSetting(el, "Total quota", "In words, characters or pages; fractions allowed.", ms.limit, ms.limitRequired, draft);
    new Setting(el).setName("Count spaces in characters").setDesc("Funding portals differ; check the call.").addToggle((tg) => tg.setValue(ms.countSpaces).onChange((v) => {
      draft.dendrite_count_spaces = v;
    }));
    new Setting(el).setName("Words per page").setDesc(ms.wordsPerPageMeasured ? "Measured from the last PDF of the whole manuscript, and measured again at each one. A number typed here is used until then." : "For page estimates and page quotas, until a PDF of the whole manuscript is exported, which measures it.").addText((t) => t.setValue(String(ms.wordsPerPage)).onChange((v) => {
      draft.dendrite_words_per_page = Number(v) > 0 ? Number(v) : null;
      draft.dendrite_measured_words_per_page = null;
    }));
    new Setting(el).setName("Characters per word").setDesc("Only for comparing quotas set in characters with quotas in words or pages, an estimate.").addText((t) => t.setValue(String(ms.charsPerWord)).onChange((v) => {
      draft.dendrite_chars_per_word = Number(v) > 0 ? Number(v) : null;
    }));
    el = section("Page", "file", "How PDF and Word export set the page and its text. Word export takes these through its reference document, unless one is set under References.");
    text(
      el,
      "Font",
      "Any font installed on this computer. Empty: Latin Modern, LaTeX's own.",
      st.font,
      "dendrite_font",
      "Arial"
    );
    text(el, "Font size", "In points: 8, 9, 10, 11, 12, 14, 17 or 20. Empty: 10.", st.fontSize, "dendrite_font_size", "10");
    text(el, "Line spacing", "1 is single, 1.5 one and a half. Empty: single.", st.lineSpacing, "dendrite_line_spacing", "1");
    new Setting(el).setName("Paper").addDropdown((d) => d.addOption("letter", "US Letter").addOption("a4", "A4").setValue(st.paper || "letter").onChange((v) => {
      draft.dendrite_paper = v === "letter" ? null : v;
    }));
    text(el, "Margin", "On every side, such as 2cm or 1in. Empty: 2.5cm.", st.margin, "dendrite_margin", "2.5cm");
    text(
      el,
      "Space above footnotes",
      "For PDF, between the last line of text and the footnote rule, such as 14pt or 0.5cm; a bare number is in points. Empty: one line of text.",
      st.footnoteGap,
      "dendrite_footnote_gap",
      ""
    );
    el = section("Header and footer", "panel-top", "For PDF, on every page in the text's font and size. Each slot takes several lines, **bold**, *italic*, {page} and {pages}. A footer set replaces the page number at the foot; so does {page} anywhere.");
    const grid = el.createDiv({ cls: "dendrite-hf-grid" });
    for (const which of ["header", "footer"]) {
      const row = grid.createDiv({ cls: `dendrite-hf-row is-${which}` });
      row.createDiv({
        cls: "dendrite-hf-label",
        text: which === "header" ? "Header" : "Footer"
      });
      for (const [k, name] of [
        ["left", "Left"],
        ["center", "Centre"],
        ["right", "Right"]
      ]) {
        const key = `dendrite_${which}_${k}`;
        const now = st[which] && st[which][k];
        const ta = row.createEl(
          "textarea",
          { cls: "dendrite-hf-slot" }
        );
        ta.value = now || "";
        ta.placeholder = name;
        ta.rows = 2;
        ta.addEventListener("input", () => {
          draft[key] = ta.value.trim() || null;
        });
      }
      if (which === "header") {
        grid.createDiv({
          cls: "dendrite-hf-page",
          text: "the page's text"
        });
      }
    }
    new Setting(el).setName("Header and footer in the margin").setDesc("Print them in the page margin, so the text keeps its whole area, where the format allows it. Off, the margin is measured to them and nothing is printed in it. A small margin may not hold several lines.").addToggle((tg) => tg.setValue(st.headerInMargin).onChange((v) => {
      draft.dendrite_header_in_margin = v || null;
    }));
    new Setting(el).setName("Page numbers").setDesc("At the foot of each page, numbered consecutively, when no footer is set.").addToggle((tg) => tg.setValue(st.pageNumbers).onChange((v) => {
      draft.dendrite_page_numbers = v ? null : false;
    }));
    el = section("References", "quote", "Citations come from Zotero at export; these set how they and the rest of the document look. Paths are from the vault root.");
    text(el, "Citation style", "A CSL style file in the vault, for PDF and Word export. Empty: Pandoc's default, Chicago author-date.", ms.csl, "dendrite_csl", "styles/nature.csl");
    text(
      el,
      "Reference list heading",
      "Over the list of references, for a citation style that prints one. Empty: References.",
      st.referencesTitle || null,
      "dendrite_references_title",
      "References"
    );
    const ref = text(
      el,
      "Word reference document",
      "A .docx whose styles Word export copies, fonts and sizes included. Set its styles in Word.",
      st.referenceDocx,
      "dendrite_reference_docx",
      "styles/reference.docx"
    );
    if (Platform.isDesktopApp) {
      ref.addButton((b) => b.setButtonText("Make one").setTooltip("Writes Pandoc's own beside the index, to open in Word, restyle and save").onClick(async () => {
        const rel = await view.makeReferenceDocx();
        if (rel) draft.dendrite_reference_docx = rel;
      }));
    }
    text(
      el,
      "Pandoc defaults file",
      "For anything else a call asks, a Pandoc defaults file in the vault. The settings in these tabs win over it.",
      st.defaults,
      "dendrite_pandoc_defaults",
      "styles/grant.yaml"
    );
    el = section("Review", "message-square", "Comments and suggested changes come in from Review on the bar, only when you ask, and nothing is written to a card until you add them.");
    const linked = view.gdocUrl();
    const fm = view.app.metadataCache.getFileCache(view.file)?.frontmatter || {};
    const gdoc = new Setting(el).setName("Google Doc").setDesc(!Platform.isDesktopApp ? "Linked from Obsidian on a computer." : linked ? `Linked to ${fm.dendrite_gdoc_title || linked}.` : "The doc or Word file in Drive that coauthors review, chosen in Google's file picker, which gives Dendrite that file only.");
    if (Platform.isDesktopApp) {
      gdoc.addButton((b) => b.setButtonText(linked ? "Change\u2026" : "Link a Google Doc\u2026").onClick(async () => {
        this.close();
        await view.plugin.linkGdoc(view.file);
      }));
      if (linked) {
        gdoc.addButton((b) => b.setButtonText("Unlink").onClick(async () => {
          await writeProps(view.app, view.file, {
            dendrite_gdoc: null,
            dendrite_gdoc_title: null
          });
          this.close();
        }));
      }
    }
    show(sections.some((x) => x.name === _ManuscriptModal.lastTab) ? _ManuscriptModal.lastTab : "Manuscript");
    const foot = contentEl.createDiv({ cls: "dendrite-ms-foot" });
    foot.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const save = foot.createEl("button", {
      cls: "mod-cta",
      text: "Save"
    });
    save.onclick = async () => {
      await writeProps(view.app, view.file, draft);
      this.close();
    };
  }
  onClose() {
    this.contentEl.empty();
  }
};
var MAX_DIFF_ROWS = 300;
var VersionModal = class _VersionModal extends Modal {
  constructor(view, id) {
    super(view.app);
    this.view = view;
    this.id = id;
    this.labels = ["the note now", "the text from before"];
  }
  async onOpen() {
    const { contentEl, view, id } = this;
    const index = id === null;
    const f = index ? view.file : view.cardFile(id);
    const node = !index && view.byId.get(id);
    const name = index ? "The index" : `Card ${core.shortId(id)}` + (node && node.label ? ` (${node.label})` : "");
    const held = !index && view.held.has(id);
    this.titleEl.setText(held ? `${name} changed while you were typing in it` : `${name} changed to an older copy`);
    const now = f ? await view.app.vault.cachedRead(f) : "";
    const before = await view.newerText(id);
    const info = view.versionInfo.get(index ? "index" : id);
    const at = view.revertedAt.get(index ? "index" : id);
    const when = at ? ` at ${new Date(at).toLocaleString()}` : "";
    const p = (text) => contentEl.createEl("p", { text });
    if (index && view.dropped.size) {
      const n = view.dropped.size;
      const names = [...view.dropped].map(([k, label]) => core.shortId(k) + (label ? ` (${label})` : "")).join(", ");
      p(`It changed outside Dendrite${when} and no longer lists ${n} card${n === 1 ? "" : "s"} whose notes still exist: ${names}.`);
    } else if (held) {
      p(`It changed outside Dendrite${when}, usually from a sync, while you had typing in it not yet saved. The text from before is the card with your typing. Nothing has been written, and export waits until you choose.`);
    } else {
      p(`It changed outside Dendrite${when} to text this device had before.`);
    }
    const from = (x) => x.outside ? "came from outside Dendrite" : "was written on this device";
    const stamp = (x) => new Date(x.at).toLocaleString();
    if (!held && info && info.before && info.before.outside !== void 0) {
      p(`The text from before ${from(info.before)}, last at ${stamp(info.before)}.` + (info.before.outside ? " It can itself be the damaged or stale copy." : ""));
    }
    if (!held && info && info.now && info.now.outside !== void 0) {
      p(`The note now matches text this device had at ${stamp(info.now)}, which ${from(info.now)}.`);
    }
    if (!held) p("Usually a device with an old copy synced it, sometimes merged line by line with the current one. Restoring a backup yourself looks the same. Nothing has been written, and export waits until you choose.");
    if (before === null) {
      p("No earlier text is recorded on this device, so there is nothing to compare or put back here.");
    } else {
      this.showDiff(now, before);
    }
    const choice = (into, label, desc, cls, fn) => {
      const cell = into.createDiv({ cls: "dendrite-version-choice" });
      const b = cell.createEl("button", { cls, text: label });
      cell.createDiv({ cls: "dendrite-version-desc", text: desc });
      b.onclick = async () => {
        this.close();
        await fn();
      };
    };
    const sides = contentEl.createDiv(
      { cls: "dendrite-version-choices" }
    );
    choice(
      sides,
      "Keep the note now",
      "Clears this mark. Nothing is written.",
      "is-now",
      () => view.keepVersion(id)
    );
    if (before !== null) {
      choice(
        sides,
        "Put back the text from before",
        "Writes it over the note. Ctrl+Z on the board undoes it.",
        "is-before",
        () => view.restoreNewer(id)
      );
    }
    choice(
      contentEl,
      "Decide later",
      "Closes this. The mark stays, and export waits.",
      "",
      async () => {
      }
    );
  }
  /**
   * The lines that differ, with one line of context around each run,
   * unified or side by side; the choice is kept in the settings.
   */
  showDiff(now, before) {
    const settings = this.view.plugin.settings;
    const rows = core.lineDiff(now, before);
    const bar = this.contentEl.createDiv(
      { cls: "dendrite-version-modes" }
    );
    const box = this.contentEl.createDiv();
    const modes = [
      ["unified", "Unified", "rows-2"],
      ["split", "Side by side", "columns-2"]
    ];
    const draw = () => {
      const mode = settings.diffMode || "unified";
      const split = mode === "split";
      for (const b of bar.children) {
        b.toggleClass("is-active", b.dataset.mode === mode);
      }
      if (this.modalEl) this.modalEl.toggleClass("dendrite-wide", split);
      box.empty();
      if (!rows.some((r) => r[0] !== " ")) {
        box.createEl("p", { text: "The two texts are the same." });
      } else if (split) {
        this.drawSplit(box, rows);
      } else {
        this.drawUnified(box, rows);
      }
    };
    for (const [mode, label, icon] of modes) {
      const b = bar.createDiv({ cls: "clickable-icon" });
      b.setAttr("aria-label", label);
      setIcon(b, icon);
      b.dataset.mode = mode;
      b.onclick = () => {
        if ((settings.diffMode || "unified") !== mode) {
          settings.diffMode = mode;
          if (this.view.plugin.saveSettings) {
            this.view.plugin.saveSettings();
          }
        }
        draw();
      };
    }
    draw();
  }
  /** Whether each item is a change or next to one, to be shown. */
  static shown(changed) {
    return changed.map((c, i) => c || !!changed[i - 1] || !!changed[i + 1]);
  }
  /**
   * Each run of changed lines paired in order, the first line only in
   * the note now with the first only in the text from before, and so
   * on. Returns, per row, its words marked by charDiff, or null.
   */
  static marks(rows) {
    const out = rows.map(() => null);
    for (let i = 0; i < rows.length; ) {
      if (rows[i][0] === " ") {
        i++;
        continue;
      }
      const gone = [];
      const back = [];
      for (; i < rows.length && rows[i][0] !== " "; i++) {
        (rows[i][0] === "-" ? gone : back).push(i);
      }
      const n = Math.min(gone.length, back.length);
      for (let k = 0; k < n; k++) {
        const [a, b] = core.charDiff(
          rows[gone[k]][1],
          rows[back[k]][1]
        );
        out[gone[k]] = a;
        out[back[k]] = b;
      }
    }
    return out;
  }
  /**
   * A changed line's text, its changed words marked and any spaces in
   * them drawn, since a change in spaces alone would otherwise show as
   * nothing. A line of only spaces, or none, is marked whole.
   */
  static fillLine(el, line, marks) {
    if (!marks && !line.trim()) marks = [[line, true]];
    if (!marks) {
      el.createSpan({ text: line });
      return;
    }
    const shown = (t) => t.replace(/ /g, "\xB7").replace(/\t/g, "\u2192").replace(/\r/g, "\u240D").replace(/\u00a0/g, "\u237D");
    for (const [text, changed] of marks) {
      if (!changed) el.createSpan({ text });
      else el.createSpan({
        cls: "dendrite-version-change",
        text: shown(text)
      });
    }
    if (!line) {
      el.createSpan({
        cls: "dendrite-version-blank",
        text: "blank line"
      });
    }
  }
  drawUnified(box, rows) {
    const key = box.createEl("p", { cls: "dendrite-version-desc" });
    const [now, other] = this.labels;
    key.createSpan({ cls: "is-removed", text: `\u2212 ${now}` });
    key.createSpan({ text: " \xB7 " });
    key.createSpan({ cls: "is-added", text: `+ ${other}` });
    key.createSpan({ text: ", each line only in that one" });
    const pre = box.createDiv({ cls: "dendrite-version-diff" });
    const keep = _VersionModal.shown(rows.map((r) => r[0] !== " "));
    const marks = _VersionModal.marks(rows);
    let gap = false;
    let shown = 0;
    rows.forEach(([op, line], i) => {
      if (!keep[i]) {
        gap = true;
        return;
      }
      if (shown >= MAX_DIFF_ROWS) return;
      if (gap && shown) pre.createDiv({ text: "\u22EF" });
      gap = false;
      shown++;
      const cls = op === "+" ? "is-added" : op === "-" ? "is-removed" : "";
      const row = pre.createDiv({ cls });
      row.createSpan({
        cls: "dendrite-version-op",
        text: op === "-" ? "\u2212" : op
      });
      if (op === " ") row.createSpan({ text: line });
      else _VersionModal.fillLine(row.createSpan(), line, marks[i]);
    });
  }
  /**
   * Two columns, the note now and the text from before, a run of
   * changed lines paired row by row and the shorter side left blank.
   */
  drawSplit(box, rows) {
    const pairs = [];
    for (let i = 0; i < rows.length; ) {
      if (rows[i][0] === " ") {
        pairs.push([i, i, false]);
        i++;
        continue;
      }
      const gone = [];
      const back = [];
      for (; i < rows.length && rows[i][0] !== " "; i++) {
        (rows[i][0] === "-" ? gone : back).push(i);
      }
      for (let k = 0; k < Math.max(gone.length, back.length); k++) {
        pairs.push([
          k < gone.length ? gone[k] : null,
          k < back.length ? back[k] : null,
          true
        ]);
      }
    }
    const marks = _VersionModal.marks(rows);
    const table = box.createDiv({ cls: "dendrite-version-diff" }).createEl("table", { cls: "dendrite-version-split" });
    const head = table.createEl("tr");
    const cap = (t) => t[0].toUpperCase() + t.slice(1);
    head.createEl("th", { cls: "is-removed", text: cap(this.labels[0]) });
    head.createEl("th", { cls: "is-added", text: cap(this.labels[1]) });
    const keep = _VersionModal.shown(pairs.map((x) => x[2]));
    let gap = false;
    let shown = 0;
    pairs.forEach(([left, right, changed], i) => {
      if (!keep[i]) {
        gap = true;
        return;
      }
      if (shown >= MAX_DIFF_ROWS) return;
      if (gap && shown) {
        const tr2 = table.createEl("tr");
        tr2.createEl("td", { text: "\u22EF" });
        tr2.createEl("td", { text: "\u22EF" });
      }
      gap = false;
      shown++;
      const tr = table.createEl("tr");
      const cell = (r, cls) => {
        if (r === null) {
          tr.createEl("td", { cls: "is-blank" });
        } else if (!changed) {
          tr.createEl("td", { text: rows[r][1] });
        } else {
          _VersionModal.fillLine(
            tr.createEl("td", { cls }),
            rows[r][1],
            marks[r]
          );
        }
      };
      cell(left, "is-removed");
      cell(right, "is-added");
    });
  }
  onClose() {
    this.contentEl.empty();
  }
};
var SuggestModal = class extends VersionModal {
  constructor(view, id, now, after, apply, tint = null, replies = [], keep = null) {
    super(view, id);
    this.now = now;
    this.after = after;
    this.apply = apply;
    this.tint = tint;
    this.replies = replies;
    this.keep = keep;
    this.labels = ["the card now", "with the change"];
  }
  async onOpen() {
    const { contentEl, view, id } = this;
    this.modalEl.style.setProperty("--dendrite-now", "var(--text-muted)");
    this.modalEl.style.setProperty("--dendrite-before", this.tint ? review.colourCss(this.tint) : "var(--interactive-accent)");
    const node = view.byId.get(id);
    this.titleEl.setText(`Apply the suggested change to card ${core.shortId(id)}` + (node && node.label ? ` (${node.label})` : ""));
    contentEl.createEl("p", { text: "The passage it was made on is still in the card as the reviewer was sent it. Nothing has been written yet." });
    this.showDiff(
      review.stripReview(this.now),
      review.stripReview(this.after)
    );
    const many = this.replies.length > 1;
    if (this.replies.length) {
      const box = contentEl.createDiv({
        cls: "dendrite-suggest-replies"
      });
      box.createEl("p", { text: "Applying it removes its " + (many ? `${this.replies.length} replies:` : "reply:") });
      const list = box.createEl("ul");
      for (const r of this.replies) {
        list.createEl("li", { text: `${r.author}, ${review.shortDate(r.date)}: ${r.text}` });
      }
    }
    const row = contentEl.createDiv({ cls: "dendrite-version-choices" });
    const yes = row.createEl("button", {
      cls: "mod-cta",
      text: "Apply"
    });
    yes.onclick = async () => {
      this.close();
      await this.apply();
    };
    if (this.keep) {
      row.createEl("button", { text: "Apply, keep the " + (many ? "replies" : "reply") + " as a comment" }).onclick = async () => {
        this.close();
        await this.keep();
      };
    }
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }
};
var ReviewImportModal = class extends Modal {
  constructor(view, name, rows, inbox = null) {
    super(view.app);
    this.view = view;
    this.name = name;
    this.rows = rows;
    this.inbox = inbox;
  }
  onOpen() {
    const { contentEl, view, rows } = this;
    this.modalEl.addClass("dendrite-wide");
    this.titleEl.setText(`Review comments in ${this.name}`);
    const found = rows.filter((x) => x.at).length;
    const dups = rows.filter((x) => x.dup).length;
    const done = rows.filter((x) => x.done).length;
    const relinks = rows.filter((x) => x.relink).length;
    contentEl.createEl("p", { text: `${rows.length} comment${rows.length === 1 ? "" : "s"} and suggested change${rows.length === 1 ? "" : "s"}; ${found} found in the cards` + (dups ? `, ${dups} already in the cards` : "") + (done ? `, ${done} resolved here before` : "") + ". " + (relinks ? `${relinks} already in the cards will get ${relinks === 1 ? "its" : "their"} Google Docs link. ` : "") + // From a Google Doc or a Word file in Drive: whether any of its
    // comments has a link, which those kept inside a Word file,
    // not in Drive's own comments, do not.
    (this.name && /\(Google Docs\)$/.test(this.name) && rows.some((x) => x.item.kind === "comment") && !rows.some((x) => x.item.link) ? "None has a Google Docs link: its comments are kept inside the Word file, not in Google Docs' own comments, so Google gives them no link to their thread. " : "") + "Each goes after its passage in the card, which is set to revise. A change still made on the text as it was sent can be applied from its card later; one whose passage has changed since comes in as a comment. Nothing is written until you add them, and Ctrl+Z on the board undoes it." });
    const list = contentEl.createDiv({ cls: "dendrite-review-rows" });
    const active = view.active && view.byId.get(view.active);
    const count = () => rows.filter((x) => x.use).length;
    const linking = rows.filter((x) => x.relink).length;
    const addLabel = () => `Add ${count()}` + (linking ? ` and link ${linking}` : "");
    let go = null;
    for (const row of rows) {
      const it = row.item;
      const c = view.colourOf()(it.author || "Reviewer");
      const el = list.createDiv({ cls: "dendrite-review-row" + (it.kind === "change" ? " is-suggest" : "") + (c ? ` is-c-${c}` : "") });
      const box = el.createEl("input", { type: "checkbox" });
      box.checked = row.use;
      box.disabled = !row.at && !active;
      box.onchange = () => {
        row.use = box.checked;
        go.setText(addLabel());
      };
      const main = el.createDiv({ cls: "dendrite-review-main" });
      const meta = main.createDiv({ cls: "dendrite-review-meta" });
      review.shownAs(
        meta.createEl("b"),
        it.author || "Reviewer",
        view.nameOf()
      );
      meta.appendText(` \xB7 ${review.shortDate(it.date)} \xB7 ` + (it.kind === "change" ? "suggested change" : "comment"));
      if (it.quote) {
        main.createDiv({
          cls: "dendrite-review-quote",
          text: `\u201C${it.quote}\u201D`
        });
      }
      main.createDiv({
        cls: "dendrite-review-text",
        text: it.kind === "comment" ? it.text : !it.insert ? "Delete this." : it.quote ? `Replace with \u201C${it.insert.trim()}\u201D` : `Add \u201C${it.insert.trim()}\u201D`
      });
      const where = main.createDiv({ cls: "dendrite-review-where" });
      if (it.link) {
        const a = main.createEl("a", {
          cls: "dendrite-review-open",
          text: "Open in Google Docs"
        });
        a.href = it.link;
        a.onclick = (e) => {
          e.preventDefault();
          openExternal(it.link);
        };
      }
      if (row.done) {
        where.addClass("is-known");
        where.setText("Resolved here before: left unticked.");
      } else if (row.dup && row.relink) {
        where.setText(`Already in the card, ${core.shortId(row.at.id)}: gets its Google Docs link.`);
      } else if (row.dup) {
        where.addClass("is-known");
        where.setText(`Already in the card, ${core.shortId(row.at.id)}: left unticked.`);
      } else if (row.at && row.at.how === "mapped") {
        const node = view.byId.get(row.at.id);
        where.addClass("is-close");
        where.setText(`\u2192 card ${core.shortId(row.at.id)}` + (node && node.label ? ` (${node.label})` : "") + `, found in an earlier version of it, card ${core.shortId(row.at.from)}: placed where its text now is. Check it.`);
      } else if (row.at && row.at.how === "old") {
        const node = view.byId.get(row.at.id);
        where.addClass("is-close");
        where.setText(`\u2192 card ${core.shortId(row.at.id)}` + (node && node.label ? ` (${node.label})` : "") + `, found in an earlier version of it, card ${core.shortId(row.at.from)}: goes at the end of the current one, with the passage quoted.`);
      } else if (row.at) {
        const node = view.byId.get(row.at.id);
        if (row.at.how === "close") where.addClass("is-close");
        where.setText(`\u2192 card ${core.shortId(row.at.id)}` + (node && node.label ? ` (${node.label})` : "") + (row.at.how === "close" ? ", found by most of its words: check it" : ""));
      } else {
        where.addClass("is-missing");
        where.setText(active ? `Not found in the cards. Ticked, it goes at the end of the selected card, ${core.shortId(active.id)}, with the passage quoted.` : "Not found in the cards. Select a card to put it there instead.");
      }
    }
    const buttons = contentEl.createDiv(
      { cls: "dendrite-version-choices" }
    );
    go = buttons.createEl("button", {
      cls: "mod-cta",
      text: addLabel()
    });
    go.onclick = async () => {
      this.close();
      await view.addReview(
        rows.filter((x) => x.use),
        active,
        rows.filter((x) => x.relink)
      );
      if (this.inbox) await view.takeInbox(this.inbox, "added");
    };
    if (this.inbox) {
      buttons.createEl("button", { text: "Ignore this review" }).onclick = async () => {
        this.close();
        await view.takeInbox(this.inbox, "ignored");
      };
    }
    buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }
  onClose() {
    this.contentEl.empty();
  }
};
var IMAGE_EXT = /^(png|jpe?g|gif|svg|webp|bmp|tiff?|avif)$/i;
function noteSuggest(app, input, pick, images = false) {
  if (typeof AbstractInputSuggest !== "function") return null;
  class NoteSuggest extends AbstractInputSuggest {
    getSuggestions(query) {
      const q = query.replace(/^\s*!?\[\[|\]\]\s*$/g, "").trim();
      const files = images ? app.vault.getFiles().filter((f) => IMAGE_EXT.test(f.extension)) : app.vault.getMarkdownFiles();
      if (!q) return files.slice(0, 20);
      const match = typeof prepareFuzzySearch === "function" ? prepareFuzzySearch(q) : null;
      const scored = [];
      for (const f of files) {
        const name = f.path.replace(/\.md$/, "");
        const m = match ? match(name) : name.toLowerCase().includes(q.toLowerCase()) ? { score: 0 } : null;
        if (m) scored.push([m.score, f]);
      }
      return scored.sort((a, b) => b[0] - a[0]).slice(0, 20).map(([, f]) => f);
    }
    renderSuggestion(f, el) {
      el.createDiv({ text: images ? f.name : f.basename });
      if (f.parent && f.parent.path !== "/") {
        el.createDiv({
          cls: "dendrite-reviewer-path",
          text: f.parent.path
        });
      }
    }
    selectSuggestion(f) {
      this.setValue(images ? f.name : f.basename);
      this.close();
      pick(f);
    }
  }
  return new NoteSuggest(app, input);
}
var RoundModal = class extends Modal {
  constructor(view) {
    super(view.app);
    this.view = view;
  }
  onOpen() {
    this.titleEl.setText("Mark as sent for review");
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Keeps what each card prints now, so the board can show which cards change from here on."
    });
    const input = this.contentEl.createEl("input", { type: "text" });
    input.placeholder = "Sent to";
    input.addClass("dendrite-round-to");
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    const go = row.createEl("button", { text: "Record", cls: "mod-cta" });
    go.onclick = async () => {
      this.close();
      await this.view.recordRound(input.value);
      new Notice("Dendrite: recorded as sent for review.");
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        go.onclick();
      }
    });
    input.focus();
  }
  onClose() {
    this.contentEl.empty();
  }
};
var ReviewersModal = class extends Modal {
  constructor(view) {
    super(view.app);
    this.view = view;
  }
  /**
   * The reviewers as kept, then any only in the cards, in order; as
   * this dialog last saved them while the index is still as it was
   * read before, which would otherwise show a colour just picked as it
   * was.
   */
  entries() {
    const view = this.view;
    const fm = this.app.metadataCache.getFileCache(view.file)?.frontmatter || {};
    let kept = review.reviewerEntries(fm.dendrite_reviewer_colours);
    if (this.latest && JSON.stringify(kept) === this.latest.before) {
      kept = this.latest.saved.map((e) => Object.assign({}, e));
    } else {
      this.latest = null;
    }
    const map = view.reviewers();
    const order = [];
    for (const n of core.allNodes(view.root)) {
      for (const who of (view.reviewersOf || /* @__PURE__ */ new Map()).get(n.id) || []) {
        if (!order.includes(who)) order.push(who);
      }
    }
    for (const e of kept) if (!order.includes(e.name)) order.push(e.name);
    const others = view.otherSelves();
    const all = order.filter((name) => !others.includes(name)).map((name) => kept.find((e) => e.name === name) || { name, note: null, colour: map.get(name) || "blue" });
    const out = [];
    for (const e of all) {
      if (out.includes(e)) continue;
      out.push(e, ...all.filter((x) => x !== e && e.note && x.note === e.note));
    }
    return out;
  }
  onOpen() {
    this.modalEl.addClass("dendrite-reviewers-modal");
    this.titleEl.setText("Reviewers");
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Each reviewer's comments and suggested changes are drawn in their colour, kept for this manuscript. A reviewer who is a person can be linked to their note."
    });
    this.list = this.contentEl.createDiv({ cls: "dendrite-reviewers" });
    this.draw();
  }
  /** The entries saved, and the dialog drawn from them. */
  async save(now) {
    const fm = this.app.metadataCache.getFileCache(this.view.file)?.frontmatter || {};
    this.latest = { saved: now, before: JSON.stringify(
      review.reviewerEntries(fm.dendrite_reviewer_colours)
    ) };
    await this.view.saveEntries(now);
    this.draw();
  }
  draw() {
    this.list.empty();
    const entries = this.entries();
    const change = async (which, fn) => {
      const now = this.entries();
      for (const x of now) {
        if (which.some((y) => y.name === x.name)) fn(x, now);
      }
      await this.save(now);
    };
    const people = [];
    for (const e of entries) {
      const p = e.note && people.find((x) => x[0].note === e.note);
      if (p) p.push(e);
      else people.push([e]);
    }
    const find = (n) => this.app.metadataCache.getFirstLinkpathDest(
      n,
      this.view.file.path
    );
    const me = this.drawYou(entries);
    for (const names of people) {
      const e = names[0];
      if (names.length === 1 && me.has(e.name)) continue;
      const person = e.note ? e.note.split("/").pop() : e.name;
      const { block, mid } = this.row(
        "dendrite-reviewer",
        person,
        e.colour,
        (c) => change(names, (x) => {
          x.colour = c;
        })
      );
      block.dataset.name = e.name;
      block.dataset.person = person;
      const note = mid.createEl("input", {
        type: "text",
        cls: "dendrite-reviewer-note"
      });
      note.placeholder = "Their note, if a person";
      note.value = e.note ? e.note.split("/").pop() : "";
      const said = mid.createDiv({ cls: "dendrite-reviewer-said" });
      const link = (f) => {
        const to = f ? this.linktext(f) : null;
        return change(names, (x, now) => {
          const known = to && now.find((y) => y.note === to && !names.some((n) => n.name === y.name));
          x.note = to;
          if (known) x.colour = known.colour;
        });
      };
      noteSuggest(this.app, note, (f) => link(f));
      note.addEventListener("change", async () => {
        const v = note.value.trim().replace(/^\[\[|\]\]$/g, "");
        if (!v) {
          await link(null);
          return;
        }
        const f = find(v);
        if (f) await link(f);
        else said.setText(`No note named ${v}`);
      });
      if (e.note) {
        const as = mid.createDiv({ cls: "dendrite-reviewer-names" });
        as.createSpan({ text: "includes:" });
        for (const x of names) {
          const chip = as.createSpan({
            cls: "dendrite-reviewer-alias"
          });
          chip.dataset.name = x.name;
          chip.createSpan({ text: x.name });
          const off = chip.createEl("button", {
            cls: "dendrite-reviewer-unlink",
            text: "\xD7"
          });
          off.title = `Not ${person}: unlink ${x.name}`;
          off.onclick = () => change([x], (y) => {
            y.note = null;
          });
        }
        continue;
      }
      const named = find(e.name) || /\s\d+$/.test(e.name) && find(e.name.replace(/\s\d+$/, ""));
      if (named) {
        const b = mid.createEl("button", {
          cls: "dendrite-reviewer-offer",
          text: `Link [[${named.basename}]]`
        });
        b.onclick = () => link(named);
      }
    }
  }
  /**
   * One row of the dialog, laid out alike for You and each reviewer:
   * who, with their colour's dot; a middle part, returned to be
   * filled; and their colour, a button showing it that opens a menu of
   * the colours, each with its chip, `pick(colour)` told of the choice.
   */
  row(cls, name, colour, pick) {
    const block = this.list.createDiv({ cls });
    const who = block.createDiv({ cls: "dendrite-reviewer-who" });
    const dot = who.createSpan({ cls: "dendrite-reviewer-dot" });
    dot.style.background = review.colourCss(colour);
    who.createSpan({ cls: "dendrite-reviewer-name", text: name });
    const mid = block.createDiv({ cls: "dendrite-reviewer-mid" });
    const btn = block.createEl("button", {
      cls: "dendrite-reviewer-colour"
    });
    btn.dataset.colour = colour;
    btn.append(colourTitle(colour));
    btn.setAttr("aria-label", `Colour for ${name}`);
    btn.addEventListener("click", (e) => {
      const m = dendriteMenu(false);
      for (const c of review.REVIEWER_COLOURS) {
        m.addItem((i) => {
          i.setTitle(colourTitle(c)).onClick(() => pick(c));
          if (typeof i.setChecked === "function") {
            i.setChecked(c === colour);
          }
        });
      }
      if (m.showAtMouseEvent) m.showAtMouseEvent(e);
    });
    return { block, mid };
  }
  /**
   * You, at the top: your colour, the name your replies are signed with
   * in the cards, and the name you are shown as, on the board, in the
   * preview and in what is sent out. The name you sign with, or Me.
   */
  drawYou(entries) {
    const view = this.view;
    const s = view.plugin.settings;
    const me = s.replyName || "Me";
    const mine = view.selfNames();
    const own = entries.find((e) => e.name === me) || entries.find((e) => mine.has(e.name));
    const { mid } = this.row(
      "dendrite-reviewer-self",
      "You",
      own ? own.colour : "blue",
      async (c) => {
        const now = this.entries();
        const e = now.find((x) => x.name === me);
        if (e) e.colour = c;
        else now.push({ name: me, note: null, colour: c });
        await this.save(now);
      }
    );
    const field = (cls, label, value, placeholder, set) => {
      const at = mid.createEl("label", {
        cls: "dendrite-reviewer-self-field"
      });
      at.createSpan({ text: label });
      const input = at.createEl("input", { type: "text", cls });
      input.value = value || "";
      input.placeholder = placeholder;
      input.addEventListener("change", async () => {
        set(input.value.trim());
        if (view.plugin.saveSettings) await view.plugin.saveSettings();
        view.reviewerMap = null;
        view.recolour();
        this.draw();
      });
    };
    field(
      "dendrite-reviewer-signed",
      "Replies signed",
      s.replyName,
      "Me",
      (v) => {
        s.replyName = v;
      }
    );
    field(
      "dendrite-reviewer-shown",
      "Shown as",
      s.presentName,
      me,
      (v) => {
        s.presentName = v;
      }
    );
    return mine;
  }
  /** A note as a link reaches it: by its name, or its path if shared. */
  linktext(f) {
    const by = this.app.metadataCache.getFirstLinkpathDest(
      f.basename,
      this.view.file.path
    );
    return by === f ? f.basename : f.path.replace(/\.md$/, "");
  }
  onClose() {
    this.contentEl.empty();
  }
};
var GroupModal = class extends Modal {
  constructor(view) {
    super(view.app);
    this.view = view;
  }
  onOpen() {
    const { contentEl, view } = this;
    const n = view.picked.size;
    this.titleEl.setText(`Group ${n} cards under a new card`);
    const choices = [
      [
        "section",
        "Section with a heading",
        "A new section: you write its heading, and the cards become its subsections, numbered and printed a level down."
      ],
      [
        "scaffolding",
        "Scaffolding",
        "Only gathers them on the board: they print, and are numbered, as they are now."
      ]
    ];
    for (const [, label, desc] of choices) {
      const p = contentEl.createEl("p");
      p.createEl("b", { text: label });
      p.appendText(`: ${desc}`);
    }
    const row = contentEl.createDiv({ cls: "dendrite-version-choices" });
    for (const [kind, label] of choices) {
      const b = row.createEl("button", { text: label });
      if (kind === "section") b.addClass("mod-cta");
      b.onclick = async () => {
        this.close();
        await view.groupPicked(kind);
      };
    }
  }
  onClose() {
    this.contentEl.empty();
  }
};
var CommentModal = class extends Modal {
  constructor(app, send) {
    super(app);
    this.send = send;
  }
  onOpen() {
    this.titleEl.setText("Comment on the selection");
    const box = this.contentEl.createEl(
      "textarea",
      { cls: "dendrite-review-reply-box" }
    );
    box.rows = 3;
    box.placeholder = "Comment";
    const row = this.contentEl.createDiv(
      { cls: "dendrite-version-choices" }
    );
    const go = row.createEl("button", {
      text: "Comment",
      cls: "mod-cta"
    });
    go.onclick = () => {
      const t = box.value.trim();
      if (!t) return;
      this.close();
      this.send(t);
    };
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        go.onclick();
      }
    });
    box.focus();
  }
  onClose() {
    this.contentEl.empty();
  }
};
var StackModal = class extends Modal {
  constructor(view, id) {
    super(view.app);
    this.view = view;
    this.id = id;
  }
  onOpen() {
    this.ready = this.fill();
  }
  async fill() {
    const { contentEl, view } = this;
    contentEl.empty();
    this.modalEl.addClass("dendrite-wide");
    const node = view.byId.get(this.id);
    this.titleEl.setText("Versions of " + (node && node.label ? node.label : core.shortId(this.id)));
    contentEl.createEl("p", { text: "The newest first. Old versions are kept under the card, hidden on the board and left out of the manuscript. Making one current puts this card at the top of the stack; Ctrl+Z on the board undoes either." });
    const text = async (id) => {
      const f = view.cardFile(id);
      return f ? core.splitFrontmatter(
        await view.app.vault.read(f)
      ).body.trim() : "";
    };
    const list = contentEl.createDiv({ cls: "dendrite-stack" });
    const row = async (id, label) => {
      const el = list.createDiv({ cls: "dendrite-stack-row" });
      el.createDiv({ cls: "dendrite-review-meta", text: label });
      el.createDiv({
        cls: "dendrite-stack-text",
        text: await text(id) || "(empty)"
      });
      return el;
    };
    await row(this.id, "Current");
    for (const old of view.stackOf(this.id)) {
      const when = view.cardProps(old.id).dendrite_superseded;
      const el = await row(old.id, `Replaced ${when}, card ` + core.shortId(old.id));
      const buttons = el.createDiv({ cls: "dendrite-version-choices" });
      buttons.createEl("button", {
        cls: "mod-cta",
        text: "Make current"
      }).onclick = async () => {
        this.close();
        await view.promote(this.id, old.id);
      };
      buttons.createEl("button", {
        cls: "mod-warning",
        text: "Delete"
      }).onclick = async () => {
        await view.deleteVersion(old.id);
        if (view.stackOf(this.id).length) await this.fill();
        else this.close();
      };
    }
  }
  onClose() {
    this.contentEl.empty();
  }
};
var CardModal = class extends Modal {
  constructor(view, id) {
    super(view.app);
    this.view = view;
    this.id = id;
  }
  onOpen() {
    const { contentEl } = this;
    const view = this.view;
    const fm = view.cardProps(this.id);
    const aliases = Array.isArray(fm.aliases) ? fm.aliases : fm.aliases ? [fm.aliases] : [];
    const draft = {};
    this.titleEl.setText("Card properties");
    new Setting(contentEl).setName("Label").setDesc("Shown in the index when the card does not open with a heading. Stored as the card's first alias.").addText((t) => t.setValue(aliases[0] || "").onChange((v) => {
      const rest = aliases.slice(1);
      draft.aliases = v.trim() ? [v.trim(), ...rest] : rest.length ? rest : null;
    }));
    quotaSetting(
      contentEl,
      "Quota",
      "For this card and everything under it, counted from what export would write. Quotas on cards below are allocations from it.",
      core.parseLimit(fm.dendrite_limit),
      fm.dendrite_limit_required === true,
      draft
    );
    new Setting(contentEl).addButton((b) => b.setButtonText("Save").setCta().onClick(async () => {
      const f = view.cardFile(this.id);
      if (f) await writeProps(view.app, f, draft);
      this.close();
    }));
  }
  onClose() {
    this.contentEl.empty();
  }
};
async function addType(app, file, value) {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  const has = (v) => (Array.isArray(v) ? v : v ? [v] : []).some((x) => String(x).trim() === value);
  if (fm && has(fm.type)) return;
  await app.fileManager.processFrontMatter(file, (front) => {
    const list = Array.isArray(front.type) ? front.type : front.type ? [front.type] : [];
    if (!list.some((x) => String(x).trim() === value)) list.push(value);
    front.type = list;
  });
}
async function writeProps(app, file, draft) {
  if (!Object.keys(draft).length) return;
  await app.fileManager.processFrontMatter(file, (fm) => {
    for (const [k, v] of Object.entries(draft)) {
      if (v === null || v === void 0) delete fm[k];
      else fm[k] = v;
    }
  });
}
var RenameModal = class extends Modal {
  constructor(view) {
    super(view.app);
    this.view = view;
  }
  onOpen() {
    const { contentEl } = this;
    const view = this.view;
    let title = view.file.basename;
    let prefix = view.prefix() || "";
    this.titleEl.setText(`Rename ${title}`);
    new Setting(contentEl).setName("Title").setDesc("Names the index note, and its folder when the folder has the same name.").addText((t) => t.setValue(title).onChange((v) => {
      title = v;
    }));
    new Setting(contentEl).setName("Prefix").setDesc("Starts every card ID. Each card note is renamed to it, keeping its last five characters.").addText((t) => t.setValue(prefix).onChange((v) => {
      prefix = v.trim();
    }));
    contentEl.createEl("p", { text: "Let your other devices finish syncing first. A board open on another device follows the rename as it arrives and changes nothing until every card is there. A note under the old name that a device brings back later is marked on the board as an old copy and not used. Links elsewhere in the vault follow when Obsidian is set to update internal links. This is not an undo step; rename again to go back." });
    new Setting(contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close())).addButton((b) => b.setButtonText("Rename").setCta().onClick(async () => {
      this.close();
      await view.renameManuscript(title, prefix);
    }));
  }
  onClose() {
    this.contentEl.empty();
  }
};
var OldCopiesModal = class extends Modal {
  constructor(view) {
    super(view.app);
    this.view = view;
  }
  onOpen() {
    const { contentEl } = this;
    const view = this.view;
    contentEl.empty();
    this.titleEl.setText("Old copies from before the rename");
    contentEl.createEl("p", { text: "These notes carry a name this manuscript had before it was renamed. A device that had not synced the rename brought them back. The manuscript does not use them. If one holds writing you want, open it and copy the writing into the card it names, then move it to the trash." });
    for (const c of view.oldCopies) {
      const node = c.id && view.byId.get(c.id);
      const desc = c.id === null && prefixOf(this.app, c.file) ? "the index as it was" : node ? `old copy of card ${core.shortId(c.id)}` + (node.label ? ` (${node.label})` : "") : "a card the index does not list";
      new Setting(contentEl).setName(c.file.path).setDesc(desc).addButton((b) => b.setButtonText("Open").onClick(() => {
        this.app.workspace.getLeaf("tab").openFile(c.file);
      })).addButton((b) => b.setButtonText("Move to trash").setWarning().onClick(async () => {
        await this.app.fileManager.trashFile(c.file);
        view.checkOldCopies();
        if (view.oldCopies.length) this.onOpen();
        else this.close();
      }));
    }
  }
  onClose() {
    this.contentEl.empty();
  }
};
var NewManuscriptModal = class extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText("New Dendrite manuscript");
    let title = "";
    let prefix = "";
    new Setting(contentEl).setName("Title").setDesc("Names the folder and the index note.").addText((t) => t.setPlaceholder("Grant application 2026").onChange((v) => {
      title = v;
    }));
    new Setting(contentEl).setName("Prefix").setDesc("Starts every card ID, such as GRANT-2026. Letters, digits and hyphens; unique in the vault.").addText((t) => t.setPlaceholder("GRANT-2026").onChange((v) => {
      prefix = v.trim();
    }));
    new Setting(contentEl).addButton((b) => b.setButtonText("Create").setCta().onClick(async () => {
      const err = this.plugin.checkNew(title, prefix);
      if (err) {
        new Notice("Dendrite: " + err);
        return;
      }
      this.close();
      await this.plugin.createManuscript(safeName(title), prefix);
    }));
  }
  onClose() {
    this.contentEl.empty();
  }
};
var DendriteSettings = class extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  // Linter's ignore list follows the writing folder once the settings
  // are closed, not on every keystroke while the folder is typed.
  hide() {
    this.plugin.syncLinter();
    this.plugin.syncReviewApi();
  }
  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    const save = () => this.plugin.saveSettings();
    const heading = (name) => new Setting(containerEl).setName(name).setHeading();
    heading("Manuscripts");
    new Setting(containerEl).setName("Writing folder").setDesc("Where new manuscripts are created, one folder each.").addText((t) => t.setValue(s.writingFolder).onChange((v) => {
      s.writingFolder = v.trim();
      save();
    }));
    new Setting(containerEl).setName("Open index notes in Dendrite").setDesc("Opening an index note shows it in Dendrite. Its markdown stays one button away in the view.").addToggle((tg) => tg.setValue(s.openInDendrite).onChange((v) => {
      s.openInDendrite = v;
      save();
    }));
    new Setting(containerEl).setName("Index note type").setDesc("Added to each index note's type property, so file lists and colour rules can mark manuscripts. Empty adds none.").addText((t) => t.setValue(s.indexType).onChange((v) => {
      s.indexType = v.trim();
      save();
    }));
    new Setting(containerEl).setName("Card type").setDesc("Added to each card's type property. Plain text rather than a link keeps cards out of the vault's links. Empty adds none.").addText((t) => t.setValue(s.cardType).onChange((v) => {
      s.cardType = v.trim();
      save();
    }));
    new Setting(containerEl).setName("Top section heading level").setDesc("Export writes a top-level section card as this heading level, deeper sections one level down each. A manuscript can set its own in its Settings.").addDropdown((d) => {
      for (let i = 1; i <= 4; i++) d.addOption(String(i), "H" + i);
      d.setValue(String(s.headingTop)).onChange((v) => {
        s.headingTop = Number(v);
        save();
      });
    });
    heading("Board");
    new Setting(containerEl).setName("Card width").setDesc("In pixels.").addSlider((sl) => sl.setLimits(260, 640, 20).setValue(s.cardWidth).setDynamicTooltip().onChange((v) => {
      s.cardWidth = v;
      save();
      this.plugin.rerender();
    }));
    new Setting(containerEl).setName("Vim-style keys").setDesc("In normal mode: h j k l to move, i or a to edit, o and O for a new card below or above, n for a child, J and K to move a card, > and < to indent, dd to delete, u to undo, gg and G for the column's ends. Arrows, + - ] and [ work either way.").addToggle((tg) => tg.setValue(s.vimKeys).onChange((v) => {
      s.vimKeys = v;
      save();
    }));
    heading("Writing in cards");
    new Setting(containerEl).setName("Use Obsidian's editor in cards").setDesc("Live preview, link and citation suggestions, and editor commands inside a card. Off, or if Obsidian's editor cannot start, cards use a plain text box.").addToggle((tg) => tg.setValue(s.obsidianEditor).onChange((v) => {
      s.obsidianEditor = v;
      save();
    }));
    new Setting(containerEl).setName("Typewriter scrolling").setDesc("As you type in a card, the line with the cursor moves to the middle of the column. Clicking and selecting never move it. Off, the column moves only enough to keep the cursor in view.").addToggle((tg) => tg.setValue(s.typewriter).onChange((v) => {
      s.typewriter = v;
      save();
    }));
    new Setting(containerEl).setName("Autosave delay").setDesc("Milliseconds after the last keystroke before a card is written to its note. Leaving a card always saves at once.").addSlider((sl) => sl.setLimits(200, 3e3, 100).setValue(s.autosaveMs).setDynamicTooltip().onChange((v) => {
      s.autosaveMs = v;
      save();
    }));
    heading("PDF and Word export");
    new Setting(containerEl).setName("Pandoc").setDesc("The pandoc command, or its full path.").addText((t) => t.setValue(s.pandocPath).onChange((v) => {
      s.pandocPath = v.trim() || "pandoc";
      save();
    }));
    new Setting(containerEl).setName("PDF engine").setDesc("The LaTeX engine Pandoc uses for PDF, or its full path. TeX Live's usual folders are searched.").addText((t) => t.setValue(s.pdfEngine).onChange((v) => {
      s.pdfEngine = v.trim() || "xelatex";
      save();
    }));
    new Setting(containerEl).setName("Zotero port").setDesc("Where Better BibTeX answers on this computer.").addText((t) => t.setValue(String(s.zoteroPort)).onChange((v) => {
      s.zoteroPort = Number(v) > 0 ? Number(v) : 23119;
      save();
    }));
    new Setting(containerEl).setName("Fallback .bib").setDesc("Used when Zotero is not running. A full path on this computer, such as a Better BibTeX auto-export; empty stops the export instead.").addText((t) => t.setValue(s.fallbackBib).onChange((v) => {
      s.fallbackBib = v.trim();
      save();
    }));
    heading("Review");
    new Setting(containerEl).setName("Your name, on replies").setDesc("Replies you write to review comments are signed with this, as a reviewer's comments are with theirs.").addText((t) => t.setPlaceholder("Me").setValue(s.replyName).onChange((v) => {
      s.replyName = v.trim();
      save();
    }));
    new Setting(containerEl).setName("Accept reviews from programs on this computer").setDesc(`Listens on 127.0.0.1 for review comments sent by a program, such as an agent, with a key. Each waits on its manuscript's board, and nothing is written until you add it there. The port and key are in ${discoveryPath(this.app.vault.getName())} while Dendrite listens. Desktop only.`).addToggle((tg) => tg.setValue(!!s.reviewApi).onChange(async (v) => {
      s.reviewApi = v;
      await save();
      await this.plugin.syncReviewApi();
    }));
    new Setting(containerEl).setName("Review port").setDesc("0 for any free port. Taken, Dendrite listens on a free one instead. Applied when settings are closed.").addText((t) => t.setValue(String(s.reviewApiPort)).onChange((v) => {
      const n = Number(v);
      s.reviewApiPort = Number.isInteger(n) && n >= 0 && n < 65536 ? n : 27130;
      save();
    })).addButton((b) => b.setButtonText("New key").onClick(async () => {
      s.reviewApiKey = "";
      await save();
      await this.plugin.syncReviewApi(true);
      new Notice(`Dendrite: a new review key is in ${discoveryPath(this.app.vault.getName())}; the old one no longer works.`);
    }));
    heading("Google Docs");
    new Setting(containerEl).setName("Google OAuth client").setDesc("The JSON of a Desktop app client from your Google Cloud project, pasted whole. It syncs with the vault; Google treats a desktop client's secret as not confidential.").addTextArea((t) => t.setValue(s.googleClientJson || "").setPlaceholder('{"installed": {"client_id": ...}}').onChange((v) => {
      s.googleClientJson = v.trim();
      save();
      showAccount();
    }));
    new Setting(containerEl).setName("Google Picker API key").setDesc("An API key restricted to the Google Picker API, for choosing a manuscript's doc.").addText((t) => t.setValue(s.googlePickerKey || "").onChange((v) => {
      s.googlePickerKey = v.trim();
      save();
    }));
    let accountBtn = null;
    const account = new Setting(containerEl).setName("Google account").addButton((b) => {
      accountBtn = b;
      b.onClick(async () => {
        if (this.plugin.googleToken()) {
          await this.plugin.googleSignOut();
        } else {
          await this.plugin.googleSignIn();
        }
        this.display();
      });
    });
    const showAccount = () => {
      const signedIn = !!this.plugin.googleToken();
      const client = this.plugin.googleClient();
      account.setDesc(!client ? s.googleClientJson ? "The pasted text is not an OAuth client's JSON." : "Paste the OAuth client above first." : signedIn ? "Signed in. Dendrite reaches only the docs you link to a manuscript." : "Not signed in. Signing in opens your browser.");
      accountBtn.setButtonText(signedIn ? "Sign out" : "Sign in with Google").setDisabled(!client || !Platform.isDesktopApp);
    };
    showAccount();
    heading("Other plugins");
    new Setting(containerEl).setName("Keep Linter out of the writing folder").setDesc("Adds the writing folder to the Linter plugin's folders to ignore, so its rules never rewrite a card. Off removes the entry, if Dendrite added it.").addToggle((tg) => tg.setValue(s.manageLinter).onChange((v) => {
      s.manageLinter = v;
      save();
    }));
    new Setting(containerEl).setName("Clean up cards with Linter").setDesc(`When you leave a card you changed, run the Linter plugin's rules on it, except those that break cards: "File name heading" and "Capitalize headings".`).addToggle((tg) => tg.setValue(s.lintCards).onChange((v) => {
      s.lintCards = v;
      save();
    }));
    heading("Diagnostics");
    new Setting(containerEl).setName("Record timings").setDesc(`While on, writes how long each of Dendrite's steps took, and how often the window stalled, to ${vaultFile(this.app.vault.getName(), TIMINGS)} every 10 seconds, to find what makes it slow. Only step names and times are written, never text. Desktop only.`).addToggle((t) => t.setValue(!!s.recordTimings).setDisabled(!Platform.isDesktopApp).onChange((v) => {
      s.recordTimings = v;
      timing.setOn(v && Platform.isDesktopApp);
      save();
    }));
    new Setting(containerEl).setName("Say what moves the board").setDesc("While on, a notice each time the board moves sideways other than by hand: the steps that centred it, or that it moved with no touch and no centring. For finding what pulls the board back.").addToggle((t) => t.setValue(!!s.showBoardMoves).onChange((v) => {
      s.showBoardMoves = v;
      save();
    }));
  }
};
function callers(stack, skip = 1) {
  const out = [];
  for (const line of String(stack).split("\n").slice(1 + skip)) {
    const m = /^\s*at (?:async )?(?:[\w$]+\.)*([\w$]+) \(/.exec(line) || /^(?:[\w$]+\.)*([\w$]+)@/.exec(line.trim());
    if (m && !out.includes(m[1])) out.push(m[1]);
    if (out.length === 5) break;
  }
  return out;
}
timing.wrap(DendriteView.prototype, "board", [
  "render",
  "renderCard",
  "updateStatuses",
  "updateChanged",
  "updateNumbers",
  "updateCounts",
  "applyActive",
  "drawFlow",
  "loadBodies",
  "onModify",
  "onMetadata",
  "sweepStatuses",
  "startEdit",
  "endEdit",
  "centre",
  "followCaret",
  "onResize",
  "scheduleFlow",
  "animateOffsets",
  "newEditor",
  "focusEditor",
  "renderToolbar",
  "fillFrame",
  "emptyFar",
  "nextToDraw"
]);
timing.wrap(DendritePreview.prototype, "preview", [
  "refresh",
  "renderSegments",
  "renderBlock",
  "drawBubbles",
  "layoutBubbles",
  "keepPace",
  "fitComments",
  "listComments",
  "highlight"
]);
var TIMINGS = "timings.jsonl";
module.exports = class DendritePlugin extends Plugin {
  onunload() {
    this.stopReviewApi();
    this.writeTimings();
  }
  /**
   * What was timed since last written, appended to the timings file as
   * one line; the file kept under 5 MB by starting it again.
   */
  writeTimings() {
    if (!timing.isOn() || this.profiling) return;
    timing.watch(window);
    for (const t of [VIEW, PREVIEW]) {
      for (const l of this.app.workspace.getLeavesOfType(t)) {
        timing.watch(l.view.containerEl.ownerDocument.defaultView);
      }
    }
    const memory = this.memoryNow();
    const got = timing.take() || memory && {};
    if (!got) return;
    if (memory) got.memory = memory;
    try {
      const fs = require("fs");
      const file = vaultFile(this.app.vault.getName(), TIMINGS);
      fs.mkdirSync(require("path").dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 5e6) {
        fs.renameSync(file, file + ".old");
      }
      fs.appendFileSync(file, JSON.stringify(Object.assign({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        version: this.manifest && this.manifest.version
      }, got)) + "\n", { mode: 384 });
    } catch (err) {
      console.error("Dendrite: timings not written", err);
    }
  }
  /**
   * Dendrite's notices left on screen, hidden: those it keeps, and any
   * others showing whose text is its own, such as an earlier version's,
   * clicked away as a click would, in every window a board or preview
   * is open in.
   */
  dismissAllNotices() {
    dismissNotices();
    const docs = /* @__PURE__ */ new Set([document]);
    for (const t of [VIEW, PREVIEW]) {
      for (const l of this.app.workspace.getLeavesOfType(t)) {
        docs.add(l.view.containerEl.ownerDocument);
      }
    }
    for (const doc of docs) {
      for (const el of doc.querySelectorAll(".notice")) {
        if (el.textContent.startsWith("Dendrite:")) el.click();
      }
    }
  }
  /**
   * The window's memory, in MB, and how much of the boards and previews
   * open is drawn, for the timings file: `rss_mb` the window's process,
   * `heap_mb` its script heap, `nodes` the elements in Dendrite's
   * views, `cards` and `parts` those drawn of all there are. Written
   * even when nothing was timed, so memory can be followed while idle.
   */
  memoryNow() {
    let m;
    try {
      m = process.memoryUsage();
    } catch (err) {
      return null;
    }
    const mb = (x) => Math.round(x / 1048576);
    const out = {
      rss_mb: mb(m.rss),
      heap_mb: mb(m.heapUsed),
      nodes: 0,
      cards: [0, 0],
      parts: [0, 0]
    };
    for (const l of this.app.workspace.getLeavesOfType(VIEW)) {
      out.nodes += l.view.containerEl.getElementsByTagName("*").length;
      for (const el of (l.view.cardEls || /* @__PURE__ */ new Map()).values()) {
        out.cards[1]++;
        if (!el.hasClass("is-pending") && !el.hasClass("is-slot")) out.cards[0]++;
      }
    }
    for (const l of this.app.workspace.getLeavesOfType(PREVIEW)) {
      out.nodes += l.view.containerEl.getElementsByTagName("*").length;
      for (const b of (l.view.blocks || /* @__PURE__ */ new Map()).values()) {
        if (b.el.hasClass("is-empty")) continue;
        out.parts[1]++;
        if (!b.el.hasClass("is-pending")) out.parts[0]++;
      }
    }
    return out;
  }
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    timing.setOn(this.settings.recordTimings && Platform.isDesktopApp);
    this.registerInterval(window.setInterval(
      () => this.writeTimings(),
      1e4
    ));
    this.history = new History(idbStore());
    this.registerView(VIEW, (leaf) => new DendriteView(leaf, this));
    this.registerView(PREVIEW, (leaf) => new DendritePreview(leaf, this));
    this.addCommand({
      id: "open-preview",
      name: "Open the manuscript preview",
      checkCallback: (checking) => {
        const v = this.app.workspace.getActiveViewOfType(
          DendriteView
        );
        const f = v ? v.file : this.app.workspace.getActiveFile();
        if (!f || !isIndex(this.app, f)) return false;
        if (!checking) this.openPreview(f);
        return true;
      }
    });
    this.addCommand({
      id: "dismiss-notices",
      name: "Dismiss notices",
      callback: () => this.dismissAllNotices()
    });
    this.addSettingTab(new DendriteSettings(this.app, this));
    this.addRibbonIcon("list-tree", "Open in Dendrite", () => {
      const f = this.app.workspace.getActiveFile();
      if (f && isIndex(this.app, f)) this.openIndex(f);
      else new NewManuscriptModal(this).open();
    });
    this.addCommand({
      id: "open-index",
      name: "Open the current index note in Dendrite",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !isIndex(this.app, f)) return false;
        if (!checking) this.openIndex(f);
        return true;
      }
    });
    this.addCommand({
      id: "new-manuscript",
      name: "New manuscript",
      callback: () => new NewManuscriptModal(this).open()
    });
    this.markdownLeaves = /* @__PURE__ */ new WeakMap();
    this.app.workspace.onLayoutReady(() => this.syncReviewApi());
    this.registerEvent(this.app.workspace.on(
      "file-open",
      (f) => this.onFileOpen(f)
    ));
    this.registerEvent(this.app.workspace.on(
      "active-leaf-change",
      (leaf) => this.decorate(leaf)
    ));
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.iterateAllLeaves((l) => this.decorate(l));
      this.syncLinter();
    });
    const viewCommand = (id, name, needsEdit, run) => this.addCommand({
      id,
      name,
      checkCallback: (checking) => {
        const v = this.app.workspace.getActiveViewOfType(
          DendriteView
        );
        if (!v || (needsEdit ? !v.editing : !v.active)) return false;
        if (!checking) run(v);
        return true;
      }
    });
    viewCommand(
      "move-to-card-below",
      "Move selection, or the rest of the card, to a new card below",
      true,
      (v) => v.moveSelection("below")
    );
    viewCommand(
      "move-to-child-card",
      "Move selection, or the rest of the card, to a new child card",
      true,
      (v) => v.moveSelection("child")
    );
    viewCommand("comment-on-selection", "Comment on the selected passage", true, (v) => v.askComment());
    viewCommand("next-flagged", "Go to the next card to revise or finish splitting", false, (v) => v.nextFlagged(1));
    viewCommand("previous-flagged", "Go to the previous card to revise or finish splitting", false, (v) => v.nextFlagged(-1));
    viewCommand(
      "next-draft",
      "Go to the next draft card",
      false,
      (v) => v.nextFlagged(1, (i) => i.prints && i.own === "draft")
    );
    viewCommand("toggle-printed", "Show only the cards that print, or every card", false, (v) => v.togglePrintOnly());
    viewCommand(
      "import-review",
      "Import review comments from a returned Word file or a JSON list",
      false,
      (v) => v.importReview()
    );
    viewCommand(
      "pull-gdoc-review",
      "Pull review comments and suggested changes from the linked Google Doc",
      false,
      (v) => v.pullGdoc()
    );
    viewCommand("add-types", "Add the type property to the index and every card", false, (v) => v.sweepTypes());
    viewCommand(
      "merge-into-above",
      "Merge card into the card above",
      false,
      (v) => v.merge("above")
    );
    viewCommand(
      "merge-into-parent",
      "Merge card into its parent",
      false,
      (v) => v.merge("parent")
    );
    viewCommand(
      "profile",
      "Profile the board and preview, on a manuscript marked dendrite_profile",
      false,
      (v) => this.runProfile(v)
    );
    this.registerEvent(this.app.workspace.on(
      "editor-menu",
      (menu, editor, info) => {
        const v = this.app.workspace.getLeavesOfType(VIEW).map((l) => l.view).find((x) => x.editing && info && info.file === x.editing.file);
        if (!v) return;
        const sel = editor.somethingSelected();
        const what = sel ? "selection" : "rest of the card";
        menu.addSeparator();
        menu.addItem((i) => i.setTitle(`Move ${what} to a new card below`).setIcon("arrow-down").onClick(() => v.moveSelection("below")));
        menu.addItem((i) => i.setTitle(`Move ${what} to a new child card`).setIcon("corner-down-right").onClick(() => v.moveSelection("child")));
        if (sel) {
          menu.addItem((i) => i.setTitle("Comment on the selection").setIcon("message-square").onClick(() => v.askComment()));
        }
      }
    ));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, f) => {
      if (!isIndex(this.app, f)) return;
      menu.addItem((i) => i.setTitle("Open in Dendrite").setIcon("list-tree").onClick(() => this.openIndex(f)));
    }));
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  // ---- reviews submitted by programs ---------------------------------
  /**
   * Listen for reviews when the setting is on, on its port and key,
   * and stop when it is off; `force` restarts, as for a new key.
   */
  async syncReviewApi(force = false) {
    const s = this.settings;
    const want = s.reviewApi && Platform.isDesktopApp && Number.isInteger(s.reviewApiPort) ? s.reviewApiPort : null;
    if (!force && this.reviewServer && want === this.reviewPort && s.reviewApiKey === this.reviewKey) return;
    if (!force && !this.reviewServer && want === null) return;
    await this.stopReviewApi();
    if (want === null) return;
    if (!s.reviewApiKey) {
      s.reviewApiKey = require("crypto").randomBytes(24).toString("hex");
      await this.saveSettings();
    }
    const start = (port) => require_reviewapi().start({
      port,
      token: s.reviewApiKey,
      submit: (d) => this.submitReview(d),
      status: (id) => this.reviewStatus(id),
      threads: (m, opts) => this.threadsFor(m, opts),
      reply: (d) => this.replyTo(d),
      suggest: (d) => this.suggestTo(d)
    });
    try {
      try {
        this.reviewServer = await start(want);
      } catch (err) {
        if (err.code !== "EADDRINUSE" || want === 0) throw err;
        this.reviewServer = await start(0);
      }
    } catch (err) {
      new Notice(`Dendrite: could not listen for reviews on port ${want} (${err.message}).`, 1e4);
      return;
    }
    this.reviewPort = want;
    this.reviewKey = s.reviewApiKey;
    const fs = require("fs");
    const vault = this.app.vault.getName();
    const file = discoveryPath(vault);
    try {
      const old = configFile("review-api.json");
      if (JSON.parse(fs.readFileSync(old, "utf8")).vault === vault) {
        fs.unlinkSync(old);
      }
    } catch (err) {
    }
    fs.mkdirSync(require("path").dirname(file), { recursive: true });
    const base = `http://127.0.0.1:${this.reviewServer.address().port}/dendrite`;
    fs.writeFileSync(file, JSON.stringify({
      url: `${base}/review`,
      threads: `${base}/threads`,
      reply: `${base}/reply`,
      suggest: `${base}/suggest`,
      key: s.reviewApiKey,
      vault: this.app.vault.getName(),
      pid: process.pid
    }, null, 2) + "\n", { mode: 384 });
  }
  async stopReviewApi() {
    const server = this.reviewServer;
    if (!server) return;
    this.reviewServer = null;
    this.reviewPort = null;
    await new Promise((r) => server.close(() => r()));
    try {
      const fs = require("fs");
      const file = discoveryPath(this.app.vault.getName());
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      if (d.pid === process.pid && d.key === this.reviewKey) {
        fs.unlinkSync(file);
      }
    } catch (err) {
    }
  }
  // ---- profiling ------------------------------------------------------
  /**
   * Profile the board `view` (profile.js), when its index asks to be,
   * and append a line per phase to this vault's profile.jsonl outside
   * it. `opts` as profile.js takes them. Answers the rows, or null when
   * not run.
   */
  async runProfile(view, opts = {}) {
    const { allowed, profile } = require_profile();
    if (!allowed(this.app, view.file)) {
      new Notice("Dendrite: profiling saves into a card, so it runs only on a manuscript whose index has dendrite_profile: true, such as a test copy.");
      return null;
    }
    if (this.profiling) return null;
    this.profiling = true;
    new Notice("Dendrite: profiling, about 30 seconds.");
    let rows;
    try {
      rows = await profile(view, Object.assign({}, opts, {
        openPreview: async () => {
          await this.openPreview(view.file);
          const l = this.previewLeaf(view.file);
          return l && l.view;
        },
        closePreview: () => {
          const l = this.previewLeaf(view.file);
          if (l) l.detach();
        }
      }));
    } catch (err) {
      new Notice(`Dendrite: profiling stopped (${err.message}).`);
      return null;
    } finally {
      this.profiling = false;
    }
    const file = vaultFile(this.app.vault.getName(), "profile.jsonl");
    const head = {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      version: this.manifest && this.manifest.version
    };
    try {
      const fs = require("fs");
      fs.mkdirSync(require("path").dirname(file), { recursive: true });
      fs.appendFileSync(
        file,
        rows.map((r) => JSON.stringify(
          Object.assign({}, head, r)
        ) + "\n").join(""),
        { mode: 384 }
      );
      new Notice(`Dendrite: profile written to ${file}.`);
    } catch (err) {
      new Notice(`Dendrite: profile not written (${err.message}).`);
    }
    return rows;
  }
  reviewQueue() {
    return this.settings.reviewQueue || [];
  }
  openViews() {
    return this.app.workspace.getLeavesOfType(VIEW).map((l) => l.view).filter((v) => v instanceof DendriteView);
  }
  /** The index with `prefix`, or the one it was renamed to. */
  indexWithPrefix(prefix) {
    return this.app.vault.getMarkdownFiles().find((f) => prefixOf(this.app, f) === prefix) || successorOf(this.app, prefix);
  }
  /**
   * What each card of a manuscript prints, for finding passages in: the
   * open board's own when there is one, so unsaved typing counts.
   */
  async reviewCardsOf(file) {
    const open = this.openViews().find((v) => v.file === file);
    if (open) return open.reviewCards();
    const app = this.app;
    const text = await app.vault.cachedRead(file);
    const root = core.parseIndex(core.splitFrontmatter(text).body).root;
    const cardOf = (id) => {
      const f = app.metadataCache.getFirstLinkpathDest(id, file.path);
      return f instanceof TFile ? f : null;
    };
    const props = (id) => {
      const f = cardOf(id);
      return f && app.metadataCache.getFileCache(f)?.frontmatter || {};
    };
    const kindOf = (id) => {
      const k = props(id).dendrite_kind;
      return core.KINDS.includes(k) ? k : null;
    };
    const roleOf = core.withKinds(
      (id) => core.cardRole(props(id)),
      kindOf
    );
    const out = [];
    for (const n of core.allNodes(root)) {
      const f = cardOf(n.id);
      if (!f) continue;
      const body = core.splitFrontmatter(await app.vault.cachedRead(f)).body;
      out.push({
        id: n.id,
        text: core.printedOnly(body, core.roleFor(n, roleOf))
      });
    }
    return out;
  }
  /**
   * Queue a review for its manuscript's board, where it is added or
   * ignored; nothing is written to a card here. `data`: { manuscript,
   * title?, items }, items as an imported JSON review's. Answers
   * { status, json } with where its passages were found. Other plugins
   * may call this directly; programs reach it over the local port.
   */
  async submitReview(data) {
    const bad = (status, error) => ({ status, json: { error } });
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return bad(400, "send { manuscript, title, items }");
    }
    const prefix = typeof data.manuscript === "string" ? data.manuscript.trim() : "";
    if (!prefix) {
      return bad(400, 'say which manuscript, by its prefix, as "manuscript"');
    }
    const file = this.indexWithPrefix(prefix);
    if (!file) return bad(404, `no manuscript has the prefix ${prefix}`);
    let items;
    try {
      items = review.readReviewJson(JSON.stringify(data));
    } catch (err) {
      return bad(400, err.message);
    }
    if (!items.length) return bad(400, "no items");
    const current = prefixOf(this.app, file);
    const title = String(data.title || "").trim() || "Review";
    const key = String(require_docx().crc32(Buffer.from(
      JSON.stringify([current, title, items]),
      "utf8"
    )));
    const cards = await this.reviewCardsOf(file);
    let found = 0;
    let already = 0;
    const missing = [];
    const bodies = /* @__PURE__ */ new Map();
    for (const [k, it] of items.entries()) {
      const at = review.locate(it, cards);
      if (!at) {
        missing.push({
          n: k + 1,
          card: it.card || null,
          quote: it.quote
        });
        continue;
      }
      found++;
      if (!bodies.has(at.id)) {
        const f = this.app.metadataCache.getFirstLinkpathDest(
          at.id,
          file.path
        );
        bodies.set(at.id, f instanceof TFile ? core.splitFrontmatter(await this.app.vault.read(f)).body : "");
      }
      if (review.alreadyIn(bodies.get(at.id), it)) already++;
    }
    const queue = this.settings.reviewQueue = this.settings.reviewQueue || [];
    let entry = queue.find((r) => r.key === key && r.state === "pending");
    if (!entry) {
      entry = {
        id: Math.random().toString(16).slice(2, 10),
        key,
        received: (/* @__PURE__ */ new Date()).toISOString(),
        manuscript: current,
        title,
        items,
        state: "pending"
      };
      queue.push(entry);
      const decided = queue.filter((r) => r.state !== "pending");
      const drop = new Set(decided.slice(0, -50));
      this.settings.reviewQueue = queue.filter((r) => !drop.has(r));
      await this.saveSettings();
      stickyNotice(
        `review:${file.path}:${entry.id}`,
        `Dendrite: ${title}: ${items.length} comment${items.length === 1 ? "" : "s"} from ${reviewAuthors(items)}, for ${file.basename}. Click "review" on its board's bar to choose which to add.`
      );
      for (const v of this.openViews()) v.refreshInbox();
    }
    return { status: 202, json: {
      id: entry.id,
      state: entry.state,
      manuscript: current,
      found,
      already,
      missing
    } };
  }
  /**
   * A manuscript's open review comments and suggested changes, each
   * with its id, card, passage, reviewer, text, Google link and
   * replies, in reading order, and the text of their cards without
   * comments; only `author`'s, if given, where "me" is
   * any name the writer signs with; with `awaiting`, only those that
   * wait for that name's answer (review.awaits); and
   * with `card`, only that card's and those of the cards under it.
   * Read only, for a reviewer to read what was answered.
   */
  async threadsFor(prefix, {
    author = null,
    awaiting = null,
    card = null
  } = {}) {
    const file = this.indexWithPrefix(prefix);
    if (!file) {
      return { status: 404, json: {
        error: `no manuscript has the prefix ${prefix}`
      } };
    }
    const app = this.app;
    const who = author === "me" ? this.selfNames() : /* @__PURE__ */ new Set([author]);
    const text = await app.vault.cachedRead(file);
    const root = core.parseIndex(core.splitFrontmatter(text).body).root;
    const all = core.allNodes(root);
    const top = card && all.find((n) => n.id === card);
    if (card && !top) {
      return { status: 404, json: { error: `no card ${card}` } };
    }
    const threads = [];
    const cards = {};
    for (const n of top ? [top, ...core.allNodes(top)] : all) {
      const f = app.metadataCache.getFirstLinkpathDest(n.id, file.path);
      if (!(f instanceof TFile)) continue;
      const body = core.splitFrontmatter(
        await app.vault.cachedRead(f)
      ).body;
      const items = review.reviewItems(body);
      const ids = review.threadIds(items);
      for (const [k, it] of items.entries()) {
        if (author && !who.has(it.author)) continue;
        const replies = it.replies || [];
        if (awaiting && !review.awaits(
          it,
          awaiting,
          this.selfNames()
        )) continue;
        const { text: said, url } = review.noteLink(it.text);
        cards[n.id] = core.stripComments(body).trim();
        threads.push({
          id: `${n.id}/${ids[k]}`,
          card: n.id,
          kind: it.kind === "suggest" ? "suggestion" : "comment",
          passage: it.passage,
          author: it.author,
          date: it.date,
          text: it.kind === "suggest" ? it.text : said.trim(),
          link: it.kind === "suggest" ? null : url || null,
          replies
        });
      }
    }
    return { status: 200, json: {
      manuscript: prefixOf(app, file),
      threads,
      cards
    } };
  }
  /** The names the writer signs with: the reply name, and Me. */
  selfNames() {
    return /* @__PURE__ */ new Set([this.settings.replyName || "Me", "Me"]);
  }
  /**
   * A reply from a program, written at once under the comment `thread`
   * names, as threadsFor gives it: `card/id`. With `replace`, it takes
   * the place of its writer's replies at the end of the thread, and is
   * refused where someone has replied since. Through the board when
   * one has the manuscript open, so it is drawn, undone, and goes into
   * the card's editor if the card is being typed in.
   */
  async replyTo(data) {
    const bad = (status, error) => ({ status, json: { error } });
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return bad(400, "send { manuscript, thread, text }");
    }
    const file = this.indexWithPrefix(String(data.manuscript || "").trim());
    if (!file) {
      return bad(404, `no manuscript has the prefix ${data.manuscript}`);
    }
    const said = String(data.text || "").trim();
    if (data.seen && said) {
      return bad(400, "either seen, with no text, or a reply");
    }
    if (!data.seen && !said) return bad(400, "no text");
    if (said.length > MAX_REPLY) {
      return bad(400, `${said.length} characters; a reply is up to ${MAX_REPLY}. Say only what the writer needs before acting on the comment.`);
    }
    const ids = Array.isArray(data.threads) ? data.threads.map(String) : [String(data.thread || "")];
    const reply = {
      author: String(data.author || "").trim() || "Claude",
      date: localDay(),
      text: data.seen ? "" : said,
      replace: !!data.replace
    };
    const view = this.openViews().find((v) => v.file === file);
    const done = [];
    const missing = [];
    const refused = [];
    for (const id of ids) {
      const [card, tid] = id.split("/");
      const f = card && this.app.metadataCache.getFirstLinkpathDest(
        card,
        file.path
      );
      const n = !(f instanceof TFile) ? -1 : await (view ? view.replyFrom(card, tid, reply) : this.replyInFile(f, tid, reply));
      if (n === REFUSED) {
        refused.push({ id, reason: "someone has replied since; send a new reply instead" });
      } else (n < 0 ? missing : done).push(id);
    }
    if (!done.length && !refused.length) {
      return bad(404, `no open comment ${missing.join(", ")}; it may have been resolved or changed`);
    }
    if (!data.seen && done.length) {
      new Notice(`Dendrite: ${reply.author} replied on ${done.map((x) => x.split("/")[0]).join(", ")}.`);
    }
    return { status: 201, json: { done, missing, refused } };
  }
  /**
   * Suggested changes from a program, `items` [{ card, quote, replace,
   * before?, after?, author? }], each written at once where its quote
   * is found exactly in its card, and refused anywhere less sure; a
   * suggestion is applied or dismissed from the board, so it needs no
   * other approval. Through the board when the manuscript is open.
   */
  async suggestTo(data) {
    const bad = (status, error) => ({ status, json: { error } });
    if (!data || typeof data !== "object" || !Array.isArray(data.items) || !data.items.length) {
      return bad(400, "send { manuscript, items: [{ card, quote, replace }] }");
    }
    const file = this.indexWithPrefix(String(data.manuscript || "").trim());
    if (!file) {
      return bad(404, `no manuscript has the prefix ${data.manuscript}`);
    }
    const view = this.openViews().find((v) => v.file === file);
    const done = [];
    const refused = [];
    for (const [k, x] of data.items.entries()) {
      const n = k + 1;
      const card = x && String(x.card || "");
      const f = card && this.app.metadataCache.getFirstLinkpathDest(
        card,
        file.path
      );
      if (!(f instanceof TFile)) {
        refused.push({ n, reason: `no card ${card}` });
        continue;
      }
      const item = { ...x, author: String(x.author || "").trim() || "Claude", date: localDay() };
      const reason = await (view ? view.suggestIn(card, item) : this.suggestInFile(f, item));
      if (reason) refused.push({ n, reason });
      else done.push(n);
    }
    if (done.length) {
      new Notice(`Dendrite: ${done.length} suggested change${done.length === 1 ? "" : "s"} from Claude.`);
    }
    return { status: 201, json: { done, refused } };
  }
  /** A suggestion written into a card's file; why not, or null. */
  async suggestInFile(f, item) {
    let reason = null;
    await this.app.vault.process(f, (data) => {
      const { fm, body } = core.splitFrontmatter(data);
      const out = review.suggestInto(body, f.basename, item);
      reason = out.reason || null;
      return out.md === void 0 ? data : fm + out.md;
    });
    return reason;
  }
  /**
   * A reply written into a card's file; the comment's index, -1 where
   * it is not there, or REFUSED where it would replace and cannot.
   */
  async replyInFile(f, tid, reply) {
    let n = -1;
    await this.app.vault.process(f, (data) => {
      const { fm, body } = core.splitFrontmatter(data);
      n = review.threadIds(review.reviewItems(body)).indexOf(tid);
      const out = n < 0 ? null : withReply(body, n, reply);
      if (n >= 0 && out === null) n = REFUSED;
      return out === null ? data : fm + out;
    });
    return n;
  }
  async reviewStatus(id) {
    const r = this.reviewQueue().find((x) => x.id === id);
    return r ? { status: 200, json: {
      id,
      state: r.state,
      manuscript: r.manuscript,
      title: r.title
    } } : { status: 404, json: { error: "no such review" } };
  }
  /**
   * Act on a review comment from the preview, as from its card on the
   * board: the board for the manuscript is opened if it is not.
   */
  async reviewFromPreview(indexFile, id, n, what, arg = null) {
    let view = this.openViews().find((v) => v.file === indexFile);
    if (!view) {
      await this.focusCard(indexFile, id, false);
      view = this.openViews().find((v) => v.file === indexFile);
    }
    if (view) await view.reviewAction(id, n, what, arg);
  }
  // ---- Google Docs ---------------------------------------------------
  /**
   * The OAuth client, as pasted in the settings or else from its file,
   * or null without one.
   */
  googleClient() {
    const pasted = this.settings && this.settings.googleClientJson;
    try {
      return google.readClient(pasted && pasted.trim() ? pasted : require("fs").readFileSync(
        configFile("google-oauth-client.json"),
        "utf8"
      ));
    } catch (err) {
      return null;
    }
  }
  /** The Picker API key, as pasted or else from its file. */
  googlePickerKey() {
    const pasted = this.settings && this.settings.googlePickerKey;
    if (pasted && pasted.trim()) return pasted.trim();
    try {
      return require("fs").readFileSync(
        configFile("google-api-key.txt"),
        "utf8"
      ).trim();
    } catch (err) {
      return "";
    }
  }
  googleToken() {
    try {
      return JSON.parse(require("fs").readFileSync(
        configFile("google-token.json"),
        "utf8"
      ));
    } catch (err) {
      return null;
    }
  }
  saveGoogleToken(tok) {
    const fs = require("fs");
    const file = configFile("google-token.json");
    fs.mkdirSync(require("path").dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(tok, null, 2) + "\n",
      { mode: 384 }
    );
  }
  googleDeps() {
    return {
      request: googleRequest,
      openUrl: openExternal,
      http: require("http"),
      crypto: require("crypto")
    };
  }
  /** Sign in as the user in the browser; false when it did not work. */
  async googleSignIn() {
    const client = this.googleClient();
    if (!client) {
      new Notice("Dendrite: paste the Google OAuth client's JSON in Dendrite's settings first.", 1e4);
      return false;
    }
    new Notice("Dendrite: sign in to Google in the browser that opened.");
    try {
      const tok = await google.signIn(Object.assign(
        { client },
        this.googleDeps()
      ));
      this.saveGoogleToken(tok);
    } catch (err) {
      new Notice(
        `Dendrite: Google sign-in failed (${err.message}).`,
        1e4
      );
      return false;
    }
    new Notice("Dendrite: signed in to Google.");
    return true;
  }
  async googleSignOut() {
    const tok = this.googleToken();
    try {
      await google.revoke({ tok, request: googleRequest });
    } catch (err) {
    }
    try {
      require("fs").unlinkSync(configFile("google-token.json"));
    } catch (err) {
    }
  }
  /** A current access token, signing in first when Google wants it. */
  async googleAccess() {
    const client = this.googleClient();
    const get = () => google.accessToken({
      client,
      tok: this.googleToken(),
      request: googleRequest,
      save: async (t) => this.saveGoogleToken(t)
    });
    try {
      return await get();
    } catch (err) {
      if (!err.signIn) throw err;
      if (!await this.googleSignIn()) return null;
      return get();
    }
  }
  /**
   * Pair a manuscript with a Google Doc, chosen in Google's picker,
   * which also grants Dendrite that doc.
   */
  async linkGdoc(indexFile) {
    const key = this.googlePickerKey();
    if (!key) {
      new Notice("Dendrite: paste the Google Picker API key in Dendrite's settings first.", 1e4);
      return;
    }
    const token = await this.googleAccess();
    if (!token) return;
    new Notice("Dendrite: choose the doc in the browser that opened.");
    let picked;
    try {
      picked = await google.pick(Object.assign(
        {
          token,
          apiKey: key,
          client: this.googleClient(),
          onEvent: (what) => new Notice(what === "loaded" ? "Dendrite: Google's picker is open in the browser. Click the doc, then Select." : `Dendrite: Google's picker reported ${what}.`, 1e4)
        },
        this.googleDeps()
      ));
    } catch (err) {
      if (/replaced by a new try/.test(err.message)) return;
      new Notice(
        `Dendrite: the picker failed (${err.message}).`,
        1e4
      );
      return;
    }
    if (!picked) return;
    await writeProps(this.app, indexFile, {
      dendrite_gdoc: google.docUrl(picked.id),
      dendrite_gdoc_title: picked.name || null
    });
    new Notice(`Dendrite: linked to the Google Doc ${picked.name}.`);
  }
  /** A linked doc's open comments and suggested changes. */
  async gdocReview(url) {
    const docId = google.docIdFromUrl(url);
    if (!docId) throw new Error("the linked doc's URL has no doc id");
    const token = await this.googleAccess();
    if (!token) return null;
    return google.fetchReview({
      docId,
      token,
      request: googleRequest,
      zlib: require("zlib")
    });
  }
  async settleReview(id, state) {
    const r = this.reviewQueue().find((x) => x.id === id);
    if (!r) return;
    r.state = state;
    r.decided = (/* @__PURE__ */ new Date()).toISOString();
    await this.saveSettings();
    for (const v of this.openViews()) v.refreshInbox();
  }
  linter() {
    const p = this.app.plugins && this.app.plugins.plugins;
    return p && p[LINTER_ID] || null;
  }
  /**
   * Run Linter's clean-up on one card, as its lint on save would, with
   * the rules that break cards switched off for that run only. Linter's
   * own triggers skip the writing folder, so this is the only way a
   * card is linted. It calls Linter's runLinterFile, which is not public
   * API: if a Linter update removes it, cards are left unlinted.
   */
  async lintCard(file) {
    const linter = this.linter();
    if (!this.settings.lintCards || !linter) return;
    if (linter.isEnabled === false) return;
    if (typeof linter.runLinterFile !== "function") return;
    if (!linter.settings || !linter.settings.ruleConfigs) return;
    const original = linter.settings;
    const rules = Object.assign({}, original.ruleConfigs);
    for (const id of CARD_UNSAFE_RULES) {
      if (rules[id]) rules[id] = Object.assign(
        {},
        rules[id],
        { enabled: false }
      );
    }
    linter.settings = Object.assign({}, original, { ruleConfigs: rules });
    try {
      await linter.runLinterFile(file);
    } catch (err) {
      console.error("Dendrite: Linter clean-up failed", err);
    } finally {
      linter.settings = original;
    }
  }
  /**
   * Keep the writing folder in Linter's folders to ignore, so Linter's
   * rules, "File name heading" above all, never rewrite a card. Only an
   * entry Dendrite added is ever removed, and Linter's own settings
   * object is changed, so the change applies without a reload.
   */
  async syncLinter() {
    const linter = this.linter();
    const ls = linter && linter.settings;
    if (!ls || !Array.isArray(ls.foldersToIgnore)) return;
    const want = this.settings.manageLinter ? normalizePath(this.settings.writingFolder) : null;
    const list = ls.foldersToIgnore;
    const had = this.settings.linterAdded;
    let changed = false;
    if (had && had !== want && list.includes(had)) {
      list.splice(list.indexOf(had), 1);
      changed = true;
    }
    let added = had === want ? had : null;
    if (want && !list.includes(want)) {
      list.push(want);
      added = want;
      changed = true;
      new Notice(`Dendrite added ${want} to Linter's folders to ignore, so Linter does not rewrite cards. This is a setting in Dendrite.`);
    }
    if (changed) {
      if (typeof linter.saveSettings === "function") {
        await linter.saveSettings();
      } else {
        await linter.saveData(ls);
      }
    }
    if (added !== this.settings.linterAdded) {
      this.settings.linterAdded = added;
      await this.saveSettings();
    }
  }
  rerender() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) {
      leaf.view.render();
    }
  }
  /** A reviewer's colour in a manuscript, set from its preview. */
  async reviewerColourFor(file, who, colour) {
    const board = this.app.workspace.getLeavesOfType(VIEW).map((l) => l.view).find((v) => v.file === file);
    if (board) {
      await board.setReviewerColour(who, colour);
      return;
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const map = review.reviewerColours(fm.dendrite_reviewer_colours);
    map.set(who, colour);
    await writeProps(this.app, file, { dendrite_reviewer_colours: review.colourList(map, fm.dendrite_reviewer_colours) });
  }
  async openIndex(file, card = null, leaf = null) {
    const target = leaf || this.app.workspace.getLeaf("tab");
    await target.setViewState({
      type: VIEW,
      active: true,
      state: { file: file.path, card }
    });
    this.app.workspace.revealLeaf(target);
  }
  /** Node's file and process access, for Pandoc export on the desktop. */
  pandocDeps() {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { execFile } = require("child_process");
    return {
      tmpdir: os.tmpdir,
      join: path.join,
      writeFile: (f, t) => fs.promises.writeFile(f, t),
      readFile: (f) => fs.promises.readFile(f),
      inflate: (b) => require("zlib").inflateSync(b),
      zlib: require("zlib"),
      remove: (f) => {
        try {
          fs.unlinkSync(f);
        } catch (e) {
        }
      },
      run: (cmd, args) => new Promise((res, rej) => execFile(
        cmd,
        args,
        { timeout: 18e4, env: this.pandocEnv() },
        (err, out, stderr) => err ? rej(Object.assign(err, { stderr })) : res()
      )),
      // Through Node rather than the page or Obsidian: Zotero drops,
      // unanswered, a request with a browser's User-Agent or an
      // Origin, which both of those send, so either fails as if
      // Zotero were closed. Node's http sends neither.
      fetch: (url, init) => nodeRequest(url, init)
    };
  }
  /**
   * The search path Pandoc runs with: Obsidian's own plus the usual
   * install folders for Pandoc and TeX, since an app started from the
   * desktop does not read the shell profile that adds them.
   */
  pandocEnv() {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const proc = globalThis.process;
    const extra = [];
    if (proc.platform === "win32") {
      const local = proc.env.LOCALAPPDATA;
      const prog = proc.env.ProgramFiles || "C:\\Program Files";
      if (local) {
        extra.push(
          path.join(local, "Pandoc"),
          path.join(
            local,
            "Programs",
            "MiKTeX",
            "miktex",
            "bin",
            "x64"
          )
        );
      }
      extra.push(
        path.join(prog, "Pandoc"),
        path.join(prog, "MiKTeX", "miktex", "bin", "x64")
      );
      return pandoc.searchPath(proc.env, proc.platform, extra);
    }
    for (const root of ["/usr/local/texlive", "/opt/texlive"]) {
      let years = [];
      try {
        years = fs.readdirSync(root).sort().reverse();
      } catch (e) {
        continue;
      }
      for (const y of years) {
        const bin = path.join(root, y, "bin");
        let arches = [];
        try {
          arches = fs.readdirSync(bin);
        } catch (e) {
          continue;
        }
        for (const a of arches) extra.push(path.join(bin, a));
      }
    }
    extra.push(
      "/Library/TeX/texbin",
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      path.join(os.homedir(), ".local", "bin")
    );
    let names = [];
    try {
      names = fs.readdirSync(os.homedir()).sort();
    } catch (e) {
    }
    extra.push(...pandoc.condaBins(names, os.homedir()));
    return pandoc.searchPath(proc.env, proc.platform, extra);
  }
  /**
   * Show an export: a PDF in a pane beside the board, reusing the one
   * already showing it; a Word file in the system's default app.
   */
  async showExport(rel, full, format) {
    if (format !== "pdf") {
      try {
        const { shell } = require("electron");
        await shell.openPath(full);
      } catch (e) {
      }
      return;
    }
    let file = null;
    for (let i = 0; i < 20 && !file; i++) {
      const f = this.app.vault.getAbstractFileByPath(rel);
      if (f instanceof TFile) file = f;
      else await new Promise((r) => setTimeout(r, 150));
    }
    if (!file) return;
    await this.app.workspace.revealLeaf(
      await this.exportLeaf(file),
      { focus: false }
    );
  }
  /**
   * Where an exported PDF opens, without taking room from the board: a
   * tab already showing an export from the same folder, else a new tab
   * beside the manuscript's preview, else, with no preview, a split.
   */
  async exportLeaf(file) {
    const ws = this.app.workspace;
    const dir = file.parent ? file.parent.path : "";
    const shown = ws.getLeavesOfType("pdf").find((l) => l.view.file && (l.view.file.parent ? l.view.file.parent.path : "") === dir);
    if (shown) {
      await shown.openFile(file, { active: false });
      return shown;
    }
    const home = dir.replace(/\/?exports$/, "");
    const previews = ws.getLeavesOfType(PREVIEW);
    const preview = previews.find((l) => l.view.file && (l.view.file.parent ? l.view.file.parent.path : "") === home) || previews[0];
    let leaf;
    if (preview && preview.parent && ws.createLeafInParent) {
      const at = preview.parent.children ? preview.parent.children.indexOf(preview) + 1 : 0;
      leaf = ws.createLeafInParent(preview.parent, at);
    } else {
      leaf = ws.getLeaf("split", "vertical");
      narrowSplit(leaf);
    }
    await leaf.openFile(file, { active: false });
    return leaf;
  }
  /** The preview for a manuscript, opened beside the board or reused. */
  previewLeaf(file) {
    return this.app.workspace.getLeavesOfType(PREVIEW).find((l) => l.view.file === file) || null;
  }
  previewOpen(file) {
    return !!this.previewLeaf(file);
  }
  /** Open a manuscript's preview beside its board, or close it. */
  async togglePreview(file) {
    const open = this.previewLeaf(file);
    if (open) open.detach();
    else await this.openPreview(file);
  }
  async openPreview(file) {
    const open = this.previewLeaf(file);
    if (open) {
      this.app.workspace.revealLeaf(open);
      return;
    }
    const leaf = this.app.workspace.getLeaf("split", "vertical");
    narrowSplit(leaf);
    await leaf.setViewState({
      type: PREVIEW,
      active: false,
      state: { file: file.path }
    });
  }
  /** From the preview: select a card on the board, or edit it. */
  async focusCard(file, id, edit) {
    const leaf = this.app.workspace.getLeavesOfType(VIEW).find((l) => l.view.file === file);
    if (!leaf) {
      await this.openIndex(file, id);
      return;
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (edit) await view.startEdit(id);
    else await view.select(id);
  }
  /**
   * A status's colour, from Pretty Properties' colour for that value of
   * dendrite_status, so the Properties panel, Bases and the board agree.
   * Unset, null: a flag is drawn in the neutral --dendrite-flag, and
   * other values stay plain.
   */
  statusColour(status) {
    const pp = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins["pretty-properties"];
    const c = pp && pp.settings && pp.settings.propertyColors && pp.settings.propertyColors.dendrite_status && pp.settings.propertyColors.dendrite_status[status];
    const pill = c && c.pillColor;
    if (pill && typeof pill === "object" && "h" in pill) {
      return `hsl(${pill.h}, ${pill.s}%, ${pill.l}%)`;
    }
    if (pill && typeof pill === "string" && pill !== "default" && pill !== "none") {
      return pill.startsWith("#") ? pill : `var(--color-${pill})`;
    }
    return null;
  }
  previewStatuses(file) {
    for (const l of this.app.workspace.getLeavesOfType(PREVIEW)) {
      if (l.view.file === file) l.view.scheduleRefresh();
    }
  }
  previewActive(file, id) {
    for (const l of this.app.workspace.getLeavesOfType(PREVIEW)) {
      if (l.view.file === file) l.view.highlight(id);
    }
  }
  async openAsMarkdown(file) {
    const leaf = this.app.workspace.getLeaf("tab");
    this.markdownLeaves.set(leaf, file.path);
    await leaf.openFile(file);
  }
  /** An index note opened as markdown switches to Dendrite. */
  onFileOpen(file) {
    if (!this.settings.openInDendrite || !file) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file !== file || !isIndex(this.app, file)) return;
    if (this.markdownLeaves.get(view.leaf) === file.path) return;
    this.openIndex(file, null, view.leaf);
  }
  isCard(file) {
    return file instanceof TFile && file.extension === "md" && file.parent && file.parent.name === "cards" && CARD_NAME.test(file.basename);
  }
  /** The index note that links a card, found from Obsidian's links. */
  indexFor(card) {
    const links = this.app.metadataCache.resolvedLinks;
    for (const src of Object.keys(links)) {
      if (!links[src][card.path]) continue;
      const f = this.app.vault.getAbstractFileByPath(src);
      if (isIndex(this.app, f)) return f;
    }
    return null;
  }
  /**
   * Give a markdown view of an index or a card a header button back
   * into Dendrite, at that card when it is one.
   */
  decorate(leaf) {
    const view = leaf && leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const file = view.file;
    const kind = isIndex(this.app, file) ? "index" : this.isCard(file) ? "card" : null;
    if (view.dendriteAction) {
      if (view.dendriteAction.kind === kind && view.dendriteAction.path === (file && file.path)) return;
      view.dendriteAction.el.remove();
      view.dendriteAction = null;
    }
    if (!kind) return;
    const el = view.addAction(
      "list-tree",
      kind === "index" ? "Open in Dendrite" : "Open this card in Dendrite",
      () => {
        if (kind === "index") {
          this.markdownLeaves.delete(view.leaf);
          this.openIndex(file, null, view.leaf);
          return;
        }
        const index = this.indexFor(file);
        if (index) this.openIndex(index, file.basename, view.leaf);
        else new Notice("Dendrite: no index note links this card.");
      }
    );
    view.dendriteAction = { el, kind, path: file.path };
  }
  prefixesInUse() {
    return prefixesInUse(this.app);
  }
  checkNew(title, prefix) {
    if (!safeName(title)) return "give the manuscript a title.";
    if (!core.validPrefix(prefix)) {
      return "a prefix is letters, digits and single hyphens.";
    }
    if (this.prefixesInUse().has(prefix.toLowerCase())) {
      return `the prefix ${prefix} is already used by another manuscript.`;
    }
    const dir = normalizePath(`${this.settings.writingFolder}/` + safeName(title));
    if (this.app.vault.getAbstractFileByPath(dir)) {
      return `${dir} already exists.`;
    }
    return null;
  }
  async createManuscript(title, prefix) {
    const vault = this.app.vault;
    const dir = normalizePath(`${this.settings.writingFolder}/${title}`);
    for (const p of [this.settings.writingFolder, dir, `${dir}/cards`]) {
      const np = normalizePath(p);
      if (np && !vault.getAbstractFileByPath(np)) {
        await vault.createFolder(np);
      }
    }
    const index = await vault.create(
      normalizePath(`${dir}/${title}.md`),
      `---
dendrite_prefix: ${prefix}
---
`
    );
    if (this.settings.indexType) {
      await addType(this.app, index, this.settings.indexType);
    }
    await new Promise((r) => {
      const ref = this.app.metadataCache.on("changed", (f) => {
        if (f === index) {
          this.app.metadataCache.offref(ref);
          r();
        }
      });
      setTimeout(r, 1500);
    });
    await this.openIndex(index);
  }
};
module.exports.core = core;
module.exports.DendriteView = DendriteView;
module.exports.DendritePreview = DendritePreview;
module.exports.DendriteSettings = DendriteSettings;
module.exports.exportStyle = exportStyle;
module.exports.callers = callers;
module.exports.stickyNotice = stickyNotice;
module.exports.dismissNotices = dismissNotices;
