import { assertOwnedExecutionDestinations, assertOwnedTestApi,
  ownedTestDatabaseUrl, ownedTestPath } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { until } from './fixtures/codex-test-helpers.js'
import { HarnessExecutionSchema, NativeSessionReferenceSchema } from '@foreman-code/contracts'
import { AgentChatContextSchema, AgentChatStateSchema, SendAgentChatMessageResponseSchema, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'

import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { readNativeSource } from './helpers/agentChatNativeSource.js'

/** Opt-in against an ALREADY RUNNING, task-owned local API and a genuinely terminal
 * native Run. No fake Run read port, seed SQL, synthetic native identity, reset,
 * migration, runtime launch, credential minting or authority changes in this test.
 * Configure the six AGENT_CHAT_ACCEPTANCE_* values documented in the F4 handoff.
 */
const enabled = process.env.RUN_REAL_AGENT_CHAT_RUN_TESTS === '1'
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for the isolated real-Run acceptance test.`)
  return value
}
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`

async function protectedState(pool: pg.Pool, schema: string, checkpointSchema: string): Promise<string> {
  const client = await pool.connect()
  try {
    await client.query('begin isolation level repeatable read read only')
    const tables = (await client.query<{ schema: string; name: string }>(`select n.nspname as schema,c.relname as name
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname=any($1::text[]) and c.relkind in ('r','p') order by n.nspname,c.relname`, [[schema, checkpointSchema]])).rows
      .filter((table) => table.schema === checkpointSchema && /^checkpoint/.test(table.name)
        || table.schema === schema && /^(runs$|harness_executions$|native_session_lanes$|workspaces$|agents$|agent_configuration_|workflows$|workflow_|graph_|run_|execution_|current_workflow_|repeat_workflow_|approval_execution_|interaction_graph_)/.test(table.name))
    for (const name of ['runs', 'harness_executions', 'native_session_lanes', 'workflows', 'workflow_versions', 'graph_drafts',
      'run_repeat_results', 'run_graph_heads', 'current_workflow_publications', 'repeat_workflow_publications']) {
      if (!tables.some((table) => table.schema === schema && table.name === name)) throw new Error(`Protected table ${name} is absent.`)
    }
    if (!tables.some((table) => table.schema === checkpointSchema && table.name === 'checkpoints')) throw new Error('The actual checkpoint schema must be included.')
    const state: Record<string, string[]> = {}
    for (const table of tables) {
      const rows = (await client.query<{ row: unknown }>(`select to_jsonb(t) as row from ${identifier(table.schema)}.${identifier(table.name)} t`)).rows
      state[`${table.schema}.${table.name}`] = rows.map((row) => canonicalJson(row.row)).sort()
    }
    await client.query('commit')
    return canonicalJson(state)
  } finally {
    await client.query('rollback').catch(() => undefined)
    client.release()
  }
}

describe.skipIf(!enabled)('F4 A-R21 actual terminal-Run to Agent-chat immutability', () => {
  it('forks and follows up through the authenticated API without changing source native, Run, execution, results, graph or checkpoints', async () => {
    const api = new URL(required('AGENT_CHAT_ACCEPTANCE_API_URL'))
    const database = new URL(ownedTestDatabaseUrl('AGENT_CHAT_ACCEPTANCE_DATABASE_URL'))
    const loopback = ['localhost', '127.0.0.1', '[::1]']
    if (!loopback.includes(api.hostname) || !loopback.includes(database.hostname) || !database.pathname.toLowerCase().includes('test')) {
      throw new Error('Acceptance requires a loopback API and an explicitly named test database.')
    }
    const schema = required('AGENT_CHAT_ACCEPTANCE_SCHEMA')
    const checkpointSchema = required('AGENT_CHAT_ACCEPTANCE_CHECKPOINT_SCHEMA')
    if (![schema, checkpointSchema].every((value) => /^chat_acceptance_[a-z0-9_]+$/.test(value))) {
      throw new Error('Use dedicated chat_acceptance_* schemas; never shared app/checkpoint schemas.')
    }
    const context = AgentChatContextSchema.parse(JSON.parse(required('AGENT_CHAT_ACCEPTANCE_CONTEXT')))
    if (!context.runId) throw new Error('Select an actual terminal Run; fresh Agent chat is not this acceptance test.')
    const token = required('AGENT_CHAT_ACCEPTANCE_TOKEN')
    const pool = new pg.Pool({ connectionString: database.toString(), max: 1,
      options: `-c search_path=${schema} -c default_transaction_read_only=on -c statement_timeout=15000` })
    const root = `/api/workspaces/${encodeURIComponent(context.workspaceId)}/agent-chat`
    const query = { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId, runId: context.runId }
    const params = new URLSearchParams(query)
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(new URL(path, api), { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`Authenticated acceptance request failed (${response.status}); no automatic retry.`)
      return response.json() as Promise<unknown>
    }
    const read = async () => AgentChatStateSchema.parse(await request(`${root}?${params}`))
    const settled = async (requestId: string): Promise<AgentChatState> => {
      return until(async () => {
        const state = await read(), receipt = state.turns.find((turn) => turn.requestId === requestId)
        if (receipt && ['failed', 'canceled', 'unknown'].includes(receipt.delivery)) throw new Error(`Native acceptance ended ${receipt.delivery}; no resend.`)
        if (receipt?.delivery === 'completed' && !state.activeTurn) return state
        return undefined
      }, 120_000)
    }
    try {
      await assertOwnedTestApi(api, pool)
      await assertOwnedExecutionDestinations(pool, { workspaceId: context.workspaceId, runId: context.runId })
      const run = WorkflowRunV3Schema.parse((await pool.query<{ record: unknown }>('select record from runs where id=$1', [context.runId])).rows[0]?.record)
      expect(run.workspaceId).toBe(context.workspaceId)
      expect(run.workflowId).toBe(context.workflowId)
      expect(['completed', 'interrupted']).toContain(run.executionState)
      const executions = (await pool.query<{ record: unknown }>('select record from harness_executions where run_id=$1', [context.runId])).rows
        .map((row) => HarnessExecutionSchema.parse(row.record))
        .filter((execution) => execution.workflowNodeId === context.workflowNodeId && execution.agentId === context.agentId && execution.nativeSessionId)
      // A one-occurrence fixture keeps this proof independent of A-R19's source-selection fix.
      expect(executions).toHaveLength(1)
      const execution = executions[0]!
      if (!execution.workingDirectory || !execution.nativeSessionId) throw new Error('The terminal execution has no actual native storage identity.')
      ownedTestPath(execution.workingDirectory)
      const initial = await read()
      expect(initial.conversation).toBeNull()
      expect(initial.availability.canSend).toBe(true)
      const lane = (await pool.query<{ record: { providerVersion?: string } }>(
        'select record from native_session_lanes where native_session_id=$1 order by updated_at desc limit 1', [execution.nativeSessionId])).rows[0]
      const session = NativeSessionReferenceSchema.parse({ harness: initial.capabilities.harness,
        providerVersion: lane?.record.providerVersion, nativeSessionId: execution.nativeSessionId })
      const sourceBefore = await readNativeSource(session, execution.workingDirectory)
      const before = await protectedState(pool, schema, checkpointSchema)
      const firstId = randomUUID()
      const sent = SendAgentChatMessageResponseSchema.parse(await request(`${root}/messages`, { requestId: firstId,
        context: query, content: 'Summarize what you did in the completed Run in one sentence. Do not use tools or change files.',
        intent: 'next_turn', expectedConversationId: null }))
      const first = await settled(firstId)
      expect(first.conversation?.id).toBe(sent.state.conversation?.id)
      expect(first.conversation?.origin).toEqual({ kind: 'run_execution', runId: context.runId,
        executionId: execution.id, sourceNativeSessionId: execution.nativeSessionId })
      expect(first.conversation?.nativeSession?.nativeSessionId).not.toBe(execution.nativeSessionId)
      const secondId = randomUUID()
      await request(`${root}/messages`, { requestId: secondId, context: query, content: 'Now restate that in five words. Do not use tools or change files.',
        intent: 'next_turn', expectedConversationId: first.conversation!.id })
      const second = await settled(secondId)
      expect(second.conversation?.nativeSession).toEqual(first.conversation?.nativeSession)
      // Compare full canonical contents without printing private Run/native content in failed-test diffs.
      expect(await readNativeSource(session, execution.workingDirectory) === sourceBefore, 'full source native history changed').toBe(true)
      expect(await protectedState(pool, schema, checkpointSchema) === before, 'protected Run/execution/result/graph/checkpoint rows changed').toBe(true)
    } finally { await pool.end() }
  }, 360_000)
})
