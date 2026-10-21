import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ApiError } from './client'
import { isTransientReadError, useBlockingReadError } from './readFailure'

it.each([401, 403, 404, 409, 422])('withdraws cached reads after a %s response', status => {
  expect(isTransientReadError(new ApiError({ code: 'READ_REJECTED', message: 'Read rejected' }, status))).toBe(false)
})

it('retains reads only for temporary transport or server failures', () => {
  expect(isTransientReadError(new ApiError({ code: 'NETWORK_ERROR', message: 'Connection interrupted' }))).toBe(true)
  expect(isTransientReadError(new ApiError({ code: 'SERVER_ERROR', message: 'Try again' }, 503))).toBe(true)
  expect(isTransientReadError(new ApiError({ code: 'INVALID_RESPONSE', message: 'Wrong scope' }, 503))).toBe(false)
  expect(isTransientReadError(new ApiError({ code: 'NETWORK_ERROR', message: 'No access' }, 403))).toBe(false)
  expect(isTransientReadError(new Error('Invalid payload'))).toBe(false)
})

it('keeps denied content hidden through a later network failure until a successful read', () => {
  const denied = new ApiError({ code: 'FORBIDDEN', message: 'No access' }, 403)
  const network = new ApiError({ code: 'NETWORK_ERROR', message: 'Connection interrupted' })
  const { result, rerender } = renderHook(useBlockingReadError, {
    initialProps: { error: denied as unknown, isSuccess: false, dataUpdatedAt: 1 },
  })
  expect(result.current).toBe(denied)
  act(() => rerender({ error: network, isSuccess: false, dataUpdatedAt: 1 }))
  expect(result.current).toBe(denied)
  act(() => rerender({ error: null, isSuccess: true, dataUpdatedAt: 2 }))
  expect(result.current).toBeUndefined()
})
