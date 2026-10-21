import { z } from 'zod'
import { AgentConfigurationVersionSchema } from './index.js'
import { HostHarnessOverrideSchema, HostHarnessProfileEvidenceSchema, HostHarnessInstallationSchema } from './harnessRegistry.js'
import { RecordedHarnessQualificationSchema } from './harnessQualification.js'
import { NativeExecutionPlacementSchema, AcceptedNodePlacementSchema, DispatchIntentSchema } from './nodePlacement.js'
import { RemoteReviewerRequestSchema, RemoteOwnerControlSchema } from './remoteExecution.js'
import { DEVICE_APPLICATION_JSON_BYTES } from './deviceApplication.js'
export const ExecutionAuthorityRequestSchema = z.object({ version: z.literal(1),
  action: z.enum(['start', 'read', 'control', 'stop', 'retain-reviewer', 'review']),
  intent: DispatchIntentSchema, placement: AcceptedNodePlacementSchema, review: RemoteReviewerRequestSchema.optional(),
  workflowControl: RemoteOwnerControlSchema.optional(),
}).strict()
export const ExecutionAuthorityResultSchema = z.object({ version: z.literal(1),
  action: z.enum(['start', 'read', 'control', 'stop', 'retain-reviewer', 'review']), operationId: z.string().min(1), attemptId: z.string().min(1),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/), owner: DispatchIntentSchema.shape.owner,
  // Original-owner observation/Stop only; never extends the model's application credential.
  cleanupOnly: z.literal(true).optional(),
  workflowControlCommandId: z.string().min(1).optional(),
  reviewer: z.object({ agentId: z.string().min(1), expiresAt: z.string().datetime() }).strict().optional(),
}).strict()
export const EXECUTION_AUTHORITY_EXTENSION = { namespace: 'execution-authority-v1', version: 1 as const,
  role: 'duplex' as const, maxJsonBytes: DEVICE_APPLICATION_JSON_BYTES, maxBinaryBytes: 0 }

export const ExecutionFactsRequestSchema = z.object({ method: z.literal('read-facts'), authorization: ExecutionAuthorityRequestSchema }).strict().refine(value => value.authorization.action === 'read')
export const ExecutionFactsResultSchema = z.object({ version: z.literal(1), intent: DispatchIntentSchema, placement: AcceptedNodePlacementSchema,
  executionPlacement: NativeExecutionPlacementSchema, configuration: z.lazy(() => AgentConfigurationVersionSchema),
  harness: z.object({ override: HostHarnessOverrideSchema, profileProof: HostHarnessProfileEvidenceSchema,
    installation: HostHarnessInstallationSchema, qualification: RecordedHarnessQualificationSchema }).strict(),
}).strict()
