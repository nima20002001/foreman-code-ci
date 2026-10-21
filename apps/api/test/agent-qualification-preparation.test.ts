import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS, type HarnessConfiguration } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { withTransaction } from '../src/infrastructure/transaction.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { ProviderAccountConfigurationService } from '../src/modules/harnesses/providerAccountConfiguration.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'

const principal: ManagementPrincipal = {
  id: 'owner', name: 'Owner', audience: 'operator', expiresAt: '9999-01-01T00:00:00Z', revokedAt: null,
  grants: [{ actions: ['agents:create', 'agents:read', 'agents:update'], scope: {} }],
}
const configuration = DEFAULT_HARNESS_DEFAULTS.codex
const version = AgentConfigurationVersionSchema.parse({
  id: 'saved-version', agentId: 'source', workspaceId: 'workspace', version: 1, productRole: 'coder',
  harness: configuration, prompt: {}, assignedSkills: [], contentHash: 'saved-hash', createdAt: '2026-10-01T00:00:00Z',
})

function fixture(operation: string, managed: boolean) {
  let leased = 0
  let resolved: HarnessConfiguration | undefined
  const saved: unknown[] = []
  const query = async (sql: string, args?: unknown[]) => {
    if (sql.includes('from management_principals')) return { rows: [{
      ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null,
    }] }
    if (sql.includes('select archived_at from workspaces')) return { rows: [{ archived_at: null }] }
    if (sql.includes('from agents a') || sql.includes('for update')) return { rows: operation === 'create' || args?.[0] === 'clone' ? [] : [{
      workspace_id: 'workspace', archived_at: null, metadata_revision: '1',
      current_configuration_version_id: version.id, configuration_record: version,
      record: { id: 'source', name: 'Source', productRole: 'coder', configurationVersionId: version.id },
    }] }
    if (sql.includes('select record from agent_configuration_versions')) return { rows: [{ record: version }] }
    if (sql.includes('insert into agent_configuration_versions')) saved.push(JSON.parse(String(args![4])))
    if (sql.includes('metadata_revision')) return { rows: [{ metadata_revision: '2' }] }
    return { rows: [] }
  }
  const pool = { connect: async () => {
    leased++
    return { query, release: () => { leased-- } }
  } } as unknown as pg.Pool
  const commands = { execute: async (command: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
    await command.prepare?.(pool)
    return withTransaction(pool, async client => {
      await command.authorize?.(client)
      if (command.preparedMutation && !await command.preparedMutation.validate(client)) throw new Error('Snapshot changed')
      return { value: await command.perform(client), replayed: false }
    })
  } } as PostgresCommandCoordinator
  const qualifyConfiguration = vi.fn(async () => {
    expect(leased, 'native qualification must release all database ownership').toBe(0)
    return {} as never
  })
  const accounts = {
    prepareProfile: async (input: { configuration: HarnessConfiguration }) => ({ configuration: input.configuration, selection: undefined }),
    resolve: async (input: HarnessConfiguration) => resolved ?? input,
    profile: async () => undefined,
  } as unknown as ProviderAccountConfigurationService
  const service = new OperatorAgentMutationService(pool, commands, { qualifyConfiguration }, undefined,
    managed ? accounts : undefined)
  const mutate = () => {
    const base = { workspaceId: 'workspace', agentId: 'source', commandId: 'mutation' }
    if (operation === 'create') return service.create(principal, { ...base, name: 'Created', productRole: 'coder', configuration })
    if (operation === 'clone') return service.clone(principal, { ...base, agentId: 'clone', sourceAgentId: 'source',
      name: 'Clone', expectedSourceRevision: 1, expectedSourceConfigurationVersionId: version.id })
    const expected = { expectedRevision: 1, expectedConfigurationVersionId: version.id }
    if (operation === 'restore') return service.restore(principal, { ...base, ...expected, versionId: version.id })
    return service.update(principal, { ...base, ...expected, configuration: { ...configuration, model: 'changed-model' } })
  }
  return { mutate, saved, qualifyConfiguration, changeAccount: () => { resolved = { ...configuration, accountId: 'changed-account' } } }
}

it.each(['create', 'update', 'clone', 'restore'])('qualifies Agent %s without retaining database ownership', async operation => {
  for (const managed of [true, false]) {
    const f = fixture(operation, managed)
    await f.mutate()
    expect(f.qualifyConfiguration).toHaveBeenCalledTimes(1)
    expect(f.saved).toHaveLength(1)
  }
})

it('rejects an account changed after qualification before saving the Agent', async () => {
  const f = fixture('create', true)
  f.qualifyConfiguration.mockImplementation(async () => {
    f.changeAccount()
    return {} as never
  })
  await expect(f.mutate()).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_CONFIGURATION_CHANGED' })
  expect(f.saved).toHaveLength(0)
})
