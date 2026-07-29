import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function capabilityAssets(): Plugin {
  return {
    name: 'blog-capability-assets',
    apply: 'build',
    async closeBundle() {
      const output = resolve('dist/client/capabilities');
      const katexOutput = resolve(output, 'katex');
      await mkdir(katexOutput, { recursive: true });

      const sourceCss = await readFile(resolve('node_modules/katex/dist/katex.min.css'), 'utf8');
      const fontSource = /src:url\(fonts\/([^)]*?\.woff2)\) format\("woff2"\),url\(fonts\/[^)]*?\.woff\) format\("woff"\),url\(fonts\/[^)]*?\.ttf\) format\("truetype"\)/g;
      const fonts = [...sourceCss.matchAll(fontSource)].map((match) => match[1]);
      if (fonts.length !== 20) throw new Error(`KaTeX 字体清单异常：预期 20，实际 ${fonts.length}`);
      const katexCss = sourceCss.replace(fontSource, (_source, filename: string) => `src:url("./katex/${filename}") format("woff2")`);
      await Promise.all(fonts.map((filename) => copyFile(
        resolve('node_modules/katex/dist/fonts', filename),
        resolve(katexOutput, filename),
      )));
      await Promise.all([
        writeFile(resolve(output, 'katex.min.css'), katexCss),
        copyFile(resolve('node_modules/highlight.js/styles/github.css'), resolve(output, 'highlight-github.css')),
      ]);
    },
  };
}

export default defineConfig({
  plugins: [react(), capabilityAssets()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@codemirror')) return 'editor';
          if (id.includes('node_modules/react') || id.includes('node_modules\\react')) return 'framework';
          if (id.includes('node_modules/diff') || id.includes('node_modules\\diff') || id.includes('node_modules/fflate') || id.includes('node_modules\\fflate')) return 'manage-tools';
          return undefined;
        },
      },
    },
  },
});
