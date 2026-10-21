import { parseWorkHandoffArtifactResult } from '@foreman-code/contracts/wave25'
import { isDeepStrictEqual } from 'node:util'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { REMOTE_NATIVE_SOURCE_LIMIT } from '@foreman-code/contracts/remote-workflow-physical'
import { ArtifactAttemptSchema } from '@foreman-code/contracts/artifact-edges'
import { remoteWorkflowHasTurn, remoteWorkflowTurnId, type RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { WorkflowVersionV3Schema, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { parseWorkflowArtifactResult, type WorkflowArtifactResultV1 } from '@foreman-code/contracts/workflow-artifact-result'
import type { AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import { DomainError } from '../../errors.js'
import { assertOriginalWorkflowTerminal } from '../../interactions/workflowTerminalSource.js'
import { assertRepeatExecution, repeatDigest, repeatExecutionIdentity } from '../repeatResolution.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import type { NativeArtifactOutputs, NativeArtifactOutput } from './nativeArtifactOutputs.js'

export interface VerifiedWorkflowArtifactSource {
  version: WorkflowVersionV3
  execution: HarnessExecution
  proof: WorkflowNativeProofRecord
  sourceDigest: string
  remote: RemoteOperationReceipt
  publicationContext(commandId: string): Promise<AcceptedArtifactPublication>
  /** Recheck the retained original terminal, accepted dispatch/Run/version and
   * current authority. Positive original closure is not a replacement launch. */
  assertCurrent(): Promise<void>
}
export interface WorkflowArtifactResultSourcePort {
  /** Main-only genuine producer: retained original proof/capture/physical source,
   * exact Run version and original attempt/placement. Never worker proof JSON. */
  readVerified(accepted: AcceptedArtifactPublication): Promise<VerifiedWorkflowArtifactSource>
}
export type WorkflowArtifactAdoptionOutcome =
  | { status: 'unavailable'; reason: 'not_declared' }
  | { status: 'adopted'; outputs: NativeArtifactOutput[] }

const conflict = (): never => { throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_CONFLICT',
  'The original artifact result differs from the saved workflow or accepted native execution.', 409) }

/** Derives names/commands from the original terminal and saved contract only.
 * Runs outside G1: canonical byte reads and each immutable output bind retain
 * their existing authorization/transaction boundaries. HRT gates successful
 * result/successor acceptance on the complete durable adoption, not this array. */
export class WorkflowArtifactResultAdoption {
  constructor(private readonly source: WorkflowArtifactResultSourcePort,
    private readonly outputs: Pick<NativeArtifactOutputs, 'acceptOutput'>) {}

  async adoptOriginalOutputs(raw: AcceptedArtifactPublication): Promise<WorkflowArtifactAdoptionOutcome> {
    const accepted = structuredClone(raw)
    accepted.attempt = ArtifactAttemptSchema.parse(accepted.attempt)
    const original = await this.source.readVerified(structuredClone(accepted))
    // Snapshot before an authority await; a producer cannot change the value
    // being validated while a current-grant/ownership check is in flight.
    const snapshot = structuredClone({ version: original.version, execution: original.execution,
      proof: original.proof, sourceDigest: original.sourceDigest, remote: original.remote })
    await original.assertCurrent()
    const { proof } = snapshot
    const version = WorkflowVersionV3Schema.parse(snapshot.version), execution = HarnessExecutionSchema.parse(snapshot.execution)
    assertRepeatExecution(version, proof.scope, proof.ref, execution)
    if (snapshot.sourceDigest !== repeatDigest(proof, REMOTE_NATIVE_SOURCE_LIMIT)
      || proof.scope.workspaceId !== accepted.attempt.workspaceId || proof.scope.workflowId !== accepted.attempt.workflowId
      || proof.scope.runId !== accepted.attempt.runId || proof.ref.nodeId !== accepted.attempt.nodeId
      || execution.id !== accepted.attempt.executionId || !isDeepStrictEqual(proof.execution, repeatExecutionIdentity(execution))
      || proof.inputDigest !== repeatDigest(execution.input) || proof.commandId !== `execution:${execution.id}`
      || proof.session.nativeSessionId !== accepted.context.nativeSessionId
      || execution.nativeSessionId !== proof.session.nativeSessionId) return conflict()
    const node = version.definition.nodes.find(item => item.id === accepted.attempt.nodeId)
    if (!node || node.kind === 'job') return conflict()
    if (!node.artifactOutputs) return { status: 'unavailable', reason: 'not_declared' }
    if (proof.original.type !== 'history' || !proof.lane || !proof.closureGeneration) return conflict()
    const history = proof.original.history, terminal = history.terminalTurn
    const correlationId = snapshot.remote.turnInput?.correlationId ?? proof.commandId
    const turnId = remoteWorkflowTurnId(snapshot.remote, correlationId)
    if (!terminal || terminal.correlationId !== correlationId || history.correlationId !== correlationId
      || !terminal.providerId || terminal.providerId !== history.nativeTurnId || terminal.providerId !== proof.lane.providerId
      || terminal.providerId !== turnId || snapshot.remote.intent.executionId !== execution.id
      || snapshot.remote.intent.attemptId !== accepted.attempt.attemptId
      || snapshot.remote.intent.bindingHash !== accepted.attempt.placementHash
      || snapshot.remote.native?.sessionId !== proof.session.nativeSessionId
      || terminal.providerId !== accepted.context.turnId || history.pendingInteraction || history.pendingInteractions.length
      || accepted.context.nativeMessageId !== undefined && history.nativeMessageId !== accepted.context.nativeMessageId
      || execution.result !== undefined && !isDeepStrictEqual(execution.result, terminal.result)) return conflict()
    assertOriginalWorkflowTerminal(execution, proof.session, history, correlationId)
    let mappings: WorkflowArtifactResultV1['outputs']
    try {
      if (version.definition.handoffs) {
        mappings = parseWorkHandoffArtifactResult(terminal.result, node.artifactOutputs).artifactOutputs.outputs
      } else if (node.choice) {
        mappings = parseWorkflowArtifactResult(terminal.result, node.artifactOutputs, node.choice).artifactOutputs.outputs
      } else {
        mappings = parseWorkflowArtifactResult(terminal.result, node.artifactOutputs).artifactOutputs.outputs
      }
    } catch {
      // Parser details can contain model text. Surface a stable domain error.
      throw new DomainError('WORKFLOW_ARTIFACT_RESULT_INVALID', 'The original native result does not satisfy its saved artifact output contract.', 409)
    }
    const adopted: NativeArtifactOutput[] = []
    for (const mapping of mappings) {
      await original.assertCurrent()
      const publication = await original.publicationContext(mapping.commandId)
      if (!isDeepStrictEqual(publication.attempt, accepted.attempt)
        || !isDeepStrictEqual({ ...publication.context, turnId: accepted.context.turnId }, accepted.context)
        || !publication.context.turnId || !remoteWorkflowHasTurn(snapshot.remote,
          publication.context.nativeSessionId, publication.context.turnId)) return conflict()
      const output = await this.outputs.acceptOutput(publication, mapping.outputKey, mapping.commandId)
      await original.assertCurrent()
      adopted.push(output)
    }
    return { status: 'adopted', outputs: structuredClone(adopted) }
  }
}
