import { afterEach, describe, expect, it, vi } from 'vitest'
import { type HarnessExecutionRequest } from '@foreman-code/contracts'
import { HierarchyWorkGroupSchema, WorkActivationInputSchema, WorkRequestSchema, WorkReturnSchema } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { readHierarchyCoordinationLocked } from '../src/modules/runs/hierarchyCoordinationRead.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { coordinationOutput, hierarchyRuntimeFixture, receivedRequest } from './helpers/hierarchyRuntimeFixture.js'
import { deferred } from './helpers/deferred.js'

afterEach(() => vi.restoreAllMocks())

/** The marked Runs are explicit immutable fixtures for coordinated cutover.
 * Production Start still leaves enforcement off. Migrations, owner, native
 * proof, engine, repository and SQL-only collaboration hooks are real. */
describe.skipIf(!postgresEnabled)('hierarchy runtime obligations and reservations', () => {
  it('executes the seven-node tree with eleven activations and one summary per group', async () => {
    const observed = new Map<string, HarnessExecutionRequest[]>()
    const f = await checkpointRuntimeFixture(1, 1, { fixture: hierarchyRuntimeFixture(), approvalNodeIds: [],
      collaborationPorts: {}, outputFor: (nodeId, request) => {
        observed.set(nodeId, [...(observed.get(nodeId) ?? []), structuredClone(request)])
        return coordinationOutput(nodeId, request)
      } })
    try {
      await f.engine.start(f.f.run.id)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      expect(f.provider.counts.starts).toBe(11)
      const executions = (await f.runs.listRepeatExecutions(f.f.run.id)).map(item => item.execution)
      expect(executions).toHaveLength(11)
      expect(new Set(executions.map(execution => WorkActivationInputSchema.parse(execution.input).work.activation.activationId)).size).toBe(11)
      const groups = (await f.db.pool.query('select record,state from run_hierarchy_groups where run_id=$1 order by group_id', [f.f.run.id])).rows
      expect(groups).toHaveLength(4)
      expect(groups.every(row => row.state === 'continued')).toBe(true)
      for (const row of groups) {
        const group = HierarchyWorkGroupSchema.parse(row.record)
        const summary = executions.filter(execution => WorkActivationInputSchema.parse(execution.input)
          .work.activation.activationId === group.continuationActivationId)
        expect(summary).toHaveLength(1)
        const input = WorkActivationInputSchema.parse(summary[0]!.input)
        expect(input.work).toMatchObject({ kind: 'hierarchy_group', failures: [] })
        if (input.work.kind !== 'hierarchy_group') throw new Error('Expected the reserved group continuation')
        expect(input.work.returns.map(item => item.requestId).sort()).toEqual([...group.memberRequestIds].sort())
      }
      for (const name of ['build', 'test', 'bugs', 'builder', 'tester', 'inspector']) {
        const input = WorkActivationInputSchema.parse(observed.get(name)![0]!.input)
        expect(input.work).toMatchObject({ kind: 'work_request', task: { data: { task: `Task for ${name}` } } })
      }
      const returns = (await f.db.pool.query('select record from run_work_returns where run_id=$1', [f.f.run.id]))
        .rows.map(row => WorkReturnSchema.parse(row.record))
      expect(returns).toHaveLength(6)
      expect(returns.every(returned => returned.outcome === 'accepted' && returned.continuationActivationId === undefined)).toBe(true)
      expect(await readHierarchyCoordinationLocked(f.db.pool, f.f.run.id, f.f.version)).toMatchObject({
        state: 'succeeded', summary: 'master finish', latestDeliverable: { execution: { runId: f.f.run.id } },
      })
      const before = structuredClone(groups)
      await f.engine.start(f.f.run.id)
      expect(f.provider.counts.starts).toBe(11)
      expect((await f.db.pool.query('select record,state from run_hierarchy_groups where run_id=$1 order by group_id', [f.f.run.id])).rows).toEqual(before)
      expect((await f.db.pool.query('select used from run_work_connection_usage where run_id=$1', [f.f.run.id])).rows)
        .toEqual(Array.from({ length: 6 }, () => ({ used: 1 })))
    } finally { await f.close() }
  }, 90_000)

  it('keeps a sibling review group separate from its saved reporting parent and closes the original ancestry', async () => {
    const observed = new Map<string, HarnessExecutionRequest[]>()
    const f = await checkpointRuntimeFixture(1, 1, { fixture: hierarchyRuntimeFixture({ siblingReview: true }),
      approvalNodeIds: [], collaborationPorts: {}, outputFor: (nodeId, request) => {
        observed.set(nodeId, [...(observed.get(nodeId) ?? []), structuredClone(request)])
        const input = WorkActivationInputSchema.parse(request.input)
        if (nodeId === 'builder' && input.work.kind === 'work_request') return {
          routing: { kind: 'request', outcome: 'review' }, data: { latestDeliverable: 'Ready for sibling review', remainingFindings: [] },
          summary: 'Builder requests tester review', board: { kind: 'none', reason: 'no_access' },
        }
        return coordinationOutput(nodeId, request, nodeId === 'master' ? { select: ['build'] } : {})
      } })
    try {
      await f.engine.start(f.f.run.id)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ outcome: 'succeeded' })
      expect(f.provider.startedNodes).not.toContain('test')
      expect(f.provider.startedNodes).not.toContain('bugs')
      expect(f.provider.counts.starts).toBe(7)
      const testerInput = WorkActivationInputSchema.parse(observed.get('tester')![0]!.input)
      expect(testerInput.work).toMatchObject({ kind: 'work_request', request: { requesterNodeId: 'builder' } })
      const builderInput = WorkActivationInputSchema.parse(observed.get('builder')![1]!.input)
      expect(builderInput.work.kind).toBe('hierarchy_group')
      expect(builderInput.parentRequest).toMatchObject({ requesterNodeId: 'build', destinationNodeId: 'builder' })
      const requests = (await f.db.pool.query('select record from run_work_requests where run_id=$1', [f.f.run.id]))
        .rows.map(row => WorkRequestSchema.parse(row.record))
      const returns = (await f.db.pool.query('select record from run_work_returns where run_id=$1', [f.f.run.id]))
        .rows.map(row => WorkReturnSchema.parse(row.record))
      expect(requests).toHaveLength(3)
      expect(returns.map(item => item.requestId).sort()).toEqual(requests.map(item => item.requestId).sort())
      expect(returns.every(item => item.continuationActivationId === undefined)).toBe(true)
      const reports = (await f.db.pool.query(`select record from run_hierarchy_reports
        where run_id=$1 and workflow_node_id='tester'`, [f.f.run.id])).rows
      expect(reports.length).toBeGreaterThan(0)
      expect(reports.every(row => row.record.parentNodeId === 'test'
        && row.record.parentRequestId === receivedRequest(testerInput))).toBe(true)
    } finally { await f.close() }
  }, 90_000)

  it('settles accepted, needs-changes and prelaunch-failed members before the one reserved parent summary', async () => {
    const fixture = hierarchyRuntimeFixture()
    const release = deferred(), entered = deferred()
    const rootSummaries: unknown[] = []
    const f = await checkpointRuntimeFixture(1, 1, { fixture, approvalNodeIds: [], collaborationPorts: {},
      preparePlacementExecution: async (_owner, _run, execution) => {
        if (execution.workflowNodeId === 'bugs') {
          entered.resolve()
          await release.promise
          throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The saved inspector profile is unavailable.', 409)
        }
        return undefined
      },
      outputFor: (nodeId, request) => {
        const input = WorkActivationInputSchema.parse(request.input)
        if (nodeId === 'master' && input.work.kind === 'hierarchy_group') rootSummaries.push(input)
        if (nodeId !== 'master') return coordinationOutput(nodeId, request, { select: [],
          ...(nodeId === 'test' ? { outcome: 'needs_changes', findings: ['Review needs another pass'] } : {}) })
        return coordinationOutput(nodeId, request)
      } })
    let failure: unknown
    const drive = f.engine.start(f.f.run.id).catch(error => { failure = error })
    try {
      await Promise.race([entered.promise, drive.then(() => { throw new Error('The failure gate was never reached') })])
      await expect.poll(async () => (await f.db.pool.query('select record from run_work_returns where run_id=$1', [f.f.run.id])).rowCount,
        { timeout: 15_000 }).toBe(2)
      expect(rootSummaries).toHaveLength(0)
      expect((await f.db.pool.query('select state from run_hierarchy_groups where run_id=$1', [f.f.run.id])).rows)
        .toEqual([{ state: 'waiting' }])
      release.resolve()
      await drive
      expect(failure).toBeUndefined()
      expect(rootSummaries).toHaveLength(1)
      const summary = WorkActivationInputSchema.parse(rootSummaries[0])
      if (summary.work.kind !== 'hierarchy_group') throw new Error('Expected a real group summary')
      expect(summary.work.failures).toEqual([expect.objectContaining({ destinationNodeId: 'bugs',
        outcome: 'failed', code: 'HARNESS_PROFILE_UNAVAILABLE' })])
      expect(summary.work.returns).toEqual(expect.arrayContaining([
        expect.objectContaining({ destinationNodeId: 'build', outcome: 'accepted' }),
        expect.objectContaining({ destinationNodeId: 'test', outcome: 'needs_changes',
          continuationActivationId: summary.work.activation.activationId }),
      ]))
      const persisted = (await f.db.pool.query('select record from run_work_returns where run_id=$1', [f.f.run.id]))
        .rows.map(row => WorkReturnSchema.parse(row.record))
      expect(persisted).toHaveLength(2)
      expect(persisted.find(item => item.outcome === 'accepted')?.continuationActivationId).toBeUndefined()
      expect(f.provider.startedNodes).not.toContain('bugs')
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ outcome: 'succeeded' })
    } finally { release.resolve(); await drive; await f.close() }
  }, 90_000)

  it('refuses the entire child set when capacity fits children but omits their parent summary', async () => {
    const saved = hierarchyRuntimeFixture({ maximum: 4 })
    const coordinators = new Set(['master', 'build', 'test', 'bugs'])
    saved.configurations = saved.configurations.filter(configuration => configuration.productRole !== 'coder')
    saved.version.agentConfigurationVersionIds = Object.fromEntries(saved.configurations.map(configuration =>
      [configuration.agentId, configuration.id]))
    saved.run.agentConfigurationVersionIds = saved.version.agentConfigurationVersionIds
    saved.version.definition.nodes = saved.version.definition.nodes.filter(node => coordinators.has(node.id))
      .map(node => node.id === 'master' ? node : { id: node.id, agentId: node.agentId, name: node.name })
    saved.version.definition.edges = saved.version.definition.edges.filter(edge => coordinators.has(edge.target))
    saved.version.definition.hierarchy!.parents = saved.version.definition.hierarchy!.parents
      .filter(member => coordinators.has(member.workflowNodeId))
    const f = await checkpointRuntimeFixture(1, 1, { fixture: saved,
      approvalNodeIds: [], collaborationPorts: {}, outputFor: coordinationOutput })
    try {
      await expect(f.engine.start(f.f.run.id)).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED',
        result: { error: { code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED' } } })
      const executions = (await f.runs.listRepeatExecutions(f.f.run.id)).map(item => item.execution)
      expect(executions).toHaveLength(1)
      expect(executions[0]).toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      for (const table of ['run_work_requests', 'run_hierarchy_groups', 'run_hierarchy_group_members', 'run_work_connection_usage']) {
        expect((await f.db.pool.query(`select 1 from ${table} where run_id=$1`, [f.f.run.id])).rows).toEqual([])
      }
      const refusals = (await f.db.pool.query('select code,source_execution_id from run_hierarchy_refusals where run_id=$1', [f.f.run.id])).rows
      expect(refusals).toEqual([{ code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED', source_execution_id: executions[0]!.id }])
      expect((await f.db.pool.query(`select payload from run_activity where run_id=$1 and kind='collaboration_lifecycle'`, [f.f.run.id]))
        .rows.map(row => row.payload.fact.phase)).toEqual(expect.arrayContaining(['awaiting_acceptance', 'failed']))
      const starts = f.provider.counts.starts
      await f.engine.start(f.f.run.id)
      expect(f.provider.counts.starts).toBe(starts)
      expect((await f.db.pool.query('select code,source_execution_id from run_hierarchy_refusals where run_id=$1', [f.f.run.id])).rows).toEqual(refusals)
    } finally { await f.close() }
  }, 90_000)

  it('refuses all three requested children when just one saved route is already exhausted', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { fixture: hierarchyRuntimeFixture({ routeMaximum: 1, maximum: 20 }),
      approvalNodeIds: [], collaborationPorts: {}, outputFor: (nodeId, request) => {
        if (nodeId !== 'master') return coordinationOutput(nodeId, request, { select: [] })
        const input = WorkActivationInputSchema.parse(request.input)
        if (input.work.kind !== 'hierarchy_group') return coordinationOutput(nodeId, request, { select: ['build'] })
        return { routing: { kind: 'delegate', requests: ['build', 'test', 'bugs'].map(outcome => ({
          outcome, data: { task: `Next task for ${outcome}` } })) },
        data: { latestDeliverable: 'The first child result remains recorded', remainingFindings: [] },
        summary: 'Request the next child set', board: { kind: 'none', reason: 'no_access' } }
      } })
    try {
      await expect(f.engine.start(f.f.run.id)).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED',
        result: { error: { code: 'WORK_ROUTE_LIMIT_EXHAUSTED' } } })
      expect(f.provider.startedNodes).toEqual(['master', 'build', 'master'])
      expect((await f.db.pool.query('select record from run_work_requests where run_id=$1', [f.f.run.id])).rows).toHaveLength(1)
      expect((await f.db.pool.query('select state from run_hierarchy_groups where run_id=$1', [f.f.run.id])).rows)
        .toEqual([{ state: 'continued' }])
      expect((await f.db.pool.query('select relationship_id,used from run_work_connection_usage where run_id=$1', [f.f.run.id])).rows)
        .toEqual([{ relationship_id: 'route-master-build', used: 1 }])
      const executions = (await f.runs.listRepeatExecutions(f.f.run.id)).map(item => item.execution)
      expect(executions).toHaveLength(3)
      expect(executions.every(execution => execution.state === 'completed' && execution.result?.outcome === 'succeeded')).toBe(true)
      const refusal = (await f.db.pool.query('select code,source_execution_id from run_hierarchy_refusals where run_id=$1', [f.f.run.id])).rows
      expect(refusal).toEqual([{ code: 'WORK_ROUTE_LIMIT_EXHAUSTED', source_execution_id: f.provider.startedExecutions[2] }])
      await f.engine.start(f.f.run.id)
      expect(f.provider.counts.starts).toBe(3)
      expect((await f.db.pool.query('select code,source_execution_id from run_hierarchy_refusals where run_id=$1', [f.f.run.id])).rows).toEqual(refusal)
    } finally { await f.close() }
  }, 90_000)

  it.each([false, true])('holds a real same-Run direction execution before launch after delegated work: %s', async delegated => {
    const f = await checkpointRuntimeFixture(1, 1, { fixture: hierarchyRuntimeFixture({ maximum: 12 }),
      approvalNodeIds: [], collaborationPorts: {}, outputFor: (nodeId, request) => {
        const input = WorkActivationInputSchema.parse(request.input)
        if (nodeId === 'master' && (!delegated || input.work.kind === 'hierarchy_group')) {
          return coordinationOutput(nodeId, request, { select: [], findings: ['Choose the release scope'] })
        }
        return coordinationOutput(nodeId, request)
      } })
    const drive = f.engine.start(f.f.run.id).catch(error => error)
    try {
      await expect.poll(async () => (await readHierarchyCoordinationLocked(f.db.pool, f.f.run.id, f.f.version))?.state,
        { timeout: 75_000 }).toBe('waiting_for_direction')
      const coordination = await readHierarchyCoordinationLocked(f.db.pool, f.f.run.id, f.f.version)
      expect(coordination?.direction?.execution.runId).toBe(f.f.run.id)
      expect(coordination?.summary).toBe('master finish')
      const target = coordination!.direction!.execution
      const held = await f.runs.getExecution(target.executionId)
      expect(held).toMatchObject({ runId: f.f.run.id, workflowNodeId: 'master', state: 'queued' })
      expect(held?.nativeSessionId).toBeUndefined()
      expect(f.provider.startedExecutions).not.toContain(target.executionId)
      const input = WorkActivationInputSchema.parse(held!.input)
      expect(input.work).toMatchObject({ kind: 'hierarchy_direction', activation: { activationId: target.activationId },
        direction: { heldExecutionId: target.executionId, remainingFindingsCount: 1 } })
      expect((await f.db.pool.query('select count(*)::int as count from run_hierarchy_groups where run_id=$1', [f.f.run.id])).rows)
        .toEqual([{ count: delegated ? 4 : 0 }])
      expect((await f.db.pool.query('select accepted from harness_executions where id=$1', [coordination!.sourceExecution!.executionId])).rows)
        .toEqual([{ accepted: false }])
      await f.stop()
      await drive
      expect((await f.db.pool.query('select state from run_hierarchy_direction_waits where run_id=$1', [f.f.run.id])).rows)
        .toEqual([{ state: 'canceled' }])
      expect(f.provider.startedExecutions).not.toContain(target.executionId)
    } finally { await f.stop(); await drive; await f.close() }
  }, 90_000)
})
