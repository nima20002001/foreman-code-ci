import { readUntil } from './observableCondition.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeTurnInput } from '../../src/modules/harnesses/port.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { type ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { createFixtureSchema, dropFixtureSchema } from './testResources.js'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { NativeHarnessEventSchema, type ExecutionResult, type NativeSessionReference } from '@foreman-code/contracts'
import pg from 'pg'
import { afterEach, beforeEach } from 'vitest'
import type { migratedDatabase } from './migratedDatabase.js'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { OperatorChatService, PostgresOperatorConversationRepository, type OperatorChatAuthority } from '../../src/modules/conversations/operatorChat.js'
import { PostgresOperatorRepository } from '../../src/modules/operators/postgres.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'

export const claudeConfiguration = {
  harness: 'claude', model: 'fixture-model', effort: 'medium', authMode: 'subscription',
  configDirectory: '/fixture/profile', permissionMode: 'default', sandbox: 'danger-full-access',
  tools: [], permissionRules: [], instructions: '', mcpServers: {},
} satisfies ClaudeHarnessConfiguration

const connectionString = process.env.TEST_DATABASE_URL

export async function prepareClaudeProfile() {
  const mainId = '11111111-1111-4111-8111-111111111111'
  return {
    instanceId: randomUUID(), instanceRevision: '1', target: {
      hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
      harnessInstallationId: 'fixture-claude', installationFingerprint: 'fixture-claude-profile',
    },
  }
}

/** Only provider I/O is fake: these tests exercise real migrations, SQL, grants and service transitions. */
export class ChatManager implements NativeHarnessSessionManager {
  constructor(readonly harness: 'codex' | 'claude' = 'codex') {}
  sessions = 0; turns = 0; attachments = 0; closes = 0; disposals = 0
  modes: Array<string | undefined> = []
  prompts: string[] = []
  publicMessages: string[] = []
  autoFinish = true; failAttach = false; cancelAcknowledged = true
  private readonly histories = new Map<string, NativeHistory>()
  private readonly active = new Map<string, string>()
  private readonly releases = new Map<string, () => void>()
  capabilities(): ReturnType<NativeHarnessSessionManager['capabilities']> { throw new Error('Not used by this provider fixture.') }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('Not used by this provider fixture.') }
  async createSession(): Promise<NativeSessionReference> {
    this.sessions++
    return { harness: this.harness, providerVersion: 'codex-cli 0.154.0', nativeSessionId: `native-${this.sessions}` }
  }
  async attachSession(session: NativeSessionReference) {
    this.attachments++
    if (this.failAttach) throw new Error('CODEX_SESSION_UNAVAILABLE')
    return session
  }
  async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal) {
    this.turns++
    this.prompts.push(input.prompt)
    this.modes.push(input.sessionMode)
    await input.onSettingsApplied?.()
    const correlation = input.clientCorrelationId
    const nativeTurnId = `turn-${this.turns}`
    this.active.set(session.nativeSessionId, correlation)
    const history: NativeHistory = { correlationId: correlation, events: [], pendingInteractions: [] }
    this.histories.set(correlation, history)
    if (this.harness === 'claude') {
      history.nativeSubmission = { kind: 'message', nativeSessionId: session.nativeSessionId,
        nativeMessageId: nativeTurnId, clientCorrelationId: correlation }
      await input.onMessageSubmitted?.(history.nativeSubmission)
    } else {
      history.nativeTurnId = nativeTurnId
      await input.onSubmitted?.(nativeTurnId)
      yield NativeHarnessEventSchema.parse({ sequence: this.turns, type: 'assistant.delta',
        occurredAt: new Date().toISOString(), payload: { text: 'partial' } })
    }
    for (const [index, text] of this.publicMessages.entries()) {
      const itemId = `commentary-${index}`
      if (this.harness === 'claude') {
        yield NativeHarnessEventSchema.parse({ sequence: this.turns * 100 + index, type: 'claude.text',
          occurredAt: new Date().toISOString(), payload: {
            itemId, messageId: nativeTurnId, text, operation: 'replace', final: true,
            nativeSessionId: session.nativeSessionId, clientCorrelationId: correlation,
            nativeGeneration: 'fixture', source: { eventId: `${nativeTurnId}:${itemId}`, sequence: String(this.turns * 100 + index) },
          },
        })
      } else {
        yield NativeHarnessEventSchema.parse({ sequence: this.turns * 100 + index, type: 'item.completed',
          occurredAt: new Date().toISOString(), payload: {
            turnId: nativeTurnId, item: { id: itemId, type: 'agentMessage', text, phase: 'commentary' },
          },
        })
      }
    }
    if (this.autoFinish) this.finish(correlation)
    else if (!this.histories.get(correlation)?.terminalResult) await new Promise<void>((resolve) => {
      const done = () => { signal?.removeEventListener('abort', done); this.releases.delete(correlation); resolve() }
      this.releases.set(correlation, done)
      signal?.addEventListener('abort', done, { once: true })
      if (signal?.aborted) done()
    })
  }
  finish(correlation: string, result: ExecutionResult = { outcome: 'succeeded', output: { text: 'final answer' } }) {
    const history = this.histories.get(correlation)
    if (history) {
      history.terminalResult = result
      history.nativeMessageId = `answer:${history.nativeSubmission?.nativeMessageId ?? history.nativeTurnId}`
      if (history.nativeSubmission) history.terminalTurn = { correlationId: correlation,
        providerId: history.nativeSubmission.nativeMessageId, result }
    }
    this.releases.get(correlation)?.()
  }
  async pending() { return undefined }
  async respond() {}
  async cancel(session: NativeSessionReference) {
    const correlation = this.active.get(session.nativeSessionId)
    if (!this.cancelAcknowledged || !correlation) return false
    this.finish(correlation, { outcome: 'canceled' })
    return true
  }
  async history(session: NativeSessionReference): Promise<NativeHistory> {
    return this.histories.get(this.active.get(session.nativeSessionId) ?? '') ?? { events: [], pendingInteractions: [] }
  }
  async reconcile(_session: NativeSessionReference, correlation: string): Promise<NativeHistory> {
    return this.histories.get(correlation) ?? { events: [], pendingInteractions: [] }
  }
  async close(session: NativeSessionReference) { this.closes++; this.releases.get(this.active.get(session.nativeSessionId) ?? '')?.() }
  async dispose() { this.disposals++; for (const release of this.releases.values()) release() }
}

export async function waitFor(check: () => Promise<boolean>) {
  await readUntil(check, ready => ready, { timeoutMs: 2000, description: 'the conversation condition' })
}

export interface OperatorChatFixture {
  pool: pg.Pool
  access: PostgresAccessService
  owner: ManagementPrincipal
  operators: PostgresOperatorRepository
  repository: PostgresOperatorConversationRepository
  manager: ChatManager
  authority: OperatorChatAuthority
  chat: OperatorChatService
  runtimeDirectory: string
}

export function registerOperatorChatFixture(
  initialize: (fixture: OperatorChatFixture) => void,
  currentChat: () => OperatorChatService | undefined,
  databaseFactory?: () => ReturnType<typeof migratedDatabase>,
) {
  let fixtureDatabase: Awaited<ReturnType<typeof migratedDatabase>> | undefined
  let schema: string
  let admin: pg.Pool
  let pool: pg.Pool
  let access: PostgresAccessService
  let owner: ManagementPrincipal
  let operators: PostgresOperatorRepository
  let repository: PostgresOperatorConversationRepository
  let manager: ChatManager
  let authority: OperatorChatAuthority
  let chat: OperatorChatService
  let runtimeDirectory: string

  beforeEach(async () => {
    runtimeDirectory = await privateFixtureDirectory('operator-claude-')
    let database: URL
    try { database = new URL(connectionString!) } catch { throw new Error('Use a loopback PostgreSQL database explicitly named for tests') }
    if (!['postgres:', 'postgresql:'].includes(database.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
      || !/(?:^|[_-])test(?:db)?(?:$|[_-])/i.test(decodeURIComponent(database.pathname.slice(1)))
      || database.search || database.hash) throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
    fixtureDatabase = await databaseFactory?.()
    schema = fixtureDatabase?.schema ?? `chat_${randomUUID().replaceAll('-', '')}`
    if (!fixtureDatabase) {
      admin = new pg.Pool({ connectionString })
      await createFixtureSchema(admin, schema)
    }
    // A one-slot pool catches accidental post-commit nested checkouts.
    pool = new pg.Pool({ connectionString: fixtureDatabase?.databaseUrl ?? connectionString,
      max: 1, connectionTimeoutMillis: 2_000, options: `-c search_path=${schema}` })
    if (!fixtureDatabase) await applyApplicationMigrations(pool)
    access = new PostgresAccessService(pool)
    owner = (await access.issue({ name: 'chat owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:cancel', 'operator_chat:respond', 'settings:update', 'harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 600_000) })).principal
    operators = new PostgresOperatorRepository(pool)
    repository = new PostgresOperatorConversationRepository(pool)
    manager = new ChatManager()
    authority = { current: (id) => access.currentOperator(id), assertConfiguration() {},
      setup: async (manager) => ({ harness: manager.harness, status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() }),
      setupConfiguration: async (_principal, configuration) => ({ harness: configuration.harness.harness,
        status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() }),
      prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }), release: async () => {} }
    chat = new OperatorChatService(repository, operators, () => manager, runtimeDirectory, authority)
    initialize({ pool, access, owner, operators, repository, manager, authority, chat, runtimeDirectory })
  }, 30_000)

  afterEach(async () => {
    try { await currentChat()?.shutdown() }
    finally {
      try { await pool?.end() }
      finally {
        try {
          if (fixtureDatabase) await fixtureDatabase.close()
          else if (admin) await dropFixtureSchema(admin, schema)
        }
        finally {
          try { await admin?.end() }
          finally { await rm(runtimeDirectory, { recursive: true, force: true }) }
        }
      }
    }
  })
}
