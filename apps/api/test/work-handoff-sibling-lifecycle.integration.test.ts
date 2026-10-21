import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { DomainError } from '../src/modules/errors.js'
import { WorkerLaunchCredentialService } from '../src/modules/harnesses/mcpDetection.js'
import { EXECUTION_INFRASTRUCTURE_RETRY_WINDOW_MS } from '../src/modules/runs/executionRetryPolicy.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { deferred } from './helpers/deferred.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { handoffOutput, workHandoffSiblings } from './helpers/workHandoffSiblings.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/** Two immediate retries, then a third delay beyond the infrastructure retry window: three attempts per node. */
const exhaustAfterThreeAttempts = () =>
  vi.stubEnv('FOREMAN_EXECUTION_RETRY_BACKOFF_MS', `0,0,${EXECUTION_INFRASTRUCTURE_RETRY_WINDOW_MS}`)

describe.skipIf(!postgresEnabled)('handed-off execution lifetimes', () => {
  it.each([false, true])('keeps queued and starting siblings open after the first return (preflight fails: %s)',
    async failPreflight => {
      exhaustAfterThreeAttempts()
      const fixture = workHandoffSiblings()
      const [coordinator, first, starting, queued] = fixture.version.definition.nodes
      if (!coordinator || !first || !starting || !queued) throw new Error('Four nodes are required')
      const releaseStarting = deferred()
      const releaseQueued = deferred()
      const startingEntered = deferred()
      const queuedEntered = deferred()
      const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], workerParallelism: 3,
        outputFor: handoffOutput,
        preparePlacementExecution: async (_owner, _run, execution) => {
          if (execution.workflowNodeId === queued.id) {
            queuedEntered.resolve()
            await releaseQueued.promise
          }
          return undefined
        },
      })
      const prepare = WorkerLaunchCredentialService.prototype.prepare
      vi.spyOn(WorkerLaunchCredentialService.prototype, 'prepare').mockImplementation(async function (
        this: WorkerLaunchCredentialService, input,
      ) {
        const execution = await f.runs.getExecution(input.executionId)
        if (execution?.workflowNodeId === starting.id) {
          startingEntered.resolve()
          await releaseStarting.promise
          if (failPreflight) {
            throw new DomainError('APP_MCP_PREFLIGHT_FAILED', 'The selected computer MCP configuration is not ready.', 409)
          }
        }
        return prepare.call(this, input)
      })
      let driveFailure: unknown
      const drive = f.engine.start(f.f.run.id).catch((error: unknown) => { driveFailure = error })
      const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
      const read = async () => decodeMcpToolResult(await f.client.callTool({
        name: 'run_get', arguments: { ...scope, detail: 'full' },
      })) as { run: { executionState: string; outcome: string; result?: unknown }; executions: Array<{
        id: string; workflowNodeId: string; state: string; result?: { outcome: string; error?: { code: string } };
      }>; cleanupPending: boolean }
      try {
        await Promise.race([
          Promise.all([startingEntered.promise, queuedEntered.promise]),
          drive.then(() => { throw new Error('The run closed before both sibling gates were entered') }),
        ])
        await expect.poll(async () => (await f.db.pool.query(
          'select request_id from run_work_returns where run_id=$1', [f.f.run.id])).rowCount,
        { timeout: 15_000 }).toBe(1)
        expect(await read()).toMatchObject({ run: { executionState: 'running', outcome: 'pending' },
          cleanupPending: false, executions: expect.arrayContaining([
            expect.objectContaining({ workflowNodeId: first.id, state: 'completed',
              result: expect.objectContaining({ outcome: 'succeeded' }) }),
            expect.objectContaining({ workflowNodeId: starting.id, state: 'starting' }),
            expect.objectContaining({ workflowNodeId: queued.id, state: 'queued' }),
          ]) })

        releaseStarting.resolve()
        if (failPreflight) {
          await expect.poll(async () => (await f.db.pool.query<{ code: string }>(`
            select b.failure_result#>>'{error,code}' as code
            from approval_execution_state b join harness_executions e on e.id=b.execution_id
            where e.run_id=$1 and e.workflow_node_id=$2`, [f.f.run.id, starting.id])).rows[0]?.code,
          { timeout: 15_000 }).toBe('APP_MCP_PREFLIGHT_FAILED')
          expect(await read()).toMatchObject({ run: { executionState: 'running', outcome: 'pending' },
            cleanupPending: false, executions: expect.arrayContaining([
              expect.objectContaining({ workflowNodeId: queued.id, state: 'queued' }),
            ]) })
        }
        releaseQueued.resolve()
        await drive
        const final = await read()
        expect(final.run).toMatchObject({ executionState: 'completed', outcome: failPreflight ? 'failed' : 'succeeded' })
        const activations = await f.db.pool.query<{ state: string }>(
          'select state from run_work_activations where run_id=$1', [f.f.run.id])
        expect(activations.rows).toHaveLength(4)
        expect(activations.rows.every(activation => activation.state === 'completed')).toBe(true)
        expect(final.cleanupPending).toBe(false)
        expect(final.executions).toHaveLength(failPreflight ? 6 : 4)
        for (const node of [coordinator, first, queued]) {
          expect(final.executions.find(execution => execution.workflowNodeId === node.id))
            .toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
          expect(f.provider.startedNodes.filter(id => id === node.id)).toHaveLength(1)
        }
        if (failPreflight) {
          const failedAttempts = final.executions.filter(execution => execution.workflowNodeId === starting.id)
          expect(failedAttempts).toHaveLength(3)
          expect(failedAttempts.every(execution => execution.state === 'completed'
            && execution.result?.outcome === 'failed'
            && execution.result.error?.code === 'APP_MCP_PREFLIGHT_FAILED')).toBe(true)
          expect(final.run.result).toMatchObject({ outcome: 'failed', error: { code: 'APP_MCP_PREFLIGHT_FAILED' } })
          expect(final.executions.find(execution => execution.workflowNodeId === starting.id))
            .toMatchObject({ state: 'completed', result: { outcome: 'failed', error: { code: 'APP_MCP_PREFLIGHT_FAILED' } } })
          expect(driveFailure).toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
          expect(f.provider.startedNodes).not.toContain(starting.id)
        } else {
          expect(driveFailure).toBeUndefined()
          expect(final.executions.every(execution => execution.result?.outcome === 'succeeded')).toBe(true)
          expect(f.provider.startedNodes.filter(id => id === starting.id)).toHaveLength(1)
        }
        const returns = await f.db.pool.query('select request_id from run_work_returns where run_id=$1', [f.f.run.id])
        expect(returns.rowCount).toBe(failPreflight ? 2 : 3)
        const denied = await f.access.issue({ name: 'Unrelated run reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 60_000),
          grants: [{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }],
        })
        await expectMcpAccessDenied((await f.connect(denied.token)).callTool({ name: 'run_get', arguments: scope }))
      } finally {
        releaseStarting.resolve()
        releaseQueued.resolve()
        await drive
        await f.close()
      }
    }, 60_000)

  it('retains both sibling launch causes and completes their work activations', async () => {
    exhaustAfterThreeAttempts()
    const fixture = workHandoffSiblings()
    const [coordinator, healthy, first, second] = fixture.version.definition.nodes
    if (!coordinator || !healthy || !first || !second) throw new Error('Four nodes are required')
    const firstEntered = deferred()
    const secondEntered = deferred()
    const release = deferred()
    const codes = new Map([
      [first.id, 'APP_MCP_PREFLIGHT_FAILED'],
      [second.id, 'APP_MCP_PREFLIGHT_TIMEOUT'],
    ])
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], workerParallelism: 3,
      outputFor: handoffOutput })
    const prepare = WorkerLaunchCredentialService.prototype.prepare
    vi.spyOn(WorkerLaunchCredentialService.prototype, 'prepare').mockImplementation(async function (
      this: WorkerLaunchCredentialService, input,
    ) {
      const execution = await f.runs.getExecution(input.executionId)
      if (!execution) throw new Error('The launch execution is required')
      const code = codes.get(execution.workflowNodeId)
      if (!code) return prepare.call(this, input)
      if (execution.workflowNodeId === first.id) firstEntered.resolve()
      else secondEntered.resolve()
      await release.promise
      throw new DomainError(code, 'The selected MCP configuration is not ready.', 409)
    })
    let driveFailure: unknown
    const drive = f.engine.start(f.f.run.id).catch((error: unknown) => { driveFailure = error })
    const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
    try {
      await Promise.race([
        Promise.all([firstEntered.promise, secondEntered.promise]),
        drive.then(() => { throw new Error('The Run closed before both launch attempts entered') }),
      ])
      release.resolve()
      await drive
      expect(driveFailure).toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
      const result = decodeMcpToolResult(await f.client.callTool({
        name: 'run_get', arguments: { ...scope, detail: 'full' },
      })) as { run: { executionState: string; outcome: string; result: { error: { code: string } } };
        cleanupPending: boolean; executions: Array<{ id: string; workflowNodeId: string; state: string;
          result: { outcome: string; error?: { code: string } } }> }
      expect(result.run).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      expect([...codes.values()]).toContain(result.run.result.error.code)
      expect(result.cleanupPending).toBe(false)
      expect(result.executions).toHaveLength(8)
      for (const [nodeId, code] of codes) {
        const attempts = result.executions.filter(execution => execution.workflowNodeId === nodeId)
        expect(attempts).toHaveLength(3)
        expect(attempts.every(execution => execution.state === 'completed'
          && execution.result.outcome === 'failed' && execution.result.error?.code === code)).toBe(true)
        expect(result.executions.find(execution => execution.workflowNodeId === nodeId))
          .toMatchObject({ state: 'completed', result: { outcome: 'failed', error: { code } } })
        expect(f.provider.startedNodes).not.toContain(nodeId)
      }
      for (const node of [coordinator, healthy]) {
        expect(result.executions.find(execution => execution.workflowNodeId === node.id))
          .toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
      }
      const activations = await f.db.pool.query<{ state: string }>(
        'select state from run_work_activations where run_id=$1', [f.f.run.id])
      expect(activations.rows).toHaveLength(4)
      expect(activations.rows.every(activation => activation.state === 'completed')).toBe(true)
      const denied = await f.access.issue({ name: 'Unrelated run reader', audience: 'operator',
        grants: [{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }],
      })
      await expectMcpAccessDenied((await f.connect(denied.token)).callTool({ name: 'run_get', arguments: scope }))
    } finally {
      release.resolve()
      await drive
      await f.close()
    }
  }, 60_000)
})
