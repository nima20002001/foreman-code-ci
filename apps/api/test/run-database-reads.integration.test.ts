import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { runtimeTimingChannel, type RuntimeTimingRecord } from '../src/infrastructure/runtimeTiming.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (closes.length) await closes.pop()!()
})

async function countStatements<T>(work: () => Promise<T>) {
  let statements = 0
  const record = (message: unknown) => {
    if ((message as RuntimeTimingRecord).phase === 'sql.query') statements++
  }
  runtimeTimingChannel.subscribe(record)
  try { return { value: await work(), statements } }
  finally { runtimeTimingChannel.unsubscribe(record) }
}

describe.skipIf(!postgresEnabled)('Run database reads', () => {
  it('reads execution pages with a query count independent of page size and preserves details', async () => {
    const f = await checkpointRuntimeFixture(2, 1, { approvalNodeIds: [] })
    closes.push(f.close)
    await f.engine.start(f.f.run.id)
    const one = await countStatements(() => f.runs.listRepeatExecutions(f.f.run.id, '', 1))
    const all = await countStatements(() => f.runs.listRepeatExecutions(f.f.run.id, '', 100))
    expect(all.value).toHaveLength(3)
    expect(all.statements).toBeLessThanOrEqual(one.statements)
    const tail = await f.runs.listRepeatExecutions(f.f.run.id, one.value[0]!.execution.id, 100)
    expect(tail).toEqual(all.value.slice(1))
    const details = await f.runs.getDetails(f.f.run.workspaceId, f.f.run.id)
    expect(details?.executions).toEqual(all.value.map(item => item.execution))
  }, 60_000)

  it('finds persisted artifact transfers through an index as command history grows', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { approvalNodeIds: [] })
    closes.push(f.close)
    await f.db.pool.query(`insert into management_command_receipts
      (principal_id,operation,command_id,target_key,input_hash,result)
      select $1,'remote.artifact-transfer.admit','transfer-'||n,'artifact','hash',
        jsonb_build_object('intent',jsonb_build_object('transferId','transfer-'||n))
      from generate_series(1,6000) n`, [f.authorizationPrincipalId])
    await f.db.pool.query('analyze management_command_receipts')
    const result = await f.db.pool.query(`explain (analyze,format json) select result from management_command_receipts
      where operation=$1 and result->'intent'->>'transferId'=$2`, ['remote.artifact-transfer.admit', 'transfer-4500'])
    type Plan = { 'Node Type': string; 'Actual Rows': number; Plans?: Plan[] }
    const plan = result.rows[0]!['QUERY PLAN'][0].Plan as Plan
    const nodes = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(nodes)]
    expect(nodes(plan).some(node => ['Index Scan', 'Bitmap Index Scan'].includes(node['Node Type']))).toBe(true)
    expect(plan['Actual Rows']).toBe(1)
  }, 60_000)

  it('publishes each retained recovery frame once in bounded batches and backs off unchanged history', async () => {
    const published = new Map<string, number>()
    const f = await checkpointRuntimeFixture(1, 1, { approvalNodeIds: [],
      nativeSourcePersisted: async (_sql, _evidence, source) => {
        if (source.original.type !== 'event' || source.original.event.type !== 'assistant.delta') return
        const key = `${source.execution.executionId}:${source.original.event.sequence}`
        published.set(key, (published.get(key) ?? 0) + 1)
      },
    })
    closes.push(f.close)
    const reconcile = f.provider.reconcile.bind(f.provider)
    const passes = new Map<string, number>()
    const histories = new Map<string, NativeHarnessEvent[]>()
    vi.spyOn(f.provider, 'reconcile').mockImplementation(async (...args) => {
      const history = await reconcile(...args)
      if (!history.terminalTurn) return history
      const pass = (passes.get(args[0].nativeSessionId) ?? 0) + 1
      passes.set(args[0].nativeSessionId, pass)
      if (pass > 3) return history
      let events = histories.get(args[0].nativeSessionId)
      if (!events) {
        events = Array.from({ length: 18 }, (_, index) => ({ sequence: index + 10,
          connectionId: 'retained-stream', type: 'assistant.delta', occurredAt: new Date().toISOString(),
          payload: { text: `output-${index}` } }))
        histories.set(args[0].nativeSessionId, events)
      }
      const active = { ...history, events }
      delete active.terminalTurn
      delete active.terminalResult
      return active
    })
    const append = vi.spyOn(f.runs, 'appendNativeEvents')
    const intervals: number[] = []
    const record = (message: unknown) => {
      const timing = message as RuntimeTimingRecord
      if (timing.phase === 'execution.backoff') intervals.push(timing.intervalMs!)
    }
    runtimeTimingChannel.subscribe(record)
    try { await f.engine.start(f.f.run.id) }
    finally { runtimeTimingChannel.unsubscribe(record) }
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
    expect(published.size).toBe(36)
    expect([...published.values()]).toEqual(Array(36).fill(1))
    const recoveredBatches = append.mock.calls.filter(([frames]) => frames.some(frame => frame.event.type === 'assistant.delta'))
    expect(recoveredBatches.map(([frames]) => frames.length)).toEqual([16, 2, 16, 2])
    expect(intervals.slice(0, 2)).toEqual([100, 200])
  }, 60_000)
})
