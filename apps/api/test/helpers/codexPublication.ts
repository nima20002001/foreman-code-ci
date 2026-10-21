import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import type { MessageAttachmentRef } from '@foreman-code/contracts/files'
import type { CodexFileCallResult } from '../../src/modules/harnesses/codexFiles/port.js'
import type { afPublicationFixture } from './afPublicationFixture.js'

export function publicationValue(result: CodexFileCallResult): { value: { artifactId: string; file: { fileId: string }; revision: { revisionId: string } } } {
  expect(result.success, JSON.stringify(result)).toBe(true)
  const text = result.contentItems.find((item) => item.type === 'inputText')
  if (!text || text.type !== 'inputText') throw new Error('File result has no JSON text')
  return JSON.parse(text.text)
}
export const publicationPin = (result: ReturnType<typeof publicationValue>): MessageAttachmentRef => ({
  fileId: result.value.file.fileId, revisionId: result.value.revision.revisionId,
})
export async function preparePublication(f: Awaited<ReturnType<typeof afPublicationFixture>>, count: number,
  failure?: 'adopt_once' | 'revoke_after_finalize' | 'lose_close') {
  const attachments: MessageAttachmentRef[] = []
  for (let index = 0; index < count; index++) attachments.push(await f.upload(Buffer.from(`# input ${index}\n`)))
  // An inherited reference exists independently of this turn's upload inputs.
  const source = attachments[0] ?? await f.inheritedReference()
  const active = await f.pause(attachments)
  const { bridge, admission } = await f.prepareCodex(active, (admission) => {
    if (failure === 'adopt_once' || failure === 'lose_close') {
      const adopt = admission.adoptPublished
      let fail = true
      admission.adoptPublished = async (...args) => {
        if (fail) {
          fail = false
          throw new Error('Injected transient adoption database failure')
        }
        return adopt(...args)
      }
    }
  })
  const call = (tool: string, arguments_: unknown) => bridge.call({ threadId: active.session.nativeSessionId,
    turnId: active.turn.nativeTurnId!, tool, arguments: arguments_ })
  const copy = publicationValue(await call('files_create_working_copy', { commandId: randomUUID(), source,
    destination: admission.accepted.scope }))
  if (failure === 'revoke_after_finalize') {
    const finalize = f.files.finalize.bind(f.files)
    vi.spyOn(f.files, 'finalize').mockImplementation(async (...args) => {
      const result = await finalize(...args)
      // This is AFTER the real finalize transaction and BEFORE publish's final authentication.
      await f.database.pool.query(`update file_tool_sessions set revoked_at=clock_timestamp()
        where record->'context'->>'messageId'=$1`, [active.turn.messageId])
      return result
    })
  }
  const publish = () => call('files_publish_result', { commandId: randomUUID(), artifactId: copy.value.artifactId,
    scope: admission.accepted.scope, filename: 'result.md', mediaType: 'text/markdown' })
  return { active, bridge, admission, attachments, publish }
}
