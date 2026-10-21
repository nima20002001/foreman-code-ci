import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { JobOutputAdmissionSchema } from './jobOutputTransfer.js'

function admission() {
  const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 3,
    connectionEpoch: randomUUID() }
  const digest = 'a'.repeat(64)
  const expiresAt = new Date(Date.now() + 60000).toISOString()
  const executionId = randomUUID()
  const attemptId = randomUUID()
  return { version: 1, input: { workspaceId: randomUUID(), executionId, attemptId,
    owner: { grantId: randomUUID(), epoch: '1' }, commandId: randomUUID(), path: 'result.json',
    mediaType: 'application/json', sha256: digest, byteSize: 4 }, principalId: 'artifact-owner',
    inputHash: `sha256:${digest}`, specDigest: digest, materializationId: randomUUID(), materializationDigest: digest,
    fileId: randomUUID(), revisionId: randomUUID(), allocationExpiresAt: expiresAt,
    originalConnection: connection, nativeIdentityDigest: digest, closureEvidenceDigest: digest, receiptSequence: 1,
    intent: { version: 1, mainId: connection.mainId, deviceId: connection.deviceId,
      workerInstallationId: connection.workerInstallationId, bootId: connection.bootId,
      keyRevision: 1, authorizationRevision: 1, connectionEpoch: connection.connectionEpoch,
      transferId: randomUUID(), operationId: randomUUID(), executionId, attemptId,
      placementHash: digest, rootId: randomUUID(), rootBindingRevision: 1,
      direction: 'to-main', byteClass: 'artifact', sha256: digest, byteSize: 4,
      manifestDigest: digest, expiresAt, chunkBytes: 8192 }, admittedAt: new Date().toISOString() }
}

it('preserves the authenticated session epoch through artifact admission and persisted readback', () => {
  const input = admission()
  const accepted = JobOutputAdmissionSchema.parse(input)
  const restored = JobOutputAdmissionSchema.parse(JSON.parse(JSON.stringify(accepted)))
  expect(restored.originalConnection).toEqual(input.originalConnection)
  expect(restored.intent.connectionEpoch).toBe(input.originalConnection.connectionEpoch)
})

it.each(['', 'not-a-session-epoch'])('rejects an invalid session epoch without stripping it: %j', connectionEpoch => {
  const input = admission()
  expect(JobOutputAdmissionSchema.safeParse({ ...input,
    originalConnection: { ...input.originalConnection, connectionEpoch } }).success).toBe(false)
})
