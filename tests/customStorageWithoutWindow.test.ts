/**
 * Custom storage must still read and write when isServer() is true.
 * Default web storage stays a no-op in that environment.
 */

import { combineReducers, configureStore, createSlice } from '@reduxjs/toolkit'
import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest'

vi.mock('../src/utils/isServer.js', () => ({
  isServer: () => true,
  isBrowser: () => false,
  isStorageAvailable: () => false,
  isSessionStorageAvailable: () => false,
}))

import { createStorageMiddleware } from '../src/storageMiddleware'

const testSlice = createSlice({
  name: 'test',
  initialState: { value: 0 },
  reducers: {
    setValue: (state, action: { payload: number }) => {
      state.value = action.payload
    },
  },
})

describe('custom storage while isServer() is true', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('reads and writes the custom backend', async () => {
    // Arrange
    const data = new Map<string, string>()
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value)
      },
      removeItem: (key: string) => {
        data.delete(key)
      },
    }
    data.set(
      'rn-ssr',
      JSON.stringify({ version: 0, state: { test: { value: 5 } } }),
    )
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'rn-ssr',
      storage,
      performance: { debounceMs: 0 },
    })
    const store = configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Act
    await vi.advanceTimersByTimeAsync(0)

    // Assert — custom storage hydrates even when isServer() is true
    expect(api.hasHydrated()).toBe(true)
    expect(store.getState().test.value).toBe(5)

    store.dispatch(testSlice.actions.setValue(11))
    await vi.advanceTimersByTimeAsync(0)
    const saved = JSON.parse(data.get('rn-ssr') ?? '{}') as {
      state: { test: { value: number } }
    }
    expect(saved.state.test.value).toBe(11)
  })

  test('does not touch localStorage when no custom storage is passed', async () => {
    // Arrange
    const rootReducer = combineReducers({ test: testSlice.reducer })
    const { middleware, reducer, api } = createStorageMiddleware({
      rootReducer,
      key: 'default-ssr',
    })
    configureStore({
      reducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(middleware),
    })

    // Act
    await vi.advanceTimersByTimeAsync(0)

    // Assert
    expect(api.hasHydrated()).toBe(false)
  })
})
