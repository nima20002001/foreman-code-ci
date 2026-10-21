import { SOURCE_MATERIALIZATION_RECORD_MAX_BYTES, SourceMaterializationFileSchema }
  from '@foreman-code/contracts/source-materialization'
import { SourceError, verifySourceManifest } from './manifest.js'

/** Apply the same encoded-file budget before readiness that verification and recovery readers enforce. */
export function encodeMaterializationRecord(input: unknown): string {
  const record = SourceMaterializationFileSchema.parse(input)
  verifySourceManifest(record.manifest)
  const encoded = JSON.stringify(record)
  if (Buffer.byteLength(encoded) > SOURCE_MATERIALIZATION_RECORD_MAX_BYTES) {
    throw new SourceError('SOURCE_CAPACITY', 'Source materialization record exceeds its metadata budget.')
  }
  return encoded
}
