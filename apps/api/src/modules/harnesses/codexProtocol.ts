import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

import { HarnessExecutionError } from './errors.js'
import { requireHarnessQualification } from './qualification/gate.js'
import { rememberQualifiedProfile, QUALIFICATION_TARGET_PROFILE } from './qualification/profiles.js'
import { canonicalJsonNumericKeysFirstLegacy } from '@foreman-code/contracts/canonical-json'
import { object, type CodexProtocol, type JsonObject } from './codexStdioTransport.js'
import { runCommand } from './process.js'
import { CompatibilityCheckError } from './compatibility/errors.js'
import { checkCodexSchema } from './compatibility/schema.js'
import { protocolFromBundle } from './codexProtocolBundle.js'
import { passiveDriverPayloads } from './payloadDiscovery.js'
import { PayloadFingerprintCache } from './payloadFingerprintCache.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import type { CodexMethodMap } from './codexMethodTypes.js'

export type CodexClientMethod = keyof CodexMethodMap
export { CODEX_RESPONSE_FIELDS, protocolFromBundle } from './codexProtocolBundle.js'
/** Typed baseline methods retain the transport's qualified runtime-schema gate. */
export async function codexRequest<M extends CodexClientMethod>(
  transport: { request(method: string, params?: JsonObject, signal?: AbortSignal,
    late?: (value: unknown, error?: Error) => void): Promise<unknown> },
  method: M, params: CodexMethodMap[M]['params'], signal?: AbortSignal,
  late?: (value: CodexMethodMap[M]['result'], error?: Error) => void,
): Promise<CodexMethodMap[M]['result']> {
  const result = await transport.request(method, params, signal,
    late ? (value, error) => late(value as CodexMethodMap[M]['result'], error) : undefined)
  return result as CodexMethodMap[M]['result']
}

const BUNDLE = 'codex_app_server_protocol.schemas.json'

export interface QualifiedCodex {
  binary: string
  identity: string
  protocol: CodexProtocol
  providerVersion: string
  schemaManifestSha256: string
  stableSchemaGitBlob: string
  referenceSchemaManifestSha256: string
}

async function executable(binary: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const paths = isAbsolute(binary) || binary.includes('/') || binary.includes('\\')
    ? [resolve(cwd, binary)]
    : (environment.PATH ?? '').split(delimiter).flatMap((directory) => {
      const base = join(directory || cwd, binary)
      return process.platform === 'win32' && !/\.[a-z]+$/i.test(binary)
        ? (environment.PATHEXT ?? '.EXE;.COM').split(';').map((extension) => base + extension.toLowerCase())
        : [base]
    })
  for (const path of paths) {
    try { await access(path, constants.X_OK); return await realpath(path) } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  throw new HarnessExecutionError('CODEX_UNAVAILABLE', 'The configured Codex executable is unavailable.')
}

const executableFingerprints = new PayloadFingerprintCache()
export async function codexExecutableIdentity(binary: string): Promise<string> {
  const path = await realpath(binary)
  const value = await stat(path, { bigint: true })
  if (!value.isFile()) throw new HarnessExecutionError('CODEX_UNAVAILABLE', 'Codex must be a regular executable file.')
  const fingerprint = await executableFingerprints.fingerprint(path, { observation: value })
  const after = await stat(path, { bigint: true })
  if (value.dev !== after.dev || value.ino !== after.ino || value.size !== after.size
    || value.mode !== after.mode || value.mtimeNs !== after.mtimeNs || value.ctimeNs !== after.ctimeNs
    || await realpath(binary) !== path) {
    throw new HarnessExecutionError('CODEX_EXECUTABLE_CHANGED', 'Codex changed while reading its executable identity.')
  }
  // Preserve the identity's numeric fields while using nanoseconds for cache invalidation.
  const mtimeMs = Number(value.mtimeNs / 1_000_000n) + Number(value.mtimeNs % 1_000_000n) / 1_000_000
  return canonicalJsonNumericKeysFirstLegacy([
    path, Number(value.dev), Number(value.ino), Number(value.size), Number(value.mode), mtimeMs, fingerprint,
  ])
}

export async function codexBinaryIdentity(binary: string, options: { fresh?: boolean } = {}): Promise<string> {
  const payload = await passiveDriverPayloads('codex', binary, process.platform, process.arch,
    options.fresh ? undefined : executableFingerprints)
  const paths = [...new Set([await realpath(binary), ...payload.paths])].sort()
  return canonicalJsonNumericKeysFirstLegacy(await Promise.all(paths.map(path => codexExecutableIdentity(path))))
}

export async function assertCodexUnchanged(qualified: Pick<QualifiedCodex, 'binary' | 'identity'>,
  options: { fresh?: boolean } = { fresh: true }): Promise<void> {
  if (await codexBinaryIdentity(qualified.binary, options) !== qualified.identity) {
    throw new HarnessExecutionError('CODEX_EXECUTABLE_CHANGED', 'Codex changed during qualification; qualify the replacement before launch.')
  }
}

async function manifest(directory: string): Promise<string> {
  const entries: string[] = []
  let count = 0
  let total = 0
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(name)
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const info = await stat(join(directory, name))
        total += info.size
        if (++count > 2_000 || total > 64 * 1024 * 1024) throw new Error('Generated schemas exceeded their size limit.')
        const bytes = await readFile(join(directory, name))
        entries.push(`${name} ${createHash('sha256').update(bytes).digest('hex')}`)
      } else throw new Error('Unexpected generated schema entry.')
    }
  }
  await walk('')
  return createHash('sha256').update(entries.sort().join('\n') + '\n').digest('hex')
}

const verifiedProtocols = new Map<string, QualifiedCodex>()
const executableVersions = new Map<string, string>()

/** Authentication and installation identity are checked even when the protocol is cached. */
export async function qualifyCodex(
  binary: string, cwd: string, environment: NodeJS.ProcessEnv,
  requireAuthentication: boolean, signal?: AbortSignal, recovery?: NativeProcessRecovery,
): Promise<QualifiedCodex> {
  signal?.throwIfAborted()
  const resolved = await executable(binary, cwd, environment)
  const fingerprint = await codexBinaryIdentity(resolved)
  signal?.throwIfAborted()
  const command = (args: string[]) => runCommand(resolved, args, cwd, signal, environment, recovery ? { recovery } : {})
  let actual = executableVersions.get(fingerprint)
  if (!actual) {
    const version = await command(['--version'])
    const output = (version.stdout || version.stderr).trim()
    actual = /^codex-cli \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(output) ? output : 'unknown version'
    if (version.exitCode !== 0) actual = 'unknown version'
    if (actual !== 'unknown version') {
      if (executableVersions.size >= 64) executableVersions.delete(executableVersions.keys().next().value!)
      executableVersions.set(fingerprint, actual)
    }
  }
  const incompatible = (contract: string) => new HarnessExecutionError('CODEX_CONTRACT_UNSUPPORTED',
    `Codex ${actual || 'unknown version'} does not satisfy ${contract}.`)
  if (actual === 'unknown version') {
    throw incompatible('--version response')
  }
  if (requireAuthentication) {
    const auth = await command(['login', 'status'])
    if (auth.exitCode !== 0 || !`${auth.stdout}\n${auth.stderr}`.includes('Logged in using ChatGPT')) {
      throw new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED',
        `Codex ${actual} requires managed ChatGPT authentication for execution.`)
    }
  }
  const key = canonicalJsonNumericKeysFirstLegacy([resolved, actual, fingerprint])
  let result = verifiedProtocols.get(key)
  if (!result) {
    const directory = await mkdtemp(join(tmpdir(), 'graphql-codex-schema-'))
    try {
      const generated = await command(['app-server', 'generate-json-schema', '--experimental', '--out', directory])
      if (generated.exitCode !== 0) throw incompatible('app-server generate-json-schema --experimental')
      const bundle = object(JSON.parse(await readFile(join(directory, BUNDLE), 'utf8')), 'CODEX_SCHEMA_INVALID')
      checkCodexSchema(bundle)
      result = {
        binary: resolved, identity: fingerprint, protocol: protocolFromBundle(bundle, actual), providerVersion: actual,
        schemaManifestSha256: await manifest(directory), stableSchemaGitBlob: '', referenceSchemaManifestSha256: '',
      }
      await assertCodexUnchanged(result)
      if (verifiedProtocols.size >= 64) verifiedProtocols.delete(verifiedProtocols.keys().next().value!)
      verifiedProtocols.set(key, result)
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof Error && error.name === 'TimeoutError') throw error
      if (error instanceof HarnessExecutionError && error.result.error?.code === 'CODEX_EXECUTABLE_CHANGED') throw error
      if (error instanceof CompatibilityCheckError) {
        throw new HarnessExecutionError('CODEX_CONTRACT_UNSUPPORTED', `Codex ${actual}: ${error.message}`, undefined, { cause: error })
      }
      const contract = error instanceof HarnessExecutionError ? error.message : 'generated app-server protocol schema'
      throw incompatible(contract)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  await assertCodexUnchanged(result, { fresh: false })
  signal?.throwIfAborted()
  await requireHarnessQualification('codex', actual, resolved)
  rememberQualifiedProfile('codex', actual, QUALIFICATION_TARGET_PROFILE.codex)
  return result
}
