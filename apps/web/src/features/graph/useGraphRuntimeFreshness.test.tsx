import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGraphRuntimeFreshness } from './useGraphRuntimeFreshness'

afterEach(() => vi.useRealTimers())

describe('one owner availability deadline', () => {
  it('expires and refreshes availability without any per-node animation clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const hook = renderHook(({ updatedAt }) => useGraphRuntimeFreshness('run', updatedAt, 5_000), {
      initialProps: { updatedAt: 100_000 },
    })
    expect(hook.result.current).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(5_001))
    expect(hook.result.current).toBe(false)
    hook.rerender({ updatedAt: Date.now() })
    expect(hook.result.current).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    hook.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
