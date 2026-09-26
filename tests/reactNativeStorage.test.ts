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
    let written = ''
    const storage: StateStorage = {
      getItem: async () => persisted(1, 'old', 0),
      setItem: (_key, value) => {
        written = value
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
    expect(JSON.parse(written)).toEqual({
      version: 1,
      state: { test: { value: 1, name: 'migrated' } },
    })
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
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Act
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(store.getState().test).toEqual({ value: 0, name: 'initial' })
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
    let reads = 0
    const storage: StateStorage = {
      getItem: () => {
        reads += 1
        return read.promise
      },
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
    const second = api.rehydrate()
    const third = api.rehydrate()
    void second.then(() => {
      secondResolved = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(secondResolved).toBe(false)
    expect(third).toBe(second)
    expect(reads).toBe(1)

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

  test('reports an error when persisted state is an array', async () => {
    // Arrange
    const onFinish = vi.fn()
    const storage: StateStorage = {
      getItem: async () => JSON.stringify({ version: 0, state: ['note'] }),
      setItem: async () => {},
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'array-state',
      storage,
      onHydrationComplete: onFinish,
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Act
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(api.getHydrationState()).toBe('error')
    expect(api.hasHydrated()).toBe(false)
    expect(store.getState().test).toEqual({ value: 0, name: 'initial' })
    expect(onFinish).toHaveBeenCalledTimes(1)
  })

  test('reports an error when stored JSON is not an object', async () => {
    // Arrange
    const onFinish = vi.fn()
    const storage: StateStorage = {
      getItem: async () => 'null',
      setItem: async () => {},
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'bad-shape',
      storage,
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
    expect(onFinish).toHaveBeenCalledTimes(1)
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

  test('does not report a save error after clearStorage supersedes that write', async () => {
    // Arrange
    const write = deferred<void>()
    const onError = vi.fn()
    const storage: StateStorage = {
      getItem: async () => null,
      setItem: () => write.promise,
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'stale-save-error',
      storage,
      onError,
      performance: { debounceMs: 0 },
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })
    await vi.advanceTimersByTimeAsync(0)
    store.dispatch(testSlice.actions.setName('later'))
    await vi.advanceTimersByTimeAsync(0)

    // Act
    api.clearStorage()
    write.reject(new Error('save failed'))
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(onError).not.toHaveBeenCalled()
  })

  test('keeps the initial store when persisted state is null or missing', async () => {
    // Arrange
    const payloads = [
      JSON.stringify({ version: 0, state: null }),
      JSON.stringify({ version: 0 }),
    ]
    for (const payload of payloads) {
      const storage: StateStorage = {
        getItem: async () => payload,
        setItem: async () => {},
        removeItem: async () => {},
      }
      const rootReducer = combineReducers({ test: testSlice.reducer })
      const { middleware, reducer, api } = createStorageMiddleware({
        rootReducer,
        key: `bad-state-${payload.length}`,
        storage,
      })
      const store = configureStore({
        reducer,
        middleware: (getDefaultMiddleware) =>
          getDefaultMiddleware().concat(middleware),
      })

      // Act
      await vi.advanceTimersByTimeAsync(0)

      // Assert
      expect(api.getHydrationState()).toBe('error')
      expect(api.hasHydrated()).toBe(false)
      expect(store.getState().test).toEqual({ value: 0, name: 'initial' })
    }
  })

  test('rehydrate after clearStorage ignores the aborted payload', async () => {
    // Arrange
    const first = deferred<string | null>()
    const second = deferred<string | null>()
    let reads = 0
    const storage: StateStorage = {
      getItem: () => {
        reads += 1
        return reads === 1 ? first.promise : second.promise
      },
      setItem: async () => {},
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'clear-then-rehydrate',
      storage,
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })
    await vi.advanceTimersByTimeAsync(0)

    // Act
    api.clearStorage()
    const again = api.rehydrate()
    first.resolve(persisted(1, 'stale'))
    second.resolve(persisted(4, 'fresh'))
    await again
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(reads).toBe(2)
    expect(store.getState().test).toEqual({ value: 4, name: 'fresh' })
  })

  test('a rehydrate from the clear completion reads after removeItem', async () => {
    // Arrange
    const first = deferred<string | null>()
    let deleted = false
    let reads = 0
    const storage: StateStorage = {
      getItem: () => {
        reads += 1
        if (reads === 1) {
          return first.promise
        }
        return Promise.resolve(deleted ? null : persisted(9, 'before-delete'))
      },
      setItem: async () => {},
      removeItem: async () => {
        deleted = true
      },
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'clear-callback-rehydrate',
      storage,
    })
    let restarted = false
    api.onFinishHydration(() => {
      if (restarted) {
        return
      }
      restarted = true
      void api.rehydrate()
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })
    await vi.advanceTimersByTimeAsync(0)

    // Act
    api.clearStorage()
    first.resolve(persisted(1, 'stale'))
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(deleted).toBe(true)
    expect(store.getState().test).toEqual({ value: 0, name: 'initial' })
  })

  test('waits for a non-Promise setItem thenable before onSaveComplete', async () => {
    // Arrange
    let fulfill: () => void = () => {}
    const writes: string[] = []
    const onSaveComplete = vi.fn()
    const storage: StateStorage = {
      getItem: async () => null,
      setItem: (_key, value) => {
        writes.push(value)
        return {
          then(onFulfilled: () => void) {
            fulfill = onFulfilled
          },
        } as unknown as Promise<void>
      },
      removeItem: async () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer } = createStorageMiddleware({
      rootReducer,
      key: 'thenable-set',
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

    // Assert
    expect(onSaveComplete).not.toHaveBeenCalled()
    expect(JSON.parse(writes[0]).state.test.name).toBe('saved')

    fulfill()
    await vi.advanceTimersByTimeAsync(0)
    expect(onSaveComplete).toHaveBeenCalledTimes(1)
  })

  test('clearStorage drops a save scheduled from a sync onSaveComplete', async () => {
    // Arrange
    const writes: string[] = []
    const storage: StateStorage = {
      getItem: () => null,
      setItem: (_key, value) => {
        writes.push(value)
      },
      removeItem: () => {},
    }
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'sync-reschedule',
      storage,
      performance: { debounceMs: 50 },
      onSaveComplete: () => {
        store.dispatch(testSlice.actions.setValue(2))
      },
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })
    await vi.advanceTimersByTimeAsync(0)
    store.dispatch(testSlice.actions.setValue(1))

    // Act
    await vi.advanceTimersByTimeAsync(50)
    api.clearStorage()
    await vi.advanceTimersByTimeAsync(50)

    // Assert — the follow-up dispatch must not be written after clear
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]).state.test.value).toBe(1)
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
    const stored = storage.getItem('theme')
    storage.removeItem('theme')

    // Assert
    expect(missing).toBeNull()
    expect(stored).toBe('dark')
    expect(removed).toEqual(['theme'])
    expect(storage.getItem('theme')).toBeNull()
  })
})
