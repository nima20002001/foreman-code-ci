import { describe, expect, it } from 'vitest'
import { containsAttachmentRefs, messageAttachmentRefs, sameAttachmentRefs } from './chatAttachmentAttempt'

const input = { fileId: 'input', revisionId: 'input-v1' }
const other = { fileId: 'other', revisionId: 'other-v1' }
const output = { fileId: 'output', revisionId: 'output-v1' }
const newerInput = { ...input, revisionId: 'input-v2' }

describe('R2-6: original input pins in hydrated publication receipts', () => {
  it.each([
    ['input-only', [input, other]],
    ['appended output', [input, other, output]],
    ['interleaved output', [other, output, input]],
    ['newer revision alongside the original', [newerInput, other, input]],
  ] as const)('accepts every original input with %s', (_name, received) => {
    expect(containsAttachmentRefs(received, [input, other])).toBe(true)
  })

  it.each([
    ['no pins', []],
    ['outputs only', [output]],
    ['a missing input', [input, output]],
    ['a different revision', [newerInput, other, output]],
    ['a different file', [{ ...input, fileId: 'foreign' }, other, output]],
  ] as const)('rejects %s', (_name, received) => {
    expect(containsAttachmentRefs(received, [input, other])).toBe(false)
  })

  it('matches immutable readback revisions even when the discovery head advanced', () => {
    // Only revision pins participate; neither the mutable file head nor its origin is proof of acceptance.
    const refs = messageAttachmentRefs({ attachments: [{
      file: { fileId: input.fileId, currentRevisionId: newerInput.revisionId, createdAt: '2026-01-01T00:00:00.000Z',
        scope: { kind: 'temporary', chat: { kind: 'operator', conversationId: 'chat',
          operatorId: 'operator', ownerPrincipalId: 'owner' } }, state: 'ready',
        retentionDurationSeconds: 3600, expiresAt: '2026-01-01T01:00:00.000Z' },
      revision: { fileId: input.fileId, revisionId: input.revisionId, filename: 'input.md', mediaType: 'text/markdown',
        byteSize: 1, sha256: 'a'.repeat(64), origin: 'agent_output', createdAt: '2026-01-01T00:00:00.000Z' },
    }] })
    expect(containsAttachmentRefs(refs, [input])).toBe(true)
    expect(containsAttachmentRefs(refs, [newerInput])).toBe(false)
  })

  it('keeps exact ordered equality for local drafts and command snapshots', () => {
    expect(sameAttachmentRefs([input, other], [input, other])).toBe(true)
    expect(sameAttachmentRefs([input, other, output], [input, other])).toBe(false)
    expect(sameAttachmentRefs([other, input], [input, other])).toBe(false)
    expect(sameAttachmentRefs([newerInput, other], [input, other])).toBe(false)
    expect(containsAttachmentRefs(undefined, [input])).toBe(false)
    expect(sameAttachmentRefs(undefined, [])).toBe(true)
  })
})
