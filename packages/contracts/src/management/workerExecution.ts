import { z } from 'zod'

export const WORKER_EXECUTION_STARTUP_VARIABLE = 'FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED'

/** The Main deployment controls execution on connected Worker computers. */
export const WorkerExecutionSettingsSchema = z.object({
  enabled: z.boolean(),
  managedBy: z.enum(['startup', 'settings']),
}).strict()

export type WorkerExecutionSettings = z.infer<typeof WorkerExecutionSettingsSchema>

export const DEFAULT_WORKER_EXECUTION_SETTINGS: WorkerExecutionSettings = {
  enabled: false,
  managedBy: 'settings',
}
