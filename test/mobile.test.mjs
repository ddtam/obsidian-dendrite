// Obsidian on a phone or tablet: no Node, so the plugin must load and
// start without Node's modules, reaching them only for desktop features.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const h = require('./harness.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, '..', 'main.js');

/** Plugin `p`'s registrations, recorded rather than made. */
function stubPlugin(p, app) {
    p.app = app;
    p.manifest = { id: 'dendrite', version: '9.9.9', dir: '' };
    p.loadData = async () => null;
    p.saveData = async () => {};
    for (const name of ['registerView', 'addCommand', 'addSettingTab',
        'addRibbonIcon', 'registerEvent', 'register', 'registerDomEvent',
        'registerExtensions', 'registerMarkdownPostProcessor',
        'registerEditorExtension', 'registerObsidianProtocolHandler',
        'addStatusBarItem', 'registerEditorSuggest']) {
        p[name] = () => ({ setText() {}, addClass() {}, remove() {} });
    }
    // Nothing left running once the test ends.
    p.registerInterval = (id) => h.window.clearInterval(id);
}

test('the built plugin loads and starts where Node\'s modules are missing, ' +
     'as on a phone', async () => {
    const asked = [];
    const orig = Module._load;
    Module._load = function (req, parent, ...a) {
        if (parent && parent.filename === bundle && isBuiltin(req)) {
            asked.push(req);
            throw new Error(`Cannot find module '${req}'`);
        }
        return orig.call(this, req, parent, ...a);
    };
    const platform = h.obsidian.Platform;
    h.obsidian.Platform = { isDesktopApp: false, isMobile: true };
    delete require.cache[bundle];
    try {
        const Plugin = require(bundle);
        const p = new Plugin();
        const app = h.makeApp();
        app.workspace.onLayoutReady = (fn) => fn();
        app.workspace.iterateAllLeaves = () => {};
        stubPlugin(p, app);
        await p.onload();
        assert.deepEqual(asked, [], 'no Node module asked for');
        p.onunload();
        assert.deepEqual(asked, [], 'nor on unloading');
    } finally {
        Module._load = orig;
        h.obsidian.Platform = platform;
        delete require.cache[bundle];
    }
});

test('the preview draws the manuscript on a tablet', async () => {
    const orig = Module._load;
    Module._load = function (req, parent, ...a) {
        if (parent && parent.filename === bundle && isBuiltin(req)) {
            throw new Error(`Cannot find module '${req}'`);
        }
        return orig.call(this, req, parent, ...a);
    };
    const platform = h.obsidian.Platform;
    h.obsidian.Platform = { isDesktopApp: false, isMobile: true };
    delete require.cache[bundle];
    try {
        const { DendritePreview } = require(bundle);
        const app = h.makeApp();
        app.vault.folders.add('W/Grant/cards');
        await app.vault.create('W/Grant/Grant.md', '---\n' +
            'dendrite_prefix: G\n---\n- [[G-aaaaa|Aims]]\n' +
            '    - [[G-bbbbb|p]]\n');
        await app.vault.create('W/Grant/cards/G-aaaaa.md', '# Aims');
        await app.vault.create('W/Grant/cards/G-bbbbb.md', 'The prose.');
        const plugin = { settings: { headingTop: 1 }, focusCard() {} };
        const view = new DendritePreview({ app, updateHeader() {} },
                                         plugin);
        await view.onOpen();
        await view.setState({ file: 'W/Grant/Grant.md' });
        await new Promise((r) => setTimeout(r, 20));
        const texts = [...view.contentEl.querySelectorAll('.dendrite-pblock')]
            .map((b) => b.textContent.trim()).filter(Boolean);
        assert.deepEqual(texts, ['# Aims', 'The prose.']);
    } finally {
        Module._load = orig;
        h.obsidian.Platform = platform;
        delete require.cache[bundle];
    }
});
