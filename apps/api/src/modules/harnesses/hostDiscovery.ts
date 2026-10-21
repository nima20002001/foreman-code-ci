import { constants } from 'node:fs'
import { access, lstat, open, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { inventoryPayloadFingerprints, type PayloadFingerprintCache } from './payloadFingerprintCache.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'

export interface TargetEnvironment {
  readonly generation: string
  readonly provenance: 'terminal' | 'gui' | 'systemd' | 'ssh' | 'worker'
  readonly cwd: string
  readonly path: string
}
export interface LauncherEvidence {
  requested: string
  resolvedLauncher: string | null
  fingerprint: string | null
  payloadFingerprints?: { path: string; fingerprint: string }[]
  status: 'installed' | 'missing' | 'not-executable' | 'broken-symlink' | 'missing-interpreter' | 'unreadable'
  interpreter: string | null
  diagnostics: string[]
  environment: TargetEnvironment
  checkedAt: string
}

/** Empty/relative PATH components are deliberately ignored: no project cwd lookup. */
export async function discoverLauncher(requested: string, environment: TargetEnvironment, payloadPaths: readonly string[] = [], signal?: AbortSignal, fingerprintCache: PayloadFingerprintCache = inventoryPayloadFingerprints): Promise<LauncherEvidence> {
  signal?.throwIfAborted()
  const diagnostics: string[] = []
  const directories = environment.path.split(':').filter((entry) => {
    if (!entry || !isAbsolute(entry)) { diagnostics.push('Ignored empty or relative PATH entry.'); return false }
    return true
  })
  const candidates = requested.includes('/') ? [isAbsolute(requested) ? requested : resolve(environment.cwd, requested)] : directories.map((entry) => join(entry, requested))
  const evidence: LauncherEvidence = { requested, resolvedLauncher: null, fingerprint: null, status: 'missing', interpreter: null, diagnostics, environment: structuredClone(environment), checkedAt: new Date().toISOString() }
  for (const candidate of candidates) {
    signal?.throwIfAborted()
    let symbolicLink: boolean
    try { symbolicLink = (await lstat(candidate)).isSymbolicLink() } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        evidence.status = 'unreadable'
        logIgnoredError('harness', 'inspect launcher candidate', error)
      }
      continue
    }
    let resolved: string
    try { resolved = await realpath(candidate) } catch (error) {
      logIgnoredError('harness', 'resolve launcher candidate', error, {}, ['ENOENT'])
      evidence.status = symbolicLink ? 'broken-symlink' : 'unreadable'
      continue
    }
    try { await access(resolved, constants.X_OK); if (!(await stat(resolved)).isFile()) throw new Error('Not a file') }
    catch (error) {
      logIgnoredError('harness', 'inspect launcher access', error, {}, ['ENOENT'])
      evidence.status = 'not-executable'
      continue
    }
    try {
      const file = await open(resolved, 'r')
      const prefix = Buffer.alloc(4096)
      let bytesRead: number
      try { ({ bytesRead } = await file.read(prefix, 0, prefix.length, 0)) } finally { await file.close() }
      const firstLine = prefix.subarray(0, bytesRead).toString().split('\n')[0] ?? ''
      if (firstLine.startsWith('#!')) {
        const words = firstLine.slice(2).trim().split(/\s+/)
        const interpreter = words[0]!
        evidence.interpreter = interpreter
        try {
          await access(interpreter, constants.X_OK)
          evidence.interpreter = await realpath(interpreter)
          if (interpreter === '/usr/bin/env' || interpreter === '/bin/env' || evidence.interpreter === '/usr/bin/env' || evidence.interpreter === '/bin/env') {
            // env -S and other option-bearing shebangs need explicit diagnostics, not guessed support.
            const command = words[1]
            if (!command || command.startsWith('-')) throw new Error('Unsupported env shebang options')
            let found: string | null = null
            for (const directory of directories) {
              try { const path = await realpath(join(directory, command)); await access(path, constants.X_OK); if ((await stat(path)).isFile()) { found = path; break } } catch (error) { logIgnoredError('harness', 'inspect target interpreter candidate', error, {}, ['ENOENT', 'ENOTDIR']) }
            }
            if (!found) throw new Error('Missing env interpreter')
            evidence.interpreter = found
          }
        } catch (error) { logIgnoredError('harness', 'inspect launcher interpreter', error, {}, ['ENOENT']); evidence.status = 'missing-interpreter'; evidence.diagnostics.push(`Unavailable shebang interpreter: ${interpreter}`); continue }
      }
      evidence.resolvedLauncher = resolved
      const fingerprints = []
      for (const payloadPath of [resolved, ...payloadPaths]) {
        const path = await realpath(payloadPath)
        // The launcher must execute; payloads may be readable SDK/modules loaded by it.
        await access(path, constants.R_OK)
        const observation = await stat(path, { bigint: true })
        if (!observation.isFile()) throw new Error('Payload is not a file')
        const fingerprint = await fingerprintCache.fingerprint(path, { signal, observation })
        fingerprints.push({ path, fingerprint })
      }
      evidence.payloadFingerprints = fingerprints
      evidence.fingerprint = createHash('sha256').update(JSON.stringify(fingerprints)).digest('hex')
      evidence.status = 'installed'
      return evidence
    } catch (error) {
      signal?.throwIfAborted()
      logIgnoredError('harness', 'read launcher payload', error)
      evidence.status = 'unreadable'
    }
  }
  return evidence
}

export const discoverInventoryLauncher: typeof discoverLauncher = (requested, environment, paths = [], signal) =>
  discoverLauncher(requested, environment, paths, signal, inventoryPayloadFingerprints)

export interface VersionProbeResult { status: 'observed' | 'failed' | 'timeout' | 'output-limit'; stdout: string; stderr: string; exitCode: number | null }
/** Explicit trusted operation; arbitrary launchers are never claimed passive or safe. */
export function probeTrustedVersion(input: {
  launcher: string; allowlistedLaunchers: readonly string[]; environment: NodeJS.ProcessEnv
  neutralCwd: string; timeoutMs?: number; maximumBytes?: number
}): Promise<VersionProbeResult> {
  if (!isAbsolute(input.launcher) || !input.allowlistedLaunchers.includes(input.launcher) || !isAbsolute(input.neutralCwd)) throw new Error('Version probe requires an allowlisted absolute launcher and neutral cwd.')
  const limit = input.maximumBytes ?? 16_384
  const timeout = input.timeoutMs ?? 5_000
  if (limit < 1 || timeout < 1) throw new Error('Invalid version probe limits.')
  const environment: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (input.environment[key] !== undefined) environment[key] = input.environment[key]
  }
  return new Promise((resolveProbe) => {
    const child = spawn(input.launcher, ['--version'], { cwd: input.neutralCwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false })
    let stdout = ''; let stderr = ''; let bytes = 0
    let status: VersionProbeResult['status'] = 'observed'
    const stop = () => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        logIgnoredError('harness', 'kill version probe process group', error, { pid: child.pid }, ['ESRCH'])
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => { status = 'timeout'; stop() }, timeout)
    const receive = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const remaining = Math.max(0, limit - bytes)
      const text = chunk.subarray(0, remaining).toString()
      if (stream === 'stdout') stdout += text; else stderr += text
      bytes += chunk.length
      if (bytes > limit && status === 'observed') { status = 'output-limit'; stop() }
    }
    child.stdout.on('data', (chunk: Buffer) => receive(chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => receive(chunk, 'stderr'))
    child.on('error', () => { status = 'failed' })
    child.once('close', (exitCode) => { clearTimeout(timer); stop(); resolveProbe({ status: status === 'observed' && exitCode !== 0 ? 'failed' : status, stdout, stderr, exitCode }) })
  })
}

export function discoveryCacheKey(input: {
  deviceId: string; harnessInstallationId: string; installationFingerprint: string
  instanceId: string; instanceRevision: string; driverRevision: string; suiteRevision: string
  environmentGeneration: string; connectionGeneration: string
}): string { return JSON.stringify(input) }
