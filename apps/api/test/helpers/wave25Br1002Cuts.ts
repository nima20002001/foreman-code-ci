import { vi } from 'vitest'
import type { GraphFact } from '@foreman-code/contracts/wave25'
import type { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import type { WorkflowNativeCaptureInput } from '../../src/modules/interactions/workflowNativeCapture.js'
import type { codexApprovalRuntime } from './codexApprovalRuntime.js'
import { rejectableDeferred } from './deferred.js'

export type Br1002Runtime = Awaited<ReturnType<typeof codexApprovalRuntime>>
export type Br1002NativeArgs = Parameters<PostgresRunRepository['updateExecution']>

/** Pause outside publication transactions around the real original-history
 * update. Negative mutations happen before the private channel freezes source. */
export function br1002ContinuationCut(f: Br1002Runtime,
  degrade: (input: WorkflowNativeCaptureInput) => WorkflowNativeCaptureInput = (input) => input) {
  const before = rejectableDeferred<Br1002NativeArgs>(), after = rejectableDeferred<Br1002NativeArgs>()
  const enter = rejectableDeferred(), finish = rejectableDeferred()
  const original = f.runs.updateExecution.bind(f.runs)
  const capture = f.nativeCapture.capture.bind(f.nativeCapture)
  let selected = false
  const captureSpy = vi.spyOn(f.nativeCapture, 'capture').mockImplementation((input) =>
    capture(input.source.type === 'history' && input.source.history.terminalTurn ? degrade(input) : input))
  const spy = vi.spyOn(f.runs, 'updateExecution').mockImplementation(async (...args) => {
    if (selected || args[0].state !== 'completed') return original(...args)
    selected = true
    before.resolve(args)
    await enter.promise
    try { await original(...args) } finally { after.resolve(args) }
    await finish.promise
  })
  return { before, after, enter, finish, original,
    release() { enter.resolve(); finish.resolve() },
    restore() { spy.mockRestore(); captureSpy.mockRestore() } }
}
export function br1002At<T>(point: Promise<T>, operation: Promise<unknown>): Promise<T> {
  return Promise.race([point, operation.then((result) => {
    const job = result as { state?: string; error?: { code?: string } } | undefined
    throw new Error(`Operation returned before the required native publication cut: ${job?.state ?? 'none'} ${job?.error?.code ?? ''}`)
  })])
}
export async function br1002Ack(f: Br1002Runtime, interactionId: string) {
  return (await f.db.pool.query<{ state: string; approval_native_ack_id: string | null; approval_native_ack_source: unknown }>(
    'select state,approval_native_ack_id,approval_native_ack_source from interaction_graph_resumes where interaction_id=$1',
    [interactionId])).rows[0]
}
export async function br1002Batches(f: Br1002Runtime) {
  return (await f.db.pool.query<{ sequence: string; payload: string }>(
    "select sequence::text,payload from run_graph_batches where run_id=$1 and kind='events' order by sequence",
    [f.f.run.id])).rows.map((row) => ({ sequence: row.sequence,
    facts: (JSON.parse(row.payload) as { events: { fact: GraphFact }[] }).events.map((event) => event.fact) }))
}
