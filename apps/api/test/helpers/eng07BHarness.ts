import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { isWorkflowStart } from '../../src/modules/harnesses/sessionStart.js'
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import type { HarnessExecutionRequest } from '@foreman-code/contracts'
import {
  CANONICAL_RUN_GRAPH_MCP_TOOLS, CANONICAL_RUN_GRAPH_ROUTES, CURRENT_WORKFLOW_TOOLS,
  CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema, RunRecordDetailSchema,
  RunStartV3InputSchema, RunStartV3ResultSchema, SavedManagedWorkflowCommandResultSchema,
  type RepeatGraphScopeV3, type WorkflowDefinitionV3,
} from '@foreman-code/contracts/wave25'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../../src/app.js'
import { OperatorInteractionService } from '../../src/modules/interactions/operator.js'
import { RunGraphReadService } from '../../src/modules/run-graph/readService.js'
import { registerUserInteractions } from '../../src/routes/userInteractions.js'
import { LOCAL_RUNNER_ID } from '../../src/modules/workspaces/location.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import type { Scenario, SuccessfulResult } from './eng07BScenarios.js'
import { waitForSuccessfulRunCleanup } from './runSettlement.testSupport.js'

export type Via = 'http' | 'mcp'
export type Saved = ReturnType<typeof CurrentWorkflowSaveResultSchema.parse>['value']
export type Harness = Awaited<ReturnType<typeof scenarioHarness>>
export type Started = Awaited<ReturnType<Harness['start']>>
export const other = (via: Via): Via => via === 'http' ? 'mcp' : 'http'
export const runPath = (scope: Pick<RepeatGraphScopeV3, 'workspaceId' | 'runId'>) =>
  `/api/management/workspaces/${encodeURIComponent(scope.workspaceId)}/runs/${encodeURIComponent(scope.runId)}`

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
async function waitGate(promise: Promise<void>, signal?: AbortSignal) {
  let abort: (() => void) | undefined
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal?.reason ?? new Error('Provider gate aborted'))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })])
    signal?.throwIfAborted()
  } finally { if (abort) signal?.removeEventListener('abort', abort) }
}
export function toolValue(result: { isError?: boolean | undefined; structuredContent?: unknown;
  content?: readonly { type: string; text?: string | undefined }[] | undefined }) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  expect(decodeMcpToolResult(result), JSON.stringify(result)).toBeDefined()
  return decodeMcpToolResult(result)
}

/** Public socket HTTP + authenticated Streamable HTTP Operator MCP. The existing
 * fixture owns migrations/DB isolation, all production services, the engine,
 * credential issuance, native capture and fences. Test Runs are created only
 * by public run_start/POST .../runs and use the production recovery sweep.
 * Only the external provider port is wrapped for deterministic timing/output. */
export async function scenarioHarness(scenario: Scenario) {
  let oracle: (nodeIndex: number, occurrenceIndex: number) => SuccessfulResult = scenario.result
  const outputs = new Map<string, number>()
  const base = await currentOperatorIntegration({ fixture: scenario.source,
    insertRun: false,
    approvalNodeIds: scenario.approvalNodeIds,
    outputFor(nodeId) {
      const index = scenario.nodes.findIndex((node) => node.id === nodeId)
      const occurrenceIndex = (outputs.get(nodeId) ?? 0) + 1
      outputs.set(nodeId, occurrenceIndex)
      return oracle(index, occurrenceIndex).output
    },
  })
  const gates = new Map<string, ReturnType<typeof latch> & { entered: ReturnType<typeof latch> }>()
  const parked = new Set<string>()
  const requests = new Map<string, HarnessExecutionRequest>()
  const trace: Array<{ nodeId: string; executionId: string; phase: 'started' | 'completed' }> = []
  const connection = base.provider.connection.bind(base.provider)
  const wrapper = vi.spyOn(base.provider, 'connection').mockImplementation(() => {
    const raw = connection()
    let acceptedRequest: HarnessExecutionRequest | undefined
    return { ...raw,
      async createSession(input, signal) {
        if (!isWorkflowStart(input)) throw new Error('ENG07 only supplies workflow-provider sessions')
        const session = await raw.createSession(input, signal)
        acceptedRequest = structuredClone(input.request)
        requests.set(acceptedRequest.executionId, acceptedRequest)
        return session
      },
      async *startTurn(session, input, signal) {
        const request = acceptedRequest
        if (!request) throw new Error('Missing exact provider request')
        for await (const event of raw.startTurn(session, input, signal)) {
          if (event.type === 'turn.started' || event.type === 'turn.completed') trace.push({
            nodeId: request.workflowNodeId, executionId: request.executionId,
            phase: event.type === 'turn.started' ? 'started' : 'completed',
          })
          yield event
          if (event.type === 'turn.started') {
            const gate = gates.get(request.workflowNodeId)
            if (gate) {
              parked.add(request.workflowNodeId)
              gate.entered.release()
              try { await waitGate(gate.promise, signal) } finally { parked.delete(request.workflowNodeId) }
            }
          }
        }
      },
    }
  })
  const app = buildApp({ readiness: {
    database: { ping: async () => { await base.db.pool.query('select 1') } },
    checkpoints: { ping: async () => undefined },
  }, operator: { access: base.access, services: { ...base.services,
    runGraph: new RunGraphReadService(base.db.pool, { qualifiedReads: true }),
    interactions: new OperatorInteractionService(base.service),
  } } })
  // Use the SAME human route/authentication/service as buildApp's product binding.
  registerUserInteractions(app, base.service)
  const clients: Client[] = []
  let recoveryTimer: ReturnType<typeof setInterval> | undefined
  let recoveryPass: Promise<void> | undefined
  const recoveryErrors: unknown[] = []
  function stopRecovery() {
    clearInterval(recoveryTimer)
    recoveryTimer = undefined
    return recoveryPass
  }
  try {
    // A public location_set must preserve the runner accepted by the synthetic
    // provider. Otherwise credential preflight fails before the first gate,
    // unlike the preseeded Run that already carries the fixture's local runner.
    expect(base.f.run.executionLocation?.runnerId).toBe(LOCAL_RUNNER_ID)
    expect(base.locations.runnerId, 'Checkpoint location service must use the seeded provider runner')
      .toBe(base.f.run.executionLocation!.runnerId)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'eng07-b-scenarios', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(base.writer.token)
    async function rawHttp(method: string, path: string, body?: unknown, token = base.writer.token) {
      const response = await fetch(new URL(path, address), { method, signal: AbortSignal.timeout(30000),
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const text = await response.text()
      let value: unknown
      try { value = JSON.parse(text) } catch { throw new Error(`Non-JSON HTTP ${response.status}: ${text}`) }
      return { status: response.status, headers: response.headers, body: value }
    }
    async function http(method: string, path: string, body?: unknown, token = base.writer.token) {
      const response = await rawHttp(method, path, body, token)
      expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(200)
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(300)
      return response.body
    }
    async function mcp(name: string, args: Record<string, unknown>, caller = client) {
      return toolValue(await caller.callTool({ name, arguments: args }))
    }
    async function command(via: Via, method: string, path: string, name: string, args: Record<string, unknown>) {
      return via === 'http' ? http(method, path, args) : mcp(name, args)
    }
    // Qualify the actual task-owned temporary directory through the real service.
    // Never reuse seedAgent3's synthetic location identity for a public Start.
    await mcp('workspace_location_set', { workspaceId: base.f.scope.workspaceId,
      commandId: randomUUID(), expectedLocationRevision: 1,
      runnerId: base.locations.runnerId, rootPath: base.db.directory })
    const locationRevision = Number((await base.db.pool.query<{ revision: string }>(
      'select location_revision::text as revision from workspaces where id=$1', [base.f.scope.workspaceId])).rows[0]!.revision)
    expect(locationRevision).toBe(2)
    const workflowPath = (workflowId: string) =>
      `/api/management/workspaces/${base.f.scope.workspaceId}/workflows/${workflowId}`
    async function save(via: Via, previous?: Saved, graph?: WorkflowDefinitionV3) {
      const created = previous ? undefined : SavedManagedWorkflowCommandResultSchema.parse(await command(via, 'POST',
        `/api/management/workspaces/${base.f.scope.workspaceId}/workflows`, 'workflow_create', {
          workspaceId: base.f.scope.workspaceId, commandId: randomUUID(), name: scenario.id,
        })).value
      const workflowId = previous?.version.workflowId ?? created!.workflow.id
      const selectedGraph = graph ?? previous?.version.definition ?? scenario.source.version.definition
      const definition = previous ? { ...selectedGraph, id: workflowId } : { ...selectedGraph, id: workflowId,
        version: created!.workflow.version, createdAt: created!.workflow.createdAt, updatedAt: created!.workflow.updatedAt }
      const input = CurrentWorkflowSaveInputSchema.parse({ workspaceId: base.f.scope.workspaceId, workflowId,
        executionSemanticsVersion: 3, commandId: randomUUID(), expectedRevision: previous?.revision ?? created!.revision,
        expectedWorkflowVersionId: previous?.currentVersionId ?? null,
        expectedAgentConfigurationVersionIds: base.f.version.agentConfigurationVersionIds, graph: definition })
      const result = CurrentWorkflowSaveResultSchema.parse(await command(via, 'PUT',
        `${workflowPath(workflowId)}/definition`, CURRENT_WORKFLOW_TOOLS.save, input))
      expect(result.replayed).toBe(false)
      const replay = CurrentWorkflowSaveResultSchema.parse(await command(other(via), 'PUT',
        `${workflowPath(workflowId)}/definition`, CURRENT_WORKFLOW_TOOLS.save, input))
      expect(replay).toEqual({ ...result, replayed: true })
      return { saved: result.value, input }
    }
    function hold(nodeId: string) {
      if (gates.has(nodeId)) throw new Error(`Duplicate gate ${nodeId}`)
      const gate = { ...latch(), entered: latch() }
      gates.set(nodeId, gate)
      return () => { gates.delete(nodeId); gate.release() }
    }
    async function start(via: Via, saved: Saved) {
      const before = (await base.db.pool.query<{ id: string }>('select id from runs where workflow_id=$1',
        [saved.version.workflowId])).rows.map((row) => row.id)
      outputs.clear()
      const input = RunStartV3InputSchema.parse({ workspaceId: saved.version.workspaceId,
        workflowId: saved.version.workflowId, workflowVersionId: saved.currentVersionId,
        executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: saved.revision,
        expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
        expectedLocationRevision: locationRevision, input: scenario.runInput })
      const path = `${workflowPath(input.workflowId)}/runs`
      const accepted = RunStartV3ResultSchema.parse(await command(via, 'POST', path, 'run_start', input))
      expect(accepted.accepted).toBe(true); expect(accepted.replayed).toBe(false)
      const replay = RunStartV3ResultSchema.parse(await command(other(via), 'POST', path, 'run_start', input))
      expect(replay.run.id).toBe(accepted.run.id); expect(replay.replayed).toBe(true)
      const scope: RepeatGraphScopeV3 = { workspaceId: input.workspaceId, workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId, executionSemanticsVersion: 3, runId: accepted.run.id }
      expect((await base.db.pool.query<{ id: string }>('select id from runs where workflow_id=$1',
        [input.workflowId])).rows.map((row) => row.id).sort()).toEqual([...before, accepted.run.id].sort())
      const record = RunRecordDetailSchema.parse(await http('GET', `${runPath(scope)}/record`))
      expect(record.run.executionLocation).toMatchObject({ runnerId: base.locations.runnerId,
        locationRevision })
      // Production retries saved checkpoints after bounded settlement waits.
      // Start recovery only after the public Start has admitted the first Run.
      recoveryTimer ??= setInterval(() => {
        if (recoveryPass) return
        recoveryPass = base.engine.reconcile((error) => recoveryErrors.push(error))
          .catch((error: unknown) => { recoveryErrors.push(error) })
          .finally(() => { recoveryPass = undefined })
      }, 1_000)
      return { scope, accepted, input, saved }
    }
    async function readParity(path: string, name: string, args: Record<string, unknown>) {
      const response = await rawHttp('GET', path)
      expect(response.status, JSON.stringify(response.body)).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('vary')).toContain('Authorization')
      expect(await mcp(name, args)).toEqual(response.body)
      return response.body
    }
    async function graph(scope: RepeatGraphScopeV3, kind: 'snapshot' | 'current' | 'events', afterSequence?: string) {
      const route = CANONICAL_RUN_GRAPH_ROUTES[kind].replace(':workspaceId', scope.workspaceId)
        .replace(':workflowId', scope.workflowId).replace(':runId', scope.runId)
      const params = new URLSearchParams({ workflowVersionId: scope.workflowVersionId, executionSemanticsVersion: '3',
        ...(afterSequence === undefined ? {} : { afterSequence }) })
      return readParity(`${route}?${params}`, CANONICAL_RUN_GRAPH_MCP_TOOLS[kind], {
        protocolVersion: 1, scope, ...(afterSequence === undefined ? {} : { afterSequence }),
      })
    }
    async function waitUntilParked(scope: RepeatGraphScopeV3, nodeId: string) {
      const gate = gates.get(nodeId)
      if (!gate) throw new Error(`Missing provider gate ${nodeId}`)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([gate.entered.promise, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Provider gate was not reached')), 25000)
        })])
        expect(parked.has(nodeId)).toBe(true)
      } catch (error) {
        // Read-only, content-free diagnostics. Do not print requests, native
        // history, location paths, credential objects or raw nested errors.
        const executions = (await base.db.pool.query<{ id: string; state: string; code: string | null }>(
          `select id,record->>'state' as state,record#>>'{result,error,code}' as code
           from harness_executions where run_id=$1 order by id limit 100`, [scope.runId])).rows
        const codes = base.dispatchErrors.map((item) => typeof item === 'string' && /^[A-Z0-9_]+$/.test(item)
          ? item : 'UNCLASSIFIED_DISPATCH_ERROR')
        throw new Error(`ENG07 provider gate was not reached: ${JSON.stringify({ runId: scope.runId,
          nodeId, runnerId: base.locations.runnerId, starts: base.provider.counts.starts, executions, codes })}`,
        { cause: error })
      } finally { clearTimeout(timer) }
    }
    async function settled(scope: RepeatGraphScopeV3, timeoutMs?: number) {
      let record: Awaited<ReturnType<typeof waitForSuccessfulRunCleanup>>
      try {
        record = await waitForSuccessfulRunCleanup({ pool: base.db.pool, runId: scope.runId,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          readRecord: async () => RunRecordDetailSchema.parse(await http('GET', `${runPath(scope)}/record`)) })
      } catch (error) {
        const progress = (await base.db.pool.query(`select
          (select count(*)::int from run_repeat_occurrences where run_id=$1) as occurrences,
          (select count(*)::int from run_repeat_decisions d join run_repeat_occurrences o
            on o.occurrence_id=d.occurrence_id where o.run_id=$1) as decisions,
          (select count(*)::int from harness_executions where run_id=$1) as executions,
          (select count(*)::int from harness_executions where run_id=$1 and record->>'state'='completed') as completed`,
        [scope.runId])).rows[0]
        const codes = base.dispatchErrors.map((item) => typeof item === 'string' && /^[A-Z0-9_]+$/.test(item)
          ? item : 'UNCLASSIFIED_DISPATCH_ERROR')
        throw new Error(`ENG07 Run did not settle: ${JSON.stringify({ runId: scope.runId, progress,
          starts: base.provider.counts.starts, parked: [...parked.keys()], codes })}`, { cause: error })
      }
      expect(base.dispatchErrors).toEqual([])
      expect(recoveryErrors).toEqual([])
      return record
    }
    return { base, app, client, connect, rawHttp, http, mcp, command, readParity, graph, save, start, settled, hold, waitUntilParked,
      trace, requests, parked, scenario, workflowPath, locationRevision,
      setOracle(next: typeof oracle) { oracle = next },
      async close() {
        const recovery = stopRecovery()
        for (const gate of gates.values()) gate.release()
        gates.clear()
        await recovery
        try { await Promise.allSettled(clients.map((item) => item.close())); await app.close(); await base.close() }
        finally { wrapper.mockRestore() }
      },
    }
  } catch (error) {
    await stopRecovery()
    for (const gate of gates.values()) gate.release()
    await Promise.allSettled(clients.map((client) => client.close()))
    await app.close(); await base.close(); wrapper.mockRestore(); throw error
  }
}
