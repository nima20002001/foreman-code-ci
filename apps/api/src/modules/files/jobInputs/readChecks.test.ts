import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { JobInputAdmissionSchema, type JobInputEntry } from '@foreman-code/contracts/job-inputs'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { JobInputAuthority } from './authority.js'
import { inputHash, makeManifest, recipient } from './manifest.js'
import { CanonicalJobInputs } from './service.js'

function fixture(count = 5) {
  const execution = jobExecution()
  execution.attemptId = randomUUID()
  const principal: ManagementPrincipal = {
    id: 'input-reader', name: 'Input reader', audience: 'operator',
    grants: [{ actions: ['jobs:start', 'workspaces:read'], scope: { workspaceIds: [execution.workspaceId] } }],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  }
  const rows = Array.from({ length: count }, (_, index) => ({
    file_id: `file-${index}`, revision_id: `revision-${index}`, current_revision_id: `revision-${index}`,
    owner_principal_id: principal.id, scope_kind: 'workspace_reference', workspace_id: execution.workspaceId,
    state: 'ready', created_at: new Date(execution.createdAt), revision_created_at: new Date(execution.createdAt),
    filename: `input-${index}.md`, media_type: 'text/markdown', byte_size: '3', sha256: '1'.repeat(64),
    origin: 'upload', storage_key: `input-${index}`,
  }))
  execution.acceptedSpec.inputs = rows.map(row => ({ path: row.filename, fileId: row.file_id,
    revisionId: row.revision_id, sha256: row.sha256, byteSize: Number(row.byte_size) }))
  const entries: JobInputEntry[] = execution.acceptedSpec.inputs.map(({ path, ...pin }) => ({
    relativePath: `files/${path}`, pin, scope: { kind: 'workspace_reference', workspaceId: execution.workspaceId },
    senderPrincipalId: principal.id, senderGrantsDigest: inputHash(principal.grants), delegation: null,
  }))
  const manifest = makeManifest(execution, entries)
  const admission = JobInputAdmissionSchema.parse({ version: 1, manifest, principalId: principal.id,
    principalGrantsDigest: inputHash(principal.grants), issuedAt: execution.createdAt, transfers: [] })
  const reads = { metadata: 0, principal: 0, workspace: 0, receipts: 0, audits: 0 }
  let revoked = false
  let commandId = `job-input:${inputHash(recipient(execution))}`
  const query = vi.fn(async (statement: string, args: unknown[] = []) => {
    if (statement.includes('file_revisions')) {
      reads.metadata += 1
      const fileIds = Array.isArray(args[0]) ? args[0] : [args[0]]
      const revisionIds = Array.isArray(args[1]) ? args[1] : [args[1]]
      return { rows: rows.filter(row => fileIds.some((id, index) =>
        id === row.file_id && revisionIds[index] === row.revision_id)) }
    }
    if (statement.includes('management_command_receipts')) {
      reads.receipts += 1
      return { rows: [{ result: structuredClone(admission), command_id: commandId }] }
    }
    if (statement.includes('job_executions')) {
      return { rows: [{ record: execution, accepted_spec: execution.acceptedSpec,
        accepted_by: principal.id, workspace_id: execution.workspaceId }] }
    }
    if (statement.includes('management_principals')) {
      reads.principal += 1
      return { rows: [{ ...principal, expires_at: new Date(principal.expiresAt),
        revoked_at: revoked ? new Date() : null, delegated_from: null }] }
    }
    if (statement.includes('workspaces')) {
      reads.workspace += 1
      return { rows: [{ archived_at: null }] }
    }
    if (statement.includes('management_audit')) reads.audits += 1
    return { rows: [] }
  })
  const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool
  const runtime = { require: vi.fn(async () => {}) }
  const authority = new JobInputAuthority(pool, runtime)
  const download = vi.fn(async () => Readable.from([Buffer.from('abc')]))
  const service = new CanonicalJobInputs(pool, authority, { download } as never, { currentBinding: () => undefined })
  return { service, execution, admission, rows, reads, runtime, download,
    revoke: () => { revoked = true }, setCommandId: (value: string) => { commandId = value } }
}

describe('canonical input read checks', () => {
  it('batches metadata and shares recipient and scope checks on both sides of each chunk', async () => {
    const f = fixture()
    expect(await f.service.read(f.execution, f.admission, 'files/input-0.md', 0, 3)).toEqual(Buffer.from('abc'))
    // Two batch snapshots per recheck, plus the requested file's storage lookup.
    expect(f.reads.metadata).toBeLessThanOrEqual(5)
    expect(f.runtime.require).toHaveBeenCalledTimes(2)
    expect(f.reads.principal).toBeLessThanOrEqual(4)
    expect(f.reads.workspace).toBe(2)
    expect(f.reads.audits).toBe(1)
  })

  it.each(['removed', 'changed-pin', 'revoked'] as const)('rejects %s authority after reading a chunk', async state => {
    const f = fixture()
    f.download.mockImplementationOnce(async () => {
      if (state === 'removed') f.rows[4]!.state = 'removed'
      if (state === 'changed-pin') f.rows[4]!.sha256 = '2'.repeat(64)
      if (state === 'revoked') f.revoke()
      return Readable.from([Buffer.from('abc')])
    })
    await expect(f.service.read(f.execution, f.admission, 'files/input-0.md', 0, 3)).rejects.toMatchObject({
      code: { removed: 'FILE_BYTES_UNAVAILABLE', 'changed-pin': 'JOB_INPUT_PIN_CONFLICT', revoked: 'AUTH_REVOKED' }[state],
    })
    expect(f.reads.audits).toBe(0)
  })

  it('resolves an original transfer with one receipt read and rejects a mismatched command', async () => {
    const f = fixture(0)
    const transfer = { relativePath: 'manifest.json', intent: {
      version: 1 as const, mainId: f.execution.acceptedSpec.target.mainId,
      deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(),
      connectionEpoch: randomUUID(),
      keyRevision: 1, authorizationRevision: 1, transferId: randomUUID(), operationId: randomUUID(),
      executionId: f.execution.id, attemptId: f.execution.attemptId,
      placementHash: f.execution.acceptedSpec.bindingHash, rootId: randomUUID(), rootBindingRevision: 1,
      direction: 'to-worker' as const, byteClass: 'artifact' as const, sha256: f.admission.manifest.manifestSha256,
      byteSize: f.admission.manifest.manifestByteSize, manifestDigest: f.admission.manifest.manifestSha256,
      expiresAt: '2099-01-01T00:00:00.000Z', chunkBytes: 8192,
    } }
    f.admission.transfers.push(transfer)
    expect(await f.service.acceptedTransfer(transfer.intent.transferId)).toEqual({
      execution: f.execution, admission: f.admission, transfer,
    })
    expect(f.reads.receipts).toBe(1)
    f.setCommandId('unrelated-command')
    await expect(f.service.acceptedTransfer(transfer.intent.transferId)).rejects.toMatchObject({
      code: 'JOB_INPUT_NOT_ADMITTED',
    })
  })
})
