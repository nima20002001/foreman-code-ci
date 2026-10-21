import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import {
  GeneralSettingsUpdateResultSchema, ManagedGeneralSettingsSchema,
  ManagedPromptSettingSchema, PromptSettingUpdateResultSchema,
  ManagedWorkspaceDefaultsSchema, WorkspaceDefaultsUpdateResultSchema,
  AgentDefaultsUpdateResultSchema, HarnessDefaultsUpdateResultSchema,
} from '@foreman-code/contracts/management'
import { HostHarnessOverrideListSchema, HostHarnessOverrideSaveResultSchema } from '@foreman-code/contracts/harness-registry'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { reviewAuthMcpDatabase } from './helpers/reviewAuthMcpDatabase.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

it('saves settings without read-before-write and keeps explicit conflicts, replay and read-only denial', async () => {
  const f = await reviewAuthMcpDatabase()
  try {
    const writer = await f.access.issue({ name: 'Settings writer', audience: 'operator',
      grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const reader = await f.access.issue({ name: 'Settings reader', audience: 'operator',
      grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const client = await f.connect(writer.token)
    const denied = await f.connect(reader.token)
    const cases = [
      { update: 'general_settings_update', get: 'general_settings_get',
        schema: GeneralSettingsUpdateResultSchema, readSchema: ManagedGeneralSettingsSchema,
        first: { theme: 'dark' }, last: { theme: 'light' } },
      { update: 'system_prompt_update', get: 'system_prompt_get',
        schema: PromptSettingUpdateResultSchema, readSchema: ManagedPromptSettingSchema,
        first: { text: 'First prompt' }, last: { text: 'Last prompt' } },
      { update: 'operator_initial_prompt_update', get: 'operator_initial_prompt_get',
        schema: PromptSettingUpdateResultSchema, readSchema: ManagedPromptSettingSchema,
        first: { text: 'First initial prompt' }, last: { text: 'Last initial prompt' } },
      { update: 'workspace_defaults_update', get: 'workspace_defaults_get',
        schema: WorkspaceDefaultsUpdateResultSchema, readSchema: ManagedWorkspaceDefaultsSchema,
        first: { suggestedName: 'First', description: '', parentPath: (await f.repository.getWorkspaceDefaults()).value.parentPath },
        last: { suggestedName: 'Last', description: '', parentPath: (await f.repository.getWorkspaceDefaults()).value.parentPath } },
    ]
    for (const item of cases) {
      const first = item.schema.parse(decodeMcpToolResult(await client.callTool({ name: item.update,
        arguments: { commandId: randomUUID(), value: item.first } })))
      const input = { commandId: randomUUID(), value: item.last }
      await expectMcpAccessDenied(denied.callTool({ name: item.update, arguments: input }))
      const last = item.schema.parse(decodeMcpToolResult(await client.callTool({ name: item.update, arguments: input })))
      expect(last.value.revision).toBe(first.value.revision + 1)
      expect(item.schema.parse(decodeMcpToolResult(await client.callTool({ name: item.update, arguments: input }))))
        .toEqual({ ...last, replayed: true })
      const stale = await client.callTool({ name: item.update,
        arguments: { commandId: randomUUID(), value: item.first, expectedRevision: first.value.revision } })
      expect(stale.isError).toBe(true)
      expect(JSON.stringify(stale.content)).toContain('REVISION_CONFLICT')
      const readback = item.readSchema.parse(decodeMcpToolResult(await denied.callTool({ name: item.get, arguments: {} })))
      expect(readback).toEqual(last.value)
    }
    const agentInput = { commandId: randomUUID(), value: (await f.repository.getAgentDefaults()).value }
    const agentFirst = AgentDefaultsUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'agent_defaults_update', arguments: agentInput,
    })))
    const agentLast = AgentDefaultsUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'agent_defaults_update', arguments: { ...agentInput, commandId: randomUUID() },
    })))
    expect(agentLast.value.revision).toBe(agentFirst.value.revision + 1)
    await expectMcpAccessDenied(denied.callTool({ name: 'agent_defaults_update', arguments: agentInput }))
    expect(await f.repository.getAgentDefaults()).toEqual(agentLast.value)
    const workflowInput = { commandId: randomUUID(), value: (await f.repository.getWorkflowDefaults()).value }
    const workflowFirst = await f.settings.updateWorkflowDefaults(writer.principal, 'http', workflowInput)
    const workflowLast = await f.settings.updateWorkflowDefaults(writer.principal, 'http', {
      ...workflowInput, commandId: randomUUID(),
    })
    expect(workflowLast.value.revision).toBe(workflowFirst.value.revision + 1)
    expect(await f.repository.getWorkflowDefaults()).toEqual(workflowLast.value)
  } finally { await f.close() }
}, 30_000)

it('increments host profile revisions from persisted state when the caller omits a revision', async () => {
  const f = await reviewAuthMcpDatabase()
  try {
    const writer = await f.access.issue({ name: 'Profile writer', audience: 'operator',
      grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const reader = await f.access.issue({ name: 'Profile reader', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const client = await f.connect(writer.token)
    const denied = await f.connect(reader.token)
    const target = { hostRef: { kind: 'main', mainId: f.mainId }, applicationInstallationId: f.mainId,
      harnessInstallationId: 'fixture-native', installationFingerprint: 'fixture-fingerprint' }
    const input = { commandId: randomUUID(), instanceId: randomUUID(), target, presetId: 'fixture', enabled: true,
      configuration: DEFAULT_HARNESS_DEFAULTS.codex }
    await expectMcpAccessDenied(denied.callTool({ name: 'harness_instance_save', arguments: input }))
    const save = async (args: Record<string, unknown>) => HostHarnessOverrideSaveResultSchema.parse(
      decodeMcpToolResult(await client.callTool({ name: 'harness_instance_save', arguments: args })))
    const first = await save(input)
    expect(first.value.revision).toBe(1)
    const lastInput = { ...input, commandId: randomUUID(), enabled: false }
    const last = await save(lastInput)
    expect(last.value).toMatchObject({ revision: 2, instanceRevision: '2', enabled: false, qualification: 'disabled' })
    expect(await save(lastInput)).toEqual({ ...last, replayed: true })
    const stale = await client.callTool({ name: 'harness_instance_save', arguments: {
      ...input, commandId: randomUUID(), expectedRevision: 1 } })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toContain('REVISION_CONFLICT')
    const readback = HostHarnessOverrideListSchema.parse(decodeMcpToolResult(await denied.callTool({
      name: 'harness_instances_list', arguments: { hostRef: target.hostRef, applicationInstallationId: f.mainId } })))
    expect(readback.overrides.find(profile => profile.instanceId === input.instanceId)).toEqual(last.value)
  } finally { await f.close() }
}, 30_000)

it('saves harness defaults without a revision through MCP and reads the persisted result', async () => {
  const f = await reviewAuthMcpDatabase()
  const repository = new PostgresSettingsRepository(f.pool)
  const catalog = new HarnessCatalogService({ qualify: async () => { throw new Error('Unchanged defaults need no check') } },
    repository, f.commands, 'fixture-directory')
  f.services.harnesses = catalog
  try {
    const writer = await f.access.issue({ name: 'Defaults writer', audience: 'operator',
      grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const reader = await f.access.issue({ name: 'Defaults reader', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const client = await f.connect(writer.token)
    const denied = await f.connect(reader.token)
    const input = { commandId: randomUUID(), defaults: (await repository.getManagedHarnessDefaults()).defaults }
    await expectMcpAccessDenied(denied.callTool({ name: 'harness_defaults_update', arguments: input }))
    const save = async (args: Record<string, unknown>) => HarnessDefaultsUpdateResultSchema.parse(
      decodeMcpToolResult(await client.callTool({ name: 'harness_defaults_update', arguments: args })))
    const first = await save(input)
    const lastInput = { ...input, commandId: randomUUID() }
    const last = await save(lastInput)
    expect(last.value.revision).toBe(first.value.revision + 1)
    expect(await save(lastInput)).toEqual({ ...last, replayed: true })
    expect(await repository.getManagedHarnessDefaults()).toMatchObject(last.value)
    const stale = await client.callTool({ name: 'harness_defaults_update', arguments: {
      ...input, commandId: randomUUID(), expectedRevision: first.value.revision,
    } })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toContain('REVISION_CONFLICT')
  } finally {
    await catalog.shutdownChecks()
    await f.close()
  }
}, 30_000)
