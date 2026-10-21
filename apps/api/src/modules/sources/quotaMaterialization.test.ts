import { jobCleanupOptions, jobLifecycleSignal } from '../jobs/lifecycle.js'
import { VerificationJobExecutionSchema } from '@foreman-code/contracts/job-verification'
import { verificationJobLifecycle } from '@foreman-code/contracts/job-verification-policy'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { sourceMaterializationClaimName } from './quotaClaims.js'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobVerificationQuotaPool } from '@foreman-code/contracts/job-verification-runtime'
import { sourceMaterializationParent, type RootBinding } from '@foreman-code/contracts/source-materialization'
import type { JobQuotaReader } from '../jobs/quotaOwnership.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim, releaseMaterializationClaimForCancellation, reconcileSourcePreparation, withClaimLock } from './materialization.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'

const roots: string[] = []
const projectDirectories = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (from: string, to: string) => {
    const source = await actual.realpath(dirname(from)), destination = await actual.realpath(dirname(to))
    const project = (path: string) => projectDirectories.find(directory => path === directory || path.startsWith(`${directory}/`)) ?? 'controller'
    if (project(source) !== project(destination)) throw Object.assign(new Error('cross-project rename'), { code: 'EXDEV' })
    return actual.rename(from, to)
  } }
})
afterEach(async () => { projectDirectories.length = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(slotCount = 2) {
  const root = await privateFixtureDirectory('job-source-quota-')
  roots.push(root)
  await chmod(root, 0o700)
  const bytes = Buffer.from('same accepted source')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
    entries: [{ path: 'src/index.ts', kind: 'file', byteSize: bytes.length,
      sha256: sourceSha256(bytes), executable: false }] })
  const directory = await openPrivateRoot(root)
  const filesystem = await identity(directory)
  await directory.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
    workspaceId: randomUUID(), rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: root,
    filesystem, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const slots = []
  for (const projectId of Array.from({ length: slotCount }, (_, index) => 2 + index)) {
    const namespace = randomUUID()
    const path = join(root, namespace)
    await mkdir(path, { mode: 0o700 })
    const slot = await openPrivateRoot(path)
    slots.push({ namespace, projectId, hardLimitBytes: 8 * 2 ** 20, hardInodes: 100,
      filesystem: await identity(slot) })
    await slot.close()
  }
  const pool: JobVerificationQuotaPool = { queryExecutable: '/protected/quota-query', queryBinarySha256: 'a'.repeat(64),
    blockDevice: '/dev/loop0', volumeCapacityInodes: 1000, slots }
  const retained = new Set<string>()
  // The kernel reader is an external boundary; these tests exercise actual filesystem claims and copies.
  const read: JobQuotaReader = async (_pool, path, signal) => {
    signal.throwIfAborted()
    const slot = pool.slots.find(value => path.startsWith(join(root, value.namespace)))!
    const file = await openPrivateRoot(path)
    const fs = await identity(file)
    await file.close()
    const base = join(root, slot.namespace)
    const stat = await open(base, 'r')
    const allocated = (await stat.stat()).blocks * 512
    await stat.close()
    const occupied = (await readdir(base)).length > 0 || retained.has(slot.namespace)
    return { volumeCapacityBytes: 64 * 2 ** 30, volumeCapacityInodes: 1000,
      projectId: slot.projectId, inheritance: true, hardLimitBytes: slot.hardLimitBytes, hardInodes: slot.hardInodes,
      usedBytes: occupied ? allocated + 4096 : allocated, usedInodes: occupied ? 2 : 1,
      accountingEnabled: true, filesystem: fs }
  }
  const quota = { pool, read }
  const attempt = () => ({ placementHash: 'b'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(),
    keyRevision: null, authorizationRevision: null })
  const materializer = () => new PrivateSourceMaterializer({ read: async () => bytes }, async () => {}, quota)
  return { root, manifest, binding, quota, attempt, materializer, bytes, retained }
}

describe('per-Job source quota ownership', () => {
  it('reclaims sealed input directories only after execution ownership is released', async () => {
    const f = await fixture(1)
    const receipt = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    const inputs = join(sourceMaterializationParent(receipt), 'tree/sealed-inputs')
    await mkdir(inputs, { mode: 0o700 })
    await writeFile(join(inputs, 'manifest.json'), '{}', { mode: 0o400 })
    await chmod(inputs, 0o500)
    await expect(releaseMaterializationClaim(receipt, async () => 'owned', f.quota)).rejects.toThrow()
    expect(await readFile(join(inputs, 'manifest.json'), 'utf8')).toBe('{}')
    await releaseMaterializationClaim(receipt, async () => 'released', f.quota)
    const successor = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    expect(successor.quota).toEqual(receipt.quota)
  })
  it('reclaims normal readable dependency directories beneath the private owned namespace', async () => {
    const f = await fixture(1)
    const receipt = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    const dependency = join(sourceMaterializationParent(receipt), 'tree/node_modules/package')
    await mkdir(dependency, { recursive: true, mode: 0o755 })
    await chmod(dependency, 0o755)
    await writeFile(join(dependency, 'index.js'), 'ordinary installed dependency', { mode: 0o644 })
    await releaseMaterializationClaim(receipt, async () => 'released', f.quota)
    const successor = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    expect(successor.quota).toEqual(receipt.quota)
    expect(successor.materializationId).not.toBe(receipt.materializationId)
  })
  it('releases and reuses a quota slot when the filesystem rejects cross-project renames', async () => {
    const f = await fixture(1)
    projectDirectories.push(...f.quota.pool.slots.map(slot => join(f.root, slot.namespace)))
    const receipt = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    await releaseMaterializationClaim(receipt, async () => 'released', f.quota)
    await releaseMaterializationClaim(receipt, async () => 'released', f.quota)
    const successor = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    expect(successor.materializationId).not.toBe(receipt.materializationId)
    expect(successor.quota).toEqual(receipt.quota)
    await releaseMaterializationClaim(receipt, async () => 'released', f.quota)
    await expect(f.materializer().verify(successor, { binding: f.binding, attempt: {
      placementHash: successor.placementHash, executionId: successor.executionId, attemptId: successor.attemptId,
      keyRevision: successor.keyRevision, authorizationRevision: successor.authorizationRevision } })).resolves.toBeUndefined()
  })
  it.each([4, 2])('prepares %i concurrent Jobs from one root and recovers their independent quotas after restart', async count => {
    const f = await fixture(count)
    const attempts = Array.from({ length: count }, () => f.attempt())
    const receipts = await Promise.all(attempts.map(attempt =>
      f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt })))
    expect(new Set(receipts.map(receipt => receipt.quota!.projectId)).size).toBe(count)
    expect(new Set(receipts.map(receipt => receipt.quota!.namespace)).size).toBe(count)
    for (const [index, receipt] of receipts.entries()) {
      expect(await f.materializer().recover(f.binding, attempts[index]!)).toEqual(receipt)
      expect(await readFile(join(sourceMaterializationParent(receipt), 'tree/src/index.ts'))).toEqual(f.bytes)
    }
    await expect(f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() }))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
  })

  it('recovers a persisted slot claim when the attempt claim write was interrupted', async () => {
    const f = await fixture()
    const attempt = f.attempt()
    const receipt = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt })
    await rm(join(f.root, sourceMaterializationClaimName(f.binding, attempt, f.quota)))
    expect(await f.materializer().recover(f.binding, attempt)).toEqual(receipt)
    const other = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    expect(other.quota!.projectId).not.toBe(receipt.quota!.projectId)
  })

  it('reclaims an interrupted preparation after restart and keeps its original closure on retry', async () => {
    const f = await fixture()
    const attempt = f.attempt()
    const source = { approvedSourceId: f.manifest.approvedSourceId,
      snapshotId: f.manifest.snapshotId, manifestDigest: f.manifest.manifestDigest }
    const owner: SourceOperationOwner = { identity: { operationId: randomUUID(), ownerPrincipalId: 'operator',
      expiresAt: new Date(Date.now() + 60_000).toISOString() },
      root: { version: 1, source, binding: f.binding, registration: null,
        selection: { hostRef: { kind: 'main', mainId: f.binding.mainId }, rootPolicyId: randomUUID(),
          rootPolicyRevision: '1', locationRevision: '1' }, ownerPrincipalId: 'operator',
        authorizedByPrincipalId: 'operator', attestationId: randomUUID(), attestationDigest: 'a'.repeat(64),
        boundAt: new Date().toISOString() },
      attempt, source, record: null, physicalClosureConfirmed: false, preparationClosed: true }
    const interrupted = new PrivateSourceMaterializer({ read: async () => { throw new Error('connection interrupted') } },
      async () => {}, f.quota)
    await expect(interrupted.prepare({ manifest: f.manifest, binding: f.binding, attempt }))
      .rejects.toThrow('connection interrupted')
    await expect(f.materializer().recover(f.binding, attempt))
      .rejects.toMatchObject({ code: 'SOURCE_MATERIALIZATION_UNCERTAIN' })
    const reconciliationId = randomUUID()
    const closure = await reconcileSourcePreparation(reconciliationId, owner, async () => true, async () => {}, f.quota)
    expect(closure.quotaReclaimed).toBe(true)
    expect(await reconcileSourcePreparation(reconciliationId, owner, async () => true, async () => {}, f.quota))
      .toEqual(closure)
    const prepared = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    expect(prepared.quota!.projectId).toBe(f.quota.pool.slots[0]!.projectId)
  })

  it('stops initial recovery at the preparation signal while another owner retains the namespace lock', async () => {
    const f = await fixture()
    const root = await openPrivateRoot(f.root)
    let entered!: () => void
    let release!: () => void
    const locked = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const owner = withClaimLock(root, async () => { entered(); await released })
    await locked
    const attempt = f.attempt()
    const controller = new AbortController()
    const reason = new DOMException('Preparation cancelled.', 'AbortError')
    const preparing = f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt,
      signal: controller.signal }).then(() => null, error => error)
    controller.abort(reason)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      expect(await Promise.race([preparing, new Promise<'still waiting'>(resolve => {
        timer = setTimeout(() => resolve('still waiting'), 1000)
      })])).toBe(reason)
    } finally {
      if (timer) clearTimeout(timer)
      release()
      await owner
      await preparing
      await root.close()
    }
    const recovered = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt })
    expect(await readFile(join(sourceMaterializationParent(recovered), 'tree/src/index.ts'))).toEqual(f.bytes)
  })

  it('retains quota after cleanup interruption and resumes within the original absolute budget after restart', async () => {
    const f = await fixture(1)
    const receipt = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    const deadlineAt = Date.now() + 60_000
    const controller = new AbortController()
    const reason = new DOMException('Worker generation closed.', 'AbortError')
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(deadlineAt - Date.now())])
    const closed = async () => {
      try { await readFile(join(sourceMaterializationParent(receipt), 'receipt.json')) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        controller.abort(reason)
      }
      return 'released' as const
    }
    await expect(releaseMaterializationClaim(receipt, closed, f.quota, signal)).rejects.toBe(reason)
    await expect(f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() }))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
    await releaseMaterializationClaim(receipt, async () => 'released', f.quota,
      AbortSignal.timeout(deadlineAt - Date.now()))
    const successor = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    expect(successor.quota).toEqual(receipt.quota)
    expect(await readFile(join(sourceMaterializationParent(successor), 'tree/src/index.ts'))).toEqual(f.bytes)
  })

  it('releases a closed execution quota after its cleanup deadline without renewing execution or publication', async () => {
    const f = await fixture(1)
    const receipt = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    const runtime = verificationRuntimeFixture()
    const policy = { ...runtime.spec.policy, cleanupTimeoutMs: 60_000 }
    const execution = VerificationJobExecutionSchema.parse({ ...jobExecution(), schemaVersion: 2,
      acceptedSpec: { ...runtime.spec, policy,
        lifecycle: verificationJobLifecycle(new Date(0).toISOString(), policy) },
      process: { phase: 'terminal', outcome: 'build_failed', exitCode: 1, signal: null, processStopped: true },
      publication: 'failed' })
    const saved = structuredClone(execution)
    expect(jobLifecycleSignal(execution, 'cleanup').aborted).toBe(true)
    expect(jobLifecycleSignal(execution, 'publication').aborted).toBe(true)
    await expect(f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() }))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
    const recovery = jobCleanupOptions(execution)
    expect(recovery.signal.aborted).toBe(false)
    expect(Date.parse(recovery.deadlineAt) - Date.now()).toBeGreaterThan(0)
    expect(Date.parse(recovery.deadlineAt) - Date.now()).toBeLessThanOrEqual(policy.cleanupTimeoutMs)
    await expect(releaseMaterializationClaim(receipt, async () => 'uncertain', f.quota, recovery.signal))
      .rejects.toMatchObject({ code: 'SOURCE_ROOT_OWNED' })
    await releaseMaterializationClaim(receipt, async () => 'released', f.quota, recovery.signal)
    const successor = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    expect(successor.quota).toEqual(receipt.quota)
    expect(successor.materializationId).not.toBe(receipt.materializationId)
    expect(execution).toEqual(saved)
    expect(jobLifecycleSignal(execution, 'publication').aborted).toBe(true)
  })

  it('retains the original quota when closure or deleted-file accounting remains uncertain', async () => {
    const f = await fixture()
    const first = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    await expect(releaseMaterializationClaim(first, async () => 'uncertain', f.quota))
      .rejects.toMatchObject({ code: 'SOURCE_ROOT_OWNED' })
    f.retained.add(first.quota!.namespace)
    await expect(releaseMaterializationClaim(first, async () => 'released', f.quota))
      .rejects.toMatchObject({ code: 'SOURCE_QUOTA_OWNED' })
    await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    await expect(f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() }))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
    f.retained.clear()
    await releaseMaterializationClaim(first, async () => 'released', f.quota)
    const successor = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    expect(successor.quota).toEqual(first.quota)
    await releaseMaterializationClaim(first, async () => 'released', f.quota)
    expect(await readFile(join(sourceMaterializationParent(successor), 'tree/src/index.ts'))).toEqual(f.bytes)
  })

  it('validates the original source before a signed filesystem-recovery quota reclaim', async () => {
    const f = await fixture(1)
    const receipt = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    const source = join(sourceMaterializationParent(receipt), 'tree/src/index.ts')
    await writeFile(source, 'replaced original source')
    await expect(releaseMaterializationClaimForCancellation(receipt, f.binding.filesystem,
      async () => 'released', new AbortController().signal, f.quota)).rejects.toThrow()
    await expect(f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() }))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
    await writeFile(source, f.bytes)
    await releaseMaterializationClaimForCancellation(receipt, f.binding.filesystem,
      async () => 'released', new AbortController().signal, f.quota)
    const successor = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    expect(successor.quota).toEqual(receipt.quota)
  })

  it('cleans only the original namespace, including scratch symlinks, and finishes after a lost release acknowledgment', async () => {
    const f = await fixture()
    const first = await f.materializer().prepare({ manifest: f.manifest, binding: f.binding, attempt: f.attempt() })
    const outside = join(f.root, 'retained-source-snapshot')
    await writeFile(outside, f.bytes, { mode: 0o600 })
    await symlink(outside, join(sourceMaterializationParent(first), 'scratch-link'))
    await releaseMaterializationClaim(first, async () => 'released', f.quota)
    await releaseMaterializationClaim(first, async () => 'released', { ...f.quota })
    expect(await readFile(outside)).toEqual(f.bytes)
    await expect(readFile(join(sourceMaterializationParent(first), 'receipt.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(f.root, first.quota!.namespace))).toEqual([])
  })
})
