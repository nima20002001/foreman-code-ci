import { z } from 'zod'
import { canonicalGraphJson } from './json.js'
import { IdSchema } from '../index.js'
import { ExpectedRevisionSchema, ManagementPageInfoSchema } from '../management/index.js'
import {
  REPEAT_CONTRACT_VERSION,
  REPEAT_EXECUTION_SEMANTICS_VERSION,
  RepeatDecisionMetadataV1Schema,
  RepeatDecisionV1Schema,
  RepeatOccurrenceV1Schema,
  RepeatWorkflowVersionV1Schema,
} from './repeat.js'


export const RepeatWorkflowReadbackSchema = z.object({
  contractVersion: z.literal(REPEAT_CONTRACT_VERSION),
  executionSemanticsVersion: z.literal(REPEAT_EXECUTION_SEMANTICS_VERSION),
  workspaceId: IdSchema,
  workflowId: IdSchema,
  revision: ExpectedRevisionSchema,
  currentVersionId: IdSchema,
  version: RepeatWorkflowVersionV1Schema,
}).strict().superRefine((value, context) => {
  if (value.workspaceId !== value.version.workspaceId
    || value.workflowId !== value.version.workflowId
    || value.currentVersionId !== value.version.id) {
    context.addIssue({ code: 'custom', message: 'repeat readback identity mismatch' })
  }
})

export const RepeatRunReadInputSchema = z.object({
  workspaceId: IdSchema,
  workflowId: IdSchema,
  runId: IdSchema,
  cursor: IdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  includeResultData: z.boolean().default(false),
}).strict()
export type RepeatRunReadInput = z.infer<typeof RepeatRunReadInputSchema>

const RepeatOccurrenceReadItemSchema = z.object({
  occurrence: RepeatOccurrenceV1Schema,
  decision: z.union([RepeatDecisionMetadataV1Schema, RepeatDecisionV1Schema]).nullable(),
}).strict().superRefine((value, context) => {
  if (!value.decision) return
  // The input binding/ancestry is part of the immutable occurrence too. A
  // matching counter or Run/version is not enough to substitute another record.
  if (canonicalGraphJson(value.occurrence) !== canonicalGraphJson(value.decision.occurrence)) {
    context.addIssue({ code: 'custom', message: 'occurrence and decision readback records differ' })
  }
})

const REPEAT_READBACK_MAX_BYTES = 512 * 1024

export const RepeatRunReadbackSchema = z.object({
  contractVersion: z.literal(REPEAT_CONTRACT_VERSION),
  executionSemanticsVersion: z.literal(REPEAT_EXECUTION_SEMANTICS_VERSION),
  workspaceId: IdSchema,
  workflowId: IdSchema,
  runId: IdSchema,
  items: z.array(RepeatOccurrenceReadItemSchema).max(100),
  pageInfo: ManagementPageInfoSchema,
}).strict().superRefine((value, context) => {
  const ids = new Set<string>()
  const versions = new Set<string>()
  for (const [index, item] of value.items.entries()) {
    const identity = item.occurrence.identity
    if (identity.scope.workspaceId !== value.workspaceId || identity.scope.workflowId !== value.workflowId
      || identity.scope.runId !== value.runId || ids.has(identity.occurrenceId)) {
      context.addIssue({ code: 'custom', path: ['items', index], message: 'repeat page has mismatched scope or duplicate occurrences' })
    }
    ids.add(identity.occurrenceId)
    versions.add(identity.scope.workflowVersionId)
  }
  if (versions.size > 1) context.addIssue({ code: 'custom', message: 'repeat page mixes immutable workflow versions' })
  if (value.pageInfo.nextCursor !== null && value.pageInfo.nextCursor !== value.items.at(-1)?.occurrence.identity.occurrenceId) {
    context.addIssue({ code: 'custom', path: ['pageInfo', 'nextCursor'], message: 'repeat continuation must identify the last returned occurrence' })
  }
  try { canonicalGraphJson(value, REPEAT_READBACK_MAX_BYTES) }
  catch { context.addIssue({ code: 'custom', message: 'repeat readback exceeds the bounded page size' }) }
})
export type RepeatRunReadback = z.infer<typeof RepeatRunReadbackSchema>
