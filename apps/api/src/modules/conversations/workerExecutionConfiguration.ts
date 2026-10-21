import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { OperatorConfigurationVersion } from '@foreman-code/contracts'
import type { WorkerConversationBinding, WorkerConversationConfiguration } from '@foreman-code/contracts/remote-execution-rpc'
import { DomainError } from '../errors.js'

function executionSettings(configuration: OperatorConfigurationVersion) {
  return {
    operatorId: configuration.operatorId,
    harness: configuration.harness,
    harnessProfileSelection: configuration.harnessProfileSelection,
    assignedSkills: configuration.assignedSkills,
    resolvedSkills: configuration.resolvedSkills,
    instructionDelivery: configuration.instructionDelivery,
  }
}

export function sameOperatorExecutionConfiguration(left: OperatorConfigurationVersion, right: OperatorConfigurationVersion) {
  return isDeepStrictEqual(executionSettings(left), executionSettings(right))
}

/** Presentation changes retain the immutable configuration that owns the Worker session. */
export function workerExecutionConfiguration(binding: WorkerConversationBinding,
  accepted: WorkerConversationConfiguration, previous?: OperatorConfigurationVersion): WorkerConversationConfiguration {
  if (binding.owner.configurationVersionId === accepted.id
    && binding.owner.configurationHash === commandInputHash(accepted)) return accepted
  if (binding.owner.kind === 'operator' && 'operatorId' in accepted && previous
    && binding.owner.operatorId === accepted.operatorId && previous.operatorId === accepted.operatorId
    && binding.owner.configurationVersionId === previous.id
    && binding.owner.configurationHash === commandInputHash(previous)
    && sameOperatorExecutionConfiguration(previous, accepted)) return previous
  throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The original Worker execution configuration changed.', 409)
}
