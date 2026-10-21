import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RemoteJobConnectionIdentitySchema, RemoteJobDispatchIntentSchema, RemoteJobTerminalEvidenceSchema, RemoteJobMainRpcRequestSchema } from './remoteJobExecution.js'
import { ArtifactEdgeReadSchema } from './artifactEdges.js'
import { MAX_FILE_READ_BYTES } from './files.js'

const uuid = '00000000-0000-4000-8000-000000000001', digest = 'a'.repeat(64)
describe('current remote Job contract boundaries', () => {
  it('keeps a manual Job subject bound to its own execution without fabricated workflow fields', () => {
    const intent = { schemaVersion: 1, protocolVersion: 1, mainId: uuid,
      subject: { kind: 'manual-job', workspaceId: 'workspace', jobExecutionId: 'job', definitionId: 'definition' },
      executionId: 'job', attemptId: 'attempt', operationId: 'operation', bindingHash: digest, inputDigest: `sha256:${digest}`,
      owner: { grantId: 'grant', epoch: '1' } }
    expect(RemoteJobDispatchIntentSchema.safeParse(intent).success).toBe(true)
    expect(RemoteJobDispatchIntentSchema.safeParse({ ...intent, executionId: 'other-job' }).success).toBe(false)
    expect(RemoteJobDispatchIntentSchema.safeParse({ ...intent, subject: { ...intent.subject, runId: 'invented-run' } }).success).toBe(false)
    expect(RemoteJobMainRpcRequestSchema.safeParse({ method: 'job-source', intent }).success).toBe(true)
    expect(RemoteJobMainRpcRequestSchema.safeParse({ method: 'job-source', intent, action: 'start' }).success).toBe(false)
  })
  it('admits actual main installation evidence without inventing worker registration', () => {
    const connection = { kind: 'main', mainId: uuid, mainInstallationId: 'installation', bootId: uuid }
    expect(RemoteJobConnectionIdentitySchema.safeParse(connection).success).toBe(true)
    expect(RemoteJobConnectionIdentitySchema.safeParse({ ...connection, workerInstallationId: uuid }).success).toBe(false)
    expect(RemoteJobConnectionIdentitySchema.safeParse({ ...connection, bootId: undefined }).success).toBe(false)
  })
  it('requires positive stop evidence and the actual finish timestamp for terminal readback', () => {
    const terminal = { finishedAt: '2026-10-01T00:00:00.000Z', closureEvidenceDigest: digest, outcome: 'succeeded',
      exitCode: 0, signal: null, processStopped: true, resultDigest: digest, logGapPossible: false,
      logsTruncated: false, outputCollectionError: false, artifactDigests: [] }
    expect(RemoteJobTerminalEvidenceSchema.safeParse(terminal).success).toBe(true)
    expect(RemoteJobTerminalEvidenceSchema.safeParse({ ...terminal, processStopped: false }).success).toBe(false)
    expect(RemoteJobTerminalEvidenceSchema.safeParse({ ...terminal, finishedAt: undefined }).success).toBe(false)
  })
  it('uses the existing file read budget for artifact edges', () => {
    expect(ArtifactEdgeReadSchema.safeParse({ edgeId: 'edge', offset: 0, length: MAX_FILE_READ_BYTES }).success).toBe(true)
    expect(ArtifactEdgeReadSchema.safeParse({ edgeId: 'edge', offset: 0, length: MAX_FILE_READ_BYTES + 1 }).success).toBe(false)
  })
  it.each([
    'deviceResources', 'deviceProvisioningFixtures', 'remoteJobExecution',
    'remoteExecution', 'remoteExecutionRpc', 'workerMcpRelay', 'sourceAdmission', 'workspaceRootPolicies',
    'workspaceBoundLocation', 'jobInputs', 'jobInputsNode', 'jobOutputTransfer', 'byteTransfer', 'files',
  ])('evaluates %s as a fresh first ESM import', (name) => {
    const url = new URL(`../dist/${name}.js`, import.meta.url).href
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000 })
    expect(result.status, `${name}: ${result.error?.message ?? result.stderr}`).toBe(0)
  })
})
