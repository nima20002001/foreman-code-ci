import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { HarnessConfigurationSchema, DEFAULT_AGENT_DEFAULTS } from '@foreman-code/contracts'
import { PostgresOperatorRepository } from './postgres.js'
import { PostgresFoundationSettingsRepository } from '../settings/foundation.js'

const retired = HarnessConfigurationSchema.parse({
  harness: 'opencode', model: 'saved/model', variant: 'max', nativeAgent: 'build',
  thinking: false, autoApprove: false,
})

describe('retired Operator configuration writes', () => {
  it('rejects new and transaction-scoped saves before any database operation', async () => {
    const connect = vi.fn()
    const query = vi.fn()
    const repository = new PostgresOperatorRepository({ connect } as unknown as pg.Pool)
    await expect(repository.update(retired, 'saved-configuration')).rejects.toMatchObject({ code: 'HARNESS_RETIRED' })
    await expect(repository.updateWithClient({ query } as unknown as pg.ClientBase,
      retired, 'saved-configuration')).rejects.toMatchObject({ code: 'HARNESS_RETIRED' })
    expect(connect).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects retired role defaults instead of republishing them', () => {
    const connect = vi.fn()
    const repository = new PostgresFoundationSettingsRepository({ connect } as unknown as pg.Pool)
    const defaults = structuredClone(DEFAULT_AGENT_DEFAULTS)
    defaults.operator.harness = retired
    expect(() => repository.updateAgentDefaults(defaults, 1)).toThrow()
    expect(connect).not.toHaveBeenCalled()
  })
})
