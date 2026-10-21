import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { CURRENT_WORKFLOW_TOOLS, RUN_INSPECTION_TOOLS } from '@foreman-code/contracts/wave25'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'

import { SkillCatalogService } from '../src/modules/skills/catalog.js'
import { SkillUsageService } from '../src/modules/skills/usage.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

describe.skipIf(!postgresEnabled)('authenticated calls to hidden MCP tools', () => {
  it('audits every grant-hidden tool once and distinguishes unknown names without side effects', async () => {
    const f = await currentOperatorIntegration()
    try {
      // Optional ports participate only in registration. Workspace persistence,
      // authentication and denial auditing use the real PostgreSQL services.
      const services: OperatorServices = f.services
      Object.assign(services, {
        workerExecution: {}, buildComputers: {}, harnessQualifications: {}, operatorChat: {}, agentChat: {}, interactions: {},
        resourceTelemetry: { reads: {}, selectors: {} },
        sources: {}, devices: {}, trustedConnections: {}, jobs: {}, jobRuntimeProfiles: {},
        fileReferences: {}, fileRetention: {},
        runGraph: {}, harnessInstances: { qualificationSupported: true },
        harnessSettings: { mcp: {}, directories: {}, plugins: {} },
        extensions: {
          native: {}, agents: {}, history: {}, lifecycle: {},
          workspace: { provisioningEnabled: true },
          skills: new SkillCatalogService(f.db.pool, f.commands),
          skillUsage: new SkillUsageService(f.db.pool,
            new OperatorAgentMutationService(f.db.pool, f.commands, f.services.harnesses),
            f.services.workflows.current, f.commands),
        },
      })
      const restricted = await f.access.issue({
        name: 'No management grants', audience: 'operator', grants: [],
        expiresAt: new Date(Date.now() + 600000),
      })
      const client = await f.connect(restricted.token)
      const listed = (await client.listTools()).tools.map(tool => tool.name)
      const catalog = (await f.client.listTools()).tools.map(tool => tool.name)
      // Skill tools intentionally remain discoverable; their services enforce grants on calls.
      expect(listed.sort()).toEqual(['skill_list', 'skill_get', 'skill_versions_list', 'skill_create',
        'skill_update', 'skill_archive', 'skill_usage_get', 'skill_users_update'].sort())
      expect(catalog).toEqual(expect.arrayContaining([
        'operator_get_capabilities', 'workspace_get', 'workspace_create', 'workspace_update', 'workspace_archive',
        'workspace_location_set', 'workspace_storage_folders_list', 'workspace_storage_folder_delete',
        'workspace_folders_list', 'workspace_folder_create', 'workspace_folder_rename', 'workspace_folder_undo',
        'workspace_folders_delete', 'harness_list', 'harness_qualification_run', 'execution_readiness_get',
        'harness_mcp_servers_list', 'codex_plugins_list', 'harness_instances_list', 'harness_instance_save',
        'agent_defaults_get', 'workspace_defaults_update', 'worker_execution_settings_get',
        'build_computer_get', 'build_computer_update', 'build_computers_update',
        'operator_chat_get', 'operator_chat_send', 'operator_chat_cancel', 'agent_chat_read',
        'workflow_create', 'agent_get', 'agent_create', 'workspace_restore', 'workflow_versions_list',
        'runner_list', 'run_get', 'run_start', 'run_subagents_list_v1', 'run_summaries_list',
        'workflow_schedule_get', 'interaction_list', 'reference_file_add', 'source_get',
        'devices_list', 'device_connection_read', 'resource_telemetry_read', 'job_start',
        'job_runtime_profile_list', 'file_retention_get',
        CURRENT_WORKFLOW_TOOLS.save, RUN_INSPECTION_TOOLS.record,
      ]))
      const workspaceId = f.f.scope.workspaceId
      const workspace = ManagedWorkspaceSchema.parse(
        decodeMcpToolResult((await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId } }))),
      )
      const folders = await readdir(f.db.directory)
      const receiptsQuery = 'select * from management_command_receipts order by principal_id, operation, command_id'
      const receipts = (await f.db.pool.query(receiptsQuery)).rows
      const providerCounts = { ...f.provider.counts }
      const skill = { workspaceId, skillId: 'denied-skill' }
      const skillInputs: Record<string, Record<string, unknown>> = {
        skill_list: { workspaceId }, skill_get: skill, skill_versions_list: skill,
        skill_create: { workspaceId, name: 'Denied skill', instructions: 'Do not save this.' },
        skill_update: { ...skill, expectedRevision: 1, name: 'Denied skill', instructions: 'Do not save this.' },
        skill_archive: { ...skill, expectedRevision: 1, archived: true },
        skill_usage_get: skill, skill_users_update: skill,
      }
      for (const name of catalog) {
        const result = await client.callTool({ name, arguments: skillInputs[name] ?? {} })
        expect(result.isError, name).toBe(true)
        expect(JSON.stringify(result.content), name).toContain('ACCESS_DENIED')
        expect((await f.db.pool.query(
          `select source, outcome from management_audit
           where principal_id=$1 and (action=$2 or target_key=$3)`,
          [restricted.principal.id, name, `mcp:${name}`],
        )).rows, name).toEqual([{ source: 'mcp', outcome: 'denied' }])
      }
      await expect(client.callTool({ name: 'unknown_management_tool', arguments: {} })).rejects.toThrow('not found')
      expect((await f.db.pool.query('select action from management_audit where principal_id=$1',
        [restricted.principal.id])).rowCount).toBe(catalog.length)
      expect((await f.db.pool.query(receiptsQuery)).rows).toEqual(receipts)
      expect(decodeMcpToolResult((await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId } }))))
        .toMatchObject({ ...workspace, locationValidation: { status: workspace.locationValidation.status } })
      expect(await readdir(f.db.directory)).toEqual(folders)
      expect(f.provider.counts).toEqual(providerCounts)
    } finally {
      await f.close()
    }
  }, 120000)

  it('keeps read-only and disjoint scopes denied while authorized commands retain revisions and replay', async () => {
    const f = await currentOperatorIntegration()
    try {
      const workspaceId = f.f.scope.workspaceId
      const workspace = ManagedWorkspaceSchema.parse(
        decodeMcpToolResult((await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId } }))),
      )
      const initial = { ...workspace, locationValidation: { status: workspace.locationValidation.status } }
      const input = { workspaceId, commandId: randomUUID(), expectedRevision: workspace.revision,
        name: `${workspace.workspace.name} renamed` }
      const reader = await f.access.issue({
        name: 'Read-only workspace caller', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['workspaces:read', 'workspace_locations:read'], scope: { workspaceIds: [workspaceId] } }],
      })
      const client = await f.connect(reader.token)
      expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('workspace_update')
      expect((await client.callTool({ name: 'workspace_update', arguments: input })).isError).toBe(true)
      expect(decodeMcpToolResult((await client.callTool({ name: 'workspace_get', arguments: { workspaceId } }))))
        .toMatchObject(initial)
      const otherWorkspace = await f.access.issue({
        name: 'Other workspace editor', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['workspaces:update'], scope: { workspaceIds: ['another-workspace'] } }],
      })
      const otherEditor = await f.connect(otherWorkspace.token)
      expect((await otherEditor.listTools()).tools.map(tool => tool.name)).toContain('workspace_update')
      const deniedUpdate = await otherEditor.callTool({ name: 'workspace_update', arguments: input })
      expect(deniedUpdate.isError).toBe(true)
      expect(JSON.stringify(deniedUpdate.content)).toContain('ACCESS_DENIED')
      const disjoint = await f.access.issue({
        name: 'Disjoint run grants', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [
          { actions: ['runs:start'], scope: { workspaceIds: [workspaceId] } },
          { actions: ['workspace_locations:read'], scope: { workspaceIds: ['another-workspace'] } },
        ],
      })
      const wrongScopes = await f.connect(disjoint.token)
      expect((await wrongScopes.listTools()).tools.map(tool => tool.name)).not.toContain('run_start')
      const deniedRun = await wrongScopes.callTool({ name: 'run_start', arguments: { workspaceId } })
      expect(deniedRun.isError).toBe(true)
      expect(JSON.stringify(deniedRun.content)).toContain('ACCESS_DENIED')
      for (const principal of [reader.principal, otherWorkspace.principal, disjoint.principal]) {
        expect((await f.db.pool.query('select outcome from management_audit where principal_id=$1', [principal.id])).rows)
          .toEqual([{ outcome: 'denied' }])
        expect((await f.db.pool.query('select command_id from management_command_receipts where principal_id=$1',
          [principal.id])).rowCount).toBe(0)
      }
      const updated = await f.client.callTool({ name: 'workspace_update', arguments: input })
      expect(updated.isError).not.toBe(true)
      expect(decodeMcpToolResult((await f.client.callTool({ name: 'workspace_update', arguments: input }))))
        .toEqual({ ...(decodeMcpToolResult(updated) as object), replayed: true })
      const conflict = await f.client.callTool({ name: 'workspace_update', arguments: {
        ...input, commandId: randomUUID(),
      } })
      expect(conflict.isError).toBe(true)
      expect(JSON.stringify(conflict.content)).toContain('REVISION_CONFLICT')
      expect(decodeMcpToolResult((await client.callTool({ name: 'workspace_get', arguments: { workspaceId } }))))
        .toMatchObject({ revision: workspace.revision + 1, workspace: { name: input.name } })
      await f.access.revoke(reader.principal.id)
      const revoked = await f.app.inject({ method: 'POST', url: '/mcp',
        headers: { host: 'localhost', authorization: `Bearer ${reader.token}` },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_update', arguments: input } },
      })
      expect(revoked.statusCode).toBe(401)
      expect(revoked.json().error.code).toBe('AUTH_REVOKED')
    } finally {
      await f.close()
    }
  }, 60000)
})
