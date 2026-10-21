import { describe, expect, it } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { DeviceAccessError } from '../src/modules/devices/access.js'
import { scheduleRejectionReason } from '../src/modules/schedules/postgresDispatcher.js'

describe('schedule placement failures', () => {
  it.each([
    'PLACEMENT_ADMISSION_CONFLICT', 'ROOT_POLICY_CONFLICT', 'ROOT_POLICY_UNAVAILABLE',
    'ROOT_CONFIGURATION_CONFLICT', 'ROOT_CONFIGURATION_MISSING', 'HARNESS_INSTANCE_INVALID',
    'HARNESS_INSTANCE_CHANGED', 'HARNESS_INSTALLATION_INVALID', 'HARNESS_INSTALLATION_CHANGED', 'SOURCE_UNAVAILABLE',
  ])('records deterministic %s as a configuration rejection', (code) => {
    expect(scheduleRejectionReason(new DomainError(code, 'Private diagnostic.', 409))).toBe('workflow_not_executable')
  })
  it.each([
    'HARNESS_INVENTORY_UNAVAILABLE', 'HARNESS_INVENTORY_STALE', 'HARNESS_INSTANCE_UNAVAILABLE',
    'WORKER_CONNECTION_UNAVAILABLE', 'HARNESS_PROFILE_UNAVAILABLE', 'UNKNOWN_CONFLICT',
  ])('leaves %s retryable', (code) => {
    expect(scheduleRejectionReason(new DomainError(code, 'Private diagnostic.', 409))).toBeUndefined()
  })
  it('does not classify unknown infrastructure failures as configuration rejection', () => {
    expect(scheduleRejectionReason(new Error('Private database diagnostic.'))).toBeUndefined()
  })
  it.each(['unauthorized', 'revoked', 'expired', 'forbidden', 'wrong_main'] as const)(
    'records typed device %s as an authorization rejection', (code) => {
      expect(scheduleRejectionReason(new DeviceAccessError(code))).toBe('schedule_authorization_denied')
      expect(scheduleRejectionReason(new DomainError(code, 'Unclassified error.', 403))).toBeUndefined()
    })
  it('records a typed device revision conflict as a configuration rejection', () => {
    expect(scheduleRejectionReason(new DeviceAccessError('conflict'))).toBe('workflow_not_executable')
  })
})
