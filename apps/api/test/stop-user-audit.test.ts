import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { it, vi } from 'vitest'
import type { DurableInteraction } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { DomainError } from '../src/modules/errors.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import type { InteractionService } from '../src/modules/interactions/service.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import { localHumanPrincipal } from '../src/modules/access/localHuman.js'
import { registerUserInteractions } from '../src/routes/userInteractions.js'
import { projectInteractionActivity } from '../src/modules/interactions/activityProjection.js'

it('F11: failed cleanup remains retryable after terminal settlement and a fresh engine instance', async () => {
  // This test begins AFTER business settlement. The retired fixture synthesized
  // a terminal Run inside settleOrphan even when physical closure had failed.
  // Current V3 instead preserves the accepted result while cleanup is retried.
  const f = makeCurrentWorkflowFixture('pr17-stop-user-audit', 'single')
  const record = AcceptedWorkflowRunV3Schema.parse({ ...f.run, executionState: 'completed',
    outcome: 'succeeded', result: { outcome: 'succeeded' }, finishedAt: f.createdAt,
    authorizationPrincipalId: 'principal-pr17-cleanup', executionLocation: { runnerId: 'runner-pr17-cleanup',
      rootPath: '/synthetic/pr17-stop-user-audit', locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } })
  const original = structuredClone(record)
  let pending = true
  let fail = true
  let attempts = 0
  let releases = 0
  const owner = { runId: record.id, assertOwned() {}, async release() { releases++ } } as unknown as RunOwnership
  const runs = {
    repeatRepositoryFactory: () => ({}),
    async requestCleanup() { pending = true },
    async finishCleanup(_id: string, failed: boolean, actual: RunOwnership) {
      assert.equal(actual, owner)
      pending = failed
    },
    async acquireOwnership(id: string) { assert.equal(id, record.id); return owner },
    async getRepeatSnapshot(id: string, actual?: RunOwnership) {
      assert.equal(id, record.id)
      if (actual) assert.equal(actual, owner)
      return { run: structuredClone(record), version: f.version, configurations: f.configurations,
        stopRequested: false, cleanupPending: pending }
    },
  }
  let nativeOwner: RunOwnership | undefined
  const nativeExecutions = {
    adoptRunOwner: (actual: RunOwnership) => { actual.assertOwned(); nativeOwner = actual },
    async finishRun(id: string) {
      assert.equal(id, record.id)
      attempts++
      if (attempts > 1) assert.equal(nativeOwner, owner)
      if (fail) throw new Error('native close failed')
    },
    cancelRun: vi.fn(async () => { throw new Error('Successful terminal cleanup must not cancel the Run') }),
  }
  type Args = ConstructorParameters<typeof LangGraphWorkflowEngine>
  const freshEngine = () => new LangGraphWorkflowEngine(runs as unknown as Args[0], {} as Args[1],
    nativeExecutions as unknown as Args[2], {} as Args[3], '/synthetic/pr17-stop-user-audit',
    {} as Args[5], {} as Args[6], {} as Args[7])
  await assert.rejects(freshEngine().cancel(record.id), /native close failed/)
  assert.equal(record.executionState, 'completed')
  assert.equal(pending, true)
  assert.equal(attempts, 2, 'the owner rechecks physical cleanup after the initial best-effort close')
  assert.deepEqual(record, original, 'uncertain cleanup must not rewrite the accepted Run')
  fail = false
  assert.equal(await freshEngine().cancel(record.id), true)
  assert.equal(attempts, 5, 'retry performs the physical, owned-cleanup and terminal-finalization passes')
  assert.equal(releases, 2, 'both fresh engine instances release their actual cleanup owner')
  assert.equal(pending, false)
  assert.deepEqual(record, original, 'cleanup success must not rewrite the business outcome or immutable pins')
  assert.equal(nativeExecutions.cancelRun.mock.calls.length, 0)
})

function userInteraction(): DurableInteraction {
  return { id: 'interaction-user', revision: 0, workspaceId: 'workspace', workflowId: 'workflow', runId: 'run',
    executionId: 'execution', requestingAgentId: 'coder', harness: 'codex', providerVersion: '0.154.0',
    nativeSessionId: 'session', nativeRequestId: 'request', nativeRequestType: 'item/commandExecution/requestApproval',
    graphThreadId: 'run', request: {}, approval: { handler: 'user' },
    responseOptions: [{ optionId: 'choice', label: 'Approve once', semantic: 'approve_once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    status: 'pending', deliveryState: 'not_started', createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' }
}

it('local human approval routes expose response authority and exclude agent credentials', async () => {
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
    .send({ error: error instanceof Error ? error.message : 'Unknown error' }))
  const record = userInteraction()
  const reader = { ...localHumanPrincipal, id: 'reader', grants: [{ actions: ['capabilities:read' as const], scope: {} }] }
  const access = { authenticate: async () => reader } as unknown as PostgresAccessService
  registerOperatorHttpSecurity(app, access)
  const respond = vi.fn(async (actor: { kind: string; principal?: { id: string } }) => {
    assert.equal(actor.kind, 'user')
    assert.equal(actor.principal?.id, localHumanPrincipal.id)
    return { interaction: { ...record, revision: 1, selectedOptionId: 'choice', selectedSemantic: 'approve_once', nativeResponse: null,
      decidedAt: '2026-09-16T00:00:01.000Z', deliveredAt: '2026-09-16T00:00:02.000Z', status: 'delivered', deliveryState: 'delivered' }, replayed: false }
  })
  const readActivity = vi.fn(async (current: DurableInteraction, authorized: boolean) => projectInteractionActivity(current,
    { response: { authorized, qualified: true, usable: true, path: 'live_callback', identity: { interactionId: current.id,
      revision: current.revision, sessionId: current.nativeSessionId, requestId: current.nativeRequestId, executionId: current.executionId } } }))
  const interactions = { get: async () => record, readActivity, respond } as unknown as InteractionService
  registerUserInteractions(app, interactions)
  const headers = { host: '127.0.0.1:4100', origin: 'http://127.0.0.1:5173' }
  const url = `/api/user/interactions/${record.id}`
  const payload = { interactionId: record.id, optionId: 'choice', expectedRevision: 0 }
  try {
    const detail = await app.inject({ method: 'GET', url, headers })
    assert.equal(detail.statusCode, 200, detail.body)
    assert.equal(detail.json().canRespond, true)
    assert.deepEqual(readActivity.mock.calls.map((call) => call[1]), [true])
    const unavailable = { ...record, approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'reviewer' } }
    const agentRead = await app.inject({ method: 'GET', url, headers: { ...headers, authorization: 'Bearer reader-token' } })
    assert.equal(agentRead.statusCode, 403)
    const agentWrite = await app.inject({ method: 'POST', url: `${url}/respond`,
      headers: { ...headers, authorization: 'Bearer reader-token' }, payload })
    assert.equal(agentWrite.statusCode, 403)
    const foreign = await app.inject({ method: 'POST', url: `${url}/respond`,
      headers: { ...headers, origin: 'https://foreign.example' }, payload })
    assert.equal(foreign.statusCode, 403)
    assert.equal(respond.mock.calls.length, 0)
    const accepted = await app.inject({ method: 'POST', url: `${url}/respond`,
      headers: { ...headers, cookie: 'graphql_operator=obsolete' }, payload })
    assert.equal(accepted.statusCode, 200, accepted.body)
    assert.equal(respond.mock.calls.length, 1)
    Object.assign(record, unavailable)
    const hidden = await app.inject({ method: 'GET', url, headers })
    assert.equal(hidden.statusCode, 404)
  } finally { await app.close() }
})
