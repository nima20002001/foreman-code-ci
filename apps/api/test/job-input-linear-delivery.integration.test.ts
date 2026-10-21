import { hashWork } from './helpers/hashWork.js'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { FileDescriptionSchema, MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { JobInputAdmissionSchema } from '@foreman-code/contracts/job-inputs'
import { jobExecution } from './helpers/jobFixture.js'
import { createCanonicalJobInputPorts } from '../src/modules/files/jobInputs/factory.js'
import { makeManifest } from '../src/modules/files/jobInputs/manifest.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { identity } from '../src/modules/sources/privateFilesystem.js'

it('copies a real 20 MiB canonical input with linear hash work and verifies the complete destination', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'job-input-linear-'))
  const project = join(root, 'project')
  await mkdir(project, { mode: 0o700 })
  const bytes = Buffer.alloc(20 * 1024 * 1024, 97)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const execution = jobExecution()
  execution.acceptedSpec.inputs = [{ path: 'input.md', fileId: 'file', revisionId: 'revision', sha256, byteSize: bytes.length }]
  const handle = await open(project, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    execution.acceptedSpec.target.destination.canonicalProjectRoot = project
    execution.acceptedSpec.target.destination.directoryIdentityHash = createHash('sha256')
      .update(JSON.stringify(await identity(handle))).digest('hex')
  } finally { await handle.close() }
  const pin = { fileId: 'file', revisionId: 'revision', sha256, byteSize: bytes.length }
  const manifest = makeManifest(execution, [{ relativePath: 'files/input.md', pin,
    scope: { kind: 'workspace_reference', workspaceId: execution.workspaceId }, senderPrincipalId: 'actor',
    senderGrantsDigest: 'a'.repeat(64), delegation: null }])
  const admission = JobInputAdmissionSchema.parse({ version: 1, manifest, principalId: 'actor',
    principalGrantsDigest: 'a'.repeat(64), issuedAt: new Date().toISOString(), transfers: [] })
  const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool
  const ports = createCanonicalJobInputPorts({ pool, runtime: {} as never, endpoint: { currentBinding: () => undefined },
    storageRoot: join(root, 'store'), receiptRoot: join(root, 'receipts') })
  const stored = new FileByteStorage(join(root, 'store'), MAX_FILE_BYTES)
  const storageKey = randomUUID()
  const revision = { filename: 'input.md', mediaType: 'text/markdown' as const, sha256, byteSize: bytes.length }
  const fileRead = vi.spyOn(PostgresFileRepository.prototype, 'read').mockResolvedValue({
    storageKey, value: { revision },
  } as never)
  vi.spyOn(ports.main, 'bind').mockResolvedValue(admission)
  vi.spyOn(ports.main, 'accepted').mockResolvedValue({ execution, admission })
  const recheck = vi.spyOn(ports.main, 'recheck').mockResolvedValue(undefined)
  try {
    expect(FileDescriptionSchema.safeParse({
      filename: revision.filename, mediaType: revision.mediaType,
    }).success).toBe(true)
    const candidate = await stored.receive(storageKey, Readable.from([bytes]), revision)
    await stored.stage(candidate, revision)
    await stored.finalize(storageKey, revision)
    hashWork.bytes = 0
    hashWork.limit = bytes.length * 3
    const verified = { privateRepositoryRoot: project,
      directoryIdentityHash: execution.acceptedSpec.target.destination.directoryIdentityHash,
      privateGit: true as const, diskQuotaBytes: bytes.length + 1024 * 1024 }
    const receipt = await ports.local.prepare(execution, verified, new AbortController().signal)
    expect(receipt.files).toContainEqual({ relativePath: 'files/input.md', sha256, byteSize: bytes.length })
    expect(hashWork.bytes).toBeLessThan(bytes.length * 3)
    expect(recheck.mock.calls.length).toBeGreaterThan(bytes.length / 8192)
    hashWork.limit = Infinity
    expect((await readFile(join(project, '.graphql-job-inputs/files/input.md'))).equals(bytes)).toBe(true)
    expect(fileRead).toHaveBeenCalled()
    const controller = new AbortController()
    const reader = await ports.main.openRead(execution, admission, 'files/input.md', controller.signal)
    try {
      expect(await reader.read(0, 8192)).toEqual(bytes.subarray(0, 8192))
      recheck.mockRejectedValueOnce(new Error('Recipient revoked'))
      await expect(reader.read(8192, 8192)).rejects.toThrow('revoked')
      controller.abort(new Error('Delivery cancelled'))
      await expect(reader.read(8192, 8192)).rejects.toThrow('cancelled')
    } finally { await reader.close() }
    const signal = new AbortController().signal
    expect(await ports.local.verifyPrepared(execution, verified, receipt, signal)).toEqual(receipt)
    const destination = join(project, '.graphql-job-inputs/files/input.md')
    await chmod(destination, 0o600)
    const changed = await open(destination, constants.O_WRONLY | constants.O_NOFOLLOW)
    try {
      await changed.write(Buffer.from([98]), 0, 1, bytes.length - 1)
      await changed.sync()
    } finally { await changed.close() }
    await expect(ports.local.verifyPrepared(execution, verified, receipt, signal)).rejects.toThrow('hash differs')
  } finally {
    hashWork.limit = Infinity
    vi.restoreAllMocks()
    await chmod(join(project, '.graphql-job-inputs'), 0o700).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
