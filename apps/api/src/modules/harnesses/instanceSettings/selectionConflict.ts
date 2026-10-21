import { DomainError } from '../../errors.js'

export function harnessProfileSelectionConflict(reason: string): DomainError {
  return new DomainError('HARNESS_PROFILE_SELECTION_CONFLICT', `${reason} Call harness_instances_list for the selected host, `
    + 'then harness_instance_save with the intended configuration. Reuse the returned selection '
    + '(instanceId, instanceRevision, target) and configuration in the Agent or defaults write.', 409)
}

export function staleHarnessProfileSelectionConflict(reason: string): DomainError {
  return new DomainError('HARNESS_PROFILE_SELECTION_CONFLICT', `${reason} Call harness_instances_list for the selected host `
    + 'and reuse the listed selection (instanceId, instanceRevision, target) and configuration '
    + 'in the Agent or defaults write when the intended configuration is unchanged.', 409)
}
