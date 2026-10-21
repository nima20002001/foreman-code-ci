import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, vi } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import { CURRENT_WORKFLOW_TOOLS, CurrentEditReadResultSchema, CurrentWorkflowSaveInputSchema,
  CurrentWorkflowSaveResultSchema, type CurrentWorkflowSaveInput } from '@foreman-code/contracts/wave25'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import type { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { graphHeaders, graphRpcValue } from '../eng04-graph-composition-fixture.js'
import { rejectableDeferred } from './deferred.js'

export type SaveFixture = Awaited<ReturnType<typeof currentOperatorIntegration>>
export type Transport = 'http' | 'mcp'
export const transports: Transport[] = ['http', 'mcp']
export const definitionUrl = (scope: { workspaceId: string; workflowId: string }) =>
  `/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/definition`

export async function meaningfulInput(f: SaveFixture): Promise<CurrentWorkflowSaveInput> {
  const row = (await f.db.pool.query(`select record,revision::text,current_version_id from workflows where id=$1`,
    [f.f.scope.workflowId])).rows[0]!
  return CurrentWorkflowSaveInputSchema.parse({ workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId,
    commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: Number(row.revision),
    expectedWorkflowVersionId: row.current_version_id,
    expectedAgentConfigurationVersionIds: f.f.version.agentConfigurationVersionIds,
    graph: { ...row.record, nodes: row.record.nodes.map((node: { id: string }) => ({ ...node, initialPrompt: `Meaningful edit for ${node.id}` })) } })
}
/** currentOperatorIntegration already owns a listening app and an authenticated
 * MCP connection. Reuse that client; graphRpc owns a separate lazy listener and
 * must not call listen() a second time on this fixture's Fastify instance. Keep
 * tool failures intact so negative admission assertions see the original code. */
export async function rpc(f: Pick<SaveFixture, 'client'>, name: string, args: Record<string, unknown>) {
  return { result: await f.client.callTool({ name, arguments: args }) }
}
export async function saveThrough(f: SaveFixture, transport: Transport, input: CurrentWorkflowSaveInput) {
  if (transport === 'http') {
    const reply = await f.app.inject({ method: 'PUT', url: definitionUrl(input), headers: graphHeaders(f.writer.token), payload: input })
    expect(reply.statusCode, reply.body).toBe(200)
    return CurrentWorkflowSaveResultSchema.parse(reply.json())
  }
  const reply = await rpc(f, CURRENT_WORKFLOW_TOOLS.save, input)
  expect(reply.result?.isError, JSON.stringify(reply)).not.toBe(true)
  return CurrentWorkflowSaveResultSchema.parse(graphRpcValue(reply.result as unknown as Parameters<typeof graphRpcValue>[0]))
}
export async function editThrough(f: SaveFixture, transport: Transport,
  input: { workspaceId: string; workflowId: string; [key: string]: unknown }) {
  if (transport === 'http') {
    const reply = await f.app.inject({ method: 'POST', url: `${definitionUrl(input)}/edits`, headers: graphHeaders(f.writer.token), payload: input })
    expect(reply.statusCode, reply.body).toBe(200)
    return CurrentEditReadResultSchema.parse(reply.json())
  }
  const reply = await rpc(f, CURRENT_WORKFLOW_TOOLS.edits, input)
  expect(reply.result?.isError, JSON.stringify(reply)).not.toBe(true)
  return CurrentEditReadResultSchema.parse(graphRpcValue(reply.result as unknown as Parameters<typeof graphRpcValue>[0]))
}
export async function stageThrough(f: SaveFixture, transport: Transport, input: CurrentWorkflowSaveInput) {
  const stage = { ...input, commandId: randomUUID(), action: 'stage_edits', draftId: `editor-${randomUUID()}` }
  const result = await editThrough(f, transport, stage)
  expect(result.intent?.state).toBe('staged')
  const intent = result.intent!
  return { result, intent, advance: { workspaceId: input.workspaceId, workflowId: input.workflowId, draftId: stage.draftId,
    intentId: intent.id, commandId: intent.advanceCommandId, action: 'stop_and_save' } }
}
export async function versionCount(f: SaveFixture) {
  return Number((await f.db.pool.query('select count(*)::text as n from workflow_versions where workflow_id=$1', [f.f.scope.workflowId])).rows[0]!.n)
}
export async function assertSettled(f: SaveFixture) {
  const snapshot = await f.runs.getRepeatSnapshot(f.f.run.id)
  expect(snapshot.run.executionState).toBe('completed')
  expect(snapshot.cleanupPending).toBe(false)
  return snapshot
}

/** Timing-only gate before the REAL observeExact boundary. Stop aborts the
 * gate, then the original method sees its original aborted owner/signal. No
 * execution result, native permission, closure or cleanup receipt is mocked. */
export function parkBeforeNativeEntry(f: SaveFixture) {
  const parked = rejectableDeferred<HarnessExecution>(), release = rejectableDeferred()
  const observe = f.native.observeExact.bind(f.native)
  const spy = vi.spyOn(f.native, 'observeExact').mockImplementation(async (input) => {
    const abort = () => release.resolve()
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) abort()
    parked.resolve(input.execution)
    try { await release.promise; return await observe(input) }
    finally { input.signal.removeEventListener('abort', abort) }
  })
  const drive = f.engine.start(f.f.run.id).then(() => undefined, (error: unknown) => error)
  return { parked: Promise.race([parked.promise, drive.then(() => { throw new Error('Run exited before the native-entry gate') })]),
    drive, release: () => release.resolve(), restore: () => spy.mockRestore() }
}

/** Corruption is ONLY negative fault setup inside the fixture's random test
 * schema. Disable user immutability triggers only around the fault/restore;
 * production readers, writers, constraints and transport calls remain real.
 * No positive settlement receipt is fabricated by this helper. */
export async function corruptProof(pool: pg.Pool, table: 'workflow_native_entries' | 'execution_native_recoveries',
  executionId: string, fault: 'missing' | 'mismatched') {
  const original = (await pool.query(`select to_jsonb(p) as record from ${table} p where execution_id=$1`, [executionId])).rows
  expect(original).toHaveLength(1)
  async function change(restore: boolean) {
    await withTransaction(pool, async client => {
      await client.query(`alter table ${table} disable trigger user`)
      if (restore) {
        await client.query(`delete from ${table} where execution_id=$1`, [executionId])
        await client.query(`insert into ${table} select * from jsonb_populate_record(null::${table},$1::jsonb)`, [JSON.stringify(original[0]!.record)])
      } else if (fault === 'missing') {
        await client.query(`delete from ${table} where execution_id=$1`, [executionId])
      } else if (table === 'workflow_native_entries') {
        await client.query(`update workflow_native_entries set reservation=jsonb_set(reservation,'{execution,attempt}','2'::jsonb) where execution_id=$1`, [executionId])
      } else {
        await client.query(`update execution_native_recoveries set execution_identity=jsonb_set(execution_identity,'{attempt}','2'::jsonb) where execution_id=$1`, [executionId])
      }
      await client.query(`alter table ${table} enable trigger user`)
    })
  }
  await change(false)
  return () => change(true)
}
