import type { JobExecution } from '@foreman-code/contracts'
import { executeJob, executeVerificationJob, type JobExecutorPorts, type JobExecutorResult,
  type VerificationExecution, type VerificationJobExecutorPorts } from './executor.js'

/** W07 carrier routes job payloads here; W08 remains the launch/owner authority. */
export function createJobWorkerHandler(ports: JobExecutorPorts, settle: (execution: JobExecution, result: JobExecutorResult) => Promise<void>) {
  return async (execution: JobExecution, cancellation: AbortSignal): Promise<JobExecutorResult> => {
    const result = await executeJob(execution, ports, cancellation)
    // The injected B sink checks attempt+owner and stores result independently of publication.
    await settle(execution, result)
    return result
  }
}

export function createVerificationJobWorkerHandler(
  ports: VerificationJobExecutorPorts,
  settle: (execution: VerificationExecution, result: JobExecutorResult) => Promise<void>,
) {
  return async (execution: VerificationExecution, cancellation: AbortSignal): Promise<JobExecutorResult> => {
    const result = await executeVerificationJob(execution, ports, cancellation)
    await settle(execution, result)
    return result
  }
}
