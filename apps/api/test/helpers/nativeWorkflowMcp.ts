import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  APP_MCP_TOKEN, appLauncherPath, appLauncherTokenName, appMcpServerName, installAppLauncher,
  isSupportedAppMcpTokenName,
} from '../../src/modules/harnesses/appMcpLauncher.js'
import { CodexMcpConnections } from '../../src/modules/harnesses/codexMcpConnections.js'
import { record } from '../../src/modules/harnesses/nativeMcpCommon.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { ownedTestDatabaseUrl, ownedTestPath, removeFixtureDirectory } from './testResources.js'
import { referenceTestAuthenticationFile } from '../../../../scripts/test-resources.mjs'

/** Use fixture-owned CLI configuration and routes while retaining the provider login. */
export async function configureNativeWorkflowMcp(input: {
  projectDirectory: string
  runtimeDirectory: string
  codexBinary: string
  appServerName?: string
}): Promise<() => Promise<void>> {
  ownedTestDatabaseUrl()
  ownedTestPath(input.projectDirectory)
  ownedTestPath(input.runtimeDirectory)
  const authentication = process.env.FOREMAN_CODE_TEST_CODEX_AUTH_FILE
  if (!authentication) throw new Error('Native workflow fixtures require explicit test Codex authentication')
  const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER! }
  const previous = process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
  const previousCodexHome = process.env.CODEX_HOME
  // Codex's release build refuses helper aliases beneath TMPDIR.
  const codexHomeDirectory = await privateFixtureDirectory('native-cli-codex-')
  const restore = async () => {
    if (previous === undefined) delete process.env.FOREMAN_CODE_APP_MCP_DIRECTORY
    else process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = previous
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await removeFixtureDirectory(codexHomeDirectory)
  }
  try {
    // Inspect copied configuration against its original managed-launcher location.
    const sourceLauncher = process.env.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY
    if (sourceLauncher !== undefined) process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = sourceLauncher
    const codex = await new CodexMcpConnections(input.codexBinary, input.projectDirectory)
      .read(AbortSignal.timeout(30_000))
    const codexName = appMcpServerName(codex.effective, input.appServerName)
    const entry = record(codex.effective[codexName])
    const reference = appLauncherTokenName(entry) ?? entry.bearer_token_env_var
    const codexToken = typeof reference === 'string' && isSupportedAppMcpTokenName(reference)
      ? reference : APP_MCP_TOKEN
    // Reuse only the selected provider login; unrelated native configuration stays outside the fixture.
    referenceTestAuthenticationFile(invocation, authentication, join(codexHomeDirectory, 'auth.json'))
    process.env.CODEX_HOME = codexHomeDirectory
    process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = ownedTestPath(join(input.runtimeDirectory, 'mcp'))
    await installAppLauncher()
    await writeFile(join(codexHomeDirectory, 'config.toml'), [
      `[mcp_servers.${codexName}]`,
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(appLauncherPath())}]`,
      `env_vars = [${JSON.stringify(codexToken)}]`,
      '',
    ].join('\n'), { mode: 0o600 })
    return restore
  } catch (error) {
    try { await restore() }
    catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Native fixture configuration and cleanup failed.', { cause: cleanup })
    }
    throw error
  }
}
