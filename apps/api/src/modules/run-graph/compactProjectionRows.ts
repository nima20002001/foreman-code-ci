import { RUN_GRAPH_LIMITS, type RunGraphScope } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'
import { assertGraphTransaction } from './connection.js'
import { REPEAT_GRAPH_PINS_SQL, type RepeatGraphPinsRow } from './repeatProjectionRows.js'
import { PUBLIC_ATTENTION_SQL, type PublicAttentionRow } from './currentAttention.js'
import { CURRENT_NATIVE_ACTIVITIES_SQL, type CurrentNativeActivityRow } from './currentActivity.js'
import { PUBLIC_RUN_STATE_SQL, type PublicRunStateRow } from './publicRunState.js'
import {
  PUBLIC_NODE_RUN_SQL, PUBLIC_NODE_EXECUTIONS_SQL, PUBLIC_NODE_JOBS_SQL, PUBLIC_NODE_RESOLUTIONS_SQL,
  type PublicNodeRunRow, type PublicNodeExecutionRow, type PublicNodeJobRow, type PublicNodeResolutionRow,
} from './publicProjection.js'
import {
  CURRENT_INTERACTIONS_SQL, CURRENT_REVIEWS_SQL, type CurrentInteractionRow, type CurrentReviewRow,
} from '../interactions/wave25/currentExchanges.js'

export interface CurrentBindingRow {
  record: { bindingId: string; recipient: unknown; inputDigest: string;
    source: { relationshipId: string; execution: unknown; acceptedResultDigest: string }; ordinal: number }
  bound_at: Date | string
}
export const CURRENT_BINDINGS_SQL = `select b.record,b.bound_at from run_repeat_bindings b
      where b.run_id=$1 and b.recipient_execution_id=any($2::text[]) and b.record->>'kind'<>'carry'
      order by b.binding_id limit $3`

export interface CompactProjectionRows {
  pins?: RepeatGraphPinsRow[]
  nodeRun: PublicNodeRunRow[]
  executions: PublicNodeExecutionRow[]
  jobs: PublicNodeJobRow[]
  attention: PublicAttentionRow[]
  native: CurrentNativeActivityRow[]
  runState: PublicRunStateRow[]
  interactions: CurrentInteractionRow[]
  reviews: CurrentReviewRow[]
  resolutions: PublicNodeResolutionRow[]
  bindings: CurrentBindingRow[]
}

function parameters(statement: string, values: readonly string[]): string {
  return statement.replace(/\$(\d+)\b/g, (_match, index: string) => values[Number(index) - 1]!)
}

/** Read each projection cut in one statement. The existing readers still validate every row and bound.
 * Run/head locks already fence writers; finalization calls this again for a fresh cut. */
export async function readCompactProjectionRows(sql: GraphTransactionSql, scope: RunGraphScope,
  nodeIds?: readonly string[]): Promise<CompactProjectionRows> {
  assertGraphTransaction(sql)
  const nodes = '(select ids from projection_nodes)::text[]'
  const executions = '(select ids from projection_executions)::text[]'
  const pins = nodeIds === undefined ? REPEAT_GRAPH_PINS_SQL : undefined
  const queries = {
    ...(pins === undefined ? {} : { pins }),
    nodeRun: PUBLIC_NODE_RUN_SQL,
    executions: parameters(PUBLIC_NODE_EXECUTIONS_SQL, ['$1', nodes]),
    jobs: parameters(PUBLIC_NODE_JOBS_SQL, ['$1', nodes, '$3', '$4', '$5']),
    attention: parameters(PUBLIC_ATTENTION_SQL, ['$1', '$7', 'null', 'null']),
    native: parameters(CURRENT_NATIVE_ACTIVITIES_SQL, ['$1', nodes, '$6']),
    runState: parameters(PUBLIC_RUN_STATE_SQL, ['$1', '$4', '$5', '$3']),
    interactions: parameters(CURRENT_INTERACTIONS_SQL, ['$1', '$8']),
    reviews: parameters(CURRENT_REVIEWS_SQL, ['$1', '$8']),
    resolutions: parameters(PUBLIC_NODE_RESOLUTIONS_SQL, ['$1', nodes, executions]),
    bindings: parameters(CURRENT_BINDINGS_SQL, ['$1', executions, '$9']),
  }
  const ctes = [
    ...(pins === undefined ? [`projection_nodes as materialized (select $2::text[] as ids)`] : [
      `pins as materialized (${pins})`,
      `projection_nodes as materialized (
      select coalesce($2::text[],(select array_agg(n.node->>'id') from pins p
        cross join lateral jsonb_array_elements(p.version_record->'definition'->'nodes') n(node))) as ids
      )`,
    ]),
    `executions as materialized (${queries.executions})`,
    `jobs as materialized (${queries.jobs})`,
    `projection_executions as materialized (
      select coalesce(array_agg(id),'{}'::text[]) as ids from (
        select id from executions union all select id from jobs
      ) e
    )`,
    ...Object.entries(queries).filter(([name]) => !['pins', 'executions', 'jobs'].includes(name))
      .map(([name, query]) => `"${name}" as materialized (${query})`),
  ]
  const columns = Object.keys(queries).map(name =>
    `coalesce((select json_agg(row) from "${name}" row),'[]'::json) as "${name}"`)
  const result = await sql.query<CompactProjectionRows>(`with ${ctes.join(',')} select ${columns.join(',')}`,
    [scope.runId, nodeIds ? [...nodeIds] : null,
    scope.workflowVersionId, scope.workspaceId, scope.workflowId,
    RUN_GRAPH_LIMITS.nodes + RUN_GRAPH_LIMITS.exchanges + 1, null, RUN_GRAPH_LIMITS.exchanges + 1,
    RUN_GRAPH_LIMITS.relationships + 1])
  return result.rows[0]!
}
