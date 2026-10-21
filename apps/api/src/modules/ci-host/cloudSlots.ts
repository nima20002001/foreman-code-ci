import type pg from 'pg'
import type { CiHostRequest, CiRunRecord } from '@foreman-code/contracts'
import { withTransaction } from '../../infrastructure/transaction.js'
import { queueCiDatabaseWork } from '../../infrastructure/ciDatabasePriority.js'
import { componentLogger } from '../diagnostics/logger.js'
import { claimCiDispatch } from './dispatch.js'
import { CI_BUSY_TICKET } from './deadlines.js'
import { CI_RETAINED_EXECUTORS } from './executorRecovery.js'
import { DomainError } from '../errors.js'
import { PostgresFoundationSettingsRepository } from '../settings/foundation.js'
import type { HostCiComputer } from './serviceTypes.js'

const log = componentLogger('jobs')

/** Cloud slots a gate leaves free for non-gate tickets, such as fix verifications, unless the product sets another count. */
export const DEFAULT_RESERVED_CLOUD_SLOTS = 4
export const RESERVED_CLOUD_SLOTS_SETTING = 'FOREMAN_CODE_CI_RESERVED_CLOUD_SLOTS'

export function configuredReservedCloudSlots(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment[RESERVED_CLOUD_SLOTS_SETTING]?.trim()
  if (!raw) return DEFAULT_RESERVED_CLOUD_SLOTS
  const value = Number(raw)
  if (Number.isInteger(value) && value >= 0) return value
  log.warn({ setting: RESERVED_CLOUD_SLOTS_SETTING, value: raw.slice(0, 40) },
    'Invalid reserved cloud CI slot count; using the default')
  return DEFAULT_RESERVED_CLOUD_SLOTS
}

/** The cloud slots gate tickets never plan or run on, taken round-robin over providers (each CircleCI org on its own)
 * from each provider's highest slots so every provider keeps capacity for non-gate work. Each provider keeps at least
 * one slot for the gate. */
export function reservedCloudSlotKeys(computers: readonly HostCiComputer[], count: number): Set<string> {
  const providers = new Map<string, HostCiComputer[]>()
  for (const computer of computers) {
    if (computer.hostRef.kind !== 'cloud') continue
    const provider = `${computer.hostRef.provider ?? ''}~${computer.hostRef.circleAccountId ?? 'default'}@${computer.hostRef.account ?? ''}`
    providers.set(provider, [...providers.get(provider) ?? [], computer])
  }
  const slots = [...providers.values()].map(list => [...list]
    .sort((left, right) => (right.hostRef.slot ?? 0) - (left.hostRef.slot ?? 0)))
  const reserved = new Set<string>()
  const taken = slots.map(() => 0)
  let progress = true
  while (reserved.size < count && progress) {
    progress = false
    for (const [index, list] of slots.entries()) {
      if (reserved.size >= count || list.length - taken[index]! <= 1) continue
      reserved.add(list[taken[index]!]!.key)
      taken[index] = taken[index]! + 1
      progress = true
    }
  }
  return reserved
}

export function withoutReservedCloudSlots(computers: HostCiComputer[], count: number): HostCiComputer[] {
  const reserved = reservedCloudSlotKeys(computers, count)
  return computers.filter(computer => !reserved.has(computer.key))
}

/** A cloud slot runs one ticket. The claim holds the slot's lock and rechecks persisted assignments, so a dispatcher
 * working from an older capacity snapshot cannot start a second ticket on a busy slot. */
export function claimCiSlot(pool: pg.Pool, run: CiRunRecord, computer: HostCiComputer,
  request: Extract<CiHostRequest, { operation: 'start' }>): Promise<CiRunRecord | 'busy' | null> {
  return queueCiDatabaseWork(pool, () => claimSlot(pool, run, computer, request), 'claim')
}

async function claimSlot(pool: pg.Pool, run: CiRunRecord, computer: HostCiComputer,
  request: Extract<CiHostRequest, { operation: 'start' }>): Promise<CiRunRecord | 'busy' | null> {
  if (computer.hostRef.kind !== 'cloud') return claimCiDispatch(pool, run, computer, request)
  return withTransaction(pool, async client => {
    const host = computer.hostRef
    if (host.provider === 'circleci') {
      // Account removal checks dependencies under the same lock before changing registration.
      await client.query('select pg_advisory_xact_lock(hashtext($1))', ['circle-accounts'])
      const owner = (host.account ?? request.ciMirror?.split('/')[0])?.toLowerCase()
      if (!owner) throw new DomainError('CI_CLOUD_UNAVAILABLE', 'The saved CircleCI mirror organization is unavailable.', 409)
      const circleAccountId = host.circleAccountId ?? 'default'
      const registry = await new PostgresFoundationSettingsRepository(pool).getCircleAccounts(client)
      const account = registry.value.accounts.find(value => value.id === circleAccountId)
      const bound = account?.organizations.some(value => value.toLowerCase() === owner)
        || circleAccountId === 'default' && account?.organizations.length === 0
      if (!bound) return null
      const slot = host.slot ?? 0
      const key = `${host.mainId}:circleci:${circleAccountId}:${owner}:${slot}`
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`ci-cloud-slot:${key}`])
      if (await retainedCiSlot(client, computer.key)) return 'busy' as const
      const assigned = await client.query(`select id from ci_runs where (${CI_BUSY_TICKET})
        and record#>>'{computer,hostRef,kind}'='cloud'
        and record#>>'{computer,hostRef,provider}'='circleci'
        and record#>>'{computer,hostRef,mainId}'=$1
        and coalesce(record#>>'{computer,hostRef,circleAccountId}','default')=$2
        and coalesce(record#>>'{computer,hostRef,slot}','0')=$3
        and (lower(coalesce(record#>>'{computer,hostRef,account}',split_part(record->>'ciMirror','/',1)))=$4
          or record#>>'{computer,hostRef,account}' is null and record->>'ciMirror' is null)
        limit 1`, [host.mainId, circleAccountId, String(slot), owner])
      if (assigned.rows.length) return 'busy' as const
      return claimCiDispatch(client, run, computer, request)
    }
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`ci-cloud-slot:${computer.key}`])
    const assigned = (await client.query<{ host_key: string | null }>(`select host_key from ci_runs
      where host_key=$1 and (${CI_BUSY_TICKET})
      union all
      select $1::text as host_key from ci_runs where ${CI_RETAINED_EXECUTORS}
        and record->'retainedExecutions' @> jsonb_build_array(
          jsonb_build_object('executor','retained','hostKey',$1::text))
      limit 1`, [computer.key])).rows
    if (assigned.some(row => row.host_key === computer.key)) return 'busy' as const
    return claimCiDispatch(client, run, computer, request)
  })
}

async function retainedCiSlot(client: pg.PoolClient, hostKey: string) {
  const result = await client.query(`select id from ci_runs where ${CI_RETAINED_EXECUTORS}
    and record->'retainedExecutions' @> $1::jsonb limit 1`,
  [JSON.stringify([{ executor: 'retained', hostKey }])])
  return result.rows.length > 0
}
