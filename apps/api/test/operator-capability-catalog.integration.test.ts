import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/client'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { CurrentOperatorCapabilitiesSchema } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult, OperatorCompactCapabilitiesSchema,
  OperatorToolSchemaResultSchema } from '@foreman-code/contracts/operator-mcp'
import { FileRetentionGetResultSchema, FileRetentionSaveResultSchema } from '@foreman-code/contracts/files'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { FileRetentionService } from '../src/modules/files/retention.js'
import { reviewAuthMcpDatabase } from './helpers/reviewAuthMcpDatabase.js'

let fixture: Awaited<ReturnType<typeof reviewAuthMcpDatabase>>
let owner: Client
let reader: Client
const workspaceId = randomUUID()
const workflowId = randomUUID()
const runId = randomUUID()
const extensionActions: Record<string, string[]> = {
  harness_instances_list: ['harnesses:read'],
  harness_instance_save: ['harnesses:update'],
  harness_instance_check: ['harnesses:read', 'harnesses:update'],
  workspace_root_configuration_adopt: ['source_roots:read', 'source_roots:bind',
    'workspace_locations:read', 'workspace_locations:validate', 'workspace_locations:update'],
  reference_files_list: ['workspaces:read', 'workflows:read'],
  reference_file_read: ['workspaces:read', 'workflows:read'],
  reference_file_add: ['workspaces:read', 'workspaces:update', 'workflows:read', 'workflows:update'],
  reference_file_remove: ['workspaces:read', 'workspaces:update', 'workflows:read', 'workflows:update'],
  file_retention_get: ['settings:read'],
  file_retention_preview: ['settings:read'],
  file_retention_save: ['settings:read', 'settings:update'],
  run_summaries_list: ['runs:read'],
  run_board_snapshot_get: ['runs:read'],
}

beforeAll(async () => {
  fixture = await reviewAuthMcpDatabase()
  // These optional ports participate only in discovery; their operations are never invoked.
  // Authentication, denial auditing and retention persistence use real PostgreSQL services.
  Object.assign(fixture.services, {
    workspaceRoots: {}, fileReferences: {}, harnessInstances: { qualificationSupported: true },
    runs: { history: {} }, fileRetention: new FileRetentionService(fixture.pool, fixture.commands),
  })
  const writer = await fixture.access.issue({ name: 'Catalog owner', audience: 'operator',
    grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] })
  const restricted = await fixture.access.issue({ name: 'Catalog reader', audience: 'operator',
    grants: [{ actions: ['capabilities:read', 'settings:read'], scope: {} }] })
  owner = await fixture.connect(writer.token)
  reader = await fixture.connect(restricted.token)
})
afterAll(async () => { await fixture?.close() })

async function listedNames(client: Client) {
  const names: string[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : {})
    names.push(...page.tools.map(tool => tool.name))
    cursor = page.nextCursor
  } while (cursor)
  return names.sort()
}

it.each([
  {}, { workspaceId }, { workspaceId, workflowId }, { workspaceId, workflowId, runId },
])('matches every registered tool in full and compact discovery for %j', async resource => {
  const names = await listedNames(owner)
  expect(names).toEqual(expect.arrayContaining(Object.keys(extensionActions)))
  for (const detail of ['full', 'compact'] as const) {
    const response = await owner.callTool({ name: 'operator_get_capabilities', arguments: { ...resource, detail } })
    expect(response.isError).not.toBe(true)
    const decoded = decodeMcpToolResult(response)
    const capabilities = detail === 'full' ? CurrentOperatorCapabilitiesSchema.parse(decoded)
      : OperatorCompactCapabilitiesSchema.parse(decoded)
    expect([...capabilities.tools].sort()).toEqual(names)
    if (detail === 'full') {
      const full = CurrentOperatorCapabilitiesSchema.parse(decoded)
      expect(full.requirements!.map(entry => entry.name).sort()).toEqual(names)
      for (const [name, actions] of Object.entries(extensionActions)) {
        expect(full.requirements!.find(entry => entry.name === name)?.actions).toEqual(expect.arrayContaining(actions))
      }
    }
  }
})

it('returns structured requirements for each registered extension without invoking it', async () => {
  for (const [name, actions] of Object.entries(extensionActions)) {
    const response = await owner.callTool({ name: 'operator_tool_schema_get', arguments: { name } })
    expect(response.isError, name).not.toBe(true)
    const schema = OperatorToolSchemaResultSchema.parse(decodeMcpToolResult(response))
    expect(schema.name).toBe(name)
    expect(schema.permissionRequirements.actions, name).toEqual(expect.arrayContaining(actions))
  }
})

it('keeps grant-hidden tools denied and reads back a persisted retention preference after discovery', async () => {
  const saved = FileRetentionSaveResultSchema.parse(decodeMcpToolResult(await owner.callTool({
    name: 'file_retention_save', arguments: { commandId: randomUUID(), durationSeconds: 7200 },
  })))
  const names = await listedNames(reader)
  expect(names).toContain('file_retention_get')
  for (const name of ['file_retention_save', 'harness_instance_save', 'reference_file_add', 'run_summaries_list']) {
    expect(names).not.toContain(name)
    const schema = await reader.callTool({ name: 'operator_tool_schema_get', arguments: { name } })
    expect(schema.isError).toBe(true)
    expect(decodeMcpToolResult(schema)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    const denied = await reader.callTool({ name, arguments: {} })
    expect(denied.isError).toBe(true)
    expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
  }
  for (const detail of ['full', 'compact']) {
    const response = await reader.callTool({ name: 'operator_get_capabilities', arguments: { detail, workspaceId } })
    expect(response.isError).not.toBe(true)
    expect((decodeMcpToolResult(response).tools as string[]).sort()).toEqual(names)
  }
  const readback = FileRetentionGetResultSchema.parse(decodeMcpToolResult(await owner.callTool({
    name: 'file_retention_get', arguments: {},
  })))
  expect(readback.preference).toEqual(saved.value.preference)
  expect(readback.preference.durationSeconds).toBe(7200)
})
