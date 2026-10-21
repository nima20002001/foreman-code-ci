import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'

interface PrincipalRow {
  id: string
  name: string
  audience: string
  grants: unknown
  expires_at: string | Date
  revoked_at: string | Date | null
  delegated_from: string | null
}

interface AuthorizationRows {
  main_id: string | null
  device: unknown | null
  principal_id: string
  principals: PrincipalRow[]
  run_authority: {
    owner_principal_id: string
    grant_ceiling: unknown
    accepted_expires_at: string | Date
    execution_state: string
    cleanup_pending: boolean
  } | null
  workspace_id: string
  workspace: { location_revision: string; archived_at: string | null } | null
  source: { record: unknown; availability: string } | null
  source_root: { record: unknown } | null
  root_policy: { record: unknown; revoked_at: string | null } | null
  root_configuration: { record: unknown } | null
}

interface AuthorizationReadSnapshot extends AuthorizationRows {
  placement: AcceptedNodePlacement
}

interface ReadScope { load(): Promise<AuthorizationReadSnapshot>; pending?: Promise<AuthorizationReadSnapshot> }
const scopes = new WeakMap<GraphSqlClient, ReadScope>()

/** Materialize live rows only for this admission check. The commit check opens a separate scope. */
export async function withAuthorizationReadSnapshot<T>(sql: GraphSqlClient, runId: string,
  placement: AcceptedNodePlacement, work: () => Promise<T>): Promise<T> {
  const previous = scopes.get(sql)
  scopes.set(sql, { load: () => readAuthorizationRows(sql, runId, placement) })
  try { return await work() }
  finally {
    if (previous) scopes.set(sql, previous)
    else scopes.delete(sql)
  }
}

export function authorizationReadSnapshot(sql: GraphSqlClient): Promise<AuthorizationReadSnapshot> | undefined {
  const scope = scopes.get(sql)
  if (!scope) return undefined
  scope.pending ??= scope.load()
  return scope.pending
}

export function snapshotPrincipal(snapshot: AuthorizationReadSnapshot, id: string) {
  const row = snapshot.principals.find(principal => principal.id === id)
  if (!row) return undefined
  return { ...row,
    expires_at: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    revoked_at: typeof row.revoked_at === 'string' ? new Date(row.revoked_at) : row.revoked_at,
  }
}

async function readAuthorizationRows(sql: GraphSqlClient, runId: string,
  placement: AcceptedNodePlacement): Promise<AuthorizationReadSnapshot> {
  const host = placement.hostRef
  const source = 'kind' in placement.source && placement.source.kind === 'pending' ? placement.source : undefined
  const hostScope = host.kind === 'device' ? `main:${host.mainId}:device:${host.deviceId}` : `main:${host.mainId}`
  // Independent keyed lookups keep one committed snapshot without a large join plan.
  const result = await sql.query<{ authorization_read: AuthorizationRows }>(`select jsonb_build_object(
      'main_id',(select id from application_installation where singleton=true),
      'device',(select record from device_registrations where id=$3::uuid and main_id=$2::uuid),
      'principal_id',r.record->>'authorizationPrincipalId',
      'principals',coalesce((with recursive chain as (
        select id,name,audience,grants,expires_at,revoked_at,delegated_from,1 as depth
          from management_principals where id=r.record->>'authorizationPrincipalId'
        union all
        select p.id,p.name,p.audience,p.grants,p.expires_at,p.revoked_at,p.delegated_from,c.depth+1
          from management_principals p join chain c on p.id=c.delegated_from where c.depth<16
      ) select jsonb_agg(to_jsonb(chain) order by depth) from chain),'[]'::jsonb),
      'run_authority',(select jsonb_build_object(
        'owner_principal_id',b.owner_principal_id,'grant_ceiling',b.grant_ceiling,
        'accepted_expires_at',b.accepted_expires_at,'execution_state',authority_run.execution_state,
        'cleanup_pending',exists(select 1 from run_cleanup_intents c where c.run_id=authority_run.id and c.pending))
        from run_authority_principals b join runs authority_run on authority_run.id=b.run_id
          and authority_run.record->>'authorizationPrincipalId'=b.principal_id
        where b.principal_id=r.record->>'authorizationPrincipalId'),
      'workspace_id',r.workspace_id,
      'workspace',(select jsonb_build_object('location_revision',location_revision::text,'archived_at',archived_at)
        from workspaces where id=r.workspace_id),
      'source',(select jsonb_build_object('record',record,'availability',availability)
        from source_snapshots where workspace_id=r.workspace_id
          and approved_source_id=$4 and snapshot_id=$5 and manifest_digest=$6),
      'source_root',(select jsonb_build_object('record',record) from source_root_bindings
        where workspace_id=r.workspace_id and root_id=$7 and binding_revision=$8),
      'root_policy',(select jsonb_build_object('record',record,'revoked_at',revoked_at) from workspace_root_policies
        where workspace_id=r.workspace_id and root_policy_id=$9 and root_policy_revision=$10),
      'root_configuration',(select jsonb_build_object('record',configuration.record)
        from workspace_root_host_configuration_heads head
        join workspace_root_host_configurations configuration on configuration.host_scope=head.host_scope
          and configuration.configuration_revision=head.configuration_revision
        where head.host_scope=$11)
    ) as authorization_read from runs r where r.id=$1`,
  [runId, host.mainId, host.kind === 'device' ? host.deviceId : null,
    source?.approvedSourceId ?? null, source?.snapshotId ?? null, source?.manifestDigest ?? null,
    source?.rootId ?? null, source?.bindingRevision ?? null,
    placement.destination.rootPolicyId, placement.destination.rootPolicyRevision, hostScope])
  const row = result.rows[0]
  if (!row) throw new DomainError('REMOTE_AUTHORITY_DENIED', 'Execution authorization is no longer available.', 403)
  return { ...row.authorization_read, placement }
}
