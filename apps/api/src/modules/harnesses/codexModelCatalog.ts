import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HarnessExecutionError } from './errors.js'
import { CodexStdioTransport, isObject, type JsonObject } from './codexStdioTransport.js'
import { assertCodexUnchanged, codexRequest, type QualifiedCodex } from './codexProtocol.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import { inheritedAgentEnvironment } from './secrets.js'
import { APP_MCP_SERVER_NAME, chatExcludedAppMcpServerNames } from './appMcpLauncher.js'
import { runCommand } from './process.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'

function reportRefreshFailure(): void {
  logIgnoredError('harness', 'refresh native model catalog',
    Object.assign(new Error('Native model refresh failed; using its validated cached catalog.'),
      { code: 'NATIVE_MODEL_REFRESH_FAILED' }), { dataAgeMs: null })
}

const MAX_MODELS = 10_000
const REFRESH_FAILURE = 'failed to refresh available models:'

export interface CodexModelInspection {
  qualified: QualifiedCodex
  assertUnchanged?: typeof assertCodexUnchanged
  readCachedModels?: (environment: NodeJS.ProcessEnv) => Promise<JsonObject[]>
  runCommand?: typeof runCommand
  transportFactory?: (...args: ConstructorParameters<typeof CodexStdioTransport>) =>
    Pick<CodexStdioTransport, 'start' | 'request' | 'close' | 'reject'>
}

/** Model metadata only: no thread creation, inference or native callback approval. */
export async function readNativeCodexModelCatalog(
  inspection: CodexModelInspection,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  recovery?: NativeProcessRecovery,
): Promise<JsonObject & { models: JsonObject[] }> {
  const assertUnchanged = inspection.assertUnchanged ?? assertCodexUnchanged
  await assertUnchanged(inspection.qualified)
  const metadataEnvironment = inheritedAgentEnvironment(environment)
  const listed = await (inspection.runCommand ?? runCommand)(inspection.qualified.binary,
    ['mcp', 'list', '--json'], workingDirectory, signal, metadataEnvironment,
    recovery ? { recovery } : {})
  let entries: unknown
  try { entries = JSON.parse(listed.stdout) }
  catch { entries = undefined }
  if (listed.exitCode !== 0 || !Array.isArray(entries) || entries.length > 500
    || !entries.every(entry => isObject(entry) && typeof entry.name === 'string')) {
    throw new HarnessExecutionError('CODEX_MCP_INSPECTION_FAILED',
      'Codex MCP configuration inspection failed; absence was not established.')
  }
  const configuredNames = new Set(entries.map((entry: JsonObject) => entry.name))
  const disabledMcpNames = chatExcludedAppMcpServerNames(APP_MCP_SERVER_NAME)
    .filter(name => configuredNames.has(name))
  let refreshFailed = false
  const factory: NonNullable<CodexModelInspection['transportFactory']> =
    inspection.transportFactory ?? ((...args) => new CodexStdioTransport(...args))
  const transport: ReturnType<typeof factory> = factory(inspection.qualified.binary, workingDirectory,
    { ...metadataEnvironment, RUST_LOG: 'codex_models_manager=error,codex_core::models_manager=error' },
    inspection.qualified.protocol,
    async request => { await transport.reject(request.id, -32601, 'Model inspection cannot answer native requests.') },
    () => undefined, () => undefined, undefined, recovery,
    disabledMcpNames, () => { refreshFailed = true })
  let catalog: ReturnType<typeof parseCodexModelCatalog> | undefined
  let failed = false
  let failure: unknown
  try {
    await transport.start(signal)
    const models: JsonObject[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await codexRequest(transport, 'model/list', {
        includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}),
      }, signal)
      for (const model of page.data) {
        if (!isObject(model) || typeof model.model !== 'string' || !Array.isArray(model.supportedReasoningEfforts)
          || !model.supportedReasoningEfforts.every(level => isObject(level)
            && typeof level.reasoningEffort === 'string')) invalid()
        const contextWindow = 'contextWindow' in model ? model.contextWindow : undefined
        models.push({ slug: model.model, display_name: model.displayName,
          visibility: model.hidden ? 'hide' : 'list', priority: models.length,
          supported_reasoning_levels: model.supportedReasoningEfforts.map(level => ({ effort: level.reasoningEffort })),
          additional_speed_tiers: model.additionalSpeedTiers,
          ...(Number.isSafeInteger(contextWindow) && Number(contextWindow) > 0
            ? { context_window: Number(contextWindow) } : {}) })
      }
      if (models.length > MAX_MODELS || page.nextCursor && (!page.data.length || cursors.has(page.nextCursor))) invalid()
      cursor = page.nextCursor ?? undefined
      if (cursor) cursors.add(cursor)
    } while (cursor)
    await assertUnchanged(inspection.qualified)
    catalog = parseCodexModelCatalog({ exitCode: 0, stdout: JSON.stringify({ models }), stderr: '' })
  } catch (error) {
    failed = true
    failure = error instanceof HarnessExecutionError && error.result.error?.code === 'CODEX_MODEL_CATALOG_INVALID'
      ? new HarnessExecutionError('CODEX_MODEL_CATALOG_INVALID',
        `Codex ${inspection.qualified.providerVersion} does not satisfy the model/list catalog response contract.`,
        false, { cause: error })
      : error
  }
  try { await transport.close() }
  catch (cleanup) {
    if (failed) throw new AggregateError([failure, cleanup], 'Native model inspection and cleanup failed.', { cause: cleanup })
    throw cleanup
  }
  if (failed) throw failure
  signal?.throwIfAborted()
  if (catalog!.models.some(model => model.context_window === undefined)) {
    const cached = await (inspection.readCachedModels ?? readCachedCodexModels)(metadataEnvironment)
    for (const model of catalog!.models) {
      const window = cached.find(entry => entry.slug === model.slug)?.context_window
      if (model.context_window === undefined && Number.isSafeInteger(window) && Number(window) > 0) {
        model.context_window = Number(window)
      }
    }
  }
  if (refreshFailed) reportRefreshFailure()
  return { ...catalog!, ...(refreshFailed ? { modelCatalogSource: 'cached' } : {}) }
}

async function readCachedCodexModels(environment: NodeJS.ProcessEnv): Promise<JsonObject[]> {
  const directory = environment.CODEX_HOME ?? join(homedir(), '.codex')
  let stdout: string
  try {
    stdout = await readFile(join(directory, 'models_cache.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return parseCodexModelCatalog({ exitCode: 0, stdout, stderr: '' }).models
}

function invalid(): never {
  throw new HarnessExecutionError('CODEX_MODEL_CATALOG_INVALID', 'Codex returned an invalid model catalog.')
}

/** Remote refresh warnings do not invalidate a successfully returned native catalog. */
export function parseCodexModelCatalog(result: {
  exitCode: number | null
  stdout: string
  stderr: string
}): JsonObject & { models: JsonObject[] } {
  if (result.exitCode !== 0) {
    throw new HarnessExecutionError('CODEX_MODEL_CATALOG_UNAVAILABLE',
      'Codex could not read the native model catalog. Retry after native discovery is available.', true)
  }
  let catalog: unknown
  try { catalog = JSON.parse(result.stdout) }
  catch (cause) {
    throw new HarnessExecutionError('CODEX_MODEL_CATALOG_INVALID',
      'Codex returned an invalid model catalog.', false, { cause })
  }
  if (!isObject(catalog) || !Array.isArray(catalog.models) || catalog.models.length > MAX_MODELS) invalid()
  const models: JsonObject[] = []
  const ids = new Set<string>()
  for (const model of catalog.models) {
    if (!isObject(model) || typeof model.slug !== 'string' || !model.slug || model.slug.length > 1_024
      || ids.has(model.slug) || !Array.isArray(model.supported_reasoning_levels)
      || !model.supported_reasoning_levels.every(level => isObject(level)
        && typeof level.effort === 'string' && level.effort.length > 0)
      || model.additional_speed_tiers !== undefined && (!Array.isArray(model.additional_speed_tiers)
        || !model.additional_speed_tiers.every(tier => typeof tier === 'string'))) invalid()
    ids.add(model.slug)
    models.push(model)
  }
  if (result.stderr.includes(REFRESH_FAILURE)) reportRefreshFailure()
  return { ...catalog, models,
    ...(result.stderr.includes(REFRESH_FAILURE) ? { modelCatalogSource: 'cached' } : {}) }
}
