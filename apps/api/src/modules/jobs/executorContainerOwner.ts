import { constants } from 'node:fs'
import { open, readFile, realpath, statfs } from 'node:fs/promises'
import { normalize } from 'node:path'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import type { JobRuntimeNativeAdmissionRecord } from '@foreman-code/contracts/job-verification-runtime'
import type { ChildProcess } from 'node:child_process'
import { ignoreError, logIgnoredError } from '../diagnostics/ignoredError.js'

export interface PodmanCommandRunner {
  run(argv: string[], timeoutMs?: number): Promise<{ exitCode: number; stdout: string }>
  attach(argv: string[]): Promise<ChildProcess>
}
export interface OCIProcessIdentity { pid: number; startTicks: string; bootId: string }
export interface OCICgroupBoundary { kind: 'cgroup-v2'; path: string; device: string; inode: string }
export type OCIOwnerScope = {
  subject: { kind: 'job'; executionId: string; attemptId: string; operationId: string; bindingHash: string }
  leaseId: string
  owner: { grantId: string; epoch: string }
  observedDeviceId: string | null
  observedInstallationId: string
  bootId: string
} | {
  subject: { kind: 'qualification'; qualificationId: string; profileId: string; profileRevision: number; operationId: string; fingerprint: string }
  /** Actual persisted diagnostic admission; qualification never borrows a Job grant. */
  admission: JobRuntimeNativeAdmissionRecord
  bootId: string
}
export interface OCIHostCertificate {
  scope: OCIOwnerScope
  containerId: string
  process: OCIProcessIdentity
  boundary: OCICgroupBoundary
  helpers: Array<{ kind: 'conmon' | 'launcher'; process: OCIProcessIdentity; boundary: OCICgroupBoundary | null }>
  lifecycle: 'active' | 'closed' | 'closure-unconfirmed'
}
export interface OCIContainerOwnership {
  scope: OCIOwnerScope
  assertCurrent(): Promise<void>
  assertClosure?(): Promise<void>
  /** Persist the original container intent before create can enter native IO. */
  reserveContainerIntent(identity: string, fingerprint: string): Promise<void>
  /** Existing HRT/W08 journal receives exact ID before start; no second ledger. */
  bindContainer(identity: string, containerId: string): Promise<void>
  /** Existing guarded native launch owners supply their passive disjoint helpers. */
  launchHelpers(): Promise<OCIHostCertificate['helpers']>
  closeHelpers?(): Promise<boolean>
  confirmUnreleasedClosure?(containerId: string): Promise<boolean>
  confirmFailedCreation?(identity: string): Promise<boolean>
  readCertificate(containerId: string): Promise<OCIHostCertificate | null>
  publish(certificate: OCIHostCertificate): Promise<void>
}
export function parseOCIProcessStat(pid: number, text: string, bootId: string): OCIProcessIdentity {
  const close = text.lastIndexOf(')')
  const fields = text.slice(close + 2).trim().split(/\s+/)
  if (!Number.isSafeInteger(pid) || pid <= 0 || !text.startsWith(`${pid} (`) || close < 0 || !/^\d+$/.test(fields[19] ?? '') || !/^[a-f0-9-]{36}$/.test(bootId)) throw new Error('Owned process identity unavailable.')
  return { pid, startTicks: fields[19]!, bootId }
}
async function processIdentity(pid: number, bootId: string) {
  if ((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== bootId) throw new Error('Owned boot identity changed.')
  return parseOCIProcessStat(pid, await readFile(`/proc/${pid}/stat`, 'utf8'), bootId)
}
async function processBoundary(process: OCIProcessIdentity): Promise<OCICgroupBoundary> {
  const before = await processIdentity(process.pid, process.bootId)
  if (before.startTicks !== process.startTicks) throw new Error('Owned process start identity changed.')
  const relative = /^0::(\/[^\n]*)$/m.exec(await readFile(`/proc/${process.pid}/cgroup`, 'utf8'))?.[1]
  const path = relative ? `/sys/fs/cgroup${relative}` : ''
  if (!path.startsWith('/sys/fs/cgroup/') || normalize(path) !== path || await realpath(path) !== path) throw new Error('Canonical owned cgroup unavailable.')
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const metadata = await directory.stat({ bigint: true })
    if ((await statfs(`/proc/self/fd/${directory.fd}`, { bigint: true })).type !== 0x63677270n) throw new Error('Owned boundary is not cgroup v2.')
    const after = await processIdentity(process.pid, process.bootId)
    if (after.startTicks !== before.startTicks) throw new Error('Owned PID was reused.')
    return { kind: 'cgroup-v2', path, device: String(metadata.dev), inode: String(metadata.ino) }
  } finally { await directory.close() }
}
export async function proveOCIBoundaryEmpty(boundary: OCICgroupBoundary): Promise<boolean> {
  try {
    const directory = await open(boundary.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const metadata = await directory.stat({ bigint: true })
      if (String(metadata.dev) !== boundary.device || String(metadata.ino) !== boundary.inode || (await statfs(`/proc/self/fd/${directory.fd}`)).type !== 0x63677270) return false
      return /^populated 0$/m.test(await readFile(`/proc/self/fd/${directory.fd}/cgroup.events`, 'utf8'))
    } finally { await directory.close() }
  } catch (error) { return !!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') }
}
interface OCIInspection { Id: string; Config: { Labels: Record<string, string> }; State: { Pid: number; ConmonPid?: number; Running: boolean; Status: string } }
/** One existing admitted OCI owner. It neither allocates a lease nor creates a registry. */
export class OwnedOCIContainer {
  private closing = false
  private containerId: string | null = null
  private certificate: OCIHostCertificate | null = null
  private creationAbsent = false
  constructor(private readonly intent: { identity: string; labels: Record<string, string>; originalContainerId?: string | null }, private readonly commands: Pick<PodmanCommandRunner, 'run'>,
    private readonly ownership: OCIContainerOwnership) {
    if (intent.originalContainerId && !/^[a-f0-9]{64}$/.test(intent.originalContainerId)) {
      throw new Error('Original immutable container ID required.')
    }
    this.containerId = intent.originalContainerId ?? null
  }
  private async inspect(target: string): Promise<OCIInspection | null> {
    if (this.closing && this.ownership.assertClosure) await this.ownership.assertClosure()
    else await this.ownership.assertCurrent()
    const response = await this.commands.run(['container', 'inspect', target])
    if (response.exitCode !== 0) return null
    const rows: OCIInspection[] = JSON.parse(response.stdout)
    const row = rows[0]
    if (rows.length !== 1 || !row || !/^[a-f0-9]{64}$/.test(row.Id) || Object.entries(this.intent.labels).some(([key, value]) => row.Config?.Labels?.[key] !== value) ||
      this.containerId && row.Id !== this.containerId) throw new Error('Original OCI ownership labels/ID changed.')
    return row
  }
  async bind(containerId: string) {
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Immutable container ID required.')
    const row = await this.inspect(containerId)
    if (!row || row.Id !== containerId) throw new Error('Original container receipt unavailable.')
    await this.ownership.bindContainer(this.intent.identity, containerId)
    this.containerId = containerId
  }
  async entered(): Promise<OCIHostCertificate> {
    const row = await this.inspect(this.containerId ?? this.intent.identity)
    if (!row || !row.State.Running || !Number.isSafeInteger(row.State.Pid) || row.State.Pid <= 0) throw new Error('Live original OCI process unavailable.')
    if (!this.containerId) await this.bind(row.Id)
    if (!this.certificate) {
      const previous = await this.ownership.readCertificate(row.Id)
      if (previous) {
        if (previous.containerId !== row.Id || canonicalGraphJson(previous.scope) !== canonicalGraphJson(this.ownership.scope) || previous.process.bootId !== this.ownership.scope.bootId) throw new Error('Original boundary certificate scope changed.')
        this.certificate = previous
      }
    }
    const process = await processIdentity(row.State.Pid, this.ownership.scope.bootId)
    const boundary = await processBoundary(process)
    if (!boundary.path.includes(`libpod-${row.Id}.scope`)) throw new Error('Owned root cgroup does not identify the exact container.')
    const helpers: OCIHostCertificate['helpers'] = []
    if (row.State.ConmonPid) {
      const conmon = await processIdentity(row.State.ConmonPid, this.ownership.scope.bootId)
      const conmonBoundary = await processBoundary(conmon)
      if (conmonBoundary.path !== boundary.path && !conmonBoundary.path.startsWith(`${boundary.path}/`)) {
        helpers.push({ kind: 'conmon', process: conmon, boundary: conmonBoundary.path.includes(`libpod-conmon-${row.Id}.scope`) ? conmonBoundary : null })
      }
    }
    for (const helper of await this.ownership.launchHelpers()) {
      const observed = await processIdentity(helper.process.pid, helper.process.bootId)
      if (observed.startTicks !== helper.process.startTicks) throw new Error('Original launcher identity changed.')
      if (helper.boundary && canonicalGraphJson(helper.boundary) !== canonicalGraphJson(await processBoundary(observed))) throw new Error('Original launcher boundary changed.')
      if (helper.boundary && (helper.boundary.path === boundary.path || helper.boundary.path.startsWith(`${boundary.path}/`))) continue
      helpers.push(helper)
    }
    this.certificate = { scope: this.ownership.scope, containerId: row.Id, process, boundary, helpers, lifecycle: 'active' }
    await this.ownership.publish(this.certificate)
    return this.certificate
  }
  async close(graceMs: number): Promise<boolean> {
    this.closing = true
    let row = await this.inspect(this.containerId ?? this.intent.identity)
    if (!row) {
      if (!this.containerId) {
        if (!this.ownership.confirmFailedCreation) return false
        const exists = await this.commands.run(['container', 'exists', this.intent.identity])
        this.creationAbsent = exists.exitCode === 1 && await this.ownership.confirmFailedCreation(this.intent.identity)
        return this.creationAbsent
      }
      const retained = await this.ownership.readCertificate(this.containerId)
      if (!retained && this.ownership.confirmUnreleasedClosure) {
        const absent = await this.commands.run(['container', 'exists', this.containerId])
        return absent.exitCode === 1 && (await this.ownership.closeHelpers?.() ?? false)
          && await this.ownership.confirmUnreleasedClosure(this.containerId)
      }
      if (!retained || retained.lifecycle !== 'closed' || retained.containerId !== this.containerId
        || retained.process.bootId !== this.ownership.scope.bootId
        || canonicalGraphJson(retained.scope) !== canonicalGraphJson(this.ownership.scope)) return false
      return await proveOCIBoundaryEmpty(retained.boundary)
        && (await Promise.all(retained.helpers.map(helper =>
          helper.boundary ? proveOCIBoundaryEmpty(helper.boundary) : Promise.resolve(false)))).every(Boolean)
    }
    if (!this.containerId) await this.bind(row.Id)
    if (!this.certificate) {
      const previous = await this.ownership.readCertificate(row.Id)
      if (previous) {
        if (previous.containerId !== row.Id || canonicalGraphJson(previous.scope) !== canonicalGraphJson(this.ownership.scope) || previous.process.bootId !== this.ownership.scope.bootId) throw new Error('Original boundary certificate scope changed.')
        this.certificate = previous
      }
    }
    if (row.State.Running) {
      if (!this.certificate) await this.entered().catch(ignoreError('jobs', 'record container entry before stop', { containerId: row.Id })) // Stop exact ID even when telemetry identity is unavailable; closure stays unconfirmed.
      try { await this.commands.run(['stop', '--time', String(Math.ceil(graceMs / 1000)), row.Id], graceMs + 30000) } catch (error) { logIgnoredError('jobs', 'stop container', error, { containerId: row.Id }) } // Reinspect original identity.
      row = await this.inspect(row.Id)
      if (row?.State.Running) { await this.commands.run(['kill', '--signal', 'KILL', row.Id]); row = await this.inspect(row.Id) }
    }
    let helpersClosed = false
    if (row && !row.State.Running && row.State.Pid === 0) {
      const requiresHelpers = row.State.Status === 'created' || row.State.Status === 'configured'
      helpersClosed = await this.ownership.closeHelpers?.() ?? !requiresHelpers
    }
    if (helpersClosed && row) row = await this.inspect(row.Id)
    const neverStarted = !this.certificate && (row?.State.Status === 'created' || row?.State.Status === 'configured')
    const stopped = helpersClosed && !!row && !row.State.Running && row.State.Pid === 0
      && (row.State.Status === 'exited' || neverStarted)
    const closed = stopped && (this.certificate
      ? await proveOCIBoundaryEmpty(this.certificate.boundary) && (await Promise.all(this.certificate.helpers.map(helper =>
        helper.boundary ? proveOCIBoundaryEmpty(helper.boundary) : Promise.resolve(false)))).every(Boolean)
      : await this.ownership.confirmUnreleasedClosure?.(row!.Id) ?? false)
    if (this.certificate) await this.ownership.publish({ ...this.certificate, lifecycle: closed ? 'closed' : 'closure-unconfirmed' })
    return closed
  }

  async remove(): Promise<void> {
    if (!await this.close(0)) throw new Error('Original container closure is unconfirmed before cleanup.')
    if (this.creationAbsent && !this.containerId) return
    if (!this.containerId) throw new Error('Original container closure is unconfirmed before cleanup.')
    const exists = () => this.commands.run(['container', 'exists', this.containerId!])
    const present = await exists()
    if (present.exitCode === 1) return
    if (present.exitCode !== 0) throw new Error('Original container cleanup readback failed.')
    const removed = await this.commands.run(['rm', '--volumes', this.containerId])
    if (removed.exitCode !== 0 || (await exists()).exitCode !== 1) {
      throw new Error('Original container removal is unconfirmed.')
    }
  }
}
