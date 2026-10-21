import type pg from 'pg'
import type { CiHostStatus } from '@foreman-code/contracts'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'
import type { CiIntegrationSlots } from './integrationParts.js'
import { componentLogger } from '../diagnostics/logger.js'

const log = componentLogger('jobs')

export interface CiPlanningCapacity extends CiIntegrationSlots {
  eligible: CiIntegrationSlots
  usedByComputer: ReadonlyMap<string, number>
  complete: boolean
  unavailableComputers: readonly string[]
}

/** A computer never read before delays only its own placement, and only this long. */
const UNKNOWN_STATUS_WAIT_MS = 3000

/** Read ready fleet capacity and free slots after runner and persisted reservations. A computer with an earlier
 * answer is planned from it while a fresh read runs in the background; dispatch validates readiness again. */
export async function readCiSlots(pool: pg.Pool,
  endpoint: HostCiEndpoint & { lastStatus?(computer: HostCiComputer): CiHostStatus | undefined }): Promise<CiPlanningCapacity> {
  const active = (await pool.query<{ host_key: string; count: number }>(`select host_key,count(*)::int as count
    from ci_runs where state in ('starting','running') and host_key is not null group by host_key`)).rows
  const used = new Map(active.map(row => [row.host_key, row.count]))
  const slots = { host: 0, ordinary: 0 }
  const eligible = { host: 0, ordinary: 0 }
  const unavailableComputers: string[] = []
  const computers = await endpoint.computers()
  for (let offset = 0; offset < computers.length; offset += 8) {
    await Promise.all(computers.slice(offset, offset + 8).map(async computer => {
      const read = endpoint.request(computer, { operation: 'status' })
      let status: Awaited<typeof read> | null | undefined = endpoint.lastStatus?.(computer)
      if (status) {
        // The read in flight replaces the snapshot when it lands; a failure only matters to the next admission.
        read.catch(error => {
          log.warn({ operation: 'refresh CI planning capacity', err: error, computer: computer.key },
            'CI capacity refresh failed; the last snapshot was used for planning')
        })
      } else {
        let timer: NodeJS.Timeout | undefined
        const slow = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('CI status read is slow')), UNKNOWN_STATUS_WAIT_MS)
        })
        status = await Promise.race([read, slow]).catch(error => {
          unavailableComputers.push(computer.key)
          log.warn({ operation: 'read CI planning capacity', err: error, computer: computer.key },
            'CI capacity unavailable while sizing parts')
          return null
        }).finally(() => clearTimeout(timer))
      }
      if (status?.operation !== 'status' || !status.ready) return
      const occupied = Math.max(status.slotsUsed ?? 0, used.get(computer.key) ?? 0)
      used.set(computer.key, occupied)
      const total = status.slotsTotal ?? 1
      const free = Math.max(0, total - occupied)
      slots.ordinary += free
      eligible.ordinary += total
      if (computer.hostRef.kind !== 'cloud') {
        slots.host += free
        eligible.host += total
      }
    }))
  }
  return { ...slots, eligible, usedByComputer: used, complete: unavailableComputers.length === 0,
    unavailableComputers: unavailableComputers.sort() }
}
