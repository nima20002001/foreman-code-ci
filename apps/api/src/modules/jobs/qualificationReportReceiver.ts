import { isDeepStrictEqual } from 'node:util'
import type { JobQualificationCandidateRecord, JobQualificationReport }
  from '@foreman-code/contracts/job-verification-runtime'
import { qualificationExecution } from './qualificationExecution.js'
import { validateQualificationReport, type createQualificationReportPublisher } from './qualificationReports.js'

/** Bounded W07 packets are sealed before the canonical file publisher adopts their bytes. */
export function createQualificationReportReceiver(publish: ReturnType<typeof createQualificationReportPublisher>) {
  const pending = new Map<string, { candidate: JobQualificationCandidateRecord; report: JobQualificationReport;
    bytes: Buffer; received: number; deadline: number }>()
  return async (candidate: JobQualificationCandidateRecord, report: JobQualificationReport, offset: number,
    chunk: Uint8Array, authorize: () => Promise<void>) => {
    await authorize()
    validateQualificationReport(candidate, report)
    const execution = qualificationExecution(candidate, report)
    const limit = execution.acceptedSpec.outputs.find(output => output.path === report.path)!.maxBytes
    if (!chunk.byteLength || chunk.byteLength > 1048576 || report.byteSize > limit
      || offset < 0 || offset + chunk.byteLength > report.byteSize) throw new Error('Diagnostic packet exceeds its declaration.')
    const key = `${execution.id}:${report.path}`
    for (const [id, value] of pending) if (value.deadline <= Date.now()) pending.delete(id)
    let saved = pending.get(key)
    if (!saved) {
      if (offset !== 0 || pending.size >= 4
        || [...pending.values()].reduce((total, value) => total + value.bytes.length, report.byteSize) > 64 * 1024 * 1024) {
        throw new Error('Diagnostic packet admission or sealing capacity is unavailable.')
      }
      saved = { candidate, report, bytes: Buffer.alloc(report.byteSize), received: 0,
        deadline: Date.parse(execution.acceptedSpec.lifecycle.publicationDeadlineAt) }
      pending.set(key, saved)
    }
    if (!isDeepStrictEqual(saved.candidate, candidate) || !isDeepStrictEqual(saved.report, report)) {
      throw new Error('Original diagnostic packet metadata changed.')
    }
    if (offset < saved.received) {
      if (offset + chunk.byteLength > saved.received
        || !saved.bytes.subarray(offset, offset + chunk.byteLength).equals(Buffer.from(chunk))) {
        throw new Error('Retried diagnostic packet changed.')
      }
    } else {
      if (offset !== saved.received) throw new Error('Diagnostic packets must be contiguous.')
      Buffer.from(chunk).copy(saved.bytes, offset)
      saved.received += chunk.byteLength
    }
    if (saved.received < report.byteSize) return { receivedBytes: saved.received, artifact: null }
    try {
      const artifact = await publish(candidate, report, saved.bytes, authorize)
      return { receivedBytes: saved.received, artifact }
    } finally { pending.delete(key) }
  }
}
