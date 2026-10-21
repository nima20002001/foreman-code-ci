import { isAbsolute, relative, basename, posix } from 'node:path'
import { realpath } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkerConversationBinding, WorkerConversationConfiguration } from '@foreman-code/contracts/remote-execution-rpc'
import { openRootDirectory } from '../sources/rootAttestation.js'
import { anchored, identity, openPrivateRoot, openChildDirectory } from '../sources/privateFilesystem.js'
import { DomainError } from '../errors.js'
import { workerOperatorDirectory } from './workerOperatorDirectory.js'
import { requiredLocationAccess } from '../workspaces/locationAccess.js'

async function inspectApprovedDirectory(approved: ApprovedRootAllowlist, path: string,
  accessMode: 'read-only' | 'read-write') {
  const base = approved.bases.find(value => {
    const child = relative(value.canonicalPath, path)
    return value.accessModes.includes(accessMode) && !isAbsolute(child) && child !== '..' && !child.startsWith('../')
  })
  if (!base) throw new DomainError('WORKER_CONVERSATION_ROOT_UNAVAILABLE',
    'The chat folder or a writable folder is outside the worker’s approved roots.', 409)
  const directory = await openRootDirectory(base.canonicalPath, relative(base.canonicalPath, path), base.filesystem)
  try {
    if (await realpath(anchored(directory)) !== path) {
      throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The selected chat folder changed.', 409)
    }
    return await identity(directory)
  } finally { await directory.close() }
}

async function inspectRunDirectory(approved: ApprovedRootAllowlist, binding: WorkerConversationBinding,
  accessMode: 'read-only' | 'read-write') {
  const source = binding.sourceExecution!
  const namespace = posix.join(approved.managedRuntimeRoot, 'source-materializations',
    source.placement.destination.rootPolicyId)
  const child = posix.relative(namespace, source.workingTree.canonicalCwd)
  if (source.placement.destination.managedRuntimeRoot !== approved.managedRuntimeRoot
    || source.workingTree.canonicalCwd !== binding.workingDirectory
    || !child || posix.isAbsolute(child) || child === '..' || child.startsWith('../')
    || accessMode === 'read-write' && source.workingTree.accessMode !== 'exclusive-write') {
    throw new DomainError('WORKER_CONVERSATION_ROOT_UNAVAILABLE',
      'The chat folder differs from its accepted Run working tree.', 409)
  }
  const runtime = await openPrivateRoot(approved.managedRuntimeRoot)
  try {
    if (!isDeepStrictEqual(await identity(runtime), approved.runtimeFilesystem)) {
      throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The worker runtime root changed.', 409)
    }
    const directory = await openRootDirectory(approved.managedRuntimeRoot,
      posix.relative(approved.managedRuntimeRoot, source.workingTree.canonicalCwd), approved.runtimeFilesystem)
    try {
      const observed = await identity(directory)
      if (await realpath(anchored(directory)) !== source.workingTree.canonicalCwd
        || !isDeepStrictEqual(observed, source.workingTree.filesystem)) {
        throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The saved Run working tree changed.', 409)
      }
      return observed
    } finally { await directory.close() }
  } finally { await runtime.close() }
}

/** Pins the selected project to the worker's existing human-approved root configuration. */
export async function installedConversationDirectory(input: {
  binding: WorkerConversationBinding
  configuration: WorkerConversationConfiguration
  approvedRoots(): Promise<ApprovedRootAllowlist>
}) {
  input = { ...input, binding: structuredClone(input.binding), configuration: structuredClone(input.configuration) }
  const approved = structuredClone(await input.approvedRoots())
  const target = input.binding.profile.target
  if (!isDeepStrictEqual(approved.hostRef, target.hostRef)
    || approved.applicationInstallationId !== target.applicationInstallationId) {
    throw new DomainError('WORKER_CONVERSATION_ROOT_UNAVAILABLE', 'This worker has no approved roots for the selected profile.', 409)
  }
  const harness = input.configuration.harness
  const directoryBinding = input.binding.directoryBinding
  const inspectProject = async () => {
    if (!directoryBinding) return
    const { policy, placement } = directoryBinding
    if (input.binding.owner.kind !== 'agent' || !isDeepStrictEqual(policy.hostRef, approved.hostRef)
      || policy.applicationInstallationId !== approved.applicationInstallationId
      || policy.configurationRevision !== approved.configurationRevision
      || policy.workspaceId !== input.binding.owner.workspaceId
      || placement.projectRoot !== policy.canonicalProjectRoot
      || !isDeepStrictEqual(placement.hostRef, policy.hostRef)
      || placement.rootPolicyId !== policy.rootPolicyId || placement.rootPolicyRevision !== policy.rootPolicyRevision
      || placement.locationRevision !== policy.locationRevision
      || posix.isAbsolute(placement.relativeCwd) || placement.relativeCwd.includes('\0')
      || placement.relativeCwd !== '' && placement.relativeCwd.split('/').some(part => ['.', '..', ''].includes(part))
      || input.binding.workingDirectory !== posix.join(policy.canonicalProjectRoot, placement.relativeCwd)
      || !approved.bases.some(base => base.baseId === policy.allowedBaseId && base.accessModes.includes(policy.accessMode))) {
      throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The saved node root differs from its approved worker settings.', 409)
    }
    const observed = await inspectApprovedDirectory(approved, policy.canonicalProjectRoot, policy.accessMode)
    if (!isDeepStrictEqual(observed, policy.filesystem)) throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED',
      'The saved node project folder was replaced.', 409)
  }
  await inspectProject()
  const writablePaths = harness.harness === 'codex' ? harness.advanced?.additionalWritableDirectories ?? [] : []
  const writable = await Promise.all(writablePaths.map(path => inspectApprovedDirectory(approved, path, 'read-write')))
  const assertWritable = async () => {
    for (const [index, path] of writablePaths.entries()) {
      if (!isDeepStrictEqual(await inspectApprovedDirectory(approved, path, 'read-write'), writable[index])) {
        throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'A configured writable folder was replaced.', 409)
      }
    }
  }
  if (input.binding.owner.kind === 'operator') {
    const expected = workerOperatorDirectory(approved.managedRuntimeRoot, input.binding.owner)
    if (input.binding.workingDirectory !== expected) throw new DomainError('WORKER_CONVERSATION_ROOT_UNAVAILABLE',
      'Operator chat must use its private folder on the selected worker.', 409)
    const inspect = async (operation: 'create' | 'read') => {
      const root = await openPrivateRoot(approved.managedRuntimeRoot)
      try {
        if (!isDeepStrictEqual(await identity(root), approved.runtimeFilesystem)) {
          throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The worker runtime root was replaced.', 409)
        }
        const chats = await openChildDirectory(root, 'operator-chats', operation === 'create')
        try {
          const directory = await openChildDirectory(chats, basename(expected), operation === 'create')
          try {
            if (await realpath(anchored(directory)) !== expected) {
              throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The private Operator chat folder changed.', 409)
            }
            return await identity(directory)
          } finally { await directory.close() }
        } finally { await chats.close() }
      } finally { await root.close() }
    }
    const original = await inspect('create')
    return { async assertCurrent(signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (!isDeepStrictEqual(await input.approvedRoots(), approved) || !isDeepStrictEqual(await inspect('read'), original)) {
        throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The worker root or Operator chat folder changed.', 409)
      }
      await assertWritable()
      signal?.throwIfAborted()
    } }
  }
  if (!('agentId' in input.configuration)) throw new DomainError('WORKER_CONVERSATION_ROOT_UNAVAILABLE',
    'The selected node chat requires its Agent configuration.', 409)
  const accessMode = requiredLocationAccess([input.configuration])
  const inspect = async () => {
    const source = input.binding.sourceExecution
    if (!source) return inspectApprovedDirectory(approved, input.binding.workingDirectory, accessMode)
    return inspectRunDirectory(approved, input.binding, accessMode)
  }
  const original = await inspect()
  return {
    async assertCurrent(signal?: AbortSignal) {
      signal?.throwIfAborted()
      const current = await input.approvedRoots()
      if (!isDeepStrictEqual(current, approved)) throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED',
        'The worker’s approved chat roots changed.', 409)
      const observed = await inspect()
      await inspectProject()
      await assertWritable()
      signal?.throwIfAborted()
      if (!isDeepStrictEqual(observed, original)) {
        throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The selected chat directory was replaced.', 409)
      }
    },
  }
}
