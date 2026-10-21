import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { deleteSession, listSessions } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import { HostHarnessOverrideSchema } from '@foreman-code/contracts/harness-registry'
import { claudeQualificationCapabilities } from '@foreman-code/contracts/claude-qualification'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { createClaudeCurrentPinResolver, discoverInstalledClaudeSdk, installedClaudeSdkEntrypoint } from '../src/modules/harnesses/claudeSdk/currentPin.js'
import { qualifyClaudeNativeProfile } from '../src/modules/harnesses/claudeSdk/nativeProfileQualification.js'
import { probeTrustedVersion } from '../src/modules/harnesses/hostDiscovery.js'
import { HarnessInstallationRegistry } from '../src/modules/harnesses/installationRegistry.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { copyTestAuthenticationFile } from '../../../scripts/test-resources.mjs'

it.runIf(process.env.RUN_CLAUDE_PROFILE_NATIVE_TESTS === '1')(
  'qualifies the installed Haiku profile through real native lifecycle and tool-policy scenarios', async () => {
    const evidenceRoot = process.env.ENG03_A_EVIDENCE_DIR
    if (!evidenceRoot) throw new Error('Native qualification requires the root runner evidence directory.')
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(evidenceRoot, 'claude-haiku-'))
    const authentication = process.env.FOREMAN_CODE_TEST_CLAUDE_AUTH_FILE
    if (authentication) copyTestAuthenticationFile({ directory: process.env.FOREMAN_CODE_TEST_ROOT!,
      token: process.env.FOREMAN_CODE_TEST_OWNER! }, authentication,
      join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json'))
    const configuration = ClaudeHarnessConfigurationSchema.parse({
      harness: 'claude', model: 'claude-haiku-4-5-20251001', authMode: 'subscription',
      configDirectory: resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')),
      permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Write'],
      permissionRules: [], instructions: '', mcpServers: {},
    })
    onTestFinished(async () => {
      try {
        for (const child of await readdir(directory, { withFileTypes: true })) {
          if (!child.isDirectory() || !child.name.startsWith('claude-profile-')) continue
          const cwd = join(directory, child.name, 'work')
          // SDK listings include sibling Git worktrees unless explicitly scoped.
          const sessions = await listSessions({ dir: cwd, includeWorktrees: false })
          for (const session of sessions) {
            if (session.cwd !== cwd) throw new Error('Qualification cleanup found another project session.')
            await deleteSession(session.sessionId, { dir: cwd })
          }
          expect(await listSessions({ dir: cwd, includeWorktrees: false })).toEqual([])
          const projects = join(configuration.configDirectory, 'projects')
          const folders = await readdir(projects, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return []
            throw error
          })
          for (const project of folders) {
            if (project.isDirectory() && project.name.includes(basename(directory))) {
              await rm(join(projects, project.name), { recursive: true })
            }
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true })
        await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    })
    const instanceId = randomUUID()
    const hostRef = { kind: 'main' as const, mainId: randomUUID() }
    const environment = { generation: randomUUID(), provenance: 'terminal' as const,
      cwd: directory, path: process.env.PATH ?? '' }
    const sdkEntrypoint = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
    const binary = createRequire(sdkEntrypoint).resolve(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`)
    const context = { hostGeneration: randomUUID(), harnessInstallationId: commandInputHash({ hostRef, binary }),
      environment, instanceRevision: commandInputHash(configuration), profilePath: configuration.configDirectory }
    const signal = AbortSignal.timeout(240_000)
    const sdk = installedClaudeSdkEntrypoint(fileURLToPath(new URL('../../../pnpm-lock.yaml', import.meta.url)), binary)
    const installed = await discoverInstalledClaudeSdk(sdk, context, signal)
    let observedCliVersion: string | undefined
    const currentPin = createClaudeCurrentPinResolver({
      sdk,
      ownedVersionProbe: async input => {
        const probe = await probeTrustedVersion({ launcher: input.launcher, allowlistedLaunchers: [input.launcher],
          environment: process.env, neutralCwd: directory })
        expect(probe.status).toBe('observed')
        expect(probe.exitCode).toBe(0)
        const version = probe.stdout.trim().match(/^(\d+\.\d+\.\d+)(?: \(Claude Code\))?$/)?.[1]
        if (!version) throw new Error('The installed Claude CLI returned no recognized version.')
        observedCliVersion = version
        return { ...input, version, positiveProcessClosure: true }
      },
    })
    const current = await currentPin(context, signal)
    if (current.status !== 'available') throw new Error(current.reason)
    expect(current.pin.sdkVersion).toBe(installed.sdkVersion)
    expect(observedCliVersion).toBeTruthy()
    expect(current.pin.cliVersion).toBe(observedCliVersion)
    const instances = new HarnessInstanceRegistry(localHarnessDrivers)
    instances.reload([{ instanceId, instanceRevision: context.instanceRevision,
      driverId: 'claude', enabled: true, configuration }])
    const installations = new HarnessInstallationRegistry(instances)
    installations.refresh([{ hostRef, harnessInstallationId: context.harnessInstallationId,
      installationFingerprint: current.launcher.fingerprint, launcher: current.launcher,
      driverId: 'claude', driverRevision: '1', protocolRevision: current.declaration.protocolRevision,
      environmentGeneration: environment.generation, connectionGeneration: context.hostGeneration,
      observedVersion: current.pin.cliVersion, installed: true, authenticated: null, compatible: null, qualified: null }])
    const binding = installations.pin({ instanceId, hostRef, harnessInstallationId: context.harnessInstallationId,
      connectionGeneration: context.hostGeneration, environmentGeneration: environment.generation })
    const value = HostHarnessOverrideSchema.parse({ instanceId, instanceRevision: context.instanceRevision, revision: 1,
      target: { hostRef, applicationInstallationId: hostRef.mainId, harnessInstallationId: context.harnessInstallationId,
        installationFingerprint: binding.selection.installationFingerprint },
      presetId: 'native-haiku-qualification', enabled: true, driverId: 'claude', configuration,
      configurationFingerprint: commandInputHash(configuration), qualification: 'unqualified' })
    const processes = new NativeProcessRegistry(join(directory, 'processes'))
    const recovery = await processes.reserveLaunch(`claude-profile-check:${randomUUID()}`)
    try {
      const proof = await qualifyClaudeNativeProfile({ value, checkId: randomUUID(), binding, pin: current.pin,
        directory, recovery, signal, assertCurrent: async () => {
          installations.assertCurrent(binding)
          const refreshed = await currentPin(context, signal)
          expect(refreshed.status).toBe('available')
          if (refreshed.status === 'available') expect(refreshed.pin).toEqual(current.pin)
        } })
      const evidenceId = proof.claudeProof?.checks.sdkInitialization?.evidenceId
      const nativeEvidence = evidenceId ? await readFile(evidenceId, 'utf8') : undefined
      const artifact = join(evidenceRoot, `claude-haiku-qualification-${randomUUID()}.json`)
      await writeFile(artifact, JSON.stringify({ model: configuration.model, proof, nativeEvidence }, null, 2), { mode: 0o600 })
      console.info(`Claude Haiku qualification evidence ${artifact}`)
      expect(proof, JSON.stringify(proof.failure)).toMatchObject({ authenticated: true, compatible: true, qualified: true })
      expect(proof.claudeProof?.pin).toEqual(current.pin)
      expect(proof.claudeProof?.observedTools).toContain('Write')
      expect(claudeQualificationCapabilities(proof.claudeProof!)).toMatchObject({
        basicTurns: true, resume: true, fork: true, history: true, workingDirectory: true,
        policy: { settingsIsolation: true, backgroundTasksDisabled: true, alwaysAppliedToolHook: true, fullAccessPolicy: true },
      })
    } finally {
      await processes.abandonReservedLaunch(recovery)
      expect(await processes.closeOwner(recovery.owner)).toBe(true)
    }
  }, 240_000,
)
