import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { AgentFilePublishInputSchema } from '@foreman-code/contracts/files'
import type { DispatchIntent } from '@foreman-code/contracts/node-placement'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { workflowArtifactTransferManifestDigest } from '@foreman-code/contracts/workflow-artifact-transfer-node'
import { WorkerMcpRelayRequestSchema } from '@foreman-code/contracts/worker-mcp-relay'
import { WorkflowArtifactTransferInputSchema } from '@foreman-code/contracts/workflow-artifact-transfer'
import { ResumableByteTransferService } from '../../src/modules/byte-transfer/service.js'
import { transferContextForBinding } from '../../src/modules/byte-transfer/carrier.js'
import { DistributedArtifactPublicationService } from '../../src/modules/files/distributed/publication.js'
import type { DistributedPublicationLink } from '../../src/modules/files/distributed/publicationLedger.js'
import { fileToolFixture } from './fileTools.js'

// Main authorization is a fixture port; transfers, publication and file readback use the domain services.
export async function workflowNativeOutputMain(input: {
  directory: string
  currentIntent(): DispatchIntent
  currentBinding(): DeviceSessionBinding | undefined
  rootId: string
  rootBindingRevision: number
}) {
  const files = await fileToolFixture()
  const originalIntent = structuredClone(input.currentIntent())
  files.scope.chat = { kind: 'agent', conversationId: files.scope.chat.conversationId,
    workspaceId: 'workspace', workflowId: 'workflow', agentId: 'agent',
    runId: originalIntent.runId, executionId: originalIntent.executionId }
  files.context.nativeSessionId = 'original-session'
  files.context.turnId = 'original-turn'
  const token = await files.issue()
  const authorize = () => files.sessions.authenticate(token, 'files.publish_result')
  const receiver = new ResumableByteTransferService(join(input.directory, 'output-receiver'), {
    authorize: async (_intent, context) => {
      const binding = input.currentBinding()
      if (!binding || !isDeepStrictEqual(context, transferContextForBinding(binding))) {
        throw new Error('Stale output transfer connection')
      }
      await authorize()
    },
  })
  const links = new Map<string, DistributedPublicationLink>()
  const publisher = new DistributedArtifactPublicationService(files.files, {
    read: async (_principalId, requestId) => links.get(requestId),
    linkPublication: async link => { links.set(link.requestId, structuredClone(link)) },
  }, receiver, { authorize, assertSourceLive: async () => {} }, files.clock)
  const admissions = new Map<string, TransferIntent>()
  const received: Array<{ binding: DeviceSessionBinding; intent: DispatchIntent }> = []
  const authority = () => ({ version: 1, mainId: originalIntent.mainId, audience: 'worker',
    principalId: files.principal.id, agentId: 'agent', executionId: originalIntent.executionId,
    operationId: originalIntent.operationId, attemptId: originalIntent.attemptId,
    bindingHash: originalIntent.bindingHash, expiresAt: '2099-01-01T00:00:00.000Z' })

  const handleMcp = async (raw: unknown, binding: DeviceSessionBinding) => {
    const request = WorkerMcpRelayRequestSchema.parse(raw)
    if (!isDeepStrictEqual(request.intent, input.currentIntent())
      || !isDeepStrictEqual(binding, input.currentBinding()) || request.applicationAccess.token !== 'original-token') {
      throw new Error('Stale output authorization')
    }
    await authorize()
    received.push({ binding: structuredClone(binding), intent: structuredClone(request.intent) })
    if (request.operation === 'worker-mcp.authorize-native-output-declarations') {
      return { payload: { ...authority(), agentConfigurationVersionId: 'configuration',
        outputOperations: ['create', 'append', 'seal', 'publish'] } }
    }
    if (request.operation === 'worker-mcp.native-output-readiness') {
      return { payload: { ...authority(), nativeSessionId: 'original-session', turnId: 'original-turn', ready: true } }
    }
    if (request.operation === 'worker-mcp.authorize-native-output') {
      return { payload: { ...authority(), nativeSessionId: 'original-session', turnId: 'original-turn',
        outputOperation: request.outputOperation, scope: files.scope } }
    }
    if (request.operation !== 'worker-mcp.request') throw new Error('Unexpected output request')
    const body = z.object({ id: z.string(), params: z.object({ name: z.string(), arguments: z.unknown() }) })
      .parse(request.body)
    let result: unknown
    const context = transferContextForBinding(binding)
    if (body.params.name === 'files.admit_transferred_result') {
      const declaration = WorkflowArtifactTransferInputSchema.parse(body.params.arguments)
      let transfer = admissions.get(declaration.commandId)
      if (!transfer) {
        transfer = { version: 1, ...context, transferId: randomUUID(),
          operationId: originalIntent.operationId, executionId: originalIntent.executionId,
          attemptId: originalIntent.attemptId, placementHash: originalIntent.bindingHash,
          rootId: input.rootId, rootBindingRevision: input.rootBindingRevision,
          direction: 'to-main', byteClass: 'artifact', sha256: declaration.sha256, byteSize: declaration.byteSize,
          manifestDigest: workflowArtifactTransferManifestDigest(declaration), chunkBytes: 1024,
          expiresAt: new Date(Date.now() + 60_000).toISOString() }
        admissions.set(declaration.commandId, transfer)
      }
      result = transfer
    } else if (body.params.name === 'files.publish_transferred_result') {
      const publication = z.object({ transferId: z.string(), publication: AgentFilePublishInputSchema })
        .parse(body.params.arguments)
      result = await publisher.publishAccepted({ context: files.context, transferContext: context,
        attempt: { workspaceId: 'workspace', workflowId: 'workflow', runId: originalIntent.runId,
          nodeId: originalIntent.nodeId, executionId: originalIntent.executionId,
          attemptId: originalIntent.attemptId, placementHash: originalIntent.bindingHash } },
      publication.transferId, publication.publication, 'mcp')
    } else throw new Error('Unexpected output tool')
    return { payload: { statusCode: 200, contentType: 'application/json', body: JSON.stringify({
      jsonrpc: '2.0', id: body.id, result: { structuredContent: result },
    }) } }
  }
  const handleBytes = async (raw: unknown, binding: DeviceSessionBinding, bytes?: Uint8Array) => {
    const request = z.object({ method: z.string(), transferId: z.string(), offset: z.number().optional(),
      sha256: z.string().optional() }).parse(raw)
    const context = transferContextForBinding(binding)
    const transfer = [...admissions.values()].find(row => row.transferId === request.transferId)
    if (!transfer) throw new Error('Unknown output transfer')
    let payload
    if (request.method === 'start') payload = await receiver.start(transfer, context)
    else if (request.method === 'status') payload = await receiver.status(transfer.transferId, context)
    else if (request.method === 'finish') payload = await receiver.finish(transfer.transferId, context)
    else if (request.method === 'append' && bytes && request.offset !== undefined && request.sha256) {
      payload = await receiver.append(transfer.transferId, context, {
        offset: request.offset, sha256: request.sha256, bytes,
      })
    } else throw new Error('Unexpected output transfer method')
    return { payload }
  }
  return { files, links, admissions, received, handleMcp, handleBytes, close: () => receiver.close() }
}
