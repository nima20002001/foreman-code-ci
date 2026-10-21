import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, type PendingNativeInteraction } from '@foreman-code/contracts'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorConversationRepository, nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { pendingResponseQuery } from '../src/modules/harnesses/responseAvailability.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { browserOwnerUpgrade } from './helpers/browserOwnerUpgrade.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import type { LocalHumanRecoveryInput } from './helpers/localHumanRecoveryChild.js'
import { readUntil } from './helpers/observableCondition.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

const databaseUrl = process.env.ENG03_A_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL
const enabled = Boolean(databaseUrl) && process.env.RUN_REAL_HARNESS_TESTS === '1'

describe.skipIf(!enabled)('local human production native recovery', { timeout: 240_000 }, () => {
  it.each(['respond', 'restart'] as const)(
    '%s retains ownership and uses production Codex response availability across upgrade', async action => {
    const db = await currentDatabase({ databaseUrl: databaseUrl! })
    const directory = await privateFixtureDirectory('local-human-native-recovery-')
    const access = new PostgresAccessService(db.pool)
    const owner = await access.issue({ name: 'Native conversation owner', audience: 'operator',
      grants: [{ actions: ManagementActionSchema.options, scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const operators = new PostgresOperatorRepository(db.pool)
    const initial = await operators.ensure()
    const { operator, configuration } = await operators.update({ harness: 'codex',
      model: process.env.CODEX_TEST_MODEL ?? 'gpt-5.6-luna', reasoningEffort: 'medium', sandbox: 'read-only',
      serviceTier: 'standard', advanced: { ...structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION), approvalPolicy: 'on-request' },
    }, initial.configuration.id)
    const repository = new PostgresOperatorConversationRepository(db.pool)
    const conversation = await repository.create(operator.id, configuration, owner.principal.id, 'Pending native request')
    const requestId = randomUUID()
    const correlationId = nativeCorrelation(conversation.id, requestId)
    const binary = harnessBinaries(process.env).codexBinary
    const manager = new CodexAppServerSessionManager(binary)
    const registry = new NativeProcessRegistry(join(directory, 'processes'))
    let child: ReturnType<typeof fork> | undefined
    let exited: Promise<void> | undefined
    let running: Promise<void> | undefined
    let app: ReturnType<typeof buildApp> | undefined
    let chat: OperatorChatService | undefined
    const signal = AbortSignal.timeout(180_000)
    try {
      await repository.beginTurn(conversation.id, { requestId, content: 'Original native pending turn' }, owner.principal.id)
      const session = await manager.createSession({ kind: 'operator', correlationId, configuration,
        workingDirectory: directory, environment: { agentId: configuration.operatorId,
          variables: { FOREMAN_CODE_MCP_TOKEN: 'operator-cleanup-disabled' } } }, signal)
      await repository.bind(conversation.id, requestId, session.providerVersion, session.nativeSessionId)
      let reportPending!: (pending: PendingNativeInteraction) => void
      let rejectPending!: (error: unknown) => void
      const pendingObserved = new Promise<PendingNativeInteraction>((resolve, reject) => {
        reportPending = resolve
        rejectPending = reject
      })
      running = (async () => {
        for await (const event of manager.startTurn(session, {
          prompt: `Run the native shell command: printf approved > ${JSON.stringify(join(directory, 'approval-marker'))}.
            Request approval when the read-only sandbox blocks writing. Do not simulate the result.`,
          clientCorrelationId: correlationId,
          onSubmitted: async nativeTurnId => {
            await repository.submitted(conversation.id, requestId, nativeTurnId,
              { nativeSessionId: session.nativeSessionId, principalId: owner.principal.id })
          },
        }, signal)) {
          void event
          const pending = await manager.pending(session)
          if (pending) reportPending(pending)
        }
        rejectPending(new Error('The native turn ended without requesting approval.'))
      })()
      void running.catch(rejectPending)
      const pending = await pendingObserved
      await repository.pending(conversation.id, requestId, pending)
      expect(await manager.inspectResponseAvailability(session, pendingResponseQuery(pending)!, signal))
        .toMatchObject({ state: 'available', path: 'live_callback', qualified: true })
      const original = await repository.active(conversation.id)
      await browserOwnerUpgrade(db.pool, owner.principal.id)
      await applyApplicationMigrations(db.pool)
      if (action === 'respond') {
        chat = new OperatorChatService(repository, operators, () => manager, directory, {
          current: id => access.currentOperator(id), assertConfiguration() {},
          setup: async () => { throw new Error('An existing response must not inspect new-work setup.') },
          prepare: async () => { throw new Error('An existing response must not issue launch authority.') },
          release: async () => {},
        })
        app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
          operator: { access, services: { operatorChat: chat, commands: new PostgresCommandCoordinator(db.pool) } as never },
          localHuman: new PostgresLocalHumanAccess(db.pool, access) })
        registerOperatorChatRoutes(app, chat)
        await chat.reconcileActive()
        const url = `/api/operator/conversations/${conversation.id}`
        const readable = await app.inject({ url })
        expect(readable.statusCode, readable.body).toBe(200)
        expect(readable.json().responseAvailability).toMatchObject({ available: true, path: 'live_callback' })
        const option = pending.responseOptions.find(value => value.semantic === 'reject')
          ?? pending.responseOptions.find(value => value.semantic === 'cancel')
        expect(option, JSON.stringify({ method: pending.nativeRequestType,
          options: pending.responseOptions.map(value => value.semantic) })).toBeDefined()
        const response = await app.inject({ method: 'POST', url: `${url}/responses`, payload: {
          requestId, nativeRequestId: pending.turn.nativeRequestId, optionId: option!.optionId, commandId: randomUUID(),
        } })
        expect(response.statusCode, response.body).toBe(200)
        expect((await manager.inspectResponseAvailability(session, pendingResponseQuery(pending)!, signal)).state)
          .not.toBe('available')
        await expect(readFile(join(directory, 'approval-marker'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await access.authenticate(owner.token)).toEqual(owner.principal)
        return
      }
      await manager.dispose()
      await Promise.allSettled([running])
      child = fork(fileURLToPath(new URL('./helpers/localHumanRecoveryChild.ts', import.meta.url)), [], {
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env },
      })
      exited = new Promise<void>(resolve => child!.once('exit', () => resolve()))
      child.stdout?.resume()
      child.stderr?.resume()
      const ready = message(child, 'address')
      const input: LocalHumanRecoveryInput = { schema: db.schema, directory, binary, databaseUrl: databaseUrl! }
      child.send(input)
      const address = String((await ready).address)
      const url = `${address}/api/operator/conversations/${conversation.id}`
      const retained = await fetch(url)
      expect(retained.status).toBe(200)
      const state = await retained.json()
      expect(state.pendingInteraction).toEqual(pending)
      expect(state.responseAvailability).toMatchObject({ available: false, path: null, reason: 'callback_lost' })
      const reconciled = message(child, 'reconciled')
      child.send('reconcile')
      await reconciled
      const inspected = message(child, 'observedHistory')
      child.send({ kind: 'inspect', conversationId: conversation.id })
      const observed = (await inspected).observedHistory as { nativeTurnId?: string; correlationId?: string }
      expect(observed).toMatchObject({ nativeTurnId: original!.active_native_turn_id, correlationId })
      const recovered = await fetch(url)
      expect(recovered.status).toBe(200)
      const recoveredState = await recovered.json()
      if (recoveredState.pendingInteraction) {
        expect(recoveredState.pendingInteraction).toEqual(pending)
        expect(recoveredState.responseAvailability).toMatchObject({ available: false, path: null })
      } else {
        expect(recoveredState.lastResult).toBeDefined()
      }
      const cancel = await fetch(`${url}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, commandId: randomUUID() }) })
      expect(cancel.status, await cancel.text()).toBe(200)
      const row = await readUntil(() => repository.active(conversation.id),
        value => value?.active_request_id === null, { timeoutMs: 5000, description: 'recovered native cancellation' })
      expect(row).toMatchObject({ owner_principal_id: owner.principal.id,
        native_session_id: original!.native_session_id })
      const turn = (await db.pool.query('select native_turn_id,result from operator_conversation_turns where conversation_id=$1 and request_id=$2',
        [conversation.id, requestId])).rows[0]
      expect(turn.native_turn_id).toBe(original!.active_native_turn_id)
      expect(turn.result).toMatchObject({ outcome: 'canceled' })
      const canceledHistory = message(child, 'observedHistory')
      child.send({ kind: 'inspect', conversationId: conversation.id })
      expect((await canceledHistory).observedHistory).toMatchObject({
        nativeTurnId: original!.active_native_turn_id, correlationId, terminalResult: { outcome: 'canceled' },
      })
      expect(await access.authenticate(owner.token)).toEqual(owner.principal)
      child.send('stop')
      await exited
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
      await app?.close()
      await chat?.shutdown()
      await registry.closeOwner(conversation.id)
      await manager.dispose()
      if (running) await Promise.allSettled([running])
      await db.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function message(child: ReturnType<typeof fork>, field: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Recovery child did not report ${field}.`)), 60_000)
    const receive = (value: Record<string, unknown>) => {
      if (value.error) finish(new Error(String(value.error)))
      else if (field in value) finish(undefined, value)
    }
    const fail = () => finish(new Error(`Recovery child exited before ${field}.`))
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timer)
      child.off('message', receive)
      child.off('error', fail)
      child.off('exit', fail)
      if (error) reject(error)
      else resolve(value!)
    }
    child.on('message', receive)
    child.once('error', fail)
    child.once('exit', fail)
  })
}
