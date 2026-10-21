import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeHistory } from '../src/modules/harnesses/port.js'
import { ReviewerDispatcher } from '../src/modules/interactions/reviewer.js'
import type { SessionWriteLease } from '../src/modules/interactions/sessionWriter.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'
import { rejectableDeferred } from './helpers/deferred.js'
import { br1002At } from './helpers/wave25Br1002Cuts.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('review history across observer handover', () => {
  it.each(['after publication', 'before publication'] as const)(
    'continues the original review when its observer stops %s', async handover => {
    const f = await routedApprovalFixture()
    const started = rejectableDeferred()
    const releaseOriginal = rejectableDeferred()
    const published = rejectableDeferred()
    const releaseSuccessor = rejectableDeferred()
    const capture = f.native.captureReviewNative.bind(f.native)
    const appendEvent = f.coordination.appendReviewNativeEvent.bind(f.coordination)
    const appendHistory = f.coordination.appendReviewNativeHistory.bind(f.coordination)
    const transition = f.coordination.transitionReviewJob.bind(f.coordination)
    let lane: SessionWriteLease | undefined
    let originalHistory: NativeHistory | undefined
    let successor: ReviewerDispatcher | undefined
    let originalDispatch: Promise<unknown> | undefined
    let successorDispatch: Promise<unknown> | undefined
    const captureSpy = vi.spyOn(f.native, 'captureReviewNative').mockImplementation((...args) => {
      lane = args[3]
      return capture(...args)
    })
    const eventSpy = vi.spyOn(f.coordination, 'appendReviewNativeEvent').mockImplementation(async (...args) => {
      if (args[1].type !== 'turn.started') return appendEvent(...args)
      if (handover === 'after publication') return appendEvent(...args)
      started.resolve()
      await releaseOriginal.promise
      lane!.guard.signal.throwIfAborted()
      await appendEvent(...args)
    })
    let acknowledged = false
    const transitionSpy = vi.spyOn(f.coordination, 'transitionReviewJob').mockImplementation(async (...args) => {
      const job = await transition(...args)
      if (!acknowledged && handover === 'after publication' && job.state === 'acknowledged') {
        acknowledged = true
        started.resolve()
        await releaseOriginal.promise
      }
      return job
    })
    let replayed = false
    const historySpy = vi.spyOn(f.coordination, 'appendReviewNativeHistory').mockImplementation(async (...args) => {
      if (replayed) return appendHistory(...args)
      replayed = true
      if (originalHistory) {
        if (!lane || !args[2]) throw new Error('The successor history has no active writer')
        const context = await f.coordination.getReviewJobContext(args[0].id)
        const saved = capture(f.reviewer.id, {
          harness: args[0].provider, providerVersion: context.providerVersion,
          nativeSessionId: args[0].nativeSessionId,
        }, args[0], lane, { type: 'history', history: originalHistory })
        await appendHistory(args[0], originalHistory.events, { ...args[2], nativeCapture: saved })
      }
      await appendHistory(...args)
      published.resolve()
      await releaseSuccessor.promise
    })
    try {
      originalDispatch = f.native.reviewers.dispatchNext(f.reviewerId, 'original-observer')
      await br1002At(started.promise, originalDispatch)
      const job = (await f.coordination.findReviewJob(f.interaction.id, f.reviewerId))!
      expect(job.state).toBe(handover === 'after publication' ? 'acknowledged' : 'submitted')
      const resident = f.native.passiveOwnedNativeSessions().find(value => value.execution.id === f.reviewer.id)!
      expect(lane).toBeDefined()
      if (handover === 'after publication') {
        originalHistory = await resident.manager.reconcile(resident.session, job.correlationId)
        await appendHistory(job, originalHistory.events, {
          writer: lane!.fence, live: false, terminalReady: false,
          nativeCapture: capture(f.reviewer.id, resident.session, job, lane!, {
            type: 'history', history: originalHistory,
          }),
        })
      }
      const saved = (await f.db.pool.query<{ proof_id: string; record: unknown }>(
        'select proof_id,record from review_native_proofs where job_id=$1 order by proof_id', [job.id])).rows
      expect(saved.length).toBeGreaterThan(0)
      const stopping = f.native.reviewers.shutdown()
      releaseOriginal.resolve()
      await stopping
      await expect(originalDispatch).rejects.toMatchObject({ code: 'ENGINE_RESTART' })
      successor = new ReviewerDispatcher(f.coordination, f.native)
      successorDispatch = successor.dispatchNext(f.reviewerId, 'replacement-observer')
      await br1002At(published.promise, successorDispatch)
      const recovered = (await f.coordination.findReviewJob(f.interaction.id, f.reviewerId))!
      expect(recovered.leaseToken).not.toBe(job.leaseToken)
      expect(recovered.providerTurnOrMessageId).toBe(job.providerTurnOrMessageId)
      const credential = await f.credentials.issueForReviewer(f.reviewer.id)
      const principal = await f.access.authenticate(credential.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker')
      const app = new PostgresAppInteractionService(f.db.pool, f.repository,
        new PostgresCommandCoordinator(f.db.pool), f.service)
      const response = await app.respond(principal, approvalResponse(f.interaction))
      expect(response.interaction.deliveryState).toBe('pending')
      expect(f.counts().responses).toBe(0)
      f.provider.completeReview(job.correlationId, job.nativeSessionId)
      releaseSuccessor.resolve()
      await successorDispatch
      await successor.dispatchNext(f.reviewerId, 'replacement-observer')
      expect((await f.service.recover({ limit: 10 })).errors).toEqual([])
      expect(await f.repository.get(f.interaction.id), 'native continuation must proceed after terminal history publication')
        .toMatchObject({ deliveryState: 'delivered' })
      expect(f.counts()).toMatchObject({ prompts: 3, responses: 1 })
      expect(await f.coordination.findReviewJob(f.interaction.id, f.reviewerId))
        .toMatchObject({ state: 'completed', providerTurnOrMessageId: job.providerTurnOrMessageId })
      expect((await f.db.pool.query('select proof_id,record from review_native_proofs where proof_id=any($1::text[]) order by proof_id',
        [saved.map(value => value.proof_id)])).rows).toEqual(saved)
    } finally {
      releaseOriginal.resolve()
      releaseSuccessor.resolve()
      await f.native.reviewers.shutdown()
      await successor?.shutdown()
      await Promise.allSettled([originalDispatch, successorDispatch].filter(value => value !== undefined))
      captureSpy.mockRestore()
      eventSpy.mockRestore()
      historySpy.mockRestore()
      transitionSpy.mockRestore()
      await f.close()
    }
  }, 60_000)
})
