import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { vi } from 'vitest'
import { codexApprovalRuntime } from './codexApprovalRuntime.js'

/** Shared Save/Start and Codex adapter events with replayed external provider IO. */
export async function routedApprovalFixture(options: Parameters<typeof codexApprovalRuntime>[1] = {}) {
  const runtime = await codexApprovalRuntime('orchestrator', options)
  try {
    // Tests control dispatch timing; enqueue and every lease/evidence transition
    // still use the production coordinator and dispatcher.
    vi.spyOn(runtime.native.reviewers, 'reconcile').mockResolvedValue(undefined)
    await runtime.engine.start(runtime.f.run.id)
    const [interaction] = await runtime.pending()
    if (!interaction?.approval.designatedOrchestratorAgentId) throw new Error('Missing routed Worker request')
    const job = await runtime.repository.coordination.findReviewJob(interaction.id, interaction.approval.designatedOrchestratorAgentId)
    if (!job) throw new Error('Missing coordinator-enqueued review')
    const executions = (await runtime.db.pool.query('select record from harness_executions where run_id=$1 order by id', [runtime.f.run.id])).rows.map((row) => HarnessExecutionSchema.parse(row.record))
    const reviewer = executions.find((execution) => execution.agentId === job.reviewerAgentId)!
    const requester = executions.find((execution) => execution.id === interaction.executionId)!
    const provider = runtime.providers.get(reviewer.id)!
    return { ...runtime, interaction, job, reviewer, requester, provider,
      reviewerId: reviewer.agentId, run: runtime.f.run, version: runtime.f.version,
      interactions: runtime.repository, coordination: runtime.repository.coordination }
  } catch (error) { await runtime.close(); throw error }
}
