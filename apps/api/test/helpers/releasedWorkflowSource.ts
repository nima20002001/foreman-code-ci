import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { SourceMaterializationRecordSchema, SourcePreparationSchema } from '@foreman-code/contracts/source-admission'
import type { SourceReservation } from '../../src/modules/sources/reservations.js'
import type { remoteReviewProduction } from './remoteReviewProduction.js'
import { waitForRemoteReview } from './remoteReviewProductionCases.js'

export async function waitForReleasedWorkflowSource(
  fixture: Pick<Awaited<ReturnType<typeof remoteReviewProduction>>, 'db' | 'value' | 'reconcile'>,
  workspaceId: string, operationId: string,
) {
  const released = await waitForRemoteReview(async () => {
    await fixture.reconcile()
    const preparation = SourcePreparationSchema.parse(await fixture.value('source_preparation_get', {
      workspaceId, operationId,
    }))
    const row = (await fixture.db.pool.query<{ state: string; record: unknown; reservation: SourceReservation }>(
      `select m.state,m.record,s.record as reservation from source_execution_materializations m
        join source_storage_reservations s using(reservation_id) where m.operation_id=$1`, [operationId])).rows[0]
    return { preparation, row }
  }, value => value.preparation.reservationState === 'retained' && value.preparation.closure !== null
    && value.row?.state === 'closed' && value.row.reservation.referenceReclaimed === true,
  'released execution reference with its shared checkout retained and charged')
  const receipt = SourceMaterializationRecordSchema.parse(released.row!.record).receipt
  expect(receipt.binding.accessMode).toBe('read-only')
  expect(receipt.sharedTree).toBeDefined()
  expect(released.preparation.reservedBytes).toBeGreaterThan(0)
  await expect(stat(join(receipt.binding.canonicalPath, receipt.materializationId, 'tree')))
    .rejects.toMatchObject({ code: 'ENOENT' })
  const shared = join(receipt.binding.canonicalPath, receipt.sharedTree!.id, 'tree')
  expect((await stat(shared)).isDirectory()).toBe(true)
  expect((await stat(join(shared, 'README.md'))).mode & 0o222).toBe(0)
  const charges = (await fixture.db.pool.query<{ bytes: string }>(
    `select record#>>'{retainedSharedTree,bytes}' as bytes from source_storage_reservations
      where scope_id=$1 and state='retained' and record#>>'{retainedSharedTree,id}'=$2`,
    [released.row!.reservation.scopeId, receipt.sharedTree!.id])).rows
  expect(charges).toHaveLength(1)
  expect(Number(charges[0]!.bytes)).toBeGreaterThan(0)
  return released.preparation
}
