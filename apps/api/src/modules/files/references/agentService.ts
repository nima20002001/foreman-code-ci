import {
  AgentReferenceListInputSchema, AgentFileReadInputSchema, MAX_FILE_BYTES, MAX_FILE_PAGE_SIZE,
  MAX_FILE_READ_BYTES, parseAgentFileReadResult,
} from '@foreman-code/contracts/files'
import { IdSchema } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { AgentReferenceAccess, type AgentReferenceDependencies } from './agentAccess.js'
import type { AgentReferenceSubject, BoundAgentReferences } from './agentTypes.js'

export { AgentReferenceListInputSchema } from '@foreman-code/contracts/files'

export class AgentReferenceService {
  private readonly access: AgentReferenceAccess
  constructor(dependencies: AgentReferenceDependencies) {
    this.access = new AgentReferenceAccess(dependencies, {
      maxPageSize: MAX_FILE_PAGE_SIZE, maxReadBytes: MAX_FILE_READ_BYTES, maxFileBytes: MAX_FILE_BYTES,
    })
  }

  /** The authenticated execution credential, not a supplied Run/node/Agent ID, chooses the execution. */
  forExecution(principal: ManagementPrincipal): BoundAgentReferences {
    return this.bind(principal, { kind: 'execution' })
  }

  /** Called by an authenticated conversation adapter. Every invocation reloads and authorizes this
   * persisted conversation, including its exact optional Run origin. Never pass an open Board ID. */
  forConversation(principal: ManagementPrincipal, conversationId: string): BoundAgentReferences {
    return this.bind(principal, { kind: 'conversation', conversationId: IdSchema.parse(conversationId) })
  }

  private bind(principal: ManagementPrincipal, subject: AgentReferenceSubject): BoundAgentReferences {
    return Object.freeze({
      list: async (raw: unknown = {}) => this.access.list(principal, subject, AgentReferenceListInputSchema.parse(raw)),
      read: async (raw: unknown) => {
        const input = AgentFileReadInputSchema.parse(raw)
        return parseAgentFileReadResult(input, await this.access.read(principal, subject, input))
      },
    })
  }
}
