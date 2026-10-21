import type pg from 'pg'
import { z } from 'zod'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { GraphSequenceSchema, RunActivitiesInputSchema, RunActivitiesPageSchema,
  RUN_ACTIVITIES_RETAINED, RUN_ACTIVITIES_PAGE_BYTES,
  canonicalGraphJson, graphJsonBytes, type RunActivitiesPage } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { withCurrentRunRead } from './currentRead.js'
import { RUN_ACTIVITIES_BOUNDS_SQL, RUN_ACTIVITIES_PAGE_SQL } from './activitiesSql.js'
import { publicRunActivity, type ActivityReadRow } from './activityProjection.js'

/** The original Run audit remains immutable. Activities expose its latest 1000
 * rows and make a cursor outside that bounded window explicitly expire. */
export { RUN_ACTIVITIES_RETAINED } from '@foreman-code/contracts/wave25'
const Cursor = z.object({ version: z.literal(1), runId: z.string().min(1).max(200),
  workflowVersionId: z.string().min(1).max(200), mode: z.enum(['older','newer']),
  position: GraphSequenceSchema, through: GraphSequenceSchema }).strict()
type CursorValue = z.infer<typeof Cursor>
const invalid = (code: string, message: string, status = 409): never => { throw new DomainError(code, message, status) }
function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(Cursor.parse(value))).toString('base64url')
}
function decodeCursor(value: string): CursorValue {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return invalid('ACTIVITIES_CURSOR_INVALID', 'The Activities cursor is invalid.', 400)
    return Cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  } catch { return invalid('ACTIVITIES_CURSOR_INVALID', 'The Activities cursor is invalid.', 400) }
}

export class RunActivitiesService {
  constructor(private readonly pool: pg.Pool) {}

  async read(principal: ManagementPrincipal, raw: unknown): Promise<RunActivitiesPage> {
    const input = RunActivitiesInputSchema.parse(raw)
    try { return await withCurrentRunRead(this.pool, principal, input.workspaceId, input.runId, 'runs:read',
      async (sql, snapshot) => {
        const { run, version } = snapshot
        const scope = { workspaceId: run.workspaceId, workflowId: run.workflowId,
          runId: run.id, workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 as const }
        const bounds = (await sql.query<{ high_water: string; retained_from: string; observed: number }>(
          RUN_ACTIVITIES_BOUNDS_SQL, [run.id])).rows[0]
        if (!bounds) return invalid('ACTIVITIES_UNAVAILABLE', 'The Run activity bounds are unavailable.', 503)
        const currentHigh = BigInt(bounds.high_water), floor = BigInt(bounds.retained_from)
        const cursor = input.cursor ? decodeCursor(input.cursor) : undefined
        if (cursor && (cursor.runId !== run.id || cursor.workflowVersionId !== version.id)) {
          return invalid('ACTIVITIES_CURSOR_SCOPE_CONFLICT', 'The cursor belongs to another Run or version.')
        }
        if (cursor) {
          const position = BigInt(cursor.position), through = BigInt(cursor.through)
          if (position>currentHigh || through>currentHigh
            || cursor.mode === 'older' && (through===0n || position>through)
            || cursor.mode === 'newer' && through!==0n && position>through) {
            return invalid('ACTIVITIES_CURSOR_INVALID', 'The Activities cursor is outside the Run history.', 400)
          }
          if (position !== 0n) {
            const anchor = await sql.query('select 1 from run_activity where run_id=$1 and sequence=$2::bigint',
              [run.id, cursor.position])
            if (anchor.rowCount !== 1 || position<floor) return invalid('ACTIVITIES_CURSOR_EXPIRED',
              'The Activities cursor is no longer retained. Reload this Run.', 410)
          } else if (bounds.observed > RUN_ACTIVITIES_RETAINED) return invalid('ACTIVITIES_CURSOR_EXPIRED',
            'The Activities cursor is no longer retained. Reload this Run.', 410)
          if (through!==0n && through<floor) return invalid('ACTIVITIES_CURSOR_EXPIRED',
            'The Activities snapshot is no longer retained. Reload this Run.', 410)
        }
        const mode = cursor?.mode ?? 'initial'
        const through = cursor?.through && cursor.through !== '0' ? cursor.through : bounds.high_water
        const position = cursor?.position ?? through
        const descending = mode !== 'newer'
        const rows = (await sql.query<ActivityReadRow>(RUN_ACTIVITIES_PAGE_SQL.replace('__COMPARATOR__',
          mode === 'initial' ? '<=' : descending ? '<' : '>')
          .replace('__ORDER__', descending ? 'desc' : 'asc'),
        [run.id, position, through, bounds.retained_from, input.limit + 1])).rows
        const selected = rows.slice(0, input.limit)
        if (descending) selected.reverse()
        const items = selected.map((row) => publicRunActivity(row, version, run.id, run.outcome))
        const pageFor = (count: number): RunActivitiesPage => {
          const pageItems = descending ? items.slice(items.length - count) : items.slice(0, count)
          const hasMore = rows.length > count
          const first = pageItems[0]?.sequence
          const last = pageItems.at(-1)?.sequence
          const olderCursor = descending && hasMore && first ? encodeCursor({ version: 1,
            runId: run.id, workflowVersionId: version.id, mode: 'older', position: first, through }) : null
          const nextCursor = encodeCursor({ version: 1, runId: run.id,
            workflowVersionId: version.id, mode: 'newer',
            position: mode === 'newer' && hasMore && last ? last : through,
            through: mode === 'newer' && hasMore ? through : '0' })
          return RunActivitiesPageSchema.parse({ scope, items: pageItems, mode,
            highWater: through, retainedFrom: bounds.retained_from, nextCursor, olderCursor, hasMore })
        }
        let page = pageFor(items.length)
        if (graphJsonBytes(page) > RUN_ACTIVITIES_PAGE_BYTES) {
          let minimum = 1
          let maximum = items.length - 1
          page = pageFor(1)
          while (minimum <= maximum) {
            const count = Math.floor((minimum + maximum) / 2)
            const candidate = pageFor(count)
            if (graphJsonBytes(candidate) <= RUN_ACTIVITIES_PAGE_BYTES) {
              page = candidate
              minimum = count + 1
            } else maximum = count - 1
          }
        }
        canonicalGraphJson(page, RUN_ACTIVITIES_PAGE_BYTES)
        return page
      })
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) throw new DomainError(
        'ACTIVITIES_EVIDENCE_CONFLICT', 'Persisted Run activity evidence is invalid or unavailable.', 409, undefined, { cause: error })
      if (error instanceof Error && error.message === 'GRAPH_JSON_LIMIT') throw new DomainError(
        'ACTIVITIES_PAGE_TOO_LARGE', 'The Activities page exceeds its response bound.', 409, undefined, { cause: error })
      throw error
    }
  }
}
