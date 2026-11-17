# Field Notes

Expo example for `@laststance/redux-storage-middleware`. Notes and theme persist through AsyncStorage. Playwright drives the web export.

```bash
pnpm install
pnpm export:web
pnpm test:e2e
```

`pnpm ios` and `pnpm android` compile and launch a native development build (Xcode or Android SDK required). AsyncStorage 3 needs its matching native module, so use these builds rather than Expo Go, which bundles AsyncStorage 2.2 in SDK 58. This example does not exercise MMKV or a window-less runtime. The unit suite in `tests/reactNativeStorage.test.ts` covers thenable storage.
