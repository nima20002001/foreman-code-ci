import type { RunIntervalCheck } from '@foreman-code/contracts/run-snapshots'
import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import type pg from 'pg'

type Queryable = { query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> }
export interface IntervalCheckFacts {
  /** An unfinished execution of the node, preferring graph work over a check. */
  openId: string | null; openTick: boolean | null
  lastFinished: string | null; lastTick: number
  /** The node's latest check in any state. */
  lastTickId: string | null
  /** The node still has graph work to do: no resolution, or an unfinished work activation. */
  graphOpen: boolean
}

/** One reading of a node's check state, shared by admission and the Board. */
export async function readIntervalCheckFacts(sql: Queryable, runId: string, nodeId: string,
  handoffs: boolean): Promise<IntervalCheckFacts> {
  const row = (await sql.query<{ open_id: string | null; open_tick: boolean | null; last_finished: string | null
    last_tick: number; last_tick_id: string | null; graph_open: boolean }>(`select open.id as open_id,open.tick as open_tick,
      (select max(e.record->>'finishedAt') from harness_executions e where e.run_id=$1 and e.workflow_node_id=$2
        and e.record->>'state'='completed') as last_finished,
      coalesce((select max(e.tick_index) from harness_executions e where e.run_id=$1 and e.workflow_node_id=$2),0) as last_tick,
      (select e.id from harness_executions e where e.run_id=$1 and e.workflow_node_id=$2 and e.tick_index is not null
        order by e.tick_index desc limit 1) as last_tick_id,
      case when $3 then exists(select 1 from run_work_activations a where a.run_id=$1 and a.workflow_node_id=$2
          and a.state<>'completed')
        else not exists(select 1 from run_repeat_resolutions r where r.run_id=$1 and r.occurrence_key=''
          and r.workflow_node_id=$2) end as graph_open
    from (select 1) one left join lateral (select e.id,e.tick_index is not null as tick from harness_executions e
      where e.run_id=$1 and e.workflow_node_id=$2 and e.record->>'state'<>'completed'
      order by e.tick_index nulls first,e.id limit 1) open on true`, [runId, nodeId, handoffs])).rows[0]!
  return { openId: row.open_id, openTick: row.open_tick, lastFinished: row.last_finished,
    lastTick: Number(row.last_tick), lastTickId: row.last_tick_id, graphOpen: row.graph_open }
}

/** When the next check may start, or null while one is running, graph work is open, the node never
 * finished. */
export function nextIntervalCheckAt(facts: IntervalCheckFacts, everySeconds: number): string | null {
  if (facts.openId || facts.graphOpen || !facts.lastFinished) return null
  return new Date(Date.parse(facts.lastFinished) + everySeconds * 1000).toISOString()
}

/** Live check state of every interval node; next times only while the Run is running. */
export async function readRunIntervalChecks(sql: Queryable, runId: string, executionState: string,
  version: WorkflowVersionV3): Promise<RunIntervalCheck[]> {
  const checks: RunIntervalCheck[] = []
  for (const node of version.definition.nodes) {
    if (node.kind === 'job' || !node.interval) continue
    const facts = await readIntervalCheckFacts(sql, runId, node.id, Boolean(version.definition.handoffs))
    const active = executionState === 'running'
    checks.push({ nodeId: node.id, everySeconds: node.interval.everySeconds, checks: facts.lastTick,
      running: active && facts.openTick === true, nextCheckAt: active ? nextIntervalCheckAt(facts, node.interval.everySeconds) : null })
  }
  return checks
}
