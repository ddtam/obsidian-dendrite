// Write a thesis-scale test manuscript for profiling Dendrite: 6 chapters
// of 40 sections of 10 paragraphs, 2,646 cards. With --deep, the same
// scale six columns deep instead of three: branching 4, 4, 4, 4, 2 and 4,
// 2,900 cards, headings for the first five levels and prose in the last.
// The sizes are chosen for the test, not measured from a real thesis.
//
// Usage: node scripts/make-test-manuscript.mjs <folder inside a vault>
//            [--deep]
// Creates <folder>/Dendrite thesis test/, or with --deep
// <folder>/Dendrite deep test/, with its index and cards/.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const target = process.argv[2];
if (!target) {
    console.error('usage: node scripts/make-test-manuscript.mjs <folder>');
    process.exit(1);
}
const deep = process.argv.includes('--deep');
const title = deep ? 'Dendrite deep test' : 'Dendrite thesis test';
const dir = join(target, title);
try {
    await access(dir);
    console.error(`${dir} exists; remove it first.`);
    process.exit(1);
} catch { /* absent, as wanted */ }
await mkdir(join(dir, 'cards'), { recursive: true });

const PREFIX = deep ? 'DDEEP' : 'DTEST';
const words = ('lorem ipsum dolor sit amet consectetur adipiscing elit ' +
    'sed do eiusmod tempor incididunt ut labore et dolore magna ' +
    'aliqua enim').split(' ');
let n = 0;
const id = () => `${PREFIX}-${(n++).toString(36).padStart(5, '0')}`;
const prose = (k) => {
    const out = [];
    for (let i = 0; i < 90; i++) out.push(words[(i * 7 + k) % words.length]);
    return out.join(' ') + '.';
};

const lines = [];
const cards = [];
// Each level's branching, its cards headings down to the last level's.
const SHAPE = [4, 4, 4, 4, 2, 4];
const level = (depth, path) => {
    for (let k = 0; k < SHAPE[depth]; k++) {
        const at = [...path, k + 1];
        const cid = id();
        const pad = '    '.repeat(depth);
        if (depth === SHAPE.length - 1) {
            const text = prose(at.reduce((t, x) => t * 7 + x, 0));
            lines.push(`${pad}- [[${cid}|${text.split(' ')
                .slice(0, 8).join(' ')}…]]`);
            cards.push([cid, text]);
            continue;
        }
        const name = `Part ${at.join('.')}`;
        lines.push(`${pad}- [[${cid}|${name}]]`);
        cards.push([cid, `${'#'.repeat(depth + 1)} ${name}\nPlanning.`]);
        level(depth + 1, at);
    }
};
if (deep) level(0, []);
for (let c = 0; c < (deep ? 0 : 6); c++) {
    const cid = id();
    lines.push(`- [[${cid}|Chapter ${c + 1}]]`);
    cards.push([cid, `# Chapter ${c + 1}\nWhat this chapter argues.`]);
    for (let s = 0; s < 40; s++) {
        const sid = id();
        lines.push(`    - [[${sid}|Section ${c + 1}.${s + 1}]]`);
        cards.push([sid, `## Section ${c + 1}.${s + 1}\nPlanning.`]);
        for (let p = 0; p < 10; p++) {
            const pid = id();
            const text = prose(c * 400 + s * 10 + p);
            lines.push(`        - [[${pid}|${text.split(' ')
                .slice(0, 8).join(' ')}…]]`);
            cards.push([pid, text]);
        }
    }
}
await writeFile(join(dir, `${title}.md`),
                `---\ndendrite_prefix: ${PREFIX}\n---\n${lines.join('\n')}\n`);
for (const [cid, text] of cards) {
    await writeFile(join(dir, 'cards', `${cid}.md`), text + '\n');
}
console.log(`wrote ${cards.length} cards and the index to ${dir}`);
