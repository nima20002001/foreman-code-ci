import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ManagedAgentDefaultsSchema, AgentDefaultsUpdateResultSchema } from '@foreman-code/contracts/management'
import { reviewAuthMcpDatabase } from './helpers/reviewAuthMcpDatabase.js'

it.each(['service', 'mcp'] as const)('rejects an ephemeral Operator host profile via %s before writing defaults or Operator revisions', async channel => {
  const f = await reviewAuthMcpDatabase()
  try {
    const owner = await f.access.issue({ name: 'defaults owner', audience: 'operator',
      grants: [{ actions: ['settings:read', 'settings:update', 'harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const initial = await f.repository.getAgentDefaults()
    const operator = await f.operators.ensure()
    const harness = initial.value.operator.harness
    if (harness.harness !== 'codex' || !harness.advanced) throw new Error('Expected advanced Codex defaults')
    const ephemeral = { ...harness, advanced: { ...harness.advanced, sessionPersistence: 'ephemeral' as const } }
    const profileInput = { commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0,
      target: { hostRef: { kind: 'main' as const, mainId: f.mainId }, applicationInstallationId: f.mainId,
        harnessInstallationId: 'review-codex', installationFingerprint: 'review-fingerprint' },
      presetId: 'local-default:codex', enabled: true, configuration: ephemeral }
    const profile = (await f.profiles.save(owner.principal, 'http', profileInput)).value
    const input = { commandId: randomUUID(), expectedRevision: initial.revision, value: {
      ...initial.value, operator: { ...initial.value.operator, harness: ephemeral, harnessProfileSelection: {
        target: profile.target, instanceId: profile.instanceId, instanceRevision: profile.instanceRevision,
      } },
    } }
    const client = await f.connect(owner.token)
    if (channel === 'service') {
      await expect(f.settings.updateAgentDefaults(owner.principal, 'http', input)).rejects.toThrow('ephemeral Codex sessions cannot support resume-dependent features')
    } else {
      expect((await client.callTool({ name: 'agent_defaults_update', arguments: input })).isError).toBe(true)
    }
    expect(await f.repository.getAgentDefaults()).toEqual(initial)
    expect((await f.pool.query("select count(*)::int as count from application_setting_versions where setting_key='agent-defaults-v1'")).rows[0].count).toBe(0)
    expect((await f.pool.query('select count(*)::int as count from operator_configuration_versions')).rows[0].count).toBe(1)
    expect(await f.operators.ensure()).toEqual(operator)
    const initialRead = await client.callTool({ name: 'agent_defaults_get', arguments: {} })
    expect(ManagedAgentDefaultsSchema.parse(decodeMcpToolResult(initialRead))).toEqual(initial)

    const reader = await f.access.issue({ name: 'defaults reader', audience: 'operator',
      grants: [{ actions: ['settings:read', 'harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const denied = await f.connect(reader.token)
    expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('agent_defaults_update')
    const deniedUpdate = await denied.callTool({ name: 'agent_defaults_update', arguments: {
      ...input, commandId: randomUUID(),
    } })
    expect(deniedUpdate.isError).toBe(true)
    expect(JSON.stringify(deniedUpdate.content)).toContain('ACCESS_DENIED')
    expect(await f.repository.getAgentDefaults()).toEqual(initial)

    const persistent = (await f.profiles.save(owner.principal, 'http', {
      ...profileInput, commandId: randomUUID(), expectedRevision: profile.revision, configuration: harness,
    })).value
    const valid = { ...input, commandId: randomUUID(), value: { ...initial.value, operator: {
      ...initial.value.operator, harness, harnessProfileSelection: { target: persistent.target,
        instanceId: persistent.instanceId, instanceRevision: persistent.instanceRevision },
    } } }
    const updated = await client.callTool({ name: 'agent_defaults_update', arguments: valid })
    const saved = AgentDefaultsUpdateResultSchema.parse(decodeMcpToolResult(updated))
    expect(saved.value.revision).toBe(1)
    expect(saved.value.value.operator.harnessProfileSelection).toEqual(valid.value.operator.harnessProfileSelection)
    const readback = await denied.callTool({ name: 'agent_defaults_get', arguments: {} })
    expect(ManagedAgentDefaultsSchema.parse(decodeMcpToolResult(readback))).toEqual(saved.value)
    expect((await f.pool.query('select count(*)::int as count from operator_configuration_versions')).rows[0].count).toBe(2)
  } finally { await f.close() }
}, 30_000)
