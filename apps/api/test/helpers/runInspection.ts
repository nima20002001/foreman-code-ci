import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import {
  CURRENT_WORKFLOW_TOOLS, RUN_INSPECTION_TOOLS, CurrentWorkflowSaveResultSchema,
  RunExecutionsPageSchema, RunVersionDetailSchema,
  type RunExecutionSummary, type RunInspectionToolName,
} from '@foreman-code/contracts/wave25'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { waitForSuccessfulRunCleanup } from './runSettlement.testSupport.js'

export type Fixture = Awaited<ReturnType<typeof currentOperatorIntegration>>
type Client = Fixture['client']
export function value(result: { isError?: boolean | undefined; structuredContent?: unknown }): unknown {
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  expect(decodeMcpToolResult(result)).toBeDefined()
  return decodeMcpToolResult(result)
}
function mcpError(result: unknown): string {
  const parsed = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
  expect(parsed.isError).toBe(true)
  const text = parsed.content?.find((item) => item.type === 'text')?.text
  expect(text).toBeDefined()
  return (JSON.parse(text!) as { error: { code: string } }).error.code
}
export const requestScope = (f: Fixture) => ({ workspaceId: f.f.scope.workspaceId, runId: f.f.run.id })
export function path(input: Record<string, unknown>, name: RunInspectionToolName) {
  const { workspaceId, runId, executionId, ...query } = input
  const base = `/api/management/workspaces/${encodeURIComponent(String(workspaceId))}/runs/${encodeURIComponent(String(runId))}`
  const suffix = name === RUN_INSPECTION_TOOLS.record ? '/record'
    : name === RUN_INSPECTION_TOOLS.version ? '/version' : name === RUN_INSPECTION_TOOLS.executions ? '/executions'
    : `/executions/${encodeURIComponent(String(executionId))}${name === RUN_INSPECTION_TOOLS.bindings ? '/bindings' : ''}`
  const parameters = new URLSearchParams(Object.entries(query).filter(([, val]) => val !== undefined).map(([key, val]) => [key, String(val)]))
  return `${base}${suffix}${parameters.size ? `?${parameters}` : ''}`
}
export async function parity(f: Fixture, client: Client, token: string, name: RunInspectionToolName, input: Record<string, unknown>) {
  const [http, result] = await Promise.all([
    f.app.inject({ method: 'GET', url: path(input, name), headers: { authorization: `Bearer ${token}` } }),
    client.callTool({ name, arguments: input }),
  ])
  expect(http.statusCode, http.body).toBe(200)
  expect(http.headers['cache-control']).toBe('private, no-store')
  expect(http.headers.vary).toContain('Authorization')
  const mcp = value(result)
  expect(http.json()).toEqual(mcp)
  return mcp
}
export async function denied(f: Fixture, client: Client, token: string, name: RunInspectionToolName,
  input: Record<string, unknown>, status: number, code: string) {
  const [http, result] = await Promise.all([
    f.app.inject({ method: 'GET', url: path(input, name), headers: { authorization: `Bearer ${token}` } }),
    client.callTool({ name, arguments: input }),
  ])
  expect(http.statusCode, http.body).toBe(status)
  expect(http.json()).toMatchObject({ error: { code } })
  expect(mcpError(result)).toBe(code)
}
export async function reader(f: Fixture, grants?: ManagementPrincipal['grants']) {
  const issued = await f.access.issue({ name: 'ENG-05 read-only inspector', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
    grants: grants ?? [
      { actions: ['capabilities:read'], scope: {} },
      { actions: ['runs:read'], scope: { workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId], runIds: [f.f.run.id] } },
      { actions: ['workflows:read'], scope: { workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId] } },
    ] })
  return { ...issued, client: await f.connect(issued.token) }
}
export async function terminal(f: Fixture, runId = f.f.run.id, timeoutMs = 20000) {
  try {
    await waitForSuccessfulRunCleanup({ pool: f.db.pool, runId, timeoutMs,
      readRecord: () => f.services.runs.inspection.record(f.writer.principal,
        { workspaceId: f.f.scope.workspaceId, runId }) })
  } catch (error) {
    // A failed async Start can otherwise leave only "running" in the public
    // record. Keep failure evidence bounded and omit native/private payloads.
    const [executions, effects, activity] = await Promise.all([
      f.db.pool.query<{ workflow_node_id: string; accepted: boolean; state: string | null }>(
        `select workflow_node_id,accepted,record->>'status' as state from harness_executions
         where run_id=$1 order by created_at,id limit 8`, [runId]),
      f.db.pool.query<{ effect_kind: string; count: string }>(
        `select effect_kind,count(*)::text from run_graph_effects where run_id=$1
         group by effect_kind order by effect_kind`, [runId]),
      f.db.pool.query<{ kind: string }>(
        `select kind from run_activity where run_id=$1 order by sequence desc limit 12`, [runId]),
    ])
    throw new Error(`${String(error)}; progress=${JSON.stringify({
      dispatchErrors: f.dispatchErrors.map(String), providerCounts: f.provider.counts,
      startedNodes: f.provider.startedNodes, executions: executions.rows,
      effects: effects.rows, recentActivity: activity.rows.map((row) => row.kind),
    })}`, { cause: error })
  }
}
export async function allExecutions(f: Fixture, r: Awaited<ReturnType<typeof reader>>) {
  const items: RunExecutionSummary[] = [], seen = new Set<string>()
  let cursor: string | undefined
  // The test is finite even if an incorrect server returns a cyclic cursor.
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const input = { ...requestScope(f), limit: 1, ...(cursor ? { cursor } : {}) }
    const page = RunExecutionsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, input))
    expect(page.items).toHaveLength(1)
    expect(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, input)).toEqual(page)
    items.push(...page.items)
    if (!page.pageInfo.nextCursor) return items
    expect(seen.has(page.pageInfo.nextCursor)).toBe(false)
    seen.add(page.pageInfo.nextCursor); cursor = page.pageInfo.nextCursor
  }
  throw new Error('Inspection pagination did not terminate')
}
export async function resaveChangingRepeat(f: Fixture) {
  const before = RunVersionDetailSchema.parse(await parity(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.version, requestScope(f)))
  const graph = structuredClone(before.version.definition)
  if (graph.repeat) {
    delete graph.repeat
    graph.executionPolicy = { maxParallelism: 1, maxNodeExecutions: graph.nodes.length }
  } else {
    const exit = graph.nodes.at(-1)!
    exit.choice = { outcomes: [
      { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
    ] }
    graph.repeat = { contractVersion: 1, blocks: [{ id: 'added-after-run', nodeIds: graph.nodes.map((node) => node.id),
      entryNodeId: before.version.entryNodeId, exitNodeId: exit.id, maxOccurrences: 2,
      repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] }
    graph.executionPolicy = { maxParallelism: 2, maxNodeExecutions: graph.nodes.length * 2 }
  }
  const row = (await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [before.scope.workflowId])).rows[0]!
  const saved = CurrentWorkflowSaveResultSchema.parse(value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: {
    workspaceId: before.scope.workspaceId, workflowId: before.scope.workflowId, executionSemanticsVersion: 3,
    commandId: randomUUID(), expectedRevision: Number(row.revision), expectedWorkflowVersionId: before.version.id,
    expectedAgentConfigurationVersionIds: before.version.agentConfigurationVersionIds, graph,
  } })))
  expect(saved.value.version.id).not.toBe(before.version.id)
  expect(!!saved.value.version.definition.repeat).toBe(!before.version.definition.repeat)
  expect(await parity(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.version, requestScope(f))).toEqual(before)
}

