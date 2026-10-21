import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { hasPositiveRemoteEntryClosure } from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { receipts, useRemoteReviewFixture, waitForRemoteReview } from './helpers/remoteReviewProductionCases.js'
import { startWhenReady } from './helpers/harnessInstallationUpdate.js'
import { waitForRequesterSession } from './helpers/remoteReviewEntryStartup.js'
import { waitForReleasedWorkflowSource } from './helpers/releasedWorkflowSource.js'

const withRemoteReviewFixture = useRemoteReviewFixture()

it('closes an unbound attempt after owner restarts, records interruption, and admits a later Run', async () => {
  await withRemoteReviewFixture(async fixture => {
    await fixture.provider.blockRequesterSession()
    const started = await fixture.start()
    await waitForRequesterSession({
      entryNodeId: fixture.version.entryNodeId,
      readExecutions: async () => (await fixture.details(started.run.id)).executions,
      readCalls: fixture.provider.calls,
      reconcile: fixture.reconcileReviews,
      subscribe: fixture.subscribeNativeChanges,
    })
    const requester = (await fixture.executions(started.run.id))
      .find(execution => execution.workflowNodeId !== fixture.version.entryNodeId)!
    expect(requester.nativeSessionId).toBeUndefined()
    const originalOwners = fixture.registry.snapshot().launches.filter(launch => launch.owner === `execution:${requester.id}`)
    const activeOwner = originalOwners.find(launch => launch.lifecycle === 'active')
    expect(activeOwner).toBeDefined()

    const reader = await fixture.access.issue({ name: 'Run observer', audience: 'operator',
      expiresAt: new Date(Date.now() + 300_000),
      grants: [{ actions: ['runs:read'], scope: { runIds: [started.run.id] } }] })
    const denied = await fixture.call('run_stop', { workspaceId: started.run.workspaceId,
      runId: started.run.id, commandId: randomUUID() }, reader.token)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    await fixture.reconcile()
    expect((await fixture.executions(started.run.id)).find(execution => execution.id === requester.id)?.state)
      .toBe('starting')
    expect(fixture.registry.snapshot().launches.find(launch => launch.launchId === activeOwner!.launchId)?.lifecycle)
      .not.toBe('closed')

    await fixture.restartWorker()
    await fixture.restartMain({ mode: 'crash' })
    const detail = await waitForRemoteReview(async () => {
      await fixture.reconcile()
      return SavedRunDetailsSchema.parse(await fixture.value('run_get', {
        workspaceId: started.run.workspaceId, runId: started.run.id, detail: 'full',
      }))
    }, value => value.run.executionState === 'completed', 'interrupted Run after native owner restarts')
    expect(detail.run.outcome).toBe('failed')
    expect(detail.executions.find(execution => execution.id === requester.id)).toMatchObject({
      state: 'completed', result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: true } },
    })
    expect(detail.run.workflowVersionId).toBe(started.run.workflowVersionId)
    expect(detail.run.input).toEqual(started.run.input)
    const closed = (await receipts(fixture, started.run.id)).find(receipt => receipt.intent.executionId === requester.id)!
    expect(hasPositiveRemoteEntryClosure(closed)).toBe(true)
    expect(closed.native).toBeUndefined()
    expect(closed.terminal?.result).toBeUndefined()
    expect(originalOwners.every(original => fixture.registry.closedRegistration(original.owner, original.launchId))).toBe(true)
    const preparation = await waitForReleasedWorkflowSource(fixture, started.run.workspaceId, closed.intent.operationId)
    expect(preparation.reservationState).toBe('retained')
    await fixture.reconcile()
    expect((await fixture.executions(started.run.id)).filter(execution => execution.workflowNodeId === requester.workflowNodeId))
      .toHaveLength(1)
    expect((await fixture.provider.calls()).filter(call => call.method === 'turn/start'
      && call.correlationId === `execution:${requester.id}`)).toHaveLength(0)

    await rm(join(fixture.provider.directory, 'block-requester-session'))
    await fixture.provider.releaseReview()
    const later = (await startWhenReady(fixture))!
    const launched = await waitForRemoteReview(async () => {
      await fixture.reconcileReviews()
      return fixture.executions(later.run.id)
    }, executions => executions.some(
      execution => execution.workflowNodeId !== fixture.version.entryNodeId && !!execution.nativeSessionId),
    'later Run native session')
    expect(launched.some(execution => execution.nativeSessionId)).toBe(true)
    const laterOwners = fixture.registry.snapshot().launches.filter(launch =>
      launched.some(execution => launch.owner === `execution:${execution.id}`))
    const stopCommandId = randomUUID()
    await fixture.value('run_stop', { workspaceId: later.run.workspaceId, runId: later.run.id, commandId: stopCommandId })
    const stopped = SavedRunDetailsSchema.parse(await fixture.value('run_get', {
      workspaceId: later.run.workspaceId, runId: later.run.id, detail: 'full',
    }))
    expect(stopped.run.executionState).toBe('completed')
    expect(stopped.cleanupPending).not.toBe(true)
    expect(stopped.run.workflowVersionId).toBe(later.run.workflowVersionId)
    expect(stopped.run.input).toEqual(later.run.input)
    const laterReceipts = await receipts(fixture, later.run.id)
    expect(laterReceipts.length).toBeGreaterThan(0)
    expect(laterReceipts.every(receipt => !!receipt.terminal?.closureEvidenceDigest)).toBe(true)
    expect(laterOwners.every(owner => fixture.registry.closedRegistration(owner.owner, owner.launchId))).toBe(true)
    await fixture.value('run_stop', { workspaceId: later.run.workspaceId, runId: later.run.id, commandId: stopCommandId })
    expect(await receipts(fixture, later.run.id)).toEqual(laterReceipts)
  })
}, 240_000)
