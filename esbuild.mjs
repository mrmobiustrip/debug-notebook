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

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
