import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { JobQualificationCandidateRecord, JobRuntimeQualificationResultRecord } from '@foreman-code/contracts/job-verification-runtime'

export interface QualificationNativeOwner {
  completedResult?: JobRuntimeQualificationResultRecord
  originalResult?: JobRuntimeQualificationResultRecord
  recoveryRequired?: boolean
  originalContainer?: { identity: string; fingerprint: string; containerId?: string | null }
  reserveCleanupProcess?(binary: string, argv: string[]): Promise<string>
  spawnCleanupProcess?(reservationId: string, binary: string, argv: string[], options: SpawnOptions): ChildProcess
  recordQuotaClaim?(claim: { path: string; namespace: string; device: number; inode: number }): Promise<void>
  recordResult?(result: JobRuntimeQualificationResultRecord): Promise<void>
  readClosure?(): Promise<import('@foreman-code/contracts/job-verification-runtime').JobQualificationReport['closure']>
  /** Existing admission journals the exact native launch before the physical Node spawn. */
  reserveProcess(binary: string, argv: string[]): Promise<string>
  /** HRT's guarded spawn primitive receives original reserved scope BEFORE native entry. */
  spawnProcess(reservationId: string, binary: string, argv: string[], options: SpawnOptions): ChildProcess
  readNativeExit(reservationId: string, child: ChildProcess, wrapperExit: { exitCode: number | null; signal: string | null }): Promise<{ confirmed: boolean; exitCode: number | null }>
  stopProcess(reservationId: string): Promise<boolean>
  registerContainer(identity: string, fingerprint: string): Promise<void>
  /** Bind ID only after validating the original reserved identity/fingerprint labels. */
  observeContainer(identity: string, containerId: string): Promise<void>
  enterContainer(identity: string, containerId: string): Promise<void>
  /** True only after all registered controller processes AND owned container descendants stopped. */
  closeContainer?(): Promise<boolean>
  close(): Promise<boolean>
}
export interface JobQualificationAuthority {
  readApproval(id: string): Promise<{ status: 'approved' | 'denied' | 'revoked'; fingerprint: string; expiresAt: string } | null>
  assertCurrent(candidate: JobQualificationCandidateRecord): Promise<void>
  reserve(candidate: JobQualificationCandidateRecord, signal: AbortSignal): Promise<QualificationNativeOwner>
}
