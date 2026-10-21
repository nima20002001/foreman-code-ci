import { pathExists } from '../../shared/pathExists.js'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { CiManagedSetupSchema } from '@foreman-code/contracts'
import { JobVerificationInstalledRuntimeDescriptorSchema } from '@foreman-code/contracts/job-verification-runtime'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { anchored, identity, openPrivateRoot, openChildDirectory } from '../sources/privateFilesystem.js'
import { DomainError } from '../errors.js'
import { readProtectedRuntimeConfiguration } from './installedRuntimeConfiguration.js'
import { InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES,
  type InstalledVerificationRuntimeConfiguration } from './installedVerificationConfiguration.js'

/** Installation inputs retained during pairing adoption, never executable runtime or qualification records. */
export const CiRuntimeInstallationSchema = z.object({
  schemaVersion: z.literal(1),
  target: JobVerificationInstalledRuntimeDescriptorSchema.shape.target,
  runtime: InstalledVerificationRuntimeConfigurationSchema,
}).strict()


export async function readCiRuntimeInstallation(stateDirectory: string) {
  const path = join(stateDirectory, 'ci-runtime-installation.json')
  if (!await pathExists(path)) return null
  return readProtectedRuntimeConfiguration({ path, ownerUid: process.getuid!() },
    CiRuntimeInstallationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES + 4096)
}

export async function readCiRuntimeTemplate(stateDirectory: string) {
  const path = join(stateDirectory, 'job-runtime.json')
  if (await pathExists(path)) {
    return readProtectedRuntimeConfiguration({ path, ownerUid: process.getuid!() },
      InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES)
  }
  return (await readCiRuntimeInstallation(stateDirectory))?.runtime ?? null
}

export async function readCiManagedSetup(stateDirectory: string) {
  const path = join(stateDirectory, 'managed-setup.json')
  if (!await pathExists(path)) return undefined
  const record = await readProtectedRuntimeConfiguration({ path, ownerUid: process.getuid!() },
    z.object({ status: CiManagedSetupSchema }).passthrough())
  return record.status
}

/** Moves idle quota slots without changing their project IDs or inodes; null means relocation was skipped. */
export async function relocateCiQuotaSlots(configuration: InstalledVerificationRuntimeConfiguration,
  root: SourceRootRecord) {
  const runtime = configuration.descriptor.runtimeRoot
  const expected = join(runtime, 'source-materializations', root.selection.rootPolicyId)
  if (configuration.root.binding.canonicalPath === expected) return configuration.descriptor.quotaPool
  if (root.binding.canonicalPath !== expected) {
    throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'The CI root is outside managed source storage.', 409)
  }
  const previous = await openPrivateRoot(configuration.root.binding.canonicalPath)
  const destination = await openPrivateRoot(expected)
  try {
    const observed = await identity(destination)
    if (!isDeepStrictEqual(observed, root.binding.filesystem)) {
      throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'The new CI source directory changed.', 409)
    }
    const source = await identity(previous)
    // Copying to another filesystem would discard kernel project quotas and inode identities.
    if (configuration.descriptor.quotaPool
      && (source.device !== observed.device || source.mountId !== observed.mountId)) return null
    const slots = []
    for (const slot of configuration.descriptor.quotaPool?.slots ?? []) {
      const to = anchored(destination, slot.namespace)
      if (!await pathExists(to)) {
        const from = await openChildDirectory(previous, slot.namespace)
        try {
          const current = await identity(from)
          if (current.device !== slot.filesystem.device || current.inode !== slot.filesystem.inode
            || current.device !== observed.device || current.mountId !== observed.mountId) {
            throw new DomainError('JOB_QUOTA_CHANGED', 'The adopted quota directory changed.', 409)
          }
          try {
            await rename(anchored(previous, slot.namespace), to)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EXDEV') return null
            throw error
          }
        } finally { await from.close() }
      }
      const moved = await openChildDirectory(destination, slot.namespace)
      try {
        const filesystem = await identity(moved)
        if (filesystem.device !== slot.filesystem.device || filesystem.inode !== slot.filesystem.inode) {
          throw new DomainError('JOB_QUOTA_CHANGED', 'The destination contains another quota directory.', 409)
        }
        slots.push({ ...slot, filesystem })
      } finally { await moved.close() }
    }
    await previous.sync()
    await destination.sync()
    return configuration.descriptor.quotaPool ? { ...configuration.descriptor.quotaPool, slots } : undefined
  } finally {
    await previous.close()
    await destination.close()
  }
}
