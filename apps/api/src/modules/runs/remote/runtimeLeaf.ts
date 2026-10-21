import { readNativeExecutionBinding } from '../../placement/executionBinding.js'
import { posix } from 'node:path'
import { z } from 'zod'
import { PlacementDigestSchema, type AcceptedNodePlacement, type DispatchIntent, type NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'

export const RuntimeLeafAttestationSchema = z.object({
  executionId: z.string().min(1), attemptId: z.string().min(1), operationId: z.string().min(1), bindingHash: PlacementDigestSchema,
  canonicalRuntimeDirectory: z.string().startsWith('/'), directoryIdentityHash: PlacementDigestSchema,
  materializationId: z.string().min(1), materializationDigest: PlacementDigestSchema,
}).strict()
export type RuntimeLeafAttestation = z.infer<typeof RuntimeLeafAttestationSchema>
export function assertRuntimeLeafPath(runtimeDirectory: string, placement: AcceptedNodePlacement) {
  const base = placement.destination.managedRuntimeRoot, project = placement.destination.canonicalProjectRoot
  if (runtimeDirectory.includes('\0') || !posix.isAbsolute(runtimeDirectory) || posix.normalize(runtimeDirectory) !== runtimeDirectory
    || runtimeDirectory === base || !runtimeDirectory.startsWith(`${base === '/' ? '' : base}/`)
    || runtimeDirectory === project || runtimeDirectory.startsWith(`${project === '/' ? '' : project}/`)) throw new Error('Exact runtime leaf must be a native canonical descendant of the accepted base')
}
export function assertRuntimeLeafBinding(raw: RuntimeLeafAttestation, runtimeDirectory: string, intent: DispatchIntent, placement: AcceptedNodePlacement, executionPlacement?: NativeExecutionPlacement) {
  assertRuntimeLeafPath(runtimeDirectory, placement)
  const proof = RuntimeLeafAttestationSchema.parse(raw)
  const native = 'kind' in placement.source && placement.source.kind === 'pending'
    ? readNativeExecutionBinding(placement, intent, executionPlacement) : undefined
  const original = 'materializationId' in placement.source ? placement.source : undefined
  const materializationId = native?.materialization.receipt.materializationId ?? original?.materializationId
  const materializationDigest = native?.workingTree.materializationDigest ?? original?.materializationDigest
  if (proof.canonicalRuntimeDirectory !== runtimeDirectory || proof.executionId !== intent.executionId || proof.attemptId !== intent.attemptId
    || proof.operationId !== intent.operationId || proof.bindingHash !== (native?.bindingHash ?? intent.bindingHash) || proof.materializationId !== materializationId
    || proof.materializationDigest !== materializationDigest) throw new Error('Runtime leaf attestation does not own this immutable operation')
}
