import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { SessionControlStateSchema, type SessionControlState } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { SessionControlStore } from '../src/modules/conversations/sessionControls/store.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { compactionFixture } from '../src/modules/harnesses/claudeSdk/__tests__/compaction.js'
import { deferred } from './helpers/deferred.js'
import { registerOperatorChatFixture, type OperatorChatFixture } from './helpers/operatorChatFixture.js'

let fixture: OperatorChatFixture
registerOperatorChatFixture(value => { fixture = value }, () => fixture.chat)

it.each(['post-offer-first', 'boundary-first'] as const)(
  'serializes compaction persistence through authenticated MCP with %s storage completion', async order => {
    const f = await compactionFixture()
    const releaseOffer = deferred()
    const releaseBoundary = deferred()
    const offerEntered = deferred()
    const boundaryEntered = deferred()
    let runningDispatchSaves = 0
    let hold = false
    const progress: SessionControlState[] = []
    const pool = { query: async (text: string, values?: unknown[]) => {
      const raw = values?.[1]
      const parsed = typeof raw === 'string' && raw.startsWith('{')
        ? SessionControlStateSchema.safeParse(JSON.parse(raw)) : undefined
      const record = parsed?.success ? parsed.data : undefined
      if (hold && record?.compaction?.status === 'running' && record.compaction.dispatchPhase === 'dispatched') {
        runningDispatchSaves++
        if (!record.compaction.nativeOperationId && runningDispatchSaves === 2) {
          offerEntered.resolve()
          await releaseOffer.promise
        }
        if (record.compaction.nativeOperationId === 'manual-boundary') {
          boundaryEntered.resolve()
          await releaseBoundary.promise
        }
      }
      const result = await fixture.pool.query(text, values)
      if (record && result.rowCount === 1) progress.push(record)
      return result
    } } as unknown as Pick<pg.Pool, 'query'>
    const store = new SessionControlStore(pool, 'operator')
    const conversation = await fixture.chat.create(fixture.owner)
    const session = await f.attach()
    const binding = { conversationId: conversation.id, principalId: fixture.owner.id,
      defaultSubject: 'operator', profileKey: 'claude-publication', busyReason: null,
      session, manager: f.manager }
    const lifetime = new AbortController()
    const controls = {
      readSessionControls: async () => store.read(binding),
      changeSessionControls: async (_id: string, request: Parameters<SessionControlStore['execute']>[2],
        principal: Parameters<SessionControlStore['execute']>[0], source: 'http' | 'mcp') =>
        store.execute(principal, source, request, async () => binding, lifetime.signal),
    }
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access: fixture.access, services: { operatorChat: controls,
        commands: new PostgresCommandCoordinator(fixture.pool) } as unknown as OperatorServices } })
    const writer = await fixture.access.issue({ name: 'Compaction writer', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }],
      expiresAt: new Date(Date.now() + 60_000) })
    binding.principalId = writer.principal.id
    const reader = await fixture.access.issue({ name: 'Compaction reader', audience: 'operator',
      grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const client = new Client({ name: 'compaction-publication', version: '1' })
    const denied = new Client({ name: 'compaction-reader', version: '1' })
    let updating: ReturnType<Client['callTool']> | undefined
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => writer.token } }))
      await denied.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => reader.token } }))
      const initial = SessionControlStateSchema.parse(decodeMcpToolResult(await client.callTool({
        name: 'operator_chat_controls_get', arguments: { conversationId: conversation.id },
      })))
      const request = { kind: 'compact', requestId: randomUUID(), expectedRevision: initial.revision }
      expect((await denied.callTool({ name: 'operator_chat_controls_update',
        arguments: { conversationId: conversation.id, request } })).isError).toBe(true)
      expect(f.offers).not.toHaveBeenCalled()
      hold = true
      updating = client.callTool({ name: 'operator_chat_controls_update',
        arguments: { conversationId: conversation.id, request } })
      void updating.catch(() => { /* ignore: the test awaits the original MCP response below. */ })
      // Consume the single native command while its post-offer database save is held.
      const command = await f.nextMessage()
      await offerEntered.promise
      await f.frames.offer({ type: 'system', subtype: 'compact_boundary', session_id: session.nativeSessionId,
        uuid: 'manual-boundary', compact_metadata: { trigger: 'manual', pre_tokens: 12000 } })
      await vi.waitFor(async () => expect((await f.manager.history(session)).events)
        .toContainEqual(expect.objectContaining({ type: 'session.compaction' })))
      await new Promise<void>(resolve => setImmediate(resolve))
      if (order === 'boundary-first') releaseBoundary.resolve()
      releaseOffer.resolve()
      if (order === 'post-offer-first') {
        await boundaryEntered.promise
        releaseBoundary.resolve()
      }
      await f.frames.offer({ type: 'result', session_id: session.nativeSessionId,
        user_message_uuid: command.uuid, is_error: false, subtype: 'success' })
      const result = SessionControlStateSchema.parse(decodeMcpToolResult(await updating))
      expect(result.compaction).toMatchObject({ status: 'completed', nativeOperationId: 'manual-boundary' })
      expect(f.close).not.toHaveBeenCalled()
      expect(f.offers).toHaveBeenCalledOnce()
      const saved = await fixture.pool.query<{ record: unknown }>(
        'select record from conversation_session_controls where conversation_id=$1', [conversation.id])
      expect(SessionControlStateSchema.parse(saved.rows[0]!.record).compaction).toMatchObject(result.compaction!)
      const readback = SessionControlStateSchema.parse(decodeMcpToolResult(await client.callTool({
        name: 'operator_chat_controls_get', arguments: { conversationId: conversation.id },
      })))
      expect(readback.compaction?.status).toBe('completed')
      expect(progress.map(state => state.revision)).toEqual([...progress.map(state => state.revision)].sort((a, b) => a - b))
      expect(progress.some(state => state.compaction?.status === 'uncertain')).toBe(false)
      const stale = await client.callTool({ name: 'operator_chat_controls_update', arguments: {
        conversationId: conversation.id, request: { ...request, requestId: randomUUID() },
      } })
      expect(stale.isError).toBe(true)
      expect(f.offers).toHaveBeenCalledOnce()
    } finally {
      releaseOffer.resolve()
      releaseBoundary.resolve()
      lifetime.abort(new Error('Fixture closed'))
      await f.dispose()
      await updating
      await client.close()
      await denied.close()
      await app.close()
    }
  }, 30_000,
)
