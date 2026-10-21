import { describe, expect, it } from 'vitest'
import { DeviceApplicationError, deviceApplicationFailure } from './deviceApplicationError.js'

describe('device application failure codes', () => {
  it('reports a handler that timed out as a retryable timeout, not a rejected extension', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(deviceApplicationFailure(timeout)).toEqual({ code: 'timeout', class: 'transient', retryable: true })
  })

  it.each([
    ...['08000', '08001', '08003', '08004', '08006', '08007', '08P01', '53300', '57P01', '57P02', '57P03',
      '40001', '40P01', '55P03', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
      'ENETUNREACH', 'EHOSTUNREACH'].map(code => Object.assign(new Error('Connection unavailable'), { code })),
    ...['timeout exceeded when trying to connect', 'Connection terminated unexpectedly',
      'Connection terminated due to connection timeout', 'Query read timeout'].map(message => new Error(message)),
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    new Error('Authorization read failed', { cause: Object.assign(new Error('Socket lost'), { code: 'ECONNRESET' }) }),
  ])('keeps a database or socket failure retryable through serialization %#', error => {
    const failure = deviceApplicationFailure(error)
    expect(failure.retryable).toBe(true)
    const decoded = JSON.parse(JSON.stringify(failure)) as { code: string }
    expect(new DeviceApplicationError(decoded.code).retryable).toBe(true)
    expect(JSON.stringify(failure)).not.toContain(error.message)
  })

  it.each([
    { code: 'AUTH_REVOKED' }, { code: 'permission' }, { code: '23505' },
    Object.assign(new Error('canceling statement due to user request'), { code: '57014' }),
    new Error('Unrecognized handler failure'),
  ])('keeps denials and unrecognized failures permanent %#', error => {
    expect(deviceApplicationFailure(error).retryable).toBe(false)
  })
})
