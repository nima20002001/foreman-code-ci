import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { requireRsyncTransferOwner } from '../src/modules/byte-transfer/rsyncTransferOwner.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
let principalId: string
beforeAll(async () => {
  database = await migratedDatabase()
  const issued = await new PostgresAccessService(database.pool).issue({
    name: 'Transfer owner fixture', audience: 'operator', grants: [],
    expiresAt: new Date(Date.now() + 600_000),
  })
  principalId = issued.principal.id
}, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

type Owner = Awaited<ReturnType<typeof requireRsyncTransferOwner>>

async function insertReceipt(operation: string, result: unknown) {
  await database.pool.query(`insert into management_command_receipts
    (principal_id,operation,command_id,target_key,input_hash,result) values($1,$2,$3,$4,$5,$6::jsonb)`,
  [principalId, operation, randomUUID(), 'transfer-fixture', 'sha256:' + 'a'.repeat(64), JSON.stringify(result)])
}

function ownerResult(operation: Owner, transferId: string) {
  if (operation === 'job.inputs.bind') {
    return { transfers: [
      { intent: { transferId: randomUUID() } },
      { intent: { transferId } },
      { intent: { transferId } },
    ] }
  }
  return { intent: { transferId } }
}

it.each(['source.package.admit', 'job.output.admit', 'job.inputs.bind'] as const)(
  'accepts one %s receipt as the transfer owner', async operation => {
    const transferId = randomUUID()
    await insertReceipt(operation, ownerResult(operation, transferId))
    await insertReceipt('unrelated.operation', { intent: { transferId } })
    // A transfer in another field of a recognized receipt is not its admitted transfer.
    await insertReceipt('source.package.admit', { transferId, intent: { transferId: randomUUID() } })
    await expect(requireRsyncTransferOwner(database.pool, transferId)).resolves.toBe(operation)
  },
)

it.each<[Owner, Owner]>([
  ['source.package.admit', 'job.output.admit'],
  ['source.package.admit', 'job.inputs.bind'],
  ['job.output.admit', 'job.inputs.bind'],
  ['source.package.admit', 'source.package.admit'],
  ['job.inputs.bind', 'job.inputs.bind'],
])('rejects ambiguous ownership across %s and %s receipts', async (first, second) => {
  const transferId = randomUUID()
  await insertReceipt(first, ownerResult(first, transferId))
  await insertReceipt(second, ownerResult(second, transferId))
  await expect(requireRsyncTransferOwner(database.pool, transferId))
    .rejects.toMatchObject({ code: 'RSYNC_TRANSFER_DENIED', status: 403 })
})

it('rejects unknown transfer IDs even when an unrelated operation contains that ID', async () => {
  const transferId = randomUUID()
  await insertReceipt('unrelated.operation', { intent: { transferId }, transfers: [{ intent: { transferId } }] })
  await insertReceipt('job.inputs.bind', ownerResult('job.inputs.bind', randomUUID()))
  await expect(requireRsyncTransferOwner(database.pool, transferId))
    .rejects.toMatchObject({ code: 'RSYNC_TRANSFER_DENIED', status: 403 })
  await expect(requireRsyncTransferOwner(database.pool, randomUUID()))
    .rejects.toMatchObject({ code: 'RSYNC_TRANSFER_DENIED', status: 403 })
})
