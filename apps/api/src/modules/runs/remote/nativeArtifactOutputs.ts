import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { ArtifactAttemptSchema, ArtifactEdgeBindingSchema, type ArtifactAttempt, type ArtifactEdgeBinding } from '@foreman-code/contracts/artifact-edges'
import { AgentFilePublishInputSchema, FileScopeSchema, TemporaryFileScopeSchema } from '@foreman-code/contracts/files'
import { VerifiedTransferReceiptSchema } from '@foreman-code/contracts/byte-transfer'
import type { AcceptedArtifactPublication, ArtifactPublicationAuthority } from '../../files/distributed/publication.js'
import type { CanonicalNativeArtifactResults, CanonicalNativeArtifactResult } from '../../files/distributed/nativeResults.js'
import type { ArtifactEdgeService } from '../../files/distributed/edges.js'
import type { FileQuery } from '../../files/repository.js'
import { fileScopeIdentity } from '../../files/requests.js'
import { DomainError } from '../../errors.js'

export const NativeArtifactOutputSchema = z.object({
  version: z.literal(1), producer: ArtifactAttemptSchema, outputKey: ArtifactEdgeBindingSchema.shape.outputKey,
  commandId: AgentFilePublishInputSchema.shape.commandId,
  nativeIdentity: z.object({ nativeSessionId: z.string().min(1), turnId: z.string().min(1).optional(),
    nativeMessageId: z.string().min(1).optional(), messageId: z.string().min(1).optional() }).strict(),
  publication: ArtifactEdgeBindingSchema.shape.publication, pins: ArtifactEdgeBindingSchema.shape.pins,
  scope: FileScopeSchema, transferReceipt: VerifiedTransferReceiptSchema,
}).strict()
export type NativeArtifactOutput = z.infer<typeof NativeArtifactOutputSchema>
export const LocalNativeArtifactOutputSchema = NativeArtifactOutputSchema.omit({ transferReceipt: true }).extend({
  scope: TemporaryFileScopeSchema,
  localPublication: z.object({ mainId: z.uuid(), executionId: z.string().min(1),
    attemptId: z.string().min(1), placementHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict()
export type LocalNativeArtifactOutput = z.infer<typeof LocalNativeArtifactOutputSchema>
export const WorkflowNativeArtifactOutputSchema = z.union([NativeArtifactOutputSchema, LocalNativeArtifactOutputSchema])
export type WorkflowNativeArtifactOutput = z.infer<typeof WorkflowNativeArtifactOutputSchema>
export interface NativeArtifactOutputRepository {
  /** Atomic first binding; a conflicting command, native identity or pin must fail. */
  bind(record: NativeArtifactOutput, authorize: (query: FileQuery) => Promise<void>,
    signal?: AbortSignal): Promise<NativeArtifactOutput>
  read(producer: ArtifactAttempt, outputKey: string): Promise<NativeArtifactOutput | undefined>
}
export type AcceptedNativeArtifactEdge = Omit<ArtifactEdgeBinding, 'version' | 'publication' | 'pins' | 'scope'>
const conflict = (): never => { throw new DomainError('NATIVE_ARTIFACT_OUTPUT_CONFLICT', 'The original native output binding differs from this accepted attempt.', 409) }
function nativeIdentity(accepted: AcceptedArtifactPublication) {
  const { nativeSessionId, turnId, nativeMessageId, messageId } = accepted.context
  return { nativeSessionId, ...(turnId ? { turnId } : {}), ...(nativeMessageId ? { nativeMessageId } : {}), ...(messageId ? { messageId } : {}) }
}
/** Main-only adoption. No output discovery, latest-revision selection, publication
 * allocation or native completion is inferred from a worker response. */
export class NativeArtifactOutputs {
  constructor(private readonly results: Pick<CanonicalNativeArtifactResults, 'readAccepted'>,
    private readonly outputs: NativeArtifactOutputRepository, private readonly authority: Pick<ArtifactPublicationAuthority, 'authorize'>,
    private readonly edges: Pick<ArtifactEdgeService, 'pinAccepted'>) {}
  private record(accepted: AcceptedArtifactPublication, outputKey: string, commandId: string, result: CanonicalNativeArtifactResult) {
    if (!isDeepStrictEqual(result.attempt, accepted.attempt) || !isDeepStrictEqual(result.nativeIdentity, nativeIdentity(accepted))
      || result.value.file.fileId !== result.pins.fileId || result.value.revision.revisionId !== result.pins.revisionId
      || result.value.revision.sha256 !== result.pins.sha256 || result.value.revision.byteSize !== result.pins.byteSize
      || fileScopeIdentity(result.value.file.scope) !== fileScopeIdentity(accepted.context.scope)) return conflict()
    const receipt = result.transferReceipt
    if (receipt.intent.executionId !== accepted.attempt.executionId || receipt.intent.attemptId !== accepted.attempt.attemptId
      || receipt.intent.placementHash !== accepted.attempt.placementHash || receipt.sha256 !== result.pins.sha256
      || receipt.byteSize !== result.pins.byteSize) return conflict()
    return NativeArtifactOutputSchema.parse({ version: 1, producer: result.attempt, outputKey, commandId,
      nativeIdentity: result.nativeIdentity, publication: result.publication, pins: result.pins,
      scope: result.value.file.scope, transferReceipt: receipt })
  }
  private async authorize(accepted: AcceptedArtifactPublication, record: NativeArtifactOutput, query?: FileQuery) {
    const caller = await this.authority.authorize(accepted, query)
    if (caller.principal.id !== record.publication.ownerPrincipalId || caller.binding !== record.publication.binding
      || !caller.context.allowedTools.includes('files.list') || !isDeepStrictEqual(nativeIdentity({ ...accepted, context: caller.context }), record.nativeIdentity)
      || fileScopeIdentity(caller.context.scope) !== fileScopeIdentity(record.scope)) return conflict()
  }
  async acceptOutput(accepted: AcceptedArtifactPublication, outputKey: string, commandId: string): Promise<NativeArtifactOutput> {
    const record = this.record(accepted, outputKey, commandId, await this.results.readAccepted(accepted, commandId))
    const bound = await this.outputs.bind(record, query => this.authorize(accepted, record, query))
    if (!isDeepStrictEqual(bound, record)) return conflict()
    return structuredClone(bound)
  }
  async readOutput(accepted: AcceptedArtifactPublication, outputKey: string): Promise<NativeArtifactOutput> {
    const producer = ArtifactAttemptSchema.parse(accepted.attempt)
    outputKey = ArtifactEdgeBindingSchema.shape.outputKey.parse(outputKey)
    const raw = await this.outputs.read(producer, outputKey)
    if (!raw) throw new DomainError('NATIVE_ARTIFACT_OUTPUT_PENDING', 'The original native output has not been bound.', 409)
    const original = NativeArtifactOutputSchema.parse(raw)
    if (!isDeepStrictEqual(original.producer, producer) || original.outputKey !== outputKey) return conflict()
    const publication = { ...accepted, context: { ...accepted.context, ...original.nativeIdentity } }
    const current = this.record(publication, outputKey, original.commandId,
      await this.results.readAccepted(publication, original.commandId))
    if (!isDeepStrictEqual(current, original)) return conflict()
    await this.authorize(publication, original)
    return structuredClone(original)
  }
  async pinEdge(accepted: AcceptedArtifactPublication, edge: AcceptedNativeArtifactEdge): Promise<ArtifactEdgeBinding> {
    if (!isDeepStrictEqual(edge.producer, accepted.attempt)) return conflict()
    const original = await this.readOutput(accepted, edge.outputKey)
    return this.edges.pinAccepted(ArtifactEdgeBindingSchema.parse({ ...edge, version: 1,
      publication: original.publication, pins: original.pins, scope: original.scope }))
  }
}
