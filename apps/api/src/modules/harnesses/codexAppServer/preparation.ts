/** Provider qualification, input preparation, MCP policy checks and accepted thread settings. */
import { worktreeSecurity } from '../worktreeSecurity.js'
import { codexDisabledMcpTransports } from '../codexNativeTools.js'
import { APP_MCP_SERVER_NAMES, APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import { timeRuntimeOperation } from '../../diagnostics/runtimeTiming.js'
import { isWorkflowStart, hasWorkflowRequest, sessionStartDirectory } from '../sessionStart.js'
import { chatExcludedAppMcpServerNames, appMcpServerName, appLauncherTokenName, isAppLauncher,
  isSupportedAppMcpServerName, isSupportedAppMcpTokenName } from '../appMcpLauncher.js'
import { normalize } from 'node:path'
import { CODEX_INTERACTION_SUPPORT, CodexHarnessConfigurationSchema, McpDetectionSchema,
  NativeHarnessCapabilitiesSchema, type CodexHarnessConfiguration, type McpDetection, type NativeHarnessCapabilities,
  type NativeSessionReference, nativeMcpServerAllowed } from '@foreman-code/contracts'
import { HarnessExecutionError } from '../errors.js'
import { codexNativeOutputDeclarations, type CodexNativeOutputQualificationInput } from '../codexNativeOutput.js'
import { readNativeCodexModelCatalog } from '../codexModelCatalog.js'
import { nativeQualification } from '../nativeQualification.js'
import { codexModelOptions } from '../operatorOptions.js'
import type { NativeSessionStart } from '../port.js'
import { runCommand } from '../process.js'
import { type QualifiedCodex } from '../codexProtocol.js'
import { canonicalJsonNumericKeysFirstLegacy } from '@foreman-code/contracts/canonical-json'
import { isObject, object, text, type JsonObject } from '../codexStdioTransport.js'
import type { CodexTransport, CodexDiagnosticOperations, Runtime, Prepared, CodexMcpConfigurationInspection,
  CodexQualificationEvidence } from './types.js'
import { advanced, accepted, ownerId, binding, validateEnvironmentVariables, validateEnvironmentOwner, configuration,
  sameSet, stringArray } from './support.js'
import { CodexManagerBase } from './base.js'

export abstract class CodexManagerPreparation extends CodexManagerBase {
  async capabilities(signal?: AbortSignal): Promise<NativeHarnessCapabilities> {
    await this.dependencies.prepareEnvironment?.()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const result = await this.dependencies.qualify(this.binary, this.inspection.workingDirectory ?? process.cwd(), this.dependencies.environment(), true, signal)
    return NativeHarnessCapabilitiesSchema.parse({
      provider: 'codex', providerVersion: result.providerVersion, persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: true,
      mcpDetection: true,
      supportedInteractionKinds: ['command_approval', 'file_approval', 'permission_profile',
        'mcp_tool_call_approval_question', 'mcp_confirmation', 'tool_user_input', 'mcp_elicitation'],
      interactionSupport: CODEX_INTERACTION_SUPPORT,
    })
  }

  /** Qualify the same native transport/settings without creating a thread or issuing an App credential. */
  async qualifyConfiguration(value: CodexHarnessConfiguration, workingDirectory: string, signal?: AbortSignal) {
    await this.dependencies.prepareEnvironment?.()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const parsed = CodexHarnessConfigurationSchema.safeParse(value)
    if (!parsed.success) throw new HarnessExecutionError('CODEX_SETTING_INVALID', 'The accepted Codex configuration is invalid.')
    const environment = this.dependencies.environment()
    const qualified = await this.dependencies.qualify(this.binary, workingDirectory, environment, true, signal)
    await this.validateMcpPolicies(parsed.data, qualified.binary, workingDirectory, environment, signal)
    const modelFacts = await this.dependencies.qualifyModel(parsed.data, qualified.binary, workingDirectory, environment, signal,
      undefined, { qualified, assertUnchanged: this.dependencies.assertUnchanged,
        runCommand: this.dependencies.runCommand,
        transportFactory: (...args) => this.ownTransport(this.dependencies.transport(...args)) })
    return { ...nativeQualification(parsed.data, qualified.providerVersion),
      ...(typeof modelFacts === 'object' && modelFacts.modelCatalogSource
        ? { modelCatalogSource: modelFacts.modelCatalogSource } : {}) }
  }

  async discoverModels(workingDirectory: string, signal?: AbortSignal) {
    await this.dependencies.prepareEnvironment?.()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const qualified = await this.dependencies.qualify(this.binary, workingDirectory, this.dependencies.environment(), true, signal)
    await this.dependencies.assertUnchanged(qualified)
    const catalog = await readNativeCodexModelCatalog({ qualified, assertUnchanged: this.dependencies.assertUnchanged,
      runCommand: this.dependencies.runCommand,
      transportFactory: (...args) => this.ownTransport(this.dependencies.transport(...args)) },
      workingDirectory, this.dependencies.environment(), signal, this.processRecovery)
    return { providerVersion: qualified.providerVersion, models: codexModelOptions(catalog) }
  }

  async qualificationEvidence(signal?: AbortSignal): Promise<CodexQualificationEvidence> {
    await this.dependencies.prepareEnvironment?.()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const result = await this.dependencies.qualify(this.binary, this.inspection.workingDirectory ?? process.cwd(), this.dependencies.environment(), true, signal)
    return {
      providerVersion: result.providerVersion, schemaManifestSha256: result.schemaManifestSha256,
      referenceSchemaManifestSha256: result.referenceSchemaManifestSha256, stableSchemaGitBlob: result.stableSchemaGitBlob,
      schemaVerification: 'installed-contract-validation',
      authentication: 'chatgpt', productionSupported: false,
      productionRestriction: 'Codex app-server remains experimental upstream. It is the only application execution transport; native qualification failure refuses execution.',
    }
  }

  async inspectMcp(signal?: AbortSignal): Promise<McpDetection> {
    const checkedAt = this.dependencies.now().toISOString()
    try {
      const value = await this.inspectMcpConfiguration(this.inspection.workingDirectory ?? process.cwd(), signal)
      return McpDetectionSchema.parse({
        harness: 'codex', serverName: value.serverName,
        state: value.configured.enabled ? 'status_unavailable' : 'disabled',
        endpointMatches: value.configured.automaticEndpoint === true && value.configured.transport === 'stdio' ? true : null,
        credentialEnvironmentVariable: isSupportedAppMcpTokenName(value.configured.bearerTokenEnvironmentVariable ?? undefined)
          ? value.configured.bearerTokenEnvironmentVariable : null,
        checkedAt,
        detail: 'CLI inspection proves configuration only; inspectNativeMcp reports runtime status.',
      })
    } catch (error) {
      if (signal?.aborted) throw error
      const notConfigured = error instanceof HarnessExecutionError && error.result.error?.code === 'CODEX_MCP_NOT_CONFIGURED'
      return McpDetectionSchema.parse({
        harness: 'codex', serverName: this.appMcpServerName, state: notConfigured ? 'not_detected' : 'check_failed',
        endpointMatches: null, credentialEnvironmentVariable: null, checkedAt,
        ...(error instanceof Error && error.name === 'TimeoutError'
          ? { detail: 'Native MCP inspection timed out. Retry after Codex finishes starting.' } : {}),
      })
    }
  }

  async inspectMcpConfiguration(cwd: string, signal?: AbortSignal): Promise<CodexMcpConfigurationInspection> {
    await this.dependencies.prepareEnvironment?.()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const environment = this.dependencies.environment()
    return timeRuntimeOperation('harness', 'native.inspect_mcp', async () => {
      const qualified = await this.dependencies.qualify(this.binary, cwd, environment, true, signal)
      return this.mcpConfiguration(qualified.binary, cwd, environment, qualified.providerVersion, signal)
    })
  }

  protected async prepareIdleInput(runtime: Runtime, source: NativeSessionStart, signal?: AbortSignal): Promise<Prepared> {
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    this.assertBinding(runtime, source)
    return this.dependencies.withDiagnostics({
      binary: runtime.qualified.binary, ...(this.expectedVersion ? { expectedVersion: this.expectedVersion } : {}), cwd: runtime.workingDirectory,
      configurationIdentity: runtime.configurationIdentity, signal,
      scopedCredentialVariables: [...new Set([...APP_MCP_TOKEN_NAMES, ...Object.keys(source.environment?.variables ?? {}),
        ...(runtime.scopedCredentialVariable ? [runtime.scopedCredentialVariable] : []),
        ...(runtime.strippedCredentialVariable ? [runtime.strippedCredentialVariable] : [])])],
    }, async (io) => {
      await io.assertUnchanged(runtime.qualified)
      const prepared = await this.prepareInput(source, signal, io, runtime.qualified.binary)
      const pin = (value: QualifiedCodex) => canonicalJsonNumericKeysFirstLegacy([value.binary, value.identity, value.providerVersion,
        value.schemaManifestSha256, value.stableSchemaGitBlob, value.referenceSchemaManifestSha256])
      if (pin(prepared.qualified) !== pin(runtime.qualified)) throw new HarnessExecutionError(
        'CODEX_SESSION_QUALIFICATION_MISMATCH', 'Idle inspection must retain the exact native executable and schema qualification.')
      await io.assertUnchanged(runtime.qualified)
      return prepared
    })
  }

  protected assertIdleAfterDiagnostics(runtime: Runtime, before: Pick<Runtime, 'generation' | 'transport' | 'closed'>, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    this.shutdownController.signal.throwIfAborted()
    if (this.requireRuntime(runtime.session) !== runtime || runtime.generation !== before.generation
      || runtime.transport !== before.transport || runtime.closed !== before.closed) {
      throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'The inspected native process changed before control dispatch.')
    }
    // A previously closed refresh can retry retained cleanup; a new disconnect
    // during inspection must never turn that inspection into a replacement.
    this.assertIdle(runtime)
  }

  protected async prepareInput(source: NativeSessionStart, signal?: AbortSignal, io: CodexDiagnosticOperations = this.dependencies, binary = this.binary): Promise<Prepared> {
    await this.dependencies.prepareEnvironment?.()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const input = structuredClone(this.startupPreferences && !source.sessionPreferences
      ? { ...source, sessionPreferences: this.startupPreferences } : source)
    const observationOnly = (input.kind === 'operator' || input.kind === 'workflow-consultation') && input.observationOnly === true
    const appMcpDisabled = this.appMcpAccess === 'none' || observationOnly
    validateEnvironmentOwner(input)
    validateEnvironmentVariables(input.environment)
    if (observationOnly) delete input.environment
    if (this.chatFiles && this.appMcpAccess === 'scoped' && input.kind !== 'operator' && input.kind !== 'agent-chat') {
      throw new HarnessExecutionError('CODEX_FILE_CHAT_ISOLATION_REQUIRED',
        'Only conversation owners can combine file tools with scoped application credentials.')
    }
    if (this.appMcpAccess === 'none' && Object.keys(input.environment?.variables ?? {}).length) {
      throw new HarnessExecutionError('CODEX_APP_MCP_UNAVAILABLE', 'Agent chat cannot receive scoped App MCP credentials.')
    }
    const workingDirectory = sessionStartDirectory(input)
    const harnessConfiguration = hasWorkflowRequest(input)
      ? await worktreeSecurity(configuration(input), workingDirectory, signal)
      : configuration(input)
    const environment = io.environment(input.environment)
    const qualified = await io.qualify(binary, workingDirectory, environment, true, signal)
    await this.validateMcpPolicies(harnessConfiguration, qualified.binary, workingDirectory, environment, signal, io)
    let scopedCredentialVariable: string | undefined
    let excludedCredentialVariable: string | undefined
    let disabledMcpServerNames: readonly string[] = []
    let mcpTransportOverrides: Record<string, string> = {}
    let approvedAppMcpServerName: string | undefined
    const nativeTools = accepted(input).nativeTools
    const nativeApps = nativeMcpServerAllowed('codex_apps', nativeTools) ? nativeTools?.apps : false
    if (appMcpDisabled || nativeTools?.mcpServers !== undefined || nativeTools?.apps === false) {
      const listed = await io.runCommand(qualified.binary, ['mcp', 'list', '--json'], workingDirectory, signal, environment)
      let entries: unknown
      try { entries = JSON.parse(listed.stdout) } catch { entries = undefined }
      if (listed.exitCode !== 0 || !Array.isArray(entries) || entries.length > 500
        || !entries.every((entry: unknown) => isObject(entry) && typeof entry.name === 'string')) {
        throw new HarnessExecutionError('CODEX_MCP_INSPECTION_FAILED', 'Codex MCP configuration inspection failed; absence was not established.')
      }
      const configuredNames = entries.map((entry: JsonObject) => String(entry.name))
      const chatExcluded = appMcpDisabled ? chatExcludedAppMcpServerNames(this.appMcpServerName) : []
      disabledMcpServerNames = configuredNames.filter(name => chatExcluded.includes(name)
        || !nativeMcpServerAllowed(name, nativeTools))
      mcpTransportOverrides = codexDisabledMcpTransports(entries, disabledMcpServerNames)
    }
    try {
      const mcp = await this.mcpConfiguration(qualified.binary, workingDirectory, environment, qualified.providerVersion, signal, io)
      excludedCredentialVariable = mcp.configured.bearerTokenEnvironmentVariable ?? undefined
      if (!appMcpDisabled && mcp.configured.enabled) {
        scopedCredentialVariable = excludedCredentialVariable
        if (hasWorkflowRequest(input)) approvedAppMcpServerName = mcp.serverName
      }
    } catch (error) {
      if (!(error instanceof HarnessExecutionError) || error.result.error?.code !== 'CODEX_MCP_NOT_CONFIGURED') throw error
    }
    validateEnvironmentOwner(input, scopedCredentialVariable)
    const strippedCredentialVariable = appMcpDisabled ? excludedCredentialVariable : scopedCredentialVariable
    const scopedEnvironment = this.dependencies.environment(input.environment, strippedCredentialVariable ? [strippedCredentialVariable] : [])
    const modelFacts = await io.qualifyModel(harnessConfiguration, qualified.binary, workingDirectory,
      io.environment(input.environment, strippedCredentialVariable ? [strippedCredentialVariable] : []), signal,
      undefined, { qualified, assertUnchanged: io.assertUnchanged,
        runCommand: io.runCommand,
        transportFactory: (...args) => {
          args[9] = [...new Set([...(args[9] ?? []), ...disabledMcpServerNames])]
          args[11] = { ...args[11], nativeApps, mcpTransportOverrides }
          return this.ownTransport(this.dependencies.transport(...args))
        } })
    if (this.nativeOutputs && input.kind !== 'workflow-consultation') {
      if (!isWorkflowStart(input) || this.appMcpAccess !== 'scoped' || harnessConfiguration.sandbox === 'read-only'
        || harnessConfiguration.sandbox === 'danger-full-access' && this.nativeOutputs.storageKind !== 'buffer') {
        throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_UNQUALIFIED', 'Native outputs require an original writable workflow, scoped App MCP and compatible output storage.')
      }
      codexNativeOutputDeclarations(harnessConfiguration, qualified.providerVersion, this.nativeOutputs)
      await this.nativeOutputs.assertQualified(this.nativeOutputQualification(harnessConfiguration, qualified, workingDirectory, scopedEnvironment.TMPDIR), signal)
      signal.throwIfAborted()
    }
    return { input, harnessConfiguration, workingDirectory, scopedCredentialVariable, strippedCredentialVariable, environment: scopedEnvironment, qualified,
      disabledMcpServerNames, mcpTransportOverrides, nativeApps,
      contextBudgetLimit: typeof modelFacts === 'object' ? modelFacts.contextWindow ?? undefined : undefined,
      ...(approvedAppMcpServerName ? { approvedAppMcpServerName } : {}),
    }
  }

  protected async mcpConfiguration(binary: string, cwd: string, environment: NodeJS.ProcessEnv,
    providerVersion: string, signal?: AbortSignal, io: CodexDiagnosticOperations = this.dependencies): Promise<CodexMcpConfigurationInspection> {
    const candidates = isSupportedAppMcpServerName(this.appMcpServerName)
      ? APP_MCP_SERVER_NAMES : [this.appMcpServerName]
    const entries: Record<string, Awaited<ReturnType<typeof runCommand>>> = Object.create(null)
    for (const name of candidates) {
      const result = await io.runCommand(binary, ['mcp', 'get', name, '--json'], cwd, signal, environment)
      if (result.exitCode === 0) {
        entries[name] = result
        continue
      }
      // A failed command alone cannot prove absence: retain only the CLI's definite missing-entry reply.
      if (result.exitCode !== 1 || result.stdout.trim() !== ''
        || result.stderr.trim() !== `Error: No MCP server named '${name}' found.`) {
        throw new HarnessExecutionError('CODEX_MCP_INSPECTION_FAILED',
          'Codex could not establish the named MCP configuration.')
      }
    }
    const serverName = appMcpServerName(entries, this.appMcpServerName)
    const result = entries[serverName]
    if (!result) throw new HarnessExecutionError('CODEX_MCP_NOT_CONFIGURED', 'The named native MCP entry is absent.')
    try {
      const parsed = object(JSON.parse(result.stdout))
      const transport = isObject(parsed.transport) ? parsed.transport : {}
      const url = text(transport.url) ?? null
      return {
        providerVersion, binary, cwd, serverName, inspectionScope: 'effective_config',
        configured: {
          enabled: parsed.enabled !== false, required: parsed.required === true,
          transport: transport.type === 'streamable_http' || transport.type === 'stdio'
            ? transport.type : url ? 'streamable_http' : text(transport.command) ? 'stdio' : 'unknown',
          url, bearerTokenEnvironmentVariable: isAppLauncher(transport)
            ? appLauncherTokenName(transport) ?? null : text(transport.bearer_token_env_var) ?? null,
          automaticEndpoint: isSupportedAppMcpServerName(serverName) && isAppLauncher(transport),
          enabledTools: stringArray(parsed.enabled_tools) ?? null, disabledTools: stringArray(parsed.disabled_tools) ?? [],
          defaultToolsApprovalMode: text(parsed.default_tools_approval_mode) ?? null,
          tools: isObject(parsed.tools) ? parsed.tools : {},
        },
      }
    } catch { throw new HarnessExecutionError('CODEX_MCP_CONFIG_INVALID', 'Codex returned invalid structured MCP configuration.') }
  }

  protected nativeOutputQualification(configuration: CodexHarnessConfiguration, qualified: QualifiedCodex,
    cwd: string, tmpdir: string | undefined): CodexNativeOutputQualificationInput {
    const draft = advanced(configuration)
    return { configuration: structuredClone(configuration), binary: qualified.binary, binaryIdentity: qualified.identity,
      providerVersion: qualified.providerVersion, schemaIdentity: qualified.schemaManifestSha256,
      expectedSandbox: { cwd, writableRoots: [...draft.additionalWritableDirectories], tmpdir,
        networkAccess: draft.workspaceWrite?.networkAccess ?? false,
        excludeTmpdirEnvVar: draft.workspaceWrite?.excludeTmpdirEnvVar ?? false,
        excludeSlashTmp: draft.workspaceWrite?.excludeSlashTmp ?? false } }
  }

  protected async validateMcpPolicies(
    value: CodexHarnessConfiguration, binary: string, cwd: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal,
    io: CodexDiagnosticOperations = this.dependencies,
  ): Promise<void> {
    for (const [serverName, expected] of Object.entries(advanced(value).mcpServers)) {
      const result = await io.runCommand(binary, ['mcp', 'get', serverName, '--json'], cwd, signal, environment)
      if (result.exitCode !== 0) throw new HarnessExecutionError(expected.required ? 'CODEX_REQUIRED_MCP_UNAVAILABLE' : 'CODEX_MCP_POLICY_MISMATCH', 'An accepted MCP server is not configured.')
      let actual: JsonObject
      try { actual = object(JSON.parse(result.stdout)) } catch { throw new HarnessExecutionError('CODEX_MCP_CONFIG_INVALID', 'Codex returned invalid MCP policy data.') }
      const actualTools = isObject(actual.tools) ? actual.tools : {}
      const normalizedTools: JsonObject = {}
      for (const [name, policy] of Object.entries(actualTools)) {
        if (!isObject(policy)) throw new HarnessExecutionError('CODEX_MCP_CONFIG_INVALID', 'Codex returned invalid MCP tool policy.')
        const unknown = Object.keys(policy).filter((key) => !['enabled', 'approval_mode'].includes(key))
        if (unknown.length > 0) throw new HarnessExecutionError('CODEX_MCP_POLICY_UNSUPPORTED', 'The installed MCP tool policy contains unqualified fields.')
        normalizedTools[name] = {
          enabled: policy.enabled ?? true,
          ...(policy.approval_mode == null ? {} : { approvalMode: policy.approval_mode }),
        }
      }
      const expectedTools = Object.fromEntries(Object.entries(expected.tools ?? {}).map(([name, policy]) => [
        name, { ...policy, enabled: policy.enabled ?? true },
      ]))
      const mismatch = (actual.enabled !== false) !== expected.enabled || (actual.required === true) !== expected.required
        || !sameSet(stringArray(actual.enabled_tools), expected.enabledTools)
        || !sameSet(stringArray(actual.disabled_tools) ?? [], expected.disabledTools ?? [])
        || (text(actual.default_tools_approval_mode) !== expected.defaultToolsApprovalMode)
        || canonicalJsonNumericKeysFirstLegacy(normalizedTools) !== canonicalJsonNumericKeysFirstLegacy(expectedTools)
      if (mismatch) throw new HarnessExecutionError(
        expected.required && (actual.enabled === false || actual.required !== true) ? 'CODEX_REQUIRED_MCP_UNAVAILABLE' : 'CODEX_MCP_POLICY_MISMATCH',
        'Native MCP enabled/required/tool policies differ from the accepted configuration; no native configuration was rewritten.',
      )
    }
  }

  protected validateThreadResponse(prepared: Pick<Prepared, 'harnessConfiguration' | 'workingDirectory' | 'environment' | 'effectiveSandbox'>, response: JsonObject, expectedId?: string): JsonObject {
    const thread = object(response.thread, 'CODEX_THREAD_INVALID')
    if (!text(thread.id) || String(thread.id).length > 1_024 || (expectedId !== undefined && thread.id !== expectedId)) {
      throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Codex returned a different or missing thread identity.')
    }
    const value = prepared.harnessConfiguration
    const draft = advanced(value)
    const sandbox = object(response.sandbox, 'CODEX_EFFECTIVE_SETTINGS_MISMATCH')
    const sandboxType = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' }[value.sandbox]
    let mismatch = response.model !== value.model || response.reasoningEffort !== value.reasoningEffort
      || normalize(String(response.cwd)) !== normalize(prepared.workingDirectory)
      || canonicalJsonNumericKeysFirstLegacy(response.approvalPolicy) !== canonicalJsonNumericKeysFirstLegacy(draft.approvalPolicy)
      || response.approvalsReviewer !== draft.approvalsReviewer || sandbox.type !== sandboxType
      || (value.serviceTier === 'priority' ? !['fast', 'priority'].includes(String(response.serviceTier)) : ![null, 'default'].includes(response.serviceTier as string | null))
    if (value.sandbox === 'workspace-write') {
      const roots = stringArray(sandbox.writableRoots) ?? []
      const requested = draft.additionalWritableDirectories.map((path) => normalize(path))
      const allowed = new Set([normalize(prepared.workingDirectory), ...requested])
      mismatch ||= roots.some((path) => !allowed.has(normalize(path))) || requested.some((path) => !roots.some((root) => normalize(root) === path))
        || sandbox.networkAccess !== (draft.workspaceWrite?.networkAccess ?? false)
        || sandbox.excludeTmpdirEnvVar !== (draft.workspaceWrite?.excludeTmpdirEnvVar ?? false)
        || sandbox.excludeSlashTmp !== (draft.workspaceWrite?.excludeSlashTmp ?? false)
    }
    if (thread.ephemeral !== undefined && thread.ephemeral !== (draft.sessionPersistence === 'ephemeral')) mismatch = true
    if (mismatch) throw new HarnessExecutionError('CODEX_EFFECTIVE_SETTINGS_MISMATCH', 'Codex did not retain the accepted thread settings; execution is refused.')
    if (value.sandbox === 'workspace-write') prepared.effectiveSandbox = {
      cwd: String(response.cwd), writableRoots: stringArray(sandbox.writableRoots) ?? [],
      networkAccess: sandbox.networkAccess === true, excludeTmpdirEnvVar: sandbox.excludeTmpdirEnvVar === true,
      excludeSlashTmp: sandbox.excludeSlashTmp === true, tmpdir: prepared.environment.TMPDIR,
    }
    if (value.sandbox === 'danger-full-access' && this.nativeOutputs?.storageKind === 'buffer') {
      prepared.effectiveSandbox = { cwd: String(response.cwd), writableRoots: ['/'], networkAccess: true,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false, tmpdir: prepared.environment.TMPDIR }
    }
    return thread
  }

  protected runtime(prepared: Prepared, session: NativeSessionReference, transport: CodexTransport, attached = false): Runtime {
    return {
      ...(prepared.contextBudgetLimit ? { contextBudgetLimit: prepared.contextBudgetLimit } : {}),
      connectionId: this.dependencies.id(), schemaIdentity: prepared.qualified.schemaManifestSha256, arrivalOrdinal: 0, attached,
      binding: binding(prepared.input), ownerId: ownerId(prepared.input), configurationIdentity: canonicalJsonNumericKeysFirstLegacy(accepted(prepared.input)),
      input: prepared.input, workingDirectory: prepared.workingDirectory, configuration: prepared.harnessConfiguration,
      scopedCredentialVariable: prepared.scopedCredentialVariable, transport, session, generation: 0,
      approvedAppMcpServerName: prepared.approvedAppMcpServerName,
      strippedCredentialVariable: prepared.strippedCredentialVariable,
      qualified: { ...prepared.qualified },
      phase: 'idle', streamActive: false, starting: undefined, cancellation: undefined,
      files: undefined, fileCleanup: undefined, nativeOutput: undefined, nativeOutputCleanup: undefined,
      effectiveSandbox: prepared.effectiveSandbox ? structuredClone(prepared.effectiveSandbox) : undefined, fileRequests: new Map(),
      activeTurnId: undefined, activeCorrelationId: undefined, terminalResult: undefined, finalAnswer: undefined, lastAgentMessage: undefined,
      finalAnswerId: undefined, lastAgentMessageId: undefined,
      interactions: new Map(), resolvedRequests: new Map(), callbackOwners: new Map(), rejectedStarts: new Map(),
      responseDecisions: new Map(), responseDeliveries: new Map(),
      events: [], eventSizes: [], eventBytes: 0, sequence: 0,
      seenNotifications: new Set(), wake: new Set(), closed: false, disposed: false,
    }
  }
}
