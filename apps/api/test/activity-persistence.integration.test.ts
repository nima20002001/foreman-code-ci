import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorActivityRepository } from '../src/modules/conversations/operatorActivityRepository.js'
import { fixture } from './helpers/agentChatF1.js'
import { agentActivitySnapshot } from '../src/modules/conversations/activitySnapshot.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { activitySnapshotMigration } from '../src/infrastructure/activitySnapshotMigration.js'
import { compactCommandActivityMigration } from '../src/infrastructure/compactCommandActivityMigration.js'

// Orchestrator executes against its owned disposable TEST_DATABASE_URL. No provider I/O.
const connectionString = process.env.TEST_DATABASE_URL
describe.skipIf(!connectionString)('activity transaction fencing in PostgreSQL', () => {
  let admin: pg.Pool; let pool: pg.Pool; let repository: PostgresOperatorActivityRepository; let schema: string
  beforeEach(async () => {
    admin = new pg.Pool({ connectionString }); schema = `activity_${randomUUID().replaceAll('-', '')}`
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` }); repository = new PostgresOperatorActivityRepository(pool)
    await pool.query(`create table operator_conversations (id text primary key, active_request_id text, native_session_id text,
      active_native_turn_id text, deleted_at timestamptz, revision bigint not null default 0,
      harness text not null default 'codex', kind text not null default 'agent', record jsonb not null default '{}', active_phase text, cancel_requested boolean not null default false,
      turn_state text not null default 'idle', last_error text, last_result jsonb, pending_interaction jsonb, updated_at timestamptz not null default now());
      create table operator_conversation_turns (conversation_id text, request_id text, intent text, delivery text, input_hash text default 'fixture', updated_at timestamptz,
        payload jsonb not null default '{}');
      create table operator_conversation_activity (conversation_id text, request_id text, activity_id text,
        record jsonb not null, sequence bigint generated always as identity, revision bigint not null default 0,
        unique(conversation_id,request_id,activity_id));`)
    await pool.query(activitySnapshotMigration.sql)
    await pool.query(`insert into operator_conversations (id,active_request_id,native_session_id,active_native_turn_id)
      values ('conversation','A','session','turn-A')`)
  })
  afterEach(async () => { await pool?.end(); if (admin) { await dropFixtureSchema(admin, schema); await admin.end() } })
  const value = (status: 'running' | 'completed', title = 'Tool') => ({ id: 'tool', requestId: 'A', kind: 'tool' as const, title, status })
  const fence = (sequence: string) => ({ nativeSessionId: 'session', nativeTurnId: 'turn-A', source: { eventId: `event-${sequence}`, sequence } })
  it('claim start time remains immutable through activity revisions and repeated claims', async () => {
    await pool.query(`update operator_conversations set active_request_id=null,active_native_turn_id=null where id='conversation';
      insert into operator_conversation_turns (conversation_id,request_id,intent,delivery) values ('conversation','A','next_turn','queued')`)
    const chat = new PostgresAgentChatRepository(pool)
    expect(await chat.claim('conversation', 'A')).toBe(true)
    const start = (await pool.query('select started_at from operator_conversation_turns')).rows[0].started_at
    expect(start).toBeInstanceOf(Date)
    await repository.append('conversation', 'A', value('running'))
    expect(await chat.claim('conversation', 'A')).toBe(false)
    expect((await pool.query('select started_at from operator_conversation_turns')).rows[0].started_at).toEqual(start)
    expect((await pool.query('select revision::text from operator_conversations')).rows[0].revision).toBe('2')
  })
  it('duplicates and stale same-status content do not mutate item or scope revisions', async () => {
    await repository.append('conversation', 'A', value('completed'), fence('2'))
    const before = await pool.query(`select c.revision::text as scope,a.revision::text as item,a.record from operator_conversations c cross join operator_conversation_activity a`)
    expect(await repository.append('conversation', 'A', value('completed'), fence('2'))).toBeUndefined()
    expect(await repository.append('conversation', 'A', value('completed', 'old payload'), fence('1'))).toBeUndefined()
    expect(await repository.append('conversation', 'A', value('completed', 'unsequenced payload'))).toBeUndefined()
    expect((await pool.query(`select c.revision::text as scope,a.revision::text as item,a.record from operator_conversations c cross join operator_conversation_activity a`)).rows).toEqual(before.rows)
  })
  it('parent cancellation retains unknown unresolved child outcome', async () => {
    await repository.append('conversation', 'A', value('running'), fence('1'))
    await withTransaction(pool, client => repository.finish('conversation', 'A', true, client))
    expect((await pool.query('select record from operator_conversation_activity')).rows[0].record.status).toBe('unknown')
  })
  it('rejects stale owner and exact native turn before insertion', async () => {
    expect(await repository.append('conversation', 'A', value('running'), { nativeTurnId: 'previous-turn' })).toBeUndefined()
    await pool.query(`update operator_conversations set active_request_id='B' where id='conversation'`)
    expect(await repository.append('conversation', 'A', value('running'), fence('1'))).toBeUndefined()
    expect((await pool.query('select * from operator_conversation_activity')).rowCount).toBe(0)
    expect((await pool.query('select revision::text from operator_conversations')).rows[0].revision).toBe('0')
  })
  it('advances source watermark for identical payload without changing revisions', async () => {
    await repository.append('conversation', 'A', value('running'), fence('2'))
    expect(await repository.append('conversation', 'A', value('running', 'ambiguous unsequenced'))).toBeUndefined()
    expect(await repository.append('conversation', 'A', value('running'), fence('5'))).toBeUndefined()
    expect(await repository.append('conversation', 'A', value('running', 'stale'), fence('4'))).toBeUndefined()
    const item = (await pool.query('select revision::text,source_provenance,record from operator_conversation_activity')).rows[0]
    expect(item.revision).toBe('0'); expect(item.source_provenance.sequence).toBe('5'); expect(item.record.title).toBe('Tool')
    expect((await pool.query('select revision::text from operator_conversations')).rows[0].revision).toBe('1')
  })
  it('requires explicit ordered reconciliation to correct a terminal payload', async () => {
    await repository.append('conversation', 'A', value('completed'), fence('2'))
    expect(await repository.append('conversation', 'A', value('completed', 'late'), fence('3'))).toBeUndefined()
    expect(await repository.append('conversation', 'A', value('completed', 'reconciled'), { ...fence('3'), authoritativeReconciliation: true })).toBeDefined()
    expect((await pool.query('select record from operator_conversation_activity')).rows[0].record.title).toBe('reconciled')
  })
  it('keeps an old unfinished child in active after parent settlement and 101 newer completed entries', async () => {
    await pool.query(`alter table operator_conversations add column workspace_id text default 'workspace',
      add column workflow_id text default 'workflow', add column workflow_node_id text default 'node', add column agent_id text default 'agent',
      add column origin_run_id text, add column origin_execution_id text;
      alter table operator_conversation_turns add column turn_sequence bigint generated always as identity,
      add column message_id text default 'message', add column native_turn_id text, add column target_native_turn_id text,
      add column delivery_error jsonb, add column result jsonb,
      add column created_at timestamptz default now();
      create table operator_conversation_messages (conversation_id text not null references operator_conversations(id),
        record jsonb not null, sequence bigint generated always as identity, activity_record_revision bigint not null default 0);
      create table management_command_receipts (principal_id text, operation text, command_id text, target_key text,
        result jsonb, activity_record_revision bigint not null default 0, created_at timestamptz not null default now());
      insert into operator_conversation_turns (conversation_id,request_id,intent,delivery,updated_at)
        values ('conversation','A','next_turn','accepted',now())`)
    await pool.query(compactCommandActivityMigration.sql)
    await repository.append('conversation', 'A', { ...value('running'), id: 'old-child', kind: 'subagent' }, fence('1'))
    for (let index = 0; index < 101; index++) await repository.append('conversation', 'A',
      { ...value('completed'), id: `done-${index}` }, fence(String(index + 2)))
    await pool.query("update operator_conversations set active_native_turn_id=null where id='conversation'")
    const chat = new PostgresAgentChatRepository(pool)
    expect(await chat.finish('conversation', 'A', { outcome: 'succeeded' })).toBe(true)
    const loaded = (await chat.state('conversation'))!
    expect(loaded.activityPage.activities).toHaveLength(100)
    expect(loaded.activityPage.activities.some((entry) => entry.id === 'old-child')).toBe(false)
    expect(agentActivitySnapshot(loaded).active).toMatchObject([
      { ref: { kind: 'subagent', itemId: JSON.stringify(['conversation-activity', 'conversation', 'A', 'old-child']) }, outcome: null, evidence: 'unknown' },
    ])
  })
  it('reports a bounded unfinished-roster recovery window without blocking state readback', async () => {
    for (let index = 0; index < 101; index++) await repository.append('conversation', 'A',
      { ...value('running'), id: `unfinished-${index}` }, fence(String(index + 1)))
    const roster = await repository.unfinished('conversation')
    expect(roster.activities).toHaveLength(100)
    expect(roster.hasMore).toBe(true)
  })
  it('accepts same-status authoritative history without inventing order and preserves the admitted transport watermark', async () => {
    const transport = { nativeSessionId: 'session', nativeTurnId: 'turn-A', source: { connectionId: 'connection-1', sequence: '8' } }
    await repository.append('conversation', 'A', value('running'), transport)
    expect(await repository.append('conversation', 'A', value('running', 'current history'), {
      nativeSessionId: 'session', nativeTurnId: 'turn-A', source: { system: 'codex_history' }, authoritativeReconciliation: true,
    })).toBeDefined()
    expect(await repository.append('conversation', 'A', value('running', 'late stream'), { ...transport, source: { ...transport.source, sequence: '7' } })).toBeUndefined()
    expect(await repository.append('conversation', 'A', value('running', 'stale history'), { ...transport, source: { ...transport.source, sequence: '7' }, authoritativeReconciliation: true })).toBeUndefined()
    const item = (await pool.query('select source_provenance,record from operator_conversation_activity')).rows[0]
    expect(item.record.title).toBe('current history'); expect(item.source_provenance.sequence).toBe('8')
  })

  for (const ordered of [true, false]) it(`persists ${ordered ? 'ordered snapshots' : 'unsequenced authoritative correction'} through the actual Agent service`, async () => {
    const f = fixture()
    Object.assign(f.service, { activity: repository })
    const manager: import('../src/modules/harnesses/port.js').NativeHarnessSessionManager = f.manager
    manager.startTurn = async function* (_session, input) {
      const event = (sequence: number, output: string) => ({ ...(ordered ? { connectionId: 'mounted-connection' } : {}), sequence,
        occurredAt: '2026-10-01T00:00:00Z', type: 'item.snapshot', payload: {
          turnId: 'turn-A', item: { id: 'mounted-tool', type: 'commandExecution', status: 'running', aggregatedOutput: output },
        } })
      f.manager.histories.set(input.clientCorrelationId, { correlationId: input.clientCorrelationId, nativeTurnId: 'turn-A',
        events: [event(0, 'authoritative correction')], pendingInteractions: [], terminalResult: { outcome: 'succeeded' } })
      await input.onSubmitted?.('turn-A')
      yield event(1, 'first'); yield event(2, 'second')
    }
    const outputs: unknown[] = []
    const unsubscribe = f.service.events.subscribe('conversation', (event) => {
      if (event.type === 'activity') outputs.push((event.data.activity as { output?: string }).output)
    })
    try {
      await f.send('A')
      // The pump awaits real PostgreSQL I/O; unit fixture tick counts are not a completion fence.
      await f.internals.tasks.get(f.store.row.id)
      await f.idle()
      expect(outputs).toEqual(ordered ? ['first', 'second', 'authoritative correction'] : ['first', 'authoritative correction'])
      const stored = (await pool.query("select record,revision::text,source_provenance from operator_conversation_activity where activity_id='mounted-tool'")).rows[0]
      expect(stored.record.output).toBe('authoritative correction'); expect(stored.revision).toBe(ordered ? '2' : '1')
      expect(stored.source_provenance.system).toBe('codex_history')
      expect(stored.source_provenance.transportSequence).toBe(ordered ? 2 : undefined)
      expect(stored.source_provenance.connectionId).toBe(ordered ? 'mounted-connection' : undefined)
      expect(stored.source_provenance.nativeSequence).toBeUndefined()
      expect(stored.source_provenance.sequence).toBeUndefined()
    } finally { unsubscribe(); await f.service.shutdown() }
  })

  it('requests authoritative reconciliation when a transport connection changes without promoting its reset sequence', async () => {
    let requested = 0
    await repository.append('conversation', 'A', value('running'), {
      nativeSessionId: 'session', nativeTurnId: 'turn-A', source: { connectionId: 'connection-old', sequence: '50' },
    })
    expect(await repository.append('conversation', 'A', value('running', 'new connection'), {
      nativeSessionId: 'session', nativeTurnId: 'turn-A', source: { connectionId: 'connection-new', sequence: '1' },
      onReconciliationRequired: () => { requested++ },
    })).toBeUndefined()
    expect(requested).toBe(1)
    const stored = (await pool.query('select source_provenance,record from operator_conversation_activity')).rows[0]
    expect(stored.source_provenance).toMatchObject({ connectionId: 'connection-old', sequence: '50' })
    expect(stored.record.title).toBe('Tool')
  })

})
