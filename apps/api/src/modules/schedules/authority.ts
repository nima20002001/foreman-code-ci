import type { TransactionSql } from '../../infrastructure/transaction.js'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type { WorkflowSchedule } from '@foreman-code/contracts/schedules'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import { intersectGrants } from '../access/operatorDelegation.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'

type Sql = TransactionSql

/** Explicitly capture the schedule writer's root owner and a ceiling, not a chat
 * token. Save does not require Run grants; absent grants cause rejected dispatch.
 * Replays never call this function. A new save/enable replaces the binding.
 * A temporary caller's expiry does not become a renewable runtime credential. */
export async function captureScheduleAuthority(client: Sql, schedule: WorkflowSchedule, actorId: string): Promise<void> {
  if (!schedule.enabled) return
  const actor = await readLiveManagementPrincipal(client, actorId)
  const row = (await client.query<{ delegated_from: string | null }>(
    'select delegated_from from management_principals where id=$1 for share', [actor.id])).rows[0]
  if (!row) throw new DomainError('AUTH_REVOKED', 'The schedule writer is unavailable.', 403)
  // Match manual Start: a temporary caller may delegate from a root or an
  // active Run-bound authority, never from another temporary chat credential.
  const parent = await currentOperatorAuthority(client, row.delegated_from ?? actor.id)
  const owner = parent.owner
  const ceiling = intersectGrants(actor.grants, parent.principal.grants)
  requireAuthorization({ ...actor, grants: ceiling }, 'workflows:update', schedule)
  await client.query(`insert into workflow_schedule_authorities
    (workspace_id,workflow_id,schedule_revision,owner_principal_id,actor_principal_id,grant_ceiling)
    values($1,$2,$3,$4,$5,$6::jsonb)
    on conflict(workflow_id) do update set schedule_revision=excluded.schedule_revision,
      owner_principal_id=excluded.owner_principal_id,actor_principal_id=excluded.actor_principal_id,
      grant_ceiling=excluded.grant_ceiling`,
  [schedule.workspaceId, schedule.workflowId, schedule.revision, owner.id, actor.id, JSON.stringify(ceiling)])
}

/** Root-only live authority; never reconstruct authority from updated_by.
 * The share locks retained by readLiveManagementPrincipal fence revocation and
 * grant edits until the dispatch transaction commits. Common Run Start still
 * creates/binds its own tokenless authority with the usual checks. */
export async function readScheduleAuthority(client: Sql, schedule: WorkflowSchedule): Promise<ManagementPrincipal> {
  const row = (await client.query<{ owner_principal_id: string; grant_ceiling: unknown }>(
    `select owner_principal_id,grant_ceiling from workflow_schedule_authorities
      where workspace_id=$1 and workflow_id=$2 and schedule_revision=$3`,
    [schedule.workspaceId, schedule.workflowId, schedule.revision])).rows[0]
  if (!row) throw new DomainError('SCHEDULE_AUTHORITY_MISSING', 'Save or enable this schedule to bind its owner.', 403)
  const live = await readLiveManagementPrincipal(client, row.owner_principal_id)
  const root = await currentOperatorAuthority(client, live.id)
  if (root.owner.id !== live.id) throw new DomainError('AUTH_INVALID', 'A schedule requires a root human owner.', 403)
  const principal = { ...live, grants: intersectGrants(live.grants,
    ManagementPrincipalSchema.shape.grants.parse(row.grant_ceiling)) }
  requireAuthorization(principal, 'runs:start', schedule)
  requireAuthorization(principal, 'workspace_locations:read', { workspaceId: schedule.workspaceId })
  return principal
}
