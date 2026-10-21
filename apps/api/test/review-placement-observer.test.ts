import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type HarnessExecutionRequest } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { repeatNativeObserver, type RepeatNativeObserverContext } from '../src/modules/runs/repeatRuntime.js'
import { RunnerAdmission } from '../src/modules/runs/runnerAdmission.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { RepeatNativeLaunchStore } from '../src/modules/interactions/repeatObservation.js'
import type { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
type Host = 'device' | 'main' | 'unplaced'
async function fixture(host: Host) {
  const f = makeCurrentWorkflowFixture(`review-placement-${host}`, 'single')
  const root = await mkdtemp('/tmp/review-placement-observer-'); directories.push(root)
  // A worker can accept this path on its own filesystem; Main cannot create it.
  const runtimeDirectory = host === 'device' ? join(root, 'worker-only', 'runtime') : join(root, 'runtime', 'execution')
  if (host === 'device') await mkdir(join(root, 'worker-only'), { mode: 0o500 })
  const workingDirectory = host === 'device' ? '/worker/materialized/project' : root
  const node = f.version.definition.nodes[0]!, mainId = randomUUID()
  if (host !== 'unplaced') node.placement = { schemaVersion: 1,
    hostRef: host === 'device' ? { kind: 'device', mainId, deviceId: randomUUID() } : { kind: 'main', mainId },
    rootPolicyId: randomUUID(), rootPolicyRevision: '1', locationRevision: '1', projectRoot: '/approved/project',
    cwdPolicy: 'project-root', relativeCwd: '', instanceId: randomUUID(), instanceRevision: '1', harnessInstallationId: 'installed-codex' }
  const run = { ...f.run, authorizationPrincipalId: 'operator', executionLocation: {
    runnerId: 'main', rootPath: root, locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } }
  let execution = HarnessExecutionSchema.parse({ id: f.identities[0]!.executionId, runId: run.id, workflowNodeId: node.id,
    agentId: node.agentId, agentConfigurationVersionId: f.configurations[0]!.id, attempt: 1, input: {}, state: 'queued', createdAt: f.createdAt })
  const events: string[] = [], paths = { workingDirectory, runtimeDirectory }
  const claimLaunch = vi.fn(async (_id: string, accepted: typeof paths) => {
    events.push('claim'); execution = HarnessExecutionSchema.parse({ ...execution, ...accepted, state: 'starting', startedAt: f.createdAt }); return execution
  })
  const beginNativeEntry = vi.fn(async (id: string) => { events.push('prepare'); return { executionId: id } })
  const authorizeNativeSubmission = vi.fn(async () => { events.push('submit') })
  let consumed = false
  const store = { readExecution: async () => ({ execution, ref: { nodeId: node.id, occurrence: null } }), claimLaunch,
    recoverSession: async () => execution, beginNativeEntry, authorizeNativeSubmission,
    assertExecutionAdmission: vi.fn(async () => undefined), assertNativeBoundary: vi.fn(async () => undefined),
    consumeLaunch: () => { if (consumed) return false; consumed = true; return true } } as unknown as RepeatNativeLaunchStore
  let request: HarnessExecutionRequest | undefined
  const observeExact = vi.fn<ApprovalExecutionCoordinator['observeExact']>(async input => {
    events.push('observe'); request = input.request
    if (host !== 'device') await access(runtimeDirectory)
    expect(input.execution.runtimeDirectory).toBe(runtimeDirectory)
    expect(input.request?.runtimeDirectory).toBe(runtimeDirectory)
    expect(input.request?.workingDirectory).toBe(workingDirectory)
    await input.store!.authorizeNativeSubmission(input.execution.id)
    expect(input.store!.consumeLaunch(input.execution.id)).toBe(true)
    expect(input.store!.consumeLaunch(input.execution.id)).toBe(false)
    const completed = HarnessExecutionSchema.parse({ ...input.execution, state: 'completed', finishedAt: f.createdAt, result: { outcome: 'succeeded' } })
    return { state: 'completed', execution: completed, result: completed.result! }
  })
  const revalidate = vi.fn(async () => undefined), directory = vi.fn(() => runtimeDirectory)
  const context: RepeatNativeObserverContext = { run, version: f.version,
    owner: { runId: run.id, assertOwned: () => undefined, client: {} } as unknown as RunOwnership,
    store, native: { observeExact, assertResume: async () => undefined }, admission: new RunnerAdmission(1),
    workflows: { resolveNodeSkills: async (configuration) => configuration, referencesCreatedByExecution: async () => new Set<string>(), getAgentConfiguration: async () => f.configurations[0] },
    locations: { revalidateRunAuthorization: vi.fn(async () => undefined), revalidateSnapshot: vi.fn(async () => undefined) },
    preparePlacement: async () => host === 'unplaced' ? undefined : { ...paths, revalidate }, directory }
  return { context, execution, runtimeDirectory, workingDirectory, events, claimLaunch, beginNativeEntry, authorizeNativeSubmission,
    observeExact, revalidate, directory, request: () => request,
    observe: () => repeatNativeObserver(context)(execution, new AbortController().signal) }
}

it('observes a device runtime path inaccessible on Main without creating it locally', async () => {
  const f = await fixture('device')
  await expect(f.observe()).resolves.toBeUndefined()
  expect(f.events).toEqual(['claim', 'prepare', 'observe', 'submit'])
  expect(f.revalidate).toHaveBeenCalled()
  expect(f.context.locations.revalidateSnapshot).not.toHaveBeenCalled()
  expect(f.directory).not.toHaveBeenCalled()
  expect(f.request()?.runtimeDirectory).toBe(f.runtimeDirectory)
  await expect(access(f.runtimeDirectory)).rejects.toThrow()
})

it.each(['main', 'unplaced'] as const)('prepares the %s Main-local runtime directory before native observation', async host => {
  const f = await fixture(host)
  await expect(access(f.runtimeDirectory)).rejects.toThrow()
  await f.observe()
  await expect(access(f.runtimeDirectory)).resolves.toBeUndefined()
  expect(f.events).toEqual(['claim', 'prepare', 'observe', 'submit'])
  expect(f.request()?.workingDirectory).toBe(f.workingDirectory)
})

it.each(['device', 'main'] as const)('retains the one-use entry gate for a %s placement', async host => {
  const f = await fixture(host)
  f.beginNativeEntry.mockRejectedValue(new DomainError('NATIVE_ENTRY_CONFLICT', 'No preparation permit', 409))
  await expect(f.observe()).rejects.toMatchObject({ code: 'NATIVE_ENTRY_CONFLICT' })
  expect(f.observeExact).not.toHaveBeenCalled()
  expect(f.authorizeNativeSubmission).not.toHaveBeenCalled()
  await expect(access(f.runtimeDirectory)).rejects.toThrow()
})
