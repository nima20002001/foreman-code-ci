import { vi } from 'vitest'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { codexApprovalRuntime } from './codexApprovalRuntime.js'
import { rejectableDeferred } from './deferred.js'
import type { agent3Database } from './wave25Agent3.js'
import { masterApprovalFixture, masterApprovalOutput } from './masterApprovalFixture.js'

/** Shared Save/Start and Codex adapter capture with replayed provider IO. */
export async function approvalDatabase(options: {
  command?: string
  reviewerRole?: 'orchestrator' | 'master'
  database?: Awaited<ReturnType<typeof agent3Database>>
} = {}) {
  const runtime = await codexApprovalRuntime('orchestrator', {
    ...options,
    ...(options.reviewerRole === 'master' ? {
      fixture: masterApprovalFixture(), workflowOutput: masterApprovalOutput,
    } : {}),
  })
  const reconcile = vi.spyOn(runtime.native.reviewers, 'reconcile').mockResolvedValue(undefined)
  const live = rejectableDeferred<void>(), release = rejectableDeferred<void>()
  const issuance = vi.spyOn(runtime.credentials, 'issueForReviewer')
  let dispatch: Promise<unknown> | undefined
  const append = runtime.repository.coordination.appendReviewNativeEvent.bind(runtime.repository.coordination)
  const capture = vi.spyOn(runtime.repository.coordination, 'appendReviewNativeEvent').mockImplementation(async (...args) => {
    await append(...args)
    if (args[2]?.live && args[1].type === 'turn.started'
      && args[1].payload.turnId === args[0].providerTurnOrMessageId) {
      live.resolve(); await release.promise
    }
  })
  async function close() {
    release.resolve()
    await runtime.native.reviewers.shutdown()
    await dispatch?.catch(() => {
      // ignore: shutdown preserves the caller's assertion failure while joining the review task.
    })
    capture.mockRestore(); reconcile.mockRestore(); issuance.mockRestore()
    await runtime.close()
  }
  try {
    await runtime.engine.start(runtime.f.run.id)
    const [interaction] = await runtime.pending()
    if (!interaction?.approval.designatedOrchestratorAgentId) throw new Error('Expected original routed approval')
    const queued = await runtime.repository.coordination.findReviewJob(interaction.id, interaction.approval.designatedOrchestratorAgentId)
    if (!queued) throw new Error('Expected coordinator review job')
    dispatch = runtime.native.reviewers.dispatchNext(queued.reviewerAgentId, 'approval-consumer')
    void dispatch.catch(() => {
      // ignore: the startup race, settle method and close method observe this task's outcome.
    })
    let settled = 'pending'
    dispatch.then(() => { settled = 'resolved' }, (e) => { settled = 'rejected ' + String(e) })
    const watchdog = setTimeout(async () => {
      const q = async (sql: string) => JSON.stringify((await runtime.db.pool.query(sql)).rows).slice(0, 3000)
      console.error('DEBUGHANG', settled)
      console.error('DEBUGHANG executions', await q("select id,record->>'state' st,record->>'agentId' ag,record->'result' res from harness_executions"))
      console.error('DEBUGHANG jobs', await q('select * from review_jobs'))
      console.error('DEBUGHANG activity', await q('select source,kind,payload from run_activity order by 1 limit 30'))
      console.error('DEBUGHANG run', await q("select execution_state, record->>'outcome' o from runs"))
    }, 20000)
    await Promise.race([live.promise, dispatch.then(() => { throw new Error('Review ended before acknowledgement') })]).finally(() => clearTimeout(watchdog))
    const executions = (await runtime.runs.listRepeatExecutions(runtime.f.run.id)).map((row) => row.execution)
    const reviewer = executions.find((e) => e.agentId === queued.reviewerAgentId)!
    const requester = executions.find((e) => e.id === interaction.executionId)!
    const job = (await runtime.repository.coordination.findReviewJob(interaction.id, reviewer.agentId))!
    const issued = issuance.mock.results.at(-1)
    if (issued?.type !== 'return') throw new Error('Expected actual dispatcher reviewer credential')
    const credential = await issued.value
    const principal = await runtime.access.authenticate(credential.environment.variables.GRAPHQL_MCP_TOKEN, 'worker')
    return { ...runtime, pool: runtime.db.pool, close, interaction, reviewer, requester, job, credential, principal,
      commands: new PostgresCommandCoordinator(runtime.db.pool),
      version: runtime.f.version, run: runtime.f.run, scope: runtime.f.scope,
      resumeObservation: () => release.resolve(),
      async settle() {
        const provider = runtime.providers.get(reviewer.id)!
        provider.completeReview(job.correlationId, job.nativeSessionId)
        release.resolve()
        await dispatch
      },
    }
  } catch (error) { await close(); throw error }
}
