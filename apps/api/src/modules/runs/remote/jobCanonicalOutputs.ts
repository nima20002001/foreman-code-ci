import { jobLifecycleSignal } from '../../jobs/lifecycle.js'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { readDeclaredJobOutputs, readAvailableVerificationOutputs, JobOutputCollectionError } from '../../jobs/executorOutputs.js'
import { projectJobReceiptLocked } from '../../jobs/receiptProjection.js'
import type { JobPublicationAuthority } from '../../jobs/authority.js'
import { createCanonicalJobArtifactPort } from '../../files/jobs/factory.js'
import { createAdmittedJobOutputs } from '../../files/jobs/admittedFactory.js'
import type { PostgresJobOutputAdmission } from '../../files/jobs/outputAdmission.js'
import { VerifiedJobOutputReader } from '../../files/jobs/transferReader.js'
import type { JobOutputPublicationInput } from '../../files/jobs/port.js'
import type { VerifiedArtifactReader } from '../../files/distributed/publication.js'
import type { RemoteJobOperationReceiptRecord } from '@foreman-code/contracts/remote-job-execution'
import type { RemoteOperationJournal } from './operationJournal.js'
import type { JobSql } from '../../jobs/repository.js'

/** Concrete main canonical adapter + verified original transfer reader; no alternate byte store. */
export function createJobCanonicalOutputs(input: { pool: pg.Pool; storageRoot: string; excludedRoots?: readonly string[];
  authority: JobPublicationAuthority; transfers: VerifiedArtifactReader; accepted: PostgresJobOutputAdmission }) {
  const artifacts = createCanonicalJobArtifactPort({ pool: input.pool, storageRoot: input.storageRoot,
    ...(input.excludedRoots ? { excludedRoots: input.excludedRoots } : {}), authority: input.authority,
    reader: new VerifiedJobOutputReader(input.transfers, input.accepted) })
  return { artifacts, projectReceipt: (sql: JobSql, execution: JobExecutionRecord, receipt: RemoteJobOperationReceiptRecord) =>
    projectJobReceiptLocked(sql, execution, receipt, artifacts) }
}
/** Main uses persisted admission, the actual W07 receiver and the locked job projector together. */
export function createAdmittedJobCanonicalOutputs(input: Parameters<typeof createAdmittedJobOutputs>[0]) {
  const outputs = createAdmittedJobOutputs(input)
  return { ...outputs, projectReceipt: (sql: JobSql, execution: JobExecutionRecord, receipt: RemoteJobOperationReceiptRecord) =>
    projectJobReceiptLocked(sql, execution, receipt, outputs.artifacts) }
}

export { createWorkerJobOutputCollector, createRemoteJobOutputCollector, type JobOutputApplicationPort } from './workerJobOutputs.js'

/** Main-local jobs use real detached bytes, never invented device/transfer identities. */
export function createLocalJobCanonicalOutputs(input: { pool: pg.Pool; storageRoot: string; authority: JobPublicationAuthority; journal: RemoteOperationJournal }) {
  const sealed = new Map<string, { input: JobOutputPublicationInput; specDigest: string; bytes: Buffer }>()
  const artifacts = createCanonicalJobArtifactPort({ pool: input.pool, storageRoot: input.storageRoot, authority: input.authority,
    reader: { open: async (request, execution) => {
      const snapshot = sealed.get(request.commandId)
      if (!snapshot || !isDeepStrictEqual(snapshot.input, request) || snapshot.specDigest !== execution.acceptedSpec.specDigest
        || execution.acceptedSpec.target.hostRef.kind !== 'main') throw new Error('Original sealed main job output is unavailable')
      return Readable.from(snapshot.bytes)
    } } })
  return { artifacts, projectReceipt: (sql: JobSql, execution: JobExecutionRecord, receipt: RemoteJobOperationReceiptRecord) => projectJobReceiptLocked(sql, execution, receipt, artifacts),
    collectOutputs: async (execution: JobExecutionRecord) => {
      const signal = jobLifecycleSignal(execution, 'publication')
      signal.throwIfAborted()
      if (execution.acceptedSpec.target.hostRef.kind !== 'main') throw new Error('Local output reader cannot change the accepted host')
      const outputs = execution.schemaVersion === 2
        ? await readAvailableVerificationOutputs(execution.acceptedSpec.target.destination.canonicalProjectRoot, execution.acceptedSpec)
        : await readDeclaredJobOutputs(execution.acceptedSpec.target.destination.canonicalProjectRoot, execution.acceptedSpec)
      for (const output of outputs) {
        signal.throwIfAborted()
        const declared = execution.acceptedSpec.outputs.find(value => value.path === output.path)
        if (!declared) throw new Error('Undeclared local job output')
        const bytes = Buffer.from(output.bytes), sha256 = createHash('sha256').update(bytes).digest('hex')
        const commandId = await input.journal.jobOutputCommand(execution.operationId, { path: output.path, mediaType: declared.mediaType, sha256, byteSize: bytes.length })
        const request: JobOutputPublicationInput = { workspaceId: execution.workspaceId, executionId: execution.id, attemptId: execution.attemptId,
          owner: execution.owner, commandId, path: output.path, mediaType: declared.mediaType, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length }
        if (sealed.size >= 4 || [...sealed.values()].reduce((sum,value) => sum+value.bytes.length,bytes.length) > 64*1024*1024) throw new Error('Main output sealing capacity exhausted')
        sealed.set(commandId, { input: request, specDigest: execution.acceptedSpec.specDigest, bytes })
        try { await artifacts.publishAccepted(request) } finally { sealed.delete(commandId) }
      }
      if (execution.acceptedSpec.outputs.some(output => output.required
        && !outputs.some(available => available.path === output.path))) {
        throw new JobOutputCollectionError('Available failure artifacts were published; required outputs remain incomplete.')
      }
    } }
}
