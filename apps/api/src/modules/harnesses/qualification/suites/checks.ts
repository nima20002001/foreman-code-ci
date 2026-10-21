import { isRecord } from '../../../../shared/records.js'
import type { HarnessQualificationCheck } from '@foreman-code/contracts'
import type { QualificationSuiteInput, QualificationSuiteResult } from '../types.js'

export type Check = readonly [id: string, run: () => Promise<string | null>]

/** Retry only live model behavior, with a new native session supplied by the caller. */
export async function modelCheck(id: string, signal: AbortSignal, evidence: Record<string, unknown>, run: (attempt: number) => Promise<string>): Promise<string> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    evidence[`${id}Attempts`] = attempt
    try {
      signal.throwIfAborted()
      return await run(attempt)
    } catch (error) {
      if (attempt === 2 || signal.aborted) throw error
    }
  }
  throw new Error('Unreachable model check state.')
}

/** Each check reports independently; errors cannot accidentally qualify a binary. */
export async function collectChecks(input: QualificationSuiteInput, checks: readonly Check[], evidence: Record<string, unknown> = {}): Promise<QualificationSuiteResult> {
  const results: HarnessQualificationCheck[] = []
  for (const [id, run] of checks) {
    try {
      input.signal.throwIfAborted()
      results.push({ id, passed: true, detail: (await run())?.slice(0, 500) ?? null })
    } catch (error) {
      results.push({ id, passed: false, detail: (error instanceof Error ? error.message : String(error)).slice(0, 500) })
    }
  }
  return { checks: results, evidence }
}

export function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Native response is not an object.')
  return value as Record<string, unknown>
}

export function nonempty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Native ${field} is missing.`)
  return value
}

export function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
