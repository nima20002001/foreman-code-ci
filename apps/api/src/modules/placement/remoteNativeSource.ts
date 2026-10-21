import { createHash } from 'node:crypto'
import type { HarnessExecution } from '@foreman-code/contracts'
import { canonicalGraphJson, sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { REMOTE_NATIVE_SOURCE_LIMIT } from '@foreman-code/contracts/remote-workflow-physical'
import { VerifiedRemoteEvidence } from '../runs/remote/resultBridge.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { beforeGraphCommit, isGraphTransactionFinalizing } from '../run-graph/connection.js'
import type { WorkflowOriginalNativeSource } from '../interactions/workflowNativeCapture.js'
import { DomainError } from '../errors.js'

export interface RemoteNativeSourceEvidence { readonly provenance: 'remote'; readonly sourceDigest: string }
export interface VerifiedRemoteOriginalSource {
  readonly verified: VerifiedRemoteEvidence
  readonly source: WorkflowOriginalNativeSource
  readonly sourceDigest: string
  assertCurrent(): void
}
export interface RemoteNativeSourceVerification { read(evidence: RemoteNativeSourceEvidence): VerifiedRemoteOriginalSource }
export interface RemoteNativePhysicalVerification {
  /** Main SQL-only consumer of actual W11 original process/session/turn/closure
   * and W09 result/artifact attestations. A receipt digest or main control lane
   * is not physical proof; an absent verifier cannot authorize publication.
   * It locks the current dispatch and requires it to equal the original receipt's intent. */
  assertOriginal(sql: GraphTransactionSql, owner: RunOwnership, original: VerifiedRemoteOriginalSource): Promise<void>
}
export interface RemoteNativeBatchPhysicalVerification extends RemoteNativePhysicalVerification {
  assertOriginals(sql: GraphTransactionSql, owner: RunOwnership,
    originals: readonly VerifiedRemoteOriginalSource[]): Promise<void>
}

const digest = (source: WorkflowOriginalNativeSource) => createHash('sha256')
  .update(canonicalGraphJson(source, REMOTE_NATIVE_SOURCE_LIMIT)).digest('hex')
const conflict = (): never => { throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'Native source must originate in the configured authenticated remote producer.', 409) }

/** Paired private producer/capture/verifier, analogous to the existing private
 * local channel. HTTP/MCP and other channel instances cannot mint this writer's
 * capabilities. Production gives observe ONLY to its actual signed RPC proxy. */
export function createRemoteNativeSourceChannel(): {
  observe(verified: VerifiedRemoteEvidence, source: WorkflowOriginalNativeSource, assertOriginalProducer: () => void): void
  capture(executionId: string, source: WorkflowOriginalNativeSource): RemoteNativeSourceEvidence
  verify: RemoteNativeSourceVerification
  forget(executionId: string, source: WorkflowOriginalNativeSource): void
  release(executionId: string): void
} {
  const observations = new Map<string, Map<string, VerifiedRemoteOriginalSource>>()
  const issued = new WeakMap<object, VerifiedRemoteOriginalSource>()
  const generations = new Map<string, object>()
  return {
    observe(verified, source, assertOriginalProducer) {
      if (!(verified instanceof VerifiedRemoteEvidence) || !verified.receipt.native) return conflict()
      assertOriginalProducer()
      const copy = JSON.parse(canonicalGraphJson(source, REMOTE_NATIVE_SOURCE_LIMIT)) as WorkflowOriginalNativeSource
      const id = verified.receipt.intent.executionId, key = digest(copy), native = verified.receipt.native
      const correlation = copy.type === 'history' ? copy.history.correlationId : undefined
      const review = verified.receipt.reviewTurns?.find(turn => turn.assignment.correlationId === correlation)
      const providerId = review ? review.providerId : native.turnId
      if (copy.type === 'session_created' && copy.session.nativeSessionId !== native.sessionId
        || copy.type === 'event' && copy.event.executionId !== id
        || copy.type === 'history' && (correlation !== undefined
          && correlation !== (verified.receipt.turnInput?.correlationId ?? `execution:${id}`) && !review
          || copy.history.nativeTurnId !== undefined && copy.history.nativeTurnId !== providerId)) return conflict()
      const entries = observations.get(id) ?? new Map<string, VerifiedRemoteOriginalSource>()
      const generation = generations.get(id) ?? Object.freeze({})
      generations.set(id, generation)
      const receiptDigest = createHash('sha256').update(canonicalGraphJson(verified.receipt)).digest('hex')
      if (!entries.has(key) && entries.size >= 1024) throw new DomainError('REMOTE_NATIVE_SOURCE_BACKPRESSURE', 'The original native source capture window is full.', 503)
      const original: VerifiedRemoteOriginalSource = Object.freeze({ verified, source: copy, sourceDigest: key, assertCurrent: () => {
        assertOriginalProducer()
        if (generations.get(id) !== generation || digest(copy) !== key
          || createHash('sha256').update(canonicalGraphJson(verified.receipt)).digest('hex') !== receiptDigest) return conflict()
      } })
      entries.set(key, original); observations.set(id, entries)
    },
    capture(executionId, source) {
      const sourceDigest = digest(source), original = observations.get(executionId)?.get(sourceDigest)
      if (!original) return conflict()
      original.assertCurrent()
      const evidence: RemoteNativeSourceEvidence = Object.freeze({ provenance: 'remote', sourceDigest })
      issued.set(evidence, original)
      observations.get(executionId)?.delete(sourceDigest)
      return evidence
    },
    verify: { read(evidence) {
      const original = issued.get(evidence)
      if (!original || original.sourceDigest !== evidence.sourceDigest) return conflict()
      original.assertCurrent(); return original
    } },
    forget(executionId, source) { observations.get(executionId)?.delete(digest(source)) },
    release(executionId) { observations.delete(executionId); generations.delete(executionId) },
  }
}

/** Existing canonical writer calls this alongside its actual main coordinator
 * and control-lane checks, not instead of them. Remote physical provenance is
 * separately mandatory and remains branded; no local native capture cast. */
export async function assertRemoteNativeSourceLocked(sql: GraphTransactionSql, owner: RunOwnership,
  execution: HarnessExecution, source: WorkflowOriginalNativeSource, evidence: RemoteNativeSourceEvidence,
  verification: RemoteNativeSourceVerification, physical: RemoteNativePhysicalVerification, registerCommitFence = true): Promise<void> {
  const original = verification.read(evidence), receipt = original.verified.receipt
  if (owner.runId !== execution.runId || receipt.intent.runId !== owner.runId || receipt.intent.executionId !== execution.id
    || receipt.intent.nodeId !== execution.workflowNodeId || !sameWorkflowValue(original.source, source)
    || receipt.native?.sessionId !== execution.nativeSessionId && source.type !== 'session_created') return conflict()
  const fence = await owner.readOneShotFence(sql)
  // assertOriginal reads the locked current dispatch and requires it to equal this original receipt's intent.
  const verify = async () => {
    owner.assertOwned(); original.assertCurrent()
    if (!sameWorkflowValue(fence, await owner.readOneShotFence(sql))) return conflict()
    await physical.assertOriginal(sql, owner, original)
  }
  await verify()
  // One COMMIT check per original and transaction. A call made by a COMMIT check is already final.
  if (!registerCommitFence || isGraphTransactionFinalizing(sql)) return
  let fenced = commitFences.get(sql)
  if (!fenced) commitFences.set(sql, fenced = new WeakSet())
  if (fenced.has(original)) return
  fenced.add(original)
  beforeGraphCommit(sql, verify)
}
const commitFences = new WeakMap<GraphTransactionSql, WeakSet<VerifiedRemoteOriginalSource>>()


/** Share the owner read and original-source readback across one native frame group. */
export async function assertRemoteNativeSourcesLocked(sql: GraphTransactionSql, owner: RunOwnership,
  captures: readonly { execution: HarnessExecution; source: WorkflowOriginalNativeSource;
    evidence: RemoteNativeSourceEvidence }[], verification: RemoteNativeSourceVerification,
  physical: RemoteNativeBatchPhysicalVerification): Promise<void> {
  if (!captures.length) return
  const originals = captures.map(({ execution, source, evidence }) => {
    const original = verification.read(evidence)
    const receipt = original.verified.receipt
    if (owner.runId !== execution.runId || receipt.intent.runId !== owner.runId
      || receipt.intent.executionId !== execution.id || receipt.intent.nodeId !== execution.workflowNodeId
      || !sameWorkflowValue(original.source, source)
      || receipt.native?.sessionId !== execution.nativeSessionId && source.type !== 'session_created') return conflict()
    return original
  })
  const fence = await owner.readOneShotFence(sql)
  const verify = async (sources: readonly VerifiedRemoteOriginalSource[]) => {
    owner.assertOwned()
    for (const original of sources) original.assertCurrent()
    if (!sameWorkflowValue(fence, await owner.readOneShotFence(sql))) return conflict()
    await physical.assertOriginals(sql, owner, sources)
  }
  await verify(originals)
  if (isGraphTransactionFinalizing(sql)) return
  let fenced = commitFences.get(sql)
  if (!fenced) commitFences.set(sql, fenced = new WeakSet())
  const pending = originals.filter(original => !fenced.has(original))
  for (const original of pending) fenced.add(original)
  if (pending.length) beforeGraphCommit(sql, () => verify(pending))
}
