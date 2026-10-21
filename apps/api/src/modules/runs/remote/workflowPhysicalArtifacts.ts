import { createHash } from 'node:crypto'
import { isDeepStrictEqual as same } from 'node:util'
import { ArtifactAttemptSchema } from '@foreman-code/contracts/artifact-edges'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { VerifiedTransferReceiptSchema } from '@foreman-code/contracts/byte-transfer'
import { SavedRunVersionSnapshotSchema, canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { workflowArtifactDigestsByOutputKey } from '@foreman-code/contracts/workflow-artifact-result'
import { remoteWorkflowPhysicalOutput, type RemoteWorkflowPhysicalReadout } from '@foreman-code/contracts/remote-workflow-physical'
import { workflowArtifactTransferManifestDigest } from '@foreman-code/contracts/workflow-artifact-transfer-node'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { assertGraphTransaction, poisonGraphTransaction, type GraphTransactionSql } from '../../run-graph/connection.js'
import { transferContextForBinding } from '../../byte-transfer/carrier.js'
import type { PostgresFileRepository } from '../../files/postgres.js'
import type { DistributedPublicationLink } from '../../files/distributed/publicationLedger.js'
import { digest } from '../../files/tools/context.js'
import { fileScopeIdentity } from '../../files/requests.js'
import type { PostgresArtifactPublicationAuthority } from './nativeArtifactAuthority.js'
import { NativeArtifactOutputSchema, type NativeArtifactOutput } from './nativeArtifactOutputs.js'
import { DomainError } from '../../errors.js'
import { remoteWorkflowHasTurn } from '@foreman-code/contracts/remote-execution'
import { workflowArtifactResult } from '../workflowCoordinationResult.js'

export interface WorkflowPhysicalArtifactsPort {
  assertPublications(sql: GraphTransactionSql, readout: RemoteWorkflowPhysicalReadout, binding: Readonly<DeviceSessionBinding>): Promise<void>
  assertAdopted(sql: GraphTransactionSql, readout: RemoteWorkflowPhysicalReadout, binding: Readonly<DeviceSessionBinding>): Promise<void>
}
interface Ports {
  authority: Pick<PostgresArtifactPublicationAuthority,
    'resolveWorkflowContext' | 'authorize' | 'authorizePublication' | 'assertSourceLive'>
  files: Pick<PostgresFileRepository, 'read'>
}
const unavailable = (): never => { throw new DomainError('REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE',
  'Exact original declared canonical publications and artifact evidence are required.', 409) }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
/** SQL metadata companion to the original physical verifier. Canonical byte validation
 * remains outside G1 in W09 adoption; echoed worker pins are never an input here. */
export class PostgresWorkflowPhysicalArtifacts implements WorkflowPhysicalArtifactsPort {
  constructor(private readonly mainId: string, private readonly ports: Ports) {}
  async assertPublications(sql: GraphTransactionSql, readout: RemoteWorkflowPhysicalReadout, binding: Readonly<DeviceSessionBinding>) {
    await this.verify(sql, readout, binding, false)
  }
  async assertAdopted(sql: GraphTransactionSql, readout: RemoteWorkflowPhysicalReadout, binding: Readonly<DeviceSessionBinding>) {
    await this.verify(sql, readout, binding, true)
  }
  private async verify(sql: GraphTransactionSql, readout: RemoteWorkflowPhysicalReadout, binding: Readonly<DeviceSessionBinding>, adopted: boolean) {
    assertGraphTransaction(sql)
    try {
      const { receipt, output } = readout, intent = receipt.intent
      if ((output?.kind !== 'published-artifacts' && output?.kind !== 'invalid-artifacts')
        || !receipt.terminal?.result || receipt.terminal.kind !== 'completed'
        || !same(output.result, receipt.terminal.result) || !receipt.native?.turnId || intent.mainId !== this.mainId) return unavailable()
      const row = (await sql.query<{ run: unknown; version: unknown }>(`select r.record as run,v.record as version
        from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=$1
        and v.execution_semantics_version=3 for share of r,v`, [intent.runId])).rows[0]
      if (!row) return unavailable()
      const {run,version} = SavedRunVersionSnapshotSchema.parse(row)
      const node = version.definition.nodes.find(item => item.id === intent.nodeId)
      if (run.id !== intent.runId || run.workflowVersionId !== version.id || run.workspaceId !== version.workspaceId
        || run.workflowId !== version.workflowId || !node || node.kind === 'job' || !node.artifactOutputs
        || run.agentConfigurationVersionIds[node.agentId] !== version.agentConfigurationVersionIds[node.agentId]) return unavailable()
      if (output.kind === 'published-artifacts' && output.resultProtocol !== run.resultProtocol) return unavailable()
      if (output.kind === 'invalid-artifacts') {
        if (adopted || !same(output.failure, receipt.terminal.artifactValidationError)
          || (receipt.terminal.artifactDigests?.length ?? 0) !== 0) return unavailable()
        const derived = remoteWorkflowPhysicalOutput(output.result, node.artifactOutputs, undefined, run.resultProtocol)
        if (output.failure.reason === 'invalid_result') {
          if (derived.kind !== 'invalid-artifacts' || !same(derived.failure, output.failure)) return unavailable()
          return
        }
        if (derived.kind !== 'published-artifacts') return unavailable()
        const attempt = ArtifactAttemptSchema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
          runId: run.id, nodeId: node.id, executionId: intent.executionId,
          attemptId: intent.attemptId, placementHash: intent.bindingHash })
        const accepted = await this.ports.authority.resolveWorkflowContext(attempt, transferContextForBinding(binding), sql)
        const caller = await this.ports.authority.authorize(accepted, sql)
        if (caller.context.nativeSessionId !== receipt.native.sessionId
          || caller.context.turnId !== receipt.native.turnId) return unavailable()
        for (const mapping of derived.artifactOutputs.outputs) {
          const publication = await sql.query<{ record: DistributedPublicationLink }>(`select record from file_tool_publications
            where owner_principal_id=$1 and request_id=$2 for share`,
          [caller.principal.id, `fil05:remote:${digest(mapping.commandId)}`])
          if (publication.rowCount === 0) return
          if (publication.rowCount !== 1) return unavailable()
          const original = { ...accepted, context: publication.rows[0]!.record.context }
          const publisher = await this.ports.authority.authorizePublication(original, sql)
          if (publisher.binding !== publication.rows[0]!.record.binding || !original.context.turnId
            || !remoteWorkflowHasTurn(receipt, original.context.nativeSessionId, original.context.turnId)) return unavailable()
        }
        return unavailable()
      }
      if (receipt.terminal.artifactValidationError) return unavailable()
      const declaration = (() => {
        try {
          return workflowArtifactResult(output.result, version, node.id, run.resultProtocol)
        } catch { return unavailable() }
      })()
      if (!same(declaration, output.artifactOutputs)) return unavailable()
      const attempt = ArtifactAttemptSchema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
        nodeId: node.id, executionId: intent.executionId, attemptId: intent.attemptId, placementHash: intent.bindingHash })
      const accepted = await this.ports.authority.resolveWorkflowContext(attempt, transferContextForBinding(binding), sql)
      const caller = await this.ports.authority.authorize(accepted, sql)
      if (caller.context.nativeSessionId !== receipt.native.sessionId || caller.context.turnId !== receipt.native.turnId
        || !caller.context.allowedTools.includes('files.list') || !same(accepted.attempt, attempt)) return unavailable()
      const records: NativeArtifactOutput[] = []
      for (const mapping of declaration.outputs) {
        const requestId = `fil05:remote:${digest(mapping.commandId)}`
        const publication = await sql.query<{ record: DistributedPublicationLink;file_id:string;revision_id:string }>(`select p.record,p.file_id,p.revision_id from file_tool_publications p
          join file_allocations a on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id
          join files f on f.file_id=p.file_id join file_revisions r on r.file_id=f.file_id and r.revision_id=p.revision_id
          where p.owner_principal_id=$1 and p.request_id=$2 and f.owner_principal_id=p.owner_principal_id
          and a.file_id=p.file_id and a.revision_id=p.revision_id and a.state='finalized'
          and f.state='ready' and f.scope_kind='temporary' and f.expires_at>clock_timestamp() for share of p,a,f,r`,
        [caller.principal.id, requestId])
        const joined=publication.rows[0],link = joined?.record
        if (publication.rowCount !== 1 || !link || !link.context.turnId
          || !remoteWorkflowHasTurn(receipt, link.context.nativeSessionId, link.context.turnId)) return unavailable()
        const publicationContext = { ...accepted, context: link.context }
        const publisher = await this.ports.authority.authorizePublication(publicationContext, sql)
        if (publication.rowCount !== 1 || !link || link.ownerPrincipalId !== caller.principal.id || link.requestId !== requestId
          || link.binding !== publisher.binding || !same(link.context, publisher.context) || !link.publicationInputHash
          ||link.ref.fileId!==joined?.file_id||link.ref.revisionId!==joined?.revision_id) return unavailable()
        const transfer = VerifiedTransferReceiptSchema.parse(link.transferReceipt)
        await this.ports.authority.assertSourceLive(accepted, transfer, sql)
        const admission = await sql.query<{principal_id:string;command_id:string;input_hash:string;target_key:string;
          result: {workerPrincipalId:string; accepted: typeof accepted; declaration: { commandId: string; sha256: string; byteSize: number }; intent: typeof transfer.intent } }>(
          `select principal_id,command_id,input_hash,target_key,result from management_command_receipts where operation='remote.artifact-transfer.admit'
            and result->'intent'->>'transferId'=$1 for share`, [transfer.transferId])
        const admitted=admission.rows[0],original = admitted?.result
        if (admission.rowCount !== 1 || !original || !same(original.intent, transfer.intent) || !same(original.accepted.attempt, attempt)
          ||!original.workerPrincipalId||admitted?.principal_id!==original.workerPrincipalId||admitted.command_id!==mapping.commandId
          ||admitted.target_key!==`workflow-artifact:${original.workerPrincipalId}`||admitted.input_hash!==commandInputHash(original.declaration)
          || !same(original.accepted.context, publisher.context) || original.declaration.commandId !== mapping.commandId || original.declaration.sha256 !== transfer.sha256
          || original.declaration.byteSize !== transfer.byteSize
          || workflowArtifactTransferManifestDigest(original.declaration) !== transfer.intent.manifestDigest) return unavailable()
        const stored = await this.ports.files.read(link.ref.fileId, link.ref.revisionId, sql)
        if (!stored || stored.ownerPrincipalId !== caller.principal.id || stored.value.file.state !== 'ready'
          || fileScopeIdentity(stored.value.file.scope) !== fileScopeIdentity(caller.context.scope)
          || stored.value.revision.fileId !== link.ref.fileId || stored.value.revision.revisionId !== link.ref.revisionId
          || stored.value.revision.sha256 !== transfer.sha256 || stored.value.revision.byteSize !== transfer.byteSize) return unavailable()
        const expected = NativeArtifactOutputSchema.parse({ version: 1, producer: attempt, outputKey: mapping.outputKey, commandId: mapping.commandId,
          nativeIdentity: { nativeSessionId: publisher.context.nativeSessionId, turnId: publisher.context.turnId,
            ...(publisher.context.messageId ? { messageId: publisher.context.messageId } : {}) },
          publication: { ownerPrincipalId: publisher.principal.id, requestId, binding: publisher.binding }, pins: { ...link.ref, sha256: transfer.sha256,
            byteSize: transfer.byteSize }, scope: stored.value.file.scope, transferReceipt: transfer })
        if (adopted) {
          const target = JSON.stringify([this.mainId, attempt.executionId, attempt.attemptId, mapping.outputKey])
          const rows = await sql.query<{ principal_id: string; command_id: string; input_hash: string; result: unknown }>(
            `select principal_id,command_id,input_hash,result from management_command_receipts
              where operation='remote.native-artifact.output' and target_key=$1 for share`, [target])
          const mapped = rows.rows[0]
          if (rows.rowCount !== 1 || !mapped || mapped.principal_id !== caller.principal.id || mapped.command_id !== hash(target)
            || mapped.input_hash !== hash(canonicalGraphJson(expected)) || !same(NativeArtifactOutputSchema.parse(mapped.result), expected)) return unavailable()
        }
        records.push(expected)
      }
      if (!same(workflowArtifactDigestsByOutputKey(records.map(record => ({ outputKey: record.outputKey, sha256: record.pins.sha256 }))),
        receipt.terminal.artifactDigests ?? [])) return unavailable()
      const current = await this.ports.authority.authorize(accepted, sql)
      if (current.principal.id !== caller.principal.id || current.binding !== caller.binding || !same(current.context, caller.context)) return unavailable()
      const ids = [...new Set(records.map(record => record.pins.fileId))]
      const live = await sql.query(`select file_id from files where file_id=any($1::text[]) and state='ready'
        and expires_at>clock_timestamp() for share`, [ids])
      if (live.rowCount !== ids.length) return unavailable()
    } catch (error) { poisonGraphTransaction(sql); throw error }
  }
}
