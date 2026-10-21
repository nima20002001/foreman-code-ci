import { randomUUID } from 'node:crypto'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { GeneralSettingsUpdateResultSchema, ManagedGeneralSettingsSchema,
  type GeneralSettingsUpdateInput } from '@foreman-code/contracts/management'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { reviewAuthMcpDatabase } from './helpers/reviewAuthMcpDatabase.js'

it('persists shared preferences through authenticated MCP, denies writes, and preserves retries and audits', async () => {
  const f = await reviewAuthMcpDatabase({ hostProfiles: false })
  try {
    const owner = await f.access.issue({ name: 'Preferences owner', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] })
    const reader = await f.access.issue({ name: 'Preferences reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['settings:read'], scope: {} }] })
    const client = await f.connect(owner.token)
    const otherComputer = await f.connect(reader.token)
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('general_settings_update')
    expect((await otherComputer.listTools()).tools.map(tool => tool.name)).not.toContain('general_settings_update')
    const input: GeneralSettingsUpdateInput = { value: { theme: 'light' }, expectedRevision: 0, commandId: randomUUID() }
    expect((await otherComputer.callTool({ name: 'general_settings_update', arguments: input })).isError).toBe(true)
    const call = (arguments_: GeneralSettingsUpdateInput) =>
      client.callTool({ name: 'general_settings_update', arguments: arguments_ })
    const result = GeneralSettingsUpdateResultSchema.parse(decodeMcpToolResult(await call(input)))
    expect(result).toMatchObject({ value: { value: { theme: 'light' }, revision: 1 }, replayed: false })
    const persisted = ManagedGeneralSettingsSchema.parse(decodeMcpToolResult(await otherComputer.callTool({
      name: 'general_settings_get', arguments: {},
    })))
    expect(persisted).toEqual(result.value)
    const restarted = new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(f.pool), f.commands)
    expect(await restarted.getGeneralSettings(reader.principal)).toEqual(persisted)
    expect(GeneralSettingsUpdateResultSchema.parse(decodeMcpToolResult(await call(input))))
      .toEqual({ ...result, replayed: true })
    expect((await call({ ...input, commandId: randomUUID() })).isError).toBe(true)
    expect((await call({ ...input, value: { theme: 'dark' } })).isError).toBe(true)
    const saved = GeneralSettingsUpdateResultSchema.parse(decodeMcpToolResult(await call({ ...input,
      value: { theme: 'dark' }, expectedRevision: 1, commandId: randomUUID() })))
    expect(saved.value).toMatchObject({ value: { theme: 'dark' }, revision: 2 })
    const audits = await f.pool.query('select source,outcome from management_audit where action=$1', ['general.settings.update'])
    expect(audits.rows.filter(row => row.outcome === 'succeeded')).toEqual([
      { source: 'mcp', outcome: 'succeeded' }, { source: 'mcp', outcome: 'succeeded' },
    ])
    await f.pool.query('update management_principals set grants=$2::jsonb where id=$1',
      [owner.principal.id, JSON.stringify(reader.principal.grants)])
    await expect(restarted.updateGeneralSettings(owner.principal, 'mcp', input)).rejects.toMatchObject({ status: 403 })
    expect(await restarted.getGeneralSettings(reader.principal)).toEqual(saved.value)
  } finally { await f.close() }
}, 30_000)
