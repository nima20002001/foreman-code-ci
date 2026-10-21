import { timeRuntimeOperation } from '../../src/infrastructure/runtimeTiming.js'
import type { Eng03NativeControl } from './eng03NativeAcceptance.js'

export async function waitForStartedBranches({ pool, runId, nodeIds, runs, publicationChanged }: Eng03NativeControl) {
  const deadline = Date.now() + 120_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<void>((resolve) => { timer = setTimeout(resolve, 120_000) })
  let started: Array<{ execution_id: string; native_session_id: string }> = []
  try {
    while (Date.now() < deadline) {
      const changed = publicationChanged()
      started = (await pool.query<{ execution_id: string; native_session_id: string }>(
        `select distinct he.id as execution_id,he.record->>'nativeSessionId' as native_session_id
         from harness_executions he join harness_native_events ne on ne.execution_id=he.id
         where he.run_id=$1 and he.workflow_node_id=any($2::text[])
           and ne.record->>'type'='turn.started' and he.record->>'nativeSessionId' is not null`,
        [runId, [nodeIds[1], nodeIds[2]]],
      )).rows
      if (started.length === 2 || (await runs.get(runId))?.executionState === 'completed') break
      await timeRuntimeOperation('engine', 'acceptance.publication_wait', () => Promise.race([changed, expired]),
        { runId })
    }
  } finally { clearTimeout(timer) }
  return started
}
