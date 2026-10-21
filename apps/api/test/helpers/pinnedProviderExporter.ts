import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { assertRequiredNativePayloads } from '../../../../scripts/ci-native-payloads.mjs'

const require = createRequire(import.meta.url)

/** CI setup installs and validates the locked exporter before any schema fixtures run. */
export async function pinnedProviderExporter(launcherVersion: string): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>
  }
  if (manifest.dependencies['@openai/codex'] !== launcherVersion) {
    throw new Error('The installed provider launcher does not match the repository dependency pin.')
  }
  assertRequiredNativePayloads(fileURLToPath(new URL('../../../../', import.meta.url)))
  return require.resolve('@openai/codex/bin/codex.js')
}
