import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { WorkflowNativeProofServices } from '../src/modules/runs/workflowNativeProof.js'
import type { RepeatRepositoryActivation } from '../src/modules/runs/port.js'

/** Read/dispatch fixture only. No captured provider source or authority is fabricated. */
export function unavailableRuntime(): RepeatRepositoryActivation {
  const unavailable = (): never => { throw new Error('Native/authority work is outside this read fixture') }
  return { runtimeRoot: '/synthetic/runtime', native: new WorkflowNativeProofServices({ read: unavailable }), services: {
    assertNativeBoundaryLocked: unavailable, assertNativeUpdateLocked: unavailable,
    assertSettlementLocked: unavailable, allowTechnicalRetryLocked: unavailable, completeRunLocked: unavailable,
  } }
}

export function currentRepositoryFixture() {
  const f = makeCurrentWorkflowFixture('repository-dispatch')
  const run = AcceptedWorkflowRunV3Schema.parse({ ...f.run, authorizationPrincipalId: 'recording-principal',
    executionLocation: { runnerId: 'recording-runner', rootPath: '/synthetic/runtime', locationRevision: 1,
      identityHash: `sha256:${'a'.repeat(64)}` } })
  return { f, version: f.version, run }
}
