import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const extensionConfig = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
};

const webviewConfig = {
    entryPoints: ['webview/main.ts'],
    bundle: true,
    outfile: 'dist/webview/main.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: true,
};

if (isWatch) {
    const ctx1 = await esbuild.context(extensionConfig);
    const ctx2 = await esbuild.context(webviewConfig);
    await ctx1.watch();
    await ctx2.watch();
    console.log('Watching for changes...');
} else {
    await esbuild.build(extensionConfig);
    await esbuild.build(webviewConfig);
    console.log('Build complete.');
}
