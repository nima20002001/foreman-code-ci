import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DomainError } from '../errors.js'
import { qualifyCodex, assertCodexUnchanged } from './codexProtocol.js'
import { CodexStdioTransport, isObject, object } from './codexStdioTransport.js'
import { inheritedAgentEnvironment } from './secrets.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'
import { runOwnedClaudeOperation } from './claudeSdk/ownedOperation.js'

/** A fresh native reader observes keyring changes without returning credentials or opening a model turn. */
export async function codexAuthenticationIdentity(input: {
  binary: string
  directory: string
  environment: NodeJS.ProcessEnv
  registry: NativeProcessRegistry
  signal: AbortSignal
}): Promise<string | null> {
  const environment = inheritedAgentEnvironment(input.environment)
  const recovery = await input.registry.reserveLaunch(`catalog-authentication:${randomUUID()}`)
  return runOwnedClaudeOperation(async () => {
    const qualified = await qualifyCodex(input.binary, input.directory, environment, true, input.signal, recovery)
    await assertCodexUnchanged(qualified)
    const transport = new CodexStdioTransport(qualified.binary, input.directory, environment, qualified.protocol,
      async () => { throw new DomainError('CODEX_AUTHENTICATION_INTERACTION',
        'Account inspection cannot answer native interactions.', 409) },
      () => undefined, () => undefined, 30_000, recovery, [], undefined,
      { nativeApps: false, nativePlugins: false })
    try {
      await transport.start(input.signal)
      const response = object(await transport.request('account/read', { refreshToken: false }, input.signal))
      if (!isObject(response.account) || response.account.type !== 'chatgpt') throw new DomainError(
        'CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'The selected Codex login is signed out or unavailable.', 409)
      await assertCodexUnchanged(qualified)
      input.signal.throwIfAborted()
      const workspace = isObject(response.workspaceRouting) ? response.workspaceRouting.chatgptAccountId : undefined
      if (typeof workspace !== 'string' || !workspace) return null
      return commandInputHash({ account: response.account, workspaceRouting: response.workspaceRouting })
    } finally { await transport.close() }
  }, async () => {
    await input.registry.abandonReservedLaunch(recovery)
    if (!await input.registry.closeOwner(recovery.owner)) throw new DomainError(
      'HARNESS_PROCESS_CLOSURE_PENDING', 'Account inspection has not stopped.', 409)
  })
}
