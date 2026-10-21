import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OwnedOCIContainer, proveOCIBoundaryEmpty } from '../src/modules/jobs/executorContainerOwner.js'
import { readProtectedRuntimeConfiguration } from '../src/modules/jobs/installedRuntimeHost.js'
import { InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES }
  from '../src/modules/jobs/installedVerificationConfiguration.js'
import { reconcileInstalledJobRuntimeQualification, runInstalledJobRuntimeQualification }
  from '../src/modules/jobs/installedRuntimeQualification.js'
import { runQualificationCommand } from '../src/modules/jobs/qualification.js'
import { runCiRuntimeCommand } from '../src/modules/jobs/ciRuntimeCommands.js'
import { identityAlive, processIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { jobQualificationFaultFixture } from './helpers/jobQualificationFaultFixture.js'
import { physicalFaultEnvironment } from './helpers/physicalFaultEnvironment.js'

describe('installed qualification container faults', () => {
  it.each(['deadline', 'connection-loss'] as const)(
    'recovers the original container after %s without renewed admission when cleanup is also canceled', async fault => {
      const path = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION
      if (!path) throw new Error('Provide FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION.')
      const installed = await readProtectedRuntimeConfiguration({ path, ownerUid: process.getuid!() },
        InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES)
      const environment = physicalFaultEnvironment()
      const f = await jobQualificationFaultFixture(installed.machine.runtimeExecutable, environment)
      const admission = f.input.admission
      const identity = `graphql-ci-qualification-${admission.qualificationId}`
      const labels = { 'graphql.qualification.identity': identity,
        'graphql.qualification.fingerprint': admission.fingerprintDigest }
      const run = (argv: string[], signal = f.lifetime.signal, timeout = 30_000) =>
        runQualificationCommand(f.reserved.native, installed.machine.runtimeExecutable,
          ['--remote=false', ...argv], f.input.candidate.controllerEnvironment, signal, timeout)
      const commands = { run: (argv: string[], timeout = 30_000) => run(argv, f.lifetime.signal, timeout) }
      const container = new OwnedOCIContainer({ identity, labels }, commands, f.reserved.ownership)
      const claim = await f.claimQuota()
      const output = join(f.directory, 'container-output')
      await mkdir(output, { mode: 0o700 })
      try {
        await f.reserved.ownership.reserveContainerIntent(identity, admission.fingerprintDigest)
        const created = await run(['create', '--pull=never', '--network=none', '--read-only', '--cap-drop=all',
          '--security-opt=no-new-privileges', '--memory=256m', '--cpus=1', '--pids-limit=32',
          '--name', identity, ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
          '--volume', `${output}:/fault-output:rw`,
          '--entrypoint=node', installed.machine.imageDigest, '-e',
          'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],'
            + '{detached:true,stdio:"ignore"}).unref();process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'])
        expect(created.exitCode).toBe(0)
        const containerId = created.stdout.trim()
        await container.bind(containerId)
        expect((await run(['start', containerId])).exitCode).toBe(0)
        const certificate = await container.entered()
        await vi.waitFor(async () => {
          const pids = (await readFile(`${certificate.boundary.path}/cgroup.procs`, 'utf8')).trim().split(/\s+/)
          expect(pids.length).toBeGreaterThanOrEqual(2)
        }, { timeout: 5000 })
        const pids = (await readFile(`${certificate.boundary.path}/cgroup.procs`, 'utf8'))
          .trim().split(/\s+/).map(Number)
        const processes = pids.map(pid => processIdentity(pid)).filter(value => value !== undefined)
        expect(processes.length).toBeGreaterThanOrEqual(2)
        const commandSignal = new AbortController()
        const diagnostic = run(['exec', containerId, 'node', '-e',
          'require("node:fs").writeFileSync("/fault-output/diagnostic", "ready");setInterval(()=>{},1000)'],
          commandSignal.signal, 10_000)
        const outcome = diagnostic.then(value => ({ value }), error => ({ error }))
        await vi.waitFor(async () => expect(await readFile(join(output, 'diagnostic'), 'utf8')).toBe('ready'),
          { timeout: 8000, interval: 25 })
        if (fault === 'connection-loss') commandSignal.abort(new Error('Authenticated connection lost'))
        expect(await outcome).toMatchObject({ error: { name: 'QualificationCommandInterruptedError',
          reason: fault === 'deadline' ? 'command_timeout' : 'signal_aborted', stopConfirmed: true } })
        const retained = await f.input.journal.qualificationStatus(admission.operationId)
        expect(retained!.container!.containerId).toBe(containerId)
        expect(retained!.admission.leaseId).toBe(admission.leaseId)
        await f.reopen()
        const result = await reconcileInstalledJobRuntimeQualification({ ...f.input,
          signal: AbortSignal.abort(new Error('Caller cancels cleanup')) })
        expect(result).toMatchObject({ outcome: 'denied', closure: 'confirmed' })
        expect(await proveOCIBoundaryEmpty(certificate.boundary)).toBe(true)
        expect(processes.every(process => !identityAlive(process))).toBe(true)
        const receipt = await f.input.journal.qualificationStatus(admission.operationId)
        expect(receipt).toMatchObject({ phase: 'closed', admission, quotaClaims: [], result })
        expect(receipt!.container!.certificate).toMatchObject({ containerId, lifecycle: 'closed' })
        expect(receipt!.launches.slice(retained!.launches.length).every(launch =>
          !launch.argv.includes('create') && !launch.argv.includes('start') && !launch.argv.includes('exec'))).toBe(true)
        await expect(stat(claim.path)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(claim.namespace)).rejects.toMatchObject({ code: 'ENOENT' })
        const absent = await runCiRuntimeCommand(installed.machine.runtimeExecutable,
          ['--remote=false', 'container', 'exists', containerId], { env: environment })
          .then(() => 0, (error: { code?: unknown }) => error.code)
        expect(absent).toBe(1)
        const launches = receipt!.launches
        await f.reopen()
        expect(await runInstalledJobRuntimeQualification({ ...f.input, configuration: null })).toEqual(result)
        expect((await f.input.journal.qualificationStatus(admission.operationId))!.launches).toEqual(launches)
      } finally {
        await runCiRuntimeCommand(installed.machine.runtimeExecutable,
          ['--remote=false', 'rm', '--force', '--ignore', identity], {
            env: environment, signal: AbortSignal.timeout(30_000),
          })
        await f.close()
      }
    }, 180_000)
})
