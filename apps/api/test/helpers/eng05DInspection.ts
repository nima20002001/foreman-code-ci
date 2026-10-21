import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import {
  RUN_INSPECTION_TOOLS, RunStartV3InputSchema, RunStartV3ResultSchema,
  type RunInspectionToolName,
} from '@foreman-code/contracts/wave25'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'

export type InspectionHarness = Awaited<ReturnType<typeof currentOperatorIntegration>>
export type InspectionReader = { token: string; client: InspectionHarness['client']; principal: ManagementPrincipal }
export type InspectionMeasurement = { tool: string; status: number; bytes: number; items?: number; cursor: boolean; limit?: unknown }
export function value(result: { isError?: boolean | undefined; structuredContent?: unknown }): unknown {
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  expect(decodeMcpToolResult(result)).toBeDefined()
  return decodeMcpToolResult(result)
}
export function errorCode(result: unknown): string {
  const failure = result as { isError?: boolean | undefined; content?: Array<{ type: string; text?: string }> }
  expect(failure.isError).toBe(true)
  const text = failure.content?.find((item) => item.type === 'text')?.text
  expect(text).toBeDefined()
  return (JSON.parse(text!) as { error: { code: string } }).error.code
}
export function path(input: Record<string, unknown>, name: RunInspectionToolName) {
  const { workspaceId, runId, executionId, ...query } = input
  const root = `/api/management/workspaces/${encodeURIComponent(String(workspaceId))}/runs/${encodeURIComponent(String(runId))}`
  const tail = name === RUN_INSPECTION_TOOLS.version ? '/version' : name === RUN_INSPECTION_TOOLS.executions ? '/executions'
    : `/executions/${encodeURIComponent(String(executionId))}${name === RUN_INSPECTION_TOOLS.bindings ? '/bindings' : ''}`
  const params = new URLSearchParams(Object.entries(query).filter(([, item]) => item !== undefined).map(([key, item]) => [key, String(item)]))
  return `${root}${tail}${params.size ? `?${params}` : ''}`
}
export async function reader(f: InspectionHarness, runId: string, grants?: ManagementPrincipal['grants']): Promise<InspectionReader> {
  const issued = await f.access.issue({ name: 'ENG05-D task-owned reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
    grants: grants ?? [
      { actions: ['capabilities:read'], scope: {} },
      { actions: ['runs:read'], scope: { workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId], runIds: [runId] } },
      { actions: ['workflows:read'], scope: { workspaceIds: [f.f.scope.workspaceId], workflowIds: [f.f.scope.workflowId] } },
    ] })
  return { ...issued, client: await f.connect(issued.token) }
}
export async function pairedRead(f: InspectionHarness, r: InspectionReader, name: RunInspectionToolName,
  input: Record<string, unknown>, measurements: InspectionMeasurement[]) {
  const response = await f.app.inject({ method: 'GET', url: path(input, name), headers: { authorization: `Bearer ${r.token}` } })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.headers['cache-control']).toBe('private, no-store')
  expect(response.headers.vary).toContain('Authorization')
  const json: unknown = response.json()
  const items = json && typeof json === 'object' && 'items' in json && Array.isArray(json.items) ? json.items.length : undefined
  measurements.push({ tool: name, status: response.statusCode, bytes: Buffer.byteLength(response.body, 'utf8'),
    ...(items === undefined ? {} : { items }), cursor: input.cursor !== undefined, limit: input.limit })
  expect(value(await r.client.callTool({ name, arguments: input }))).toEqual(json)
  return json
}
export async function pairedDenial(f: InspectionHarness, r: InspectionReader, name: RunInspectionToolName,
  input: Record<string, unknown>, status: number, code: string) {
  const response = await f.app.inject({ method: 'GET', url: path(input, name), headers: { authorization: `Bearer ${r.token}` } })
  expect(response.statusCode, response.body).toBe(status)
  expect(response.json()).toMatchObject({ error: { code } })
  expect(errorCode(await r.client.callTool({ name, arguments: input }))).toBe(code)
}
export async function terminal(f: InspectionHarness, runId: string, timeout = 60000) {
  await expect.poll(async () => (await f.runs.get(runId))?.executionState, { timeout, interval: 50 }).toBe('completed')
  await expect.poll(async () => (await f.db.pool.query<{ pending: boolean }>(
    'select exists(select 1 from run_cleanup_intents where run_id=$1 and pending) as pending', [runId])).rows[0]?.pending,
  { timeout: 20000, interval: 50 }).toBe(false)
}
/** Any inserted seed Run must already be terminal. This uses production HTTP Start and
 * then replays its SAME command through authenticated Operator MCP. Only the
 * existing helper's external provider/filesystem qualification is synthetic. */
export async function startThroughHttp(f: InspectionHarness, input: Record<string, unknown> = {}, locationRevision?: number) {
  if (locationRevision === undefined) {
    const location = value(await f.client.callTool({ name: 'workspace_location_set', arguments: {
      workspaceId: f.f.scope.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
      runnerId: f.locations.runnerId, rootPath: f.db.directory,
    } })) as { locationRevision?: number; value?: { locationRevision: number } }
    locationRevision = location.value?.locationRevision ?? location.locationRevision
  }
  expect(locationRevision).toBeTypeOf('number')
  const current = await f.services.workflows.get(f.writer.principal, f.f.scope.workspaceId, f.f.scope.workflowId)
  const request = RunStartV3InputSchema.parse({ workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId,
    workflowVersionId: current.currentVersionId, executionSemanticsVersion: 3, commandId: randomUUID(),
    expectedWorkflowRevision: Number(current.revision), expectedAgentConfigurationVersionIds: f.f.version.agentConfigurationVersionIds,
    expectedLocationRevision: locationRevision, input })
  const response = await f.app.inject({ method: 'POST',
    url: `/api/management/workspaces/${request.workspaceId}/workflows/${request.workflowId}/runs`,
    headers: { authorization: `Bearer ${f.writer.token}` }, payload: request })
  expect(response.statusCode, response.body).toBe(202)
  const started = RunStartV3ResultSchema.parse(response.json())
  expect(started.accepted).toBe(true)
  expect(started.run.executionSemanticsVersion).toBe(3)
  expect(started.run.workflowVersionId).toBe(request.workflowVersionId)
  const replay = RunStartV3ResultSchema.parse(value(await f.client.callTool({ name: 'run_start', arguments: request })))
  expect(replay.replayed).toBe(true)
  expect(replay.run.id).toBe(started.run.id)
  expect((await f.db.pool.query('select id from runs where id=$1', [started.run.id])).rows).toHaveLength(1)
  return { started, request, locationRevision: locationRevision! }
}
