import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fileToolFixture } from '../../../../test/support/fileTools.js'
import { observedWorkflowArtifactPublication } from './workerMcpEndpoint.js'

async function fixture() {
  // Parsing-only UNIT relay payloads; real common file service with memory SQL
  // and byte ports supplies schema-valid values, not Main/native qualification.
  const f = await fileToolFixture(), source = await f.upload()
  const copy = await f.service.createWorkingCopy(f.token, { commandId: randomUUID(), source, destination: f.scope })
  const publication = { commandId: randomUUID(), artifactId: copy.value.artifactId,
    scope: f.scope, filename: 'result.md', mediaType: 'text/markdown' as const }
  const result = await f.service.publish(f.token, publication)
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'files.publish_transferred_result',
    arguments: { transferId: randomUUID(), publication } } }
  const reply = { jsonrpc: '2.0', id: 1, result: { structuredContent: result } }
  return { call, reply, result }
}
it.each(['application/json', 'text/event-stream'] as const)('observes one exact successful Main publication in %s', async contentType => {
  const f = await fixture(), json = JSON.stringify(f.reply)
  const body = contentType === 'application/json' ? json : `event: message\ndata: ${json}\n\n`
  expect(observedWorkflowArtifactPublication(f.call, { statusCode: 200, contentType, body }))
    .toEqual({ input: f.call.params.arguments, result: f.result })
})
it.each(['other-tool', 'other-id', 'error', 'status', 'malformed', 'duplicate', 'text-only'])(
  'does not observe %s as an original successful publication', async kind => {
    const f = await fixture()
    if (kind === 'other-tool') f.call.params.name = 'files.publish_result'
    if (kind === 'other-id') f.reply.id = 2
    const reply = kind === 'error' ? { ...f.reply, result: { ...f.reply.result, isError: true } }
      : kind === 'text-only' ? { ...f.reply, result: { content: [{ type: 'text', text: JSON.stringify(f.result) }] } } : f.reply
    const json = JSON.stringify(reply)
    const body = kind === 'malformed' ? '{' : kind === 'duplicate' ? `data: ${json}\n\ndata: ${json}\n\n` : json
    expect(observedWorkflowArtifactPublication(f.call, { statusCode: kind === 'status' ? 403 : 200,
      contentType: kind === 'duplicate' ? 'text/event-stream' : 'application/json', body })).toBeUndefined()
  },
)
