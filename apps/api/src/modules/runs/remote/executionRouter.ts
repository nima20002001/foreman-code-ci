import { DomainError } from '../../errors.js'
import { RemoteJobExecutionRpcRequestRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import type { RemoteJobExecutionHost } from './jobExecutionHost.js'
import { WorkerConversationRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
/** Workflow, Job and chat operations share the authenticated execution-v1 carrier. */
export function createRemoteExecutionHandler(workflows: { handle(raw: unknown): Promise<unknown> },
  jobs?: RemoteJobExecutionHost, conversations?: { handle(raw: unknown): Promise<unknown> }) {
  return (raw: unknown) => {
    const method = raw && typeof raw === 'object' && 'method' in raw ? raw.method : undefined
    if (typeof method === 'string' && method.startsWith('conversation.')) {
      const request = WorkerConversationRpcRequestSchema.parse(raw)
      if (!conversations) throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The installed chat runtime is unavailable.', 409)
      return conversations.handle(request)
    }
    if (RemoteJobExecutionRpcRequestRecordSchema.safeParse(raw).success) {
      if (!jobs) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'This actual workflow host has no installed Job runtime.', 409)
      return jobs.handle(raw)
    }
    return workflows.handle(raw)
  }
}
