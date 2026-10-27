// Bundles src/ into the single main.js Obsidian loads.
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const ctx = await esbuild.context({
    entryPoints: ['src/main.js'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    external: ['obsidian', 'electron', 'fs', 'os', 'path',
               'child_process', 'http', 'zlib', 'buffer', 'crypto',
               '@codemirror/view', '@codemirror/state'],
    outfile: 'main.js',
    logLevel: 'info',
    banner: { js: '/* Dendrite: bundled from src/ by esbuild; edit src/, ' +
                  'not this file. */' },
});
if (watch) await ctx.watch();
else {
    await ctx.rebuild();
    await ctx.dispose();
}
