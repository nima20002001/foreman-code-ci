import type { JobVerificationRepositoryContextSchema } from '@foreman-code/contracts/job-verification-runtime'
import type { JobVerificationReport } from '@foreman-code/contracts/job-verification'
import type { z } from 'zod'
export function integrationPartition(files: string[], durations: Record<string, number>, partition: { index: number; count: number }): string[]
export function captureVerificationInventory(root: string, suite: string, options?: { qualification?: boolean; partition?: { index: number; count: number } | undefined }): Array<{ key: string; kind: 'command' | 'bootstrap' | 'vitest' | 'node' | 'integration'; files?: string[] }>
export function expectedPortions(root: string, suite: string): Array<{ key: string; kind: string }>
export function finalizeVerification(context: z.infer<typeof JobVerificationRepositoryContextSchema>, input: {
  root: string
  directory: string
  state: { identity?: unknown; startedAt: string; expected: Array<{ key: string; kind: string }> }
  terminalOutcome: string
  processStopped: boolean
  finishedAt?: string
  reportRoot?: string
  writeSummary?: (path: string, value: JobVerificationReport, maximumBytes: number) => void
  checkpoint?: () => void
}): JobVerificationReport
