import { CURRENT_WORKFLOW_TOOLS } from '@foreman-code/contracts/wave25'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  ManagementActionSchema,
  type ManagementAction,
  type ManagementGrant,
  type ManagementPrincipal,
  type OperatorToolName,
} from '@foreman-code/contracts/management'
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagedPromptSettingSchema, PromptSettingUpdateResultSchema } from '@foreman-code/contracts/management'
import { reviewAuthMcpDatabase } from './helpers/reviewAuthMcpDatabase.js'

import { agentTools } from '../src/mcp/operator/tools/agents.js'
import { bugReportTools } from '../src/mcp/operator/tools/bugReports.js'
import { harnessTools } from '../src/mcp/operator/tools/harnesses.js'
import { interactionTools } from '../src/mcp/operator/tools/interactions.js'
import { runTools } from '../src/mcp/operator/tools/runs.js'
import { settingsTools } from '../src/mcp/operator/tools/settings.js'
import { workflowTools } from '../src/mcp/operator/tools/workflows.js'
import { workspaceDefaultsTools } from '../src/mcp/operator/tools/workspaceDefaults.js'
import { workspaceTools } from '../src/mcp/operator/tools/workspaces.js'
import { registerCurrentWorkflowTools } from '../src/mcp/operator/tools/currentWorkflow.js'
import { registerOperatorToolGroup } from '../src/mcp/operator/server.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'

// Independent expectations, not generated from the production permission catalog.
const actionTools: Array<[ManagementAction, OperatorToolName[]]> = [
  ['agents:read', ['agent_get', 'agent_list']],
  ['bug_reports:report', ['bug_report']],
  ['bug_reports:read', ['bug_report_get', 'bug_reports_list']],
  ['bug_reports:update', ['bug_report_update']],
  ['graph:read', []],
  ['graph:edit', []],
  ['graph:save', []],
  ['harnesses:read', ['claude_setup_options_get', 'harness_get', 'harness_list']],
  ['harnesses:update', ['harness_defaults_update']],
  ['interactions:read', ['interaction_get', 'interaction_list', 'interaction_summary']],
  ['runs:read', ['run_activities_get_v1', 'run_events_list', 'run_get', 'run_list']],
  ['runs:stop', ['run_stop']],
  ['settings:read', [
    'agent_defaults_get', 'circle_accounts_list', 'circle_credit_allowance_get', 'general_settings_get', 'operator_initial_prompt_get',
    'system_prompt_get', 'workflow_defaults_get', 'workspace_defaults_get',
  ]],
  ['settings:update', [
    'agent_defaults_update', 'circle_account_add', 'circle_account_remove', 'circle_credit_allowance_update', 'general_settings_update', 'operator_initial_prompt_update',
    'system_prompt_update', 'workflow_defaults_update', 'workspace_defaults_update',
  ]],
  ['workflows:read', ['workflow_get', 'workflow_list']],
  ['workflows:create', ['workflow_create']],
  ['workflows:update', ['workflow_update']],
  ['workflows:archive', ['workflow_archive', 'workflow_batch_archive']],
  ['workspaces:read', ['workspace_get', 'workspace_list']],
  ['workspaces:create', ['workspace_create']],
  ['workspaces:update', ['workspace_update']],
  ['workspaces:archive', ['workspace_archive', 'workspace_batch_archive']],
  ['workspace_locations:validate', ['workspace_location_validate']],
  ['workspace_locations:update', ['workspace_location_set']],
]

function context(grants: ManagementGrant[] = []): OperatorRequestContext {
  return {
    principal: {
      id: 'registration-reader', name: 'Registration reader', audience: 'operator',
      expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants,
    },
    // No service callback is executed in these registration-only tests.
    services: { settings: {}, circleAccounts: {}, interactions: {}, runs: {}, workflows: {}, bugReports: {} },
  } as unknown as OperatorRequestContext
}

function registered(context: OperatorRequestContext): string[] {
  const names: string[] = []
  const server = { registerTool: (name: string) => { names.push(name) } } as unknown as McpServer
  registerCurrentWorkflowTools(server, context)
  for (const tools of [agentTools, bugReportTools, harnessTools, interactionTools, runTools, settingsTools,
    workflowTools, workspaceTools, workspaceDefaultsTools]) {
    registerOperatorToolGroup(server, context, tools)
  }
  return names.sort()
}

describe('Operator tool registration permissions', () => {
  it.each([
    ['system_prompt_get', 'system_prompt_update'],
    ['operator_initial_prompt_get', 'operator_initial_prompt_update'],
  ] as const)('persists %s settings through authenticated MCP and denies read-only updates', async (readTool, updateTool) => {
    const database = await reviewAuthMcpDatabase({ hostProfiles: false })
    try {
      const expiresAt = new Date(Date.now() + 600_000)
      const owner = await database.access.issue({ name: 'Settings owner', audience: 'operator', expiresAt,
        grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
      const reader = await database.access.issue({ name: 'Settings reader', audience: 'operator', expiresAt,
        grants: [{ actions: ['settings:read'], scope: {} }] })
      const writeClient = await database.connect(owner.token)
      const readClient = await database.connect(reader.token)
      const input = { value: { text: 'Stored prompt' }, expectedRevision: 0, commandId: randomUUID() }
      const saved = PromptSettingUpdateResultSchema.parse(decodeMcpToolResult(await writeClient.callTool({
        name: updateTool, arguments: input,
      })))
      expect(saved).toMatchObject({ value: { value: input.value, revision: 1 }, replayed: false })
      const replay = PromptSettingUpdateResultSchema.parse(decodeMcpToolResult(await writeClient.callTool({
        name: updateTool, arguments: input,
      })))
      expect(replay).toEqual({ ...saved, replayed: true })
      const denied = await readClient.callTool({ name: updateTool,
        arguments: { ...input, commandId: randomUUID(), expectedRevision: 1, value: { text: 'Denied edit' } } })
      expect(denied.isError).toBe(true)
      const readback = ManagedPromptSettingSchema.parse(decodeMcpToolResult(await readClient.callTool({
        name: readTool, arguments: {},
      })))
      expect(readback).toEqual(saved.value)
      const persisted = readTool === 'system_prompt_get'
        ? await database.repository.getSystemPrompt() : await database.repository.getOperatorInitialPrompt()
      expect(persisted).toEqual(saved.value)
    } finally {
      await database.close()
    }
  })

  it.each(actionTools)('registers only the tools allowed by %s', (action, expected) => {
    expect(registered(context([{ actions: [action], scope: {} }]))).toEqual(expected)
  })

  it('registers every supported tool for an unrestricted owner', () => {
    // These require more than one grant (respond also needs interactions:read).
    const expected = [...actionTools.flatMap(([, names]) => names), 'interaction_respond',
      'run_handoffs_get_v1', 'run_start', 'run_start_resolve', 'workflow_reorder', 'bug_reports_close'].sort()
    expect(registered(context([{ actions: [...ManagementActionSchema.options], scope: {} }]))).toEqual(expected)
  })

  it('registers current V3 authoring with complete grants and hides retired graph tools', () => {
    const candidate = context([{ actions: [...ManagementActionSchema.options], scope: {} }])
    candidate.services.workflows = { current: {} } as OperatorRequestContext['services']['workflows']
    const names = registered(candidate)
    for (const name of Object.values(CURRENT_WORKFLOW_TOOLS)) expect(names).toContain(name)
    expect(names).not.toContain('graph_save')
    expect(names).not.toContain('graph_draft_apply')
    expect(names).not.toContain('run_history_get_v1')
  })

  it('does not advertise V3 Save when graph write and read grants have disjoint scopes', () => {
    const candidate = context([
      { actions: ['workflows:read', 'agents:read', 'graph:read', 'workspace_locations:read'], scope: { workspaceIds: ['a'] } },
      { actions: ['workflows:update', 'graph:edit', 'graph:save'], scope: { workspaceIds: ['b'] } },
    ])
    candidate.services.workflows = { current: {} } as OperatorRequestContext['services']['workflows']
    expect(registered(candidate)).toContain(CURRENT_WORKFLOW_TOOLS.validate)
    expect(registered(candidate)).not.toContain(CURRENT_WORKFLOW_TOOLS.save)
    expect(registered(candidate)).not.toContain(CURRENT_WORKFLOW_TOOLS.edits)
  })

  it('does not register tools without grants', () => {
    expect(registered(context())).toEqual([])
  })

  it('requires overlapping read and update scopes to advertise batch bug-report closing', () => {
    expect(registered(context([
      { actions: ['bug_reports:read'], scope: { workspaceIds: ['a'] } },
      { actions: ['bug_reports:update'], scope: { workspaceIds: ['b'] } },
    ]))).not.toContain('bug_reports_close')
    expect(registered(context([
      { actions: ['bug_reports:read'], scope: { workspaceIds: ['a'] } },
      { actions: ['bug_reports:update'], scope: { workspaceIds: ['a'] } },
    ]))).toContain('bug_reports_close')
  })

  it.each([
    { expiresAt: '2000-01-01T00:00:00.000Z' },
    { revokedAt: '2026-01-01T00:00:00.000Z' },
    { audience: 'worker' as const },
    { audience: 'user' as const },
  ])('rejects an inactive or non-Operator principal: %j', (patch) => {
    const candidate = context([{ actions: [...ManagementActionSchema.options], scope: {} }])
    candidate.principal = { ...candidate.principal, ...patch } as ManagementPrincipal
    expect(registered(candidate)).toEqual([])
  })

  it('still validates malformed stored grant scopes', () => {
    const candidate = context([{ actions: ['agents:read'], scope: {} }])
    candidate.principal.grants[0]!.scope = { workspaceIds: 'workspace-a' } as unknown as ManagementGrant['scope']
    expect(() => registered(candidate)).toThrow()
  })

  it('does not turn workspace-scoped grants into global settings or harness access', () => {
    expect(registered(context([{
      actions: ['settings:read', 'settings:update', 'harnesses:read', 'harnesses:update', 'workspaces:create', 'agents:read'],
      scope: { workspaceIds: ['workspace-a'] },
    }]))).toEqual(['agent_get', 'agent_list'])
  })

  it('keeps empty scopes from advertising resource access', () => {
    expect(registered(context([{ actions: ['agents:read'], scope: { workspaceIds: [] } }]))).toEqual([])
  })

  it.each(([
    [{ actions: ['runs:start'], scope: { workspaceIds: ['a'] } }],
    [{ actions: ['workspace_locations:read'], scope: { workspaceIds: ['a'] } }],
    [
      { actions: ['runs:start'], scope: { workspaceIds: ['a'] } },
      { actions: ['workspace_locations:read'], scope: { workspaceIds: ['b'] } },
    ],
    [
      { actions: ['runs:start'], scope: { workspaceIds: ['a'], workflowIds: [] } },
      { actions: ['workspace_locations:read'], scope: { workspaceIds: ['a'] } },
    ],
    [
      { actions: ['runs:start'], scope: { workspaceIds: ['a'] } },
      { actions: ['workspace_locations:read'], scope: { workspaceIds: [] } },
    ],
  ] satisfies ManagementGrant[][]).map((grants) => ({ grants })))('requires compatible run-start and location grants: $grants', ({ grants }) => {
    expect(registered(context(grants))).toEqual([])
  })

  it('registers Start and resolution when both grants cover the same workspace', () => {
    expect(registered(context([
      { actions: ['runs:start'], scope: { workspaceIds: ['a'], workflowIds: ['workflow-a'] } },
      { actions: ['workspace_locations:read'], scope: { workspaceIds: ['a'] } },
    ]))).toEqual(['run_start', 'run_start_resolve'])
  })

  it('does not register tools for absent optional services', () => {
    const candidate = context([{ actions: ['settings:read', 'settings:update', 'interactions:read', 'interactions:respond'], scope: {} }])
    delete candidate.services.settings
    delete candidate.services.circleAccounts
    delete candidate.services.interactions
    expect(registered(candidate)).toEqual([])
  })

  it('does not register Start or resolution when the run service is absent', () => {
    const candidate = context([{
      actions: ['runs:start', 'workspace_locations:read'], scope: {},
    }])
    Reflect.deleteProperty(candidate.services, 'runs')
    expect(registered(candidate)).toEqual([])
  })
})


it('hides CircleCI registration tools when the account service is unavailable', () => {
  const candidate = context([{ actions: ['settings:read', 'settings:update'], scope: {} }])
  delete candidate.services.circleAccounts
  expect(registered(candidate)).not.toContain('circle_accounts_list')
  expect(registered(candidate)).not.toContain('circle_account_add')
  expect(registered(candidate)).not.toContain('circle_account_remove')
})
