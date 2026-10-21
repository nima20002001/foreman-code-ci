import type pg from 'pg'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { CanonicalRunGraphScopeSchema, CanonicalRunGraphReadCapabilitiesSchema, type CanonicalRunGraphReadCapabilities,
  type RepeatGraphSnapshotV3, type RepeatGraphPageV3, type RepeatGraphResetV3, type RepeatGraphCurrentV3 } from '@foreman-code/contracts/wave25'
import { hasAction, requireAuthorization } from '../access/policy.js'
import { readRepeatGraphSnapshot, readRepeatGraphPage, readRepeatGraphCurrent, type AuthorizeRepeatGraphRead } from './repeatReader.js'
import { RunGraphError } from './errors.js'

/** Authenticated, rollout-gated HTTP/Operator-MCP read boundary. The default is
 * closed. Uses the SAME access policy and actual Run tuple as RunGraphReadService;
 * worker/App principals cannot be promoted into Operator read authority. */
export class RepeatGraphReadService {
  readonly qualifiedReads: boolean
  constructor(private readonly primaryPool: pg.Pool, options: { qualifiedReads?: boolean } = {}) {
    // Capture once at trusted composition, not from a mutable request/options object.
    this.qualifiedReads = options.qualifiedReads === true
  }
  capabilities(input: ManagementPrincipal): CanonicalRunGraphReadCapabilities {
    try {
      const principal = ManagementPrincipalSchema.parse(input)
      requireAuthorization(principal, 'capabilities:read')
      if (!hasAction(principal, 'runs:read')) throw new RunGraphError('GRAPH_READ_ACCESS_DENIED')
    } catch { throw new RunGraphError('GRAPH_READ_ACCESS_DENIED') }
    return CanonicalRunGraphReadCapabilitiesSchema.parse({ capabilityVersion: 1,
      protocolVersions: this.qualifiedReads ? [1] : [], readSemanticsVersions: this.qualifiedReads ? [3] : [],
      transport: 'http_poll', activePollMs: 1000,
      semantics3: { persistedReads: this.qualifiedReads, payload: 'metadata_only', runtimeAdmission: false, meaningfulEdit: false },
    })
  }
  private authorize(input: ManagementPrincipal): AuthorizeRepeatGraphRead {
    let principal: ManagementPrincipal
    try {
      principal = ManagementPrincipalSchema.parse(input)
      if (!hasAction(principal, 'runs:read')) throw new RunGraphError('GRAPH_READ_ACCESS_DENIED')
    } catch { throw new RunGraphError('GRAPH_READ_ACCESS_DENIED') }
    if (!this.qualifiedReads) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
    return async (sql, scope) => {
      const row = (await sql.query<{ workspace_id: string; workflow_id: string; id: string }>(
        'select workspace_id,workflow_id,id from runs where id=$1', [scope.runId])).rows[0]
      if (!row) throw new RunGraphError('GRAPH_READ_ACCESS_DENIED')
      requireAuthorization(principal, 'runs:read', { workspaceId: row.workspace_id, workflowId: row.workflow_id, runId: row.id })
    }
  }
  private async checked<T>(read: () => Promise<T>): Promise<T> {
    try { return await read() } catch (error) {
      throw error instanceof RunGraphError ? error : new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
  }
  snapshot(principal: ManagementPrincipal, request: unknown) {
    return this.checked(() => readRepeatGraphSnapshot(this.primaryPool, request, this.authorize(principal)))
  }
  current(principal: ManagementPrincipal, request: unknown) {
    return this.checked(() => readRepeatGraphCurrent(this.primaryPool, request, this.authorize(principal)))
  }
  events(principal: ManagementPrincipal, request: unknown) {
    return this.checked(() => readRepeatGraphPage(this.primaryPool, request, this.authorize(principal)))
  }
}
export interface RunGraphReadApi {
  capabilities(principal: ManagementPrincipal): CanonicalRunGraphReadCapabilities
  current(principal: ManagementPrincipal, request: unknown): Promise<RepeatGraphCurrentV3>
  snapshot(principal: ManagementPrincipal, request: unknown): Promise<RepeatGraphSnapshotV3>
  events(principal: ManagementPrincipal, request: unknown): Promise<RepeatGraphPageV3 | RepeatGraphResetV3>
}

export interface CanonicalRunGraphReadApi {
  capabilities: RunGraphReadApi['capabilities']
  readCapabilities(principal: ManagementPrincipal): CanonicalRunGraphReadCapabilities
  current(principal: ManagementPrincipal, request: unknown): Promise<RepeatGraphCurrentV3>
  snapshot(principal: ManagementPrincipal, request: unknown): Promise<RepeatGraphSnapshotV3>
  events(principal: ManagementPrincipal, request: unknown): Promise<RepeatGraphPageV3 | RepeatGraphResetV3>
}
/** One current execution reader, not a semantics dispatcher. Retired/unknown
 * tags fail before any database work. Wire protocol names remain unchanged. */
export function canonicalRunGraphReadApi(reads: RunGraphReadApi): CanonicalRunGraphReadApi {
  function checked(request: unknown): unknown {
    if (typeof request !== 'object' || request === null || !('scope' in request)
      || !CanonicalRunGraphScopeSchema.safeParse(request.scope).success) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    return request
  }
  return {
    capabilities: (principal) => reads.capabilities(principal),
    readCapabilities: (principal) => reads.capabilities(principal),
    current: (principal, request) => reads.current(principal, checked(request)),
    snapshot: (principal, request) => reads.snapshot(principal, checked(request)),
    events: (principal, request) => reads.events(principal, checked(request)),
  }
}
