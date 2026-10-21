import { createRequire } from 'node:module'
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { updateOperationalFailure } from '../diagnostics/operationalFailures.js'

const nativeTargets: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
}
function npmCodexBinary(launcher: string): string | undefined {
  const resolved = realpathSync(launcher)
  const manifest = JSON.parse(readFileSync(join(dirname(resolved), '..', 'package.json'), 'utf8')) as { name?: string }
  if (manifest.name !== '@openai/codex') return undefined
  const target = `${process.platform}-${process.arch}`
  const triple = nativeTargets[target]
  if (!triple) return undefined
  const nativePackage = createRequire(resolved).resolve(`@openai/codex-${target}/package.json`)
  const payload = join(dirname(nativePackage), 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
  accessSync(payload, constants.X_OK)
  return realpathSync(payload)
}
function installedCodex(path: string, bundled?: string): string | undefined {
  const excluded = new Set<string>()
  if (bundled) {
    excluded.add(realpathSync(bundled))
    try {
      const payload = npmCodexBinary(bundled)
      if (payload) excluded.add(payload)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  for (const directory of path.split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex')
    let candidateFound = false
    try {
      accessSync(candidate, constants.X_OK)
      candidateFound = true
      const resolved = realpathSync(candidate)
      if (excluded.has(resolved)) continue
      const prefix = readFileSync(resolved).subarray(0, 4).toString('hex')
      if (prefix === '7f454c46' || prefix.startsWith('4d5a')
        || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(prefix)) return resolved
      const payload = npmCodexBinary(resolved)
      if (payload && !excluded.has(payload)) return payload
      if (!payload) logIgnoredError('harness', 'reject default Codex candidate',
        Object.assign(new Error('The default Codex launcher is unrecognized.'), { code: 'UNRECOGNIZED_CODEX_LAUNCHER' }))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['ENOENT', 'ENOTDIR', 'MODULE_NOT_FOUND'].includes(code ?? '')) throw error
      if (candidateFound) logIgnoredError('harness', 'reject default Codex candidate', error)
    }
  }
  return undefined
}

/** Shared by normal configuration and the DB-free build diagnostic. No fallback provider. */
export function harnessBinaries(environment: NodeJS.ProcessEnv): { codexBinary: string } {
  const codex = environment.CODEX_BINARY === undefined ? 'codex' : environment.CODEX_BINARY.trim()
  if (!codex) throw new Error('Configured harness binaries must not be empty.')
  if (codex !== 'codex') return { codexBinary: codex }
  let bundled: string | undefined
  try { bundled = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
  }
  let selected = installedCodex(environment.PATH ?? process.env.PATH ?? '', bundled)
  let selectedSource = 'installed-native'
  if (!selected && environment.CODEX_BINARY === undefined && bundled) {
    selected = bundled
    selectedSource = 'bundled-package'
  }
  if (!selected) {
    selected = codex
    selectedSource = 'command'
  }
  updateOperationalFailure('harness', 'reject default Codex candidate', { selectedSource })
  return { codexBinary: selected }
}
