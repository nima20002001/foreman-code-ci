import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import { SourcePreparationReconcileInputSchema } from '@foreman-code/contracts/source-admission'
import { PrivateSourceMaterializer, preparationChildrenClosed, reconcileSourcePreparation, withClaimLock } from './materialization.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { sourceBindingHash } from './bindingHash.js'
import { sourceMaterializationClaimName } from './quotaClaims.js'
import { InstalledSourceExecutionHosts, type SourceAttemptAuthority, type RemoteSourceMaterializationHost } from './executionHosts.js'
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readdir: vi.fn(original.readdir) }
})
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function fixture(copy = true) {
  const directory = await mkdtemp(join(tmpdir(), 'jobprep-reconcile-')); directories.push(directory)
  const handle = await openPrivateRoot(directory), filesystem = await identity(handle); await handle.close()
  const bytes = Buffer.from('retained source evidence'), manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', entries: [{ path: 'source.txt', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }], deletions: [] })
  const mainId = randomUUID(), operationId = randomUUID()
  const root: SourceOperationOwner['root'] = { version: 1, source: { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    selection: { hostRef: { kind: 'main', mainId }, rootPolicyId: randomUUID(), rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId, deviceId: null, workerInstallationId: null, workspaceId: 'workspace', rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
      canonicalPath: directory, filesystem, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    registration: null, ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner', attestationId: randomUUID(), attestationDigest: 'a'.repeat(64), boundAt: new Date().toISOString() }
  const attempt = { executionId: randomUUID(), attemptId: randomUUID(), keyRevision: null, authorizationRevision: null, placementHash: '' }
  attempt.placementHash = sourceBindingHash(root, attempt, operationId)
  const owner: SourceOperationOwner = { identity: { operationId, ownerPrincipalId: 'cleanup-operator', expiresAt: new Date(Date.now() + 60000).toISOString() },
    root, attempt, source: root.source, record: null, physicalClosureConfirmed: false, preparationClosed: true }
  if (copy) {
    const receipt = await new PrivateSourceMaterializer({ read: async () => bytes }, async () => {}).prepare({ manifest, binding: root.binding, attempt })
    owner.record = { receipt, operationId, reservationId: randomUUID(), rootPolicyId: root.selection.rootPolicyId, rootPolicyRevision: '1', sourceBindingHash: attempt.placementHash,
      finalDispatchBindingHash: null, state: 'prepared' }
    await mkdir(join(directory, receipt.materializationId, 'repository'), { mode: 0o700 })
    await writeFile(join(directory, receipt.materializationId, 'repository', 'partial-object'), 'original incomplete Git evidence', { mode: 0o600 })
  }
  const claimName = sourceMaterializationClaimName(root.binding, attempt,
    owner.record?.receipt.quota, owner.record?.receipt.claimScope ?? 'execution')
  return { directory, owner, bytes, manifest, claimName, reconciliationId: randomUUID(), nativeClosed: vi.fn(async () => true), reauthorize: vi.fn(async () => {}) }
}

it.each(['reservation', 'copy', 'activation'] as const)(
  'reconciles an unacknowledged source attempt interrupted during %s after restart', async phase => {
    const f = await fixture(false)
    const input = { manifest: f.manifest, binding: f.owner.root.binding, attempt: f.owner.attempt }
    const interrupted = new Error('API process stopped')
    if (phase === 'activation') {
      const receipt = await new PrivateSourceMaterializer({ read: async () => f.bytes }, async () => {}).prepare(input)
      await rename(join(f.directory, receipt.materializationId, 'tree'),
        join(f.directory, receipt.materializationId, 'staging'))
    } else {
      const beforeRestart = new PrivateSourceMaterializer({ read: async () => { throw interrupted } }, async () => {})
      await expect(beforeRestart.prepare(input)).rejects.toBe(interrupted)
      if (phase === 'reservation') {
        const claim = JSON.parse(await readFile(join(f.directory, f.claimName), 'utf8')) as { materializationId: string }
        await rm(join(f.directory, claim.materializationId), { recursive: true })
      }
    }
    const read = vi.fn(async () => f.bytes)
    const restarted = new PrivateSourceMaterializer({ read }, async () => {})
    await expect(restarted.prepare(input)).rejects.toMatchObject({ code: 'SOURCE_MATERIALIZATION_UNCERTAIN' })
    expect(read).not.toHaveBeenCalled()
    f.nativeClosed.mockResolvedValue(false)
    await expect(reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize))
      .rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
    expect(await readdir(f.directory)).toContain(f.claimName)
    f.nativeClosed.mockResolvedValue(true)
    const closure = await vi.waitFor(() =>
      reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize))
    expect(closure).toMatchObject({ admissionClosed: true, childrenClosed: true, claimReleased: true })
    expect(await readdir(f.directory)).not.toContain(f.claimName)
  },
)

it('archives a closed claim, retains every source/private-repository byte and replays closure without touching a successor', async () => {
  const f = await fixture(), id = f.owner.record!.receipt.materializationId
  const claim = await readFile(join(f.directory, f.claimName))
  const proof = await vi.waitFor(() => reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize))
  expect(proof).toMatchObject({ materializationId: id, admissionClosed: true, childrenClosed: true, claimReleased: true, evidencePreserved: true })
  expect(await readFile(join(f.directory, `closed-preparation-${f.reconciliationId}.claim.json`))).toEqual(claim)
  expect(await readFile(join(f.directory, id, 'tree/source.txt'))).toEqual(f.bytes)
  expect(await readFile(join(f.directory, id, 'repository/partial-object'), 'utf8')).toBe('original incomplete Git evidence')
  const successor = Buffer.from('successor claim must remain exact')
  await writeFile(join(f.directory, f.claimName), successor, { mode: 0o600 })
  expect(await reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize)).toEqual(proof)
  expect(await readFile(join(f.directory, f.claimName))).toEqual(successor)
})
it('retains a pre-activation failure with no Main materialization record or local claim', async () => {
  const f = await fixture(false)
  const proof = await vi.waitFor(() => reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize))
  expect(proof.materializationId).toBeNull(); expect(proof.evidencePreserved).toBe(true)
})

it('routes Main workflow cleanup through original authorization and positive closure before releasing its claim', async () => {
  const f = await fixture()
  f.owner.preparationKind = 'workflow'
  const closed = vi.fn(async () => false)
  const authorize = vi.fn(async () => {})
  const hosts = new InstalledSourceExecutionHosts(f.owner.root.binding.mainId,
    { read: async () => { throw new Error('Cleanup must not copy source bytes') } },
    {} as SourceAttemptAuthority, {} as RemoteSourceMaterializationHost,
    async () => { throw new Error('Cleanup must not allocate a native session') }, { authorize, closed })
  await expect(hosts.reconcilePreparation(f.reconciliationId, f.owner))
    .rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
  expect(await readdir(f.directory)).toContain(f.claimName)
  closed.mockResolvedValue(true)
  const closure = await vi.waitFor(() => hosts.reconcilePreparation(f.reconciliationId, f.owner))
  expect(closure).toMatchObject({ deviceId: null, workerInstallationId: null, claimReleased: true })
  expect(authorize).toHaveBeenCalledWith(f.reconciliationId, f.owner)
  expect(await readFile(join(f.directory, f.owner.record!.receipt.materializationId, 'tree/source.txt'))).toEqual(f.bytes)
})
it('does not accept an empty task set while an original namespace child is still live', async () => {
  const f = await fixture(), child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: join(f.directory, f.owner.record!.receipt.materializationId), stdio: 'ignore' })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  try {
    await expect(reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize)).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
    expect(await readdir(f.directory)).toContain(f.claimName)
  } finally { child.kill('SIGKILL'); await closed }
  await vi.waitFor(async () => {
    const closure = await reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize)
    expect(closure.childrenClosed).toBe(true)
  })
})
it.each(['argument', 'descriptor'] as const)('retains a claim while a child holds a source %s', async reference => {
  const f = await fixture()
  const source = join(f.directory, f.owner.record!.receipt.materializationId, 'tree/source.txt')
  const script = `process.on('message', path => {
    require('node:fs').openSync(path, 'r')
    process.send('ready')
  })`
  const child = spawn(process.execPath, ['-e', script, ...(reference === 'argument' ? [source] : [])], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    const ready = new Promise<void>(resolve => child.once('message', () => resolve()))
    child.send(source)
    await ready
    await expect(reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize))
      .rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
    expect(await readdir(f.directory)).toContain(f.claimName)
  } finally {
    child.kill('SIGKILL')
    await closed
  }
  const closure = await reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize)
  expect(closure).toMatchObject({ childrenClosed: true, claimReleased: true, evidencePreserved: true })
  expect(await readFile(source)).toEqual(f.bytes)
})
it.each([
  { state: 'exited', code: 'EACCES' },
  { state: 'live', code: 'EACCES' },
  { state: 'exited', code: 'ENOENT' },
  { state: 'live', code: 'EIO' },
] as const)('checks unrelated process descriptor errors ($state, $code)', async ({ state, code }) => {
  const f = await fixture(false)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const descriptors = `/proc/${child.pid}/fd`
  const failure = Object.assign(new Error('Descriptor inspection failed'), { code })
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const inspect = vi.mocked(readdir).mockImplementation(async (...args) => {
    if (String(args[0]) === descriptors) {
      if (state === 'exited') {
        child.kill('SIGKILL')
        await closed
      }
      throw failure
    }
    return original.readdir(...args)
  })
  try {
    if (code !== 'EIO') {
      await expect(preparationChildrenClosed(f.directory)).resolves.toBe(true)
    } else {
      await expect(preparationChildrenClosed(f.directory)).rejects.toMatchObject({
        code: 'source-reconciliation-unconfirmed', cause: failure,
      })
    }
    expect(inspect).toHaveBeenCalledWith(descriptors)
  } finally {
    inspect.mockImplementation(original.readdir)
    child.kill('SIGKILL')
    await closed
  }
})
it.each(['release', 'deadline'] as const)('waits for a contended preparation lock until %s', async outcome => {
  const f = await fixture()
  const root = await openPrivateRoot(f.directory)
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const holder = withClaimLock(root, async () => { entered(); await released })
  await held
  if (outcome === 'deadline') f.owner.identity.expiresAt = new Date(Date.now() + 500).toISOString()
  const pending = reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize)
  const settled = pending.then(() => 'closed', error => error)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    expect(await Promise.race([settled, new Promise<'waiting'>(resolve => {
      timer = setTimeout(() => resolve('waiting'), 250)
    })])).toBe('waiting')
    expect(await readdir(f.directory)).toContain(f.claimName)
    if (outcome === 'deadline') {
      await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
      expect(await readdir(f.directory)).toContain(f.claimName)
      expect(f.nativeClosed).not.toHaveBeenCalled()
      return
    }
    release()
    await holder
    const closure = await pending
    expect(closure).toMatchObject({ childrenClosed: true, claimReleased: true, evidencePreserved: true })
    expect(await readFile(join(f.directory, f.owner.record!.receipt.materializationId, 'tree/source.txt')))
      .toEqual(f.bytes)
  } finally {
    if (timer) clearTimeout(timer)
    release()
    await holder
    await settled
    await root.close()
  }
})
it('preserves uncertain native ownership and rejects missing admission closure, changed roots and caller closure flags', async () => {
  const f = await fixture(); f.nativeClosed.mockResolvedValue(false)
  await expect(reconcileSourcePreparation(f.reconciliationId, f.owner, f.nativeClosed, f.reauthorize)).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
  const { preparationClosed: _closed, ...unconfirmed } = f.owner; void _closed
  await expect(reconcileSourcePreparation(f.reconciliationId, unconfirmed, f.nativeClosed, f.reauthorize)).rejects.toThrow('admission closure')
  const changed = structuredClone(f.owner); changed.root.binding.filesystem.inode = '999999'
  await expect(reconcileSourcePreparation(f.reconciliationId, changed, f.nativeClosed, f.reauthorize)).rejects.toMatchObject({ code: 'SOURCE_ROOT_CHANGED' })
  expect(SourcePreparationReconcileInputSchema.safeParse({ workspaceId: 'workspace', operationId: f.owner.identity.operationId, commandId: randomUUID(), childrenClosed: true }).success).toBe(false)
})
