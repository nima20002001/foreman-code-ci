import {
  BugReportCloseResultSchema, BugReportCreateResultSchema, BugReportSchema,
  type BugReport, type BugReportCreateResult,
} from '@foreman-code/contracts/management'
import { z } from 'zod'
import { DomainError } from '../errors.js'
import type { BugReportOutcome } from './repository.js'

const ReportReceiptSchema = BugReportCreateResultSchema.omit({ replayed: true })
const CloseReceiptSchema = BugReportCloseResultSchema.omit({ replayed: true }).extend({ originalInputHash: z.string() })

export function replayReportReceipt(
  value: unknown,
  message: (report: BugReport, outcome: BugReportOutcome) => string,
): Omit<BugReportCreateResult, 'replayed'> {
  const current = ReportReceiptSchema.safeParse(value)
  if (current.success) return current.data
  const previous = ReportReceiptSchema.pick({ report: true, deduplicated: true }).parse(value)
  const report = BugReportSchema.parse(previous.report)
  const outcome = previous.deduplicated ? 'repeat' : 'created'
  return { ...previous, report, outcome, message: message(report, outcome) }
}

export function replayCloseReceipt(value: unknown, originalInputHash: string) {
  // Earlier close receipts store the report array without an original-input digest.
  if (Array.isArray(value)) {
    return { reports: BugReportCloseResultSchema.shape.reports.parse(value), originalInputHash }
  }
  const receipt = CloseReceiptSchema.parse(value)
  if (receipt.originalInputHash !== originalInputHash) {
    throw new DomainError('COMMAND_ID_CONFLICT', 'This command ID was already used with different input.', 409)
  }
  return receipt
}
