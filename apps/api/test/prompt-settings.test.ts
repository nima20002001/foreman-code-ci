import { randomUUID } from 'node:crypto'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  ManagedPromptSettingSchema,
  MAX_PROMPT_TEXT_LENGTH,
  PromptSettingUpdateResultSchema,
  type PromptSettingUpdateInput,
} from '@foreman-code/contracts/management'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { reviewAuthMcpDatabase } from './helpers/reviewAuthMcpDatabase.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function fixture() {
  const database = await reviewAuthMcpDatabase({ hostProfiles: false })
  const app = buildApp({
    logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: database.access, services: database.services },
  })
  cleanups.push(async () => {
    await app.close()
    await database.close()
  })
  const expiresAt = new Date(Date.now() + 3_600_000)
  const owner = await database.access.issue({ name: 'Prompt owner', audience: 'operator', expiresAt,
    grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] })
  const reader = await database.access.issue({ name: 'Prompt reader', audience: 'operator', expiresAt,
    grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] })
  const scoped = await database.access.issue({ name: 'Workspace editor', audience: 'operator', expiresAt,
    grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'],
      scope: { workspaceIds: ['workspace-one'] } }] })
  return { ...database, app, owner, reader, scoped }
}

const settings = [
  { label: 'System prompt', path: '/api/management/settings/system-prompt', key: 'system-prompt',
    readTool: 'system_prompt_get', updateTool: 'system_prompt_update', operation: 'system.prompt.update' },
  { label: 'Operator Initial prompt', path: '/api/management/settings/operator-initial-prompt',
    key: 'operator-initial-prompt', readTool: 'operator_initial_prompt_get',
    updateTool: 'operator_initial_prompt_update', operation: 'operator.initial.prompt.update' },
] as const

describe.each(settings)('$label settings', setting => {
  it('shares revisioned HTTP/MCP values, discovers permissions, and persists cleared text', async () => {
    const f = await fixture()
    const owner = await f.connect(f.owner.token)
    const reader = await f.connect(f.reader.token)
    expect((await owner.listTools()).tools.map(tool => tool.name))
      .toEqual(expect.arrayContaining([setting.readTool, setting.updateTool]))
    const capabilities = decodeMcpToolResult(await owner.callTool({
      name: 'operator_get_capabilities', arguments: { detail: 'full' },
    }))
    expect(capabilities).toMatchObject({
      tools: expect.arrayContaining([setting.readTool, setting.updateTool]),
      requirements: expect.arrayContaining([
        expect.objectContaining({ name: setting.readTool, actions: ['settings:read'] }),
        expect.objectContaining({ name: setting.updateTool, actions: ['settings:update'] }),
      ]),
    })
    const initial = ManagedPromptSettingSchema.parse(decodeMcpToolResult(await owner.callTool({
      name: setting.readTool, arguments: {},
    })))
    expect(initial).toEqual({ value: { text: '' }, revision: 0, versionId: null })
    const text = '  Be precise.\nPreserve فارسی and 日本語.\n'
    const input: PromptSettingUpdateInput = {
      value: { text }, expectedRevision: initial.revision, commandId: randomUUID(),
    }
    const response = await f.app.inject({ method: 'PUT', url: setting.path,
      headers: { authorization: `Bearer ${f.owner.token}` }, payload: input })
    expect(response.statusCode).toBe(200)
    const saved = PromptSettingUpdateResultSchema.parse(response.json())
    expect(saved).toMatchObject({ value: { value: { text }, revision: 1 }, replayed: false })
    expect(saved.value.versionId).toEqual(expect.any(String))
    expect(ManagedPromptSettingSchema.parse(decodeMcpToolResult(await reader.callTool({
      name: setting.readTool, arguments: {},
    })))).toEqual(saved.value)
    const restarted = new PostgresFoundationSettingsRepository(f.pool)
    const persisted = setting.key === 'system-prompt'
      ? await restarted.getSystemPrompt() : await restarted.getOperatorInitialPrompt()
    expect(persisted).toEqual(saved.value)
    const cleared = PromptSettingUpdateResultSchema.parse(decodeMcpToolResult(await owner.callTool({
      name: setting.updateTool,
      arguments: { value: { text: '' }, expectedRevision: 1, commandId: randomUUID() },
    })))
    expect(cleared).toMatchObject({ value: { value: { text: '' }, revision: 2 }, replayed: false })
    expect(cleared.value.versionId).not.toBe(saved.value.versionId)
    const readback = await f.app.inject({ method: 'GET', url: setting.path,
      headers: { authorization: `Bearer ${f.reader.token}` } })
    expect(readback.statusCode).toBe(200)
    expect(ManagedPromptSettingSchema.parse(readback.json())).toEqual(cleared.value)
    const versions = await f.pool.query('select record, version from application_setting_versions '
      + 'where setting_key=$1 order by version', [setting.key])
    expect(versions.rows).toEqual([
      { record: { text }, version: 1 }, { record: { text: '' }, version: 2 },
    ])
    const audits = await f.pool.query('select source, outcome, details from management_audit where action=$1',
      [setting.operation])
    expect(audits.rows).toEqual([
      { source: 'http', outcome: 'succeeded', details: { commandId: input.commandId } },
      { source: 'mcp', outcome: 'succeeded', details: expect.objectContaining({ commandId: expect.any(String) }) },
    ])
  })

  it('denies invalid credentials, read-only, and workspace-scoped callers with audited denials', async () => {
    const f = await fixture()
    const unauthenticated = await f.app.inject({ method: 'GET', url: setting.path,
      headers: { authorization: 'Bearer invalid-test-credential' } })
    expect(unauthenticated.statusCode).toBe(401)
    for (const caller of [f.reader, f.scoped]) {
      const client = await f.connect(caller.token)
      const tools = (await client.listTools()).tools.map(tool => tool.name)
      expect(tools).not.toContain(setting.updateTool)
      const input = { value: { text: 'Denied change' }, expectedRevision: 0, commandId: randomUUID() }
      expect((await client.callTool({ name: setting.updateTool, arguments: input })).isError).toBe(true)
      const response = await f.app.inject({ method: 'PUT', url: setting.path,
        headers: { authorization: `Bearer ${caller.token}` }, payload: input })
      expect(response.statusCode).toBe(403)
    }
    const scoped = await f.connect(f.scoped.token)
    expect((await scoped.listTools()).tools.map(tool => tool.name)).not.toContain(setting.readTool)
    expect((await scoped.callTool({ name: setting.readTool, arguments: {} })).isError).toBe(true)
    const read = await f.app.inject({ method: 'GET', url: setting.path,
      headers: { authorization: `Bearer ${f.scoped.token}` } })
    expect(read.statusCode).toBe(403)
    const unchanged = await f.app.inject({ method: 'GET', url: setting.path,
      headers: { authorization: `Bearer ${f.owner.token}` } })
    expect(unchanged.json()).toEqual({ value: { text: '' }, revision: 0, versionId: null })
    const denied = await f.pool.query('select source from management_audit where outcome=$1 and principal_id=$2',
      ['denied', f.reader.principal.id])
    expect(denied.rows).toEqual(expect.arrayContaining([{ source: 'http' }, { source: 'mcp' }]))
  })

  it('replays retries, rejects stale or changed commands, and rechecks live grants', async () => {
    const f = await fixture()
    const client = await f.connect(f.owner.token)
    const input: PromptSettingUpdateInput = {
      value: { text: 'Saved prompt' }, expectedRevision: 0, commandId: randomUUID(),
    }
    const call = (value: PromptSettingUpdateInput) => client.callTool({ name: setting.updateTool, arguments: value })
    const saved = PromptSettingUpdateResultSchema.parse(decodeMcpToolResult(await call(input)))
    expect(PromptSettingUpdateResultSchema.parse(decodeMcpToolResult(await call(input))))
      .toEqual({ ...saved, replayed: true })
    const httpReplay = await f.app.inject({ method: 'PUT', url: setting.path,
      headers: { authorization: `Bearer ${f.owner.token}` }, payload: input })
    expect(httpReplay.statusCode).toBe(200)
    expect(PromptSettingUpdateResultSchema.parse(httpReplay.json())).toEqual({ ...saved, replayed: true })
    expect((await call({ ...input, value: { text: 'Changed command' } })).isError).toBe(true)
    expect((await call({ ...input, commandId: randomUUID() })).isError).toBe(true)
    const stale = await f.app.inject({ method: 'PUT', url: setting.path,
      headers: { authorization: `Bearer ${f.owner.token}` }, payload: { ...input, commandId: randomUUID() } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
    const invalid = await f.app.inject({ method: 'PUT', url: setting.path,
      headers: { authorization: `Bearer ${f.owner.token}` },
      payload: { ...input, value: { text: false }, expectedRevision: 1, commandId: randomUUID() } })
    expect(invalid.statusCode).toBe(400)
    await f.pool.query('update management_principals set grants=$2::jsonb where id=$1',
      [f.owner.principal.id, JSON.stringify(f.reader.principal.grants)])
    const restarted = new FoundationSettingsManagementService(
      new PostgresFoundationSettingsRepository(f.pool), f.commands,
    )
    const update = setting.key === 'system-prompt'
      ? restarted.updateSystemPrompt(f.owner.principal, 'mcp', input)
      : restarted.updateOperatorInitialPrompt(f.owner.principal, 'mcp', input)
    await expect(update).rejects.toMatchObject({ status: 403 })
    expect(ManagedPromptSettingSchema.parse(decodeMcpToolResult(await client.callTool({
      name: setting.readTool, arguments: {},
    })))).toEqual(saved.value)
    const succeeded = await f.pool.query('select source from management_audit where action=$1 and outcome=$2',
      [setting.operation, 'succeeded'])
    expect(succeeded.rows).toEqual([{ source: 'mcp' }])
  })

  it('rejects oversized HTTP and MCP updates without changing the persisted prompt snapshot', async () => {
    const f = await fixture()
    const client = await f.connect(f.owner.token)
    const text = 'x'.repeat(MAX_PROMPT_TEXT_LENGTH)
    const accepted = await f.app.inject({ method: 'PUT', url: setting.path,
      headers: { authorization: `Bearer ${f.owner.token}` },
      payload: { value: { text }, expectedRevision: 0, commandId: randomUUID() } })
    expect(accepted.statusCode).toBe(200)
    const saved = PromptSettingUpdateResultSchema.parse(accepted.json())
    expect(saved.value.value.text).toBe(text)
    const oversized = { value: { text: `${text}x` }, expectedRevision: 1, commandId: randomUUID() }
    const http = await f.app.inject({ method: 'PUT', url: setting.path,
      headers: { authorization: `Bearer ${f.owner.token}` }, payload: oversized })
    expect(http.statusCode).toBe(400)
    const mcp = await client.callTool({ name: setting.updateTool,
      arguments: { ...oversized, commandId: randomUUID() } })
    expect(mcp.isError).toBe(true)
    const readback = ManagedPromptSettingSchema.parse(decodeMcpToolResult(await client.callTool({
      name: setting.readTool, arguments: {},
    })))
    expect(readback).toEqual(saved.value)
    const versions = await f.pool.query('select version from application_setting_versions where setting_key=$1',
      [setting.key])
    expect(versions.rows).toEqual([{ version: 1 }])
  })
})
