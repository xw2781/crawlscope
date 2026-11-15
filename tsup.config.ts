import { defineConfig } from 'tsup';
import { readFileSync, cpSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  onSuccess: async () => { cpSync('src/web', 'dist/web', { recursive: true }); },
  format: ['esm'], target: 'node20', dts: { entry: { index: 'src/index.ts' } },
  clean: true, sourcemap: false, splitting: false,
  define: { __VERSION__: JSON.stringify(pkg.version) },
  banner: ({ format }) => ({ js: '' }),
});
