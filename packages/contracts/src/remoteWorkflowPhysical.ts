import { z } from 'zod'
import { NativeSessionReferenceSchema, NativeHarnessEventSchema, PendingNativeInteractionSchema,
  ExecutionResultSchema, RecordedAgentHarnessSchema, ApprovalResponseSemanticSchema } from './index.js'
import { NativeMessageSubmissionSchema } from './claude.js'
import { PlacementDigestSchema, DispatchIntentSchema } from './nodePlacement.js'
import { RemoteOperationReceiptSchema, WorkflowArtifactValidationFailureSchema,
  type WorkflowArtifactValidationFailure } from './remoteExecution.js'
import { SourceMaterializationRecordSchema, VerifiedSourceWorkingTreeSchema, SourceCwdAttestationSchema } from './sourceAdmission.js'
import { WorkflowArtifactResultV1Schema, type WorkflowArtifactOutputsV1 } from './workflowArtifactDeclarations.js'
import { WorkflowArtifactResultEnvelopeV1Schema, WorkflowChoiceArtifactResultEnvelopeV1Schema } from './workflowArtifactResult.js'
import { canonicalGraphJson } from './wave25/json.js'
import { WorkHandoffResultSchema } from './wave25/handoffs.js'
import { DeviceHistoryGapSchema, DeviceJsonContinuationSchema, DEVICE_JSON_CONTINUATION_LIMIT } from './deviceApplication.js'

export const REMOTE_PHYSICAL_CONTINUATION_LIMIT = DEVICE_JSON_CONTINUATION_LIMIT * 3
/** A history repeats its journal-sized result in both terminal fields. */
export const REMOTE_NATIVE_SOURCE_LIMIT = DEVICE_JSON_CONTINUATION_LIMIT * 3
export const RemoteResultDictionarySchema = z.object({
  kind: z.literal('execution-result-dictionary'), data: z.record(z.string(), z.unknown()),
  results: z.array(z.lazy(() => ExecutionResultSchema)).max(64),
  locations: z.array(z.object({ path: z.array(z.union([z.string().min(1).max(64),
    z.number().int().nonnegative()])).min(1).max(8),
    index: z.number().int().nonnegative().max(63) }).strict()).max(128),
}).strict()
export type RemoteResultDictionary = z.infer<typeof RemoteResultDictionarySchema>
const RemotePhysicalJsonContinuationSchema = DeviceJsonContinuationSchema.extend({
  byteSize: z.number().int().safe().positive().max(REMOTE_PHYSICAL_CONTINUATION_LIMIT),
})

const ProcessIdentitySchema = z.object({ pid: z.number().int().safe().gt(1), startTicks: z.string().regex(/^\d+$/) }).strict()
/** Internal original registry identities only; never a public process DTO. */
export const RemoteNativeLaunchObservationSchema = z.object({ owner: z.string().min(1).max(4096), launchId: z.uuid(), bootId: z.string().min(1),
  guardian: ProcessIdentitySchema, provider: ProcessIdentitySchema,
  boundary: z.object({ kind: z.literal('cgroup-v2'), path: z.string().startsWith('/'), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict(),
  lifecycle: z.enum(['active', 'ended', 'closure-unconfirmed', 'closed']),
  closureEvidence: z.enum(['linux_boot_changed', 'native_not_started', 'cgroup_v2_empty',
    'native_exit_removed_cgroup', 'cgroup_v2_removed']).optional(),
}).strict()
const RemoteRuntimeLeafAttestationSchema = z.object({ executionId: z.string().min(1), attemptId: z.string().min(1),
  operationId: z.string().min(1), bindingHash: PlacementDigestSchema, canonicalRuntimeDirectory: z.string().startsWith('/'),
  directoryIdentityHash: PlacementDigestSchema, materializationId: z.string().min(1), materializationDigest: PlacementDigestSchema }).strict()
/** The same bounded real NativeHistory contract used by the native proxy. */
export const RemoteNativeHistorySchema = z.object({ nativeSubmission: z.lazy(() => NativeMessageSubmissionSchema).optional(),
  correlationId: z.string().optional(), nativeTurnId: z.string().optional(), nativeMessageId: z.string().optional(), nextCursor: z.string().optional(),
  firstRetainedSequence: z.number().int().nonnegative().optional(), nextSequence: z.number().int().nonnegative().optional(),
  gap: DeviceHistoryGapSchema.optional(),
  events: z.array(z.lazy(() => NativeHarnessEventSchema)).max(1024), pendingInteractions: z.array(z.lazy(() => PendingNativeInteractionSchema)).max(128),
  pendingInteraction: z.lazy(() => PendingNativeInteractionSchema).optional(), terminalResult: z.lazy(() => ExecutionResultSchema).optional(),
  terminalTurn: z.object({ correlationId: z.string(), providerId: z.string(), result: z.lazy(() => ExecutionResultSchema) }).strict().optional(),
  interactionDeliveries: z.array(z.object({ nativeRequestId: z.string(), state: z.enum(['pending','submitting','submitted','uncertain']), selectedOptionId: z.string().optional() }).strict()).max(128).optional(),
  responseDeliveries: z.array(z.object({ source: z.enum(['provider_acknowledgement','provider_history']), harness: z.lazy(() => RecordedAgentHarnessSchema),
    providerVersion: z.string(), nativeSessionId: z.string(), nativeRequestId: z.string(), nativeRequestType: z.string(), optionId: z.string(),
    semantic: z.lazy(() => ApprovalResponseSemanticSchema), responseDigest: z.string().regex(/^[a-f0-9]{64}$/).optional()
  }).strict()).max(128).optional(), canceledRequestIds: z.array(z.string()).max(128).optional(),
}).strict()
/** Original terminal result and its declared command association only. Canonical
 * publication receipts, saved declarations and original lifetime ownership must
 * still be verified by the receiver before accepting any artifact digest. */
export const RemoteWorkflowPhysicalOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invalid-artifacts'), result: z.lazy(() => ExecutionResultSchema),
    failure: WorkflowArtifactValidationFailureSchema }).strict().superRefine((value, context) => {
    if (value.result.outcome !== 'succeeded') {
      context.addIssue({ code: 'custom', message: 'Artifact validation failure requires the original successful provider result.' })
    }
  }),
  z.object({ kind: z.literal('text-only'), result: z.lazy(() => ExecutionResultSchema).superRefine((value,context) => {
    if (value.output !== undefined && !z.object({ text: z.string() }).strict().safeParse(value.output).success)
      context.addIssue({ code: 'custom', message: 'Only the actual provider text-only result can attest zero result artifacts.' })
  }) }).strict(),
  z.object({ kind: z.literal('published-artifacts'), result: z.lazy(() => ExecutionResultSchema),
    artifactOutputs: WorkflowArtifactResultV1Schema }).strict().superRefine((value, context) => {
    try {
      canonicalGraphJson(value.result, 64 * 1024)
      if (value.result.outcome !== 'succeeded') throw new Error('successful original terminal result required')
      const output = z.object({ text: z.string() }).strict().parse(value.result.output)
      const envelope = z.union([WorkflowArtifactResultEnvelopeV1Schema, WorkflowChoiceArtifactResultEnvelopeV1Schema,
        WorkHandoffResultSchema]).parse(JSON.parse(output.text))
      if (canonicalGraphJson(envelope.artifactOutputs) !== canonicalGraphJson(value.artifactOutputs))
        throw new Error('artifact association differs from original terminal text')
    } catch {
      context.addIssue({ code: 'custom', message: 'Published artifacts require the exact bounded association in original successful native text.' })
    }
  }),
])
export type RemoteWorkflowPhysicalOutput = z.infer<typeof RemoteWorkflowPhysicalOutputSchema>

/** Association metadata from original text; Main still verifies publication and bytes. */
export function remoteWorkflowPhysicalOutput(result: z.infer<typeof ExecutionResultSchema>,
  declaration?: WorkflowArtifactOutputsV1, failure?: WorkflowArtifactValidationFailure): RemoteWorkflowPhysicalOutput {
  if (!declaration || result.outcome !== 'succeeded') {
    return RemoteWorkflowPhysicalOutputSchema.parse({ kind: 'text-only', result })
  }
  if (failure) return RemoteWorkflowPhysicalOutputSchema.parse({ kind: 'invalid-artifacts', result, failure })
  try {
    const native = z.object({ text: z.string() }).strict().parse(result.output)
    const envelope = z.object({ artifactOutputs: WorkflowArtifactResultV1Schema }).passthrough().parse(JSON.parse(native.text))
    const keys = new Set(envelope.artifactOutputs.outputs.map((output) => output.outputKey))
    if (keys.size !== declaration.outputKeys.length || declaration.outputKeys.some((key) => !keys.has(key))) {
      throw new Error('WORKFLOW_ARTIFACT_OUTPUT_KEYS_MISMATCH')
    }
    return RemoteWorkflowPhysicalOutputSchema.parse({ kind: 'published-artifacts', result,
      artifactOutputs: envelope.artifactOutputs })
  } catch {
    return RemoteWorkflowPhysicalOutputSchema.parse({ kind: 'invalid-artifacts', result,
      failure: { code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT', reason: 'invalid_result' } })
  }
}

export const RemoteWorkflowPhysicalReadoutSchema = z.object({ version: z.literal(1), expiresAt: z.string().datetime(), receipt: RemoteOperationReceiptSchema,
  launchIntent: DispatchIntentSchema.optional(),
  session: z.lazy(() => NativeSessionReferenceSchema), launch: RemoteNativeLaunchObservationSchema,
  observation: RemoteNativeLaunchObservationSchema, runtimeLeaf: RemoteRuntimeLeafAttestationSchema,
  source: z.object({ record: SourceMaterializationRecordSchema, workingTree: VerifiedSourceWorkingTreeSchema.extend({ cwdAttestation: SourceCwdAttestationSchema }) }).strict(),
  history: RemoteNativeHistorySchema.optional(),
  closure: z.object({ ownerClosed: z.literal(true), launch: RemoteNativeLaunchObservationSchema }).strict().optional(),
  output: RemoteWorkflowPhysicalOutputSchema.optional(),
}).strict()
export type RemoteWorkflowPhysicalReadout = z.infer<typeof RemoteWorkflowPhysicalReadoutSchema>
export const RemoteWorkflowPhysicalReadoutTransferSchema = z.union([
  RemoteWorkflowPhysicalReadoutSchema,
  z.object({ kind: z.literal('json-continuation'), metadata: DeviceJsonContinuationSchema }).strict(),
  z.object({ kind: z.literal('result-continuation'), metadata: RemotePhysicalJsonContinuationSchema }).strict(),
])
/** Cleanup acknowledgment, never evidence of native execution or success. */
export const RemoteWorkflowPhysicalAckSchema=z.object({version:z.literal(1),operationId:z.string().min(1),
  receiptSequence:z.number().int().positive(),sourceDigest:PlacementDigestSchema,status:z.enum(['retired','not_retained']),
}).strict()
export type RemoteWorkflowPhysicalAck=z.infer<typeof RemoteWorkflowPhysicalAckSchema>
