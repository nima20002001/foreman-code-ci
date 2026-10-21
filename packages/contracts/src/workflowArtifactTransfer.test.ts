import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_FILE_BYTES } from './files.js'
import { canonicalGraphJson } from './wave25/json.js'
import { WorkflowArtifactTransferInputSchema } from './workflowArtifactTransfer.js'
import { workflowArtifactTransferManifestDigest } from './workflowArtifactTransferNode.js'

const input = { commandId: 'original-command', sha256: 'a'.repeat(64), byteSize: 123 }
describe('workflow single-artifact transfer declaration', () => {
  it('uses the existing artifact budget, including empty bytes and exact command bounds', () => {
    expect(WorkflowArtifactTransferInputSchema.parse(input)).toEqual(input)
    expect(WorkflowArtifactTransferInputSchema.safeParse({ ...input, commandId: 'a'.repeat(8), byteSize: 0 }).success).toBe(true)
    expect(WorkflowArtifactTransferInputSchema.safeParse({ ...input, commandId: 'a'.repeat(200), byteSize: MAX_FILE_BYTES }).success).toBe(true)
  })
  it.each([
    { commandId: 'short' }, { commandId: 'a'.repeat(201) },
    { sha256: 'a'.repeat(63) }, { sha256: 'A'.repeat(64) },
    { byteSize: -1 }, { byteSize: 1.5 }, { byteSize: MAX_FILE_BYTES + 1 },
    { byteSize: Number.NaN }, { byteSize: Infinity },
  ])('rejects invalid declaration metadata %j', replacement => {
    expect(WorkflowArtifactTransferInputSchema.safeParse({ ...input, ...replacement }).success).toBe(false)
  })
  it.each(['executionId', 'attemptId', 'rootId', 'context', 'principalId', 'manifestDigest', 'transferId'])('rejects caller-supplied %s', field => {
    expect(WorkflowArtifactTransferInputSchema.safeParse({ ...input, [field]: 'caller-selected' }).success).toBe(false)
  })
  it('pins canonical versioned manifest bytes separately from the artifact byte hash', () => {
    const bytes = '{"byteSize":123,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":1}'
    expect(canonicalGraphJson({ version: 1, sha256: input.sha256, byteSize: input.byteSize })).toBe(bytes)
    expect(workflowArtifactTransferManifestDigest(input)).toBe('cd818f73244eb22e624362426fe6bea9934d7fe070c177d718eba360135312b2')
    expect(workflowArtifactTransferManifestDigest(input)).not.toBe(input.sha256)
    expect(workflowArtifactTransferManifestDigest(input)).toBe(createHash('sha256').update(bytes).digest('hex'))
  })
  it('keeps declaration identity stable across command IDs and property order, and binds both byte fields', () => {
    const original = workflowArtifactTransferManifestDigest(input)
    expect(workflowArtifactTransferManifestDigest({ byteSize: 123, sha256: input.sha256, commandId: 'other-command' })).toBe(original)
    expect(workflowArtifactTransferManifestDigest({ ...input, byteSize: 124 })).not.toBe(original)
    expect(workflowArtifactTransferManifestDigest({ ...input, sha256: 'b'.repeat(64) })).not.toBe(original)
    expect(() => workflowArtifactTransferManifestDigest({ ...input, byteSize: -1 })).toThrow()
  })
})
