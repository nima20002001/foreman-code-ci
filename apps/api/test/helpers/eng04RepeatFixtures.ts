import type pg from 'pg'
import { HarnessExecutionSchema, NativeSessionReferenceSchema, type HarnessExecution, type NativeSessionReference } from '@foreman-code/contracts'
import {
  RepeatWorkflowVersionV1Schema,
  canonicalGraphJson,
  makeCurrentWorkflowFixture,
  parseRepeatExitResultV1,
  type RepeatDecisionV1,
  type RepeatOccurrenceV1,
  type RepeatWorkflowVersionV1,
} from '@foreman-code/contracts/wave25'

import { ExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { DomainError } from '../../src/modules/errors.js'
import {
  RepeatRunRepository,
  type RepeatEffect,
  type RepeatFact,
  type RepeatRepositoryHost,
  type RepeatRuntimeRun,
} from '../../src/modules/runs/repeatPostgres.js'
import {
  decideRepeatExit,
  freezeRepeatEntry,
  makeRepeatOccurrence,
  repeatDigest,
  type RepeatResolution,
  type RepeatScope,
} from '../../src/modules/runs/repeatResolution.js'
import { repeatTerminalResolution } from '../../src/modules/runs/repeatNode.js'

export const ENG04_REPEAT_AT = '2026-09-25T02:21:00.000Z'

const edge = (id: string, source: string, target: string) => ({ id, kind: 'execution' as const, source, target })

export interface RepeatFixture {
  version: RepeatWorkflowVersionV1
  scope: RepeatScope
  run: RepeatRuntimeRun
  block: NonNullable<RepeatWorkflowVersionV1['definition']['repeat']>['blocks'][number]
}

function configuredFixture(input: {
  suffix: string
  cap: number
  names: string[]
  entryNodeId: string
  nodes: RepeatWorkflowVersionV1['definition']['nodes']
  edges: RepeatWorkflowVersionV1['definition']['edges']
  blockNodeIds: string[]
  blockEntry: string
  blockExit: string
  runId?: string
}): RepeatFixture {
  const base = makeCurrentWorkflowFixture(input.suffix)
  const pins = Object.fromEntries(input.names.map((id) => [`agent-${id}`, `config-${id}`]))
  const version = RepeatWorkflowVersionV1Schema.parse({
    ...base.version,
    executionSemanticsVersion: 3,
    entryNodeId: input.entryNodeId,
    agentConfigurationVersionIds: pins,
    definition: {
      ...base.version.definition,
      executionSemanticsVersion: 3,
      entryNodeId: input.entryNodeId,
      executionPolicy: {
        maxParallelism: 4,
        maxNodeExecutions: input.names.length + Math.max(0, input.cap - 1) * input.blockNodeIds.length,
      },
      nodes: input.nodes,
      edges: input.edges,
      repeat: {
        contractVersion: 1,
        blocks: [{
          id: 'review-fix',
          nodeIds: input.blockNodeIds,
          entryNodeId: input.blockEntry,
          exitNodeId: input.blockExit,
          maxOccurrences: input.cap,
          repeatOutcome: 'issues',
          earlyExitOutcome: 'pass',
          limitExit: { kind: 'edge', relationshipId: 'review-limit' },
        }],
      },
    },
  })
  const runId = input.runId ?? base.scope.runId
  const scope: RepeatScope = {
    ...base.scope,
    runId,
    workflowVersionId: version.id,
    workspaceId: version.workspaceId,
    workflowId: version.workflowId,
    executionSemanticsVersion: 3,
  }
  const run: RepeatRuntimeRun = {
    ...base.run,
    id: runId,
    workspaceId: version.workspaceId,
    workflowId: version.workflowId,
    workflowVersionId: version.id,
    executionState: 'running',
    executionSemanticsVersion: 3,
    agentConfigurationVersionIds: version.agentConfigurationVersionIds,
    approval: version.approval,
  }
  return { version, scope, run, block: version.definition.repeat!.blocks[0]! }
}

export function makeSimpleRepeatFixture(cap = 3, options: { suffix?: string; runId?: string; sibling?: boolean } = {}): RepeatFixture {
  const sibling = options.sibling ?? false
  const names = sibling ? ['root', 'work', 'review', 'sibling', 'done', 'limit'] : ['work', 'review', 'done', 'limit']
  const nodes = names.map((id) => ({
    id,
    agentId: `agent-${id}`,
    name: id,
    ...(id === 'review' ? {
      choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'edge' as const, relationshipId: 'review-done' } },
        { outcome: 'issues', target: { kind: 'edge' as const, relationshipId: 'review-limit' } },
      ] },
    } : {}),
  }))
  const edges = [
    ...(sibling ? [edge('root-work', 'root', 'work'), edge('root-sibling', 'root', 'sibling')] : []),
    edge('work-review', 'work', 'review'),
    edge('review-done', 'review', 'done'),
    edge('review-limit', 'review', 'limit'),
  ]
  return configuredFixture({
    suffix: options.suffix ?? (sibling ? 'eng04-d-sibling' : 'eng04-d-simple'),
    cap,
    names,
    entryNodeId: sibling ? 'root' : 'work',
    nodes,
    edges,
    blockNodeIds: ['work', 'review'],
    blockEntry: 'work',
    blockExit: 'review',
    ...(options.runId ? { runId: options.runId } : {}),
  })
}

export function makeJoinRepeatFixture(cap = 2, suffix = 'eng04-d-joins'): RepeatFixture {
  const names = ['start', 'fast', 'choose', 'deep1', 'deep2', 'unused', 'join', 'review', 'done', 'limit']
  const nodes = names.map((id) => ({
    id,
    agentId: `agent-${id}`,
    name: id,
    ...(id === 'choose' ? {
      choice: { outcomes: [
        { outcome: 'deep', target: { kind: 'edge' as const, relationshipId: 'choose-deep1' } },
        { outcome: 'unused', target: { kind: 'edge' as const, relationshipId: 'choose-unused' } },
      ] },
    } : {}),
    ...(id === 'review' ? {
      choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'edge' as const, relationshipId: 'review-done' } },
        { outcome: 'issues', target: { kind: 'edge' as const, relationshipId: 'review-limit' } },
      ] },
    } : {}),
  }))
  const edges = [
    edge('start-fast', 'start', 'fast'),
    edge('start-choose', 'start', 'choose'),
    edge('choose-deep1', 'choose', 'deep1'),
    edge('choose-unused', 'choose', 'unused'),
    edge('deep1-deep2', 'deep1', 'deep2'),
    edge('deep2-join', 'deep2', 'join'),
    edge('fast-join', 'fast', 'join'),
    edge('unused-join', 'unused', 'join'),
    edge('join-review', 'join', 'review'),
    edge('review-done', 'review', 'done'),
    edge('review-limit', 'review', 'limit'),
  ]
  const body = ['start', 'fast', 'choose', 'deep1', 'deep2', 'unused', 'join', 'review']
  return configuredFixture({
    suffix,
    cap,
    names,
    entryNodeId: 'start',
    nodes,
    edges,
    blockNodeIds: body,
    blockEntry: 'start',
    blockExit: 'review',
  })
}

export function executionFor(fixture: RepeatFixture, nodeId: string, id: string, attempt = 1): HarnessExecution {
  return HarnessExecutionSchema.parse({
    id,
    runId: fixture.scope.runId,
    workflowNodeId: nodeId,
    agentId: `agent-${nodeId}`,
    agentConfigurationVersionId: `config-${nodeId}`,
    attempt,
    state: 'queued',
    input: {},
    createdAt: ENG04_REPEAT_AT,
  })
}

export function successfulExecution(value: HarnessExecution, output: unknown = {}): HarnessExecution {
  return HarnessExecutionSchema.parse({
    ...value,
    state: 'completed',
    finishedAt: ENG04_REPEAT_AT,
    result: { outcome: 'succeeded', output },
  })
}

export function retryableFailure(value: HarnessExecution, code = 'PROVIDER_TRANSIENT'): HarnessExecution {
  return HarnessExecutionSchema.parse({
    ...value,
    state: 'completed',
    finishedAt: ENG04_REPEAT_AT,
    result: { outcome: 'failed', error: { code, message: 'provider-shaped transient failure', retryable: true } },
  })
}

export function firstOccurrence(fixture: RepeatFixture) {
  return makeRepeatOccurrence(fixture.scope, fixture.block, freezeRepeatEntry({ request: fixture.scope.runId }, []), null)
}

export function repeatExitOutput(index: number, outcome: 'issues' | 'pass' = 'issues') {
  return {
    routing: { outcome },
    data: {
      latestDeliverable: { occurrence: index, artifactDigest: `sha256:${String(index).padStart(64, '0')}` },
      remainingFindings: outcome === 'pass' ? [] : [{ id: `finding-${index}`, text: `remaining-${index}` }],
    },
  }
}

export function exitDecision(fixture: RepeatFixture, occurrence: RepeatOccurrenceV1, outcome: 'issues' | 'pass' = 'issues', executionId?: string) {
  const completed = successfulExecution(
    executionFor(fixture, 'review', executionId ?? `review-${occurrence.identity.occurrenceIndex}`),
    repeatExitOutput(occurrence.identity.occurrenceIndex, outcome),
  )
  const choice = fixture.version.definition.nodes.find((node) => node.id === 'review')!.choice!
  const envelope = parseRepeatExitResultV1(completed.result, choice)
  const decision = decideRepeatExit(fixture.version, occurrence, completed, envelope, ENG04_REPEAT_AT)
  return { completed, decision }
}

export function resolutionFor(
  fixture: RepeatFixture,
  occurrence: RepeatOccurrenceV1,
  nodeId: string,
  output: unknown = {},
  executionId = `${nodeId}-${occurrence.identity.occurrenceIndex}`,
): RepeatResolution {
  return repeatTerminalResolution(
    fixture.version,
    fixture.scope,
    { nodeId, occurrence: occurrence.identity },
    successfulExecution(executionFor(fixture, nodeId, executionId), output),
  )
}

interface HarnessExecutionRow {
  execution_id: string
  record: HarnessExecution
  accepted: boolean
  slot_id: string
  identity: unknown
  previous: string | null
  execution_run_id: string
  execution_node_id: string
  execution_agent_id: string
  execution_attempt: number
  execution_occurrence_id: string | null
  identity_occurrence_id: string | null
  technical_attempt: number
}

interface HarnessNativeSessionRow {
  reference: NativeSessionReference
  finalized: boolean
}

interface HarnessNativeClosureRow {
  generation: string
  execution_identity: Record<string, unknown>
  expected_reference: NativeSessionReference
  closed_reference: NativeSessionReference
  closed: boolean
  prior_unclosed: boolean
}

export interface RepeatHarnessPublication {
  sequence: string
  effect: RepeatEffect
  facts: RepeatFact[]
}

export interface RepeatHarnessState {
  run: RepeatRuntimeRun
  stopped: boolean
  occurrences: Map<string, { record: RepeatOccurrenceV1; input_json: string; input_digest: string }>
  slots: Map<string, { slot_id: string; occurrence_id: string | null; workflow_node_id: string; input_json: string; input_digest: string }>
  executions: Map<string, HarnessExecutionRow>
  nativeReservations: Map<string, { runId: string; reservation: unknown; digest: string }>
  nativeSessions: Map<string, HarnessNativeSessionRow>
  nativeClosures: Map<string, HarnessNativeClosureRow>
  resolutions: Map<string, RepeatResolution>
  bindings: Array<{ recipient: string; record: unknown }>
  results: Map<string, { result_json: string; result_digest: string }>
  decisions: Map<string, RepeatDecisionV1>
  effects: Map<string, string>
  receipts: Map<string, string>
  publications: RepeatHarnessPublication[]
}

export interface RepeatHarness {
  fixture: RepeatFixture
  store: RepeatRunRepository
  repository(): RepeatRunRepository
  connection: ExclusiveGraphConnection
  renewConnection(): void
  owner: {
    runId: string
    assertOwned(): void
    oneShotConnection(): ExclusiveGraphConnection
    readOneShotFence(): Promise<{ ownerId: string; fence: string }>
  }
  state(): RepeatHarnessState
  events: string[]
  enter(): Promise<RepeatOccurrenceV1>
  admit(occurrence: RepeatOccurrenceV1 | null, nodeId: string, executionId?: string): Promise<HarnessExecution>
  finish(executionId: string, output?: unknown): HarnessExecution
  failExecution(executionId: string, code?: string): HarnessExecution
  accept(executionId: string): ReturnType<RepeatRunRepository['acceptTerminal']>
  runBody(occurrence: RepeatOccurrenceV1, outcome?: 'issues' | 'pass'): Promise<string>
  setStopped(value?: boolean): void
  blockSettlement(code?: 'APPROVAL_SETTLEMENT_PENDING' | 'REPEAT_CLEANUP_PENDING' | 'REPEAT_BOUNDARY_PENDING' | null, executionId?: string): void
  allowTechnicalRetry(value: boolean): void
  failGate(name: string): void
  loseCommit(): void
  snapshotPublications(): RepeatHarnessPublication[]
  deltasAfter(sequence: string): RepeatHarnessPublication[]
}

/**
 * One D-owned adapter seam. It exercises the real RepeatRunRepository and real
 * ExclusiveGraphConnection while keeping only SQL, publication, settlement and
 * owner hooks deterministic. Unsupported SQL fails immediately. This is not a
 * PostgreSQL/native/security substitute; eng04-repeat-postgres.test.ts and the
 * real-app scenario plan cover those boundaries separately.
 */
export function createRepeatHarness(fixture = makeSimpleRepeatFixture()): RepeatHarness {
  const events: string[] = []
  let state: RepeatHarnessState = {
    run: structuredClone(fixture.run),
    stopped: false,
    occurrences: new Map(),
    slots: new Map(),
    executions: new Map(),
    nativeReservations: new Map(),
    nativeSessions: new Map(),
    nativeClosures: new Map(),
    resolutions: new Map(),
    bindings: [],
    results: new Map(),
    decisions: new Map(),
    effects: new Map(),
    receipts: new Map(),
    publications: [],
  }
  let saved: RepeatHarnessState | undefined
  let fault = ''
  let lostCommit = false
  let fence = 0
  let settlementCode: 'APPROVAL_SETTLEMENT_PENDING' | 'REPEAT_CLEANUP_PENDING' | 'REPEAT_BOUNDARY_PENDING' | null = null
  let settlementExecutionId: string | undefined
  let technicalRetry = true
  const effectKey = (kind: unknown, id: unknown) => `${kind}:${id}`
  const closureExecutionIdentity = (execution: HarnessExecution): Record<string, unknown> => ({
    id: execution.id,
    runId: execution.runId,
    workflowNodeId: execution.workflowNodeId,
    agentId: execution.agentId,
    agentConfigurationVersionId: execution.agentConfigurationVersionId,
    attempt: execution.attempt,
    ...(execution.workingDirectory ? { workingDirectory: execution.workingDirectory } : {}),
    ...(execution.runtimeDirectory ? { runtimeDirectory: execution.runtimeDirectory } : {}),
  })
  const providerSession = (executionId: string): NativeSessionReference => NativeSessionReferenceSchema.parse({
    harness: 'codex',
    providerVersion: 'eng04-d-provider-shaped-current',
    nativeSessionId: `native-session-${executionId}`,
  })
  const recordProviderSettlementEvidence = (executionId: string, terminal: HarnessExecution): HarnessExecution => {
    const session = providerSession(executionId)
    const execution = HarnessExecutionSchema.parse({ ...terminal, nativeSessionId: session.nativeSessionId })
    state.nativeSessions.set(executionId, { reference: session, finalized: false })
    state.nativeClosures.set(executionId, {
      generation: '1',
      execution_identity: closureExecutionIdentity(execution),
      expected_reference: session,
      closed_reference: session,
      closed: true,
      prior_unclosed: false,
    })
    return execution
  }

  const client = {
    query: async (text: string, values: unknown[] = []) => {
      const q = text.replace(/\s+/g, ' ').trim().toLowerCase()
      const v = values as Array<string | null>
      events.push(q)
      let rows: unknown[] = []
      if (q.startsWith('begin ')) saved = structuredClone(state)
      else if (q === 'commit') {
        saved = undefined
        if (lostCommit) { lostCommit = false; throw new Error('COMMIT reply lost') }
      } else if (q === 'rollback') {
        if (saved) state = saved
        saved = undefined
      } else if (q.includes('from runs r join workflow_versions')) {
        rows = [{ run: state.run, version: fixture.version, stopped: state.stopped, state: state.run.executionState, now: ENG04_REPEAT_AT }]
      } else if (q.startsWith('select ( (select count(*) from harness_executions')) {
        rows = [{ total: String([...state.executions.values()]
          .filter((item) => item.execution_run_id === v[0]).length) }]
      } else if (q.startsWith('select record,input_json,input_digest')) {
        const row = state.occurrences.get(v[0]!)
        if (row) rows = [row]
      } else if (q.startsWith('select occurrence_id from run_repeat_occurrences')) {
        const list = [...state.occurrences.values()]
          .filter((item) => item.record.identity.blockId === v[1]
            && (values.length < 3 || item.record.identity.occurrenceIndex === values[2]))
          .sort((a, b) => b.record.identity.occurrenceIndex - a.record.identity.occurrenceIndex)
        rows = list.slice(0, 1).map((item) => ({ occurrence_id: item.record.identity.occurrenceId }))
      } else if (q.startsWith('select record from run_repeat_resolutions')) {
        rows = [...state.resolutions.entries()].filter(([key]) => key.startsWith(`${v[1]}:`)).map(([, record]) => ({ record }))
      } else if (q.startsWith('select payload_digest')) {
        const payload_digest = state.effects.get(effectKey(v[1], v[2]))
        if (payload_digest) rows = [{ payload_digest }]
      } else if (q.startsWith('insert into run_repeat_occurrences')) {
        state.occurrences.set(v[0]!, { record: JSON.parse(v[14]!) as RepeatOccurrenceV1, input_json: v[8]!, input_digest: v[9]! })
      } else if (q.startsWith('insert into run_repeat_effects')) {
        state.effects.set(effectKey(v[1], v[2]), v[3]!)
      } else if (q.startsWith('insert into run_repeat_slots')) {
        state.slots.set(v[0]!, { slot_id: v[0]!, occurrence_id: v[2] ?? null, workflow_node_id: v[3]!, input_json: v[4]!, input_digest: v[5]! })
      } else if (q.startsWith('insert into harness_executions')) {
        state.executions.set(v[0]!, {
          execution_id: v[0]!,
          record: JSON.parse(v[6]!) as HarnessExecution,
          accepted: false,
          slot_id: '',
          identity: {},
          previous: null,
          execution_run_id: v[1]!,
          execution_node_id: v[2]!,
          execution_agent_id: v[3]!,
          execution_attempt: Number(v[4]),
          execution_occurrence_id: v[5] ?? null,
          identity_occurrence_id: null,
          technical_attempt: 0,
        })
      } else if (q.startsWith('insert into workflow_native_entries')) {
        if (state.nativeReservations.has(v[0]!)) throw new Error('Duplicate native reservation')
        state.nativeReservations.set(v[0]!, { runId: v[1]!, reservation: JSON.parse(v[2]!), digest: v[4]! })
        rows = [{ execution_id: v[0] }]
      } else if (q.startsWith('insert into run_repeat_executions')) {
        const row = state.executions.get(v[0]!)
        if (!row) throw new Error(`Missing execution ${v[0]}`)
        Object.assign(row, {
          slot_id: v[2]!,
          identity_occurrence_id: v[3] ?? null,
          technical_attempt: Number(v[4]),
          previous: v[5] ?? null,
          identity: JSON.parse(v[6]!),
        })
      } else if (q.startsWith('select e.id from harness_executions e')) {
        const after = v[1] ?? ''
        const kind = v[2]
        const selectedId = v[3]
        const throughAttempt = v[4] === null || v[4] === undefined ? null : Number(v[4])
        rows = [...state.executions.values()]
          .filter((item) => item.execution_run_id === v[0] && item.execution_id > after)
          .filter((item) => kind === 'run'
            || kind === 'occurrence' && item.execution_occurrence_id === selectedId
            || kind === 'slot' && item.slot_id === selectedId && item.technical_attempt <= (throughAttempt ?? 0))
          .sort((a, b) => a.execution_id.localeCompare(b.execution_id))
          .slice(0, 100)
          .map((item) => ({ id: item.execution_id }))
      } else if (q.startsWith('select execution_id from run_repeat_executions')) {
        rows = [...state.executions.values()]
          .filter((item) => q.includes('previous_execution_id') ? item.previous === v[0] : item.slot_id === v[0])
          .sort((a, b) => b.record.attempt - a.record.attempt)
          .slice(0, 1)
          .map((item) => ({ execution_id: item.execution_id }))
      } else if (q.startsWith('select x.execution_id from run_repeat_executions x join run_repeat_slots')) {
        rows = [...state.executions.values()]
          .filter((item) => item.execution_run_id === v[0] && item.identity_occurrence_id === v[1]
            && item.technical_attempt === 1 && state.slots.get(item.slot_id)?.workflow_node_id === v[2])
          .map((item) => ({ execution_id: item.execution_id }))
      } else if (q.startsWith('select e.record,e.accepted')) {
        const item = state.executions.get(v[0]!)
        if (item) {
          const slot = state.slots.get(item.slot_id)
          if (!slot) throw new Error(`Missing slot ${item.slot_id}`)
          rows = [{ ...item, ...slot }]
        }
      } else if (q.includes("record->>'executionsemanticsversion' as semantics") && q.includes('from runs where id=$1 for update')) {
        rows = [{
          id: state.run.id,
          semantics: String(state.run.executionSemanticsVersion),
          workspace_id: state.run.workspaceId,
          workflow_id: state.run.workflowId,
          pins_match: true,
          negative_cleanup: false,
        }]
      } else if (q.startsWith('select id,run_id,workflow_node_id,agent_id,attempt,record from harness_executions')) {
        const item = state.executions.get(v[0]!)
        if (item && item.execution_run_id === v[1]) rows = [{
          id: item.execution_id,
          run_id: item.execution_run_id,
          workflow_node_id: item.execution_node_id,
          agent_id: item.execution_agent_id,
          attempt: item.execution_attempt,
          record: item.record,
        }]
      } else if (q.startsWith('select j.id,j.execution_id,j.state,j.record,i.run_id')) {
        rows = []
      } else if (q.includes('as outstanding') && q.includes('worker_credential_bindings')) {
        rows = [{ outstanding: false }]
      } else if (q.startsWith('select reference,workflow_finalized_at is not null as finalized')) {
        const native = state.nativeSessions.get(v[0]!)
        if (native) rows = [native]
      } else if (q.startsWith("select c.record#>>'{harness,harness}' as harness")) {
        const pinned = Object.entries(fixture.version.agentConfigurationVersionIds)
          .find(([, configurationId]) => configurationId === v[0])
        if (pinned && v[1] === fixture.scope.runId) rows = [{
          harness: 'codex',
          agent_id: pinned[0],
          workspace_id: fixture.scope.workspaceId,
          pinned: true,
        }]
      } else if (q.includes('join lateral (select * from execution_native_closures')) {
        const item = state.executions.get(v[0]!)
        const native = state.nativeSessions.get(v[0]!)
        const closure = state.nativeClosures.get(v[0]!)
        if (item && native && closure) rows = [{ ...closure, record: item.record, reference: native.reference }]
      } else if (q.startsWith('update execution_native_sessions set workflow_finalized_at')) {
        const native = state.nativeSessions.get(v[0]!)
        if (native && JSON.stringify(native.reference) === v[1]) {
          native.finalized = true
          rows = [{ execution_id: v[0] }]
        }
      } else if (q.includes('as possible_submission') && q.includes('run_graph_effects')) {
        rows = [{ possible_submission: false }]
      } else if (q.startsWith('select i.id,i.execution_id,i.status,i.record')) {
        rows = []
      } else if (q.startsWith('insert into run_repeat_bindings')) {
        state.bindings.push({ recipient: v[2]!, record: JSON.parse(v[8]!) })
      } else if (q.startsWith('select record from run_repeat_bindings')) {
        rows = state.bindings.filter((binding) => binding.recipient === v[0]).map((binding) => ({ record: binding.record }))
      } else if (q.startsWith('insert into run_repeat_results')) {
        state.results.set(v[0]!, { result_json: v[3]!, result_digest: v[4]! })
      } else if (q.startsWith('select result_json,result_digest')) {
        const row = state.results.get(v[0]!)
        if (row) rows = [row]
      } else if (q.startsWith('update harness_executions set accepted=true')) {
        const row = state.executions.get(v[0]!)
        if (!row) throw new Error(`Missing execution ${v[0]}`)
        row.accepted = true
      } else if (q.startsWith('insert into run_repeat_resolutions')) {
        state.resolutions.set(`${v[1]}:${v[2]}`, JSON.parse(v[5]!) as RepeatResolution)
      } else if (q.startsWith('insert into run_repeat_decisions')) {
        state.decisions.set(v[1]!, JSON.parse(v[4]!) as RepeatDecisionV1)
      } else if (q.startsWith('select record from run_repeat_decisions') || q.startsWith('select 1 from run_repeat_decisions')) {
        const record = state.decisions.get(v[0]!)
        if (record) rows = [{ record }]
      } else if (q.startsWith('select record,reserved_successor_execution_id,delivery_id from run_control_continuations')
        || q.startsWith("select id from run_chat_commands where run_id=$1 and kind='stop'")
        || q.startsWith('with recursive lineage(id) as')) {
        // No workflow control command, continuation or Stop receipt exists in the repeat fixture.
      } else if (/from execution_dispatch_intents where execution_id=\$1/.test(q) || q.startsWith('select record from execution_native_placements where execution_id=$1')) {
        // Main-local executions have no device dispatch intent or native placement.
      } else {
        throw new Error(`Unscripted ENG04-D SQL: ${q}`)
      }
      return { rows, rowCount: rows.length, command: q.split(' ')[0] ?? '', fields: [], oid: 0 }
    },
  }

  const makeConnection = () => new ExclusiveGraphConnection({ query: client.query } as unknown as pg.ClientBase, () => {
    if (fault === 'owner') throw new DomainError('RUN_OWNERSHIP_LOST', 'Synthetic owner lost.', 409)
  })
  let connection = makeConnection()
  const renewConnection = () => {
    if (!connection.unusable) throw new Error('ENG04-D connection renewal requires an unusable prior lease')
    connection = makeConnection()
  }
  const gate = (name: string) => {
    events.push(name)
    if (fault === name) throw new Error(name)
  }
  const host: RepeatRepositoryHost = {
    openLocked: async () => ({
      run: state.run,
      assertAuthorityLocked: async () => { gate('authority') },
      assertAdmissionLocked: async () => { gate('admission') },
      assertSettlementLocked: async (_sql, executionIds) => {
        gate('settlement')
        if (settlementCode && (!settlementExecutionId || executionIds.includes(settlementExecutionId))) {
          throw new DomainError(settlementCode, 'Exact settlement is still pending.', 409)
        }
      },
      allowTechnicalRetryLocked: async () => technicalRetry,
      publishLocked: async (_sql, effect, facts, mutate) => {
        gate('publication.before')
        await mutate()
        gate('publication.after')
        state.receipts.set(effectKey(effect.kind, effect.entityId), effect.digest)
        state.publications.push({ sequence: String(state.publications.length + 1), effect: structuredClone(effect), facts: structuredClone([...facts]) })
      },
      assertPublicationReceiptLocked: async (_sql, effect) => {
        gate('receipt')
        if (state.receipts.get(effectKey(effect.kind, effect.entityId)) !== effect.digest) throw new Error('GRAPH_RECEIPT_MISMATCH')
      },
      completeRunLocked: async () => {
        gate('complete')
        state.run.executionState = 'completed'
      },
    }),
  }
  const owner = {
    runId: fixture.scope.runId,
    assertOwned: () => {
      if (fault === 'owner') throw new DomainError('RUN_OWNERSHIP_LOST', 'Synthetic owner lost.', 409)
    },
    oneShotConnection: () => connection,
    readOneShotFence: async () => ({ ownerId: 'eng04-d-owner', fence: String(fault === 'generation' ? ++fence : 1) }),
  }
  const repository = () => new RepeatRunRepository(owner, host, fixture.version)
  const store = repository()

  const enter = async () => {
    const result = await store.enterBlock(fixture.block.id)
    if (result.kind !== 'active') throw new Error('Repeat block is inactive')
    return result.occurrence
  }
  const admit = async (occurrence: RepeatOccurrenceV1 | null, nodeId: string, executionId?: string) => {
    const ref = { nodeId, occurrence: occurrence?.identity ?? null }
    const result = await store.admit(ref, () => executionFor(fixture, nodeId, executionId ?? `${nodeId}-${occurrence?.identity.occurrenceIndex ?? 'outside'}`))
    if (result.kind !== 'admitted') throw new Error(`Expected admitted ${nodeId}, received ${result.kind}`)
    return result.execution
  }
  const finish = (executionId: string, output: unknown = {}) => {
    const row = state.executions.get(executionId)
    if (!row) throw new Error(`Missing execution ${executionId}`)
    row.record = recordProviderSettlementEvidence(executionId, successfulExecution(row.record, output))
    return row.record
  }
  const failExecution = (executionId: string, code = 'PROVIDER_TRANSIENT') => {
    const row = state.executions.get(executionId)
    if (!row) throw new Error(`Missing execution ${executionId}`)
    row.record = recordProviderSettlementEvidence(executionId, retryableFailure(row.record, code))
    return row.record
  }
  const accept = (executionId: string) => store.acceptTerminal(executionId, (attempt) => {
    const current = state.executions.get(executionId)
    if (!current) throw new Error(`Missing execution ${executionId}`)
    return executionFor(fixture, current.record.workflowNodeId, `${executionId}-attempt-${attempt}`, attempt)
  })
  const runBody = async (occurrence: RepeatOccurrenceV1, outcome: 'issues' | 'pass' = 'issues') => {
    const work = await admit(occurrence, 'work')
    finish(work.id)
    await accept(work.id)
    const review = await admit(occurrence, 'review')
    finish(review.id, repeatExitOutput(occurrence.identity.occurrenceIndex, outcome))
    await accept(review.id)
    return review.id
  }

  return {
    fixture,
    store,
    repository,
    get connection() { return connection },
    renewConnection,
    owner,
    state: () => state,
    events,
    enter,
    admit,
    finish,
    failExecution,
    accept,
    runBody,
    setStopped: (value = true) => { state.stopped = value },
    blockSettlement: (code = 'APPROVAL_SETTLEMENT_PENDING', executionId) => { settlementCode = code; settlementExecutionId = executionId },
    allowTechnicalRetry: (value) => { technicalRetry = value },
    failGate: (name) => { fault = name },
    loseCommit: () => { lostCommit = true },
    snapshotPublications: () => structuredClone(state.publications),
    deltasAfter: (sequence) => state.publications.filter((item) => BigInt(item.sequence) > BigInt(sequence)).map((item) => structuredClone(item)),
  }
}

export function canonicalDigest(value: unknown): string {
  return repeatDigest(JSON.parse(canonicalGraphJson(value)))
}
