import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const copyHelper = {
  name: 'copy-helper',
  setup(build) {
    build.onEnd(async () => {
      await mkdir('dist', { recursive: true });
      await copyFile('src/profiles/python/helper.py', 'dist/helper.py');
    });
  },
};

const ctx = await esbuild.context({
  plugins: [copyHelper],
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

const renderer = await esbuild.context({
  entryPoints: ['src/renderer/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/renderer.js',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

if (watch) {
  await Promise.all([ctx.watch(), renderer.watch()]);
} else {
  await Promise.all([ctx.rebuild(), renderer.rebuild()]);
  await Promise.all([ctx.dispose(), renderer.dispose()]);
}
