/**
 * Redux Storage Middleware
 *
 * Custom middleware for synchronizing Redux state with LocalStorage
 * SSR-safe and robust implementation based on patterns from jotai/zustand
 */

import type {
  Middleware,
  MiddlewareAPI,
  Dispatch,
  UnknownAction,
  Reducer,
} from '@reduxjs/toolkit'

import { defaultJsonSerializer } from './serializers/json.js'
import { createSafeLocalStorage } from './storage.js'
import type {
  StorageMiddlewareConfig,
  StorageMiddlewareResult,
  HydrationApi,
  HydrationState,
  PersistedState,
} from './types.js'
import { debounce } from './utils/debounce.js'
import { isServer, isStorageAvailable } from './utils/isServer.js'
import { throttle, scheduleIdleCallback } from './utils/throttle.js'

// =============================================================================
// Constants
// =============================================================================

const ACTION_HYDRATE_START = '@@redux-storage-middleware/HYDRATE_START'
const ACTION_HYDRATE_COMPLETE = '@@redux-storage-middleware/HYDRATE_COMPLETE'
const ACTION_HYDRATE_ERROR = '@@redux-storage-middleware/HYDRATE_ERROR'

const DEFAULT_DEBOUNCE_MS = 300

/**
 * Promise detection for storage backends that are not native Promises.
 *
 * React Native storage often returns a thenable. `instanceof Promise` misses
 * those and would persist the thenable object itself.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  )
}

/**
 * Minimum and maximum length for storage keys
 */
const MIN_STORAGE_KEY_LENGTH = 1
const MAX_STORAGE_KEY_LENGTH = 255

/**
 * Valid storage key pattern
 * Only alphanumeric characters, dots, underscores, and hyphens are allowed
 */
const VALID_STORAGE_KEY_PATTERN = /^[a-zA-Z0-9._-]+$/

/**
 * Reserved keys prohibited for security reasons
 * Prevents prototype pollution attacks
 */
const RESERVED_STORAGE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

// =============================================================================
// Validation
// =============================================================================

/**
 * Validates storage key
 *
 * @param key - The storage key to validate
 * @throws Error if the key is invalid
 *
 * @example
 * ```ts
 * validateStorageKey('my-app-state')  // OK
 * validateStorageKey('app.settings')  // OK
 * validateStorageKey('')              // Error: empty key
 * validateStorageKey('__proto__')     // Error: reserved word
 * validateStorageKey('key with spaces') // Error: invalid characters
 * ```
 */
function validateStorageKey(key: string): void {
  // Length check
  if (key.length < MIN_STORAGE_KEY_LENGTH) {
    throw new Error(`[redux-storage-middleware] Storage key must not be empty`)
  }

  if (key.length > MAX_STORAGE_KEY_LENGTH) {
    throw new Error(
      `[redux-storage-middleware] Storage key must not exceed ${MAX_STORAGE_KEY_LENGTH} characters`,
    )
  }

  // Pattern check
  if (!VALID_STORAGE_KEY_PATTERN.test(key)) {
    throw new Error(
      `[redux-storage-middleware] Storage key "${key}" contains invalid characters. ` +
        `Only alphanumeric characters, dots, underscores, and hyphens are allowed.`,
    )
  }

  // Reserved word check
  if (RESERVED_STORAGE_KEYS.has(key)) {
    throw new Error(
      `[redux-storage-middleware] Storage key "${key}" is reserved and cannot be used.`,
    )
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Shallow merge (default)
 */
function shallowMerge<T extends object>(
  persistedState: Partial<T>,
  currentState: T,
): T {
  return { ...currentState, ...persistedState }
}

/**
 * Deep merge
 */
function deepMerge<T extends object>(
  persistedState: Partial<T>,
  currentState: T,
): T {
  const result = { ...currentState } as Record<string, unknown>

  for (const key in persistedState) {
    if (Object.prototype.hasOwnProperty.call(persistedState, key)) {
      const persistedValue = persistedState[key]
      const currentValue = result[key]

      if (
        typeof persistedValue === 'object' &&
        persistedValue !== null &&
        typeof currentValue === 'object' &&
        currentValue !== null &&
        !Array.isArray(persistedValue)
      ) {
        result[key] = deepMerge(
          persistedValue as Record<string, unknown>,
          currentValue as Record<string, unknown>,
        )
      } else {
        result[key] = persistedValue
      }
    }
  }

  return result as T
}

// =============================================================================
// Storage Middleware Factory
// =============================================================================

/**
 * Creates Storage Middleware
 *
 * @param config - Middleware configuration (rootReducer is required)
 * @returns Middleware, hydration-wrapped reducer, and hydration API
 *
 * @example
 * ```ts
 * import { combineReducers, configureStore } from '@reduxjs/toolkit'
 *
 * const rootReducer = combineReducers({
 *   settings: settingsReducer,
 *   board: boardReducer,
 * })
 *
 * const { middleware, reducer, api } = createStorageMiddleware({
 *   rootReducer,  // Required: pass your root reducer
 *   key: 'my-app-state',
 *   slices: ['settings'],
 *   version: 1,
 *   migrate: (state, oldVersion) => {
 *     if (oldVersion < 1) {
 *       state.settings = { ...state.settings, newField: 'default' }
 *     }
 *     return state
 *   },
 * })
 *
 * const store = configureStore({
 *   reducer,  // Use the returned reducer (already hydration-wrapped)
 *   middleware: (getDefaultMiddleware) =>
 *     getDefaultMiddleware().concat(middleware),
 * })
 *
 * // Hydration happens automatically on client
 * // Use api.hasHydrated() to check status
 * ```
 */
export function createStorageMiddleware<
  S extends object = Record<string, unknown>,
>(config: StorageMiddlewareConfig<S>): StorageMiddlewareResult<S> {
  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  const {
    rootReducer,
    key,
    slices,
    storage: customStorage,
    serializer: customSerializer,
    version: configVersion = 0,
    migrate,
    merge,
    performance: perfConfig,
    onHydrationComplete,
    onSaveComplete,
    onError,
  } = config

  // Resolve merge strategy (default: shallow merge)
  const mergeFn = merge ?? shallowMerge

  // Resolve serializer (default: JSON)
  const serializer = customSerializer ?? defaultJsonSerializer

  // Validate rootReducer is required
  if (!rootReducer || typeof rootReducer !== 'function') {
    throw new Error(
      '[redux-storage-middleware] rootReducer is required. ' +
        'Pass your root reducer to createStorageMiddleware({ rootReducer, ... })',
    )
  }

  // Validate storage key (security measure)
  validateStorageKey(key)

  // Create hydration-wrapped reducer
  const hydratedReducer = withHydration(rootReducer) as Reducer<S>

  // Resolve performance configuration
  const debounceMs = perfConfig?.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const throttleMs = perfConfig?.throttleMs
  const useIdleCallback = perfConfig?.useIdleCallback ?? false
  const idleTimeout = perfConfig?.idleTimeout ?? 1000

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let hydrationState: HydrationState = 'idle'
  let hydratedState: S | null = null
  let storeApi: MiddlewareAPI<Dispatch<UnknownAction>, S> | null = null

  const hydrateCallbacks = new Set<(state: S) => void>()
  const finishHydrationCallbacks = new Set<(state: S) => void>()

  // ---------------------------------------------------------------------------
  // Storage Setup
  // ---------------------------------------------------------------------------

  // Custom storage skips the window check so React Native can hydrate.
  // Default localStorage still noops when window is missing.
  const usesDefaultWebStorage = customStorage === undefined
  const storage = customStorage ?? createSafeLocalStorage()
  const skipWebSsr = (): boolean => usesDefaultWebStorage && isServer()

  // Generation-numbered serial queue. A late getItem whose generation no
  // longer matches does not hydrate. Sync jobs run inline when the queue is idle.
  let generation = 0
  let ioChain: Promise<void> = Promise.resolve()
  let ioBusy = false
  let inflightRehydrate: Promise<void> | null = null
  let cancelScheduledSave: (() => void) | null = null
  let hydrationSettled = false

  const enqueue = async <T>(job: () => T | PromiseLike<T>): Promise<T> => {
    const track = async (scheduled: Promise<T>): Promise<T> => {
      const settled = scheduled.then(
        () => undefined,
        () => undefined,
      )
      ioBusy = true
      ioChain = settled
      void settled.then(() => {
        if (ioChain === settled) {
          ioBusy = false
        }
      })
      return scheduled
    }

    if (!ioBusy) {
      try {
        const result = job()
        if (!isThenable(result)) {
          return Promise.resolve(result)
        }
        return track(Promise.resolve(result))
      } catch (error) {
        return Promise.reject(error)
      }
    }

    return track(ioChain.then(() => job()))
  }

  const callbackState = (override: S | null): S =>
    override ?? storeApi?.getState() ?? ({} as S)

  const notifySettled = (stateForCallback: S): void => {
    hydrationSettled = true
    onHydrationComplete?.(stateForCallback)
    for (const callback of finishHydrationCallbacks) {
      callback(stateForCallback)
    }
  }

  const finishHydrated = (myGen: number, next: S | null): boolean => {
    if (myGen !== generation) {
      return false
    }
    hydrationState = 'hydrated'
    hydratedState = next
    notifySettled(callbackState(next))
    return true
  }

  const finishError = (myGen: number, error: unknown): boolean => {
    if (myGen !== generation) {
      return false
    }
    console.error('[redux-storage-middleware] Hydration failed:', error)
    hydrationState = 'error'
    hydratedState = null
    onError?.(error as Error, 'load')
    notifySettled(callbackState(null))
    return true
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Extracts state to save
   */
  const extractStateToSave = (state: S): Partial<S> => {
    if (slices && slices.length > 0) {
      // Select using slices array
      const stateToSave = {} as Partial<S>
      for (const sliceName of slices) {
        const value = (state as Record<string, unknown>)[sliceName]
        if (value !== undefined) {
          ;(stateToSave as Record<string, unknown>)[sliceName] = value
        }
      }
      return stateToSave
    }
    // Save entire state
    return state
  }

  /**
   * Saves to storage.
   *
   * Sync setItem calls onSaveComplete before this function returns when the
   * queue is idle. A thenable setItem calls it only after that write settles.
   * A generation change (clearStorage) drops the write.
   */
  const saveToStorage = (state: S): void => {
    if (skipWebSsr()) {
      return
    }

    const scheduledGen = generation
    void enqueue(async () => {
      if (scheduledGen !== generation) {
        return
      }

      try {
        const stateToSave = extractStateToSave(state)
        const persistedState: PersistedState<Partial<S>> = {
          version: configVersion,
          state: stateToSave,
        }
        const serialized = serializer.serialize(persistedState)
        const written = storage.setItem(key, serialized)
        if (isThenable(written)) {
          return Promise.resolve(written).then(
            () => {
              if (scheduledGen === generation) {
                onSaveComplete?.(state)
              }
            },
            (error: unknown) => {
              console.error(
                '[redux-storage-middleware] Failed to save state:',
                error,
              )
              onError?.(error as Error, 'save')
            },
          )
        }
        onSaveComplete?.(state)
      } catch (error) {
        console.error('[redux-storage-middleware] Failed to save state:', error)
        onError?.(error as Error, 'save')
      }
    })
  }

  const commitMerge = (myGen: number, state: Partial<S>): void => {
    if (myGen !== generation) {
      return
    }
    if (storeApi) {
      const currentState = storeApi.getState()
      hydratedState = mergeFn(state, currentState)
      storeApi.dispatch({
        type: ACTION_HYDRATE_COMPLETE,
        payload: hydratedState,
      })
    } else {
      hydratedState = state as S
    }
    hydrationState = 'hydrated'
    notifySettled(callbackState(hydratedState))
  }

  const removeStored = async (myGen: number): Promise<void> =>
    enqueue(async () => {
      if (myGen !== generation) {
        return
      }
      try {
        const removed = storage.removeItem(key)
        if (isThenable(removed)) {
          return Promise.resolve(removed).then(
            () => {
              finishHydrated(myGen, null)
            },
            (error: unknown) => {
              finishError(myGen, error)
            },
          )
        }
        finishHydrated(myGen, null)
      } catch (error) {
        finishError(myGen, error)
      }
    })

  const writeMigrated = async (
    myGen: number,
    state: Partial<S>,
  ): Promise<void> => {
    let serialized: string
    try {
      serialized = serializer.serialize({
        version: configVersion,
        state,
      })
    } catch (error) {
      finishError(myGen, error)
      return Promise.resolve()
    }

    return enqueue(async () => {
      if (myGen !== generation) {
        return
      }
      try {
        const written = storage.setItem(key, serialized)
        if (isThenable(written)) {
          return Promise.resolve(written).then(
            () => {
              commitMerge(myGen, state)
            },
            (error: unknown) => {
              if (myGen !== generation) {
                return
              }
              console.error(
                '[redux-storage-middleware] Failed to save migrated state:',
                error,
              )
              hydrationState = 'error'
              hydratedState = null
              onError?.(error as Error, 'save')
              notifySettled(callbackState(null))
            },
          )
        }
        commitMerge(myGen, state)
      } catch (error) {
        if (myGen !== generation) {
          return
        }
        console.error(
          '[redux-storage-middleware] Failed to save migrated state:',
          error,
        )
        hydrationState = 'error'
        hydratedState = null
        onError?.(error as Error, 'save')
        notifySettled(callbackState(null))
      }
    })
  }

  const applyLoaded = async (
    myGen: number,
    serialized: string | null,
  ): Promise<void> => {
    if (myGen !== generation) {
      return Promise.resolve()
    }
    if (serialized === null) {
      finishHydrated(myGen, null)
      return Promise.resolve()
    }

    let persisted: PersistedState<Partial<S>>
    try {
      persisted = serializer.deserialize(serialized) as PersistedState<
        Partial<S>
      >
    } catch (error) {
      console.error('[redux-storage-middleware] Failed to load state:', error)
      finishError(myGen, error)
      return Promise.resolve()
    }

    const storedState =
      persisted !== null &&
      typeof persisted === 'object' &&
      !Array.isArray(persisted) &&
      'state' in persisted
        ? persisted.state
        : undefined
    if (
      storedState === undefined ||
      storedState === null ||
      typeof storedState !== 'object' ||
      Array.isArray(storedState)
    ) {
      finishError(myGen, new Error('Stored value is not a persisted state'))
      return Promise.resolve()
    }

    const storedVersion = persisted.version ?? 0
    let state = persisted.state

    if (storedVersion !== configVersion) {
      if (migrate) {
        try {
          state = migrate(state, storedVersion)
        } catch (error) {
          console.error('[redux-storage-middleware] Migration failed:', error)
          onError?.(error as Error, 'load')
          return removeStored(myGen)
        }
        return writeMigrated(myGen, state)
      }

      console.warn(
        `[redux-storage-middleware] Version mismatch (stored: ${storedVersion}, config: ${configVersion}). ` +
          'No migrate function provided. Clearing storage.',
      )
      return removeStored(myGen)
    }

    commitMerge(myGen, state)
    return Promise.resolve()
  }

  // ---------------------------------------------------------------------------
  // Debounce/Throttle Setup
  // ---------------------------------------------------------------------------

  let saveHandler: ((state: S) => void) | null = null

  const setupSaveHandler = (): void => {
    if (useIdleCallback) {
      const { scheduledFn, cancel } = scheduleIdleCallback(saveToStorage, {
        timeout: idleTimeout,
      })
      saveHandler = scheduledFn
      cancelScheduledSave = cancel
    } else if (throttleMs) {
      const { throttledFn, cancel } = throttle(saveToStorage, throttleMs)
      saveHandler = throttledFn
      cancelScheduledSave = cancel
    } else {
      const { debouncedFn, cancel } = debounce(saveToStorage, debounceMs)
      saveHandler = debouncedFn
      cancelScheduledSave = cancel
    }
  }

  setupSaveHandler()

  // ---------------------------------------------------------------------------
  // Hydration API
  // ---------------------------------------------------------------------------

  const api: HydrationApi<S> = {
    rehydrate: async (): Promise<void> => {
      // A second call waits for the read already in flight.
      if (hydrationState === 'hydrating' && inflightRehydrate) {
        return inflightRehydrate
      }

      if (skipWebSsr()) {
        return Promise.resolve()
      }

      const myGen = ++generation
      hydrationState = 'hydrating'
      hydrationSettled = false

      for (const callback of hydrateCallbacks) {
        callback(storeApi?.getState() as S)
      }

      const run = enqueue(async () => {
        if (myGen !== generation) {
          return null
        }
        return storage.getItem(key)
      }).then(
        async (serialized) => {
          if (myGen !== generation) {
            return
          }
          try {
            await applyLoaded(myGen, serialized)
          } catch (error) {
            finishError(myGen, error)
          }
        },
        (error: unknown) => {
          finishError(myGen, error)
        },
      )

      inflightRehydrate = run.finally(() => {
        if (inflightRehydrate === run) {
          inflightRehydrate = null
        }
      })
      return inflightRehydrate
    },

    hasHydrated: (): boolean => {
      return hydrationState === 'hydrated'
    },

    getHydrationState: (): HydrationState => {
      return hydrationState
    },

    getHydratedState: (): S | null => {
      return hydratedState
    },

    clearStorage: (): void => {
      if (skipWebSsr()) {
        return
      }

      // Drop a debounced/throttled/idle save so it cannot write deleted state back.
      cancelScheduledSave?.()
      const wasHydrating = hydrationState === 'hydrating'
      generation += 1

      // The in-flight getItem sees the new generation and must not hydrate.
      // This call owns the terminal state for that aborted read.
      if (wasHydrating) {
        hydrationState = 'hydrated'
        hydratedState = null
        notifySettled(callbackState(null))
      }

      void enqueue(async () => {
        try {
          const removed = storage.removeItem(key)
          if (isThenable(removed)) {
            return Promise.resolve(removed).then(
              () => undefined,
              (error: unknown) => {
                console.error(
                  '[redux-storage-middleware] Failed to clear storage:',
                  error,
                )
                onError?.(error as Error, 'clear')
              },
            )
          }
        } catch (error) {
          console.error(
            '[redux-storage-middleware] Failed to clear storage:',
            error,
          )
          onError?.(error as Error, 'clear')
        }
      })
    },

    onHydrate: (callback: (state: S) => void): (() => void) => {
      hydrateCallbacks.add(callback)
      return (): void => {
        hydrateCallbacks.delete(callback)
      }
    },

    onFinishHydration: (callback: (state: S) => void): (() => void) => {
      finishHydrationCallbacks.add(callback)

      // Settled means hydrated, error, or a read aborted by clearStorage.
      if (hydrationSettled) {
        callback(callbackState(hydratedState))
      }

      return (): void => {
        finishHydrationCallbacks.delete(callback)
      }
    },
  }

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  const middleware: Middleware<object, S> = (store) => {
    storeApi = store

    // Default web storage still skips SSR. Custom storage hydrates without window.
    if (!skipWebSsr()) {
      // Execute in microtask (after store initialization)
      Promise.resolve().then(() => {
        void api.rehydrate()
      })
    }

    return (next) => (action) => {
      const result = next(action)

      // Handle hydration actions
      if (
        typeof action === 'object' &&
        action !== null &&
        'type' in action &&
        typeof action.type === 'string'
      ) {
        // Update internal state with HYDRATE_COMPLETE action
        if (action.type === ACTION_HYDRATE_COMPLETE) {
          hydrationState = 'hydrated'
          hydratedState = (action as unknown as { payload: S }).payload
          return result
        }

        // Don't save other middleware actions
        if (action.type.startsWith('@@redux-storage-middleware/')) {
          return result
        }
      }

      // Save only after hydration is complete
      if (hydrationState === 'hydrated' && saveHandler) {
        saveHandler(store.getState())
      }

      return result
    }
  }

  return { middleware, reducer: hydratedReducer, api }
}

// =============================================================================
// Standalone Functions
// =============================================================================

/**
 * Restores initial state from LocalStorage
 *
 * @param storageKey - LocalStorage key
 * @returns Restored state or null
 *
 * @example
 * ```ts
 * const preloadedState = loadStateFromStorage('my-app-state')
 * const store = configureStore({
 *   reducer: rootReducer,
 *   preloadedState: preloadedState?.state,
 * })
 * ```
 */
export function loadStateFromStorage<S = unknown>(
  storageKey: string,
): PersistedState<S> | null {
  // Validate storage key
  validateStorageKey(storageKey)

  if (isServer() || !isStorageAvailable()) {
    return null
  }

  try {
    const storage = createSafeLocalStorage()
    const serialized = storage.getItem(storageKey)

    if (serialized === null) {
      return null
    }

    return defaultJsonSerializer.deserialize(serialized) as PersistedState<S>
  } catch (error) {
    console.error('[redux-storage-middleware] Failed to load state:', error)
    return null
  }
}

/**
 * Removes state from LocalStorage
 *
 * @param storageKey - LocalStorage key
 */
export function clearStorageState(storageKey: string): void {
  // Validate storage key
  validateStorageKey(storageKey)

  if (isServer() || !isStorageAvailable()) {
    return
  }

  try {
    const storage = createSafeLocalStorage()
    storage.removeItem(storageKey)
  } catch (error) {
    console.error('[redux-storage-middleware] Failed to clear state:', error)
  }
}

/**
 * Reducer enhancer for hydration (internal use only)
 *
 * Wraps reducer to handle hydration actions.
 * This function is used internally by createStorageMiddleware.
 *
 * @internal
 * @param reducer - Original reducer
 * @returns Hydration-aware reducer
 */
function withHydration<S>(
  reducer: (state: S | undefined, action: UnknownAction) => S,
): (state: S | undefined, action: UnknownAction) => S {
  return (state, action) => {
    if (action.type === ACTION_HYDRATE_COMPLETE) {
      // Hydration complete: overwrite state
      return action.payload as S
    }

    return reducer(state, action)
  }
}

// =============================================================================
// Exports
// =============================================================================

export {
  ACTION_HYDRATE_START,
  ACTION_HYDRATE_COMPLETE,
  ACTION_HYDRATE_ERROR,
  shallowMerge,
  deepMerge,
}
