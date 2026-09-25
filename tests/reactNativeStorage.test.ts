/**
 * React Native storage behavior
 *
 * Custom storage must hydrate without window, await thenables, and ignore a
 * getItem that finishes after clear or a newer read.
 */

import type { PayloadAction } from '@reduxjs/toolkit'
import { combineReducers, configureStore, createSlice } from '@reduxjs/toolkit'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

import { createStorageMiddleware } from '../src/storageMiddleware'
import { createMMKVStorage } from '../src/storage'
import type { StateStorage } from '../src/types'

interface TestState {
  value: number
  name: string
}

const testSlice = createSlice({
  name: 'test',
  initialState: { value: 0, name: 'initial' } as TestState,
  reducers: {
    setValue: (state, action: PayloadAction<number>) => {
      state.value = action.payload
    },
    setName: (state, action: PayloadAction<string>) => {
      state.name = action.payload
    },
  },
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function persisted(value: number, name: string, version = 0): string {
  return JSON.stringify({ version, state: { test: { value, name } } })
}

describe('async custom storage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('hydrates after a thenable getItem resolves and saves only after that', async () => {
    // Arrange
    const read = deferred<string | null>()
    const writes: string[] = []
    const storage: StateStorage = {
      getItem: () => read.promise,
      setItem: async (_key, value) => {
        writes.push(value)
      },
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'async-hydrate',
      storage,
      performance: { debounceMs: 0 },
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Act
    store.dispatch(testSlice.actions.setValue(9))
    await vi.advanceTimersByTimeAsync(0)

    // Assert — still reading, so the dispatch is not saved
    expect(api.hasHydrated()).toBe(false)
    expect(writes).toEqual([])

    read.resolve(persisted(4, 'stored'))
    await vi.advanceTimersByTimeAsync(0)

    expect(api.hasHydrated()).toBe(true)
    expect(store.getState().test).toEqual({ value: 4, name: 'stored' })
  })

  test('does not hydrate a getItem that resolves after clearStorage', async () => {
    // Arrange
    const read = deferred<string | null>()
    let removed = false
    const storage: StateStorage = {
      getItem: () => read.promise,
      setItem: async () => {},
      removeItem: async () => {
        removed = true
      },
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const onFinish = vi.fn()
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'late-read',
      storage,
      onHydrationComplete: onFinish,
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })
    await vi.advanceTimersByTimeAsync(0)

    // Act
    api.clearStorage()
    read.resolve(persisted(8, 'stale'))
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(removed).toBe(true)
    expect(store.getState().test).toEqual({ value: 0, name: 'initial' })
    expect(api.hasHydrated()).toBe(true)
    expect(onFinish).toHaveBeenCalledTimes(1)
  })

  test('stays unhydrated until the migration write resolves', async () => {
    // Arrange
    const write = deferred<void>()
    let writeStarted = false
    const storage: StateStorage = {
      getItem: async () => persisted(1, 'old', 0),
      setItem: () => {
        writeStarted = true
        return write.promise
      },
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'migrate-wait',
      version: 1,
      storage,
      migrate: (state) => ({
        ...state,
        test: { value: 1, name: 'migrated' },
      }),
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Act
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(writeStarted).toBe(true)
    expect(api.hasHydrated()).toBe(false)

    write.resolve()
    await vi.advanceTimersByTimeAsync(0)

    expect(api.hasHydrated()).toBe(true)
    expect(store.getState().test.name).toBe('migrated')
  })

  test('calls async onSaveComplete only after setItem resolves', async () => {
    // Arrange
    const write = deferred<void>()
    const onSaveComplete = vi.fn()
    const storage: StateStorage = {
      getItem: async () => null,
      setItem: () => write.promise,
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer } = createStorageMiddleware({
      rootReducer,
      key: 'async-save',
      storage,
      onSaveComplete,
      performance: { debounceMs: 0 },
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })
    await vi.advanceTimersByTimeAsync(0)

    // Act
    store.dispatch(testSlice.actions.setName('saved'))
    await vi.advanceTimersByTimeAsync(0)
    expect(onSaveComplete).not.toHaveBeenCalled()

    write.resolve()
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(onSaveComplete).toHaveBeenCalledTimes(1)
  })

  test('does not setItem when clearStorage cancels a debounced save', async () => {
    // Arrange
    const writes: string[] = []
    const storage: StateStorage = {
      getItem: () => persisted(1, 'kept'),
      setItem: (_key, value) => {
        writes.push(value)
      },
      removeItem: () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'cancel-debounce',
      storage,
      performance: { debounceMs: 300 },
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })
    await vi.advanceTimersByTimeAsync(0)
    store.dispatch(testSlice.actions.setValue(3))

    // Act
    api.clearStorage()
    await vi.advanceTimersByTimeAsync(300)

    // Assert — hydration did not write, and the cancelled save did not either
    expect(writes).toEqual([])
  })

  test('keeps the stored value when the migration write fails', async () => {
    // Arrange
    const onError = vi.fn()
    const onFinish = vi.fn()
    let removed = false
    const storage: StateStorage = {
      getItem: async () => persisted(2, 'original', 0),
      setItem: async () => {
        throw new Error('disk full')
      },
      removeItem: async () => {
        removed = true
      },
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'migrate-write-fail',
      version: 1,
      storage,
      migrate: (state) => state,
      onError,
      onHydrationComplete: onFinish,
    })
    configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Act
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(removed).toBe(false)
    expect(api.getHydrationState()).toBe('error')
    expect(api.hasHydrated()).toBe(false)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'disk full' }),
      'save',
    )
    expect(onFinish).toHaveBeenCalledTimes(1)
  })

  test('notifies finish callbacks when storage is empty', async () => {
    // Arrange
    const onFinish = vi.fn()
    const storage: StateStorage = {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'empty-notify',
      storage,
      onHydrationComplete: onFinish,
    })
    const finished = vi.fn()
    api.onFinishHydration(finished)
    configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Act
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(api.hasHydrated()).toBe(true)
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(finished).toHaveBeenCalledTimes(1)
  })

  test('overwrites a dispatch that happened while getItem was pending', async () => {
    // Arrange
    const read = deferred<string | null>()
    const storage: StateStorage = {
      getItem: () => read.promise,
      setItem: async () => {},
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer } = createStorageMiddleware({
      rootReducer,
      key: 'dispatch-during-read',
      storage,
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })
    await vi.advanceTimersByTimeAsync(0)
    store.dispatch(testSlice.actions.setName('typed-too-soon'))

    // Act
    read.resolve(persisted(1, 'persisted'))
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(store.getState().test).toEqual({ value: 1, name: 'persisted' })
  })

  test('second rehydrate waits for the in-flight read', async () => {
    // Arrange
    const read = deferred<string | null>()
    const storage: StateStorage = {
      getItem: () => read.promise,
      setItem: async () => {},
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'shared-rehydrate',
      storage,
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })
    await vi.advanceTimersByTimeAsync(0)
    let secondResolved = false

    // Act
    const second = api.rehydrate().then(() => {
      secondResolved = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(secondResolved).toBe(false)

    read.resolve(persisted(6, 'shared'))
    await second
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(secondResolved).toBe(true)
    expect(store.getState().test.name).toBe('shared')
  })

  test('calls onFinishHydration when migrate throws', async () => {
    // Arrange
    const onFinish = vi.fn()
    let removed = false
    const storage: StateStorage = {
      getItem: async () => persisted(1, 'bad', 0),
      setItem: async () => {},
      removeItem: async () => {
        removed = true
      },
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'migrate-throw-notify',
      version: 1,
      storage,
      migrate: () => {
        throw new Error('bad migrate')
      },
      onHydrationComplete: onFinish,
    })
    configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Act
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(removed).toBe(true)
    expect(api.hasHydrated()).toBe(true)
    expect(onFinish).toHaveBeenCalledTimes(1)
  })

  test('hydrates from a thenable that is not a Promise', async () => {
    // Arrange
    let fulfill: (value: string | null) => void = () => {}
    const read = {
      then(onFulfilled: (value: string | null) => void) {
        fulfill = onFulfilled
      },
    }
    const storage: StateStorage = {
      getItem: () => read as unknown as Promise<string | null>,
      setItem: async () => {},
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'plain-thenable',
      storage,
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Act
    await vi.advanceTimersByTimeAsync(0)
    expect(api.hasHydrated()).toBe(false)
    fulfill(persisted(3, 'thenable'))
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(api.hasHydrated()).toBe(true)
    expect(store.getState().test).toEqual({ value: 3, name: 'thenable' })
  })

  test('reports an error when getItem rejects', async () => {
    // Arrange
    const onError = vi.fn()
    const onFinish = vi.fn()
    const storage: StateStorage = {
      getItem: async () => {
        throw new Error('read failed')
      },
      setItem: async () => {},
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'read-reject',
      storage,
      onError,
      onHydrationComplete: onFinish,
    })
    configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Act
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(api.getHydrationState()).toBe('error')
    expect(api.hasHydrated()).toBe(false)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'read failed' }),
      'load',
    )
    expect(onFinish).toHaveBeenCalledTimes(1)
  })

  test('reports a save error when setItem rejects after hydration', async () => {
    // Arrange
    const onError = vi.fn()
    const onSaveComplete = vi.fn()
    const storage: StateStorage = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error('save failed')
      },
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer } = createStorageMiddleware({
      rootReducer,
      key: 'save-reject',
      storage,
      onError,
      onSaveComplete,
      performance: { debounceMs: 0 },
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })
    await vi.advanceTimersByTimeAsync(0)

    // Act
    store.dispatch(testSlice.actions.setName('later'))
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(onSaveComplete).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'save failed' }),
      'save',
    )
  })
})

describe('createMMKVStorage', () => {
  test('returns null for a missing key and deletes with remove', () => {
    // Arrange
    const data = new Map<string, string>()
    const removed: string[] = []
    const mmkv = {
      getString: (key: string) => data.get(key),
      set: (key: string, value: string) => {
        data.set(key, value)
      },
      remove: (key: string) => {
        removed.push(key)
        data.delete(key)
      },
    }
    const storage = createMMKVStorage(mmkv)

    // Act
    const missing = storage.getItem('absent')
    storage.setItem('theme', 'dark')
    storage.removeItem('theme')

    // Assert
    expect(missing).toBeNull()
    expect(removed).toEqual(['theme'])
    expect(storage.getItem('theme')).toBeNull()
  })
})
