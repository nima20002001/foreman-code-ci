import { createWorkflowCollaborationHooks, type WorkflowCollaborationHooks } from '../collaboration/workflowHooks.js'
import { MemoryResultRejected } from '../collaboration/memoryResultError.js'
import type { MemoryBoardService } from '../memory-boards/service.js'
import { DomainError } from '../errors.js'
import { isWorkflowResultEffectFailure } from './workflowResultEffectFailure.js'

/** Hierarchy transitions own their memory lifecycle; ordinary work uses the repository's handoff settlement. */
export function createMemoryBoardHooks(service: MemoryBoardService): WorkflowCollaborationHooks {
  const memory = createWorkflowCollaborationHooks(service)
  const projections = createWorkflowCollaborationHooks()
  return {
    lifecycleLocked(sql, input) {
      return input.version.definition.hierarchy
        ? memory.lifecycleLocked(sql, input) : projections.lifecycleLocked(sql, input)
    },
    async resultLocked(sql, input) {
      try {
        await memory.resultLocked(sql, input)
      } catch (error) {
        const cause = isWorkflowResultEffectFailure(error) ? error.cause : error
        if (cause instanceof DomainError && cause.status < 500) throw new MemoryResultRejected(cause)
        throw error
      }
    },
  }
}
