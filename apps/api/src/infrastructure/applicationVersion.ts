import { createRequire } from 'node:module'

const manifest: unknown = createRequire(import.meta.url)('../../package.json')
if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || typeof manifest.version !== 'string'
  || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  throw new Error('The installed API application version is unavailable.')
}
export const API_APPLICATION_VERSION = manifest.version
