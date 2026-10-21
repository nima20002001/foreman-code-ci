import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { systemMaintenancePorts } from './maintenance.js'
import { discoverInstalledClaudeSdk, installedClaudeSdkEntrypoint } from '../harnesses/claudeSdk/currentPin.js'
import {
  readInstalledWorkflowConfiguration, type InstalledWorkflowConfigurationLocation,
} from '../runs/remote/installedWorkflowConfiguration.js'

/** Follows the native installer's launcher after an update; profile qualification still checks the selected payload. */
export async function selectInstalledClaude(location: InstalledWorkflowConfigurationLocation | null,
  environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string | null> {
  if (!location) return null
  const configuration = await readInstalledWorkflowConfiguration(location)
  if (!configuration?.claude) return null
  signal.throwIfAborted()
  const launcher = await systemMaintenancePorts(environment).find('claude')
  if (!launcher) throw new Error('The updated Claude launcher could not be located.')
  const binary = await realpath(launcher)
  const sdk = installedClaudeSdkEntrypoint(configuration.claude.installedLockPath, binary,
    configuration.claude.sdkEntrypoint)
  await discoverInstalledClaudeSdk(sdk, {
    harnessInstallationId: 'worker-installed-claude',
    environment: { path: environment.PATH ?? '', cwd: dirname(location.path), provenance: 'worker', generation: 'update' },
  }, signal)
  if (configuration.claude.binary === binary) return binary
  const next = { ...configuration, claude: { ...configuration.claude, binary } }
  const temporary = join(dirname(location.path), `.workflow-runtime.${randomUUID()}.tmp`)
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await file.writeFile(`${JSON.stringify(next, null, 2)}\n`)
    await file.sync()
  } finally { await file.close() }
  try {
    signal.throwIfAborted()
    await rename(temporary, location.path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return binary
}
