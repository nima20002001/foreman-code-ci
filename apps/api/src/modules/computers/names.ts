import type pg from 'pg'
import { ComputerRenameInputSchema, ComputerRenameResultSchema, type ComputerRenameResult } from '@foreman-code/contracts/computer-activity'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { buildComputerKey } from '../settings/buildComputers.js'

type Queryable = { query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> }

/** Names the owner gave computers on this Main, by build-computer key; computers without one keep their default label. */
export async function readComputerNames(sql: Queryable, mainId: string): Promise<ReadonlyMap<string, string>> {
  const rows = await sql.query<{ host_key: string; name: string }>(
    'select host_key,name from computer_names where host_key like $1', [`${mainId}:%`])
  return new Map(rows.rows.map(row => [row.host_key, row.name]))
}
export function computerNameKey(mainId: string, deviceId?: string): string {
  return buildComputerKey({ hostRef: deviceId ? { kind: 'device', mainId, deviceId } : { kind: 'main', mainId } })
}

/** Save a new computer name. The grant is the one every computer settings edit uses. */
export async function renameComputer(pool: pg.Pool, commands: PostgresCommandCoordinator, mainId: string,
  principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<ComputerRenameResult> {
  const input = ComputerRenameInputSchema.parse(raw)
  const { target } = input
  const key = buildComputerKey(target)
  try { requireAuthorization(principal, 'settings:update') } catch (error) {
    await commands.recordDenied(principal.id, source, 'computer.rename', key)
    throw error
  }
  if (target.hostRef.mainId !== mainId) throw new DomainError('COMPUTER_NOT_FOUND', 'This computer belongs to another Main.', 404)
  const { value } = await commands.execute({ principal, source, commandId: input.commandId,
    operation: 'computer.rename', targetKey: key, payload: input,
    authorize: async sql => {
      requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), 'settings:update')
      await assertDeviceHostInstallation(sql, target.hostRef, target.applicationInstallationId)
    },
    perform: async sql => {
      await sql.query(`insert into computer_names(host_key,name,updated_by) values($1,$2,$3)
        on conflict(host_key) do update set name=excluded.name,updated_by=excluded.updated_by`, [key, input.name, principal.id])
      return ComputerRenameResultSchema.parse({ target, name: input.name })
    } })
  return value
}
