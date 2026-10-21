import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import type { CompatibilityHarness } from '@foreman-code/contracts'
import { HarnessExecutionError } from '../errors.js'
import { normalizeHarnessVersion } from './profiles.js'
import type { HarnessQualificationRegistry } from './registry.js'

const readOnly = new AsyncLocalStorage<HarnessQualificationRegistry>()
/** An operation-scoped authenticated Main reader. No begin/write service or global gate replacement. */
export function runWithReadOnlyQualification<T>(registry: HarnessQualificationRegistry, work: () => Promise<T>): Promise<T> {
  return readOnly.run(registry, work)
}

/** Explicit suites retain their selected binary identity before any native effects. */
export async function runAsQualificationCandidate<T>(harness: CompatibilityHarness, sha256: string,
  binary: string, work: () => Promise<T>): Promise<T> {
  if (createHash('sha256').update(await readFile(await realpath(binary))).digest('hex') !== sha256) {
    throw new HarnessExecutionError('HARNESS_INSTALLATION_CHANGED', `${harness} changed before its native contract checks.`)
  }
  return work()
}

export async function requireHarnessQualification(harness: CompatibilityHarness, version: string, binary: string): Promise<void> {
  const normalized = normalizeHarnessVersion(version)
  const scoped = readOnly.getStore()
  if (scoped) {
    const { sha256 } = await scoped.inspectBinary(binary)
    if (!await scoped.trustedExact(harness, normalized, sha256)) throw new HarnessExecutionError('HARNESS_UNQUALIFIED', 'Current authenticated Main qualification for this exact installed harness is required.')
    return
  }
  // Main launch paths verify the installed protocol and concrete settings themselves.
  // Native scenario suites remain explicit operations; a read never starts a model turn.
}
