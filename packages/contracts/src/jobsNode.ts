import { createHash } from 'node:crypto'
import type { PreparedJobSpecRecord, JobAcceptedSpecRecord } from './jobVerification.js'
import type { RunInput } from './schemaPrimitives.js'
import { canonicalGraphJson } from './wave25/json.js'
const hash = (value: unknown) => createHash('sha256').update(canonicalGraphJson(value)).digest('hex')

/** Node-only producer/executor identity. Browser contracts never import this entrypoint. */
export function jobSpecDigests(spec: PreparedJobSpecRecord, workflowInput: RunInput | null) {
  const prepared = {
    source: spec.source,
    target: spec.target,
    argv: spec.argv,
    inputs: spec.inputs,
    policy: spec.policy,
    outputs: spec.outputs,
    ...(spec.computerSelection ? { computerSelection: spec.computerSelection } : {}),
    ...(spec.relativeCwd ? { relativeCwd: spec.relativeCwd } : {}),
    ...('verification' in spec ? { verification: spec.verification } : {}),
  }
  return {
    scriptDigest: hash(prepared.argv),
    outputSpecDigest: hash(prepared.outputs),
    specDigest: hash({ ...prepared, workflowInput }),
    bindingHash: hash({ target: prepared.target, source: prepared.source }),
  }
}

/** Verification binds its measured profile and original capacity reservation into acceptance. */
export function acceptedJobSpecDigests(spec: JobAcceptedSpecRecord) {
  if (!('verification' in spec)) return jobSpecDigests(spec, spec.workflowInput)
  const digests = jobSpecDigests(spec, spec.workflowInput)
  return {
    ...digests,
    specDigest: hash({
      preparedDigest: digests.specDigest,
      profile: spec.profile,
      reservationId: spec.reservationId,
      lifecycle: spec.lifecycle,
      resourcePolicyRevision: spec.resourcePolicyRevision,
      resourcePolicyDigest: spec.resourcePolicyDigest,
      runtimeApprovalId: spec.runtimeApprovalId,
      runtimeApprovalRevision: spec.runtimeApprovalRevision,
    }),
    bindingHash: hash({ preparedBindingHash: digests.bindingHash, profile: spec.profile,
      reservationId: spec.reservationId }),
  }
}
