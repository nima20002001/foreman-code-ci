import { readUntil } from './observableCondition.js'
import Fastify from 'fastify'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import type pg from 'pg'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import type { GitWorktreePorts } from '../../src/modules/sources/gitWorktree.js'
import { BuildComputerPrepareStatusSchema, CI_RUNTIME_NAMESPACE, type CiRuntimeRequest, type PreparedCiRuntime }
  from '@foreman-code/contracts'
import { JobVerificationProfileSchema, type JobVerificationProfile } from '@foreman-code/contracts/job-verification-runtime'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresAccessService } from '../../src/modules/access/postgres.js'
import type { AppInteractionService } from '../../src/modules/interactions/app.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { DomainError } from '../../src/modules/errors.js'
import { DeviceConnectionError } from '../../src/modules/devices/deviceWire.js'
import { registerGraphqlMcp } from '../../src/mcp/unified/transport.js'
import { CiRuntimeProvisioner } from '../../src/modules/jobs/ciRuntimeProvisioner.js'
import { CiRuntimeWorker } from '../../src/modules/jobs/ciRuntimeWorker.js'
import { buildComputerTarget } from '../../src/modules/settings/buildComputers.js'
import { createVerificationProfile } from '../../src/modules/jobs/verificationProfiles.js'
import { jobDigest } from '../../src/modules/jobs/digest.js'
import { ciFixture } from './ciFixture.js'
import { ciPreparationMemory } from './ciPreparationMemory.js'
import { verificationCapacityFixture } from './verificationCapacityFixture.js'

export const mainId = '11111111-1111-4111-8111-111111111111'
export const builder = '22222222-2222-4222-8222-222222222222'
export const laptop = '33333333-3333-4333-8333-333333333333'
export const oldImage = `sha256:${'1'.repeat(64)}`
export const newImage = `sha256:${'2'.repeat(64)}`
/** A verification profile in another workspace still runs this image on Builder. */
export const otherWorkspaceImage = `sha256:${'3'.repeat(64)}`
export const commit = 'c'.repeat(40)
const uuid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`
const oldPin = { approvedSourceId: uuid('a'), snapshotId: uuid('b'), manifestDigest: 'a'.repeat(64) }
export const newPin = { approvedSourceId: uuid('d'), snapshotId: uuid('e'), manifestDigest: 'd'.repeat(64) }
const builderRoot = uuid('4'), laptopRoot = uuid('5'), mainRoot = uuid('6')

/** `deviceId` null is Main itself. */
function root(deviceId: string | null, rootId: string, bindingRevision: number,
  source = oldPin, installationId = mainId) {
  const hostRef = deviceId ? { kind: 'device' as const, mainId: installationId, deviceId }
    : { kind: 'main' as const, mainId: installationId }
  return { version: 1 as const, source, selection: { hostRef,
    rootPolicyId: 'root-policy', rootPolicyRevision: '1', locationRevision: '2' },
    binding: { version: 1 as const, mainId: installationId, deviceId, workerInstallationId: deviceId,
      workspaceId: 'workspace-fixture',
      rootId, bindingRevision, locationRevision: 2, canonicalPath: '/ci/workspaces/project',
      filesystem: { device: '1', inode: '2', mountId: '3' }, accessMode: 'exclusive-write' as const,
      snapshotId: source.snapshotId, manifestDigest: source.manifestDigest },
    ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner',
    registration: deviceId ? { workerInstallationId: deviceId, keyRevision: 1, authorizationRevision: 1 } : null,
    attestationId: 'attestation', attestationDigest: '7'.repeat(64), boundAt: '2026-10-07T00:00:00.000Z' }
}

export function qualifiedPreparationProfile(profile: JobVerificationProfile): JobVerificationProfile {
  const baseline = verificationCapacityFixture('device').measurement!
  const fingerprint = { ...baseline.fingerprint, profileId: profile.id, profileRevision: profile.revision,
    specDigest: profile.specDigest, root: profile.root, hostRef: profile.root.selection.hostRef,
    registration: profile.root.registration, mainInstallationId: profile.root.binding.mainId,
    sourceCommit: profile.sourceCommit!, resources: profile.spec.resources, limits: profile.spec.resources.limits,
    network: profile.spec.policy.network, imageDigest: profile.spec.policy.imageDigest,
    imageConfigDigest: profile.spec.policy.imageDigest, imageManifestDigest: profile.spec.policy.imageDigest,
    toolchainDigest: profile.spec.policy.toolchainDigest, approvalConfig: profile.approvalConfig }
  if (profile.spec.suites.includes('integration')) {
    fingerprint.tools = [...fingerprint.tools, { kind: 'postgresql', executable: '/usr/lib/postgresql/17/bin/postgres',
      version: '17.6', binarySha256: 'a'.repeat(64) }]
    baseline.checks.push({ id: 'postgres-isolation', passed: true, evidenceDigest: 'a'.repeat(64) })
  }
  return JobVerificationProfileSchema.parse({ ...profile, status: 'qualified', measurement: { ...baseline, fingerprint,
    identity: { ...baseline.identity, profileId: profile.id, profileRevision: profile.revision,
      fingerprintDigest: jobDigest(fingerprint), rootId: profile.root.binding.rootId,
      bindingRevision: profile.root.binding.bindingRevision, imageDigest: profile.spec.policy.imageDigest,
      toolchainDigest: profile.spec.policy.toolchainDigest, network: profile.spec.policy.network },
    suites: profile.spec.suites.map(suite => ({ ...baseline.suites[0]!, suite, resources: profile.spec.resources })),
  } })
}

export function preparationProfile(id: string, name: string, deviceId: string | null, rootId: string,
  suites: JobVerificationProfile['spec']['suites'], memoryBytes = 6 * 2 ** 30,
  installationId = mainId): JobVerificationProfile {
  const baseline = verificationCapacityFixture('device')
  const resources = { ...baseline.spec.resources, limits: { ...baseline.spec.resources.limits, cpuLimit: 4, memoryBytes } }
  return qualifiedPreparationProfile(createVerificationProfile({ id, name, workspaceId: 'workspace-fixture', revision: 3,
    sourceCommit: 'a'.repeat(40), root: root(deviceId, rootId, 1, oldPin, installationId),
    previous: null, now: new Date().toISOString(),
    spec: { ...baseline.spec, rootId, bindingRevision: 1, suites, resources,
      policy: { ...baseline.spec.policy, imageDigest: oldImage } } }))
}

type Stage = 'source' | 'root' | 'profile' | 'refresh' | 'capture' | 'qualify'
export async function ciPreparationFixture(options: {
  reusedImage?: boolean; staleQualification?: boolean
  /** A Main verification profile; 'installed' also gives Main its own CI runtime. */
  main?: 'installed' | 'absent'
  mainInstallationId?: string
  prepareFails?: boolean; disabled?: boolean; statusDrops?: number; loseRefreshAck?: boolean
  refreshGate?: Promise<void>
  stateDirectory?: string
  /** Main's publication of the approved commit to GitHub; the computer then fetches it with its own clone. */
  publish?(repository: string, commit: string): Promise<void>
  source?: { manifest: SourceManifest; git: GitWorktreePorts }
  pause?(stage: Stage): Promise<void>
} = {}) {
  const directory = await privateFixtureDirectory('ci-preparation-')
  const stateDirectories = { worker: options.stateDirectory ?? join(directory, 'worker'), main: join(directory, 'main') }
  await mkdir(stateDirectories.worker, { mode: 0o700, recursive: true })
  await mkdir(stateDirectories.main, { mode: 0o700 })
  const data = ciFixture()
  const workspaceId = data.workspaceId
  const installationId = options.mainInstallationId ?? mainId
  const profile = (id: string, name: string, deviceId: string | null, rootId: string,
    suites: JobVerificationProfile['spec']['suites'], memoryBytes = 6 * 2 ** 30) =>
    preparationProfile(id, name, deviceId, rootId, suites, memoryBytes, installationId)
  const fixtureRoot = (deviceId: string | null, rootId: string, revision: number, source = oldPin) =>
    root(deviceId, rootId, revision, source, installationId)
  const profiles = new Map([
    ['p-install', profile('p-install', 'Builder install', builder, builderRoot, ['install'])],
    ['p-unit', profile('p-unit', 'Builder unit', builder, builderRoot, ['install', 'unit'])],
    ['p-laptop', profile('p-laptop', 'Laptop install', laptop, laptopRoot, ['install'])],
    ['p-small', profile('p-small', 'Builder small', builder, builderRoot, ['install'], 2 ** 30)],
    ...options.main ? [['p-main', profile('p-main', 'Main unit', null, mainRoot, ['install', 'unit'])] as const] : [],
  ])
  const calls = { prepare: [] as unknown[], bind: [] as unknown[],
    saves: [] as Array<{ id: string; spec: { bindingRevision: number; policy: { imageDigest: string } } }>,
    refresh: [] as unknown[], qualified: [] as string[], publish: [] as Array<{ repository: string; commit: string }> }
  const memory = ciPreparationMemory()
  const reader: ManagementPrincipal = { ...data.readonly, id: 'runtime-reader', grants: [{
    actions: ['job_definitions:read'], scope: { workspaceIds: [workspaceId] },
  }] }
  const principals = new Map<string, ManagementPrincipal>([
    [data.operator.id, data.operator], [data.readonly.id, data.readonly], [reader.id, reader],
  ])
  let disabled = options.disabled ?? false
  const query = async (text: string, values: unknown[] = []) => {
    if (text.includes('from application_installation')) return { rows: [{ id: installationId }] }
    if (text.includes('from device_registrations')) {
      const deviceId = String(values[0])
      const knownDevice = deviceId === builder || deviceId === laptop
      return { rows: knownDevice && values[1] === installationId ? [{ record: {
        mainId: installationId, deviceId, workerInstallationId: deviceId, publicKeyFingerprint: 'a'.repeat(64),
        keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'],
      } }] : [] }
    }
    if (text.includes('from management_principals')) {
      const principal = principals.get(String(values[0]))
      return { rows: principal ? [{ id: principal.id, name: principal.name, audience: principal.audience,
        grants: principal.grants, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] : [] }
    }
    if (text.includes('from build_computer_preferences')) {
      const profile = [...profiles.values()].find(value => `${installationId}:${value.root.binding.deviceId}` === values[0]
        || value.root.binding.deviceId === null && values[0] === `${installationId}:main`)!
      const target = buildComputerTarget({ hostRef: profile.root.selection.hostRef,
        registration: profile.root.registration, mainInstallationId: installationId })
      return { rows: [{ target, revision: '1', build_enabled: !disabled, build_priority: 100,
        build_allowance_percent: 100 }] }
    }
    if (text.includes('from job_runtime_profiles')) {
      const hostRef = JSON.parse(String(values[0])) as { kind: string; deviceId?: string }
      const images = [...profiles.values()].filter(profile => JSON.stringify(profile.root.selection.hostRef)
        === JSON.stringify(hostRef)).map(profile => profile.spec.policy.imageDigest)
      return { rows: [...images, ...hostRef.deviceId === builder ? [otherWorkspaceImage] : []].map(image => ({ image })) }
    }
    if (text.includes('from workspaces')) return { rows: [{ record: { id: workspaceId, name: 'CI',
      repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' } } }] }
    return { rows: [] }
  }
  const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool
  const commands = { ...data.services.commands, execute: async (input: Parameters<typeof data.services.commands.execute>[0]) =>
    data.services.commands.execute({ ...input, authorize: async () => { await input.authorize?.(pool as never) },
      perform: async () => input.perform(pool as never) }) } as typeof data.services.commands
  const manifest = options.source?.manifest ?? { version: 1 as const, ...newPin, capturePolicy: 'git-tree-v1' as const,
    executablePolicy: 'preserve-approved' as const, git: { commit, tree: 'f'.repeat(40), objectFormat: 'sha1' as const },
    entries: [], deletions: [], totalEntries: 0, totalBytes: 0 }
  const clone = join(directory, 'clone')
  await mkdir(clone, { mode: 0o700 })
  const acceptedCommit = manifest.git!.commit
  const acceptedPin = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest }
  const prepared: PreparedCiRuntime = { commit: acceptedCommit, imageId: newImage, imageManifestDigest: `sha256:${'9'.repeat(64)}`,
    seedReceiptPath: '/ci/installer/context/seed-receipt.json', contextReceiptPath: '/ci/installer/context/context-receipt.json',
    qualificationSource: '/ci/installer/qualification-source', unitCodex: { executable: '/opt/graphql-ci/tools/codex',
      sourceExecutable: '/ci/codex', version: 'codex-cli 1.0.0', binarySha256: '8'.repeat(64) } }
  let refreshRecord: { operationId: string; commit: string; ok: boolean; log: string } | null = null
  const workerPorts = {
    git: options.source?.git ?? { cloneDirectory: () => clone,
      git: async () => ({ code: 0, stdout: '', stderr: '' }) },
    managedRuntimeRoot: async () => '/ci/managed',
    prepare: async (input: { repository: string; commit: string; installer: string; keepImages?: readonly string[];
      keepPaths?: readonly string[]; log?: (stage: string) => void }) => {
      calls.prepare.push({ repository: input.repository, commit: input.commit, installer: input.installer,
        keepImages: input.keepImages, keepPaths: input.keepPaths })
      input.log?.('fetch-packages')
      if (options.prepareFails) throw new Error('podman build failed: no space left on device')
      return { ...prepared, commit: input.commit,
        ...(options.reusedImage ? { imageId: oldImage, reusedImage: true } : {}) }
    },
    refresh: async (input: { operationId: string; prepared: PreparedCiRuntime }) => {
      calls.refresh.push(input)
      await options.refreshGate
      refreshRecord = { operationId: input.operationId, commit: input.prepared.commit, ok: true, log: 'exit=0' }
      return { unit: 'refresh', workerUnit: 'worker.service' }
    },
    lastRefresh: async () => refreshRecord,
    currentRuntimePaths: async () => ['/ci/managed/installer/qualification-source-aaaaaaaaaaaa'],
    now: () => new Date(),
  }
  const workerLifetime = new AbortController()
  let worker = new CiRuntimeWorker(stateDirectories.worker, workerPorts as never, workerLifetime.signal)
  let restartedOperation: string | undefined
  let statusDrops = options.statusDrops ?? 0
  let ackLost = false
  const endpoint = {
    capabilities: (deviceId: string) => deviceId === builder ? [{ namespace: CI_RUNTIME_NAMESPACE, mainCanRequest: true }] : [],
    request: async (_deviceId: string, _namespace: string, raw: unknown) => {
      const payload = raw as CiRuntimeRequest
      if (refreshRecord && restartedOperation !== refreshRecord.operationId) {
        await worker.close()
        restartedOperation = refreshRecord.operationId
        worker = new CiRuntimeWorker(stateDirectories.worker, workerPorts as never, workerLifetime.signal)
      }
      if (payload.operation === 'status' && statusDrops-- > 0) throw new DeviceConnectionError('transport')
      const state = await worker.handle(payload)
      if (payload.operation === 'refresh') {
        await options.pause?.('refresh')
        if (options.loseRefreshAck && !ackLost) { ackLost = true; throw new DeviceConnectionError('transport') }
      }
      return { payload: state }
    },
  }
  const command = async <T>(principal: ManagementPrincipal, operation: string,
    input: { commandId: string; approvalId?: string },
    perform: () => Promise<T>) => (await commands.execute({ principal, source: 'mcp', operation,
      commandId: input.commandId, targetKey: workspaceId, payload: input, perform })).value
  const currentRoots = new Map([
    [builderRoot, fixtureRoot(builder, builderRoot, 1)],
    [laptopRoot, fixtureRoot(laptop, laptopRoot, 1)],
    [mainRoot, fixtureRoot(null, mainRoot, 1)],
  ])
  const sources = {
    approveProject: async (principal: ManagementPrincipal, input: { commandId: string; commit?: string }) => {
      const approved = await command(principal, 'fixture.source', input,
        async () => ({ manifest: { ...manifest, git: { ...manifest.git!, commit: input.commit ?? acceptedCommit } } }))
      await options.pause?.('source')
      return approved
    },
    publish: async (repository: string, commit: string) => {
      calls.publish.push({ repository, commit })
      await options.publish?.(repository, commit)
    },
    rootList: async () => ({ items: [...currentRoots.values()].map(value => structuredClone(value)) }),
    bindRoot: async (principal: ManagementPrincipal, _source: unknown,
      input: { commandId: string; expectedBindingRevision: number; selection: { hostRef: { deviceId?: string } } }) => {
      const result = await command(principal, 'fixture.root', input, async () => {
        calls.bind.push(input)
        const host = input.selection.hostRef.deviceId ?? null, rootId = host ? builderRoot : mainRoot
        const current = currentRoots.get(rootId)!
        if (current.binding.bindingRevision !== input.expectedBindingRevision) throw new DomainError('REVISION_CONFLICT', 'changed', 409)
        const value = fixtureRoot(host, rootId, current.binding.bindingRevision + 1, acceptedPin)
        currentRoots.set(rootId, value)
        return { value }
      })
      await options.pause?.('root')
      return result
    },
  }
  const profileService = {
    list: async (_principal: unknown, scope: string) => ({ profiles: [...profiles.values()]
      .filter(profile => profile.workspaceId === scope).map(profile => ({ profile: structuredClone(profile),
      ready: !options.staleQualification || calls.qualified.includes(profile.id),
      reasons: [], sideEffects: false })), approvals: [] }),
    save: async (principal: ManagementPrincipal, _source: unknown, scope: string,
      input: { id: string; commandId: string; expectedRevision: number; name: string; spec: JobVerificationProfile['spec'] }) => {
      const saved = await command(principal, 'fixture.profile', input, async () => {
        const current = profiles.get(input.id)!
        if (current.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'changed', 409)
        calls.saves.push(input)
        const value = createVerificationProfile({ id: input.id, name: input.name, workspaceId: scope,
          revision: current.revision + 1, sourceCommit: acceptedCommit, root: currentRoots.get(input.spec.rootId)!,
          spec: input.spec, previous: current, now: new Date().toISOString() })
        profiles.set(input.id, value)
        return value
      })
      await options.pause?.('profile')
      return saved
    },
    requestQualification: async (principal: ManagementPrincipal, _source: unknown, _scope: string,
      input: { commandId: string; profileId: string }) => {
      const result = await command(principal, 'fixture.capture', input, async () => ({ id: `approval-${input.profileId}` }))
      await options.pause?.('capture')
      return result
    },
    qualify: async (principal: ManagementPrincipal, _source: unknown, _scope: string, commandId: string, approvalId: string) => {
      const result = await command(principal, 'fixture.qualify', { commandId, approvalId }, async () => {
        const id = approvalId.replace('approval-', '')
        calls.qualified.push(id)
        const value = qualifiedPreparationProfile(profiles.get(id)!)
        profiles.set(id, value)
        return value
      })
      await options.pause?.('qualify')
      return result
    },
  }
  // Main's own CI runtime restarts with Main after its refresh, like a Worker.
  const mainPorts = { ...workerPorts, managedRuntimeRoot: async () => stateDirectories.main }
  let mainRuntime = new CiRuntimeWorker(stateDirectories.main, mainPorts as never, workerLifetime.signal)
  let mainRestartedOperation: string | undefined
  const main = options.main === 'installed' ? () => ({ handle: async (payload: unknown) => {
    if (refreshRecord && mainRestartedOperation !== refreshRecord.operationId) {
      await mainRuntime.close()
      mainRestartedOperation = refreshRecord.operationId
      mainRuntime = new CiRuntimeWorker(stateDirectories.main, mainPorts as never, workerLifetime.signal)
    }
    return mainRuntime.handle(payload)
  } }) : undefined
  const createProvisioner = () => new CiRuntimeProvisioner(pool, profileService as never, sources as never,
    () => endpoint, commands, { ...memory, ...main ? { main } : {}, timing: { pollMs: 0,
      wait: () => new Promise(resolve => setImmediate(resolve)), now: () => new Date() } })
  const ciRuntime = createProvisioner()
  const services = { ...data.services, commands, jobRuntimeProfiles: profileService, ciRuntime } as unknown as OperatorServices
  const app = Fastify()
  app.addHook('onClose', async () => {
    await ciRuntime.close()
    workerLifetime.abort()
    await worker.close()
    await mainRuntime.close()
    await rm(directory, { recursive: true, force: true })
  })
  const access = { authenticate: async (token: string) => {
    const principal = { operator: data.operator, readonly: data.readonly, reader }[token]
    if (!principal) throw new DomainError('AUTH_INVALID', 'Invalid bearer token.', 401)
    return principal
  } } as unknown as PostgresAccessService
  const interactions = { toolAccess: async () => ({ role: 'coder', tools: [] }), canRead: async () => false,
    canRespond: async () => false } as unknown as AppInteractionService
  registerGraphqlMcp(app, { access, operator: services, interactions })
  const url = await app.listen({ port: 0, host: '127.0.0.1' })
  const call = async (name: string, input: unknown, token = 'operator') => {
    const response = await fetch(`${url}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
        'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) })
    const responseBody = await response.text()
    const body = responseBody.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? responseBody
    return JSON.parse(body).result as {
      isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[]
    }
  }
  const settle = async (profileId: string, provisioner = ciRuntime) => {
    return readUntil(async () => BuildComputerPrepareStatusSchema.parse(
      await provisioner.get(data.operator, { workspaceId, profileId })),
    status => ['qualified', 'failed'].includes(status.state),
    { timeoutMs: 5000, description: 'CI preparation to settle' })
  }
  return { ...data, app, call, settle, calls, profiles, sources, profileService, pool, ciRuntime,
    createProvisioner, memory, principals, commands, endpoint, main, stateDirectories, clone, disable: () => { disabled = true },
    workerState: () => worker.handle({ operation: 'status' }) }
}
