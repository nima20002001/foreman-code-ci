import { randomUUID } from 'node:crypto'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { codexApprovalRuntime } from './codexApprovalRuntime.js'
import { deferred } from './deferred.js'

/** One Agent on two sequential nodes; the entry node loops every 10 seconds, with prompt when given. */
export async function intervalRuntime(prompt?: string) {
  const f = makeCurrentWorkflowFixture(randomUUID())
  const [watcher, worker] = f.version.definition.nodes
  if (!watcher || !worker) throw new Error('Expected two Agent nodes')
  worker.agentId = watcher.agentId
  f.configurations = [f.configurations[0]!]
  f.version.agentConfigurationVersionIds = { [watcher.agentId]: f.configurations[0]!.id }
  watcher.interval = { everySeconds: 10, ...(prompt ? { prompt } : {}) }
  f.version.definition.executionPolicy!.maxParallelism = 1
  const checkStarted = deferred<string>(), checkGate = deferred(), workerGate = deferred()
  const db: { pool?: { query: (text: string, values: unknown[]) => Promise<{ rows: Array<{ node: string; tick: number | null }> }> } } = {}
  const runtime = await codexApprovalRuntime('user', { fixture: f, approvalPolicy: 'never',
    workflowOutput: async (executionId) => {
      const [row] = (await db.pool!.query('select workflow_node_id as node,tick_index as tick from harness_executions where id=$1',
        [executionId])).rows
      if (row?.tick) {
        checkStarted.resolve(executionId)
        await checkGate.promise
        return 'Checked the Run: no failed nodes or CI.'
      }
      if (row?.node === worker.id) await workerGate.promise
      return `${row?.node} done`
    } })
  db.pool = runtime.db.pool as never
  return { runtime, f, watcher, worker, checkStarted, checkGate, workerGate }
}

