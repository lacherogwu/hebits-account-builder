import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  deps: { alwaysBundle: [/.*/] },
  fixedExtension: true,
  dts: false,
  sourcemap: true,
  clean: true,
});
