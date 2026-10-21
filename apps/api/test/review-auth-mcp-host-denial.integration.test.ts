import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { reviewAuthMcpDatabase } from './helpers/reviewAuthMcpDatabase.js'

it('audits authenticated calls to grant-hidden host-profile tools without mutating profiles', async () => {
  const f = await reviewAuthMcpDatabase()
  try {
    const owner = await f.access.issue({ name: 'profile owner', audience: 'operator',
      grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const reader = await f.access.issue({ name: 'profile reader', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const noRead = await f.access.issue({ name: 'no profile access', audience: 'operator',
      grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const harness = (await f.repository.getAgentDefaults()).value.operator.harness
    const input = { commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0,
      target: { hostRef: { kind: 'main' as const, mainId: f.mainId }, applicationInstallationId: f.mainId,
        harnessInstallationId: 'review-codex', installationFingerprint: 'review-fingerprint' },
      presetId: 'local-default:codex', enabled: true, configuration: harness }
    const writer = await f.connect(owner.token), denied = await f.connect(reader.token), unavailableReader = await f.connect(noRead.token)
    const saved = await writer.callTool({ name: 'harness_instance_save', arguments: input })
    expect(saved.isError).not.toBe(true)
    expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('harness_instance_save')
    expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('harness_instance_check')
    const before = (await f.pool.query('select record from harness_instance_settings')).rows
    const listInput = { hostRef: input.target.hostRef, applicationInstallationId: f.mainId }
    for (const [client, principalId, name, args, targetKey] of [
      [denied, reader.principal.id, 'harness_instance_save', { ...input, commandId: randomUUID(), expectedRevision: 1, enabled: false }, `harness-instance:${input.instanceId}`],
      [denied, reader.principal.id, 'harness_instance_check', { commandId: randomUUID(), instanceId: input.instanceId, expectedRevision: 1, target: input.target }, `harness-instance:${input.instanceId}`],
      [unavailableReader, noRead.principal.id, 'harness_instances_list', listInput, 'harness-instances'],
    ] as const) {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('ACCESS_DENIED')
      expect((await f.pool.query("select principal_id,action,target_key from management_audit where source='mcp' and outcome='denied' and action=$1", [name])).rows)
        .toEqual([{ principal_id: principalId, action: name, target_key: targetKey }])
    }
    expect((await f.pool.query('select record from harness_instance_settings')).rows).toEqual(before)
    expect((await f.pool.query('select count(*)::int as count from harness_instance_profile_evidence')).rows[0].count).toBe(0)
    const readback = await denied.callTool({ name: 'harness_instances_list', arguments: listInput })
    expect(decodeMcpToolResult(readback)).toEqual({ overrides: [before[0].record] })
    // The writer's unsupported check is unavailable, not permission to manufacture qualification.
    const check = await writer.callTool({ name: 'harness_instance_check', arguments: {
      commandId: randomUUID(), instanceId: input.instanceId, expectedRevision: 1, target: input.target,
    } })
    expect(check.isError).toBe(true)
    expect(JSON.stringify(check.content)).toContain('HARNESS_PROFILE_CHECK_UNAVAILABLE')
  } finally { await f.close() }
}, 30_000)

it('returns explicit unavailable errors for host-profile tools when the service is absent', async () => {
  const f = await reviewAuthMcpDatabase({ hostProfiles: false })
  try {
    const owner = await f.access.issue({ name: 'profile owner', audience: 'operator',
      grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const client = await f.connect(owner.token)
    const tools = (await client.listTools()).tools.map(tool => tool.name)
    for (const name of ['harness_instance_save', 'harness_instance_check', 'harness_instances_list']) {
      expect(tools).not.toContain(name)
      const result = await client.callTool({ name, arguments: {} })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('HARNESS_INSTANCES_UNAVAILABLE')
    }
    expect((await f.pool.query('select count(*)::int as count from harness_instance_settings')).rows[0].count).toBe(0)
  } finally { await f.close() }
}, 30_000)
