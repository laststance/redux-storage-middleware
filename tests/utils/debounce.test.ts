/**
 * Debounce Utility Tests
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

import { debounce, debounceLeading } from '../../src/utils/debounce'

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('executes the function after the specified time', async () => {
    const fn = vi.fn()
    const { debouncedFn } = debounce(fn, 100)

    debouncedFn('arg1')

    expect(fn).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('arg1')
  })

  test('consolidates consecutive calls into the last one', async () => {
    const fn = vi.fn()
    const { debouncedFn } = debounce(fn, 100)

    debouncedFn('arg1')
    debouncedFn('arg2')
    debouncedFn('arg3')

    await vi.advanceTimersByTimeAsync(100)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('arg3')
  })

  test('cancel stops a timer that the running callback scheduled', async () => {
    // Arrange
    let calls = 0
    const { debouncedFn, cancel } = debounce(() => {
      calls += 1
      if (calls === 1) {
        debouncedFn()
      }
    }, 100)
    debouncedFn()

    // Act
    await vi.advanceTimersByTimeAsync(100)
    cancel()
    await vi.advanceTimersByTimeAsync(100)

    // Assert — the rescheduled save must not survive cancel
    expect(calls).toBe(1)
  })

  test('can cancel pending execution with cancel', async () => {
    const fn = vi.fn()
    const { debouncedFn, cancel } = debounce(fn, 100)

    debouncedFn('arg1')
    cancel()

    await vi.advanceTimersByTimeAsync(100)

    expect(fn).not.toHaveBeenCalled()
  })

  test('does not throw error when calling cancel consecutively', () => {
    const fn = vi.fn()
    const { cancel } = debounce(fn, 100)

    cancel()
    cancel()
    cancel()

    expect(true).toBe(true)
  })
})

describe('debounceLeading', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('executes immediately on the first call', async () => {
    const fn = vi.fn()
    const { debouncedFn } = debounceLeading(fn, 100)

    debouncedFn('arg1')

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('arg1')
  })

  test('ignores calls within the debounce period', async () => {
    const fn = vi.fn()
    const { debouncedFn } = debounceLeading(fn, 100)

    debouncedFn('arg1')
    debouncedFn('arg2')
    debouncedFn('arg3')

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('arg1')
  })

  test('can execute again after the debounce period', async () => {
    const fn = vi.fn()
    const { debouncedFn } = debounceLeading(fn, 100)

    debouncedFn('arg1')

    await vi.advanceTimersByTimeAsync(100)

    debouncedFn('arg2')

    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('arg2')
  })

  test('can reset timer and waiting state with cancel', async () => {
    const fn = vi.fn()
    const { debouncedFn, cancel } = debounceLeading(fn, 100)

    debouncedFn('arg1')
    cancel()
    debouncedFn('arg2')

    expect(fn).toHaveBeenCalledTimes(2)
  })
})
