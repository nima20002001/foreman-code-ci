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
  const result = await sql.query<{ authorization_read: AuthorizationRows }>(`select jsonb_build_object(
      'main_id',m.id,'device',d.record,'principal_id',r.record->>'authorizationPrincipalId',
      'principals',coalesce(principals.records,'[]'::jsonb),
      'run_authority',case when authority_run.id is null then null else jsonb_build_object(
        'owner_principal_id',b.owner_principal_id,'grant_ceiling',b.grant_ceiling,
        'accepted_expires_at',b.accepted_expires_at,'execution_state',authority_run.execution_state,
        'cleanup_pending',exists(select 1 from run_cleanup_intents c where c.run_id=authority_run.id and c.pending)) end,
      'workspace_id',r.workspace_id,
      'workspace',case when w.id is null then null else jsonb_build_object(
        'location_revision',w.location_revision::text,'archived_at',w.archived_at) end,
      'source',case when s.snapshot_id is null then null else jsonb_build_object(
        'record',s.record,'availability',s.availability) end,
      'source_root',case when root.root_id is null then null else jsonb_build_object('record',root.record) end,
      'root_policy',case when policy.root_policy_id is null then null else jsonb_build_object(
        'record',policy.record,'revoked_at',policy.revoked_at) end,
      'root_configuration',case when configuration.host_scope is null then null
        else jsonb_build_object('record',configuration.record) end
    ) as authorization_read
    from runs r
    left join application_installation m on m.singleton=true
    left join device_registrations d on d.id=$3::uuid and d.main_id=$2::uuid
    left join lateral (
      with recursive chain as (
        select id,name,audience,grants,expires_at,revoked_at,delegated_from,1 as depth
          from management_principals where id=r.record->>'authorizationPrincipalId'
        union all
        select p.id,p.name,p.audience,p.grants,p.expires_at,p.revoked_at,p.delegated_from,c.depth+1
          from management_principals p join chain c on p.id=c.delegated_from where c.depth<16
      ) select jsonb_agg(to_jsonb(chain) order by depth) as records from chain
    ) principals on true
    left join run_authority_principals b on b.principal_id=r.record->>'authorizationPrincipalId'
    left join runs authority_run on authority_run.id=b.run_id
      and authority_run.record->>'authorizationPrincipalId'=b.principal_id
    left join workspaces w on w.id=r.workspace_id
    left join source_snapshots s on s.workspace_id=r.workspace_id
      and s.approved_source_id=$4 and s.snapshot_id=$5 and s.manifest_digest=$6
    left join source_root_bindings root on root.workspace_id=r.workspace_id
      and root.root_id=$7 and root.binding_revision=$8
    left join workspace_root_policies policy on policy.workspace_id=r.workspace_id
      and policy.root_policy_id=$9 and policy.root_policy_revision=$10
    left join workspace_root_host_configuration_heads head on head.host_scope=$11
    left join workspace_root_host_configurations configuration on configuration.host_scope=head.host_scope
      and configuration.configuration_revision=head.configuration_revision
    where r.id=$1`,
  [runId, host.mainId, host.kind === 'device' ? host.deviceId : null,
    source?.approvedSourceId ?? null, source?.snapshotId ?? null, source?.manifestDigest ?? null,
    source?.rootId ?? null, source?.bindingRevision ?? null,
    placement.destination.rootPolicyId, placement.destination.rootPolicyRevision, hostScope])
  const row = result.rows[0]
  if (!row) throw new DomainError('REMOTE_AUTHORITY_DENIED', 'Execution authorization is no longer available.', 403)
  return { ...row.authorization_read, placement }
}
