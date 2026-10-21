import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { RemoteEntryClosureSchema } from './remoteExecutionEntryClosure.js'
import { RemoteNativeLaunchObservationSchema } from './remoteWorkflowPhysical.js'

it('retains removed-cgroup closure across entry and native observation contracts', () => {
  const mainId = randomUUID()
  const bootId = randomUUID()
  const launchId = randomUUID()
  const launch = { owner: 'execution:execution', launchId, bootId, lifecycle: 'closed',
    closureEvidence: 'cgroup_v2_removed', guardian: { pid: 1001, startTicks: '10' },
    provider: { pid: 1002, startTicks: '11' }, boundary: { kind: 'cgroup-v2',
      path: `/sys/fs/cgroup/graphql-native-${launchId}`, device: '1', inode: '2' } }
  const closure = { intent: { schemaVersion: 1, protocolVersion: 1, mainId, runId: 'run', nodeId: 'node',
    executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
    attemptId: 'attempt', operationId: 'operation', bindingHash: 'a'.repeat(64), inputDigest: `sha256:${'b'.repeat(64)}`,
    owner: { grantId: 'grant', epoch: '1' } }, connection: { mainId, deviceId: randomUUID(),
    workerInstallationId: randomUUID(), bootId, keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 },
    owner: launch.owner, initialLaunchId: launchId, launches: [launch] }
  expect(RemoteEntryClosureSchema.parse(closure)).toEqual(closure)
  expect(RemoteNativeLaunchObservationSchema.parse(launch)).toEqual(launch)
  const unqualified = { ...launch, boundary: undefined }
  expect(RemoteEntryClosureSchema.safeParse({ ...closure, launches: [unqualified] }).success).toBe(false)
  expect(RemoteEntryClosureSchema.safeParse({ ...closure,
    launches: [{ ...launch, owner: 'execution:another' }] }).success).toBe(false)
})
