import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { compactCommandActivityMigration } from '../src/infrastructure/compactCommandActivityMigration.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { readActivityCommands } from '../src/modules/conversations/activityCommands.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { buildApp } from '../src/app.js'
import { OperatorChatService, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'

it.skipIf(process.env.NIM2691_POSTGRES !== '1').each(['pending', 'uncertain', 'completed'])('retains the newest %s control beside 200 completed PostgreSQL receipts', async (status) => {
    await nim2691TaskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const access = new PostgresAccessService(pool)
      const caller = await access.issue({ name: 'window owner', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }] })
      const chat = new OperatorChatService(new PostgresOperatorConversationRepository(pool), new PostgresOperatorRepository(pool),
        () => { throw new Error('Readback must not open a native session') }, '/tmp/activity-window', {
          current: (id) => access.currentOperator(id), assertConfiguration() {},
          setup: async () => { throw new Error('Unused') }, prepare: async () => { throw new Error('Unused') }, release: async () => {},
        })
      const conversation = await chat.create(caller.principal)
      const scope = { kind: 'operator_chat' as const, conversationId: conversation.id }
      const retainedState = { privateSnapshot: Array.from({ length: 2048 }, () => randomUUID()).join('') }
      for (let i = 0; i <= 200; i++) {
        const control = { schemaVersion: 1, kind: 'respond', conversationId: scope.conversationId,
          modelRequestId: `model-${i}`, scope,
          native: { harness: 'codex', providerVersion: '0.154.0', sessionId: 'session', turnId: `turn-${i}`,
            requestId: `approval-${i}`, requestType: 'permission.asked' }, choice: { optionId: 'once', semantic: 'approve_once' } }
        await pool.query(`insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result,created_at)
          values($1,'operator_chat_control',$2,$3,'hash',$4::jsonb,'2026-10-02T00:00:00Z'::timestamptz+$5*interval '1 second')`,
        [caller.principal.id, `command-${i}`, scope.conversationId,
          JSON.stringify({ status: i === 200 ? status : 'completed', acceptedControl: control, state: retainedState }), i])
      }
      const result = await readActivityCommands(pool, scope.conversationId, scope, '9')
      expect(result.hasMore).toBe(true)
      expect(result.sourceRevisions).toHaveLength(200)
      expect(result.sourceRevisions.some((revision) => revision.id === JSON.stringify([caller.principal.id, 'operator_chat_control', 'command-200']))).toBe(true)
      expect(result.summaries.at(-1)).toMatchObject({ owner: { requestId: 'model-200' },
        delivery: status === 'uncertain' ? 'uncertain' : 'answer_recorded', native: { requestId: 'approval-200' } })
      expect(result.summaries[0]?.owner).toMatchObject({ requestId: 'model-1' })
      expect((await pool.query('select count(*)::integer as n from management_command_receipts')).rows[0]!.n).toBe(201)
      const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { operatorChat: chat, commands: new PostgresCommandCoordinator(pool) } as never } })
      try {
        const mcp = await graphRpc(app, caller.token, 'tools/call', { name: 'operator_chat_get', arguments: { conversationId: scope.conversationId } })
        expect(mcp.result?.isError).not.toBe(true)
        const state = graphRpcValue(mcp.result) as { activitySnapshot: { pendingInteractions: { owner: unknown }[] } }
        expect(state.activitySnapshot.pendingInteractions).toHaveLength(200)
        expect(state.activitySnapshot.pendingInteractions.at(-1)?.owner).toMatchObject({ requestId: 'model-200' })
        const denied = await access.issue({ name: 'denied window reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['harnesses:read'], scope: {} }] })
        const blocked = await graphRpc(app, denied.token, 'tools/call', { name: 'operator_chat_get', arguments: { conversationId: scope.conversationId } })
        expect(blocked.error || blocked.result?.isError).toBeTruthy()
      } finally { await app.close(); await chat.shutdown() }
    })
  }, 120000)

it.skipIf(process.env.NIM2691_POSTGRES !== '1')('backfills compact receipt activity and follows result updates without changing stored outcomes', async () => {
  await nim2691TaskDatabase(async pool => {
    const sql = await pool.connect()
    try {
      await sql.query('begin')
      // Template databases already contain the migrated table; this fixture needs its pre-migration shape.
      const schema = `command_activity_${randomUUID().replaceAll('-', '')}`
      await sql.query(`create schema ${schema}`)
      await sql.query(`set local search_path=${schema}`)
      await sql.query('create table management_command_receipts (id integer primary key, result jsonb not null)')
      const outcome = { status: 'pending', acceptedControl: { id: 'control' }, state: { retained: 'original snapshot' } }
      await sql.query('insert into management_command_receipts values (1,$1::jsonb),(2,$2::jsonb)', [JSON.stringify(outcome), '["historical"]'])
      await sql.query(compactCommandActivityMigration.sql)
      const read = async () => (await sql.query(`select result,activity_status,activity_control,activity_acknowledgment
        from management_command_receipts order by id`)).rows
      expect(await read()).toEqual([
        { result: outcome, activity_status: 'pending', activity_control: outcome.acceptedControl, activity_acknowledgment: null },
        { result: ['historical'], activity_status: null, activity_control: null, activity_acknowledgment: null },
      ])
      const settled = { ...outcome, status: 'completed', providerAcknowledgment: { id: 'acknowledgment' } }
      await sql.query('update management_command_receipts set result=$1::jsonb where id=1', [JSON.stringify(settled)])
      expect((await read())[0]).toEqual({ result: settled, activity_status: 'completed', activity_control: outcome.acceptedControl,
        activity_acknowledgment: settled.providerAcknowledgment })
    } finally {
      try { await sql.query('rollback') } finally { sql.release() }
    }
  })
}, 120000)
