import { createHash } from 'node:crypto'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { z } from 'zod'
import type { CodexHarnessConfiguration, NativeSessionReference } from '@foreman-code/contracts'
import { WorkerNativeOutputCommandSchema, WorkerNativeOutputReplySchema, WORKER_NATIVE_OUTPUT_TOOL_NAMES,
  type WorkerNativeOutputCommand, type WorkerNativeOutputReply } from '@foreman-code/contracts/worker-native-output'
import { HarnessExecutionError } from './errors.js'
import type { RequestId } from './codexStdioTransport.js'
import { harnessProfile } from './qualification/profiles.js'
import { warnCodexFileError } from './codexFiles/errorLog.js'

export interface CodexNativeOutputSandbox {
  cwd: string
  writableRoots: readonly string[]
  networkAccess: boolean
  excludeTmpdirEnvVar: boolean
  excludeSlashTmp: boolean
  /** Environment actually passed to this app-server, not a native argument. */
  tmpdir: string | undefined
}
/** Codex may report cwd as an explicit writable root or as the implicit workspace. */
export function sameCodexNativeOutputSandbox(actual: CodexNativeOutputSandbox, expected: CodexNativeOutputSandbox): boolean {
  const roots = (policy: CodexNativeOutputSandbox) => [...new Set([policy.cwd, ...policy.writableRoots])].sort()
  return actual.cwd === expected.cwd && actual.networkAccess === expected.networkAccess
    && actual.excludeTmpdirEnvVar === expected.excludeTmpdirEnvVar && actual.excludeSlashTmp === expected.excludeSlashTmp
    && actual.tmpdir === expected.tmpdir && JSON.stringify(roots(actual)) === JSON.stringify(roots(expected))
}
export interface CodexNativeOutputQualificationInput {
  configuration: CodexHarnessConfiguration
  binary: string
  binaryIdentity: string
  providerVersion: string
  schemaIdentity: string
  expectedSandbox: CodexNativeOutputSandbox
}
export interface CodexNativeOutputTurnPin {
  session: NativeSessionReference
  connectionId: string
  runtimeGeneration: number
  nativeTurnId: string
  assertCurrent(): void
}
export interface CodexNativeOutputCallback extends CodexNativeOutputTurnPin {
  rpcId: RequestId
  callId: string
}
export interface CodexNativeOutputBridge {
  /** Called only after the actual turn ACK has passed awaited durable admission. */
  activate(pin: CodexNativeOutputTurnPin, signal: AbortSignal): Promise<void>
  /** Compose callback.assertCurrent with W09 original authority/storage/budget checks on every await. */
  dispatch(command: WorkerNativeOutputCommand, callback: CodexNativeOutputCallback, signal: AbortSignal): Promise<WorkerNativeOutputReply>
  close(): Promise<void>
}
export interface CodexNativeOutputs {
  storageKind?: 'buffer'
  /** Genuine exact-binary protected-store qualification and current original grants;
   * required before declarations. No implementation or success fallback exists here. */
  assertQualified(input: CodexNativeOutputQualificationInput, signal: AbortSignal): Promise<void>
  /** Receives measured effective policy after native thread settings verification. */
  prepare(input: CodexNativeOutputQualificationInput & {
    session: NativeSessionReference; clientCorrelationId: string; connectionId: string; runtimeGeneration: number
    effectiveSandbox: CodexNativeOutputSandbox
  }, signal: AbortSignal): Promise<CodexNativeOutputBridge>
}
const operations = ['create', 'append', 'seal', 'publish'] as const
export const CODEX_NATIVE_OUTPUT_TOOL_ALIASES = Object.freeze(Object.fromEntries(operations.map(operation =>
  [WORKER_NATIVE_OUTPUT_TOOL_NAMES[operation].replaceAll('.', '_'), operation])) as Record<string, typeof operations[number]>)
const schemas = Object.fromEntries(WorkerNativeOutputCommandSchema.options.map(schema =>
  [schema.shape.operation.value, schema]))
export function codexNativeOutputDeclarations(configuration: CodexHarnessConfiguration, providerVersion: string,
  options: { storageKind?: 'buffer' } = {}) {
  const profile = harnessProfile('codex', providerVersion)
  if (configuration.sandbox === 'read-only'
    || configuration.sandbox === 'danger-full-access' && options.storageKind !== 'buffer'
    || !['codex-0.154', 'codex-0.156'].includes(profile ?? '')) {
    throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_UNQUALIFIED', 'Native output requires a qualified writable configuration and compatible output storage.')
  }
  return Object.entries(CODEX_NATIVE_OUTPUT_TOOL_ALIASES).map(([name, operation]) => ({ type: 'function' as const,
    name, description: `${operation} an original turn-owned native output through the qualified host. No paths or caller-supplied scope.`,
    inputSchema: z.toJSONSchema(schemas[operation]!, { target: 'draft-7', io: 'input' }), deferLoading: false }))
}
const refused = () => ({ success: false, contentItems: [{ type: 'inputText' as const, text: 'Native output operation unavailable or denied.' }] })
const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex')
/** Bounded turn-local receipts. They never grant authority to an artifact/output key. */
export class CodexRuntimeNativeOutputTurn {
  private pin?: CodexNativeOutputTurnPin
  private stopped = false
  private readonly stop = new AbortController()
  private readonly calls = new Map<string, string>()
  constructor(private readonly bridge: CodexNativeOutputBridge) {}
  async activate(pin: CodexNativeOutputTurnPin, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); pin.assertCurrent()
    await this.bridge.activate(pin, AbortSignal.any([signal, this.stop.signal]))
    signal.throwIfAborted(); pin.assertCurrent()
    if (this.stopped) throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_CLOSED', 'Native output turn closed during activation.')
    this.pin = pin
  }
  async dispatch(tool: string, raw: unknown, callback: CodexNativeOutputCallback) {
    const current = () => {
      if (this.stopped || !this.pin || !callback.callId.trim() || callback.callId.length > 1024
        || callback.connectionId !== this.pin.connectionId || callback.runtimeGeneration !== this.pin.runtimeGeneration
        || callback.session.nativeSessionId !== this.pin.session.nativeSessionId
        || callback.session.providerVersion !== this.pin.session.providerVersion || callback.session.harness !== 'codex'
        || callback.nativeTurnId !== this.pin.nativeTurnId) throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_CLOSED', 'Original native output callback changed.')
      this.pin.assertCurrent(); callback.assertCurrent()
    }
    try {
      current()
      const operation = CODEX_NATIVE_OUTPUT_TOOL_ALIASES[tool]
      const command = WorkerNativeOutputCommandSchema.parse(raw)
      if (!operation || command.operation !== operation) return refused()
      const signature = digest([tool, command])
      const prior = this.calls.get(callback.callId)
      if (prior !== undefined && prior !== signature) return refused()
      if (prior === undefined && this.calls.size >= 128) return refused()
      this.calls.set(callback.callId, signature)
      // Even a repeated callback re-enters the original registry's command receipt
      // and current authority checks; a cached native reply is never a grant.
      const reply = WorkerNativeOutputReplySchema.parse(await this.bridge.dispatch(command, callback, this.stop.signal))
      current()
      if (reply.operation !== operation) return refused()
      const response = { success: true, contentItems: [{ type: 'inputText' as const, text: JSON.stringify(reply) }] }
      if (Buffer.byteLength(JSON.stringify(response)) > 256 * 1024) return refused()
      return response
    } catch (error) { warnCodexFileError(error); return refused() }
  }
  close(): Promise<void> { this.stopped = true; this.stop.abort(); return Promise.resolve().then(() => this.bridge.close()) }
}
