import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { parseCoordinationResult } from '@foreman-code/contracts'
import {
  CurrentWorkflowReadResultSchema, CURRENT_WORKFLOW_TOOLS, RepeatGraphSnapshotV3Schema,
  RunStartV3InputSchema, type WorkflowDefinitionV3,
} from '@foreman-code/contracts/wave25'
import { scenarioFixture, type Scenario } from './eng07BScenarios.js'
import { scenarioHarness, type Harness, type Saved, type Started, type Via } from './eng07BHarness.js'
import { assertScenarioEvidence } from './eng07BEvidence.js'

function withoutRepeat(graph: WorkflowDefinitionV3) {
  const { repeat: _repeat, ...ordinary } = graph
  void _repeat
  return { ...ordinary, nodes: ordinary.nodes.map(({ choice: _choice, ...node }) => { void _choice; return node }) }
}
async function historicalVersion(f: Harness, saved: Saved, current: Saved) {
  const input = { workspaceId: saved.version.workspaceId, workflowId: saved.version.workflowId, workflowVersionId: saved.version.id }
  const path = `${f.workflowPath(input.workflowId)}/definition?workflowVersionId=${input.workflowVersionId}`
  const [httpValue, mcpValue] = await Promise.all([
    f.http('GET', path),
    f.mcp(CURRENT_WORKFLOW_TOOLS.saved, input),
  ])
  const http = CurrentWorkflowReadResultSchema.parse(httpValue)
  expect(mcpValue).toEqual(http)
  expect(http.version).toEqual(saved.version)
  expect(http.currentVersionId).toBe(current.currentVersionId)
}

async function settledWithDiagnosis(f: Harness, started: Started) {
  // Poll only the accepted Run's checkpoint; the fixture also has an unlaunched seeded Run.
  const recoveryCodes: string[] = []
  let recoveryInFlight: Promise<void> | undefined
  const recovery = setInterval(() => {
    if (recoveryInFlight) return
    recoveryInFlight = f.base.engine.start(started.scope.runId).catch((error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'UNCLASSIFIED_RECOVERY_ERROR'
      if (code !== 'RUN_ALREADY_OWNED' && recoveryCodes.length < 10) recoveryCodes.push(code)
    }).finally(() => { recoveryInFlight = undefined })
  }, 100)
  recovery.unref()
  try {
    await f.settled(started.scope, 60000)
    expect(recoveryCodes).toEqual([])
  } catch (error) {
    const executions = (await f.base.db.pool.query<{ node_id: string; state: string; result: string | null }>(
      `select workflow_node_id as node_id, record->>'state' as state,
        record#>>'{result,outcome}' as result from harness_executions where run_id=$1 order by id limit 10`,
      [started.scope.runId])).rows
    const resolutions = (await f.base.db.pool.query<{ node_id: string; resolution: string }>(
      `select workflow_node_id as node_id, record#>>'{value,resolution}' as resolution
       from run_repeat_resolutions where run_id=$1 order by workflow_node_id limit 10`,
      [started.scope.runId])).rows
    const codes = f.base.dispatchErrors.map((item) => typeof item === 'string' && /^[A-Z0-9_]+$/.test(item)
      ? item : 'UNCLASSIFIED_DISPATCH_ERROR')
    throw new Error(`Version-pin Run stalled: ${JSON.stringify({ runId: started.scope.runId,
      workflowVersionId: started.scope.workflowVersionId, providerStarts: f.base.provider.counts.starts,
      trace: f.trace.filter((item) => executions.some((execution) => execution.node_id === item.nodeId)),
      executions, resolutions, codes, recoveryCodes })}`, { cause: error })
  } finally {
    clearInterval(recovery)
    await recoveryInFlight
  }
}

/** Invalid execution tags are NEGATIVE payloads, not V1/V2 fixtures/adapters. */
async function invalidMcpTag(f: Harness, name: string, input: Record<string, unknown>) {
  // The SDK may transport a shared-schema rejection as either a tool error or
  // JSON-RPC InvalidParams. Both must explicitly identify the field and literal
  // 3. Arbitrary errors, INTERNAL_ERROR and successful coercion fail this test.
  const response = await f.client.callTool({ name, arguments: input }).then(
    (result) => ({ kind: 'result' as const, result }), (error: unknown) => ({ kind: 'rpc' as const, error }))
  let text: string
  if (response.kind === 'rpc') {
    expect(response.error).toMatchObject({ code: -32602 })
    text = response.error instanceof Error ? response.error.message : JSON.stringify(response.error)
  } else {
    expect(response.result.isError, JSON.stringify(response.result)).toBe(true)
    text = JSON.stringify(response.result)
  }
  expect(text).toContain('executionSemanticsVersion')
  expect(text).toMatch(/\b(?:expected|only|literal)\b[\s\S]*\b3\b/i)
  expect(text).not.toContain('INTERNAL_ERROR')
}
async function rejectedTag(f: Harness, method: string, path: string, tool: string, input: Record<string, unknown>, fieldPath: string[]) {
  const http = await f.rawHttp(method, path, input)
  expect(http.status, JSON.stringify(http.body)).toBe(400)
  expect(http.body).toMatchObject({ error: { code: 'INVALID_REQUEST',
    details: { issues: expect.arrayContaining([expect.objectContaining({ path: fieldPath, message: expect.stringMatching(/3/) })]) } } })
  await invalidMcpTag(f, tool, input)
}

export async function assertHistoricalVersionPins(via: Via) {
  const repeated = scenarioFixture('S3-05-early', randomUUID()), f = await scenarioHarness(repeated)
  // Same IDs/configurations/Run input, different saved definitions. No retagging
  // of versions or Runs, and no overwriting an old accepted result.
  const ordinary: Scenario = { ...repeated, id: 'S3-01', repeat: false, occurrences: 1,
    result: (node, round) => ({ outcome: 'succeeded', output: {
      data: { marker: `ordinary:${node}:${round}`, exact: [0, false, '', 'λ'] },
      summary: 'Completed the assigned work.', board: { kind: 'none', reason: 'no_access' },
    } }) }
  const completed: Array<{ started: Started; initial: ReturnType<typeof RepeatGraphSnapshotV3Schema.parse>; expected: Scenario;
    evidence: Awaited<ReturnType<typeof assertScenarioEvidence>> }> = []
  try {
    let previous: Saved | undefined
    for (const expected of [ordinary, repeated, ordinary]) {
      const raw = expected.repeat ? repeated.source.version.definition : withoutRepeat(repeated.source.version.definition)
      const graph = previous ? { ...raw, id: previous.version.workflowId, version: previous.version.version,
        createdAt: previous.version.definition.createdAt, updatedAt: previous.version.definition.updatedAt } : raw
      const { saved } = await f.save(via, previous, graph)
      for (const index of expected.executedIndexes) {
        expect(() => parseCoordinationResult(expected.result(index, 1).output, {
          resultProtocol: 'f1-f4-v1', definition: saved.version.definition,
          workflowNodeId: expected.nodes[index]!.id,
        })).not.toThrow()
      }
      expect(saved.version.executionSemanticsVersion).toBe(3)
      expect(Object.hasOwn(saved.version.definition, 'repeat')).toBe(expected.repeat)
      if (previous) expect(saved.version.id).not.toBe(previous.version.id)
      f.setOracle(expected.result)
      const release = f.hold(expected.nodes[0]!.id), started = await f.start(via, saved)
      await f.waitUntilParked(started.scope, expected.nodes[0]!.id)
      const initial = RepeatGraphSnapshotV3Schema.parse(await f.graph(started.scope, 'snapshot'))
      release(); await settledWithDiagnosis(f, started)
      const evidence = await assertScenarioEvidence(f, started, initial, expected)
      completed.push({ started, initial, expected, evidence }); previous = saved
    }
    expect(new Set(completed.map((item) => item.started.scope.runId)).size).toBe(3)
    expect(new Set(completed.map((item) => item.started.scope.workflowVersionId)).size).toBe(3)
    expect(new Set(completed.map((item) => item.started.scope.workflowId)).size).toBe(1)
    expect((await f.base.db.pool.query('select id from workflow_versions where workflow_id=$1', [previous!.version.workflowId])).rowCount).toBe(3)
    expect(f.base.provider.counts.starts).toBe(8)
    // A later Save cannot rewrite any previous execution, input, result, graph
    // cursor, receipt or version; compare the complete earlier readback again.
    for (const item of completed) {
      await historicalVersion(f, item.started.saved, previous!)
      expect(await assertScenarioEvidence(f, item.started, item.initial, item.expected)).toEqual(item.evidence)
    }
    expect(f.base.provider.counts.starts).toBe(8)
  } finally { await f.close() }
}

export async function assertRejectedExecutionTag(f: Harness, tag: number) {
  const { saved, input } = await f.save('http')
  const definition = `${f.workflowPath(saved.version.workflowId)}/definition`
  const next = { ...input, commandId: randomUUID(), expectedRevision: saved.revision,
    expectedWorkflowVersionId: saved.version.id, graph: saved.version.definition }
  await rejectedTag(f, 'PUT', definition, CURRENT_WORKFLOW_TOOLS.save,
    { ...next, executionSemanticsVersion: tag }, ['executionSemanticsVersion'])
  await rejectedTag(f, 'PUT', definition, CURRENT_WORKFLOW_TOOLS.save,
    { ...next, commandId: randomUUID(), graph: { ...next.graph, executionSemanticsVersion: tag } }, ['graph', 'executionSemanticsVersion'])
  const start = RunStartV3InputSchema.parse({ workspaceId: saved.version.workspaceId, workflowId: saved.version.workflowId,
    workflowVersionId: saved.version.id, executionSemanticsVersion: 3, commandId: randomUUID(),
    expectedWorkflowRevision: saved.revision, expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
    expectedLocationRevision: f.locationRevision, input: f.scenario.runInput })
  await rejectedTag(f, 'POST', `${f.workflowPath(saved.version.workflowId)}/runs`, 'run_start',
    { ...start, executionSemanticsVersion: tag }, ['executionSemanticsVersion'])
  expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [saved.version.workflowId])).rowCount).toBe(0)
  expect((await f.base.db.pool.query('select id from workflow_versions where workflow_id=$1', [saved.version.workflowId])).rowCount).toBe(1)
  expect(f.base.provider.counts.starts).toBe(0)
  expect(f.base.dispatchErrors).toEqual([])
  await historicalVersion(f, saved, saved)
}
