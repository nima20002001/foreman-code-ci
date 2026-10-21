import assert from 'node:assert/strict'
import { inspect } from 'node:util'

import { it } from 'vitest'

import { DomainError } from '../src/modules/errors.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { nativePersistenceRedactor } from '../src/modules/interactions/nativePersistence.js'
import { correlationId, event, historicalSecret, permission, providerId, reviewerFixture, secret, session, terminal, sourceTerminal } from './helpers/reviewerAudit.js'

function assertNoSecrets(value: unknown): void {
  const representation = inspect(value, { depth: null })
  assert.equal(representation.includes(secret), false)
  assert.equal(representation.includes(historicalSecret), false)
}

it('F3/F6: live reviewer-native approval fails durably, records exact request, cancels exact turn and never self-approves', async () => {
  const fixture = await reviewerFixture({ silent: true })
  const pending = permission()
  fixture.hooks.pending = pending
  const accepted = structuredClone(fixture.run.approval)
  const result = await fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
  assert.equal(result?.state, 'failed')
  assert.equal(result.error?.code, 'REVIEWER_NATIVE_APPROVAL_UNSUPPORTED')
  assert.ok(result.error?.message.includes(pending.turn.nativeRequestId!))
  assert.ok(result.error?.message.includes('Stop this Run'))
  assert.equal(fixture.responses, 0)
  assert.equal(fixture.starts.length, 1)
  assert.deepEqual(fixture.cancellations, [{ session, nativeTurnId: providerId }])
  assert.deepEqual(fixture.revoked, [fixture.credential.principalId])
  assert.deepEqual(fixture.run.approval, accepted)
  assert.equal(await fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker'), undefined)
  assertNoSecrets(fixture.saved)
  assert.ok(result.error?.message.includes(pending.turn.nativeRequestId!))
  assert.ok(fixture.saved.jobs.find((job) => job.state === 'failed'
    && job.error?.code === 'REVIEWER_NATIVE_APPROVAL_UNSUPPORTED' && job.cleanup))
})

it.each(['list', 'single'] as const)('cold pending native approval on an unbound lane preserves cleanup without prompt replay: %s', async source => {
  const fixture = await reviewerFixture({ recovering: true, recoveredLane: 'unbound' })
  fixture.setHistory({ correlationId, nativeTurnId: providerId, events: [],
    pendingInteractions: source === 'list' ? [permission()] : [],
    ...(source === 'single' ? { pendingInteraction: permission() } : {}) })
  const result = await fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
  assert.equal(result?.state, 'failed')
  assert.equal(result.providerTurnOrMessageId, providerId)
  assert.equal(result.error?.code, 'REVIEWER_NATIVE_APPROVAL_UNSUPPORTED')
  assert.equal(fixture.starts.length, 0)
  assert.equal(fixture.responses, 0)
  // The recovered lane was never durably bound to this review, so cleanup must not target it.
  assert.deepEqual(fixture.cancellations, [])
  assert.equal(result.cleanup?.nativeState, 'pending')
  assert.equal(result.cleanup?.interruptState, 'not_sent')
  assert.equal((await fixture.coordination.getLane(session.harness, session.nativeSessionId))?.currentTurnOrMessageId, undefined)
  assertNoSecrets(fixture.saved)
})

it('cold pending native approval on a bound lane cancels its recovered turn without prompt replay', async () => {
  const fixture = await reviewerFixture({ recovering: true, recoveredLane: 'bound' })
  fixture.setHistory({ correlationId, nativeTurnId: providerId, events: [], pendingInteractions: [permission()] })
  const result = await fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
  assert.equal(result?.state, 'failed')
  assert.equal(result.providerTurnOrMessageId, providerId)
  assert.equal(result.error?.code, 'REVIEWER_NATIVE_APPROVAL_UNSUPPORTED')
  assert.equal(fixture.starts.length, 0)
  assert.equal(fixture.responses, 0)
  assert.deepEqual(fixture.cancellations, [{ session, nativeTurnId: providerId }])
  assert.equal(result.cleanup?.interruptState, 'acknowledged')
  assert.equal(result.cleanup?.nativeState, 'pending')
  assertNoSecrets(fixture.saved)
})

it('F3: failed native cancellation stays visible and is never treated as successful delivery', async () => {
  const fixture = await reviewerFixture({ silent: true })
  fixture.hooks.pending = permission()
  fixture.hooks.cancelError = new Error(`Provider could not cancel ${secret} ${historicalSecret}`)
  const result = await fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
  assert.equal(result?.state, 'failed')
  assert.equal(result.cleanup?.nativeState, 'pending')
  assert.equal(result.cleanup?.interruptState, 'submitted')
  assert.equal(fixture.responses, 0)
  assertNoSecrets(result)
  assertNoSecrets(fixture.saved)
  // Release the deliberately abort-ignoring fake provider, not another native submission.
  fixture.finish()
})

it('F3: a mismatched pending session/turn is never canceled as the current review', async () => {
  const fixture = await reviewerFixture({ recovering: true })
  const pending = permission()
  pending.session = { ...session, nativeSessionId: 'other-session' }
  fixture.setHistory({ ...terminal(), pendingInteraction: pending })
  const result = await fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
  assert.equal(result?.state, 'failed')
  assert.equal(fixture.cancellations.length, 0)
  assert.equal(fixture.responses, 0)
  assert.equal(fixture.starts.length, 0)
})

it('F3: enqueue refuses a reviewer that is also the requesting Agent', async () => {
  const fixture = await reviewerFixture()
  await assert.rejects(fixture.dispatcher.enqueue({ ...fixture.interaction, approval: fixture.run.approval },
    fixture.execution.agentId, session, { executionId: fixture.execution.id, workingDirectory: fixture.execution.workingDirectory! }),
  (error: unknown) => error instanceof DomainError && error.code === 'REVIEWER_ASSIGNMENT_MISMATCH')
  assert.equal(fixture.starts.length, 0)
})

it('F6: reviewer live events and recovered native history are redacted before the persistence boundary', async () => {
  const live = await reviewerFixture({ events: 3 })
  assert.equal((await live.dispatcher.dispatchNext(live.job.reviewerAgentId, 'worker'))?.state, 'completed')
  assert.equal(live.saved.events.length, 5)
  assertNoSecrets(live.saved)
  assert.match(JSON.stringify(live.saved.events), /\[REDACTED\]/)
  const recovered = await reviewerFixture({ recovering: true })
  recovered.setHistory({ ...sourceTerminal(), events: [...sourceTerminal().events, event('item.output', { text: `${secret} ${historicalSecret}`, turnId: providerId })] })
  assert.equal((await recovered.dispatcher.dispatchNext(recovered.job.reviewerAgentId, 'worker'))?.state, 'completed')
  assertNoSecrets(recovered.saved)
  assert.ok(JSON.stringify(recovered.saved.events).includes(providerId), 'provider identity is retained')
})

it('F6: terminal recovery redacts both events and result/output after confirmed approval delivery', async () => {
  const fixture = await reviewerFixture({ workflow: true })
  const expectedCorrelation = `execution:${fixture.execution.id}`
  const history = terminal(expectedCorrelation)
  history.events = [event('item.output', { stdout: `${secret} ${historicalSecret}`, turnId: providerId })]
  history.terminalTurn!.result = { outcome: 'succeeded', output: { nested: [secret, historicalSecret] } }
  fixture.setHistory(history)
  const original = structuredClone(fixture.interaction)
  assert.equal((await fixture.observeWorkflow()).state, 'completed')
  assertNoSecrets(fixture.saved)
  assertNoSecrets(fixture.execution)
  assert.equal(fixture.execution.state, 'completed')
  assert.deepEqual(fixture.execution.result?.output, { nested: ['[REDACTED]', '[REDACTED]'] })
  assert.deepEqual(fixture.interaction, original)
  assert.equal(fixture.interaction.deliveryState, 'delivered')
  assert.equal(fixture.responses, 0)
  assert.equal(fixture.starts.length, 0)
  assert.equal(fixture.execution.result?.outcome, 'succeeded')
})

it('F6: replay redaction is identical across different process credential contexts', () => {
  const otherToken = `opm_${'b'.repeat(43)}`
  const snapshot = event('item.output', { text: `${historicalSecret} ${otherToken}`, turnId: providerId })
  const oldOwner = nativePersistenceRedactor([historicalSecret])
  const newOwner = nativePersistenceRedactor([otherToken])
  assert.deepEqual(oldOwner.value(snapshot), newOwner.value(snapshot))
  assert.deepEqual(oldOwner.value(snapshot), newOwner.value(oldOwner.value(snapshot)))
  assert.equal(newOwner.value(snapshot).payload.turnId, providerId)
})

it('F6: known and historical tokens are scrubbed from nested JSON, keys and escaped provider strings', () => {
  const redactor = nativePersistenceRedactor([secret])
  const escapedOld = historicalSecret.replace(/./g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
  const escapedKnown = secret.replace(/./g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
  const input = { [secret]: [secret, historicalSecret], raw: `{"stdout":"${escapedKnown}","stderr":"${escapedOld}"}` }
  const safe = redactor.value(input)
  assertNoSecrets(safe)
  const decoded = JSON.parse(safe.raw) as { stdout: string; stderr: string }
  assert.equal(decoded.stdout, '[REDACTED]')
  assert.equal(decoded.stderr, '[REDACTED]')
  assertNoSecrets(decoded)
})

it('F6: Domain/Harness/Aggregate/cause errors cannot export raw tokens or provider environment fields', () => {
  const redactor = nativePersistenceRedactor([secret])
  const domain = new DomainError('TEST_FAILURE', secret, 409, { nested: historicalSecret })
  const provider = new HarnessExecutionError('PROVIDER_FAILURE', historicalSecret)
  const error = Object.assign(new Error(secret, { cause: domain }), { environment: { GRAPHQL_MCP_TOKEN: secret } })
  const safe = redactor.error(new AggregateError([domain, provider, error], `${secret} ${historicalSecret}`))
  assertNoSecrets(safe)
  assert.ok(safe instanceof AggregateError)
  assert.ok(safe.errors[0] instanceof DomainError)
  assert.equal(safe.errors[0].code, 'TEST_FAILURE')
  assert.ok(safe.errors[1] instanceof HarnessExecutionError)
  assert.equal(safe.errors[2].environment, undefined)
})

it('F6: reviewer stream failures store only redacted errors and keep ambiguous delivery non-retryable', async () => {
  const fixture = await reviewerFixture()
  fixture.hooks.streamError = new Error(`Disconnected ${secret} ${historicalSecret}`)
  const result = await fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
  assert.equal(result?.state, 'uncertain')
  assert.equal(result.error?.code, 'REVIEW_DELIVERY_UNCERTAIN')
  assert.ok(result.submittedAt)
  assertNoSecrets(result)
  assertNoSecrets(fixture.saved)
  assert.equal(fixture.starts.length, 1)
})

it('F6: terminal recovery reconcile failures are redacted before reaching error/audit callers', async () => {
  const fixture = await reviewerFixture({ workflow: true })
  fixture.hooks.history = async () => { throw new DomainError('PROVIDER_FAILED', `${secret} ${historicalSecret}`, 409, { output: secret }) }
  await assert.rejects(fixture.observeWorkflow(),
    (error: unknown) => { assertNoSecrets(error); return error instanceof DomainError && error.code === 'PROVIDER_FAILED' })
  assert.equal(fixture.saved.executions.length, 0)
})

it('F6: attach/cleanup failures redact before credentials are released', async () => {
  const fixture = await reviewerFixture({ workflow: true })
  fixture.hooks.attachError = new Error(`Attach ${secret} ${historicalSecret}`)
  fixture.hooks.closeError = new Error(`Close ${secret} ${historicalSecret}`)
  await assert.rejects(fixture.observeWorkflow(),
    (error: unknown) => { assertNoSecrets(error); return error instanceof Error })
  assertNoSecrets(fixture.saved)
})

it('F3: every simultaneously recovered permission keeps its exact identity in the durable failure', async () => {
  const fixture = await reviewerFixture({ recovering: true })
  const first = permission()
  const second = { ...permission(), turn: { nativeTurnId: providerId, nativeRequestId: 'second-permission-exact' } }
  fixture.setHistory({ correlationId, nativeTurnId: providerId, events: [], pendingInteractions: [first, second], pendingInteraction: first })
  const result = await fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
  assert.equal(result?.state, 'failed')
  assert.ok(result.error?.message.includes(first.turn.nativeRequestId!))
  assert.ok(result.error?.message.includes(second.turn.nativeRequestId))
  assert.equal(result.cleanup?.nativeState, 'pending')
  assertNoSecrets(fixture.saved)
  assert.equal(fixture.responses, 0)
  assert.equal(fixture.starts.length, 0)
})

it('F6: recovered failure results are redacted before execution storage and Run details', async () => {
  const fixture = await reviewerFixture({ workflow: true })
  const history = terminal(`execution:${fixture.execution.id}`)
  history.terminalTurn!.result = { outcome: 'failed', error: { code: 'NATIVE_FAILED', message: `${secret} ${historicalSecret}`, retryable: false } }
  fixture.setHistory(history)
  assert.equal((await fixture.observeWorkflow()).state, 'completed')
  assertNoSecrets(fixture.execution)
  assertNoSecrets(fixture.saved)
  assert.equal(fixture.execution.result?.error?.code, 'NATIVE_FAILED')
})
