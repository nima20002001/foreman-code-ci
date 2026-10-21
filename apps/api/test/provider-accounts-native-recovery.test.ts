import { OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, it, vi } from 'vitest'
import type { ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { captureOriginalCodexSession } from '../src/modules/harnesses/originalCodexSession.js'
import { collect, until, fixtureQualification } from './fixtures/codex-test-helpers.js'
import { f, source, managers, useCodexFixture, wire } from './codex-app-server.test-support.js'
import type { ResolvedProviderAccount } from '../src/modules/provider-accounts/service.js'

const { NativeHarnessFactories } = await import('../src/modules/harnesses/runtimeFactory.js')

function fixture() {
  const first = randomUUID()
  const second = randomUUID()
  const binding: ProviderAccountBinding = { kind: 'slot', accountId: first, provider: 'codex',
    bindingRevision: 1, profileRef: randomUUID(), subject: null,
    target: { hostRef: { kind: 'main', mainId: randomUUID() }, applicationInstallationId: randomUUID(),
      keyRevision: null, authorizationRevision: null } }
  const account: ResolvedProviderAccount = { accountId: first, homePath: join(f.directory, 'account-profile'),
    authMode: 'subscription', binding }
  let available = true
  let defaultId = first
  const resolve = vi.fn(async (_provider: 'codex' | 'claude', id?: string) => {
    if (id === first && !available) return null
    return id === first ? account : { ...account, accountId: defaultId }
  })
  const environments: NodeJS.ProcessEnv[] = []
  const accepted = structuredClone(source)
  if (accepted.request.configuration.harness.harness !== 'codex') throw new Error('Codex fixture required')
  accepted.request.configuration.harness.accountId = first
  const recovery = { root: join(f.directory, 'processes'), owner: 'execution:accepted' }
  const factories = new NativeHarnessFactories({ codexBinary: f.binary, accounts: { resolve } }, {
    mode: 'native', codex: { mode: 'native',
      qualify: async (binary, cwd, environment, authenticated, signal) => {
        environments.push(environment)
        return fixtureQualification(binary, cwd, environment, authenticated, signal)
      },
      assertUnchanged: async () => undefined },
  })
  const allocate = (owner = recovery.owner, accountSourceRecovery?: typeof recovery,
    role: 'workflow' | 'operator' = 'workflow') => {
    const result = factories.allocate({ harness: 'codex', role, ownerAgentId: 'recorded-agent',
      workingDirectory: f.directory, appMcpAccess: 'scoped', accountBinding: binding,
      accountRecovery: { ...recovery, owner }, ...(accountSourceRecovery ? { accountSourceRecovery } : {}),
      configured: { instanceId: 'recorded-profile', instanceRevision: '1', enabled: true, driverId: 'codex',
        configuration: accepted.request.configuration.harness } })
    managers.push(result.manager)
    return result.manager
  }
  return { accepted, account, binding, allocate, resolve, environments, recovery,
    changeDefault: () => { defaultId = second }, remove: () => { available = false } }
}

describe('accepted accounts through native factory and adapter recovery', () => {
  useCodexFixture({ requestTimeoutMs: 5_000 })

  it('starts queued accepted A under A after default B is selected', async () => {
    const test = fixture()
    test.changeDefault()
    const manager = test.allocate()
    const session = await manager.createSession(test.accepted)
    assert.equal(session.harness, 'codex')
    assert(test.resolve.mock.calls.length >= 1)
    assert(test.resolve.mock.calls.every(call => call[1] === test.account.accountId))
    assert.equal(test.environments[0]!.CODEX_HOME, test.account.homePath)
    assert.equal((await wire('thread/start')).length, 1)
  })

  it('reattaches the original resident process after removal without replacement or account lookup', async () => {
    const test = fixture()
    const manager = test.allocate()
    const session = await manager.createSession(test.accepted)
    const original = captureOriginalCodexSession(manager, session, test.accepted, () => undefined)
    assert(original)
    test.changeDefault()
    test.remove()
    test.resolve.mockClear()
    assert.deepEqual(await original.reattach(), session)
    assert.equal(test.resolve.mock.calls.length, 0)
    assert.equal((await wire('thread/start')).length, 1)
    assert.equal((await wire('thread/resume')).length, 0)
  })

  it('cold-resumes only the accepted A thread and explicitly rejects unavailable A', async () => {
    const test = fixture()
    const original = test.allocate()
    const session = await original.createSession(test.accepted)
    await original.close(session)
    test.changeDefault()
    const recovered = test.allocate()
    assert.deepEqual(await recovered.attachSession(session, test.accepted), session)
    assert.equal((await wire('thread/start')).length, 1)
    assert.equal((await wire('thread/resume')).length, 1)
    assert(test.environments.every(environment => environment.CODEX_HOME === test.account.homePath))
    await recovered.close(session)
    test.remove()
    await assert.rejects(test.allocate().attachSession(session, test.accepted), /unavailable/)
    assert.equal((await wire('thread/start')).length, 1)
    assert.equal((await wire('thread/resume')).length, 1)
  })

  it('retries an accepted Operator session on A after the default changes without a new thread or prompt', async () => {
    const test = fixture()
    const configuration = OperatorConfigurationVersionSchema.parse({ id: randomUUID(),
      operatorId: test.accepted.request.configuration.agentId, version: 1,
      harness: test.accepted.request.configuration.harness,
      contentHash: commandInputHash(test.accepted.request.configuration.harness), createdAt: new Date().toISOString() })
    const accepted = { kind: 'operator' as const, configuration, correlationId: 'accepted-operator-command',
      workingDirectory: f.directory, ...(test.accepted.environment ? { environment: test.accepted.environment } : {}) }
    const original = test.allocate('conversation:operator-retry', undefined, 'operator')
    const session = await original.createSession(accepted)
    await original.close(session)
    test.changeDefault()
    const retry = test.allocate('conversation:operator-retry', undefined, 'operator')
    assert.deepEqual(await retry.attachSession(session, accepted), session)
    assert.equal((await wire('thread/start')).length, 1)
    assert.equal((await wire('thread/resume')).length, 1)
    assert.equal((await wire('turn/start')).length, 0)
    assert(test.resolve.mock.calls.every(call => call[1] === test.account.accountId))
  })

  it('keeps Stop on the original accepted turn after its account becomes unavailable', async () => {
    const test = fixture()
    const manager = test.allocate()
    const session = await manager.createSession(test.accepted)
    const events = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'accepted-turn' }))
    await until(async () => (await manager.history(session)).events.some(event =>
      event.type === 'turn.started' && event.payload.clientCorrelationId === 'accepted-turn'))
    const original = captureOriginalCodexSession(manager, session, test.accepted, () => undefined)
    assert(original)
    test.changeDefault()
    test.remove()
    test.resolve.mockClear()
    assert.equal(await original.cancel(), true)
    await events
    assert.equal(test.resolve.mock.calls.length, 0)
    assert.equal((await wire('thread/start')).length, 1)
    assert.equal((await wire('thread/resume')).length, 0)
    const interrupted = await wire('turn/interrupt')
    assert.equal(interrupted.length, 1)
    assert.equal((interrupted[0]!.params as { turnId: string }).turnId, original.residency.nativeTurnId)
  })

  it('forks the source A once and resumes the independent fork without changing the source session', async () => {
    const test = fixture()
    const original = test.allocate()
    const sourceSession = await original.createSession(test.accepted)
    test.changeDefault()
    const child = test.allocate('conversation:source-chat', test.recovery)
    const fork = await child.forkSession(sourceSession, test.accepted)
    assert.notEqual(fork.nativeSessionId, sourceSession.nativeSessionId)
    await child.close(fork)
    const recovered = test.allocate('conversation:source-chat', test.recovery)
    assert.deepEqual(await recovered.attachSession(fork, test.accepted), fork)
    assert.equal((await wire('thread/start')).length, 1)
    assert.equal((await wire('thread/fork')).length, 1)
    assert.equal((await wire('thread/resume')).length, 1)
    assert(test.environments.every(environment => environment.CODEX_HOME === test.account.homePath))
    const sourcePin = captureOriginalCodexSession(original, sourceSession, test.accepted, () => undefined)
    assert(sourcePin)
    assert.deepEqual(await sourcePin.reattach(), sourceSession)
  })
})
