import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { normalizeHarnessDefaults, PostgresSettingsRepository } from './postgres.js'
import type pg from 'pg'

const retired = {
  harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'max',
  nativeAgent: 'build', thinking: true, autoApprove: false,
}

describe('retired default presets', () => {
  it('reads supported defaults without mutating the saved retired configuration', () => {
    const saved = { ...structuredClone(DEFAULT_HARNESS_DEFAULTS), opencode: structuredClone(retired) }
    const original = structuredClone(saved)
    expect(normalizeHarnessDefaults(saved)).toEqual(DEFAULT_HARNESS_DEFAULTS)
    expect(saved).toEqual(original)
  })

  it('retains the original retired preset revision and settings in managed inventory', async () => {
    const pool = {
      query: async () => ({ rows: [{
        record: structuredClone(DEFAULT_HARNESS_DEFAULTS), revision: '9', unavailable: ['opencode'],
        retired: { opencode: retired }, retired_revision: '4',
      }] }),
    } as unknown as pg.Pool
    const result = await new PostgresSettingsRepository(pool).getManagedHarnessDefaults()
    expect(result.defaults).toEqual(DEFAULT_HARNESS_DEFAULTS)
    expect(result.revision).toBe(9)
    expect(result.retiredDefaults).toEqual([{
      instanceId: 'local-default:opencode', instanceRevision: '4', driverId: 'opencode',
      enabled: false, configuration: retired,
    }])
    expect(result.unavailable).toBeUndefined()
  })
})
