import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect } from 'vitest'
import { AgentConfigurationVersionSchema, GetInteractionResponseSchema, NativeSessionLaneSchema, ReviewJobSchema,
  withAdvancedDefaults, type HarnessExecution } from '@foreman-code/contracts'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { RunExecutionLocationV3Schema } from '@foreman-code/contracts/wave25'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { hasRetainedRemoteReviewerSource } from '../../src/modules/interactions/retainedRemoteReviewer.js'
import { HostHarnessProfileEvidenceRepository } from '../../src/modules/harnesses/instanceSettings/profileRepository.js'
import { harnessConnectionGeneration } from '../../src/modules/harnesses/hostConnectionGeneration.js'
import { remoteReviewProduction, waitForRemoteReview as waitForProduction } from './remoteReviewProduction.js'
import { buildRemoteReviewWorkerRelease } from './remoteReviewProvider.js'
import { privateFixtureDirectory, withPrivateFixtureDirectories } from './privateFixtureDirectory.js'

type Fixture = Awaited<ReturnType<typeof remoteReviewProduction>>
type Inventory = Awaited<ReturnType<Fixture['inventory']>>

export async function waitForReplacementReviewInventory(
  fixture: Pick<Fixture, 'inventory' | 'profiles'>, previous: Inventory,
): Promise<Inventory> {
  return waitForRemoteReview(fixture.inventory, value => {
    const original = previous.hostMetadata?.connection?.binding
    const current = value.hostMetadata?.connection?.binding
    if (!current || !original || current.connectionEpoch === original.connectionEpoch) return false
    // The live binding can arrive before its installation snapshot.
    const generation = harnessConnectionGeneration(current)
    return fixture.profiles.every(profile => value.installations.some(installation =>
      installation.harnessInstallationId === profile.target.harnessInstallationId
        && installation.connectionGeneration === generation))
  }, 'replacement authenticated inventory generation')
}

export async function waitForRemoteReview<T>(read: () => Promise<T>, accept: (value: T) => boolean,
  description: string, subscribe?: (changed: () => void) => () => void): Promise<T> {
  const started = performance.now()
  console.info(`[remote-review] waiting for ${description} at ${new Date().toISOString()}`)
  try {
    return await waitForProduction(read, accept, description, subscribe)
  } finally {
    console.info(`[remote-review] ${description}: ${Math.round(performance.now() - started)} ms`)
  }
}

/** Keep pairing and qualified profiles alive for the file's scenarios. */
export function useRemoteReviewFixture(options: Parameters<typeof remoteReviewProduction>[0] = {}) {
  let fixture: Fixture | undefined
  let workerRelease: string
  // Cold packaging has its own bound so it cannot consume the native setup budget.
  beforeAll(async () => {
    workerRelease = await (options.workerRelease ?? withPrivateFixtureDirectories(async () => {
      const directory = await privateFixtureDirectory('remote-review-worker-release-')
      return buildRemoteReviewWorkerRelease(directory)
    }))
  }, 60_000)
  beforeAll(async () => {
    const started = performance.now()
    fixture = await remoteReviewProduction({
      ...options, workerRelease, parallelProfileChecks: true, reuseMatchingProfiles: true,
      // Reconnects still refresh immediately; avoid periodic payload hashing during native checks.
      parallelSetup: true, installationRefreshIntervalMs: 60_000,
      reportPhase: (phase, elapsedMs) => console.info(`[remote-review] ${phase}: ${Math.round(elapsedMs)} ms`),
    })
    console.info(`[remote-review] fixture ready: ${Math.round(performance.now() - started)} ms`)
  }, 60_000)
  afterAll(async () => {
    if (!fixture) return
    const cleanupStarted = performance.now()
    await fixture.close()
    console.info(`[remote-review] cleanup: ${Math.round(performance.now() - cleanupStarted)} ms`)
  }, 60_000)
  return async (check: (fixture: Fixture) => Promise<void>) => {
    if (!fixture) throw new Error('Remote review fixture setup did not complete.')
    await checkRemoteReviewFixture(check, fixture)
  }
}

async function checkRemoteReviewFixture(check: (fixture: Fixture) => Promise<void>, fixture: Fixture) {
  const started = performance.now()
  try {
    await check(fixture)
    console.info(`[remote-review] case complete: ${Math.round(performance.now() - started)} ms`)
  } catch (error) {
    console.error('Remote review production failure', error)
    console.error('Remote review production error codes', fixture.failures())
    const executions = await fixture.db.pool.query<{ record: HarnessExecution }>(
      'select record from harness_executions order by created_at')
    console.error('Remote review execution failures', executions.rows.flatMap(({ record }) => record.result?.error
      ? [{ executionId: record.id, state: record.state, error: record.result.error }] : []))
    console.error('Remote review jobs', (await fixture.db.pool.query(`select id,state,
      record->'error' as error,record->>'retryAfter' as retry_after,
      record->>'providerTurnOrMessageId' as provider_turn,record->>'attempt' as attempt,
      lease_expires_at>clock_timestamp() as lease_active from review_jobs order by created_at`)).rows)
    console.error('Remote review writer leases', (await fixture.db.pool.query(`select native_session_id,
      record->>'correlationId' as correlation,record->>'leaseToken' is not null as claimed,
      record->>'leaseExpiresAt' as expires_at from native_session_lanes`)).rows)
    console.error('Remote review credential fences', (await fixture.db.pool.query(`select b.execution_id,b.purpose,
      b.approval_review_lease_fence=j.lease_fence as current_job_fence,
      b.approval_connection_generation::text as credential_generation,
      j.approval_connection_generation::text as job_generation,
      (select l.record->>'connectionGeneration' from native_session_lanes l
        where l.harness=j.record->>'provider' and l.native_session_id=j.record->>'nativeSessionId') as writer_generation
      from worker_credential_bindings b left join review_jobs j on j.id=b.approval_review_job_id`)).rows)
    console.error('Remote review interactions', (await fixture.db.pool.query(`select id,status,
      record->>'deliveryState' as delivery_state from durable_interactions`)).rows)
    console.error('Remote review delivery attempts', (await fixture.db.pool.query(`select interaction_id,attempt,state,error,
      approval_write_started_at is not null as write_started,remote_owner_control is not null as remote_reserved
      from interaction_delivery_attempts order by interaction_id,attempt`)).rows)
    console.error('Remote reviewer retention', (await fixture.db.pool.query(`select receipt->'intent'->>'executionId' as execution_id,
      receipt->>'phase' as phase,receipt->'retainedReviewer'->>'expiresAt' as retained_until,
      receipt->'terminal'->>'kind' as terminal,clock_timestamp() as observed_at from remote_execution_receipts`)).rows)
    console.error('Remote source reservations', (await fixture.db.pool.query(
      'select owner_id,state,reserved_bytes from source_storage_reservations order by reservation_id')).rows)
    const activity = (await fixture.provider.calls()).filter(call => call.method === undefined
      || call.method === 'turn/start' || call.method === 'turn/interrupt').slice(-30)
    console.error('Remote review provider activity', activity.map(call => ({
      method: call.method, nativeStarted: call.nativeStarted, review: call.review, providerFailure: call.providerFailure,
      reviewDecisionError: call.reviewDecisionError, approvalResponse: call.approvalResponse,
      reviewDecision: call.reviewDecision,
    })))
    await reportNativeStartup(fixture)
    throw error
  }
}

async function reportNativeStartup(fixture: Fixture, after = 0) {
  const activity = await fixture.provider.startupActivity()
  console.info('[remote-review] native startup', activity.slice(after).map(event => ({
    occurredAt: event.occurredAt, nativeCommand: event.nativeCommand, method: event.method,
    nativeStarted: event.nativeStarted, workflowTurn: event.workflowTurn, workflowCompleted: event.workflowCompleted,
  })))
  return activity.length
}

export async function reviewInProgress(fixture: Fixture) {
  let startupOffset = (await fixture.provider.startupActivity()).length
  const workspace = ManagedWorkspaceSchema.parse(await fixture.value('workspace_get', {
    workspaceId: fixture.version.definition.workspaceId,
  }))
  expect(workspace.workspace.repository).toMatchObject({ provider: 'github', defaultBranch: 'main' })
  expect(`${workspace.workspace.repository!.owner}/${workspace.workspace.repository!.name}`)
    .toBe(fixture.repositoryName)
  expect(fixture.sourceManifest.capturePolicy).toBe('git-tree-v1')
  expect(fixture.sourceManifest.git?.repository).toBe(fixture.repositoryName)
  const requesterVersion = Object.entries(fixture.version.agentConfigurationVersionIds)
    .find(([agentId]) => agentId !== fixture.version.approval.designatedOrchestratorAgentId)?.[1]
  const row = (await fixture.db.pool.query<{ record: unknown }>(
    'select record from agent_configuration_versions where id=$1', [requesterVersion])).rows[0]
  const configuration = AgentConfigurationVersionSchema.parse(row?.record)
  expect(configuration.harness.harness).toBe('codex')
  if (configuration.harness.harness !== 'codex') throw new Error('The requester requires the Codex fixture.')
  expect(configuration.harness.advanced).toBeUndefined()
  expect(fixture.profiles[1]!.configuration).toEqual(withAdvancedDefaults(configuration.harness))
  const started = await fixture.start()
  const location = RunExecutionLocationV3Schema.parse(started.run.executionLocation)
  expect(workspace.executionLocation).not.toBeNull()
  expect(location).toMatchObject(workspace.executionLocation!)
  expect((await fixture.details(started.run.id)).run.executionLocation).toEqual(location)
  // The execution edge starts the requester only after the reviewer's workflow turn settles.
  await waitForRemoteReview(async () => {
    await fixture.reconcileReviews()
    const details = await fixture.details(started.run.id)
    const reviewer = details.executions.find(execution =>
      execution.agentId === fixture.version.approval.designatedOrchestratorAgentId)
    if (reviewer?.result?.outcome === 'failed') {
      throw new Error(`Native reviewer failed before requester startup: ${reviewer.result.error?.code}`)
    }
    return reviewer
  }, reviewer => reviewer?.state === 'completed' && reviewer.result?.outcome === 'succeeded',
  'completed reviewer workflow turn', fixture.subscribeNativeChanges)
  const interaction = await waitForRemoteReview(async () => {
    // Retry recoverable workflow boundaries through the engine without the source-cleanup sweep.
    await fixture.reconcileReviews()
    const pending = (await fixture.pending(started.run.id))[0]
    if (!pending) {
      const failed = (await fixture.executions(started.run.id)).find(execution => execution.result?.outcome === 'failed')
      if (failed) throw new Error(`Native execution failed before review: ${failed.result?.error?.code}`)
    }
    return pending
  }, value => value !== undefined, 'routed native interaction', fixture.subscribeNativeChanges)
  startupOffset = await reportNativeStartup(fixture, startupOffset)
  if (!interaction) throw new Error('The requester has no pending interaction.')
  const job = await waitForRemoteReview(async () => {
    await fixture.reconcileReviews()
    const row = (await fixture.db.pool.query<{ record: unknown }>(
      'select record from review_jobs where interaction_id=$1', [interaction.id])).rows[0]
    const current = row ? ReviewJobSchema.parse(row.record) : undefined
    if (current?.state === 'failed') throw new Error(`Remote reviewer failed: ${JSON.stringify(current.error)}`)
    return current
  }, value => value?.state === 'acknowledged', 'authenticated remote review submission', fixture.subscribeNativeChanges)
  await reportNativeStartup(fixture, startupOffset)
  if (!job) throw new Error('The retained reviewer has no submitted review job.')
  const executions = await fixture.executions(started.run.id)
  const reviewer = executions.find(execution => execution.agentId === job.reviewerAgentId)
  const requester = executions.find(execution => execution.id === interaction.executionId)
  if (!reviewer || !requester) throw new Error('The Run is missing its native execution identities.')
  const owners = fixture.registry.snapshot().launches.filter(launch => launch.lifecycle === 'active'
    && [reviewer.id, requester.id].some(executionId => launch.owner === `execution:${executionId}`))
  expect(owners).toHaveLength(2)
  for (const owner of owners) {
    expect(owner.guardian).toBeDefined()
    expect(owner.provider).toBeDefined()
    expect(owner.boundary?.kind).toBe('cgroup-v2')
  }
  return { run: started.run, interaction, job, reviewer, requester, owners }
}

export async function readInteraction(fixture: Fixture, interactionId: string) {
  return GetInteractionResponseSchema.parse(await fixture.value('interaction_get', { interactionId })).interaction
}

export async function deliveredReview(fixture: Fixture, interactionId: string) {
  const job = await waitForRemoteReview(async () => {
    const failure = (await fixture.provider.calls()).find(call => call.providerFailure !== undefined)
    if (failure) throw new Error(`Remote review provider failed: ${String(failure.providerFailure)}`)
    await fixture.reconcileReviews()
    const row = (await fixture.db.pool.query<{ record: unknown }>(
      'select record from review_jobs where interaction_id=$1', [interactionId])).rows[0]!
    return ReviewJobSchema.parse(row.record)
  }, value => value.state === 'completed', 'persisted completed remote review')
  // Retry the original MCP decision after its native terminal commits, without a global maintenance sweep.
  await fixture.provider.retryReview()
  // Graph resume and native acknowledgment advance the interaction revision after delivery.
  const { interaction } = await waitForRemoteReview(async () => {
    const failure = (await fixture.provider.calls()).find(call => call.providerFailure !== undefined)
    if (failure) throw new Error(`Remote review provider failed: ${String(failure.providerFailure)}`)
    await fixture.reconcileReviews()
    return GetInteractionResponseSchema.parse(await fixture.value('interaction_get', { interactionId }))
  }, value => value.interaction.deliveryState === 'delivered' && value.activity?.workerAcknowledgment === 'confirmed',
  'persisted native decision delivery and worker acknowledgment', fixture.subscribeNativeChanges)
  expect(interaction.selectedSemantic).toBe('approve_once')
  expect(interaction.deliveredAt).toBeDefined()
  expect(job.providerTurnOrMessageId).toBeDefined()
  expect(job.completedAt).toBeDefined()
  return { interaction, job }
}

export async function receipts(fixture: Fixture, runId: string) {
  const rows = await fixture.db.pool.query<{ receipt: unknown }>(`select r.receipt
    from remote_execution_receipts r join execution_dispatch_intents i on i.operation_id=r.operation_id
    where i.run_id=$1 order by i.execution_id`, [runId])
  return rows.rows.map(row => RemoteOperationReceiptSchema.parse(row.receipt))
}

export async function retainedReviewRecovery(fixture: Fixture, recovery: 'crash' | 'graceful' | 'expired-receipt') {
  const active = await reviewInProgress(fixture)
  const beforeInventory = await fixture.inventory()
  const originalWorkerPid = fixture.workerPid()
  const originalLaunches = active.owners.map(owner => ({
    owner: owner.owner, launchId: owner.launchId, guardian: owner.guardian, provider: owner.provider, boundary: owner.boundary,
  }))
  const ownerLaunchIds = fixture.registry.snapshot().launches.filter(owner => originalLaunches.some(
    original => original.owner === owner.owner)).map(owner => owner.launchId).sort()
  const originalReceipts = await receipts(fixture, active.run.id)
  const processCredentials = async () => (await fixture.db.pool.query<{
    principal_id: string; execution_id: string
  }>(`select principal_id,execution_id from worker_credential_bindings
    where run_id=$1 and revoked_at is null order by execution_id,principal_id`, [active.run.id])).rows
  const originalCredentials = await processCredentials()
  expect(originalCredentials.map(row => row.execution_id).sort())
    .toEqual([active.reviewer.id, active.requester.id].sort())
  if (recovery === 'graceful') {
    const shortened = await fixture.db.pool.query(`update management_principals p
      set expires_at=clock_timestamp()+interval '70 seconds' from worker_credential_bindings b
      where b.principal_id=p.id and b.execution_id=$1 and b.revoked_at is null and p.revoked_at is null`,
    [active.reviewer.id])
    expect(shortened.rowCount).toBe(1)
  }
  await fixture.restartMain({ mode: recovery === 'graceful' ? 'graceful' : 'crash', afterShutdown: async () => {
    if (recovery === 'graceful') {
      const lease = (await fixture.db.pool.query<{ live: boolean; remaining_ms: number }>(`select
        p.revoked_at is null and b.revoked_at is null as live,
        (extract(epoch from (p.expires_at-clock_timestamp()))*1000)::float8 as remaining_ms
        from worker_credential_bindings b join management_principals p on p.id=b.principal_id
        where b.execution_id=$1 and b.purpose='reviewer'`, [active.reviewer.id])).rows[0]!
      expect(lease.live).toBe(true)
      expect(lease.remaining_ms).toBeGreaterThan(5 * 60_000)
      const lifetime = (await fixture.db.pool.query<{ detached: boolean; closed: boolean }>(`select
        detached_at is not null as detached,closed_at is not null as closed from execution_native_closures
        where execution_id=$1 order by generation desc limit 1`, [active.reviewer.id])).rows[0]
      expect(lifetime).toEqual({ detached: true, closed: false })
      expect(await hasRetainedRemoteReviewerSource(fixture.db.pool, active.reviewer)).toBe(true)
      const row = (await fixture.db.pool.query<{ record: unknown }>(
        'select record from review_jobs where id=$1', [active.job.id])).rows[0]!
      const retained = ReviewJobSchema.parse(row.record)
      expect(retained.state).toBe('acknowledged')
      expect(retained.nativeSessionId).toBe(active.job.nativeSessionId)
      expect(retained.providerTurnOrMessageId).toBe(active.job.providerTurnOrMessageId)
      expect(retained.leaseToken).toBeUndefined()
      expect(retained.leaseExpiresAt).toBeUndefined()
      const lanes = (await fixture.db.pool.query<{ record: unknown }>(
        'select record from native_session_lanes where native_session_id=any($1::text[])',
        [[active.reviewer.nativeSessionId, active.requester.nativeSessionId]],
      )).rows.map(row => NativeSessionLaneSchema.parse(row.record))
      expect(lanes).toHaveLength(2)
      for (const lane of lanes) {
        expect(lane.leaseToken).toBeUndefined()
        expect(lane.leaseOwner).toBeUndefined()
        expect(lane.leaseExpiresAt).toBeUndefined()
      }
      expect(lanes.find(lane => lane.nativeSessionId === retained.nativeSessionId)).toMatchObject({
        correlationId: retained.correlationId, currentTurnOrMessageId: retained.providerTurnOrMessageId,
      })
    }
    if (recovery !== 'graceful') {
      // Main has exited; expire its observer leases without waiting for the wall clock.
      const expired = new Date(Date.now() - 1_000).toISOString()
      const job = await fixture.db.pool.query(`update review_jobs
        set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb($3::text))
        where id=$1 and record->>'leaseToken'=$2`, [active.job.id, active.job.leaseToken, expired])
      expect(job.rowCount).toBe(1)
      const lane = await fixture.db.pool.query(`update native_session_lanes
        set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb($4::text))
        where harness=$1 and native_session_id=$2 and record->>'correlationId'=$3
          and record->>'leaseToken' is not null`,
      [active.job.provider, active.job.nativeSessionId, active.job.correlationId, expired])
      expect(lane.rowCount).toBe(1)
    }
    if (recovery === 'expired-receipt') {
      const expired = new Date(Date.now() - 60_000).toISOString()
      const journal = JSON.parse(await readFile(join(fixture.stateDirectory, 'workflow-operations.json'), 'utf8')) as
        { receipts: unknown[] }
      const worker = journal.receipts.map(receipt => RemoteOperationReceiptSchema.parse(receipt))
        .find(receipt => receipt.intent.executionId === active.reviewer.id)!
      expect(Date.parse(worker.retainedReviewer!.expiresAt)).toBeGreaterThan(Date.now())
      expect(worker.native?.sessionId).toBe(active.reviewer.nativeSessionId)
      const stale = RemoteOperationReceiptSchema.parse({ ...worker, sequence: worker.sequence - 1,
        retainedReviewer: { ...worker.retainedReviewer, expiresAt: expired } })
      await fixture.db.pool.query(`update remote_execution_receipts set sequence=$2,receipt=$3::jsonb
        where operation_id=$1`, [stale.intent.operationId, stale.sequence, JSON.stringify(stale)])
      const cached = (await receipts(fixture, active.run.id)).find(receipt =>
        receipt.intent.executionId === active.reviewer.id)!
      expect(Date.parse(cached.retainedReviewer!.expiresAt)).toBeLessThan(Date.now())
      expect(worker.sequence).toBeGreaterThan(cached.sequence)
    }
  } })
  const inventory = await waitForReplacementReviewInventory(fixture, beforeInventory)
  const previousBinding = beforeInventory.hostMetadata?.connection?.binding
  const replacementBinding = inventory.hostMetadata?.connection?.binding
  expect(previousBinding).toBeDefined()
  expect(replacementBinding).toBeDefined()
  expect(replacementBinding!.connectionEpoch).not.toBe(previousBinding!.connectionEpoch)
  expect(replacementBinding!.bootId).toBe(previousBinding!.bootId)
  expect(replacementBinding!.connectionGeneration).toBeGreaterThan(previousBinding!.connectionGeneration)
  for (const profile of fixture.profiles) {
    const previous = beforeInventory.installations.find(installation =>
      installation.harnessInstallationId === profile.target.harnessInstallationId)
    const replacement = inventory.installations.find(installation =>
      installation.harnessInstallationId === profile.target.harnessInstallationId)
    expect(previous).toBeDefined()
    expect(replacement).toBeDefined()
    expect(replacement!.connectionGeneration).toBe(previous!.connectionGeneration)
    expect(replacement!.connectionGeneration).toBe(harnessConnectionGeneration(replacementBinding!))
  }
  expect(fixture.workerPid()).toBe(originalWorkerPid)
  const profileEvidence = new HostHarnessProfileEvidenceRepository(fixture.db.pool)
  // Inventory arrives before reconnect qualification; dispatching early incurs a retry backoff.
  await waitForRemoteReview(() => Promise.all(fixture.profiles.map(profile =>
    profileEvidence.latest(profile.instanceId, profile.revision))), proofs => proofs.every((proof, index) => {
    const installation = inventory.installations.find(value =>
      value.harnessInstallationId === fixture.profiles[index]!.target.harnessInstallationId)
    return !!proof && !!installation && proof.qualified && proof.authenticated === true && proof.compatible === true
      && proof.connectionGeneration === installation.connectionGeneration
      && proof.environmentGeneration === installation.environmentGeneration
  }), 'replacement Worker profile qualification')
  await fixture.reconcileReviews()
  const currentReceipts = await receipts(fixture, active.run.id)
  expect(currentReceipts.map(receipt => ({ intent: receipt.intent, native: receipt.native })))
    .toEqual(originalReceipts.map(receipt => ({ intent: receipt.intent, native: receipt.native })))
  const reconnected = fixture.registry.snapshot().launches.filter(owner => originalLaunches.some(
    original => original.launchId === owner.launchId))
  expect(reconnected.map(owner => ({ owner: owner.owner, launchId: owner.launchId,
    guardian: owner.guardian, provider: owner.provider, boundary: owner.boundary }))).toEqual(originalLaunches)
  expect(reconnected.every(owner => owner.lifecycle === 'active')).toBe(true)
  // Attachment temporarily owns the same correlated lane. Wait for history from
  // the replacement review observer, whose writer stays live through the decision.
  const recoveredLease = await waitForRemoteReview(async () => {
    await fixture.reconcileReviews()
    const row = (await fixture.db.pool.query<{
      record: unknown; credential_bound: boolean; reviewer_live: boolean; writer_live: boolean; observer_ready: boolean
    }>(`select
      j.record,exists(select 1 from worker_credential_bindings b where b.execution_id=j.execution_id
        and b.approval_review_lease_fence=j.lease_fence and b.revoked_at is null) as credential_bound,
      j.lease_expires_at>clock_timestamp() and exists(select 1 from native_session_lanes l
        where l.harness=j.record->>'provider' and l.native_session_id=j.record->>'nativeSessionId'
          and l.record->>'correlationId'=j.record->>'correlationId'
          and l.record->>'leaseToken' is not null
          and (l.record->>'leaseExpiresAt')::timestamptz>clock_timestamp()
          and (l.record->>'connectionGeneration')::bigint=j.approval_connection_generation) as writer_live,
      exists(select 1 from review_native_proofs p join native_session_lanes l
        on l.harness=j.record->>'provider' and l.native_session_id=j.record->>'nativeSessionId'
        where p.job_id=j.id and p.record#>>'{jobLease,token}'=j.lease_token
          and (p.record#>>'{jobLease,fence}')::bigint=j.lease_fence
          and p.record#>>'{lane,token}'=l.record->>'leaseToken'
          and p.record#>>'{original,type}'='history') as observer_ready,
      exists(select 1 from execution_dispatch_intents i join remote_execution_receipts r using(operation_id)
        where i.execution_id=j.execution_id
          and (r.receipt#>>'{retainedReviewer,expiresAt}')::timestamptz>clock_timestamp()) as reviewer_live
      from review_jobs j where j.id=$1`, [active.job.id])).rows[0]
    if (!row) return undefined
    return { job: ReviewJobSchema.parse(row.record),
      credentialBound: row.credential_bound, reviewerLive: row.reviewer_live, writerLive: row.writer_live,
      observerReady: row.observer_ready }
  }, value => !!value && value.job.attempt > active.job.attempt && value.job.state === 'acknowledged'
    && value.credentialBound && value.reviewerLive && value.writerLive && value.observerReady,
  'replacement Main review lease and original process credential rebinding')
  expect(recoveredLease?.observerReady, 'recovery must finish attachment before resuming the reviewer').toBe(true)
  expect(await processCredentials()).toEqual(originalCredentials)
  if (recovery === 'graceful') {
    const generations = (await fixture.db.pool.query<{ generation: string; detached: boolean; closed: boolean }>(`select
      generation::text,detached_at is not null as detached,closed_at is not null as closed
      from execution_native_closures where execution_id=$1 order by generation`, [active.reviewer.id])).rows
    expect(generations).toHaveLength(2)
    expect(generations[0]).toMatchObject({ detached: true, closed: false })
    expect(generations[1]).toMatchObject({ detached: false, closed: false })
  }
  if (recovery === 'expired-receipt') {
    const renewed = (await receipts(fixture, active.run.id)).find(receipt =>
      receipt.intent.executionId === active.reviewer.id)!
    expect(Date.parse(renewed.retainedReviewer!.expiresAt)).toBeGreaterThan(Date.now())
  }
  const reader = await fixture.access.issue({ name: 'Recovered review reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 300_000), grants: [{ actions: ['interactions:read'],
      scope: { runIds: [active.run.id] } }] })
  const pending = await readInteraction(fixture, active.interaction.id)
  const option = pending.responseOptions.find(option => option.semantic === 'approve_once')!
  const denied = await fixture.call('interaction_respond', { interactionId: pending.id,
    optionId: option.optionId, expectedRevision: pending.revision }, reader.token)
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
  expect(await readInteraction(fixture, pending.id)).toEqual(pending)
  const beforeRenewal = (await receipts(fixture, active.run.id)).find(receipt =>
    receipt.intent.executionId === active.reviewer.id)!
  // Observe a persisted periodic renewal before delivering with the original credential.
  await waitForRemoteReview(async () => {
    await fixture.reconcileReviews()
    return (await receipts(fixture, active.run.id)).find(receipt =>
      receipt.intent.executionId === active.reviewer.id)
  }, receipt => !!receipt && receipt.sequence > beforeRenewal.sequence
    && Date.parse(receipt.retainedReviewer!.expiresAt) > Date.parse(beforeRenewal.retainedReviewer!.expiresAt),
  'periodic retained reviewer renewal with the original process credential')
  await fixture.provider.releaseReview()
  const decisionCall = await waitForRemoteReview(async () => {
    await fixture.reconcile()
    const calls = await fixture.provider.calls()
    const denied = calls.find(call => call.reviewDecisionError !== undefined)
    expect(denied, 'the retained reviewer must remain authorized after Main recovery').toBeUndefined()
    return calls.find(call => call.reviewDecision !== undefined)
  }, call => call !== undefined, 'authenticated retained reviewer decision response')
  expect(decisionCall?.reviewDecision).toMatchObject({
    interactionId: pending.id,
    value: { interaction: { id: pending.id, selectedOptionId: option.optionId, selectedSemantic: 'approve_once' } },
  })
  const delivered = await deliveredReview(fixture, active.interaction.id)
  expect(delivered.job.nativeSessionId).toBe(active.job.nativeSessionId)
  expect(delivered.job.providerTurnOrMessageId).toBe(active.job.providerTurnOrMessageId)
  expect((await fixture.provider.calls()).filter(call => 'approvalResponse' in call)).toHaveLength(1)
  const starts = (await fixture.provider.calls()).filter(call => call.method === 'turn/start'
    && call.correlationId === active.job.correlationId)
  expect(starts).toHaveLength(1)
  expect(fixture.registry.snapshot().launches.filter(owner => originalLaunches.some(
    original => original.owner === owner.owner)).map(owner => owner.launchId).sort())
    .toEqual(ownerLaunchIds)
  const settled = await waitForRemoteReview(async () => {
    await fixture.reconcile()
    return fixture.details(active.run.id)
  }, value => value.run.executionState === 'completed' && value.cleanupPending !== true,
  'completed Run and native cleanup after recovered review delivery')
  expect(settled.run.outcome).toBe('succeeded')
  return { runId: active.run.id, launchIds: ownerLaunchIds }
}
