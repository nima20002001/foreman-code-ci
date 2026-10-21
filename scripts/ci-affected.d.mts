export interface AffectedSelection {
  scope: 'affected' | 'full'
  files: string[]
  reason: string
  staticFallbackFiles?: string[]
}

import type { IntegrationCoverage } from '../packages/contracts/src/ciCoverage.mjs'
export function affectedSnapshot(commit: string, suite: string, cwd?: string, defaultRef?: string,
  baseCommit?: string, coverageMaps?: IntegrationCoverage[],
  preparedCoverage?: { coverageMap?: IntegrationCoverage; coverageReason?: string; changedFiles: string[] }): AffectedSelection

export function selectAffectedFiles(input: {
  suite: string
  changedFiles: string[]
  sources: Map<string, string>
  exports?: Record<string, unknown>
  coverageMap?: IntegrationCoverage
  coverageReason?: string
}): AffectedSelection
