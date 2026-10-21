import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { hasPositiveRemoteEntryClosure } from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { SourcePreparationSchema } from '@foreman-code/contracts/source-admission'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { waitForRemoteReview, receipts, useRemoteReviewFixture } from './helpers/remoteReviewProductionCases.js'
import { waitForRequesterSession } from './helpers/remoteReviewEntryStartup.js'
import { waitForReleasedWorkflowSource } from './helpers/releasedWorkflowSource.js'

const withRemoteReviewFixture = useRemoteReviewFixture()

describe('production remote review and native recovery through authenticated MCP', () => {
  it('closes a requester entry interrupted before session acknowledgment through installed recovery and authenticated Stop', async () => {
    await withRemoteReviewFixture(async fixture => {
      await fixture.provider.blockRequesterSession()
      const started = await fixture.start()
      const blocked = await waitForRequesterSession({
        entryNodeId: fixture.version.entryNodeId,
        readExecutions: async () => (await fixture.details(started.run.id)).executions,
        readCalls: fixture.provider.calls,
        reconcile: fixture.reconcileReviews,
        subscribe: fixture.subscribeNativeChanges,
      })
      const provider = blocked.find(call => 'requesterSessionBlocked' in call)!.requesterSessionBlocked as { pid: number }
      const requesterNode = fixture.version.definition.nodes.find(node => node.id !== fixture.version.entryNodeId)!
      const requester = (await fixture.executions(started.run.id)).find(execution => execution.workflowNodeId === requesterNode.id)!
      expect(requester.state).toBe('starting')
      expect(requester.nativeSessionId).toBeUndefined()
      const workerJournal = JSON.parse(await readFile(join(fixture.stateDirectory, 'workflow-operations.json'), 'utf8')) as {
        receipts: unknown[]
      }
      const original = workerJournal.receipts.map(value => RemoteOperationReceiptSchema.parse(value))
        .find(receipt => receipt.intent.executionId === requester.id)!
      expect(original.entryAttempted).toBe(true)
      expect(original.turnEntryAttempted).toBe(false)
      expect(original.native).toBeUndefined()
      expect(original.terminal).toBeUndefined()
      const owners = fixture.registry.snapshot().launches.filter(launch => launch.owner === `execution:${requester.id}`)
      let originalLaunches = owners
      const active = owners.find(owner => owner.provider?.pid === provider.pid)!
      expect(active.lifecycle).toBe('active')
      expect(active.boundary?.kind).toBe('cgroup-v2')
      const entry = fixture.entryCapture(original.intent.operationId)
      expect(entry).toMatchObject({ intent: original.intent, connection: original.connection, owner: active.owner })
      if (!entry) throw new Error('The original requester entry capture is missing.')
      const preparation = SourcePreparationSchema.parse(await fixture.value('source_preparation_get', {
        workspaceId: started.run.workspaceId, operationId: original.intent.operationId,
      }))
      expect(preparation.materializationId).not.toBeNull()
      // Startup can reserve another launch before the Worker exits.
      await fixture.restartWorker(() => {
        originalLaunches = fixture.registry.snapshot().launches.filter(launch => launch.owner === active.owner)
      })
      await fixture.value('run_stop', { workspaceId: started.run.workspaceId,
        runId: started.run.id, commandId: randomUUID() })
      const closed = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return (await receipts(fixture, started.run.id)).find(receipt => receipt.intent.executionId === requester.id)
      }, receipt => !!receipt && hasPositiveRemoteEntryClosure(receipt), 'persisted closure of the original unacknowledged entry')
      expect(closed).toBeDefined()
      expect(closed!.native).toBeUndefined()
      expect(closed!.turnEntryAttempted).toBe(false)
      expect(closed!.terminal?.result).toBeUndefined()
      expect(closed!.terminal?.resultDigest).toBeUndefined()
      expect(closed!.terminal?.entryClosure).toMatchObject({ intent: original.intent,
        connection: original.connection, owner: `execution:${requester.id}` })
      const closedLaunches = closed!.terminal!.entryClosure!.launches
      const originalLaunchIds = [...new Set([...originalLaunches.map(launch => launch.launchId), entry.initialLaunchId])]
      expect(closed!.terminal!.entryClosure!.initialLaunchId).toBe(entry.initialLaunchId)
      expect(closedLaunches.map(launch => launch.launchId).sort())
        .toEqual(originalLaunchIds.sort())
      expect(closedLaunches.find(launch => launch.launchId === active.launchId)).toMatchObject({
        guardian: active.guardian, provider: active.provider, boundary: active.boundary,
        lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty',
      })
      const detail = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return SavedRunDetailsSchema.parse(await fixture.value('run_get', {
          detail: 'full',
          workspaceId: started.run.workspaceId, runId: started.run.id,
        }))
      }, value => value.run.executionState === 'completed', 'authenticated readback of the stopped Run')
      expect(detail.run.outcome).toBe('canceled')
      expect(detail.executions.find(execution => execution.id === requester.id)?.nativeSessionId).toBeUndefined()
      expect((await fixture.db.pool.query('select 1 from execution_native_sessions where execution_id=$1',
        [requester.id])).rows).toEqual([])
      const released = await waitForReleasedWorkflowSource(fixture, started.run.workspaceId, original.intent.operationId)
      expect(released.materializationId).toBe(preparation.materializationId)
      expect((await fixture.db.pool.query<{ state: string }>(
        'select state from source_execution_materializations where operation_id=$1',
        [original.intent.operationId])).rows[0]?.state).toBe('closed')
      expect(fixture.registry.closedRegistration(active.owner, entry.initialLaunchId))
        .toEqual(closedLaunches.find(launch => launch.launchId === entry.initialLaunchId))
      expect(fixture.registry.snapshot().launches.filter(launch => launch.owner === active.owner)
        .map(launch => launch.launchId).sort()).toEqual(originalLaunches.map(launch => launch.launchId).sort())
      expect((await fixture.provider.calls()).filter(call => 'requesterSessionBlocked' in call)).toHaveLength(1)
      expect((await fixture.provider.calls()).filter(call => call.method === 'turn/start'
        && call.correlationId === `execution:${requester.id}`)).toHaveLength(0)
    })
  }, 240_000)
})
