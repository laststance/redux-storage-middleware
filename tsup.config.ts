import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // tsup injects baseUrl, which TypeScript 7 rejects unless 6.0 deprecations are ignored.
  dts: {
    compilerOptions: {
      ignoreDeprecations: '6.0',
    },
  },
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['@reduxjs/toolkit', 'react-redux', 'lz-string', 'superjson'],
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.mjs' : '.cjs',
    }
  },
})
