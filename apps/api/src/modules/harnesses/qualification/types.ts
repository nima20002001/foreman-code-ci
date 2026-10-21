import type { CompatibilityHarness, HarnessProfileId, HarnessQualificationCheck } from '@foreman-code/contracts'

/**
 * The app's own integration tests for a harness binary. A suite runs real
 * protocol and live-turn checks against the installed executable in a disposable
 * project, with no workflow/App MCP credentials. It never edits user config.
 */
export interface QualificationSuiteInput {
  /** Absolute, realpath-resolved executable. */
  binary: string
  /** Normalized version reported by the binary. */
  version: string
  /** sha256 of the executable bytes; the trust record is bound to it. */
  binarySha256: string
  /** Behavior profile the candidate must satisfy. */
  profile: HarnessProfileId
  /** Model for the live turn (global harness default); null means the harness's own default. */
  model: string | null
  reasoningEffort?: string | undefined
  environment?: NodeJS.ProcessEnv
  /** Disposable directory owned by this run; deleted afterwards by the caller. */
  workDirectory: string
  signal: AbortSignal
  /** Register acquired resources before the next await; unregister only after positive close. */
  ownCleanup?(close: () => Promise<void>): () => void
}

export interface QualificationSuiteResult {
  checks: HarnessQualificationCheck[]
  /** Suite-specific facts kept for audit (schema hashes, model used, native ids). */
  evidence: Record<string, unknown>
}

export interface QualificationSuite {
  harness: CompatibilityHarness
  /** Bump when checks change; records from an older revision are not trusted. */
  revision: string
  run(input: QualificationSuiteInput): Promise<QualificationSuiteResult>
}
