import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import {
  canonicalGraphJson, reduceRepeatGraphPageV3, RepeatGraphSnapshotV3Schema, RepeatGraphPageV3Schema,
  RepeatGraphCurrentV3Schema, RunRecordDetailSchema, RunExecutionsPageSchema, RunExecutionDetailSchema,
  RunExecutionBindingsPageSchema, RunVersionDetailSchema, WorkflowRunV3Schema, RUN_INSPECTION_TOOLS,
  type RepeatGraphSnapshotV3, type RepeatGraphEventV3, type RunExecutionSummary, type RunExecutionDetail,
  type RunExecutionBinding, type RepeatOccurrenceV1,
} from '@foreman-code/contracts/wave25'
import { runPath, type Harness, type Started } from './eng07BHarness.js'
import type { Scenario } from './eng07BScenarios.js'

export const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalGraphJson(value)).digest('hex')}`
export function identity(value: RunExecutionSummary) {
  if (value.kind === 'job') throw new Error('Agent scenario requires an Agent execution identity')
  return { workflowNodeId: value.workflowNodeId, executionId: value.executionId, agentId: value.agentId,
    agentConfigurationVersionId: value.agentConfigurationVersionId, attempt: value.attempt }
}
const graphIdentity = (value: RunExecutionSummary) => ({ ...identity(value), occurrence: value.occurrence ?? null })
const request = (started: Started) => ({ workspaceId: started.scope.workspaceId, runId: started.scope.runId })

/** Small pages deliberately cross cursor boundaries. No truncation, Set-only
 * equality, sorting away input order, or graph-service shortcut is allowed. */
export async function executions(f: Harness, started: Started) {
  const items: RunExecutionSummary[] = [], cursors = new Set<string>()
  let cursor: string | undefined
  for (let count = 0; count < 20; count++) {
    const args = { ...request(started), limit: 2, ...(cursor ? { cursor } : {}) }
    const query = new URLSearchParams({ limit: '2', ...(cursor ? { cursor } : {}) })
    const page = RunExecutionsPageSchema.parse(await f.readParity(`${runPath(started.scope)}/executions?${query}`,
      RUN_INSPECTION_TOOLS.executions, args))
    expect(page.run).toMatchObject({ ...started.scope, executionState: 'completed', outcome: 'succeeded', cleanupPending: false })
    expect(page.items.length).toBeLessThanOrEqual(2)
    items.push(...page.items)
    const next = page.pageInfo.nextCursor
    if (next === null) {
      expect(new Set(items.map((item) => item.executionId)).size).toBe(items.length)
      return items
    }
    expect(page.items).toHaveLength(2)
    expect(cursors.has(next), 'A repeated history cursor would loop forever').toBe(false)
    cursors.add(next); cursor = next
  }
  throw new Error('ENG07 execution history exceeded its fixture bound')
}
async function bindings(f: Harness, started: Started, detail: RunExecutionDetail) {
  const items: RunExecutionBinding[] = [], cursors = new Set<string>()
  let cursor: string | undefined
  for (let count = 0; count < 20; count++) {
    const args = { ...request(started), executionId: detail.execution.executionId, limit: 1, ...(cursor ? { cursor } : {}) }
    const query = new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) })
    const page = RunExecutionBindingsPageSchema.parse(await f.readParity(
      `${runPath(started.scope)}/executions/${detail.execution.executionId}/bindings?${query}`,
      RUN_INSPECTION_TOOLS.bindings, args))
    expect(page.scope).toEqual(started.scope)
    expect(page.executionId).toBe(detail.execution.executionId)
    expect(page.inputDigest).toBe(detail.acceptedInput.digest)
    items.push(...page.items)
    if (page.pageInfo.nextCursor === null) return items
    expect(page.items).toHaveLength(1)
    expect(cursors.has(page.pageInfo.nextCursor)).toBe(false)
    cursors.add(page.pageInfo.nextCursor); cursor = page.pageInfo.nextCursor
  }
  throw new Error('ENG07 binding history exceeded its fixture bound')
}

export async function assertScenarioEvidence(f: Harness, started: Started, initial: RepeatGraphSnapshotV3,
  expected: Scenario = f.scenario) {
  const scope = started.scope, version = started.saved.version
  const record = RunRecordDetailSchema.parse(await f.readParity(`${runPath(scope)}/record`, RUN_INSPECTION_TOOLS.record, request(started)))
  expect(record).toMatchObject({ run: { id: scope.runId, workflowVersionId: version.id, executionSemanticsVersion: 3,
    agentConfigurationVersionIds: version.agentConfigurationVersionIds, input: expected.runInput,
    executionState: 'completed', outcome: 'succeeded' }, stopRequested: false, cleanupPending: false })
  const durableRun = WorkflowRunV3Schema.parse((await f.base.db.pool.query<{ record: unknown }>(
    'select record from runs where id=$1', [scope.runId])).rows[0]!.record)
  delete durableRun.authorizationPrincipalId
  expect(record.run).toEqual(durableRun)
  expect(record.run).not.toHaveProperty('authorizationPrincipalId')
  expect(record.run.executionLocation).toEqual(started.accepted.run.executionLocation)
  expect(RunVersionDetailSchema.parse(await f.readParity(`${runPath(scope)}/version`, RUN_INSPECTION_TOOLS.version, request(started))))
    .toEqual({ scope, version })
  const events: RepeatGraphEventV3[] = []
  let replayed = initial, pages = 0
  for (;;) {
    if (++pages > 100) throw new Error('ENG07 graph replay exceeded its bounded fixture')
    const page = RepeatGraphPageV3Schema.parse(await f.graph(scope, 'events', replayed.asOfSequence))
    expect(page.baseSequence).toBe(replayed.asOfSequence)
    events.push(...page.batches.flatMap((batch) => batch.events))
    replayed = reduceRepeatGraphPageV3(replayed, page)
    if (!page.hasMore) break
  }
  const snapshot = RepeatGraphSnapshotV3Schema.parse(await f.graph(scope, 'snapshot'))
  expect(replayed).toEqual(snapshot) // COMPLETE consumer; never filter facts.
  expect(BigInt(snapshot.asOfSequence)).toBeGreaterThan(BigInt(initial.asOfSequence))
  const empty = RepeatGraphPageV3Schema.parse(await f.graph(scope, 'events', snapshot.asOfSequence))
  expect(empty.batches).toEqual([]); expect(empty.hasMore).toBe(false)
  const current = RepeatGraphCurrentV3Schema.parse(await f.graph(scope, 'current'))
  expect(current.scope).toEqual(scope); expect(current.topology).toEqual(snapshot.topology)
  expect(current.state.run).toEqual(snapshot.state.run)
  expect(current.asOfSequence).toBe(snapshot.asOfSequence)
  expect(snapshot.state.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded',
    cleanupPending: false, stopRequested: false, pendingInteractionCount: 0, unsettledReviewCount: 0 })

  const summaries = await executions(f, started), details: RunExecutionDetail[] = []
  expect(summaries).toHaveLength(expected.executedIndexes.length * expected.occurrences)
  for (const summary of summaries) {
    const detail = RunExecutionDetailSchema.parse(await f.readParity(`${runPath(scope)}/executions/${summary.executionId}`,
      RUN_INSPECTION_TOOLS.execution, { ...request(started), executionId: summary.executionId }))
    expect(detail.execution).toEqual(summary)
    expect(detail.execution).toMatchObject({ state: 'completed', attempt: 1, acceptedResultAvailable: true })
    details.push(detail)
  }
  const at = (node: number, occurrence = 1) => {
    const matches = details.filter((item) => item.execution.workflowNodeId === expected.nodes[node]!.id
      && (item.execution.occurrence?.occurrenceIndex ?? 1) === occurrence)
    expect(matches, `Exactly one accepted execution for node ${node}, occurrence ${occurrence}`).toHaveLength(1)
    return matches[0]!
  }
  const occurrences = snapshot.state.occurrences
  const decisions = snapshot.state.decisions
  expect(occurrences).toHaveLength(expected.repeat ? expected.occurrences : 0)
  expect(decisions).toHaveLength(expected.repeat ? expected.occurrences : 0)
  const occurrenceAt = (index: number): RepeatOccurrenceV1 => {
    const matches = occurrences.filter((item) => item.identity.occurrenceIndex === index)
    expect(matches).toHaveLength(1)
    return matches[0]!
  }
  const expectedGraphBindings = []
  for (let round = 1; round <= expected.occurrences; round++) {
    const occurrence = expected.repeat ? occurrenceAt(round) : null
    for (const node of expected.executedIndexes) {
      const detail = at(node, round), result = expected.result(node, round)
      if (detail.execution.kind === 'job') throw new Error('Agent scenario requires an Agent execution')
      if (round > 1) {
        expect(detail.execution.continuedFromExecutionId).toBe(at(node, round - 1).execution.executionId)
      } else {
        expect(detail.execution).not.toHaveProperty('continuedFromExecutionId')
      }
      expect(detail.execution.agentId).toBe(expected.nodes[node]!.agentId)
      expect(detail.execution.agentConfigurationVersionId).toBe(version.agentConfigurationVersionIds[detail.execution.agentId])
      expect(detail.reportedResult).toEqual(result)
      expect(detail.acceptedResult).toEqual({ status: 'accepted', digest: digest(result), value: result })
      const predecessors = expected.edges.filter((edge) => edge.target === expected.nodes[node]!.id
        && expected.executedIndexes.some((index) => expected.nodes[index]!.id === edge.source))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((edge) => {
          const from = expected.nodes.findIndex((item) => item.id === edge.source), source = at(from, round)
          const acceptedResult = expected.result(from, round)
          return { relationshipId: edge.id, execution: identity(source.execution), occurrence: occurrence?.identity ?? null,
            acceptedResult, acceptedResultDigest: digest(acceptedResult) }
        })
      const previous = expected.repeat && round > 1 ? at(1, round - 1) : undefined
      const decision = previous ? decisions.find((item) => item.exitExecution.executionId === previous.execution.executionId) : undefined
      if (previous) expect(decision).toBeDefined()
      const carry = previous ? { decisionId: decision!.decisionId,
        execution: { ...identity(previous.execution), occurrence: previous.execution.occurrence! },
        acceptedResult: expected.result(1, round - 1), acceptedResultDigest: digest(expected.result(1, round - 1)) } : null
      const entry = expected.repeat && node === 0 ? { runInput: expected.runInput, external: [], carry } : null
      const input = { executionSemanticsVersion: 3, runInput: expected.runInput, occurrence, entry, predecessors }
      expect(detail.acceptedInput).toEqual({ digest: digest(input), value: input })
      const nativeRequests = [...f.requests.values()].filter((request) => request.executionId === detail.execution.executionId)
      expect(nativeRequests).toHaveLength(1)
      expect(nativeRequests[0]).toMatchObject({ runId: scope.runId, workflowNodeId: detail.execution.workflowNodeId })
      expect(nativeRequests[0]!.input).toEqual(input)
      if (occurrence) {
        expect(detail.execution.occurrence).toEqual(occurrence.identity)
        expect(occurrence.identity).toMatchObject({ scope, blockId: 'repair', occurrenceIndex: round })
        if (node === 0) {
          expect(occurrence.input.inputDigest).toBe(digest(entry))
          expect(occurrence.input.previous).toEqual(previous ? { occurrenceId: previous.execution.occurrence!.occurrenceId,
            occurrenceIndex: round - 1, decisionId: decision!.decisionId, acceptedResultDigest: carry!.acceptedResultDigest } : null)
        }
      } else expect(detail.execution).not.toHaveProperty('occurrence')
      const actualBindings = await bindings(f, started, detail)
      const sources: Array<{ kind: RunExecutionBinding['kind']; source: RunExecutionBinding['source'] }> =
        predecessors.map((source) => ({ kind: 'predecessor', source }))
      if (entry?.carry) sources.push({ kind: 'carry', source: entry.carry })
      expect(actualBindings).toEqual(sources.map(({ kind, source }, ordinal) => ({
        bindingId: `repeat-binding-${digest([detail.execution.executionId, kind, ordinal]).slice(7)}`,
        kind, source, ordinal, recipient: identity(detail.execution), recipientOccurrence: occurrence?.identity ?? null,
        inputDigest: detail.acceptedInput.digest,
      })))
      for (const binding of actualBindings) expectedGraphBindings.push({ bindingId: binding.bindingId,
        recipient: graphIdentity(detail.execution), sender: { ...binding.source.execution,
          occurrence: 'occurrence' in binding.source ? binding.source.occurrence : binding.source.execution.occurrence },
        acceptedResultDigest: binding.source.acceptedResultDigest, inputDigest: binding.inputDigest,
        ordinal: binding.ordinal, kind: binding.kind,
        relationshipId: 'relationshipId' in binding.source ? binding.source.relationshipId : null,
        decisionId: 'decisionId' in binding.source ? binding.source.decisionId : null })
    }
  }
  // Map equality checks identities and cardinality; input arrays above preserve order.
  expect(Object.fromEntries(snapshot.state.executions.map((item) => [item.identity.executionId, item])))
    .toEqual(Object.fromEntries(details.map((detail) => [detail.execution.executionId, {
      identity: graphIdentity(detail.execution), inputDigest: detail.acceptedInput.digest,
      ...(detail.execution.continuedFromExecutionId
        ? { continuedFromExecutionId: detail.execution.continuedFromExecutionId } : {}),
      previousExecutionId: null, state: 'completed', resultOutcome: 'succeeded',
    }])))
  expect(snapshot.state.executions).toHaveLength(details.length)
  expect(snapshot.state.results).toHaveLength(details.length)
  expect(Object.fromEntries(snapshot.state.results.map((item) => [item.execution.executionId, item])))
    .toEqual(Object.fromEntries(details.map((detail) => [detail.execution.executionId, {
      execution: graphIdentity(detail.execution), resultDigest: digest(detail.reportedResult),
    }])))
  expect(snapshot.state.bindings).toHaveLength(expectedGraphBindings.length)
  expect(Object.fromEntries(snapshot.state.bindings.map((item) => [item.bindingId, item])))
    .toEqual(Object.fromEntries(expectedGraphBindings.map((item) => [item.bindingId, item])))

  if (expected.repeat) {
    for (let round = 1; round <= expected.occurrences; round++) {
      const exit = at(1, round), final = round === expected.occurrences
      const found = decisions.filter((item) => item.occurrence.identity.occurrenceIndex === round)
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({ occurrence: occurrenceAt(round), exitExecution: graphIdentity(exit.execution),
        acceptedResultDigest: digest(expected.result(1, round)), outcome: final && expected.id === 'S3-05-early' ? 'pass' : 'issues',
        reason: final ? expected.id === 'S3-05-early' ? 'early_exit' : 'limit_exit' : 'repeat',
        target: final ? { kind: 'branch_end' } : { kind: 'next_occurrence', entryNodeId: expected.nodes[0]!.id, occurrenceIndex: round + 1 } })
    }
    expect(version.definition.repeat!.blocks[0]!.maxOccurrences).toBe(3)
  } else {
    expect(version.definition).not.toHaveProperty('repeat')
    expect(snapshot.topology).not.toHaveProperty('repeat')
  }
  const sqlOccurrences = (await f.base.db.pool.query<{ record: unknown }>(
    'select record from run_repeat_occurrences where run_id=$1 order by occurrence_index', [scope.runId])).rows
  expect(sqlOccurrences.map((row) => row.record)).toEqual([...occurrences].sort((a, b) => a.identity.occurrenceIndex - b.identity.occurrenceIndex))
  const sqlDecisions = (await f.base.db.pool.query<{ record: unknown }>(`select d.record - 'resultData' as record
    from run_repeat_decisions d join run_repeat_occurrences o on o.occurrence_id=d.occurrence_id
    where o.run_id=$1 order by o.occurrence_index`, [scope.runId])).rows
  expect(sqlDecisions.map((row) => row.record)).toEqual([...decisions].sort((a, b) => a.occurrence.identity.occurrenceIndex - b.occurrence.identity.occurrenceIndex))
  const stored = (await f.base.db.pool.query<{ record: unknown; input_json: string; result_json: string }>(`select e.record,s.input_json,r.result_json
    from harness_executions e join run_repeat_executions x on x.execution_id=e.id
    join run_repeat_slots s on s.slot_id=x.slot_id left join run_repeat_results r on r.execution_id=e.id
    where e.run_id=$1`, [scope.runId])).rows
  expect(stored).toHaveLength(details.length)
  for (const row of stored) {
    const execution = HarnessExecutionSchema.parse(row.record), detail = details.find((item) => item.execution.executionId === execution.id)!
    expect(execution.result).toEqual(detail.reportedResult)
    expect(JSON.parse(row.input_json)).toEqual(detail.acceptedInput.value)
    expect(detail.acceptedResult).toMatchObject({ status: 'accepted', value: JSON.parse(row.result_json) })
  }
  const publicText = JSON.stringify({ snapshot, replayed, current })
  for (const secret of [expected.runInput.instruction, f.base.db.directory, f.base.writer.token,
    ...details.map((detail) => `native-${detail.execution.executionId}`)]) expect(publicText).not.toContain(secret)
  return { record, snapshot, details, events }
}
