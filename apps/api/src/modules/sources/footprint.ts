import { SOURCE_MATERIALIZATION_RECORD_MAX_BYTES, type SourceManifest } from '@foreman-code/contracts/source-materialization'

const entryAllowance = 8192
const metadataAllowance = SOURCE_MATERIALIZATION_RECORD_MAX_BYTES

export function sourceStructureBytes(paths: readonly string[], copies = 1): number {
  const directories = new Set<string>()
  for (const path of paths) {
    const components = path.split('/')
    for (let index = 1; index < components.length; index++) {
      directories.add(components.slice(0, index).join('/'))
    }
  }
  return (paths.length + directories.size) * entryAllowance * copies + metadataAllowance
}

export function sourceMaterializationBytes(manifest: SourceManifest): number {
  return manifest.totalBytes * 3 + (manifest.git?.metadata?.byteSize ?? 0)
    + sourceStructureBytes(manifest.entries.map(entry => entry.path), 2)
}
