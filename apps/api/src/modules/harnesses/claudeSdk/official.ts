import { createRequire } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import { NativeProcessRegistry, spawnNativeProcess, stopRecoveredChild, type NativeProcessRecovery } from '../recovery/processRegistry.js'
import { HarnessExecutionError } from '../errors.js'
import { createClaudeSdkRunner } from './runner.js'
import type { Options, SDKUserMessage, McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeSdkClient } from './port.js'
import { claudeProfileHelper } from './profileHelpers.js'


export function assertClaudeSdkContract(sdk: unknown, version: string): void {
  const exports = sdk && typeof sdk === 'object' ? sdk as Record<string, unknown> : {}
  for (const method of ['query', 'getSessionInfo', 'getSessionMessages', 'forkSession', 'listSubagents', 'getSubagentMessages']) {
    if (typeof exports[method] !== 'function') throw new HarnessExecutionError('CLAUDE_CONTRACT_UNSUPPORTED',
      `Claude Code SDK ${version} does not satisfy the required ${method} method contract.`)
  }
}

/** Loading occurs only at admitted startup, never at synchronous factory allocation. */
export async function loadInstalledClaudeSdk(sdkEntrypoint?: string): Promise<typeof import('@anthropic-ai/claude-agent-sdk')> {
  const require = createRequire(import.meta.url)
  const selected = sdkEntrypoint ?? require.resolve('@anthropic-ai/claude-agent-sdk')
  if (!isAbsolute(selected) || selected.includes('\0')) throw new Error('Claude SDK requires its qualified absolute entrypoint')
  const entrypoint = await realpath(selected)
  const manifest = JSON.parse(await readFile(join(dirname(entrypoint), 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
  if (manifest.name !== '@anthropic-ai/claude-agent-sdk' || typeof manifest.version !== 'string' || !manifest.version) throw new Error('Claude SDK manifest is invalid')
  const sdk = await import(pathToFileURL(entrypoint).href) as typeof import('@anthropic-ai/claude-agent-sdk')
  assertClaudeSdkContract(sdk, manifest.version)
  return sdk
}

export async function loadOfficialClaudeSdk(profilePath: string, recovery: NativeProcessRecovery, binary: string,
  sdkEntrypoint?: string): Promise<ClaudeSdkClient> {
  const sdk = await loadInstalledClaudeSdk(sdkEntrypoint)
  const require = createRequire(import.meta.url)
  const entrypoint = await realpath(sdkEntrypoint ?? require.resolve('@anthropic-ai/claude-agent-sdk'))
  const manifest = JSON.parse(await readFile(join(dirname(entrypoint), 'package.json'), 'utf8')) as { version: string }
  return {
    sdkVersion: manifest.version,
    ...ownedClaudeSdkQueries({ sdk, recovery, binary }),
    getSessionInfo: (id, options) => claudeProfileHelper(entrypoint, profilePath, 'getSessionInfo', [id, options]),
    getSessionMessages: (id, options) => claudeProfileHelper(entrypoint, profilePath, 'getSessionMessages', [id, options]),
    listSubagents: (id, options) => claudeProfileHelper(entrypoint, profilePath, 'listSubagents', [id, options]),
    getSubagentMessages: (id, agentId, options) =>
      claudeProfileHelper(entrypoint, profilePath, 'getSubagentMessages', [id, agentId, options]),
    forkSession: (id, options) => claudeProfileHelper(entrypoint, profilePath, 'forkSession', [id, options]),
  }
}

/** Reserve native ownership before SDK dispatch, including queries that never spawn. */
export function ownedClaudeSdkQueries(input: {
  sdk: Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'query'>
  recovery: NativeProcessRecovery
  binary: string
}): Pick<ClaudeSdkClient, 'query' | 'requiresRuntimeClosure'> {
  const registry = new NativeProcessRegistry(input.recovery.root)
  const unclosed = new Set<NativeProcessRecovery>()
  let usedReservation = false
  return {
    requiresRuntimeClosure: () => unclosed.size > 0,
    async query({ prompt, options, scope }) {
      const recovery = input.recovery.launchId && !usedReservation
        ? input.recovery : await registry.reserveLaunch(input.recovery.owner)
      usedReservation = true
      unclosed.add(recovery)
      const children = new Set<ChildProcess>()
      let stopped = false
      const joinClosed = async () => {
        if (!unclosed.has(recovery)) return
        stopped = true
        await Promise.all([...children].map(async child => {
          if (!await stopRecoveredChild(child)) throw new Error('Claude native process closure is unverified')
        }))
        await registry.abandonReservedLaunch(recovery)
        if (!await registry.closeOwner(recovery.owner)) throw new Error('Claude native launch closure is unverified')
        unclosed.delete(recovery)
      }
      try {
        const query = input.sdk.query({ prompt: prompt as AsyncIterable<SDKUserMessage>, options: {
          ...options as Options,
          pathToClaudeCodeExecutable: input.binary,
          spawnClaudeCodeProcess(spawn) {
            if (stopped) throw new Error('The owned Claude query closed before native launch')
            const controller = options.abortController as AbortController | undefined
            controller?.signal.throwIfAborted()
            spawn.signal.throwIfAborted()
            const child = spawnNativeProcess(spawn.command, spawn.args, {
              cwd: spawn.cwd ?? String(options.cwd), env: spawn.env, recovery, ...(scope ? { claudeSessionScope: scope } : {}),
            })
            children.add(child)
            return child
          },
        } })
        return {
          [Symbol.asyncIterator]: () => query[Symbol.asyncIterator](),
          setPermissionMode: mode => query.setPermissionMode(mode),
          getContextUsage: options => query.getContextUsage(options),
          interrupt: () => query.interrupt(),
          initializationResult: () => query.initializationResult(),
          mcpServerStatus: () => query.mcpServerStatus(),
          setMcpServers: (servers: Readonly<Record<string, unknown>>) =>
            query.setMcpServers(servers as Record<string, McpServerConfig>),
          close: () => { stopped = true; query.close() },
          joinClosed,
        }
      } catch (error) {
        await joinClosed()
        throw error
      }
    },
  }
}

/** Synchronous allocation retains the exact initially unreserved HRT recovery object. */
export function createOfficialClaudeSdkRunner(input: { profilePath: string; recovery: NativeProcessRecovery; binary: string }) {
  return createClaudeSdkRunner({ loadClient: () => loadOfficialClaudeSdk(input.profilePath, input.recovery, input.binary) })
}
