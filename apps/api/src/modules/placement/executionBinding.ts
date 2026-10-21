import { NativeExecutionPlacementSchema, type AcceptedNodePlacement, type DispatchIntent, type NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import type { SourceMaterializationRecord, VerifiedSourceWorkingTree } from '@foreman-code/contracts/source-admission'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { posix } from 'node:path'
import { DomainError } from '../errors.js'
import { placementDigest, readPlacement } from './binding.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { assertWorktreeReceipt } from '../sources/worktreeRequest.js'
function sourceMaterializationDigest(record: SourceMaterializationRecord): string {
  return commandInputHash({ receipt: record.receipt, sourceBindingHash: record.sourceBindingHash,
    rootPolicyId: record.rootPolicyId, rootPolicyRevision: record.rootPolicyRevision,
    operationId: record.operationId, reservationId: record.reservationId }).slice('sha256:'.length)
}

export function nativePlacementDigest(input: Omit<NativeExecutionPlacement, 'bindingHash'>): string {
  const record = input.materialization
  return placementDigest({ ...input, materialization: { receipt: record.receipt, sourceBindingHash: record.sourceBindingHash,
    rootPolicyId: record.rootPolicyId, rootPolicyRevision: record.rootPolicyRevision, operationId: record.operationId, reservationId: record.reservationId } })
}
export function bindNativeExecution(placement: AcceptedNodePlacement, intent: DispatchIntent,
  materialization: SourceMaterializationRecord, workingTree: VerifiedSourceWorkingTree): NativeExecutionPlacement {
  const input = { version: 1 as const, acceptedBindingHash: placement.bindingHash, runId: intent.runId, nodeId: intent.nodeId,
    executionId: intent.executionId, attemptId: intent.attemptId, operationId: intent.operationId, materialization, workingTree }
  return readNativeExecutionBinding(placement, intent, { ...input, bindingHash: nativePlacementDigest(input) })
}
export function readNativeExecutionBinding(parent: AcceptedNodePlacement, intent: DispatchIntent, raw: unknown): NativeExecutionPlacement {
  const placement = readPlacement(parent), binding = NativeExecutionPlacementSchema.parse(raw), { bindingHash, ...input } = binding
  const receipt = binding.materialization.receipt
  if (placement.payload.kind === 'agent' && placement.payload.worktree) {
    assertWorktreeReceipt(receipt, placement.payload.worktree)
  }
  const source = placement.source
  if (!('kind' in source) || source.kind !== 'pending' || placement.bindingHash !== intent.bindingHash
    || bindingHash !== nativePlacementDigest(input) || binding.acceptedBindingHash !== placement.bindingHash
    || binding.runId !== placement.runId || binding.runId !== intent.runId || binding.nodeId !== placement.nodeId
    || binding.nodeId !== intent.nodeId || binding.executionId !== intent.executionId || binding.attemptId !== intent.attemptId
    || binding.operationId !== intent.operationId || binding.materialization.operationId !== intent.operationId
    || receipt.executionId !== intent.executionId || receipt.attemptId !== intent.attemptId
    || binding.materialization.sourceBindingHash !== receipt.placementHash
    || receipt.binding.rootId !== source.rootId || receipt.binding.bindingRevision !== source.bindingRevision
    || receipt.binding.snapshotId !== source.snapshotId || receipt.binding.manifestDigest !== source.manifestDigest
    || binding.materialization.rootPolicyId !== placement.destination.rootPolicyId
    || binding.materialization.rootPolicyRevision !== placement.destination.rootPolicyRevision
    || receipt.keyRevision !== (placement.registration?.keyRevision ?? null)
    || receipt.authorizationRevision !== (placement.registration?.authorizationRevision ?? null)
    || receipt.binding.mainId !== placement.mainId
    || receipt.binding.deviceId !== (placement.hostRef.kind === 'device' ? placement.hostRef.deviceId : null)
    || binding.workingTree.materializationId !== receipt.materializationId
    || binding.workingTree.materializationDigest !== sourceMaterializationDigest(binding.materialization)
    || !sameWorkflowValue(binding.workingTree.filesystem, receipt.localTreeIdentity)) {
    throw new DomainError('EXECUTION_PLACEMENT_CONFLICT', 'Native source must be the exact materialized accepted execution.', 409)
  }
  const proof = binding.workingTree.cwdAttestation
  if (!proof) throw new DomainError('EXECUTION_CWD_ATTESTATION_REQUIRED', 'An actual host CWD attestation is required.', 409)
  const { attestationDigest, ...fields } = proof
  const relativeCwd = posix.relative(placement.destination.canonicalProjectRoot, placement.destination.canonicalCwd)
  if (attestationDigest !== commandInputHash(fields).slice('sha256:'.length)
    || proof.materializationId !== receipt.materializationId || proof.executionId !== intent.executionId
    || proof.attemptId !== intent.attemptId || proof.operationId !== intent.operationId
    || proof.sourceBindingHash !== binding.materialization.sourceBindingHash || proof.relativeCwd !== relativeCwd
    || proof.canonicalCwd !== posix.join(binding.workingTree.canonicalProjectRoot, relativeCwd)
    || binding.workingTree.canonicalCwd !== proof.canonicalCwd || binding.workingTree.directoryIdentityHash !== proof.directoryIdentityHash
    || proof.accessMode !== receipt.binding.accessMode || binding.workingTree.accessMode !== proof.accessMode) {
    throw new DomainError('EXECUTION_CWD_CONFLICT', 'Native CWD must match the exact retained host child-directory attestation.', 409)
  }
  return binding
}
