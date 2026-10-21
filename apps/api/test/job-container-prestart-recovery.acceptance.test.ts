import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readProtectedRuntimeConfiguration } from '../src/modules/jobs/installedRuntimeHost.js'
import { InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES }
  from '../src/modules/jobs/installedVerificationConfiguration.js'
import { OwnedOCIContainer, type OCIContainerOwnership } from '../src/modules/jobs/executorContainerOwner.js'
import { runCiRuntimeCommand } from '../src/modules/jobs/ciRuntimeCommands.js'
import { bootIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import type { PodmanCommandRunner } from '../src/modules/jobs/executorPodman.js'

describe('installed OCI container pre-start recovery', () => {
  it('removes the original created container without starting it, including repeated recovery', async () => {
    const path = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION
    if (!path) throw new Error('Provide the protected FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION input.')
    const installed = await readProtectedRuntimeConfiguration({ path, ownerUid: process.getuid!() },
      InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES)
    const identity = `foreman-prestart-recovery-${randomUUID()}`
    const labels = { 'io.foreman-code.prestart-test': identity }
    const commands: string[][] = []
    let active = 0
    const runner: Pick<PodmanCommandRunner, 'run'> = {
      async run(argv) {
        commands.push(argv)
        active++
        try {
          const result = await runCiRuntimeCommand('podman', ['--remote=false', ...argv], {
            env: process.env, signal: AbortSignal.timeout(30_000),
          })
          return { exitCode: 0, stdout: result.stdout }
        } catch (error) {
          const failure = error as { code?: unknown; stdout?: string }
          if (typeof failure.code !== 'number') throw error
          return { exitCode: failure.code, stdout: failure.stdout ?? '' }
        } finally {
          active--
        }
      },
    }
    let containerId: string | undefined
    try {
      const created = await runner.run(['create', '--pull=never', '--network=none', '--read-only',
        '--cap-drop=all', '--security-opt=no-new-privileges', '--memory=2g', '--pids-limit=32',
        '--name', identity, '--label', `${Object.keys(labels)[0]}=${identity}`, installed.machine.imageDigest, 'true'])
      expect(created.exitCode).toBe(0)
      containerId = created.stdout.trim()
      expect(containerId).toMatch(/^[a-f0-9]{64}$/)
      const inspected = JSON.parse((await runner.run(['container', 'inspect', containerId])).stdout)
      expect(inspected[0].State).toMatchObject({ Running: false, Pid: 0 })
      expect(['created', 'configured']).toContain(inspected[0].State.Status)
      const ownership: OCIContainerOwnership = {
        scope: { subject: { kind: 'job', executionId: identity, attemptId: identity,
          operationId: identity, bindingHash: 'a'.repeat(64) },
          leaseId: identity, owner: { grantId: identity, epoch: '1' }, observedDeviceId: null,
          observedInstallationId: identity, bootId: bootIdentity() },
        assertCurrent: async () => {}, reserveContainerIntent: async () => {}, bindContainer: async () => {},
        launchHelpers: async () => [], readCertificate: async () => null, publish: async () => {},
        closeHelpers: async () => active === 0,
        confirmUnreleasedClosure: async id => id === containerId && active === 0
          && !commands.some(argv => ['start', 'exec'].includes(argv[0]!)),
      }
      const restore = () => new OwnedOCIContainer({ identity, labels, originalContainerId: containerId! },
        runner, ownership)
      await restore().remove()
      await restore().remove()
      expect((await runner.run(['container', 'exists', containerId])).exitCode).toBe(1)
      expect(commands.some(argv => ['start', 'exec'].includes(argv[0]!))).toBe(false)
    } finally {
      if (containerId) await runner.run(['rm', '--force', '--ignore', containerId])
    }
  }, 120_000)
})
