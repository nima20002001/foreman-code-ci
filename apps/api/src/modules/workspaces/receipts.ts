import { ManagedWorkspaceSchema, type ManagedWorkspace } from '@foreman-code/contracts/management'

const LegacyWorkspaceResultSchema = ManagedWorkspaceSchema.omit({
  executionLocation: true,
  locationRevision: true,
  locationValidation: true,
}).strict()

/**
 * PR #4 receipts predate location fields. Adapt only that exact legacy shape.
 * A receipt describes the original command, not today's saved workspace. Do
 * not invent a historical path, query current state, or execute the command again.
 */
export function replayWorkspaceResult(value: unknown): ManagedWorkspace {
  const current = ManagedWorkspaceSchema.safeParse(value)
  if (current.success) return current.data
  const legacy = LegacyWorkspaceResultSchema.parse(value)
  return ManagedWorkspaceSchema.parse({
    ...legacy,
    executionLocation: null,
    locationRevision: 0,
    locationValidation: { status: 'restricted' },
  })
}
