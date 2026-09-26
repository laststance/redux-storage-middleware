# Field Notes

Expo example for `@laststance/redux-storage-middleware`. Notes and theme persist through AsyncStorage. Playwright drives the web export.

```bash
pnpm install
pnpm export:web
pnpm test:e2e
```

`pnpm ios` and `pnpm android` start the native app. This example does not exercise MMKV or a window-less runtime. The unit suite in `tests/reactNativeStorage.test.ts` covers thenable storage.
