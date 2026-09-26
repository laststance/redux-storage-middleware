/**
 * Throttle Utility Tests
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

import { throttle, scheduleIdleCallback } from '../../src/utils/throttle'

describe('throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('executes immediately on the first call', () => {
    const fn = vi.fn()
    const { throttledFn } = throttle(fn, 100)

    throttledFn('arg1')

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('arg1')
  })

  test('executes calls within throttle period after the period ends', async () => {
    const fn = vi.fn()
    const { throttledFn } = throttle(fn, 100)

    throttledFn('arg1')
    throttledFn('arg2')
    throttledFn('arg3')

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('arg1')

    await vi.advanceTimersByTimeAsync(100)

    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('arg3')
  })

  test('can execute immediately again after the throttle period', async () => {
    const fn = vi.fn()
    const { throttledFn } = throttle(fn, 100)

    throttledFn('arg1')

    await vi.advanceTimersByTimeAsync(100)

    throttledFn('arg2')

    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('arg2')
  })

  test('can cancel pending execution with cancel', async () => {
    const fn = vi.fn()
    const { throttledFn, cancel } = throttle(fn, 100)

    throttledFn('arg1')
    throttledFn('arg2')
    cancel()

    await vi.advanceTimersByTimeAsync(100)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('arg1')
  })
})

describe('scheduleIdleCallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('falls back to setTimeout when requestIdleCallback is not available', async () => {
    const fn = vi.fn()
    const { scheduledFn } = scheduleIdleCallback(fn)

    scheduledFn('arg1')

    expect(fn).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('arg1')
  })

  test('uses the last argument when called consecutively', async () => {
    const fn = vi.fn()
    const { scheduledFn } = scheduleIdleCallback(fn)

    scheduledFn('arg1')
    scheduledFn('arg2')
    scheduledFn('arg3')

    await vi.advanceTimersByTimeAsync(1)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('arg3')
  })

  test('a sync reschedule from the idle callback still runs', () => {
    // Arrange — own the idle queue so the reschedule cannot run early
    const jobs = new Map<number, () => void>()
    let nextId = 1
    vi.stubGlobal(
      'requestIdleCallback',
      (callback: IdleRequestCallback): number => {
        const id = nextId
        nextId += 1
        jobs.set(id, () => {
          callback({
            didTimeout: false,
            timeRemaining: () => 50,
          })
        })
        return id
      },
    )
    vi.stubGlobal('cancelIdleCallback', (id: number): void => {
      jobs.delete(id)
    })

    try {
      let calls = 0
      const { scheduledFn } = scheduleIdleCallback(() => {
        calls += 1
        if (calls === 1) {
          scheduledFn()
        }
      })
      scheduledFn()

      // Act
      const first = jobs.get(1)
      jobs.delete(1)
      first?.()
      for (const job of jobs.values()) {
        job()
      }

      // Assert — clearing the handle after the callback would drop this save
      expect(calls).toBe(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('cancel stops a callback that the running idle task scheduled', () => {
    // Arrange — own the idle queue so the reschedule cannot run before cancel
    const jobs = new Map<number, () => void>()
    let nextId = 1
    vi.stubGlobal(
      'requestIdleCallback',
      (callback: IdleRequestCallback): number => {
        const id = nextId
        nextId += 1
        jobs.set(id, () => {
          callback({
            didTimeout: false,
            timeRemaining: () => 50,
          })
        })
        return id
      },
    )
    vi.stubGlobal('cancelIdleCallback', (id: number): void => {
      jobs.delete(id)
    })

    try {
      let calls = 0
      const { scheduledFn, cancel } = scheduleIdleCallback(() => {
        calls += 1
        if (calls === 1) {
          scheduledFn()
        }
      })
      scheduledFn()

      // Act
      const first = jobs.get(1)
      jobs.delete(1)
      first?.()
      cancel()
      for (const job of jobs.values()) {
        job()
      }

      // Assert
      expect(jobs.size).toBe(0)
      expect(calls).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('can cancel pending execution with cancel', async () => {
    const fn = vi.fn()
    const { scheduledFn, cancel } = scheduleIdleCallback(fn)

    scheduledFn('arg1')
    cancel()

    await vi.advanceTimersByTimeAsync(1)

    expect(fn).not.toHaveBeenCalled()
  })
})
