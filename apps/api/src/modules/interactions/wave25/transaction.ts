import type pg from 'pg'
import { withExclusiveGraphConnection } from '../../run-graph/connection.js'
import { openRunGraphPublication, type RunGraphPublication } from '../../run-graph/publication.js'
import { readPublicProjectionLocked } from '../../run-graph/compactSnapshot.js'
import { fail, scopeForRun } from './context.js'

export async function transact<T>(pool: pg.Pool, runId: string, work: (publication: RunGraphPublication) => Promise<T>): Promise<T> {
  return withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    const scope = await scopeForRun(sql, runId)
    if (scope.executionSemanticsVersion !== 3) return fail('APPROVAL_SEMANTICS_MISMATCH')
    const publication = await openRunGraphPublication(sql, scope, readPublicProjectionLocked)
    // The Run and graph head precede child locks; never upgrade the parent lock.
    // The Run lock serializes its children. Exact writers lock only their
    // requester/reviewer identities, never an unbounded whole-Run history.
    return work(publication)
  }))
}
