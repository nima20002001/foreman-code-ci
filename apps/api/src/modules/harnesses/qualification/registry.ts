import { createHash } from 'node:crypto'
import { access, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'
import type { CompatibilityHarness } from '@foreman-code/contracts'
import { forgetQualifiedProfile, rememberQualifiedProfile, QUALIFICATION_TARGET_PROFILE } from './profiles.js'
import type { HarnessQualificationRepository } from './repository.js'

export class HarnessQualificationRegistry {
  constructor(private readonly repository: Pick<HarnessQualificationRepository, 'list' | 'find'>, private readonly revisions: Partial<Record<CompatibilityHarness, string>>) {}

  async load(retryRead?: (
    work: () => ReturnType<HarnessQualificationRepository['list']>,
  ) => ReturnType<HarnessQualificationRepository['list']>): Promise<void> {
    const read = () => this.repository.list()
    const rows = await (retryRead ? retryRead(read) : read())
    for (const row of rows) {
      if (row.status === 'qualified' && row.suiteRevision === this.revisions[row.harness] && row.profile === QUALIFICATION_TARGET_PROFILE[row.harness]) {
        rememberQualifiedProfile(row.harness, row.version, row.profile)
      }
    }
  }

  async inspectBinary(binary: string): Promise<{ binary: string; sha256: string }> {
    const candidates = isAbsolute(binary) || binary.includes('/') ? [binary] : (process.env.PATH ?? '').split(delimiter).map((entry) => resolve(entry || '.', binary))
    let resolved: string | undefined
    for (const candidate of candidates) {
      try { await access(candidate, constants.X_OK); resolved = await realpath(candidate); break }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
    if (!resolved) throw new Error('The configured harness executable is unavailable.')
    const sha256 = createHash('sha256').update(await readFile(resolved)).digest('hex')
    return { binary: resolved, sha256 }
  }

  /** Worker read-only scopes require actual current proof even for known baseline versions. */
  async trustedExact(harness: CompatibilityHarness, version: string, binarySha256: string): Promise<boolean> {
    const revision = this.revisions[harness]
    if (!revision) return false
    const record = await this.repository.find(harness, version, binarySha256, revision)
    const passed = record?.harness === harness && record.version === version && record.binarySha256 === binarySha256
      && record.suiteRevision === revision && record.status === 'qualified' && record.profile === QUALIFICATION_TARGET_PROFILE[harness]
      && record.checkedAt !== null && record.checks.length > 0 && record.checks.every(check => check.passed)
    if (passed && record?.profile) rememberQualifiedProfile(harness, version, record.profile)
    return passed
  }

  async trusted(harness: CompatibilityHarness, version: string, binarySha256: string): Promise<boolean> {
    const passed = await this.trustedExact(harness, version, binarySha256)
    if (!passed) forgetQualifiedProfile(harness, version)
    return passed
  }
}
