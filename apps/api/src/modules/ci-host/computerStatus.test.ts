import { setImmediate as nextTurn } from 'node:timers/promises'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { ciDatabasePriority, withCiDatabasePriority, withoutCiDatabasePriority }
  from '../../infrastructure/ciDatabasePriority.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { CiComputerStatuses, ciComputerStatusKey } from './computerStatus.js'
import { queuedTicket, readyStatus } from './dispatchFleet.testSupport.js'
import type { HostCiComputer } from './serviceTypes.js'

it('shares provider I/O while reading and reconciling tickets in each caller database priority', async () => {
  const computer: HostCiComputer = { key: 'fixture:cloud:0', label: 'Cloud executor', priority: 30,
    hostRef: { kind: 'cloud', mainId: 'fixture', provider: 'circleci', account: 'fixture', slot: 0 } }
  const run = queuedTicket({ state: 'running', computer: { hostRef: computer.hostRef, label: computer.label } })
  const reads: string[] = []
  const reconciled: { priority: string; runId: string }[] = []
  const priority = () => ciDatabasePriority() ? 'dispatch' : 'shared'
  const pool = { query: async () => {
    reads.push(priority())
    return { rows: [{ host_key: computer.key, record: run }] }
  } } as unknown as pg.Pool
  const statuses = new CiComputerStatuses(pool, ciComputerStatusKey, async record => {
    reconciled.push({ priority: priority(), runId: record.id })
  })
  const entered = deferred()
  const provider = deferred<ReturnType<typeof readyStatus>>()
  let providerReads = 0
  const send = () => {
    providerReads++
    entered.resolve()
    return provider.promise
  }
  const shared = withoutCiDatabasePriority(() => statuses.read(computer, send))
  await entered.promise
  const dispatch = withCiDatabasePriority(() => statuses.read(computer, send))
  await nextTurn()
  provider.resolve(readyStatus())
  await Promise.all([shared, dispatch])
  expect(providerReads).toBe(1)
  expect(reads).toEqual(['shared', 'dispatch'])
  expect(reconciled).toEqual([{ priority: 'shared', runId: run.id }, { priority: 'dispatch', runId: run.id }])
})
