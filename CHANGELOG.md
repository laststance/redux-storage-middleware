# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-26

### Added

- Pass AsyncStorage or any thenable storage backend. A custom `storage` hydrates even when `window` is missing, so React Native can persist state without this package depending on React Native.
- `createMMKVStorage` adapts a react-native-mmkv v4 instance (`getString` / `set` / `remove`). Missing keys become `null`.
- The Field Notes Expo example persists notes and theme through AsyncStorage, with Playwright coverage for reload, delete, theme, and clear.

### Changed

- `storage` accepts `StateStorage` (sync or async). Reads and writes run on a generation-numbered queue, so a slow `getItem` cannot restore state after `clearStorage`.
- Hydration waits until a migration write succeeds. A failed write keeps the old value and reports an error. A throwing `migrate` still clears storage.
- Empty storage, a failed load, a failed migration, and a version mismatch all call `onFinishHydration` and `onHydrationComplete`.
- `clearStorage` cancels a pending debounce, throttle, or idle save, and queues the delete before those callbacks run.
- `rehydrate()` during an in-flight read returns that same promise.

### Fixed

- A sync `onSaveComplete` can schedule the next debounce or idle save without losing the timer `clearStorage` cancels.
- `rehydrate()` from a `clearStorage` completion callback reads storage after `removeItem`.
- The in-flight `rehydrate()` promise is cleared when that read settles, including when `onHydrate` calls `rehydrate()` again.
- Do not dispatch before `onFinishHydration`. Persisted state wins the merge. `loadStateFromStorage` stays web-only.
