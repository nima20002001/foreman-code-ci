import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as files from './files.js'

const schemas = files as unknown as Record<string, z.ZodType>
const scope = { kind: 'workspace_reference', workspaceId: 'workspace-example' }
const upload = { requestId: 'upload-example', filename: 'guide.md', mediaType: 'text/markdown',
  byteSize: 0, sha256: '0'.repeat(64) }

describe('shared reference file envelopes', () => {
  it('exports validated mutation and read inputs for all transports', () => {
    for (const name of ['FileUploadRequestSchema', 'FileReferenceListInputSchema', 'FileReferenceReadInputSchema',
      'FileReferenceReadResultSchema', 'FileReferenceAddInputSchema', 'FileReferenceRemoveBodySchema',
      'FileReferenceRemoveInputSchema', 'FileReferenceRemoveToolInputSchema', 'FileReferenceMutationResultSchema']) {
      expect(schemas[name], name).toBeDefined()
    }
    expect(schemas.FileReferenceAddInputSchema!.parse({ scope, upload, contentBase64: '' }))
      .toEqual({ scope, upload, contentBase64: '' })
    expect(schemas.FileReferenceAddInputSchema!.safeParse({ scope, upload: { ...upload, filename: 'guide.exe' },
      contentBase64: '' }).success).toBe(false)
    expect(schemas.FileReferenceReadInputSchema!.safeParse({ scope, fileId: 'file-example',
      revisionId: 'revision-example', length: files.MAX_FILE_READ_BYTES + 1 }).success).toBe(false)
    expect(schemas.FileReferenceAddInputSchema!.safeParse({ scope: { kind: 'temporary' }, upload,
      contentBase64: '' }).success).toBe(false)
  })

  it('allows optional removal command identity and rejects temporary mutation results', () => {
    expect(schemas.FileReferenceRemoveToolInputSchema).toBeDefined()
    const removal = schemas.FileReferenceRemoveToolInputSchema!.parse({ scope, fileId: 'file-example',
      revisionId: 'revision-example' })
    expect(removal).toMatchObject({ scope, fileId: 'file-example', revisionId: 'revision-example' })
    expect(schemas.FileReferenceMutationResultSchema).toBeDefined()
    const createdAt = '2026-01-01T00:00:00.000Z'
    const value = { file: { fileId: 'file-example', currentRevisionId: 'revision-example', scope,
      state: 'pending', createdAt }, revision: { ...upload, requestId: undefined, fileId: 'file-example',
      revisionId: 'revision-example', origin: 'upload', createdAt } }
    delete value.revision.requestId
    expect(schemas.FileReferenceMutationResultSchema!.safeParse({ value, replayed: false }).success).toBe(true)
    const temporary = { ...value, file: { ...value.file, scope: { kind: 'temporary', chat: {
      kind: 'operator', ownerPrincipalId: 'owner-example', operatorId: 'operator-example', conversationId: 'chat-example',
    } }, retentionDurationSeconds: 3600, expiresAt: '2026-01-01T01:00:00.000Z' } }
    expect(files.FileWithRevisionSchema.safeParse(temporary).success).toBe(true)
    expect(schemas.FileReferenceMutationResultSchema!.safeParse({ value: temporary, replayed: false }).success).toBe(false)
  })
})
