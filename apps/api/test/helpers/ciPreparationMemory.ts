import type pg from 'pg'
import { DomainError } from '../../src/modules/errors.js'
import { ExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import type { JobOwnership } from '../../src/modules/jobs/ownership.js'
import { CiPreparationRecordSchema, type CiPreparationRecord, type CiPreparationRepository }
  from '../../src/modules/jobs/ciPreparationRepository.js'

/** Storage and SQL sessions are synthetic; domain services and checkpoint validation run unchanged. */
export function ciPreparationMemory() {
  const records = new Map<string, CiPreparationRecord>()
  const owners = new Set<string>()
  const repository: CiPreparationRepository = {
    create: async (_sql, record) => {
      if ([...records.values()].some(value => value.status.deviceId === record.status.deviceId
        && !['qualified', 'failed'].includes(value.status.state))) {
        throw new DomainError('CI_RUNTIME_BUSY', 'Computer preparation is already running.', 409)
      }
      records.set(record.id, structuredClone(record))
    },
    get: async id => structuredClone(records.get(id)!),
    latest: async (workspaceId, deviceId) => structuredClone([...records.values()].reverse()
      .find(record => record.input.workspaceId === workspaceId && record.status.deviceId === deviceId)),
    latestForDevice: async deviceId => structuredClone([...records.values()].reverse()
      .find(record => record.status.deviceId === deviceId)),
    pending: async () => [...records.values()].filter(record => !['qualified', 'failed'].includes(record.status.state))
      .map(record => structuredClone(record)),
    save: async (_sql, record) => { records.set(record.id, structuredClone(CiPreparationRecordSchema.parse(record))) },
  }
  const acquire: typeof JobOwnership.acquire = async (_pool, key) => {
    if (owners.has(key)) return undefined
    owners.add(key)
    const assertOwned = () => { if (!owners.has(key)) throw new DomainError('JOB_OWNERSHIP_LOST', 'Owner released.', 409) }
    const connection = new ExclusiveGraphConnection({ query: (text: string, values?: unknown[]) => _pool.query(text, values) } as unknown as pg.Client,
      assertOwned)
    return { connection, assertOwned, readFence: async () => ({ ownerId: '1', fence: '1' }),
      release: async () => { await connection.close(); owners.delete(key) } } as unknown as JobOwnership
  }
  return { repository, acquire, records, owners }
}
