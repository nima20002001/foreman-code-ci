import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DurableInteractionSchema } from '@foreman-code/contracts'
import { RemoteOwnerControlSchema } from '@foreman-code/contracts/remote-execution'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { waitForRemoteReview, deliveredReview, receipts, reviewInProgress,
  useRemoteReviewFixture } from './helpers/remoteReviewProductionCases.js'

const withRemoteReviewFixture = useRemoteReviewFixture()

describe('production remote review and native recovery through authenticated MCP', () => {
  it('retries the same reserved decision through authenticated MCP after a post-reservation authorization failure', async () => {
    await withRemoteReviewFixture(async fixture => {
      const active = await reviewInProgress(fixture)
      fixture.denyNextReservedResponse()
      await fixture.provider.releaseReview()
      const repository = new PostgresInteractionRepository(fixture.db.pool)
      const uncertain = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return repository.get(active.interaction.id)
      },
        value => value?.deliveryState === 'uncertain', 'persisted uncertain approval after actual Main authorization denial')
      expect(uncertain?.selectedSemantic).toBe('approve_once')
      const command = fixture.deniedResponse()
      expect(command).toBeDefined()
      const serialized = JSON.parse(await readFile(join(fixture.stateDirectory, 'workflow-operations.json'), 'utf8')) as {
        controlDeliveries: Array<{ operationId: string; commandId: string; phase: string }>
      }
      expect(serialized.controlDeliveries).toContainEqual({ operationId: command!.operationId,
        commandId: command!.commandId, phase: 'reserved' })
      const attempt = (await fixture.db.pool.query<{ remote_owner_control: unknown }>(
        'select remote_owner_control from interaction_delivery_attempts where interaction_id=$1 order by attempt desc limit 1',
        [active.interaction.id])).rows[0]!
      expect(RemoteOwnerControlSchema.parse(attempt.remote_owner_control)).toEqual(command)
      expect((await fixture.provider.calls()).filter(call => 'approvalResponse' in call)).toHaveLength(0)
      await fixture.restoreOriginalResponseGrant()
      await fixture.provider.retryReview()
      const delivered = await deliveredReview(fixture, active.interaction.id)
      expect(DurableInteractionSchema.parse((await fixture.value('interaction_get', {
        interactionId: active.interaction.id,
      }) as { interaction: unknown }).interaction)).toEqual(delivered.interaction)
      const receipt = (await receipts(fixture, active.run.id)).find(receipt => receipt.intent.executionId === active.requester.id)!
      expect(receipt.controls.filter(control => control.action.kind === 'respond')).toEqual([command])
      expect(fixture.deliveryReads).toContainEqual({ command, phase: 'reserved' })
      expect((await fixture.provider.calls()).filter(call => 'approvalResponse' in call)).toHaveLength(1)
      const settled = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return fixture.details(active.run.id)
      }, details => details.run.executionState === 'completed' && details.cleanupPending !== true,
      'completed Run and native cleanup after the reserved decision')
      expect(settled.run.outcome).toBe('succeeded')
      expect((await fixture.executions(active.run.id)).every(execution => execution.state === 'completed')).toBe(true)
    })
  }, 240_000)
})
