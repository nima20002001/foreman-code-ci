import { describe, expect, it } from 'vitest'
import { DEFAULT_MANAGEMENT_ACTIONS, ManagementActionSchema } from './management/index.js'

describe('default management actions', () => {
  it('includes CI and priority in the full supported catalog without device provisioning', () => {
    expect(DEFAULT_MANAGEMENT_ACTIONS).toContain('ci')
    expect(DEFAULT_MANAGEMENT_ACTIONS).toContain('jobs:prioritize')
    expect(DEFAULT_MANAGEMENT_ACTIONS).toEqual(ManagementActionSchema.options)
    expect(DEFAULT_MANAGEMENT_ACTIONS).not.toContain('devices:provision')
    expect(ManagementActionSchema.safeParse('devices:provision').success).toBe(false)
  })
})
