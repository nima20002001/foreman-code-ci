import { logIgnoredError } from '../diagnostics/ignoredError.js'
import type pg from 'pg'
export interface GraphMeasurement {
  stage: 'snapshot' | 'delta' | 'projection' | 'publication' | 'storage'
  outcome: 'ok' | 'error' | 'ignored' | 'rejected'
  durationMs: number
  bytes?: number
  rows?: number
}
/** Bounded labels only. Implementations must not attach Run IDs, native IDs or payloads. */
export type GraphMeasurementSink = (measurement: Readonly<GraphMeasurement>) => void
export function observeGraph(sink: GraphMeasurementSink | undefined, measurement: GraphMeasurement): void {
  try { sink?.(Object.freeze({ ...measurement })) } catch (error) { logIgnoredError('engine', 'publish graph measurement', error) }
}
/** Qualification hook, NOT called on every graph poll. Counts are planner estimates, bytes are relation sizes. */
export async function measureGraphStorage(pool: pg.Pool, sink?: GraphMeasurementSink) {
  const start = performance.now()
  const rows = await pool.query<{ relation: string; bytes: string; estimated_rows: number }>(
    `select relname as relation,pg_total_relation_size(oid)::text as bytes,greatest(reltuples,0) as estimated_rows
     from pg_class where relnamespace=current_schema()::regnamespace
       and relname=any($1::text[]) order by relname`,
    [['run_graph_batches', 'run_graph_sources', 'run_native_activity', 'run_native_correlations', 'run_native_projection_checkpoints']])
  observeGraph(sink, { stage: 'storage', outcome: 'ok', durationMs: performance.now() - start, rows: rows.rows.length })
  return rows.rows
}
