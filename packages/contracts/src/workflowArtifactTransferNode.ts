import { createHash } from 'node:crypto'
import { canonicalGraphJson } from './wave25/json.js'
import { WorkflowArtifactTransferInputSchema, type WorkflowArtifactTransferInput } from './workflowArtifactTransfer.js'

/** Node-only single-artifact manifest identity. Command, execution, root and context
 * have their own original admission fences and are not this declaration digest. */
export function workflowArtifactTransferManifestDigest(raw: WorkflowArtifactTransferInput): string {
  const { sha256, byteSize } = WorkflowArtifactTransferInputSchema.parse(raw)
  return createHash('sha256').update(canonicalGraphJson({ version: 1, sha256, byteSize })).digest('hex')
}
