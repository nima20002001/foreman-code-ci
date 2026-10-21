import { agentWorkflowVersion } from './agentWorkflowFixture.js'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import {
  CURRENT_WORKFLOW_TOOLS, RUN_INSPECTION_TOOLS, RUN_INSPECTION_LIMITS,
  CurrentWorkflowSaveResultSchema, RunExecutionDetailSchema, RunExecutionBindingsPageSchema,
  RunExecutionsPageSchema, RunVersionDetailSchema, WorkflowVersionV3Schema,
  makeCurrentWorkflowFixture, type RunExecutionSummary,
} from '@foreman-code/contracts/wave25'
import { RunEventsListInputSchema, RunEventsPageSchema } from '@foreman-code/contracts/management'
import { answerForRun } from './coordinationEnvelope.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import {
  value, reader, pairedRead, pairedDenial, terminal, startThroughHttp,
  type InspectionMeasurement, type InspectionHarness, type InspectionReader,
} from './eng05DInspection.js'

async function pages(f: InspectionHarness, r: InspectionReader, runId: string, measurements: InspectionMeasurement[]) {
  const input = { workspaceId: f.f.scope.workspaceId, runId }
  const items: RunExecutionSummary[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = RunExecutionsPageSchema.parse(await pairedRead(f, r, RUN_INSPECTION_TOOLS.executions,
      { ...input, ...(cursor ? { cursor } : {}) }, measurements))
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.length).toBeLessThanOrEqual(25)
    if (page.pageInfo.nextCursor) expect(page.items).toHaveLength(25)
    items.push(...page.items)
    if (!page.pageInfo.nextCursor) return items
    expect(cursors.has(page.pageInfo.nextCursor), 'The cursor chain must make progress').toBe(false)
    cursors.add(page.pageInfo.nextCursor); cursor = page.pageInfo.nextCursor
  }
  throw new Error('Bounded ENG05-D execution pagination did not terminate')
}

async function assertActivityPages(f: InspectionHarness, r: InspectionReader, runId: string) {
  const input = { workspaceId: f.f.scope.workspaceId, runId, limit: 2 }
  const base = `/api/management/workspaces/${input.workspaceId}/runs/${runId}/events`
  // The provider-backed engine records real activity; no activity SQL rows are
  // manufactured by this test. HTTP cursor maps to MCP's afterSequence.
  const first = await f.app.inject({ method: 'GET', url: `${base}?limit=2`, headers: { authorization: `Bearer ${r.token}` } })
  expect(first.statusCode, first.body).toBe(200)
  const page = RunEventsPageSchema.parse(first.json())
  expect(page.items).toHaveLength(2)
  expect(value(await r.client.callTool({ name: 'run_events_list', arguments: input }))).toEqual(page)
  expect(page.pageInfo.nextCursor).not.toBeNull()
  const afterSequence = Number(page.pageInfo.nextCursor)
  RunEventsListInputSchema.parse({ ...input, afterSequence })
  const second = await f.app.inject({ method: 'GET', url: `${base}?limit=2&cursor=${encodeURIComponent(page.pageInfo.nextCursor!)}`,
    headers: { authorization: `Bearer ${r.token}` } })
  expect(second.statusCode, second.body).toBe(200)
  const next = RunEventsPageSchema.parse(second.json())
  expect(next.items.length).toBeGreaterThan(0)
  expect(next.items.length).toBeLessThanOrEqual(2)
  expect(next.items.every((item) => item.runId === runId && item.sequence > afterSequence)).toBe(true)
  expect(new Set([...page.items, ...next.items].map((item) => item.id)).size).toBe(page.items.length + next.items.length)
  expect(value(await r.client.callTool({ name: 'run_events_list', arguments: { ...input, afterSequence } }))).toEqual(next)
  console.info(`ENG05-D_ACTIVITY ${JSON.stringify({ requests: 2, mcpCalls: 2,
    bytes: [Buffer.byteLength(first.body, 'utf8'), Buffer.byteLength(second.body, 'utf8')], pageSize: 2 })}`)
}

export async function inspectRepeatRun({ exit, maxOccurrences, expectedOccurrences }: {
  exit: 'early' | 'limit'
  maxOccurrences: number
  expectedOccurrences: number
}) {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'repeat')
  fixture.version = agentWorkflowVersion(WorkflowVersionV3Schema.parse({ ...fixture.version, definition: { ...fixture.version.definition,
    executionPolicy: { maxParallelism: 1, maxNodeExecutions: maxOccurrences * 2 },
    repeat: { ...fixture.version.definition.repeat!, blocks: fixture.version.definition.repeat!.blocks.map((block) => ({ ...block, maxOccurrences })) },
  } }))
  const exitId = fixture.version.definition.nodes[1]!.id
  let exits = 0
  const f = await currentOperatorIntegration({ fixture, insertRun: false, approvalNodeIds: [], outputFor: (nodeId, request) => {
    if (nodeId !== exitId) return answerForRun(request, { data: { nodeId } })
    exits++
    const outcome = exit === 'early' && exits === 2 ? 'pass' : 'issues'
    const answer = answerForRun(request, { routing: { outcome }, data: {
      latestDeliverable: { task: 'ENG05-D', occurrence: exits },
      remainingFindings: outcome === 'pass' ? [] : [{ id: 'task-owned-finding' }],
    } })
    return { text: JSON.stringify(answer) }
  } })
  const measurements: InspectionMeasurement[] = []
  try {
    const { started, locationRevision } = await startThroughHttp(f, { task: 'ENG05-D', exit })
    const runId = started.run.id, args = { workspaceId: f.f.scope.workspaceId, runId }
    // Fourteen real occurrences produce 28 executions and cross the 25-item page boundary.
    await terminal(f, runId, exit === 'limit' ? 600000 : 60000)
    expect(exits).toBe(expectedOccurrences)
    const r = await reader(f, runId)
    const providerCounts = { ...f.provider.counts }
    const original = RunVersionDetailSchema.parse(await pairedRead(f, r, RUN_INSPECTION_TOOLS.version, args, measurements))
    const items = await pages(f, r, runId, measurements)
    expect(items).toHaveLength(expectedOccurrences * 2)
    expect(new Set(items.map((item) => item.executionId)).size).toBe(items.length)
    expect(new Set(items.map((item) => item.occurrence?.occurrenceIndex))).toEqual(new Set(Array.from({ length: expectedOccurrences }, (_, index) => index + 1)))
    expect(items.every((item) => item.attempt === 1 && item.acceptedResultAvailable)).toBe(true)
    const sql = (await f.db.pool.query<{ id: string }>(
      'select id from harness_executions where run_id=$1 order by created_at desc,id desc', [runId])).rows.map((row) => row.id)
    expect(items.map((item) => item.executionId)).toEqual(sql)
    expect((await f.db.pool.query('select occurrence_id from run_repeat_occurrences where run_id=$1', [runId])).rows).toHaveLength(expectedOccurrences)
    expect(JSON.stringify(items)).not.toMatch(/acceptedInput|reportedResult|nativeSessionId|workingDirectory|credential/)

    const first = RunExecutionsPageSchema.parse(await pairedRead(f, r, RUN_INSPECTION_TOOLS.executions, { ...args, limit: 1 }, measurements))
    expect(first.items).toHaveLength(1)
    expect(first.pageInfo.nextCursor).not.toBeNull()
    const rest = RunExecutionsPageSchema.parse(await pairedRead(f, r, RUN_INSPECTION_TOOLS.executions,
      { ...args, limit: 100, cursor: first.pageInfo.nextCursor! }, measurements))
    expect([...first.items, ...rest.items].map((item) => item.executionId)).toEqual(sql)
    expect(rest.pageInfo.nextCursor).toBeNull()
    expect(await pairedRead(f, r, RUN_INSPECTION_TOOLS.executions, { ...args, limit: 1 }, measurements)).toEqual(first)
    const entry = items.find((item) => item.workflowNodeId === f.f.version.entryNodeId && item.occurrence?.occurrenceIndex === 2)!
    expect(entry).toBeDefined()
    const exactArgs = { ...args, executionId: entry.executionId }
    const exact = RunExecutionDetailSchema.parse(await pairedRead(f, r, RUN_INSPECTION_TOOLS.execution, exactArgs, measurements))
    expect(exact.acceptedInput.value.runInput).toEqual({ task: 'ENG05-D', exit })
    if (exact.execution.kind === 'job' || entry.kind === 'job') throw new Error('inspection fixture requires Agent executions')
    expect(exact.execution.agentConfigurationVersionId).toBe(original.version.agentConfigurationVersionIds[entry.agentId])
    const bindings = RunExecutionBindingsPageSchema.parse(await pairedRead(f, r, RUN_INSPECTION_TOOLS.bindings, { ...exactArgs, limit: 1 }, measurements))
    expect(bindings.items).toHaveLength(1)
    const carry = bindings.items[0]!
    expect(carry.kind).toBe('carry')
    if (carry.kind !== 'carry') throw new Error('Expected a real second-occurrence carry')
    expect(carry.recipientOccurrence?.occurrenceIndex).toBe(2)
    expect(carry.source.execution.occurrence.occurrenceIndex).toBe(1)
    const source = RunExecutionDetailSchema.parse(await pairedRead(f, r, RUN_INSPECTION_TOOLS.execution,
      { ...args, executionId: carry.source.execution.executionId }, measurements))
    expect(source.acceptedResult).toEqual({ status: 'accepted', digest: carry.source.acceptedResultDigest, value: carry.source.acceptedResult })
    await assertActivityPages(f, r, runId)
    expect(f.provider.counts).toEqual(providerCounts)

    // A later V3 Save removes repeat; it cannot rewrite any historical pin or
    // rebrand historical attempts as executions of the new ordinary version.
    const graph = structuredClone(original.version.definition)
    delete graph.repeat
    graph.executionPolicy = { maxParallelism: 1, maxNodeExecutions: graph.nodes.length }
    const revision = (await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [f.f.scope.workflowId])).rows[0]!.revision
    const saved = CurrentWorkflowSaveResultSchema.parse(value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: {
      workspaceId: args.workspaceId, workflowId: f.f.scope.workflowId, executionSemanticsVersion: 3,
      commandId: randomUUID(), expectedRevision: Number(revision), expectedWorkflowVersionId: original.version.id,
      expectedAgentConfigurationVersionIds: original.version.agentConfigurationVersionIds, graph,
    } })))
    expect(saved.value.version.id).not.toBe(original.version.id)
    expect(saved.value.version.definition).not.toHaveProperty('repeat')
    expect(await pairedRead(f, r, RUN_INSPECTION_TOOLS.version, args, measurements)).toEqual(original)
    expect(await pairedRead(f, r, RUN_INSPECTION_TOOLS.execution, exactArgs, measurements)).toEqual(exact)
    const ordinary = await startThroughHttp(f, { task: 'ENG05-D ordinary after repeat' }, locationRevision)
    await terminal(f, ordinary.started.run.id)
    const ordinaryReader = await reader(f, ordinary.started.run.id)
    const ordinaryArgs = { workspaceId: args.workspaceId, runId: ordinary.started.run.id }
    const plain = await pages(f, ordinaryReader, ordinary.started.run.id, measurements)
    expect(plain).toHaveLength(2)
    expect(plain.every((item) => !Object.hasOwn(item, 'occurrence'))).toBe(true)
    expect((await f.db.pool.query('select occurrence_id from run_repeat_occurrences where run_id=$1', [ordinary.started.run.id])).rows).toEqual([])
    await pairedDenial(f, ordinaryReader, RUN_INSPECTION_TOOLS.executions,
      { ...ordinaryArgs, cursor: first.pageInfo.nextCursor! }, 400, 'RUN_INSPECTION_CURSOR_INVALID')
    await pairedDenial(f, ordinaryReader, RUN_INSPECTION_TOOLS.execution,
      { ...ordinaryArgs, executionId: entry.executionId }, 404, 'RUN_EXECUTION_NOT_FOUND')
    await pairedDenial(f, r, RUN_INSPECTION_TOOLS.executions, ordinaryArgs, 403, 'ACCESS_DENIED')
    expect(new Set(f.provider.startedExecutions).size).toBe(f.provider.startedExecutions.length)
    expect(f.dispatchErrors).toEqual([])
    expect(measurements.every((sample) => sample.bytes > 0 && sample.bytes <= RUN_INSPECTION_LIMITS.responseBytes)).toBe(true)
    console.info(`ENG05-D_INSPECTION ${JSON.stringify({ exit, expectedOccurrences, httpRequests: measurements.length,
      mcpCalls: measurements.length, samples: measurements })}`)
  } finally { await f.close() }
}
