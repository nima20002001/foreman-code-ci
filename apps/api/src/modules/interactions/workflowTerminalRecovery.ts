import { isDeepStrictEqual } from 'node:util'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'
import { beforeGraphCommit } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import { readWorkflowClosure } from './workflowClosure.js'

function pending(): never {
  throw new DomainError('REPEAT_CLEANUP_PENDING',
    'The exact recovered workflow lifetime has not finished resource settlement.', 409)
}

/** Repair the crash between physical close and workflow credential revocation.
 * Capture only immutable principal IDs of this execution's WORKFLOW purpose.
 * Never revokeForExecution: a separately finalized reviewer can own a successor
 * credential on the same execution. The ordinary settlement gate still checks
 * all credentials, budgets, original terminal provenance and native ACKs. */
export async function finishRecoveredWorkflowCredentials(owner: RunOwnership, execution: HarnessExecution,
  credentials: ExecutionCredentialProvider | undefined, signal: AbortSignal): Promise<void> {
  const check = () => { owner.assertOwned(); signal.throwIfAborted() }
  check()
  if (execution.runId !== owner.runId || execution.state !== 'completed'
    || !execution.result || !execution.finishedAt || !execution.nativeSessionId) return pending()
  const captured = await owner.oneShotConnection().transaction(async (sql) => {
    check()
    const parent = await sql.query('select id from runs where id=$1 for update', [owner.runId])
    const row = (await sql.query<{ record: unknown }>(
      'select record from harness_executions where id=$1 and run_id=$2 for update', [execution.id, owner.runId])).rows[0]
    if (parent.rowCount !== 1 || !row
      || !isDeepStrictEqual(HarnessExecutionSchema.parse(row.record), execution)) return pending()
    const fence = await owner.readOneShotFence(sql)
    const proof = await readWorkflowClosure(sql, execution)
    if (!proof) return pending()
    const bindings = await sql.query<{ principal_id: string }>(`select b.principal_id
      from worker_credential_bindings b
      where b.execution_id=$1 and b.run_id=$2 and b.agent_id=$3 and b.purpose='workflow'
      order by b.principal_id for share`, [execution.id, owner.runId, execution.agentId])
    beforeGraphCommit(sql, async () => {
      check()
      if (!isDeepStrictEqual(fence, await owner.readOneShotFence(sql))
        || !isDeepStrictEqual(proof, await readWorkflowClosure(sql, execution))) return pending()
    })
    return { proof, principalIds: bindings.rows.map((binding) => binding.principal_id) }
  })
  check()
  if (captured.principalIds.length && !credentials) return pending()
  // No SQL locks span the credential service's own transaction. The immutable
  // captured IDs remain safe even if a reviewer is admitted after our commit.
  for (const principalId of captured.principalIds) {
    check()
    await credentials!.revoke({ principalId })
    check()
  }
  await owner.oneShotConnection().transaction(async (sql) => {
    check()
    const fence = await owner.readOneShotFence(sql)
    if (!isDeepStrictEqual(captured.proof, await readWorkflowClosure(sql, execution))) return pending()
    beforeGraphCommit(sql, async () => {
      check()
      if (!isDeepStrictEqual(fence, await owner.readOneShotFence(sql))
        || !isDeepStrictEqual(captured.proof, await readWorkflowClosure(sql, execution))) return pending()
    })
  })
  check()
}
