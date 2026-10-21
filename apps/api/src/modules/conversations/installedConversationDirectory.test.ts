import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import { installedConversationDirectory } from './installedConversationDirectory.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { identity, openPrivateRoot } from '../sources/privateFilesystem.js'
import { workerOperatorDirectory } from './workerOperatorDirectory.js'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'

it.each(['codex', 'claude'])('%s uses a read-only approved folder and rejects its replacement or permission change', async harness => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'conversation-root-'))
  const base = join(root, 'base')
  const project = join(base, 'project')
  const runtime = join(root, 'runtime')
  const f = workerConversationFixture('agent')
  if (harness === 'claude') f.configuration.harness = { harness: 'claude', model: 'profile-model',
    authMode: 'subscription', configDirectory: '/selected/profile', permissionMode: 'default',
    sandbox: 'read-only', tools: [], permissionRules: [], instructions: '', mcpServers: {} }
  try {
    await mkdir(project, { recursive: true, mode: 0o700 })
    await mkdir(runtime, { mode: 0o700 })
    const baseHandle = await openPrivateRoot(base)
    const runtimeHandle = await openPrivateRoot(runtime)
    let roots
    try {
      roots = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef: f.binding.profile.target.hostRef,
        applicationInstallationId: f.connection.workerInstallationId, configurationRevision: '1',
        bases: [{ baseId: randomUUID(), canonicalPath: base, filesystem: await identity(baseHandle), accessModes: ['read-only'] }],
        managedRuntimeRoot: runtime, runtimeFilesystem: await identity(runtimeHandle) })
    } finally { await baseHandle.close(); await runtimeHandle.close() }
    const binding = { ...f.binding, workingDirectory: project }
    const directory = await installedConversationDirectory({ binding, configuration: f.configuration,
      approvedRoots: async () => roots })
    await directory.assertCurrent()
    await rename(project, join(base, 'original'))
    await mkdir(project, { mode: 0o700 })
    await expect(directory.assertCurrent()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_ROOT_CHANGED' })
    roots.bases[0]!.accessModes = ['read-write']
    await expect(directory.assertCurrent()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_ROOT_CHANGED' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['operator', 'agent'] as const)('%s checks every additional writable folder before native startup and while it is owned', async role => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'conversation-writable-root-'))
  const f = workerConversationFixture(role)
  const base = join(root, 'projects')
  const project = join(base, 'project')
  const extra = join(base, 'extra')
  const runtime = join(root, 'runtime')
  try {
    await mkdir(project, { recursive: true, mode: 0o700 })
    await mkdir(extra, { mode: 0o700 })
    await mkdir(runtime, { mode: 0o700 })
    const baseHandle = await openPrivateRoot(base)
    const runtimeHandle = await openPrivateRoot(runtime)
    let roots
    try {
      roots = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef: f.binding.profile.target.hostRef,
        applicationInstallationId: f.connection.workerInstallationId, configurationRevision: '1',
        bases: [{ baseId: randomUUID(), canonicalPath: base, filesystem: await identity(baseHandle), accessModes: ['read-write'] }],
        managedRuntimeRoot: runtime, runtimeFilesystem: await identity(runtimeHandle) })
    } finally { await baseHandle.close(); await runtimeHandle.close() }
    if (f.configuration.harness.harness !== 'codex') throw new Error('Codex fixture required')
    const configuration = { ...f.configuration, harness: { ...f.configuration.harness,
      sandbox: 'workspace-write' as const, advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION,
        additionalWritableDirectories: [extra] } } }
    const workingDirectory = f.binding.owner.kind === 'operator'
      ? workerOperatorDirectory(runtime, f.binding.owner) : project
    const binding = { ...f.binding, workingDirectory }
    const directory = await installedConversationDirectory({ binding, configuration, approvedRoots: async () => roots })
    await directory.assertCurrent()
    await expect(installedConversationDirectory({ binding,
      configuration: { ...configuration, harness: { ...configuration.harness,
        advanced: { ...configuration.harness.advanced, additionalWritableDirectories: [root] } } },
      approvedRoots: async () => roots })).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_ROOT_UNAVAILABLE' })
    await rename(extra, `${extra}-original`)
    await mkdir(extra, { mode: 0o700 })
    await expect(directory.assertCurrent()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_ROOT_CHANGED' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('creates a private Operator folder on the approved worker root and keeps other chats separate', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'worker-operator-root-'))
  const f = workerConversationFixture('operator')
  if (f.binding.owner.kind !== 'operator') throw new Error('Operator fixture required')
  const base = join(root, 'projects')
  const runtime = join(root, 'runtime')
  try {
    await mkdir(base, { mode: 0o700 })
    await mkdir(runtime, { mode: 0o700 })
    const baseHandle = await openPrivateRoot(base)
    const runtimeHandle = await openPrivateRoot(runtime)
    let roots
    try {
      roots = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef: f.binding.profile.target.hostRef,
        applicationInstallationId: f.connection.workerInstallationId, configurationRevision: '1',
        bases: [{ baseId: randomUUID(), canonicalPath: base, filesystem: await identity(baseHandle), accessModes: ['read-only'] }],
        managedRuntimeRoot: runtime, runtimeFilesystem: await identity(runtimeHandle) })
    } finally { await baseHandle.close(); await runtimeHandle.close() }
    const directory = workerOperatorDirectory(runtime, f.binding.owner)
    const binding = { ...f.binding, workingDirectory: directory }
    const owner = await installedConversationDirectory({ binding, configuration: f.configuration, approvedRoots: async () => roots })
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    await owner.assertCurrent()
    const otherOwner = { ...f.binding.owner, conversationId: randomUUID() }
    const otherDirectory = workerOperatorDirectory(runtime, otherOwner)
    await installedConversationDirectory({ binding: { ...binding, owner: otherOwner, workingDirectory: otherDirectory },
      configuration: f.configuration, approvedRoots: async () => roots })
    expect((await stat(directory)).ino).not.toBe((await stat(otherDirectory)).ino)
    await expect(installedConversationDirectory({ binding: { ...binding, workingDirectory: base }, configuration: f.configuration,
      approvedRoots: async () => roots })).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_ROOT_UNAVAILABLE' })
    await rename(directory, `${directory}-original`)
    await mkdir(directory, { mode: 0o700 })
    await expect(owner.assertCurrent()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_ROOT_CHANGED' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps historical Agent chat on its saved runtime working tree without opening other runtime folders', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'historical-chat-root-'))
  const f = workerConversationFixture('agent')
  if (f.binding.owner.kind !== 'agent' || f.binding.profile.target.hostRef.kind !== 'device') {
    throw new Error('Worker Agent fixture required')
  }
  const runtime = join(root, 'runtime')
  const base = join(root, 'projects')
  const rootPolicyId = randomUUID()
  const tree = join(runtime, 'source-materializations', rootPolicyId, randomUUID(), 'tree')
  try {
    await mkdir(tree, { recursive: true, mode: 0o700 })
    await mkdir(base, { mode: 0o700 })
    const baseHandle = await openPrivateRoot(base)
    const runtimeHandle = await openPrivateRoot(runtime)
    const treeHandle = await openPrivateRoot(tree)
    let roots
    let filesystem
    try {
      filesystem = await identity(treeHandle)
      roots = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef: f.binding.profile.target.hostRef,
        applicationInstallationId: f.connection.workerInstallationId, configurationRevision: '1',
        bases: [{ baseId: randomUUID(), canonicalPath: base, filesystem: await identity(baseHandle),
          accessModes: ['read-only'] }], managedRuntimeRoot: runtime, runtimeFilesystem: await identity(runtimeHandle) })
    } finally { await treeHandle.close(); await runtimeHandle.close(); await baseHandle.close() }
    const digest = 'a'.repeat(64)
    const placement = { schemaVersion: 1, mainId: f.connection.mainId, runId: 'source-run',
      nodeId: f.binding.owner.workflowNodeId, hostRef: f.binding.profile.target.hostRef,
      registration: { workerInstallationId: f.connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
      mainInstallationId: f.connection.mainId, bindingHash: digest,
      destination: { canonicalProjectRoot: base, canonicalCwd: base, managedRuntimeRoot: runtime,
        directoryIdentityHash: digest, rootPolicyId, rootPolicyRevision: '1', locationRevision: '1',
        attestationId: 'attestation', attestationHash: digest },
      source: { revisionId: 'source-revision', manifestDigest: digest, materializationId: 'materialization',
        materializationDigest: digest },
      payload: { kind: 'agent', agentId: f.binding.owner.agentId,
        agentConfigurationVersionId: f.configuration.id, driverId: 'codex', driverRevision: 'driver',
        instanceId: f.binding.profile.instanceId, instanceRevision: f.binding.profile.instanceRevision,
        harnessInstallationId: f.binding.profile.target.harnessInstallationId,
        installationFingerprint: f.binding.profile.target.installationFingerprint,
        runtimeContractVersion: 1, protocolRevision: 'protocol', credentialScopeRefs: [] } }
    const binding = WorkerConversationBindingSchema.parse({ ...f.binding, workingDirectory: tree,
      sourceExecution: { executionId: 'source-execution', placement, workingTree: {
        materializationId: randomUUID(), materializationDigest: digest, canonicalProjectRoot: tree,
        canonicalCwd: tree, directoryIdentityHash: digest, filesystem, accessMode: 'read-only', privateGit: null,
      } } })
    const input = { binding, configuration: f.configuration, approvedRoots: async () => roots }
    const directory = await installedConversationDirectory(input)
    await directory.assertCurrent()
    const withoutSource = structuredClone(binding)
    delete withoutSource.sourceExecution
    await expect(installedConversationDirectory({ ...input, binding: withoutSource }))
      .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_ROOT_UNAVAILABLE' })
    const wrongNamespace = structuredClone(binding)
    wrongNamespace.sourceExecution!.placement.destination.rootPolicyId = randomUUID()
    await expect(installedConversationDirectory({ ...input, binding: wrongNamespace }))
      .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_ROOT_UNAVAILABLE' })
    const writable = structuredClone(f.configuration)
    if (writable.harness.harness !== 'codex') throw new Error('Codex fixture required')
    writable.harness.sandbox = 'workspace-write'
    await expect(installedConversationDirectory({ ...input, configuration: writable }))
      .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_ROOT_UNAVAILABLE' })
    await rename(tree, `${tree}-original`)
    await mkdir(tree, { mode: 0o700 })
    await expect(directory.assertCurrent()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_ROOT_CHANGED' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
