'use strict';
// Profiling a manuscript: the board and the preview put through what a
// writing session does to them, opening, saving a card and scrolling,
// with each phase's timings (timing.js) kept as one row. It saves into a
// card and puts its text back, so it runs only on a manuscript whose
// index says `dendrite_profile: true`, which a test vault's copy does.

const timing = require('./timing.js');

const PHASE_WAIT = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether the index `file` asks to be profiled. */
function allowed(app, file) {
    const c = file && app.metadataCache.getFileCache(file);
    return !!(c && c.frontmatter && c.frontmatter.dendrite_profile === true);
}

/**
 * Profile the board `view`. `hooks`: { openPreview() answering the
 * preview's view, closePreview(), saves (default 12), every (ms between
 * saves, default 400), wait (ms after each phase, default 1500) }.
 * Answers the rows, one per phase, with timing on for the run and put
 * back as it was after.
 */
async function profile(view, hooks) {
    const app = view.app;
    const saves = hooks.saves || 12;
    const every = hooks.every === undefined ? 400 : hooks.every;
    const wait = hooks.wait === undefined ? PHASE_WAIT : hooks.wait;
    const first = view.root.children[0];
    const card = first && view.cardFile(first.id);
    if (!card) throw new Error('the manuscript has no card to save into');
    const base = await app.vault.read(card);
    const was = timing.isOn();
    const rows = [];
    const phase = async (name, run) => {
        timing.take();
        const t0 = performance.now();
        await run();
        const ran = performance.now() - t0;
        await sleep(wait);
        const got = timing.take() || { steps: [] };
        rows.push(Object.assign({ phase: name,
            ran_ms: Math.round(ran) }, got, {
            steps: got.steps.slice(0, 10) }));
    };
    const save = async () => {
        for (let k = 1; k <= saves; k++) {
            await app.vault.modify(card, base + '\nProfile ' +
                                   'x'.repeat(k));
            await sleep(every);
        }
    };
    timing.setOn(true);
    timing.watch(view.contentEl.ownerDocument.defaultView);
    let preview = null;
    try {
        await phase('redraw the board', () => view.render());
        await phase('open the preview', async () => {
            preview = await hooks.openPreview();
        });
        await phase(`${saves} saves, preview open`, save);
        await phase('scroll the preview', async () => {
            const doc = preview && preview.contentEl.querySelector(
                '.dendrite-preview-doc');
            for (let k = 0; k < 40 && doc; k++) {
                doc.scrollTop += 120;
                await sleep(16);
            }
        });
        await phase('close the preview', () => hooks.closePreview());
        await phase(`${saves} saves, preview closed`, save);
    } finally {
        await app.vault.modify(card, base);
        timing.take();
        timing.setOn(was);
    }
    return rows;
}

module.exports = { allowed, profile };
