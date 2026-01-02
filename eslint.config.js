import { defineConfig } from 'eslint/config'
import tsPrefixer from 'eslint-config-ts-prefixer'

export default defineConfig([
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'examples/**',
      '.serena/**',
      'tests/**',
      'benchmarks/**',
      'eslint.config.js',
      'vitest.config.ts',
    ],
  },
  ...tsPrefixer,
])
