import { createHash, randomUUID } from 'node:crypto'
import { access, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { sameCodexNativeOutputSandbox, type CodexNativeOutputQualificationInput } from './codexNativeOutput.js'
import { CodexStdioTransport, object, type JsonObject } from './codexStdioTransport.js'
import { qualifyCodex, assertCodexUnchanged } from './codexProtocol.js'
import { inheritedAgentEnvironment } from './secrets.js'
import { codexDisabledMcpTransports } from './codexNativeTools.js'
import { runCommand } from './process.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'
import { assertCodexProtectedOutputPlacement, codexNativeOutputSandboxProbeCommand,
  codexNativeOutputSandboxProbeProgram,
  matchesCodexNativeProbeCommand, parseCodexNativeProbeOutput } from './qualification/suites/codexNativeOutputSandbox.js'
import { DomainError } from '../errors.js'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { CodexCommandOutput, recordedCodexCommandOutput } from './codexCommandOutput.js'

const unavailable = () => new DomainError('WORKER_NATIVE_OUTPUT_PROTECTION_FAILED',
  'The selected native sandbox did not prove protection of its output store.', 409)

const probeNativeTools = Object.freeze({ mcpServers: [] as readonly string[], apps: false, plugins: false })

/** The shell-only probe uses a fixed loading policy, independent of the Agent's allowed tools. */
export function codexOutputProtectionIdentity(input: CodexNativeOutputQualificationInput) {
  const { configuration, binary, binaryIdentity, providerVersion, schemaIdentity, expectedSandbox } = input
  return { configuration, binary, binaryIdentity, providerVersion, schemaIdentity, expectedSandbox, probeNativeTools }
}

/** Probe the selected binary with the same sandbox policy, using a separately
 * owned diagnostic actor without an application credential. Assistant claims
 * cannot pass: the exact native command item and its filesystem witness must agree. */
export async function qualifyCodexOutputProtection(input: {
  qualification: CodexNativeOutputQualificationInput
  protectedDirectory: string
  registry: Pick<NativeProcessRegistry, 'reserveLaunch' | 'abandonReservedLaunch' | 'closeOwner'>
  qualify: typeof qualifyCodex
  command: typeof runCommand
  assertCurrent(signal: AbortSignal): Promise<void>
  signal: AbortSignal
}): Promise<void> {
  const { qualification: selected, protectedDirectory, registry } = input
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
  assertCodexProtectedOutputPlacement(protectedDirectory, selected.expectedSandbox)
  await input.assertCurrent(signal)
  const recovery = await registry.reserveLaunch(`native-output-qualification:${randomUUID()}`)
  let transport: CodexStdioTransport | undefined
  const marker = randomUUID()
  const directPath = join(protectedDirectory, `.native-direct-${marker}`)
  const descendantPath = join(protectedDirectory, `.native-descendant-${marker}`)
  const witnessPath = join(selected.expectedSandbox.cwd, `.native-witness-${marker}.json`)
  const hostPath = join(protectedDirectory, `.host-witness-${marker}`)
  const programPath = join(protectedDirectory, `.native-probe-${marker}.py`)
  let failure: { error: unknown } | undefined
  const cleanupProbe = async () => {
    const errors: unknown[] = []
    try { await transport?.close() } catch (error) { errors.push(error) }
    try {
      await registry.abandonReservedLaunch(recovery)
      if (!await registry.closeOwner(recovery.owner)) throw unavailable()
    } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Native output qualification closure was incomplete.')
    // Own probe markers only, after positive diagnostic closure.
    await removeProbeMarkers([hostPath, directPath, descendantPath, witnessPath, programPath])
  }
  try {
    const environment = inheritedAgentEnvironment()
    const redact = nativePersistenceRedactor(Object.values(environment)
      .filter((value): value is string => typeof value === 'string' && value.length >= 8))
    if (selected.expectedSandbox.tmpdir) environment.TMPDIR = selected.expectedSandbox.tmpdir
    const qualified = await input.qualify(selected.binary,
      selected.expectedSandbox.cwd, environment, true, signal, recovery)
    if (qualified.identity !== selected.binaryIdentity || qualified.schemaManifestSha256 !== selected.schemaIdentity) {
      throw unavailable()
    }
    const listed = await input.command(qualified.binary, ['mcp', 'list', '--json'], selected.expectedSandbox.cwd,
      signal, environment, { recovery })
    const servers: unknown = JSON.parse(listed.stdout)
    if (listed.exitCode !== 0 || !Array.isArray(servers) || servers.length > 500
      || servers.some((entry) => typeof entry?.name !== 'string')) throw unavailable()
    const disabled = servers.map(entry => String(entry.name))
    const mcpTransportOverrides = codexDisabledMcpTransports(servers, disabled)
    const observedTurn: { id?: string } = {}
    const commands: Array<{ threadId: string; turnId: string; item: JsonObject }> = []
    const commandOutput = new CodexCommandOutput()
    const terminals = new Map<string, { status: string; error: string | null }>()
    let complete!: () => void
    let fail!: (error: unknown) => void
    const done = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject })
    transport = new CodexStdioTransport(qualified.binary, selected.expectedSandbox.cwd, environment,
      qualified.protocol, async (request) => {
        await transport!.reject(request.id, -32601, 'No application tools in native output qualification.')
      }, (method, params) => {
        if (method === 'item/commandExecution/outputDelta' && typeof params.threadId === 'string'
          && typeof params.turnId === 'string' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
          commandOutput.append({ threadId: params.threadId, turnId: params.turnId,
            itemId: params.itemId, delta: params.delta })
        }
        if (method === 'item/completed') {
          const item = object(params.item)
          if (item.type === 'commandExecution' && typeof params.threadId === 'string' && typeof params.turnId === 'string') {
            commands.push({ threadId: params.threadId, turnId: params.turnId, item })
          }
          if (item.type === 'functionCallOutput' && typeof item.id === 'string'
            && typeof params.threadId === 'string' && typeof params.turnId === 'string') {
            commandOutput.complete({ threadId: params.threadId, turnId: params.turnId,
              itemId: item.id, output: item.output })
          }
        }
        if (method === 'rawResponseItem/completed') {
          const item = object(params.item)
          if (item.type === 'function_call_output' && typeof item.call_id === 'string'
            && typeof params.threadId === 'string' && typeof params.turnId === 'string') {
            commandOutput.complete({ threadId: params.threadId, turnId: params.turnId,
              itemId: item.call_id, output: item.output })
          }
        }
        if (method === 'turn/completed') {
          const turn = object(params.turn)
          if (typeof turn.id === 'string' && typeof turn.status === 'string') {
            terminals.set(turn.id, { status: turn.status,
              error: turn.error == null ? null : redact.text(JSON.stringify(turn.error)).slice(0, 2048) })
            if (turn.id === observedTurn.id) complete()
          }
        }
      }, fail, 30_000, recovery, disabled, undefined, {
        nativeApps: probeNativeTools.apps, nativePlugins: probeNativeTools.plugins, mcpTransportOverrides,
      })
    await transport.start(signal)
    const policy = selected.expectedSandbox
    const started = object(await transport.request('thread/start', { cwd: policy.cwd,
      runtimeWorkspaceRoots: [policy.cwd], sandbox: 'workspace-write', approvalPolicy: 'never', ephemeral: true,
      experimentalRawEvents: true,
      model: selected.configuration.model,
      config: { ...Object.fromEntries(disabled.map((name) => [`mcp_servers.${name}.enabled`, false])),
        ...mcpTransportOverrides,
        'features.apps': probeNativeTools.apps,
        'features.plugins': probeNativeTools.plugins,
        model_reasoning_effort: selected.configuration.reasoningEffort,
        sandbox_workspace_write: { writable_roots: [...policy.writableRoots], network_access: policy.networkAccess,
          exclude_tmpdir_env_var: policy.excludeTmpdirEnvVar, exclude_slash_tmp: policy.excludeSlashTmp } },
    }, signal))
    const threadId = object(started.thread).id as string
    const actual = object(started.sandbox)
    const roots = actual.writableRoots
    if (!threadId || started.cwd !== policy.cwd || actual.type !== 'workspaceWrite'
      || !Array.isArray(roots) || roots.some((root) => typeof root !== 'string')
      || !sameCodexNativeOutputSandbox({ cwd: String(started.cwd), writableRoots: roots,
        networkAccess: actual.networkAccess === true, excludeTmpdirEnvVar: actual.excludeTmpdirEnvVar === true,
        excludeSlashTmp: actual.excludeSlashTmp === true, tmpdir: environment.TMPDIR }, policy)) {
      throw unavailable()
    }
    await writeFile(hostPath, marker, { flag: 'wx', mode: 0o600 })
    await unlink(hostPath)
    const program = codexNativeOutputSandboxProbeProgram({ directPath, descendantPath, witnessPath, marker })
    await writeFile(programPath, program, { flag: 'wx', mode: 0o400 })
    if (await readFile(programPath, 'utf8') !== program) throw unavailable()
    const command = codexNativeOutputSandboxProbeCommand(programPath)
    const turn = object(await transport.request('turn/start', { threadId, clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: `Run this exact command once with the native shell tool. Do not change it, request broader permissions, or use other tools. Then finish.\n${command}`, text_elements: [] }],
    }, signal))
    const turnId = object(turn.turn).id as string
    observedTurn.id = turnId
    if (!turnId) throw unavailable()
    if (!terminals.has(turnId)) {
      let aborted!: () => void
      try {
        await Promise.race([done, new Promise<never>((_resolve, reject) => {
          aborted = () => reject(signal.reason)
          signal.addEventListener('abort', aborted, { once: true })
          if (signal.aborted) aborted()
        })])
      } finally { signal.removeEventListener('abort', aborted) }
    }
    if (await readFile(programPath, 'utf8') !== program) throw unavailable()
    const observed = commands.filter((entry) => entry.threadId === threadId && entry.turnId === turnId)
    if (terminals.get(turnId)?.status !== 'completed' || observed.length !== 1
      || !matchesCodexNativeProbeCommand(observed[0]!.item.command, command, environment.SHELL ?? '/bin/bash')
      || observed[0]!.item.status !== 'completed' || observed[0]!.item.exitCode !== 0) {
      throw new DomainError('WORKER_NATIVE_OUTPUT_PROTECTION_FAILED',
        'The original native sandbox probe did not execute the required command.', 409, {
          terminalStatus: terminals.get(turnId)?.status ?? null,
          terminalError: terminals.get(turnId)?.error ?? null,
          expectedCommandDigest: createHash('sha256').update(command).digest('hex'),
          commands: observed.map(({ item }) => ({ status: item.status, exitCode: item.exitCode,
            commandType: typeof item.command,
            commandDigest: typeof item.command === 'string'
              ? createHash('sha256').update(item.command).digest('hex') : null,
            output: matchesCodexNativeProbeCommand(item.command, command, environment.SHELL ?? '/bin/bash')
              && typeof item.aggregatedOutput === 'string' ? redact.text(item.aggregatedOutput).slice(0, 2048) : null,
            command: typeof item.command === 'string' && item.command.includes(marker)
              ? redact.text(item.command).slice(0, 4096) : null })),
        })
    }
    const originalCommand = observed[0]!
    const aggregate = recordedCodexCommandOutput(observed.map(entry => ({ turnId: entry.turnId, item: entry.item })),
      { turnId, itemId: originalCommand.item.id as string, command: originalCommand.item.command })
    const output = typeof originalCommand.item.id === 'string'
      ? commandOutput.read({ threadId, turnId, itemId: originalCommand.item.id }, aggregate)
      : undefined
    const result = parseCodexNativeProbeOutput(output, marker)
    if (!result) {
      throw new DomainError('WORKER_NATIVE_OUTPUT_PROTECTION_FAILED',
        'The original native sandbox command emitted no unique probe result.', 409, {
          firstOutputWord: typeof output === 'string' ? /^[A-Za-z]{1,12}/u.exec(output)?.[0] ?? null : null,
          hasMatchingMarker: typeof output === 'string' && output.includes(marker),
          output: typeof output === 'string' ? redact.text(output).slice(0, 8192) : null,
        })
    }
    const witness: unknown = JSON.parse(await readFile(witnessPath, 'utf8'))
    if (!isDeepStrictEqual(result, witness) || result.marker !== marker || result.uid !== process.getuid?.()
      || !result.direct?.denied || !result.descendant?.denied || result.descendantExitCode !== 0) throw unavailable()
    assertCodexProtectedOutputPlacement(protectedDirectory, { ...policy, tmpdir: result.tmpdir ?? undefined })
    for (const path of [directPath, descendantPath]) {
      try { await access(path); throw unavailable() }
      catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    await assertCodexUnchanged(qualified)
    await input.assertCurrent(signal)
  } catch (error) {
    failure = { error }
    throw error
  } finally {
    await cleanupProbe().catch((error: unknown) => {
      if (failure) throw new AggregateError([failure.error, error],
        'Native output qualification and cleanup both failed.', { cause: error })
      throw error
    })
  }
}

async function removeProbeMarkers(paths: string[]): Promise<void> {
  for (const path of paths) {
    await unlink(path).catch((error: unknown) => {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    })
  }
}
