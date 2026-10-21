import { describe, expect, it } from 'vitest'
import { ManagementGrantSchema, OperatorToolNameSchema } from './management/index.js'

describe('supported device management contracts', () => {
  it.each([
    'device_pairing_install_create',
    'device_readiness_get',
    'device_readiness_check',
    'device_repair_plan',
    'device_repair_start',
    'device_provisioning_operation_get',
    'device_resources_get',
    'device_resources_update',
    'device_resources_apply_now',
    'device_runtime_approval_get',
    'device_runtime_approval_request',
    'device_runtime_approval_revoke',
  ])('rejects the unimplemented tool %s', name => {
    expect(OperatorToolNameSchema.safeParse(name).success).toBe(false)
  })

  it('rejects grants for unimplemented provisioning', () => {
    expect(ManagementGrantSchema.safeParse({
      actions: ['devices:provision'],
      scope: {},
    }).success).toBe(false)
  })

  it.each([
    'devices_list', 'device_pairing_grant_create', 'device_revoke',
    'device_setup_code_create', 'device_connection_read', 'build_computer_get', 'build_computer_update',
  ])('retains the implemented tool %s', name => {
    expect(OperatorToolNameSchema.parse(name)).toBe(name)
  })

  it('retains scoped device reads without adding update permissions', () => {
    const grant = {
      actions: ['devices:read'],
      scope: { deviceIds: ['11111111-1111-4111-8111-111111111111'] },
    }
    expect(ManagementGrantSchema.parse(grant)).toEqual(grant)
    expect(ManagementGrantSchema.safeParse({
      ...grant,
      scope: { deviceIds: ['invalid-device-id'] },
    }).success).toBe(false)
  })
})
