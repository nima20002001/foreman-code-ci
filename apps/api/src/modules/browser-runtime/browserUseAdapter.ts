import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { DomainError } from '../errors.js'
import type { BrowserHostAction, BrowserNativeDispatch } from './types.js'

export interface BrowserRuntimeInstallation {
  rootDirectory: string; pythonExecutable: string; chromiumExecutable: string; bridgeScript: string
  runtimeVersion: string; profileFormat: number
}

export async function runBrowserUseAction(runtime: BrowserRuntimeInstallation, action: BrowserHostAction,
  dispatch: BrowserNativeDispatch, actionDirectory: string): Promise<void> {
  if (action.kind === 'dialog') {
    await dispatch('Page.handleJavaScriptDialog', { accept: action.accept, promptText: action.promptText ?? '' })
    return
  }
  if (action.kind === 'reload') { await dispatch('Page.reload'); return }
  if (action.kind === 'back' || action.kind === 'forward') {
    const history = await dispatch('Page.getNavigationHistory') as { currentIndex: number; entries: Array<{ id: number }> }
    const entry = history.entries[history.currentIndex + (action.kind === 'back' ? -1 : 1)]
    if (entry) await dispatch('Page.navigateToHistoryEntry', { entryId: entry.id })
    return
  }
  if (action.kind === 'upload' || action.kind === 'download') {
    throw new DomainError('BROWSER_FILE_PHASE_REQUIRED', 'Use this session’s owned file transfer phase.', 400)
  }
  if (action.kind === 'navigate') {
    const url = new URL(action.url)
    if (!['http:', 'https:', 'about:'].includes(url.protocol) || url.username || url.password
      || url.protocol === 'about:' && url.href !== 'about:blank') {
      throw new DomainError('BROWSER_URL_INVALID', 'Use an HTTP or HTTPS address, or about:blank.', 400)
    }
  }
  const home = await mkdtemp(join(actionDirectory, 'bridge-'))
  try { await runBridgeProcess(runtime, action, dispatch, home) }
  finally { await rm(home, { recursive: true, force: true }) }
}

function runBridgeProcess(runtime: BrowserRuntimeInstallation, action: BrowserHostAction,
  dispatch: BrowserNativeDispatch, home: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(runtime.pythonExecutable, ['-I', '-B', '-u', runtime.bridgeScript], {
      stdio: ['pipe', 'pipe', 'ignore'], cwd: runtime.rootDirectory,
      env: { PATH: `${join(runtime.rootDirectory, 'python', 'bin')}:/usr/bin:/bin`, LANG: 'C.UTF-8',
        HOME: home, BH_HOME: home, BH_AGENT_WORKSPACE: join(runtime.rootDirectory, 'empty-workspace'),
        PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
    })
    const lines = createInterface({ input: child.stdout })
    let completed = false, failure: unknown, settled = false, dispatchTail = Promise.resolve()
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true; clearTimeout(timeout); lines.close()
      if (error) reject(error); else resolve()
    }
    const timeout = setTimeout(() => {
      failure = new DomainError('BROWSER_ACTION_TIMEOUT', 'The browser action did not settle. Observe before retrying.', 504)
      child.kill('SIGTERM')
      finish(failure)
    }, 30_000)
    child.on('error', finish)
    child.stdin.on('error', error => { failure = error; child.kill('SIGTERM') })
    lines.on('line', line => {
      dispatchTail = dispatchTail.then(async () => {
        if (line.length > 524_288) throw new DomainError('BROWSER_BRIDGE_INVALID', 'Browser bridge output exceeded its bound.', 502)
        const message: unknown = JSON.parse(line)
        if (!message || typeof message !== 'object' || !('kind' in message)) throw new Error('Invalid bridge message')
        if (message.kind === 'complete') { completed = true; return }
        if (message.kind === 'failed') throw new DomainError('BROWSER_ACTION_FAILED', 'The browser action could not be confirmed.', 502)
        if (message.kind !== 'dispatch' || !('method' in message) || typeof message.method !== 'string'
          || !('params' in message) || !message.params || typeof message.params !== 'object') throw new Error('Invalid bridge dispatch')
        const value = await dispatch(message.method, message.params as Record<string, unknown>)
        child.stdin.write(`${JSON.stringify({ kind: 'result', ok: true, value })}\n`)
      }).catch(error => {
        failure = error
        if (!child.stdin.destroyed) child.stdin.end('{"kind":"result","ok":false}\n')
        child.kill('SIGTERM')
      })
    })
    child.on('close', () => { void dispatchTail.then(() => finish(failure ?? (completed ? undefined
      : new DomainError('BROWSER_ACTION_UNKNOWN', 'The browser action ended without a confirmed result.', 502)))) })
    child.stdin.write(`${JSON.stringify(action)}\n`)
  })
}
