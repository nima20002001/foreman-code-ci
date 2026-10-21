import { z } from 'zod'
import type { CanonicalMachineReference } from './deviceIdentity.js'

export const SourceRootReferenceSchema = z.object({
  rootId: z.uuid(),
  bindingRevision: z.number().int().positive(),
}).strict()
export type SourceRootReference = z.infer<typeof SourceRootReferenceSchema>

export const AgentBranchPrefixSchema = z.string().regex(/^foreman\/[A-Za-z0-9._/-]{1,200}$/)
  .refine(value => !value.includes('\n') && !value.includes('\r') && !value.includes('..') && !value.includes('//')
    && !value.endsWith('/') && !value.endsWith('.')
    && value.split('/').every(part => !part.endsWith('.lock') && !part.startsWith('.')),
  'Use a valid foreman/ Agent branch prefix.')
  .describe('Agents using the same effective explicit prefix must be on one computer. '
    + 'Each execution still gets its own worktree and unique branch suffix.')

export const WorkflowWorktreeSettingsSchema = z.object({
  rootBinding: SourceRootReferenceSchema,
  branchPrefix: AgentBranchPrefixSchema.optional(),
}).strict()
export type WorkflowWorktreeSettings = z.infer<typeof WorkflowWorktreeSettingsSchema>

export const AgentWorktreeSettingsSchema = z.object({
  branchPrefix: AgentBranchPrefixSchema,
}).strict()
export type AgentWorktreeSettings = z.infer<typeof AgentWorktreeSettingsSchema>

export interface WorktreeComputerSelection {
  branchPrefix: string
  agentName: string
  hostRef: CanonicalMachineReference
}

export function worktreeComputerConflict(selections: readonly WorktreeComputerSelection[]): {
  first: WorktreeComputerSelection
  second: WorktreeComputerSelection
} | undefined {
  const prefixes = new Map<string, WorktreeComputerSelection>()
  for (const selection of selections) {
    const first = prefixes.get(selection.branchPrefix)
    if (!first) {
      prefixes.set(selection.branchPrefix, selection)
      continue
    }
    const a = first.hostRef
    const b = selection.hostRef
    if (a.mainId !== b.mainId || a.kind !== b.kind
      || a.kind === 'device' && b.kind === 'device' && a.deviceId !== b.deviceId) {
      return { first, second: selection }
    }
  }
  return undefined
}
