import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { publishCommit } from '../src/modules/sources/githubPublisher.js'
import { snapshotAgentWorktree, importAgentSnapshot } from '../src/modules/sources/agentSnapshot.js'
import { captureGitSource } from '../src/modules/sources/capture.js'
import { createSourceManifest } from '../src/modules/sources/manifest.js'
import { ensureCommit, systemGitWorktreePorts, type GitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { describe, expect, it, vi } from 'vitest'
import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import { ciPreparationFixture as fixture, qualifiedPreparationProfile, preparationProfile, builder, oldImage, newImage, commit, newPin,
  otherWorkspaceImage, mainId }
  from './helpers/ciPreparationFixture.js'

describe('build computer CI runtime preparation over the authenticated MCP endpoint', () => {
  it('persists exponentially capped failure backoff and resets it for a different commit', async () => {
    const f = await fixture({ prepareFails: true })
    try {
      const delays = [120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]
      for (let attempt = 1; attempt <= 7; attempt++) {
        const started = await f.call('build_computer_prepare', { workspaceId: f.workspaceId,
          profileId: 'p-unit', commit, commandId: `failed-prepare-${attempt}` })
        expect(started.isError).not.toBe(true)
        const status = await f.settle('p-unit')
        expect(status).toMatchObject({ state: 'failed', failureCount: attempt })
        const delay = Date.parse(status.retryAt!) - Date.parse(status.updatedAt!)
        expect(delay).toBeLessThanOrEqual(delays[attempt - 1]!)
        expect(delay).toBeGreaterThan(delays[attempt - 1]! - 5000)
        const read = await f.call('build_computer_prepare_get', { workspaceId: f.workspaceId,
          profileId: 'p-unit' }, 'reader')
        expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toEqual(status)
      }
      await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-unit',
        commit: 'd'.repeat(40), commandId: 'different-commit' })
      expect(await f.settle('p-unit')).toMatchObject({ state: 'failed', failureCount: 1 })
    } finally { await f.app.close() }
  })
  it('prepares Main as its own build computer, restarting Main around its runtime refresh', async () => {
    const f = await fixture({ main: 'installed' })
    try {
      const input = { workspaceId: f.workspaceId, profileId: 'p-main', commandId: 'prepare-main' }
      expect((await f.call('build_computer_prepare', input, 'reader')).isError).toBe(true)
      expect(f.calls.prepare).toEqual([])
      const started = await f.call('build_computer_prepare', input)
      expect(started.isError).not.toBe(true)
      expect(await f.settle('p-main')).toMatchObject({ state: 'qualified', commit, deviceId: mainId,
        profiles: [{ profileId: 'p-main', status: 'qualified' }] })
      expect(f.calls.prepare).toEqual([expect.objectContaining({ installer: join(f.stateDirectories.main, 'installer'), keepImages: [oldImage] })])
      expect(f.calls.bind).toEqual([expect.objectContaining({ source: newPin,
        selection: expect.objectContaining({ hostRef: { kind: 'main', mainId } }) })])
      expect(f.calls.saves.map(value => [value.id, value.spec.policy.imageDigest])).toEqual([['p-main', newImage]])
      expect(f.calls.refresh).toEqual([expect.objectContaining({ stateDirectory: f.stateDirectories.main })])
      const read = await f.call('build_computer_prepare_get', { workspaceId: f.workspaceId, profileId: 'p-main' }, 'reader')
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toMatchObject({ state: 'qualified', deviceId: mainId })
    } finally { await f.app.close() }
  })

  it.each(['p-unit', 'p-main'] as const)(
    'reads completed refresh after the %s runtime restarts with persisted preparation', async profileId => {
      const f = await fixture({ main: 'installed' })
      try {
        const input = { workspaceId: f.workspaceId, profileId, commit, commandId: 'persisted-refresh' }
        expect((await f.call('build_computer_prepare', input, 'reader')).isError).toBe(true)
        expect((await f.call('build_computer_prepare', input)).isError).not.toBe(true)
        const done = await f.settle(profileId)
        expect(done).toMatchObject({ state: 'qualified', commit, message: null })
        const read = await f.call('build_computer_prepare_get', { workspaceId: f.workspaceId, profileId }, 'reader')
        expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toEqual(done)
        const runtime = profileId === 'p-main'
          ? await f.main!()!.handle({ operation: 'status' })
          : await f.workerState()
        expect(runtime).toMatchObject({ state: 'idle', commit, stage: 'refresh', prepared: null })
        expect(f.calls.prepare).toHaveLength(1)
        expect(f.calls.refresh).toHaveLength(1)
      } finally { await f.app.close() }
    })

  it('reports that Main without an installed CI runtime cannot be prepared', async () => {
    const f = await fixture({ main: 'absent' })
    try {
      const result = await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-main',
        commandId: 'prepare-main-absent' })
      expect(result.isError).toBe(true)
      expect(result.content?.[0]?.text).toContain('BUILD_COMPUTER_PREPARE_UNSUPPORTED')
      expect(f.calls.prepare).toEqual([])
    } finally { await f.app.close() }
  })

  it('reuses a valid qualification for new source while preserving its saved facts', async () => {
    const f = await fixture({ reusedImage: true })
    try {
      const original = structuredClone(f.profiles.get('p-unit')!)
      const input = { workspaceId: f.workspaceId, profileId: original.id, commit, commandId: 'reuse-runtime' }
      expect((await f.call('build_computer_prepare', input, 'reader')).isError).toBe(true)
      expect(f.calls.prepare).toEqual([])
      expect((await f.call('build_computer_prepare', input)).isError).not.toBe(true)
      expect(await f.settle(original.id)).toMatchObject({ state: 'qualified', commit,
        reuse: { image: true, qualification: true, qualificationSourceCommit: original.sourceCommit } })
      expect(f.profiles.get(original.id)).toEqual(original)
      expect(f.calls.bind).toEqual([])
      expect(f.calls.saves).toEqual([])
      expect(f.calls.refresh).toEqual([])
      expect(f.calls.qualified).toEqual([])
      const read = await f.call('build_computer_prepare_get', { workspaceId: f.workspaceId,
        profileId: original.id }, 'reader')
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read)).reuse?.qualification).toBe(true)
    } finally { await f.app.close() }
  })

  it('requalifies a reused image when the machine qualification is stale', async () => {
    const f = await fixture({ reusedImage: true, staleQualification: true })
    try {
      await f.call('build_computer_prepare', { workspaceId: f.workspaceId,
        profileId: 'p-unit', commit, commandId: 'refresh-stale-qualification' })
      expect(await f.settle('p-unit')).toMatchObject({ state: 'qualified',
        reuse: { image: true, qualification: false, qualificationSourceCommit: null } })
      expect(f.calls.refresh).toHaveLength(1)
      expect(f.calls.qualified).toContain('p-unit')
    } finally { await f.app.close() }
  })

  it('automatically prepares integration profiles and retains the longer suite budget through MCP readback', async () => {
    const f = await fixture()
    try {
      const base = f.profiles.get('p-unit')!
      const profile = preparationProfile('p-integration', 'Builder integration', builder,
        base.root.binding.rootId, ['integration'])
      profile.spec.policy.executionTimeoutMs = 9_000_000
      f.profiles.set(profile.id, profile)
      const start = await f.call('build_computer_prepare', { workspaceId: f.workspaceId,
        profileId: profile.id, commandId: 'prepare-integration' })
      expect(start.isError).not.toBe(true)
      expect(await f.settle(profile.id)).toMatchObject({ state: 'qualified', commit })
      const saved = f.profiles.get(profile.id)!
      expect(saved.spec.suites).toEqual(['integration'])
      expect(saved.spec.policy.executionTimeoutMs).toBe(9_000_000)
      expect(saved.measurement?.suites.map(value => value.suite)).toEqual(['integration'])
      expect(f.calls.qualified).toContain(profile.id)
      const read = await f.call('build_computer_prepare_get', { workspaceId: f.workspaceId,
        profileId: profile.id }, 'reader')
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read)).profiles).toContainEqual({
        profileId: profile.id, revision: 4, status: 'qualified',
      })
    } finally { await f.app.close() }
  })

  it('reports draining through MCP and delays qualification until the Worker finishes its active work', async () => {
    let finish!: () => void
    const refreshGate = new Promise<void>(resolve => { finish = resolve })
    const f = await fixture({ refreshGate })
    try {
      const started = await f.call('build_computer_prepare', {
        workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'prepare-drain',
      })
      expect(started.isError).not.toBe(true)
      await vi.waitFor(() => expect(f.calls.refresh).toHaveLength(1))
      expect(await f.workerState()).toMatchObject({ state: 'refreshing', stage: 'draining', commit })
      const status = await f.call('build_computer_prepare_get', { workspaceId: f.workspaceId, profileId: 'p-unit' })
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(status)).state).toBe('refreshing')
      expect(f.calls.qualified).toEqual([])
      finish()
      expect(await f.settle('p-unit')).toMatchObject({ state: 'qualified', commit })
      expect(f.profiles.get('p-unit')).toMatchObject({ revision: 4, status: 'qualified', sourceCommit: commit })
    } finally { finish(); await f.app.close() }
  })

  it('prepares the computer, moves its profiles to the new image and root, refreshes it and requalifies them', async () => {
    const f = await fixture()
    try {
      const started = await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'prepare-1' })
      expect(started.isError).not.toBe(true)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(started)))
        .toMatchObject({ deviceId: builder, state: 'approving' })
      const done = await f.settle('p-install')
      expect(done).toMatchObject({ state: 'qualified', commit, deviceId: builder, message: null })
      expect(done.profiles.map(value => [value.profileId, value.status]).sort()).toEqual([['p-install', 'qualified'], ['p-unit', 'qualified']])
      // The computer keeps the images its profiles in every workspace and the qualification source its current runtime use.
      expect(f.calls.prepare).toEqual([{ repository: f.clone, commit, installer: '/ci/managed/installer',
        keepImages: [oldImage, otherWorkspaceImage],
        keepPaths: ['/ci/managed/installer/qualification-source-aaaaaaaaaaaa'] }])
      expect(f.calls.bind).toEqual([expect.objectContaining({ source: newPin, expectedBindingRevision: 1, accessMode: 'exclusive-write' })])
      expect(f.calls.saves.map(value => [value.id, value.spec.bindingRevision, value.spec.policy.imageDigest]).sort())
        .toEqual([['p-install', 2, newImage], ['p-unit', 2, newImage]])
      expect(f.calls.refresh).toEqual([expect.objectContaining({ stateDirectory: f.stateDirectories.worker, root: expect.objectContaining({ source: newPin }),
        resources: expect.objectContaining({ limits: expect.objectContaining({ cpuLimit: 4 }) }) })])
      expect(f.calls.qualified.sort()).toEqual(['p-install', 'p-unit'])
      // Readback: Laptop's profile was not touched; Builder's carry the commit.
      expect(f.profiles.get('p-laptop')).toMatchObject({ revision: 3, spec: { policy: { imageDigest: oldImage } } })
      expect(f.profiles.get('p-small')).toMatchObject({ revision: 3, spec: { policy: { imageDigest: oldImage } } })
      expect(f.profiles.get('p-unit')).toMatchObject({ revision: 4, status: 'qualified', sourceCommit: commit })
      expect(f.audits).toContainEqual({ principalId: f.operator.id, action: 'build_computer_prepare', outcome: 'succeeded' })
    } finally { await f.app.close() }
  })

  it('reports the computer\'s failure and leaves its profiles unchanged', async () => {
    const f = await fixture({ prepareFails: true })
    try {
      await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'prepare-2' })
      const done = await f.settle('p-unit')
      expect(done).toMatchObject({ state: 'failed', commit })
      expect(done.message).toContain('no space left on device')
      expect(f.calls.saves).toEqual([])
      expect(f.calls.refresh).toEqual([])
    } finally { await f.app.close() }
  })

  it('refuses a caller without the workspace grants and records the denial', async () => {
    const f = await fixture()
    try {
      const denied = await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'prepare-3' }, 'readonly')
      expect(denied.isError).toBe(true)
      expect(f.calls.prepare).toEqual([])
      expect(f.audits).toContainEqual({ principalId: f.readonly.id, action: 'build_computer_prepare', outcome: 'denied' })
    } finally { await f.app.close() }
  })

  it('lets a reader follow preparation and retained profiles while denying a repeat start', async () => {
    const f = await fixture()
    try {
      await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'prepare-readback' })
      await f.settle('p-unit')
      const retained = structuredClone(f.profiles.get('p-unit'))
      const read = await f.call('build_computer_prepare_get', {
        workspaceId: f.workspaceId, profileId: 'p-unit',
      }, 'reader')
      expect(read.isError).not.toBe(true)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toMatchObject({
        state: 'qualified', commit, profiles: expect.arrayContaining([
          { profileId: 'p-unit', revision: 4, status: 'qualified' },
        ]),
      })
      const preparedCount = f.calls.prepare.length
      const denied = await f.call('build_computer_prepare', {
        workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'reader-repeat',
      }, 'reader')
      expect(denied.isError).toBe(true)
      expect(f.calls.prepare).toHaveLength(preparedCount)
      expect(f.profiles.get('p-unit')).toEqual(retained)
    } finally { await f.app.close() }
  })

})

describe('runtime preparation ownership and recovery', () => {
  it('prepares an earlier commit again after another commit replaced its runtime', async () => {
    const f = await fixture()
    const newerCommit = 'd'.repeat(40)
    try {
      for (const requestedCommit of [commit, newerCommit, commit]) {
        await f.ciRuntime.prepareForCommit(f.operator, f.workspaceId, 'unit', requestedCommit)
        expect(await f.settle('p-unit')).toMatchObject({ state: 'qualified', commit: requestedCommit })
      }
      expect(f.calls.prepare).toEqual([commit, newerCommit, commit].map(requestedCommit =>
        expect.objectContaining({ commit: requestedCommit })))
      expect(f.calls.refresh).toHaveLength(3)
      expect(f.memory.records.size).toBe(3)
      await f.ciRuntime.prepareForCommit(f.operator, f.workspaceId, 'unit', commit)
      expect(f.calls.prepare).toHaveLength(3)
    } finally { await f.ciRuntime.close(); await f.app.close() }
  })

  it('leaves computers with disabled build participation untouched', async () => {
    const f = await fixture({ disabled: true })
    try {
      await f.ciRuntime.prepareForCommit(f.operator, f.workspaceId, 'unit', commit)
      expect(f.calls.prepare).toEqual([])
      expect(f.memory.records.size).toBe(0)
      const denied = await f.call('build_computer_prepare', {
        workspaceId: f.workspaceId, profileId: 'p-unit', commit, commandId: 'disabled' })
      expect(denied.isError).toBe(true)
      expect(f.calls.saves).toEqual([])
      expect(f.calls.refresh).toEqual([])
    } finally { await f.ciRuntime.close(); await f.app.close() }
  })

  it('reports busy for a newer commit and accepts the same command once the owner finishes', async () => {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const f = await fixture({ pause: stage => stage === 'source' ? paused : Promise.resolve() })
    try {
      await f.ciRuntime.start(f.operator, 'mcp', { workspaceId: f.workspaceId,
        profileId: 'p-unit', commit, commandId: 'first' })
      const next = { workspaceId: f.workspaceId, profileId: 'p-unit', commit: 'd'.repeat(40), commandId: 'next' }
      await expect(f.ciRuntime.start(f.operator, 'mcp', next)).rejects.toMatchObject({ code: 'CI_RUNTIME_BUSY' })
      release()
      expect((await f.settle('p-unit')).state).toBe('qualified')
      expect((await f.ciRuntime.start(f.operator, 'mcp', next)).commit).toBe(next.commit)
      expect((await f.settle('p-unit')).commit).toBe(next.commit)
      expect(f.calls.prepare).toHaveLength(2)
    } finally { release(); await f.ciRuntime.close(); await f.app.close() }
  })

  it('allows only one workspace to own preparation on a physical computer, even at the same commit', async () => {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const f = await fixture({ pause: stage => stage === 'source' ? paused : Promise.resolve() })
    const other = f.createProvisioner()
    try {
      const foreign = structuredClone(f.profiles.get('p-unit')!)
      foreign.id = 'p-other'
      foreign.workspaceId = 'another-workspace'
      foreign.root.binding.workspaceId = 'another-workspace'
      f.profiles.set(foreign.id, qualifiedPreparationProfile(foreign))
      await f.ciRuntime.start(f.operator, 'mcp', { workspaceId: f.workspaceId,
        profileId: 'p-unit', commit, commandId: 'workspace-first' })
      const principal = { ...f.operator, grants: f.operator.grants.map(grant => ({ ...grant, scope: {} })) }
      f.principals.set(principal.id, principal)
      await expect(other.start(principal, 'mcp', { workspaceId: 'another-workspace',
        profileId: 'p-other', commit, commandId: 'workspace-second' })).rejects.toMatchObject({ code: 'CI_RUNTIME_BUSY' })
      await other.recover()
      release()
      expect((await f.settle('p-unit')).state).toBe('qualified')
      expect(f.calls.refresh).toHaveLength(1)
      expect(f.memory.records.size).toBe(1)
      expect(await other.get(principal, { workspaceId: 'another-workspace', profileId: 'p-other' }))
        .toMatchObject({ state: 'idle' })
    } finally { release(); await other.close(); await f.ciRuntime.close(); await f.app.close() }
  })

  it.each(['source', 'root', 'profile', 'refresh', 'capture', 'qualify'] as const)(
    'recovers after Main stops following the committed %s command', async stage => {
      let reached!: () => void
      const atStage = new Promise<void>(resolve => { reached = resolve })
      let release!: () => void
      const paused = new Promise<void>(resolve => { release = resolve })
      let stopped = false
      const f = await fixture({ pause: async current => {
        if (current === stage && !stopped) { reached(); await paused }
      } })
      let recovered: ReturnType<typeof f.createProvisioner> | undefined
      try {
        const input = { workspaceId: f.workspaceId, profileId: 'p-unit', commit, commandId: `restart-${stage}` }
        await f.ciRuntime.start(f.operator, 'mcp', input)
        await atStage
        stopped = true
        const closing = f.ciRuntime.close()
        release()
        await closing
        recovered = f.createProvisioner()
        expect((await recovered.get(f.operator, { workspaceId: f.workspaceId, profileId: 'p-unit' })).state)
          .not.toBe('idle')
        await recovered.recover()
        const done = await f.settle('p-unit', recovered)
        expect(done).toMatchObject({ state: 'qualified', commit })
        expect(await recovered.start(f.operator, 'mcp', input)).toEqual(done)
        expect(f.calls.prepare).toHaveLength(1)
        expect(f.calls.refresh).toHaveLength(1)
        expect(f.calls.saves).toHaveLength(2)
        expect(f.calls.qualified.sort()).toEqual(['p-install', 'p-unit'])
        expect(f.memory.records.size).toBe(1)
      } finally { release(); await recovered?.close(); await f.ciRuntime.close(); await f.app.close() }
    })

  it.each([{ statusDrops: 1 }, { loseRefreshAck: true }])('reconciles a temporary channel failure: %j', async options => {
    const f = await fixture(options)
    try {
      await f.ciRuntime.start(f.operator, 'mcp', { workspaceId: f.workspaceId,
        profileId: 'p-unit', commit, commandId: 'disconnect' })
      expect(await f.settle('p-unit')).toMatchObject({ state: 'qualified', commit })
      expect(f.calls.prepare).toHaveLength(1)
      expect(f.calls.refresh).toHaveLength(1)
    } finally { await f.ciRuntime.close(); await f.app.close() }
  })

  it('does not gain missing preparation grants when the stored Operator grants are broader', async () => {
    const f = await fixture()
    try {
      const caller = { ...f.operator, grants: f.operator.grants.map(grant => ({ ...grant,
        actions: grant.actions.filter(action => action !== 'job_artifacts:read') })) }
      await expect(f.ciRuntime.start(caller, 'mcp', { workspaceId: f.workspaceId,
        profileId: 'p-unit', commit, commandId: 'limited' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      expect(f.calls.prepare).toEqual([])
      expect(f.memory.records.size).toBe(0)
    } finally { await f.ciRuntime.close(); await f.app.close() }
  })
})

it('cancels pending computer Git acquisition when the preparation fixture closes', async () => {
  const manifest = createSourceManifest({
    version: 1,
    approvedSourceId: randomUUID(),
    snapshotId: randomUUID(),
    capturePolicy: 'git-tree-v1',
    executablePolicy: 'preserve-approved',
    git: { commit, tree: 'f'.repeat(40), objectFormat: 'sha1' },
    entries: [],
    deletions: [],
  })
  let gitSignal: AbortSignal | undefined
  let releaseGit!: () => void
  const pendingGit = new Promise<void>(resolve => { releaseGit = resolve })
  const directory = await privateFixtureDirectory('ci-cancellation-')
  const f = await fixture({ source: { manifest, git: {
    cloneDirectory: () => join(directory, 'clone'),
    git: async (_args, { signal }) => {
      gitSignal = signal
      signal.addEventListener('abort', releaseGit, { once: true })
      try {
        await pendingGit
        return { code: 128, stdout: '', stderr: 'Git acquisition cancelled' }
      } finally {
        signal.removeEventListener('abort', releaseGit)
      }
    },
  } } })
  let closing: Promise<void> | undefined
  try {
    const input = { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'close-pending-git' }
    expect((await f.call('build_computer_prepare', input, 'reader')).isError).toBe(true)
    expect(gitSignal).toBeUndefined()
    expect((await f.call('build_computer_prepare', input)).isError).not.toBe(true)
    await vi.waitFor(() => expect(gitSignal).toBeDefined())
    closing = f.app.close()
    await vi.waitFor(() => expect(gitSignal?.aborted).toBe(true))
    await closing
    expect(f.calls.prepare).toEqual([])
    expect(f.calls.refresh).toEqual([])
  } finally {
    releaseGit()
    await (closing ?? f.app.close())
    await rm(directory, { recursive: true, force: true })
  }
})

it.each([
  ['fatal: could not read Username for https://github.com', 'COMPUTER_GITHUB_REQUIRED', 'Sign in to GitHub'],
  ["fatal: could not read Username for 'https://github.com': No such device or address",
    'COMPUTER_GITHUB_REQUIRED', 'Sign in to GitHub'],
  ["fatal: could not read Password for 'https://example@github.com': No such device or address",
    'COMPUTER_GITHUB_REQUIRED', 'Sign in to GitHub'],
  ["fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    'COMPUTER_GITHUB_REQUIRED', 'Sign in to GitHub'],
  ['fatal: Could not resolve host: github.com', 'SOURCE_GITHUB_UNAVAILABLE', 'DNS lookup failed'],
  ['fatal: Recv failure: Connection reset by peer', 'SOURCE_GITHUB_UNAVAILABLE', 'connection failed'],
  ['fatal: The requested URL returned error: 503', 'SOURCE_GITHUB_UNAVAILABLE', 'temporarily unavailable'],
] as const)('classifies Git acquisition failure without exposing stderr: %s', async (stderr, code, message) => {
  const directory = await privateFixtureDirectory('ci-git-failure-')
  try {
    const ports: GitWorktreePorts = {
      cloneDirectory: () => join(directory, 'clone'),
      git: async () => ({ code: 128, stdout: '', stderr: `${stderr}\ncredential-helper-secret` }),
    }
    const failure = await ensureCommit(ports, 'example/project', commit, new AbortController().signal)
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code, message: expect.stringContaining(message) })
    expect((failure as Error).message).not.toContain('credential-helper-secret')
    if (code === 'SOURCE_GITHUB_UNAVAILABLE') {
      expect(failure).toMatchObject({ details: { retryable: true, newCommandRequired: false } })
      expect((failure as Error).message).not.toContain('Sign in')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['unpublished Agent commit', 'published commit', 'computer without GitHub', 'Main without push access'] as const)(
  'prepares a build computer from GitHub only, through authenticated MCP: %s', async scenario => {
    const directory = await privateFixtureDirectory('ci-github-')
    let f: Awaited<ReturnType<typeof fixture>> | undefined
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args,
      { cwd, encoding: 'utf8', env: gitFixtureEnvironment() }).trim()
    try {
      // `origin` stands in for GitHub; `main` is Main's clone of it.
      const origin = join(directory, 'origin')
      await mkdir(origin, { mode: 0o700 })
      git(origin, 'init', '-q', '-b', 'main')
      await writeFile(join(origin, 'pnpm-lock.yaml'), 'published lockfile\n')
      git(origin, 'add', '.')
      git(origin, 'commit', '-qm', 'published')
      const main = join(directory, 'main')
      await mkdir(main, { mode: 0o700 })
      git(directory, 'clone', '-q', origin, main)
      await chmod(join(main, '.git'), 0o700)
      const agent = join(directory, 'agent')
      await mkdir(agent, { mode: 0o700 })
      git(directory, 'clone', '-q', origin, agent)
      await chmod(join(agent, '.git'), 0o700)
      await writeFile(join(agent, 'pnpm-lock.yaml'), 'agent lockfile\n')
      const system = systemGitWorktreePorts(gitFixtureEnvironment())
      const signal = AbortSignal.timeout(30_000)
      const snapshot = await snapshotAgentWorktree(system, { path: agent, baseCommit: git(origin, 'rev-parse', 'HEAD') }, signal)
      await importAgentSnapshot(system, main, snapshot, signal)
      const acceptedCommit = snapshot.commit
      if (scenario === 'published commit') git(main, 'push', '-q', 'origin', `${acceptedCommit}:refs/heads/published`)
      const acceptedManifest = await captureGitSource({ root: main, commit: acceptedCommit, approvedSourceId: randomUUID(),
        executablePolicy: 'preserve-approved', repository: 'octo/site',
        sink: { write: async () => {}, writeGitMetadata: async () => {}, commit: async () => {}, abort: async () => {} } })
      const refused = { code: 128, stdout: '', stderr: 'fatal: could not read Username for https://github.com' }
      const mainGit: GitWorktreePorts = { cloneDirectory: () => main, git: (args, options) =>
        scenario === 'Main without push access' && args[0] === 'push' ? Promise.resolve(refused) : system.git(args, options) }
      const workerGit: GitWorktreePorts = { cloneDirectory: () => join(directory, 'worker-clone'), git: (args, options) =>
        scenario === 'computer without GitHub' && ['rev-parse', 'clone', 'fetch'].includes(args[0]!) ? Promise.resolve(refused)
          : system.git(args[0] === 'clone' ? ['clone', '--no-checkout', origin, args.at(-1)!] : args, options) }
      f = await fixture({ source: { manifest: acceptedManifest, git: workerGit },
        publish: (repository, commit) => publishCommit(mainGit, repository, commit, signal) })
      const originalProfile = structuredClone(f.profiles.get('p-unit'))
      const input = { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'github-runtime' }
      expect((await f.call('build_computer_prepare', input, 'readonly')).isError).toBe(true)
      expect(f.calls.prepare).toEqual([])
      expect((await f.call('build_computer_prepare', input)).isError).not.toBe(true)
      const settled = await f.settle('p-unit')
      expect(f.calls.publish).toEqual([{ repository: 'octo/site', commit: acceptedCommit }])
      if (scenario === 'computer without GitHub') {
        expect(settled).toMatchObject({ state: 'failed', message: expect.stringContaining('Sign in to GitHub on this computer') })
        const read = await f.call('build_computer_prepare_get', { workspaceId: f.workspaceId,
          profileId: 'p-unit' }, 'reader')
        expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toEqual(settled)
        expect(await f.workerState()).toMatchObject({ state: 'failed', commit: acceptedCommit,
          message: expect.stringContaining('Sign in to GitHub on this computer') })
        expect(f.profiles.get('p-unit')).toEqual(originalProfile)
        expect(f.calls.prepare).toEqual([])
        expect(f.calls.bind).toEqual([])
        expect(f.calls.saves).toEqual([])
        expect(f.calls.refresh).toEqual([])
        expect(f.calls.qualified).toEqual([])
        return
      }
      if (scenario === 'Main without push access') {
        expect(settled).toMatchObject({ state: 'failed', message: expect.stringContaining('Connect GitHub with push access on Main') })
        expect(git(origin, 'branch', '--list', 'foreman/*')).toBe('')
        expect(f.calls.prepare).toEqual([])
        return
      }
      expect(settled).toMatchObject({ state: 'qualified', commit: acceptedCommit })
      expect(f.calls.prepare).toHaveLength(1)
      expect(f.profiles.get('p-unit')?.sourceCommit).toBe(acceptedCommit)
      // The computer fetched the commit from GitHub itself.
      expect((await workerGit.git(['show', `${acceptedCommit}:pnpm-lock.yaml`],
        { cwd: workerGit.cloneDirectory('octo/site'), signal })).stdout).toBe('agent lockfile\n')
      expect(git(origin, 'branch', '--list', 'foreman/ci/*').length > 0).toBe(scenario === 'unpublished Agent commit')
    } finally {
      await f?.ciRuntime.close()
      await f?.app.close()
      await rm(directory, { recursive: true, force: true })
    }
}, 30_000)
