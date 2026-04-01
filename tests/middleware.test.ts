/**
 * Redux Storage Middleware Unit Tests
 *
 * Tests for:
 * - createStorageMiddleware: Main middleware factory
 * - loadStateFromStorage: Restore from storage
 * - clearStorageState: Clear storage
 *
 * These tests run in real browser environment via Vitest browser mode.
 * Real localStorage is used instead of jsdom mocks.
 */

import type { PayloadAction } from '@reduxjs/toolkit'
import { combineReducers, configureStore, createSlice } from '@reduxjs/toolkit'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  createStorageMiddleware,
  loadStateFromStorage,
  clearStorageState,
  deepMerge,
} from '../src/storageMiddleware'
import { createMemoryStorage } from '../src/storage'
import type { PersistedState } from '../src/types'

// Test Redux slice
interface TestState {
  value: number
  name: string
}

const testSlice = createSlice({
  name: 'test',
  initialState: { value: 0, name: 'initial' } as TestState,
  reducers: {
    increment: (state) => {
      state.value += 1
    },
    setValue: (state, action: PayloadAction<number>) => {
      state.value = action.payload
    },
    setName: (state, action: PayloadAction<string>) => {
      state.name = action.payload
    },
  },
})

interface SettingsState {
  theme: string
  language: string
}

const settingsSlice = createSlice({
  name: 'settings',
  initialState: { theme: 'light', language: 'en' } as SettingsState,
  reducers: {
    setTheme: (state, action: PayloadAction<string>) => {
      state.theme = action.payload
    },
    setLanguage: (state, action: PayloadAction<string>) => {
      state.language = action.payload
    },
  },
})

const { increment, setValue } = testSlice.actions

describe('createStorageMiddleware', () => {
  beforeEach(() => {
    // Clear real browser localStorage
    localStorage.clear()
    vi.clearAllTimers()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('saves specified slices to LocalStorage', async () => {
    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer } = createStorageMiddleware({
      rootReducer,
      key: 'test-state',
      slices: ['test'],
      performance: { debounceMs: 100 },
    })

    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Wait for auto-hydration via microtask
    await vi.advanceTimersByTimeAsync(0)

    // Dispatch action
    store.dispatch(increment())

    // Wait for debounce
    await vi.advanceTimersByTimeAsync(100)

    // Verify saved to LocalStorage
    const saved = localStorage.getItem('test-state')
    expect(saved).toBeTruthy()

    const parsed = JSON.parse(saved!) as PersistedState
    expect(parsed.state).toHaveProperty('test')
    expect((parsed.state as { test: TestState }).test.value).toBe(1)
    expect(parsed.state).not.toHaveProperty('settings')
  })

  it('debounces and saves multiple actions', async () => {
    // Spy on real localStorage
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer } = createStorageMiddleware({
      rootReducer,
      key: 'test-debounce',
      slices: ['test'],
      performance: { debounceMs: 200 },
    })

    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Wait for auto-hydration and flush all pending timers, then clear mocks
    await vi.runAllTimersAsync()
    setItemSpy.mockClear()

    // Dispatch actions consecutively
    store.dispatch(increment())
    store.dispatch(increment())
    store.dispatch(increment())

    // Not saved during debounce period
    await vi.advanceTimersByTimeAsync(100)
    // Exclude isStorageAvailable() test key and verify actual save count
    const actualSaveCalls = setItemSpy.mock.calls.filter(
      (call) => call[0] !== '__redux_storage_middleware_test__',
    )
    expect(actualSaveCalls).toHaveLength(0)

    // Saved only once after debounce completes
    await vi.advanceTimersByTimeAsync(100)
    const finalSaveCalls = setItemSpy.mock.calls.filter(
      (call) => call[0] !== '__redux_storage_middleware_test__',
    )
    expect(finalSaveCalls).toHaveLength(1)
    expect(finalSaveCalls[0][0]).toBe('test-debounce')

    const saved = localStorage.getItem('test-debounce')
    const parsed = JSON.parse(saved!) as PersistedState
    expect((parsed.state as { test: TestState }).test.value).toBe(3)

    setItemSpy.mockRestore()
  })

  it('can use throttle with throttleMs option', async () => {
    // Spy on real localStorage
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer } = createStorageMiddleware({
      rootReducer,
      key: 'test-throttle',
      slices: ['test'],
      performance: { throttleMs: 200 },
    })

    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Wait for auto-hydration and flush all pending timers, then clear mocks
    await vi.runAllTimersAsync()
    setItemSpy.mockClear()

    // Helper function: Get save count excluding isStorageAvailable() test key
    const getActualSaveCount = () =>
      setItemSpy.mock.calls.filter(
        (call) => call[0] !== '__redux_storage_middleware_test__',
      ).length

    // Immediate save on first action
    store.dispatch(increment())
    expect(getActualSaveCount()).toBe(1)

    // Action within throttle period
    store.dispatch(increment())
    expect(getActualSaveCount()).toBe(1)

    // After throttle period
    await vi.advanceTimersByTimeAsync(200)
    expect(getActualSaveCount()).toBe(2)

    setItemSpy.mockRestore()
  })

  it('performs auto-hydration by default', async () => {
    const preloadedState: PersistedState = {
      version: 0,
      state: { test: { value: 99, name: 'restored' } },
    }
    localStorage.setItem('test-auto-hydrate', JSON.stringify(preloadedState))

    const onHydrationComplete = vi.fn()

    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer } = createStorageMiddleware({
      rootReducer,
      key: 'test-auto-hydrate',
      onHydrationComplete,
    })

    configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Wait for microtask completion (auto-hydration triggers automatically)
    await vi.advanceTimersByTimeAsync(0)

    expect(onHydrationComplete).toHaveBeenCalled()
  })

  it('calls onSaveComplete callback', async () => {
    const onSaveComplete = vi.fn()

    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer } = createStorageMiddleware({
      rootReducer,
      key: 'test-onsave',
      slices: ['test'],
      performance: { debounceMs: 100 },
      onSaveComplete,
    })

    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Wait for auto-hydration via microtask
    await vi.advanceTimersByTimeAsync(0)
    store.dispatch(increment())

    await vi.advanceTimersByTimeAsync(100)

    expect(onSaveComplete).toHaveBeenCalled()
  })
})
// Note: 'calls onError callback on error' and 'can use custom storage' tests were removed
// because the 'storage' config option was removed in the YAGNI cleanup.

describe('Hydration API', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllTimers()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('api.hasHydrated() correctly reports hydration completion', async () => {
    const preloadedState: PersistedState = {
      version: 0,
      state: { test: { value: 10, name: 'restored' } },
    }
    localStorage.setItem('test-has-hydrated', JSON.stringify(preloadedState))

    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'test-has-hydrated',
    })

    configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Initially false before microtask runs
    expect(api.hasHydrated()).toBe(false)

    // Wait for auto-hydration via microtask
    await vi.advanceTimersByTimeAsync(0)

    expect(api.hasHydrated()).toBe(true)
  })

  it('api.getHydrationState() returns correct state', async () => {
    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'test-hydration-state',
    })

    configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Initially idle before microtask runs
    expect(api.getHydrationState()).toBe('idle')

    // Wait for auto-hydration via microtask
    await vi.advanceTimersByTimeAsync(0)

    expect(api.getHydrationState()).toBe('hydrated')
  })

  it('api.clearStorage() can clear storage', async () => {
    localStorage.setItem(
      'test-clear',
      JSON.stringify({ version: 0, state: {} }),
    )

    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'test-clear',
    })

    configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    expect(localStorage.getItem('test-clear')).toBeTruthy()

    api.clearStorage()

    expect(localStorage.getItem('test-clear')).toBeNull()
  })

  it('api.onFinishHydration() can register callbacks', async () => {
    const preloadedState: PersistedState = {
      version: 0,
      state: { test: { value: 42, name: 'test' } },
    }
    localStorage.setItem('test-callback', JSON.stringify(preloadedState))

    const callback = vi.fn()

    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'test-callback',
    })

    configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    const unsubscribe = api.onFinishHydration(callback)

    // Wait for auto-hydration via microtask
    await vi.advanceTimersByTimeAsync(0)

    expect(callback).toHaveBeenCalled()

    // Test unsubscribe
    unsubscribe()
  })

  it('onFinishHydration immediately calls callback if hydration already completed', async () => {
    const preloadedState: PersistedState = {
      version: 0,
      state: { test: { value: 1, name: 'test' } },
    }
    localStorage.setItem(
      'test-immediate-callback',
      JSON.stringify(preloadedState),
    )

    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'test-immediate-callback',
    })

    configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Wait for auto-hydration via microtask
    await vi.advanceTimersByTimeAsync(0)

    const callback = vi.fn()
    api.onFinishHydration(callback)

    expect(callback).toHaveBeenCalled()
  })
})

describe('Merge Strategy', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses shallowMerge by default', async () => {
    const persistedState = {
      version: 0,
      state: { test: { value: 99, name: 'persisted' } },
    }
    localStorage.setItem('test-merge-default', JSON.stringify(persistedState))

    const rootReducer = combineReducers({
      test: testSlice.reducer,
      settings: settingsSlice.reducer,
    })

    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'test-merge-default',
      performance: { debounceMs: 100 },
    })

    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(api.hasHydrated()).toBe(true)
    // shallowMerge: persisted test slice overwrites current entirely
    expect(store.getState().test).toEqual({ value: 99, name: 'persisted' })
    // settings was not persisted, so it stays at initial
    expect(store.getState().settings).toEqual({
      theme: 'light',
      language: 'en',
    })
  })

  it('uses deepMerge when provided', async () => {
    const persistedState = {
      version: 0,
      state: { test: { value: 42 } },
    }
    localStorage.setItem('test-merge-deep', JSON.stringify(persistedState))

    const rootReducer = combineReducers({
      test: testSlice.reducer,
      settings: settingsSlice.reducer,
    })

    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'test-merge-deep',
      merge: deepMerge,
      performance: { debounceMs: 100 },
    })

    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(api.hasHydrated()).toBe(true)
    // deepMerge: persisted value is merged deeply, name comes from initial state
    expect(store.getState().test).toEqual({ value: 42, name: 'initial' })
  })

  it('uses custom merge function when provided', async () => {
    const persistedState = {
      version: 0,
      state: { test: { value: 50, name: 'saved' } },
    }
    localStorage.setItem('test-merge-custom', JSON.stringify(persistedState))

    const rootReducer = combineReducers({
      test: testSlice.reducer,
      settings: settingsSlice.reducer,
    })

    // Custom merge: take persisted state but always keep current name
    const customMerge = <T extends object>(
      persisted: Partial<T>,
      current: T,
    ): T => {
      const merged = { ...current, ...persisted }
      const currentAny = current as Record<string, unknown>
      const mergedAny = merged as Record<string, unknown>
      if (
        typeof currentAny.test === 'object' &&
        currentAny.test !== null &&
        typeof mergedAny.test === 'object' &&
        mergedAny.test !== null
      ) {
        mergedAny.test = {
          ...(mergedAny.test as object),
          name: (currentAny.test as { name: string }).name,
        }
      }
      return merged as T
    }

    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'test-merge-custom',
      merge: customMerge,
      performance: { debounceMs: 100 },
    })

    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(api.hasHydrated()).toBe(true)
    // Custom merge: value from persisted, name from current (initial)
    expect(store.getState().test.value).toBe(50)
    expect(store.getState().test.name).toBe('initial')
  })
})

describe('Custom Storage', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses custom storage instead of localStorage', async () => {
    const memStorage = createMemoryStorage()

    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer } = createStorageMiddleware({
      rootReducer,
      key: 'test-custom-storage',
      storage: memStorage,
      performance: { debounceMs: 100 },
    })

    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    await vi.advanceTimersByTimeAsync(0)

    store.dispatch(increment())
    await vi.advanceTimersByTimeAsync(100)

    // Data should be in memoryStorage, not localStorage
    expect(memStorage.getItem('test-custom-storage')).toBeTruthy()
    expect(localStorage.getItem('test-custom-storage')).toBeNull()
  })

  it('hydrates from custom storage', async () => {
    const memStorage = createMemoryStorage()
    const persistedState = {
      version: 0,
      state: { test: { value: 77, name: 'from-memory' } },
    }
    memStorage.setItem('test-hydrate-custom', JSON.stringify(persistedState))

    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'test-hydrate-custom',
      storage: memStorage,
      performance: { debounceMs: 100 },
    })

    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(api.hasHydrated()).toBe(true)
    expect(store.getState().test).toEqual({ value: 77, name: 'from-memory' })
  })

  it('clears custom storage via api.clearStorage()', async () => {
    const memStorage = createMemoryStorage()
    memStorage.setItem(
      'test-clear-custom',
      JSON.stringify({ version: 0, state: {} }),
    )

    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'test-clear-custom',
      storage: memStorage,
      performance: { debounceMs: 100 },
    })

    configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    await vi.advanceTimersByTimeAsync(0)

    api.clearStorage()
    expect(memStorage.getItem('test-clear-custom')).toBeNull()
  })
})

describe('loadStateFromStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('correctly restores state from LocalStorage', () => {
    const state: PersistedState = {
      version: 0,
      state: { test: { value: 42, name: 'test' } },
    }
    localStorage.setItem('test-load', JSON.stringify(state))

    const loaded = loadStateFromStorage('test-load')
    expect(loaded).toEqual(state)
  })

  it('returns null for non-existent keys', () => {
    const loaded = loadStateFromStorage('non-existent-key')
    expect(loaded).toBeNull()
  })

  it('returns null on JSON parse error', () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})
    localStorage.setItem('test-invalid-json', 'invalid json')

    const loaded = loadStateFromStorage('test-invalid-json')
    expect(loaded).toBeNull()
    expect(consoleErrorSpy).toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })
})

describe('clearStorageState', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('correctly removes state from LocalStorage', () => {
    localStorage.setItem('test-clear', JSON.stringify({ test: 'data' }))

    expect(localStorage.getItem('test-clear')).toBeTruthy()

    clearStorageState('test-clear')

    expect(localStorage.getItem('test-clear')).toBeNull()
  })

  // Note: 'outputs error log on removeItem error using custom storage' test was removed
  // because the 'storage' config option was removed in the YAGNI cleanup.
})

describe('Integration Test: Store with Middleware', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllTimers()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('restores state from LocalStorage on Store creation and saves changes', async () => {
    // Save initial state to LocalStorage
    const preloadedState: PersistedState = {
      version: 0,
      state: { test: { value: 10, name: 'initial' } },
    }
    localStorage.setItem('integration-test', JSON.stringify(preloadedState))

    // Create root reducer with combineReducers
    const rootReducer = combineReducers({
      test: testSlice.reducer,
    })

    // Create Middleware with new API (rootReducer passed, reducer returned)
    const { middleware, reducer } = createStorageMiddleware({
      rootReducer,
      key: 'integration-test',
      slices: ['test'],
      performance: { debounceMs: 100 },
    })

    // Create Store - use returned reducer (already hydration-wrapped)
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Wait for auto-hydration via microtask
    await vi.advanceTimersByTimeAsync(0)
    // Flush all pending timers
    await vi.runAllTimersAsync()

    // Verify initial state was restored
    expect(store.getState().test.value).toBe(10)

    // Change state
    store.dispatch(setValue(20))

    // Wait for debounce
    await vi.advanceTimersByTimeAsync(100)

    // Verify saved to LocalStorage
    const saved = localStorage.getItem('integration-test')
    const parsed = JSON.parse(saved!) as PersistedState
    expect((parsed.state as { test: TestState }).test.value).toBe(20)
  })
})

// =============================================================================
// Storage Key Validation Tests
// =============================================================================

describe('Storage Key Validation', () => {
  // Create a simple rootReducer for validation tests
  const validationRootReducer = combineReducers({
    test: testSlice.reducer,
  })

  describe('createStorageMiddleware', () => {
    it('rejects empty keys', () => {
      expect(() =>
        createStorageMiddleware({
          rootReducer: validationRootReducer,
          key: '',
          slices: ['test'],
        }),
      ).toThrow('[redux-storage-middleware] Storage key must not be empty')
    })

    it('rejects keys with invalid characters', () => {
      expect(() =>
        createStorageMiddleware({
          rootReducer: validationRootReducer,
          key: 'key with spaces',
          slices: ['test'],
        }),
      ).toThrow('contains invalid characters')

      expect(() =>
        createStorageMiddleware({
          rootReducer: validationRootReducer,
          key: 'key<script>',
          slices: ['test'],
        }),
      ).toThrow('contains invalid characters')

      expect(() =>
        createStorageMiddleware({
          rootReducer: validationRootReducer,
          key: 'key/path',
          slices: ['test'],
        }),
      ).toThrow('contains invalid characters')
    })

    it('rejects reserved keys', () => {
      expect(() =>
        createStorageMiddleware({
          rootReducer: validationRootReducer,
          key: '__proto__',
          slices: ['test'],
        }),
      ).toThrow('is reserved and cannot be used')

      expect(() =>
        createStorageMiddleware({
          rootReducer: validationRootReducer,
          key: 'prototype',
          slices: ['test'],
        }),
      ).toThrow('is reserved and cannot be used')

      expect(() =>
        createStorageMiddleware({
          rootReducer: validationRootReducer,
          key: 'constructor',
          slices: ['test'],
        }),
      ).toThrow('is reserved and cannot be used')
    })

    it('accepts valid keys', () => {
      expect(() =>
        createStorageMiddleware({
          rootReducer: validationRootReducer,
          key: 'my-app-state',
          slices: ['test'],
        }),
      ).not.toThrow()

      expect(() =>
        createStorageMiddleware({
          rootReducer: validationRootReducer,
          key: 'app.settings.v2',
          slices: ['test'],
        }),
      ).not.toThrow()

      expect(() =>
        createStorageMiddleware({
          rootReducer: validationRootReducer,
          key: 'user_preferences_123',
          slices: ['test'],
        }),
      ).not.toThrow()
    })
  })

  describe('loadStateFromStorage', () => {
    it('rejects empty keys', () => {
      expect(() => loadStateFromStorage('')).toThrow(
        '[redux-storage-middleware] Storage key must not be empty',
      )
    })

    it('rejects reserved keys', () => {
      expect(() => loadStateFromStorage('__proto__')).toThrow(
        'is reserved and cannot be used',
      )
    })
  })

  describe('clearStorageState', () => {
    it('rejects empty keys', () => {
      expect(() => clearStorageState('')).toThrow(
        '[redux-storage-middleware] Storage key must not be empty',
      )
    })

    it('rejects reserved keys', () => {
      expect(() => clearStorageState('constructor')).toThrow(
        'is reserved and cannot be used',
      )
    })
  })
})
