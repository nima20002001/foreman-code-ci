import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { hydrateMessageAttachments } from '../src/modules/conversations/messageAttachments.js'
import { readOriginalMessageInputs } from '../src/modules/conversations/originalMessageInputs.js'

const pin = (name: string) => ({ fileId: name, revisionId: `pinned-${name}` })
function metadata(name: string) {
  return { file_id: name, revision_id: `pinned-${name}`, current_revision_id: 'mutable-head', activity_record_revision: '1',
    chat_kind: 'agent', owner_principal_id: 'owner', operator_id: null, conversation_id: 'conversation', agent_id: 'agent',
    workspace_id: 'workspace', workflow_id: 'workflow', run_id: null, execution_id: null, state: 'ready',
    created_at: new Date('2026-10-01T00:00:00Z'), retention_duration_seconds: 3600, expires_at: new Date('2026-10-01T01:00:00Z'),
    filename: `${name}.md`, media_type: 'text/markdown', byte_size: '1', sha256: '0'.repeat(64), origin: 'upload',
    revision_created_at: new Date('2026-10-01T00:00:00Z'), read_at: new Date('2026-10-01T00:30:00Z') }
}
describe('exact original admitted message source', () => {
  for (const count of [0, 10]) it(`keeps ${count} original inputs separate from twelve published outputs`, async () => {
    const inputs = Array.from({ length: count }, (_, index) => pin(`input-${index}`))
    const outputs = Array.from({ length: 12 }, (_, index) => pin(`output-${index}`))
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('select m.id,t.request_id')) return { rows: [{ id: 'message', request_id: 'A', content: 'exact original text', input_pins: inputs }] }
      if (sql.includes('jsonb_to_recordset')) return { rows: [...inputs, ...outputs].map((ref) => metadata(ref.fileId)) }
      return { rows: [] }
    })
    const result = await hydrateMessageAttachments({ query } as unknown as Pick<pg.PoolClient, 'query'>, 'conversation', [{
      id: 'message', conversationId: 'conversation', requestId: 'A', role: 'user', content: 'display text', attachmentRefs: inputs, publicationRefs: outputs,
    }])
    expect(result[0]?.attachments).toHaveLength(count + 12)
    expect(result[0]?.originalInput).toEqual({ requestId: 'A', content: 'exact original text', attachments: inputs })
    const originalLookup = query.mock.calls.find(([sql]) => sql.includes('select m.id,t.request_id'))![0]
    expect(originalLookup).toContain('t.message_id=m.id'); expect(originalLookup).toContain('t.request_id=m.client_request_id')
    expect(originalLookup).toContain('c.id=$1'); expect(originalLookup).not.toContain('order by')
  })
  it('does not manufacture an original input when there is no matching admitted receipt', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    expect(await readOriginalMessageInputs({ query } as unknown as Pick<pg.PoolClient, 'query'>, 'conversation', ['message'])).toEqual(new Map())
    expect(query).toHaveBeenCalledWith(expect.stringContaining("m.role='user'"), ['conversation', ['message']])
  })
})
