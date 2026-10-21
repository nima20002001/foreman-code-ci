import {
  DEFAULT_WORKER_EXECUTION_SETTINGS,
  WorkerExecutionSettingsSchema,
  type ManagementPrincipal,
  type WorkerExecutionSettings,
} from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'

export class WorkerExecutionPolicy {
  private settings: WorkerExecutionSettings

  constructor(settings: WorkerExecutionSettings = DEFAULT_WORKER_EXECUTION_SETTINGS) {
    this.settings = WorkerExecutionSettingsSchema.parse(settings)
  }

  apply(settings: WorkerExecutionSettings): void {
    this.settings = WorkerExecutionSettingsSchema.parse(settings)
  }

  read(principal: ManagementPrincipal): WorkerExecutionSettings {
    requireAuthorization(principal, 'settings:read')
    return { ...this.settings }
  }

  requireEnabled(host: { kind: 'main' | 'device' }): void {
    if (host.kind === 'main' || this.settings.enabled) return
    throw new DomainError(
      'WORKER_EXECUTION_DISABLED',
      'Execution on connected computers is disabled. Ask the Operator to update remote execution settings on Main.',
      409,
    )
  }
}
