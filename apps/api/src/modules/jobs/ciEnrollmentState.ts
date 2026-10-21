import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { buildComputerKey } from '../settings/buildComputers.js'
import type { JobSql } from './repository.js'

export async function lockCiEnrollment(sql: JobSql, workspaceId: string,
  target: DeviceProvisioningTarget): Promise<void> {
  await sql.query('select pg_advisory_xact_lock(hashtext($1))',
    [`ci-enrollment:${workspaceId}:${buildComputerKey(target)}`])
}

export async function ciEnrollmentDisabled(sql: JobSql, workspaceId: string,
  target: DeviceProvisioningTarget, options: { lock?: boolean } = {}): Promise<boolean> {
  if (options.lock) await lockCiEnrollment(sql, workspaceId, target)
  const row = (await sql.query<{ enabled: boolean }>(
    'select enabled from ci_enrollment_computers where workspace_id=$1 and host_key=$2',
    [workspaceId, buildComputerKey(target)])).rows[0]
  return row?.enabled === false
}

export async function disabledCiEnrollmentHosts(sql: JobSql, workspaceId: string,
  targets: DeviceProvisioningTarget[], options: { lock?: boolean } = {}): Promise<Set<string>> {
  const byHost = new Map(targets.map(target => [buildComputerKey(target), target]))
  const keys = [...byHost.keys()].sort()
  if (!keys.length) return new Set()
  if (options.lock) {
    for (const key of keys) await lockCiEnrollment(sql, workspaceId, byHost.get(key)!)
  }
  const rows = (await sql.query<{ host_key: string; enabled: boolean }>(
    'select host_key,enabled from ci_enrollment_computers where workspace_id=$1 and host_key=any($2::text[])',
    [workspaceId, keys])).rows
  return new Set(rows.filter(row => !row.enabled).map(row => row.host_key))
}
