import { fork } from 'node:child_process'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { JobRuntimeNativeAdmissionRecord } from '@foreman-code/contracts/job-verification-runtime'
import { identityAlive, processIdentity, type LinuxProcessIdentity }
  from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { runQualificationCommand } from '../src/modules/jobs/qualification.js'
import { reconcileInstalledJobRuntimeQualification, releaseQualificationQuotaClaims,
  runInstalledJobRuntimeQualification, recoverInstalledJobRuntimeQualifications }
  from '../src/modules/jobs/installedRuntimeQualification.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { jobQualificationFaultFixture, hungQualificationDiagnostic } from './helpers/jobQualificationFaultFixture.js'

interface CrashedQualification {
  directory: string
  journalPath: string
  registryPath: string
  owner: string
  admission: JobRuntimeNativeAdmissionRecord
  identities: LinuxProcessIdentity[]
  claim: { path: string; namespace: string }
}

async function diagnosticProcesses(marker: string) {
  const paths = [marker, `${marker}.descendant`]
  await vi.waitFor(async () => {
    for (const path of paths) expect(await readFile(path, 'utf8')).toMatch(/^\d+$/)
  }, { timeout: 8000, interval: 25 })
  return Promise.all(paths.map(async path => {
    const identity = processIdentity(Number(await readFile(path, 'utf8')))
    if (!identity) throw new Error('The diagnostic exited before fault injection.')
    return identity
  }))
}

describe('physical qualification interruption', () => {
  it.each(['deadline', 'cancellation'] as const)(
    'closes the original diagnostic and detached descendant on %s before releasing its quota claim', async fault => {
      const f = await jobQualificationFaultFixture()
      const marker = join(f.directory, 'diagnostic')
      const claim = await f.claimQuota()
      const task = runQualificationCommand(f.reserved.native, process.execPath,
        ['-e', hungQualificationDiagnostic, marker],
        f.input.candidate.controllerEnvironment, f.lifetime.signal, 10_000)
      const outcome = task.then(value => ({ value }), error => ({ error }))
      try {
        const identities = await diagnosticProcesses(marker)
        const launches = f.input.registry.snapshot().launches
        expect(launches).toHaveLength(1)
        await expect(releaseQualificationQuotaClaims(f.input.journal, f.input.admission.operationId))
          .rejects.toThrow('Positive qualification closure required')
        expect(await stat(claim.path)).toMatchObject({ nlink: 1 })
        if (fault === 'cancellation') f.lifetime.abort(new Error('Connection lost'))
        expect(await outcome).toMatchObject({ error: { name: 'QualificationCommandInterruptedError',
          reason: fault === 'deadline' ? 'command_timeout' : 'signal_aborted', stopConfirmed: true } })
        expect(identities.map(identityAlive)).toEqual([false, false])
        expect(await f.reserved.native.close()).toBe(true)
        await releaseQualificationQuotaClaims(f.input.journal, f.input.admission.operationId)
        await expect(stat(claim.path)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(claim.namespace)).rejects.toMatchObject({ code: 'ENOENT' })
        const receipt = await f.input.journal.qualificationStatus(f.input.admission.operationId)
        expect(receipt).toMatchObject({ phase: 'closed', admission: f.input.admission, quotaClaims: [] })
        expect(receipt!.launches.map(launch => launch.launchId)).toEqual(launches.map(launch => launch.launchId))
        expect(f.input.registry.snapshot().launches.every(launch => launch.lifecycle === 'closed')).toBe(true)
      } finally {
        await f.close()
        await outcome
      }
    }, 30_000)

  it('observes cancellation delivered inside spawn instead of waiting for the diagnostic deadline', async () => {
    const f = await jobQualificationFaultFixture()
    const native = f.reserved.native
    try {
      const owner = { ...native, spawnProcess: (...args: Parameters<typeof native.spawnProcess>) => {
        const child = native.spawnProcess(...args)
        f.lifetime.abort(new Error('Connection lost during spawn'))
        return child
      } }
      await expect(runQualificationCommand(owner, process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        f.input.candidate.controllerEnvironment, f.lifetime.signal, 10_000))
        .rejects.toMatchObject({ reason: 'signal_aborted', stopConfirmed: true })
      expect(await native.close()).toBe(true)
      const receipt = await f.input.journal.qualificationStatus(f.input.admission.operationId)
      expect(receipt!.launches).toHaveLength(1)
      expect(receipt!.launches[0]!.closed).toBe(true)
      expect(f.input.registry.snapshot().launches.every(launch => launch.lifecycle === 'closed')).toBe(true)
    } finally { await f.close() }
  }, 30_000)

  it('reopens ownership while the original diagnostic survives and cleans it without a replacement entry or lease', async () => {
    const f = await jobQualificationFaultFixture()
    const marker = join(f.directory, 'surviving-diagnostic')
    const claim = await f.claimQuota()
    try {
      const native = f.reserved.native
      const argv = ['-e', hungQualificationDiagnostic, marker]
      const launchId = await native.reserveProcess(process.execPath, argv)
      const child = native.spawnProcess(launchId, process.execPath, argv, {
        shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: f.input.candidate.controllerEnvironment,
      })
      child.stdout!.resume()
      child.stderr!.resume()
      const identities = await diagnosticProcesses(marker)
      await f.reopen()
      expect(identities.every(identityAlive)).toBe(true)
      const before = f.input.registry.snapshot().launches.map(launch => launch.launchId)
      const result = await reconcileInstalledJobRuntimeQualification({ ...f.input,
        signal: AbortSignal.abort(new Error('Caller canceled cleanup')) })
      expect(result).toMatchObject({ outcome: 'denied', closure: 'confirmed' })
      expect(identities.map(identityAlive)).toEqual([false, false])
      const receipt = await f.input.journal.qualificationStatus(f.input.admission.operationId)
      expect(receipt).toMatchObject({ phase: 'closed', admission: f.input.admission,
        quotaClaims: [], result })
      expect(f.input.registry.snapshot().launches.map(launch => launch.launchId)).toEqual(before)
      expect(receipt!.launches.map(launch => launch.launchId)).toEqual([launchId])
      await expect(stat(claim.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(claim.namespace)).rejects.toMatchObject({ code: 'ENOENT' })
      await f.reopen()
      expect(await runInstalledJobRuntimeQualification({ ...f.input, configuration: null })).toEqual(result)
      expect(f.input.registry.snapshot().launches.map(launch => launch.launchId)).toEqual(before)
      expect((await f.input.journal.qualificationStatus(f.input.admission.operationId))!.admission.leaseId)
        .toBe(f.input.admission.leaseId)
    } finally { await f.close() }
  }, 30_000)

  it('recovers a killed qualification owner using its persisted original launch and quota claim', async () => {
    const child = fork(fileURLToPath(new URL('./fixtures/jobQualificationFaultProcess.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let diagnostics = ''
    child.stdout!.resume()
    child.stderr!.on('data', (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString()}`.slice(-8192) })
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    const ready = new Promise<CrashedQualification>((resolve, reject) => {
      child.once('error', reject)
      child.once('message', message => resolve(message as CrashedQualification))
      child.once('exit', () => reject(new Error(`Qualification fixture exited before handoff: ${diagnostics}`)))
    })
    let saved: CrashedQualification | undefined
    let journal: RemoteOperationJournal | undefined
    let registry: NativeProcessRegistry | undefined
    let scenarioFailure: { error: unknown } | undefined
    const cleanupFailures: unknown[] = []
    try {
      saved = await ready
      expect(saved.identities.every(identityAlive)).toBe(true)
      child.kill('SIGKILL')
      expect(await exited).toEqual({ code: null, signal: 'SIGKILL' })
      registry = new NativeProcessRegistry(saved.registryPath)
      const launches = registry.snapshot().launches.map(launch => launch.launchId)
      expect(launches).toHaveLength(1)
      journal = await RemoteOperationJournal.open(saved.journalPath)
      const admission = saved.admission
      await recoverInstalledJobRuntimeQualifications({ journal, registry, host: {
        hostRef: admission.hostRef, registration: admission.registration,
        mainInstallationId: admission.mainInstallationId, bootId: admission.bootId,
      } })
      expect(saved.identities.map(identityAlive)).toEqual([false, false])
      expect(registry.snapshot().launches.map(launch => launch.launchId)).toEqual(launches)
      expect(registry.snapshot().launches.every(launch => launch.lifecycle === 'closed')).toBe(true)
      const receipt = await journal.qualificationStatus(admission.operationId)
      expect(receipt).toMatchObject({ phase: 'closed', admission, quotaClaims: [],
        result: { outcome: 'denied', closure: 'confirmed' } })
      await expect(stat(saved.claim.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(saved.claim.namespace)).rejects.toMatchObject({ code: 'ENOENT' })
      await recoverInstalledJobRuntimeQualifications({ journal, registry, host: {
        hostRef: admission.hostRef, registration: admission.registration,
        mainInstallationId: admission.mainInstallationId, bootId: admission.bootId,
      } })
      expect((await journal.qualificationStatus(admission.operationId))!.admission.leaseId).toBe(admission.leaseId)
      expect(registry.snapshot().launches.map(launch => launch.launchId)).toEqual(launches)
    } catch (error) {
      scenarioFailure = { error }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
      if (saved) {
        try {
          registry ??= new NativeProcessRegistry(saved.registryPath)
          const closed = await registry.closeOwner(saved.owner)
          await journal?.close()
          if (closed) await rm(saved.directory, { recursive: true, force: true })
          else cleanupFailures.push(new Error('Crashed fixture cleanup remains unconfirmed.'))
        } catch (error) {
          cleanupFailures.push(error)
        }
      }
    }
    if (cleanupFailures.length) {
      if (scenarioFailure) cleanupFailures.unshift(scenarioFailure.error)
      throw new AggregateError(cleanupFailures, 'Crashed qualification fixture cleanup failed.',
        { cause: scenarioFailure?.error })
    }
    if (scenarioFailure) throw scenarioFailure.error
  }, 45_000)
})
