import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { AgentRunStatusSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { RunHistoryService } from '../src/modules/runs/history.js'
import { workerToolServices } from './helpers/workerMcpServices.js'
import { intervalRuntime } from './helpers/intervalRuntime.js'

it('re-activates a looping node with its loop prompt in its own session without routing and keeps the settled Run idle until Stop', async () => {
  const { runtime, f, watcher, worker, checkStarted, checkGate, workerGate } = await intervalRuntime('Check the deploy log for errors.')
  const commands = new PostgresCommandCoordinator(runtime.db.pool)
  const tools = workerToolServices(runtime.db.pool, commands)
  const services = { commands, bugReports: tools.bugReports, ci: tools.ci } as unknown as OperatorServices
  const app = buildApp({
    logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: runtime.access, services },
    appMcp: tools.appMcp(runtime.access, new PostgresAppInteractionService(runtime.db.pool, runtime.repository, commands)),
  })
  const clients: Client[] = []
  let finished: Promise<void> | undefined
  let stopped = false
  try {
    finished = runtime.engine.start(f.run.id)
    const checkId = await checkStarted.promise
    const executions = async () => (await runtime.db.pool.query<{ id: string; node: string; tick: number | null
      state: string; continued: string | null }>(`select id,workflow_node_id as node,tick_index as tick,record->>'state' as state,
      record#>>'{sessionContinuation,previousExecutionId}' as continued from harness_executions where run_id=$1
      order by created_at`, [f.run.id])).rows
    const during = await executions()
    const graphWatcher = during.find(row => row.node === watcher.id && row.tick === null)!
    const workerRun = during.find(row => row.node === worker.id)!
    expect(during.find(row => row.id === checkId)).toMatchObject({ node: watcher.id, tick: 1, continued: graphWatcher.id })
    expect(workerRun.state).not.toBe('completed')

    // The check runs with the node's own credential and reads its whole Run through authenticated MCP.
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (executionId: string) => {
      const credential = await runtime.credentials.issueForExecution(executionId)
      const client = new Client({ name: 'interval-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { requestInit: {
        headers: { authorization: `Bearer ${credential.environment.variables.GRAPHQL_MCP_TOKEN!}` } } }))
      return { client, principalId: credential.principalId }
    }
    const checker = await connect(checkId)
    const tools = (await checker.client.listTools()).tools
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'run_status_get', 'files.references_list', 'files.reference_read',
    ]))
    for (const tool of tools.filter(tool => tool.name.startsWith('files.reference'))) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
    }
    const read = await checker.client.callTool({ name: 'run_status_get', arguments: {} })
    expect(read.isError).not.toBe(true)
    const status = AgentRunStatusSchema.parse(decodeMcpToolResult(read))
    expect(status.self).toEqual({ nodeId: watcher.id, executionId: checkId })
    expect(status.run).toMatchObject({ id: f.run.id, stopRequested: false })
    expect(status.nodes).toEqual([
      expect.objectContaining({ nodeId: watcher.id, executions: 2, checks: 1 }),
      expect.objectContaining({ nodeId: worker.id, executions: 1, checks: 0 }),
    ])
    expect(status.nodes[1]!.state).not.toBe('completed')

    // The Board's live Run read shows the running check.
    const history = new RunHistoryService(runtime.db.pool)
    const viewer = (await runtime.access.issue({ name: 'Board viewer', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['runs:read'], scope: { workspaceIds: [f.scope.workspaceId] } }] })).principal
    const board = () => history.snapshot(viewer, { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, runId: f.run.id })
    expect((await board()).intervalChecks).toEqual([{ nodeId: watcher.id, everySeconds: 10, checks: 1, running: true, nextCheckAt: null }])

    // A node without interval checks cannot read Run status, and the denial is audited.
    const denied = await connect(workerRun.id)
    expect((await denied.client.listTools()).tools.map(tool => tool.name)).not.toContain('run_status_get')
    const refused = await denied.client.callTool({ name: 'run_status_get', arguments: {} })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('TOOL_NOT_ENABLED')
    expect((await runtime.db.pool.query('select action,outcome from management_audit where principal_id=$1',
      [denied.principalId])).rows).toContainEqual({ action: 'run_status_get', outcome: 'denied' })

    // Test-issued credentials are extra; the Run settles only after every credential is revoked.
    for (const issued of [checker, denied]) await runtime.credentials.revoke(issued)
    checkGate.resolve()
    workerGate.resolve()
    await vi.waitFor(async () => expect((await executions()).every(row => row.state === 'completed')).toBe(true),
      { timeout: 10_000 })
    await vi.waitFor(async () => {
      const resolved = await runtime.db.pool.query(
        'select workflow_node_id from run_repeat_resolutions where run_id=$1', [f.run.id])
      expect(resolved.rows).toHaveLength(2)
    }, { timeout: 10_000 })
    expect((await runtime.runs.get(f.run.id))?.executionState).toBe('running')
    await runtime.stop()
    await runtime.engine.cancel(f.run.id)
    stopped = true
    await Promise.allSettled([finished])
    const after = await executions()
    expect(after.filter(row => row.node === worker.id)).toHaveLength(1)
    expect(after.filter(row => row.tick !== null).every(row => row.state === 'completed')).toBe(true)
    // The stored check index always matches the check's frozen input.
    await expect(runtime.db.pool.query('update harness_executions set tick_index=2 where id=$1', [checkId]))
      .rejects.toThrow(/tick_execution_outside/)
    expect((await runtime.db.pool.query(`select execution_state as state,record->>'outcome' as outcome from runs where id=$1`,
      [f.run.id])).rows[0]).toEqual({ state: 'completed', outcome: 'canceled' })
    expect((await board()).intervalChecks).toEqual([{ nodeId: watcher.id, everySeconds: 10, checks: 1, running: false, nextCheckAt: null }])
    const resolutions = (await runtime.db.pool.query('select workflow_node_id as node,execution_id as execution from run_repeat_resolutions where run_id=$1 order by workflow_node_id',
      [f.run.id])).rows
    expect(resolutions).toEqual(expect.arrayContaining([{ node: watcher.id, execution: graphWatcher.id },
      { node: worker.id, execution: workerRun.id }]))
    expect(resolutions).toHaveLength(2)
    const prompts = [...runtime.providers.values()].flatMap(provider => [...provider.threads.values()])
      .flatMap(thread => thread.turns).map(turn => JSON.stringify(turn.items[0]))
    expect(prompts.some(prompt => prompt.includes('loop 1') && prompt.includes('Each loop: Check the deploy log for errors.')
      && prompt.includes('run_status_get'))).toBe(true)
  } finally {
    checkGate.resolve(); workerGate.resolve()
    // A failed assertion must not leave the loop Run active: closing the runtime would then fail its
    // restart cleanup and replace the assertion with a database cleanup error.
    if (!stopped) await Promise.allSettled([runtime.stop().then(() => runtime.engine.cancel(f.run.id))])
    await Promise.allSettled([finished])
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close()
    await runtime.close()
  }
}, 90_000)
