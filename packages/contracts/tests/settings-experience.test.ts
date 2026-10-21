import { describe, expect, it } from 'vitest'
import { AgentSettingsSearchSchema, HarnessSettingsSearchSchema, WorkspaceDefaultsSchema, WorkspaceDefaultsUpdateInputSchema,
  LocalHumanAccessSchema } from '../src/management/index.js'

describe('Settings experience contracts', () => {
  it('parses direct links and rejects unsupported agent section selections', () => {
    expect(AgentSettingsSearchSchema.parse({ role: 'coder', section: 'tools' })).toEqual({ role: 'coder', section: 'tools' })
    expect(AgentSettingsSearchSchema.parse({ role: 'unknown', section: 'connections' })).toEqual({ role: undefined, section: undefined })
    expect(HarnessSettingsSearchSchema.parse({ harness: 'claude', section: 'workspace' })).toEqual({ harness: 'claude', section: 'workspace' })
    expect(HarnessSettingsSearchSchema.parse({ harness: 'opencode', section: 'workspace' })).toEqual({ harness: undefined, section: 'workspace' })
  })
  it('workspace suggestions cannot carry runner or filesystem authority', () => {
    expect(WorkspaceDefaultsSchema.safeParse({ suggestedName: 'Workspace', description: '', rootPath: '/tmp' }).success).toBe(false)
    expect(WorkspaceDefaultsSchema.safeParse({ suggestedName: ' ', description: '' }).success).toBe(false)
    expect(WorkspaceDefaultsSchema.safeParse({ suggestedName: 'Workspace', description: 'x'.repeat(10_001) }).success).toBe(false)
  })
  it('keeps explicit empty descriptions and validates revision/command identity', () => {
    expect(WorkspaceDefaultsUpdateInputSchema.parse({ value: { suggestedName: 'Project', description: '' }, commandId: 'command-1', expectedRevision: 0 }).value.description).toBe('')
    expect(WorkspaceDefaultsUpdateInputSchema.safeParse({ value: { suggestedName: 'Project', description: '' }, commandId: 'x', expectedRevision: -1 }).success).toBe(false)
  })
  it('local permission readback excludes credentials', () => {
    const value = { principal: { id: 'principal-x', name: 'Browser', expiresAt: '2099-01-01T00:00:00Z', grants: [] } }
    expect(LocalHumanAccessSchema.safeParse(value).success).toBe(true)
    expect(LocalHumanAccessSchema.safeParse({ ...value, localDev: true }).success).toBe(false)
    expect(LocalHumanAccessSchema.safeParse({ ...value, localDev: false }).success).toBe(false)
    expect(LocalHumanAccessSchema.safeParse({ ...value, token: 'secret' }).success).toBe(false)
    expect(LocalHumanAccessSchema.safeParse({ principal: { ...value.principal, tokenHash: 'secret' } }).success).toBe(false)
  })
})
