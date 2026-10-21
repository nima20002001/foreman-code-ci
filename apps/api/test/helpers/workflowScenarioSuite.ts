import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GetInteractionResponseSchema, ListInteractionsResponseSchema, RespondToInteractionRequestSchema, RespondToInteractionResponseSchema } from '@foreman-code/contracts'
import { ManagedInteractionPageSchema } from '@foreman-code/contracts/management'
import { RepeatGraphSnapshotV3Schema, RunExecutionsPageSchema, RunRecordDetailSchema } from '@foreman-code/contracts/wave25'
import { postgresEnabled } from './wave25Agent3.js'
import { scenarioFixture, type ScenarioId } from './eng07BScenarios.js'
import { runPath, scenarioHarness, type Harness, type Started, type Via } from './eng07BHarness.js'
import { assertScenarioEvidence } from './eng07BEvidence.js'

async function approveThroughHttp(f: Harness, started: Started) {
  const { workspaceId, workflowId, runId } = started.scope
  const agentDenied = await f.rawHttp('GET', `/api/user/interactions?runId=${encodeURIComponent(runId)}&limit=10`)
  expect(agentDenied.status).toBe(403)
  const runOnly = await f.rawHttp('GET', `/api/user/interactions?runId=${encodeURIComponent(runId)}&limit=10`, undefined, '')
  expect(runOnly.status).toBe(200)
  const query = new URLSearchParams({ workspaceId, workflowId, runId, limit: '10' })
  const list = () => f.http('GET', `/api/user/interactions?${query}`, undefined, '')
  await vi.waitFor(async () => {
    const page = ListInteractionsResponseSchema.parse(await list())
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ runId, status: 'pending' })
    const record = RunRecordDetailSchema.parse(await f.http('GET', `${runPath(started.scope)}/record`))
    expect(record).toMatchObject({ run: { executionState: 'waiting', outcome: 'pending' },
      stopRequested: false, cleanupPending: false })
  }, { timeout: 25000, interval: 50 })
  const page = ListInteractionsResponseSchema.parse(await list()), interaction = page.items[0]!
  const reader = await f.base.access.issue({
    name: 'Run interaction reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
    grants: [{ actions: ['interactions:read'], scope: { runIds: [runId] } }],
  })
  const monitor = await f.connect(reader.token)
  const monitoringResult = await monitor.callTool({
    name: 'interaction_list', arguments: { workspaceId, workflowId, runId, limit: 10 },
  })
  expect(monitoringResult.isError).not.toBe(true)
  const monitoring = ManagedInteractionPageSchema.parse(decodeMcpToolResult(monitoringResult))
  expect(monitoring.items).toEqual(page.items)
  expect(f.base.provider.startedNodes).toEqual(f.scenario.nodes.slice(0, 2).map((node) => node.id))
  const current = RepeatGraphSnapshotV3Schema.parse(await f.graph(started.scope, 'snapshot'))
  expect(current.state.run.pendingInteractionCount).toBe(1)
  expect(current.state.occurrences).toEqual([]); expect(current.state.decisions).toEqual([])
  const detail = GetInteractionResponseSchema.parse(await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, ''))
  expect(detail.canRespond).toBe(true); expect(detail.interaction).toEqual(interaction)
  const option = interaction.responseOptions.find((item) => item.semantic === 'approve_once')
  expect(option).toBeDefined()
  const input = RespondToInteractionRequestSchema.parse({ interactionId: interaction.id,
    expectedRevision: interaction.revision, optionId: option!.optionId })
  const path = `/api/user/interactions/${interaction.id}/respond`
  const tools = await f.client.listTools()
  expect(tools.tools.map((tool) => tool.name)).toContain('interaction_respond')
  const readerTools = await monitor.listTools()
  expect(readerTools.tools.map((tool) => tool.name)).not.toContain('interaction_respond')
  const deniedMcp = await monitor.callTool({ name: 'interaction_respond', arguments: input })
  expect(deniedMcp.isError).toBe(true)
  expect(JSON.stringify(deniedMcp.content)).toContain('ACCESS_DENIED')
  const denied = await f.rawHttp('POST', path, input)
  expect(denied.status).toBe(403)
  expect(denied.body).toMatchObject({ error: { code: 'MCP_BROWSER_REVIEW_REQUIRED' } })
  expect(f.base.provider.counts.responses).toBe(0)
  expect(await f.base.repository.get(interaction.id)).toEqual(interaction)
  // Prove that the original approval is still open BEFORE the first response.
  // These are observations only; no authority, budget or cleanup fence is reset.
  const authority = (await f.base.db.pool.query(`select r.execution_state as run_state,
    r.stop_requested_at is not null as stop_requested,
    r.worker_credentials_closed_at is not null as run_credentials_closed,
    e.record->>'state' as execution_state,
    e.worker_credentials_closed_at is not null as execution_credentials_closed
    from runs r join harness_executions e on e.run_id=r.id where r.id=$1 and e.id=$2`,
  [runId, interaction.executionId])).rows
  expect(authority).toEqual([{ run_state: 'waiting', stop_requested: false,
    run_credentials_closed: false, execution_state: 'waiting', execution_credentials_closed: false }])

  // respondToApproval awaits the real graph resume. With this fast provider an
  // awaited first response completes the entire Run, so a subsequent response
  // correctly hits EXECUTION_STOPPED. Hold the successor, not the requester,
  // and replay after delivery/ACK while the first response is still in flight.
  const successor = f.scenario.nodes[2]!, releaseSuccessor = f.hold(successor.id)
  const response = f.http('POST', path, input, '')
  void response.catch(() => undefined) // Keep failures handled until the awaited read below.
  try {
    await f.waitUntilParked(started.scope, successor.id)
    const active = RunRecordDetailSchema.parse(await f.http('GET', `${runPath(started.scope)}/record`))
    expect(active).toMatchObject({ run: { executionState: 'running', outcome: 'pending' },
      stopRequested: false, cleanupPending: false })
    expect(f.base.provider.counts.responses).toBe(1)
    const delivered = GetInteractionResponseSchema.parse(await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, ''))
    expect(delivered.interaction).toMatchObject({ id: interaction.id, runId, deliveryState: 'delivered' })
    const replay = RespondToInteractionResponseSchema.parse(await f.http('POST', path, input, ''))
    expect(replay).toMatchObject({ replayed: true,
      interaction: { id: interaction.id, runId, deliveryState: 'delivered' } })
    expect(f.parked.has(successor.id)).toBe(true)
    expect(f.base.provider.counts.responses).toBe(1)
  } finally {
    releaseSuccessor()
    await response.catch(() => undefined)
  }
  const decision = RespondToInteractionResponseSchema.parse(await response)
  expect(decision).toMatchObject({ replayed: false,
    interaction: { id: interaction.id, runId, deliveryState: 'delivered' } })
  await f.settled(started.scope)
  // An exact terminal replay remains idempotent and cannot redeliver the native response.
  const counts = { ...f.base.provider.counts }
  const terminalReplay = RespondToInteractionResponseSchema.parse(await f.http('POST', path, input, ''))
  expect(terminalReplay).toMatchObject({ replayed: true,
    interaction: { id: interaction.id, runId, deliveryState: 'delivered' } })
  expect(f.base.provider.counts).toEqual(counts)
  const final = GetInteractionResponseSchema.parse(await f.http('GET', `/api/user/interactions/${interaction.id}`, undefined, ''))
  expect(final.interaction).toEqual(terminalReplay.interaction)
  // Worker acknowledgement can advance the revision after the first response snapshot.
  const { revision: decisionRevision, updatedAt: decisionUpdatedAt, ...decisionFields } = decision.interaction
  const { revision: finalRevision, updatedAt: finalUpdatedAt, ...finalFields } = final.interaction
  expect(finalFields).toEqual(decisionFields)
  expect(finalRevision).toBeGreaterThanOrEqual(decisionRevision)
  expect(Date.parse(finalUpdatedAt)).toBeGreaterThanOrEqual(Date.parse(decisionUpdatedAt))
  const finalMonitoringResult = await monitor.callTool({
    name: 'interaction_list', arguments: { workspaceId, workflowId, runId, limit: 10 },
  })
  expect(finalMonitoringResult.isError).not.toBe(true)
  const finalMonitor = ManagedInteractionPageSchema.parse(decodeMcpToolResult(finalMonitoringResult))
  expect(finalMonitor.items).toEqual(ListInteractionsResponseSchema.parse(await list()).items)
  return final.interaction
}

export function defineScenarioTests(id: ScenarioId, via: Via) {
  describe.skipIf(!postgresEnabled)(`${id} / real PostgreSQL + HTTP + authenticated Operator MCP`, () => {
    afterEach(() => vi.restoreAllMocks())
    describe(`${via} admission with cross-transport replay`, () => {
      it(`${id} preserves exact routing, history, input/result and graph evidence`, async () => {
        const scenario = scenarioFixture(id, randomUUID()), f = await scenarioHarness(scenario)
        let primaryFailure: unknown, failed = false
        try {
          const { saved } = await f.save(via)
          const releaseEntry = f.hold(scenario.nodes[0]!.id)
          const releaseSlow = scenario.slowNodeId ? f.hold(scenario.slowNodeId) : undefined
          const releaseFast = scenario.joinNodeId ? f.hold(scenario.nodes[1]!.id) : undefined
          const releaseRouter = id === 'S3-03' ? f.hold(scenario.nodes[2]!.id) : undefined
          const started = await f.start(via, saved)
          await f.waitUntilParked(started.scope, scenario.nodes[0]!.id)
          const initial = RepeatGraphSnapshotV3Schema.parse(await f.graph(started.scope, 'snapshot'))
          expect(initial.state.run).toMatchObject({ executionState: 'running', outcome: 'pending' })
          expect(f.base.provider.counts.starts).toBe(1)
          releaseEntry()
          if (releaseSlow) {
            // Rendezvous at the fork before either sibling may complete. Holding
            // only the slow branch would incorrectly let a serial engine pass.
            await Promise.all(scenario.nodes.slice(1, 3).map(node => f.waitUntilParked(started.scope, node.id)))
            expect(f.parked.has(scenario.nodes[1]!.id)).toBe(true)
            expect(f.parked.has(scenario.nodes[2]!.id)).toBe(true)
            for (const node of scenario.nodes.slice(1, 3)) expect(f.trace.some((event) =>
              event.nodeId === node.id && event.phase === 'completed')).toBe(false)
            releaseFast!(); releaseRouter?.()
            await vi.waitFor(async () => {
              expect(f.parked.has(scenario.slowNodeId!)).toBe(true)
              const page = RunExecutionsPageSchema.parse(await f.http('GET', `${runPath(started.scope)}/executions?limit=100`))
              expect(page.items.find((item) => item.workflowNodeId === scenario.nodes[1]!.id))
                .toMatchObject({ state: 'completed', acceptedResultAvailable: true })
            }, { timeout: 25000, interval: 50 })
            // This gate proves overlapping branches, rather than merely observing
            // an eventually-successful diamond that may have run serially.
            expect(f.base.provider.startedNodes).toContain(scenario.nodes[1]!.id)
            expect(f.base.provider.startedNodes).toContain(scenario.slowNodeId!)
            expect(f.base.provider.startedNodes).not.toContain(scenario.joinNodeId!)
            if (id === 'S3-03') expect(f.base.provider.startedNodes).not.toContain(scenario.nodes[4]!.id)
            releaseSlow()
          }
          const approval = id === 'S3-04' ? await approveThroughHttp(f, started) : undefined
          await f.settled(started.scope, scenario.repeat ? 75000 : undefined)
          const view = await assertScenarioEvidence(f, started, initial)
          if (id === 'S3-04') expect(view.events.some((event) => event.fact.type === 'worker.resumed'
            && event.evidence.sourceKind === 'native_event')).toBe(true)
          if (approval) {
            const acknowledgements = view.events.filter((event) => event.fact.type === 'interaction.state'
              && event.fact.interaction.interactionId === approval.id
              && event.fact.interaction.resumeState === 'acknowledged')
            expect(acknowledgements).toHaveLength(1)
            expect(acknowledgements[0]).toMatchObject({
              evidence: { sourceKind: 'native_event' },
              fact: { interaction: { revision: String(approval.revision), status: 'delivered',
                deliveryState: 'delivered', selectedOptionId: approval.selectedOptionId,
                decision: approval.selectedSemantic } },
            })
          }
          const expectedNodes = Array.from({ length: scenario.occurrences }, () => scenario.executedIndexes
            .map((index) => scenario.nodes[index]!.id)).flat()
          expect([...f.base.provider.startedNodes].sort()).toEqual([...expectedNodes].sort())
          expect(new Set(f.base.provider.startedExecutions).size).toBe(expectedNodes.length)
          expect(f.base.provider.counts).toMatchObject({ sessions: scenario.executedIndexes.length, starts: expectedNodes.length,
            responses: id === 'S3-04' ? 1 : 0 })
          if (id === 'S3-01' || id === 'S3-04' || scenario.repeat) expect(f.base.provider.startedNodes).toEqual(expectedNodes)
          if (scenario.joinNodeId) {
            const join = f.trace.findIndex((event) => event.nodeId === scenario.joinNodeId && event.phase === 'started')
            for (const nodeId of [scenario.nodes[1]!.id, scenario.slowNodeId!]) {
              const done = f.trace.findIndex((event) => event.nodeId === nodeId && event.phase === 'completed')
              expect(done).toBeGreaterThanOrEqual(0); expect(join).toBeGreaterThan(done)
            }
          }
          if (id === 'S3-03') {
            const router = view.snapshot.state.resolutions.find((item) => item.ref.nodeId === scenario.nodes[2]!.id)!
            expect(router.value).toMatchObject({ resolution: 'succeeded', outcome: 'long',
              selectedRelationshipIds: [scenario.edges[2]!.id], unselectedRelationshipIds: [scenario.edges[3]!.id] })
            expect(view.snapshot.state.resolutions.find((item) => item.ref.nodeId === scenario.nodes[4]!.id)?.value)
              .toMatchObject({ resolution: 'skipped', selectedRelationshipIds: [], unselectedRelationshipIds: [scenario.edges[6]!.id] })
          }
        } catch (error) {
          primaryFailure = error
          failed = true
        }
        let closeFailure: unknown, closeFailed = false
        try { await f.close() } catch (error) { closeFailure = error; closeFailed = true }
        if (failed && closeFailed) throw new AggregateError([primaryFailure, closeFailure],
          `ENG07 scenario failed before teardown: ${primaryFailure instanceof Error ? primaryFailure.message : 'unknown error'}`)
        if (failed) throw primaryFailure
        if (closeFailed) throw closeFailure
      }, id.startsWith('S3-05') ? 130000 : 90000)
    })
  })
}
