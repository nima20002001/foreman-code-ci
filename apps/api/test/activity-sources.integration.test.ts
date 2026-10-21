import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActivityTextOperation } from '@foreman-code/contracts/activity-text'
import { activityCommandSourcesMigration } from '../src/infrastructure/activityCommandSourcesMigration.js'
import { activitySourcesMigration } from '../src/infrastructure/activitySourcesMigration.js'
import { appendConversationTextOperation } from '../src/modules/conversations/conversationTextRepository.js'

const connectionString = process.env.TEST_DATABASE_URL
// Root owns execution. This uses isolated schema and existing record tables, never native/provider I/O.
describe.skipIf(!connectionString)('activity source records in PostgreSQL', () => {
  let admin: pg.Pool; let pool: pg.Pool; let schema: string
  beforeEach(async () => {
    admin = new pg.Pool({ connectionString }); schema = `activity_sources_${randomUUID().replaceAll('-', '')}`
    await createFixtureSchema(admin, schema); pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
    await pool.query(`create table operator_conversations (id text primary key,kind text,revision bigint not null default 0,workspace_id text,workflow_id text,
      workflow_node_id text,agent_id text,origin_run_id text,origin_execution_id text,native_session_id text,active_native_turn_id text,
      active_request_id text,deleted_at timestamptz,harness text,updated_at timestamptz);
      create table operator_conversation_messages (id text primary key,conversation_id text,role text,content text,native_message_id text,record jsonb);
      create unique index source_messages_native on operator_conversation_messages(conversation_id,native_message_id) where native_message_id is not null;
      create table operator_conversation_activity (conversation_id text,request_id text,sequence bigint);
      create table management_command_receipts (principal_id text,operation text,command_id text,result jsonb);
      create table files (file_id text primary key,state text);
      create table runs (id text primary key,record jsonb);
      create table harness_executions (id text primary key,record jsonb);`)
    await pool.query(activitySourcesMigration.sql)
    await pool.query(activityCommandSourcesMigration.sql)
    await pool.query(`insert into operator_conversations (id,kind,workspace_id,workflow_id,workflow_node_id,agent_id,native_session_id,active_native_turn_id,active_request_id,harness)
      values ('conversation','agent','ws','wf','node','agent','session','turn','A','codex')`)
  })
  afterEach(async () => { await pool?.end(); if (admin) { await dropFixtureSchema(admin, schema); await admin.end() } })
  const operation = (sequence: number, text: string, final = false): ActivityTextOperation => ({ identity: {
    scope: { kind: 'agent_chat', conversationId: 'conversation', workspaceId: 'ws', workflowId: 'wf', nodeId: 'node', agentId: 'agent' },
    requestId: 'A', sessionId: 'session', turnId: 'turn', itemId: 'item', channel: 'assistant' },
    mode: final ? 'replace' : 'append', text, final, source: { connectionId: 'connection', sequence } })
  it('changes record revisions only for changed public facts and rejects stale/late deltas', async () => {
    await appendConversationTextOperation(pool, 'conversation', 'A', operation(1, 'draft'))
    await appendConversationTextOperation(pool, 'conversation', 'A', operation(2, '', true))
    const before = (await pool.query('select record,content,activity_record_revision::text from operator_conversation_messages')).rows
    expect(before[0].content).toBe(''); expect(before[0].activity_record_revision).toBe('1')
    await appendConversationTextOperation(pool, 'conversation', 'A', operation(3, 'late'))
    await appendConversationTextOperation(pool, 'conversation', 'A', operation(1, 'stale'))
    expect((await pool.query('select record,content,activity_record_revision::text from operator_conversation_messages')).rows).toEqual(before)
    expect((await pool.query('select revision::text from operator_conversations')).rows[0].revision).toBe('2')
  })
  it('records command source revisions only when the existing receipt changes', async () => {
    await pool.query(`insert into management_command_receipts values ('principal','agent_chat_control','command','{"status":"pending"}',0);
      update management_command_receipts set result='{"status":"completed"}';
      update management_command_receipts set result='{"status":"completed"}'`)
    expect((await pool.query('select activity_record_revision::text from management_command_receipts')).rows[0].activity_record_revision).toBe('1')
  })
  it('preserves independently scoped Run/execution revisions without an event store', async () => {
    await pool.query(`insert into runs values ('run','{}',0); insert into harness_executions values ('execution','{}',0);
      update runs set record='{"executionState":"running"}' where id='run';
      update harness_executions set record='{"state":"running"}' where id='execution';
      update harness_executions set record='{"state":"running"}' where id='execution'`)
    expect((await pool.query('select activity_record_revision::text from runs')).rows[0].activity_record_revision).toBe('1')
    expect((await pool.query('select activity_record_revision::text from harness_executions')).rows[0].activity_record_revision).toBe('1')
  })
})
