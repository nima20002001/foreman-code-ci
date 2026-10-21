import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Owns only the frontend serving this disposable native application. */
export async function sessionControlsWeb(input: { root: string; baseUrl: string; browserOrigin: string }) {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    FOREMAN_CODE_BROWSER_ORIGIN: input.browserOrigin,
    FOREMAN_CODE_WEB_PORT: new URL(input.browserOrigin).port,
    VITE_API_URL: input.baseUrl,
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL(
    '../../../../scripts/acceptance/session-control-web.mjs', import.meta.url)), input.root], {
    env: environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  child.stderr?.pipe(process.stderr)
  let exit: number | null | undefined
  const closed = new Promise<void>((done, fail) => {
    child.once('error', fail)
    child.once('close', code => { exit = code; done() })
  })
  const close = async () => {
    if (exit === undefined) child.kill('SIGTERM')
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([closed, new Promise<never>((_done, fail) => {
        timer = setTimeout(() => fail(new Error('The owned browser fixture did not stop.')), 20000)
      })])
    } catch (error) {
      if (exit === undefined) child.kill('SIGKILL')
      await closed
      throw error
    } finally { clearTimeout(timer) }
    assert.equal(exit, 0, 'The owned browser fixture did not close successfully.')
  }
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([new Promise<void>((done, fail) => {
      child.on('message', message => {
        if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'ready') return
        if ('origin' in message && message.origin === input.browserOrigin) done()
        else fail(new Error('The browser fixture announced another origin.'))
      })
      void closed.then(() => fail(new Error('The browser fixture closed before readiness.')), fail)
    }), new Promise<never>((_done, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out starting the owned browser fixture.')), 60000)
    })])
    return { close }
  } catch (error) {
    try { await close() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Browser startup and cleanup failed.', { cause: cleanupError }) }
    throw error
  } finally { clearTimeout(timer) }
}
