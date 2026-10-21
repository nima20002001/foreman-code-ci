import { persistentFixtureRoot } from '../../../../test/helpers/fixtureStorage.js'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, rm, chmod, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobInputAdmissionSchema, JobInputDeliveryReceiptSchema, type JobInputDeliveryReceipt } from '@foreman-code/contracts/job-inputs'
import type { TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { makeManifest, manifestBytes } from '../../files/jobInputs/manifest.js'
import { transferContextForBinding } from '../../byte-transfer/carrier.js'
import { ResumableByteTransferService } from '../../byte-transfer/service.js'
import { identity } from '../../sources/privateFilesystem.js'
import { bootIdentity } from '../../harnesses/recovery/linuxIdentity.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { createInstalledJobInputRsync } from './installedJobInputRsync.js'
import * as git from '../../jobs/privateGitMounts.js'

const roots: string[] = [], journals: RemoteOperationJournal[] = [], receivers: ResumableByteTransferService[] = []
const inputDirectories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(receivers.splice(0).map(receiver => receiver.close()))
  await Promise.all(journals.splice(0).map(journal => journal.close()))
  for (const directory of inputDirectories.splice(0)) await chmod(directory, 0o700).catch(error => { if (error.code !== 'ENOENT') throw error })
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function directoryIdentity(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { return await identity(handle) } finally { await handle.close() }
}
async function fixture() {
  const root = await mkdtemp(join(persistentFixtureRoot, 'hrt-input-runtime-')); roots.push(root)
  const execution = jobExecution(); execution.id = randomUUID(); execution.attemptId = randomUUID(); execution.operationId = randomUUID()
  const parent = join(root, execution.acceptedSpec.source.materializationId), project = join(parent, 'tree')
  inputDirectories.push(join(project, '.graphql-job-inputs'))
  await mkdir(parent, { mode: 0o700 }); await mkdir(project, { mode: 0o700 })
  for (const name of ['repository', 'job-heavy-jobs']) await mkdir(join(parent, name), { mode: 0o700 })
  const observed = await directoryIdentity(project)
  Object.assign(execution.acceptedSpec.target.destination, { canonicalProjectRoot: project, canonicalCwd: project,
    directoryIdentityHash: createHash('sha256').update(JSON.stringify(observed)).digest('hex') })
  Object.assign(execution.acceptedSpec, jobSpecDigests(execution.acceptedSpec, execution.acceptedSpec.workflowInput))
  const binding = { mainId: execution.acceptedSpec.target.mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, bootId: bootIdentity(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const context = transferContextForBinding(binding), manifest = makeManifest(execution, []), workflow = Buffer.from('null')
  const descriptors = [{ relativePath: 'manifest.json', bytes: manifestBytes(manifest) }, { relativePath: 'workflow-input.json', bytes: workflow }]
  const admission = JobInputAdmissionSchema.parse({ version: 1, manifest, principalId: 'original-actor', principalGrantsDigest: '1'.repeat(64), issuedAt: new Date().toISOString(),
    transfers: descriptors.map(item => ({ relativePath: item.relativePath, intent: { ...context, version: 1, transferId: randomUUID(), operationId: randomUUID(), executionId: execution.id,
      attemptId: execution.attemptId, placementHash: execution.acceptedSpec.bindingHash, rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-worker', byteClass: 'artifact',
      sha256: createHash('sha256').update(item.bytes).digest('hex'), byteSize: item.bytes.length, manifestDigest: manifest.manifestSha256, chunkBytes: 8192,
      expiresAt: new Date(Date.now() + 60000).toISOString() } })) })
  let denied = false, failAck = false, saved: JobInputDeliveryReceipt | undefined
  const order: string[] = []
  const receiver = new ResumableByteTransferService(join(root, 'canonical'), { authorize: async () => { if (denied) throw new Error('Original input grant revoked') } }); receivers.push(receiver)
  const journal = await RemoteOperationJournal.open(join(root, 'journal'), { initializeNewInstallation: true }); journals.push(journal)
  const intent = { schemaVersion: 1 as const, protocolVersion: 1 as const, mainId: context.mainId,
    subject: { kind: 'manual-job' as const, workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId }, executionId: execution.id,
    attemptId: execution.attemptId, operationId: execution.operationId, bindingHash: execution.acceptedSpec.bindingHash, inputDigest: `sha256:${execution.acceptedSpec.specDigest}`, owner: execution.owner }
  await journal.jobAccept(intent, execution, { kind: 'main', mainId: context.mainId, mainInstallationId: execution.acceptedSpec.target.mainInstallationId, bootId: binding.bootId }, randomUUID())
  const digest = 'a'.repeat(64), mounts: git.VerifiedJobGitMounts = { version: 1, layout: git.JOB_PRIVATE_GIT_LAYOUT, workspaceId: execution.workspaceId,
    executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, owner: execution.owner, specDigest: execution.acceptedSpec.specDigest,
    bindingHash: execution.acceptedSpec.bindingHash, materializationId: execution.acceptedSpec.source.materializationId, materializationDigest: execution.acceptedSpec.source.materializationDigest,
    git: { directory: join(parent, 'repository'), filesystem: await directoryIdentity(join(parent, 'repository')), generatedCommit: '4'.repeat(40), sourceCommit: execution.acceptedSpec.source.commit,
      repositoryReceiptDigest: digest, configDigest: digest, indexDigest: digest, mountpoint: await directoryIdentity(join(parent, 'repository')) },
    scheduler: { directory: join(parent, 'job-heavy-jobs'), filesystem: await directoryIdentity(join(parent, 'job-heavy-jobs')) }, receiptDigest: digest }
  const source = { privateRepositoryRoot: project, directoryIdentityHash: execution.acceptedSpec.target.destination.directoryIdentityHash, privateGit: true as const, diskQuotaBytes: 1048576, gitMounts: mounts }
  const verifyGit = vi.spyOn(git, 'verifyJobGitMounts').mockResolvedValue(undefined)
  let helper: ReturnType<typeof createInstalledJobInputRsync>
  const request = vi.fn(async (_namespace: string, raw: unknown) => {
    if (denied) throw new Error('Original input grant revoked')
    const command = raw as { method: string; transferId: string; receipt?: unknown }
    if (command.method === 'bind') return { payload: admission }
    if (command.method === 'authorize') return { payload: { authorized: true, transferId: command.transferId, bindingId: manifest.bindingId } }
    const item = admission.transfers.find(value => value.intent.transferId === command.transferId)
    if (!item) throw new Error('Unknown original input transfer')
    if (command.method === 'stage') {
      order.push('stage')
      const bytes = descriptors.find(value => value.relativePath === item.relativePath)!.bytes
      const offset = (await receiver.status(item.intent.transferId, context)).durableOffset
      if (offset < bytes.length) await receiver.append(item.intent.transferId, context, { offset, sha256: createHash('sha256').update(bytes.subarray(offset)).digest('hex'), bytes: bytes.subarray(offset) })
      return { payload: await receiver.finish(item.intent.transferId, context) }
    }
    if (command.method === 'delivery-status') { order.push('readback'); if (!saved) throw new Error('Original delivery not persisted'); return { payload: saved } }
    if (command.method === 'delivery-ack') {
      saved = JobInputDeliveryReceiptSchema.parse(command.receipt); order.push('persist')
      if (failAck) throw new Error('Lost original delivery ACK')
      await helper.acknowledged(item.intent, context); order.push('backend-ack')
      return { payload: saved }
    }
    throw new Error('Unexpected original input operation')
  })
  const input = { receiver, journal, channel: { request, currentBinding: () => binding }, receiptRoot: join(root, 'receipts'), admissionRoot: join(root, 'admissions') }
  helper = createInstalledJobInputRsync(input)
  return { root, execution, source, admission, context, helper, input, request, receiver, order, verifyGit,
    deny: () => { denied = true }, failAck: () => { failAck = true }, allowAck: () => { failAck = false }, replace: (value: typeof helper) => { helper = value } }
}
describe('installed selected Job-input factory with real canonical journals and detached files', () => {
  it('uses the original transfer deadline for input staging instead of the short metadata request timeout', async () => {
    const f = await fixture()
    const intent = f.admission.transfers[0]!.intent
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(intent.expiresAt) - 45000)
    try {
      await f.helper.prepare(f.execution, f.source, new AbortController().signal)
      expect(f.request).toHaveBeenCalledWith('job-inputs-v1', { method: 'stage', transferId: intent.transferId },
        { signal: expect.any(AbortSignal), timeoutMs: 45000 })
    } finally {
      clock.mockRestore()
    }
  })
  it('stages into the one shared receiver, verifies detached files, and persists before backend ACK readback', async () => {
    const f = await fixture(), receipt = await f.helper.prepare(f.execution, f.source, new AbortController().signal)
    expect(f.order).toEqual(['stage', 'stage', 'persist', 'readback', 'backend-ack', 'persist', 'readback', 'backend-ack'])
    expect(receipt.readonlyMountRequired).toBe(true)
    expect(await f.helper.verifyPrepared(f.execution, f.source, receipt, new AbortController().signal)).toEqual(receipt)
    expect(f.verifyGit).toHaveBeenCalledTimes(2)
    expect(f.request.mock.calls.some(([, raw]) => (raw as { method: string }).method === 'range')).toBe(false)
    f.order.splice(0)
    expect(await f.helper.prepare(f.execution, f.source, new AbortController().signal)).toEqual(receipt)
    expect(f.order).not.toContain('stage')
    await f.helper.close()
  })
  it('recovers original admission read-only after a factory restart and denies substituted intent/bytes', async () => {
    const f = await fixture(), receipt = await f.helper.prepare(f.execution, f.source, new AbortController().signal)
    const recovered = createInstalledJobInputRsync(f.input); f.replace(recovered); f.order.splice(0)
    await recovered.acknowledged(f.admission.transfers[0]!.intent, f.context)
    expect(f.order).toEqual(['readback'])
    await expect(recovered.acknowledged({ ...f.admission.transfers[0]!.intent, attemptId: randomUUID() }, f.context)).rejects.toThrow('ACK context changed')
    const path = join(f.source.privateRepositoryRoot, '.graphql-job-inputs/workflow-input.json')
    await chmod(path, 0o600); await writeFile(path, 'evil')
    await expect(recovered.acknowledged(f.admission.transfers[0]!.intent, f.context)).rejects.toThrow('hash differs')
    expect(receipt.manifestSha256).toBe(f.admission.manifest.manifestSha256)
  })
  it('retries a lost durable ACK using the original verified bytes without staging them again', async () => {
    const f = await fixture(); f.failAck()
    await expect(f.helper.prepare(f.execution, f.source, new AbortController().signal)).rejects.toThrow('Lost original delivery ACK')
    f.allowAck(); f.order.splice(0)
    const recovered = createInstalledJobInputRsync(f.input); f.replace(recovered)
    await recovered.prepare(f.execution, f.source, new AbortController().signal)
    expect(f.order).not.toContain('stage'); expect(f.order).toContain('backend-ack')
  })
  it('rejects missing retained receipt and revoked authority without reconstructing or restaging inputs', async () => {
    const f = await fixture(); await f.helper.prepare(f.execution, f.source, new AbortController().signal)
    await rm(join(f.root, 'receipts', `${f.admission.manifest.bindingId}.json`))
    f.order.splice(0)
    await expect(f.helper.acknowledged(f.admission.transfers[0]!.intent, f.context)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(f.root, 'receipts', `${f.admission.manifest.bindingId}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.order).not.toContain('stage')
    f.deny(); await expect(f.helper.acknowledged(f.admission.transfers[0]!.intent, f.context)).rejects.toThrow('grant revoked')
  })
  it('cancels before any original admission or staging and refuses a foreign source owner', async () => {
    const f = await fixture(), controller = new AbortController(); controller.abort(new Error('Original cancelled'))
    expect(() => f.helper.prepare(f.execution, f.source, controller.signal)).toThrow('Original cancelled')
    expect(f.request).not.toHaveBeenCalled()
    expect(() => f.helper.prepare({ ...f.execution, attemptId: randomUUID() }, f.source, new AbortController().signal)).toThrow('Original qualified Job')
  })
  it('checks durable membership without treating another transfer as an input', async () => {
    const f = await fixture(); await f.helper.prepare(f.execution, f.source, new AbortController().signal)
    expect(await f.helper.owns(f.admission.transfers[0]!.intent)).toBe(true)
    expect(await f.helper.owns({ ...f.admission.transfers[0]!.intent, transferId: randomUUID() } as TransferIntent)).toBe(false)
  })
})
