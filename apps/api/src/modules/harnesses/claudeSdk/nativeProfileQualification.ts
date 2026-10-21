import { errorMessage } from '../../../shared/errorMessage.js'
import { asRecord } from '../../../shared/records.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { HostHarnessProfileEvidenceSchema, type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { CLAUDE_QUALIFICATION_CHECKS, claudeQualificationCapabilities, type ClaudeQualificationPin, type ClaudeQualificationProof } from '@foreman-code/contracts/claude-qualification'
import type { NativeProcessRecovery } from '../recovery/processRegistry.js'
import type { RegistryHarnessSelection } from '../installationRegistry.js'
import { DomainError } from '../../errors.js'
import { claudeCandidateConfiguration } from './configuration.js'
import { loadOfficialClaudeSdk } from './official.js'
import { createClaudeSdkRunner } from './runner.js'
import type { ClaudeSdkClient, ClaudeSdkSession } from './port.js'
import { ClaudeFullAccessConfigurationSchema } from '@foreman-code/contracts/claude'
import { CLAUDE_PROFILE_CHECK_REVISION } from './profileRevision.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const exists = async (path: string) => readFile(path).then(() => true, () => false)

/** Finite real subscription scenarios run only from the explicit authenticated
 * host-profile check. Every check links to the recorded native evidence file;
 * initialization alone never creates lifecycle or OS policy proof. */
export async function qualifyClaudeNativeProfile(input: {
  value: HostHarnessOverride; checkId: string; binding: RegistryHarnessSelection; pin: ClaudeQualificationPin
  directory: string; recovery: NativeProcessRecovery; signal: AbortSignal
  assertCurrent(): Promise<void>; sdkEntrypoint?: string; loadClient?: typeof loadOfficialClaudeSdk; apiKey?: string
}) {
  if (input.value.configuration.harness !== 'claude') throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'Claude qualification requires a Claude profile.', 409)
  const configuration = ClaudeFullAccessConfigurationSchema.parse(input.value.configuration)
  const binary = input.binding.installation.launcher.resolvedLauncher
  if (!binary) throw new DomainError('CLAUDE_INSTALLATION_UNAVAILABLE', 'The exact Claude executable is unavailable.', 409)
  await mkdir(input.directory, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(input.directory, 'claude-profile-'))
  const cwd = join(directory, 'work'), outside = join(directory, 'outside.txt')
  const denied = join(directory, 'denied.txt')
  await mkdir(cwd, { mode: 0o700 }); await mkdir(join(cwd, '.claude'), { mode: 0o700 })
  // An owned project sentinel verifies that ambient settings/hooks are excluded.
  const ambient = join(directory, 'ambient-hook.txt')
  const quotedAmbient = `'${ambient.replaceAll("'", "'\\''")}'`
  await writeFile(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `printf ambient > ${quotedAmbient}` }] }] } }), { mode: 0o600 })
  const compiled = claudeCandidateConfiguration(configuration, cwd, process.env, input.apiKey)
  const evidence: Record<string, unknown> = { checkId: input.checkId, pin: input.pin, configurationFingerprint: input.value.configurationFingerprint,
    cwd, model: compiled.model, effort: compiled.effort, sandbox: compiled.sandbox, sessions: [], hooks: [], receipts: [] }
  const passed = new Set<typeof CLAUDE_QUALIFICATION_CHECKS[number]>()
  const hooks: Array<{ sessionId: string; toolUseId: string; tool: string; file?: string; command?: string; denied: boolean }> = []
  evidence.hooks = hooks
  let observedTools: string[] = [], faultAfterResult = false, expectedFault = false
  const client = await (input.loadClient ?? loadOfficialClaudeSdk)(
    configuration.configDirectory, input.recovery, binary, input.sdkEntrypoint)
  const faultClient: ClaudeSdkClient = { ...client, async query(query) {
    const actual = await client.query(query)
    return { ...actual, [Symbol.asyncIterator]() {
      const iterator = actual[Symbol.asyncIterator]()
      return { async next() {
        if (expectedFault) throw new Error('qualification-owned post-result transport fault')
        const next = await iterator.next()
        if (faultAfterResult && asRecord(next.value).type === 'result') {
          faultAfterResult = false
          expectedFault = true
          return { done: false, value: next.value }
        }
        return next
      } }
    } }
  } }
  // Fault injection uses actual native output. It cannot fabricate a result,
  // receipt or session ID, and is recorded separately from ordinary turns.
  const runner = createClaudeSdkRunner({ loadClient: async () => faultClient })
  const callbacks: Pick<Options, 'canUseTool' | 'hooks'> = {
    canUseTool: async (tool, value) => {
      const path = typeof value.file_path === 'string' ? value.file_path : undefined
      if (tool === 'Write' && [outside, denied].includes(path ?? '')) return { behavior: 'allow', updatedInput: value }
      return { behavior: 'deny', message: 'The qualification owner authorizes only its exact disposable fixture.' }
    },
    hooks: { PreToolUse: [{ hooks: [async hook => {
      if (hook.hook_event_name !== 'PreToolUse') return {}
      const path = asRecord(hook.tool_input).file_path
      const command = asRecord(hook.tool_input).command
      const blocked = path === denied
      hooks.push({ sessionId: hook.session_id, toolUseId: hook.tool_use_id, tool: hook.tool_name,
        ...(typeof path === 'string' ? { file: path } : {}),
        ...(typeof command === 'string' ? { command } : {}), denied: blocked })
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: blocked ? 'deny' : 'ask',
        permissionDecisionReason: 'Qualification-owned fixture policy' } }
    }] }] },
  }
  const scope = { deviceId: input.value.target.applicationInstallationId, profilePath: configuration.configDirectory,
    configRevision: input.pin.configRevision, cwd }
  const sdkOptions: Record<string, unknown> = { ...compiled, ...callbacks, includePartialMessages: true,
    // Built-in policy is qualified here; MCP tools require the owner's authenticated server manifest.
    mcpServers: {} }
  delete sdkOptions.configuration
  const open = async (resume?: string) => {
    await input.assertCurrent(); input.signal.throwIfAborted()
    return runner.open({ scope, signal: input.signal, options: sdkOptions,
      ...(resume ? { resume: { ...scope, nativeSessionId: resume } } : {}), cancelPendingRequests: () => {} })
  }
  const turn = async (session: ClaudeSdkSession, content: string) => {
    const promptUuid = randomUUID(), frames: unknown[] = []
    await session.offer({ promptUuid, content }, input.signal)
    const iterator = session.output[Symbol.asyncIterator]()
    let result: Record<string, unknown> | undefined
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      const frame = asRecord(next.value.raw)
      frames.push(frame)
      if (frame.type === 'system' && frame.subtype === 'init') {
        observedTools = Array.isArray(frame.tools)
          ? frame.tools.filter((tool): tool is string => typeof tool === 'string' && !tool.startsWith('mcp__'))
          : []
        if (frame.cwd === cwd) passed.add('workingDirectory')
      }
      if (frame.type === 'result') { result = frame; break }
    }
    const receipt = session.reconcile(promptUuid)
    ;(evidence.receipts as unknown[]).push({ promptUuid, frames, receipt })
    if (!result || result.is_error === true || result.subtype !== 'success' || !receipt.some(row => row.kind === 'result' && row.nativeSessionId === session.nativeSessionId)) {
      throw new DomainError('CLAUDE_NATIVE_RECEIPT_UNQUALIFIED', 'The native scenario returned no exact successful message receipt.', 409)
    }
    return { result, promptUuid, frames, receipt }
  }
  let failure: { code: string; message: string } | undefined
  try {
    const first = await open()
    const initialization = asRecord(await first.initializationResult?.())
    evidence.initialization = { hooksApplied: initialization.hooks_applied, models: Array.isArray(initialization.models)
      ? initialization.models.map(row => ({ value: asRecord(row).value, resolvedModel: asRecord(row).resolvedModel })) : [] }
    if (!Array.isArray(initialization.models)) throw new Error('Native SDK initialization did not return its catalog.')
    const model = initialization.models.map(asRecord).find(row => row.resolvedModel === configuration.model || row.value === configuration.model)
    if (!model || configuration.effort && (!Array.isArray(model.supportedEffortLevels) || !model.supportedEffortLevels.includes(configuration.effort))) throw new DomainError('CLAUDE_MODEL_UNAVAILABLE', 'The accepted model and effort are absent from the exact native catalog.', 409)
    passed.add('sdkInitialization')
    const marker = `CLAUDE_PROFILE_${randomUUID()}`
    const one = await turn(first, `Remember this exact diagnostic marker: ${marker}. Reply with only the marker. Do not use tools.`)
    if (!String(one.result.result).includes(marker)) throw new Error('The first native turn did not return the diagnostic marker.')
    const nativeSessionId = first.nativeSessionId!
    ;(evidence.sessions as unknown[]).push(nativeSessionId)
    const two = await turn(first, `Reply with only the diagnostic marker from my previous message. Do not use tools.`)
    if (!String(two.result.result).includes(marker) || first.nativeSessionId !== nativeSessionId || one.promptUuid === two.promptUuid) throw new Error('Second-turn context or native message ownership changed.')
    passed.add('firstSecondTurn'); passed.add('exactMessageReceipt')
    const wakeUuids = [randomUUID(), randomUUID()], wakeFrames: unknown[] = []
    await first.offer({ promptUuid: wakeUuids[0]!, content: 'Reply exactly WAKE_FIRST. Do not use tools.' }, input.signal)
    await first.offer({ promptUuid: wakeUuids[1]!, content: 'Reply exactly WAKE_SECOND. Do not use tools.' }, input.signal)
    const wakeIterator = first.output[Symbol.asyncIterator]()
    while (!wakeUuids.every(uuid => first.reconcile(uuid).some(receipt => receipt.kind === 'result' && receipt.nativeSessionId === nativeSessionId))) {
      const next = await wakeIterator.next()
      if (next.done) throw new Error('Queued native wake input ended without both exact receipts.')
      wakeFrames.push(next.value.raw)
      if (asRecord(next.value.raw).type === 'result' && asRecord(next.value.raw).is_error === true) throw new Error('Queued native wake scenario failed.')
    }
    evidence.queuedWakes = { promptUuids: wakeUuids, frames: wakeFrames, receipts: wakeUuids.map(uuid => first.reconcile(uuid)) }
    passed.add('wakeCorrelation')
    if (!await exists(ambient) && compiled.settingSources.length === 0 && Object.keys(compiled.mcpServers).length === 0) passed.add('settingsIsolation')
    // Configured MCP endpoints are excluded only from this diagnostic owner,
    // so their presence does not qualify endpoint availability or tool authority.
    if (!await exists(ambient) && initialization.hooks_applied === true) passed.add('settingsIsolation')
    if (compiled.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === '1' && !observedTools.some(tool => ['Agent', 'Task', 'TaskOutput', 'TaskStop'].includes(tool))) passed.add('backgroundTasksDisabled')
    await first.close(); passed.add('idleClose')
    const persisted = { ...scope, nativeSessionId }
    const before = await runner.history(persisted, scope, input.signal)
    if (before.some(row => JSON.stringify(row).includes(marker))) passed.add('exactHistory')
    const resumed = await open(nativeSessionId)
    const resumedTurn = await turn(resumed, 'Reply with only the diagnostic marker from our first message. Do not use tools.')
    if (resumed.nativeSessionId === nativeSessionId && String(resumedTurn.result.result).includes(marker)) passed.add('exactResume')
    if (configuration.sandbox === 'danger-full-access' && configuration.tools.includes('Write')) {
      const writeMarker = `OWNED_WRITE_${randomUUID()}`
      await turn(resumed, `Use Write to put exactly ${writeMarker} in ${outside}. This is an owned disposable diagnostic file. Then reply DONE.`)
      await turn(resumed, `Use Write to put exactly BLOCKED in ${denied}. If the diagnostic policy denies it, do not retry or use another tool. Reply DONE.`)
      if (await readFile(outside, 'utf8').then(value => value.trim() === writeMarker, () => false)
        && !await exists(denied) && hooks.some(hook => hook.file === outside && !hook.denied) && hooks.some(hook => hook.file === denied && hook.denied)) {
        passed.add('alwaysAppliedToolHook'); passed.add('fullAccessPolicy')
      }
    }
    await resumed.close()
    const sourceBefore = await runner.history(persisted, scope, input.signal)
    const forked = await runner.fork(persisted, scope, input.signal)
    const forkHistory = await runner.history(forked, scope, input.signal)
    const sourceAfter = await runner.history(persisted, scope, input.signal)
    if (forked.nativeSessionId !== nativeSessionId && digest(sourceBefore) === digest(sourceAfter)
      && forkHistory.some(row => JSON.stringify(row).includes(marker))) passed.add('forkPreservesSource')
    evidence.fork = { source: nativeSessionId, fork: forked.nativeSessionId, sourceBeforeSha256: digest(sourceBefore), sourceAfterSha256: digest(sourceAfter), forkHistorySha256: digest(forkHistory) }
    // Run the fault case from exact native resume; close the transport only
    // after its actual success result has entered the runner's output queue.
    const fault = await open(nativeSessionId)
    faultAfterResult = true
    const result = await turn(fault, 'Reply exactly RESULT_SURVIVES. Do not use tools.')
    const iterator = fault.output[Symbol.asyncIterator]()
    try { await iterator.next() } catch (error) {
      if (String(error).includes('qualification-owned post-result transport fault') && String(result.result.result).includes('RESULT_SURVIVES')) passed.add('resultThenThrow')
    }
    evidence.resultFaultInjection = { actualResultUuid: result.result.uuid, expectedError: 'qualification-owned post-result transport fault' }
    await fault.close()
    await input.assertCurrent()
  } catch (error) {
    input.signal.throwIfAborted()
    failure = { code: error instanceof DomainError ? error.code : 'CLAUDE_NATIVE_SCENARIO_FAILED', message: errorMessage(error, 'Native scenario failed.') }
    evidence.failure = failure
  } finally { await runner.dispose() }
  input.signal.throwIfAborted(); await input.assertCurrent()
  evidence.passedChecks = [...passed]
  const evidenceId = join(directory, 'evidence.json'), bytes = JSON.stringify(evidence)
  await writeFile(evidenceId, bytes, { mode: 0o600 })
  const evidenceSha256 = createHash('sha256').update(bytes).digest('hex')
  const claudeProof: ClaudeQualificationProof = { pin: input.pin, observedTools,
    checks: Object.fromEntries(CLAUDE_QUALIFICATION_CHECKS.map(check => [check, passed.has(check)
      ? { state: 'passed', source: 'native_scenario', evidenceId, evidenceSha256 } : { state: 'unverified' }])) }
  const capabilities = claudeQualificationCapabilities(claudeProof)
  const builtinToolsObserved = compiled.tools.every(tool => observedTools.includes(tool))
  const sandboxQualified = capabilities.policy.fullAccessPolicy
  const qualified = builtinToolsObserved && capabilities.basicTurns && capabilities.resume && capabilities.history
    && capabilities.policy.settingsIsolation && capabilities.policy.backgroundTasksDisabled
    && capabilities.policy.alwaysAppliedToolHook && sandboxQualified
  return HostHarnessProfileEvidenceSchema.parse({ target: input.value.target, instanceRevision: input.value.instanceRevision,
    configurationFingerprint: input.value.configurationFingerprint, driverId: 'claude', driverRevision: input.binding.installation.driverRevision,
    protocolRevision: input.binding.installation.protocolRevision, suiteRevision: CLAUDE_PROFILE_CHECK_REVISION,
    environmentGeneration: input.binding.installation.environmentGeneration, connectionGeneration: input.binding.installation.connectionGeneration,
    authenticated: passed.has('exactMessageReceipt'), compatible: capabilities.sdk, qualified, claudeProof,
    ...(!qualified ? { failure: failure ?? { code: 'CLAUDE_POLICY_UNQUALIFIED', message: 'The selected profile has not proved its native tool and OS policy. Full access requires an available Write tool and a proved tool policy.' } } : {}),
    checkedAt: new Date().toISOString() })
}
