import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { AgentHarness } from '@foreman-code/contracts'
import { discoverInventoryLauncher } from './hostDiscovery.js'
import { inventoryDriverPayloads } from './payloadDiscovery.js'

/** Cache identity includes the launcher, interpreter and installed native payload. */
export async function binaryCacheIdentity(harness: AgentHarness, binary: string, cwd: string): Promise<string> {
  const environment = { path: process.env.PATH ?? '', cwd, provenance: 'terminal' as const,
    generation: commandInputHash({ path: process.env.PATH ?? '', cwd, node: process.execPath }) }
  const launcher = await discoverInventoryLauncher(binary, environment, [])
  const payload = launcher.resolvedLauncher
    ? await inventoryDriverPayloads(harness, launcher.resolvedLauncher)
    : null
  const paths = [...(payload?.paths ?? []), ...(launcher.interpreter ? [launcher.interpreter] : [])]
  const observed = await discoverInventoryLauncher(binary, environment, paths)
  return commandInputHash({ binary, environment, launcher: observed.resolvedLauncher, fingerprint: observed.fingerprint })
}
