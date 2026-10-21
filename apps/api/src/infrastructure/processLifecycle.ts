import type { Logger } from 'pino'
import { flushLogsSync } from './logger.js'

/**
 * Nothing in the API process may end without a final log line. Installed first
 * in server.ts, before configuration or infrastructure can fail.
 *
 * Crashes keep Node's own semantics (exit 1) but are logged at fatal first.
 * The logger writes asynchronously, so each final line is drained explicitly before exit.
 * SIGKILL and the kernel OOM killer cannot be caught: the absence of a
 * `process exiting` line after the last entry means exactly that.
 */
export function installProcessLifecycleLogging(log: Logger, exit: (code: number) => void = (code) => process.exit(code)) {
  let crashed = false
  const crash = (kind: 'uncaught exception' | 'unhandled rejection') => (error: unknown) => {
    if (crashed) return
    crashed = true
    log.fatal({ err: error instanceof Error ? error : new Error(String(error)) }, kind)
    flushLogsSync()
    exit(1)
  }
  const onException = crash('uncaught exception'), onRejection = crash('unhandled rejection')
  const onWarning = (warning: Error) => log.warn({ err: warning }, 'process warning')
  const onSignal = (signal: NodeJS.Signals) => log.info({ signal }, 'shutdown signal received')
  const onExit = (code: number) => {
    log[code === 0 ? 'info' : 'error']({ exitCode: code, uptimeSeconds: Math.round(process.uptime()) }, 'process exiting')
    flushLogsSync()
  }
  process.on('uncaughtException', onException)
  process.on('unhandledRejection', onRejection)
  process.on('warning', onWarning)
  // Observe only, once: server.ts owns the shutdown, and a second signal must
  // still reach Node's default handler and end a hung shutdown.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.prependOnceListener(signal, onSignal)
  process.on('exit', onExit)
  return () => {
    process.off('uncaughtException', onException)
    process.off('unhandledRejection', onRejection)
    process.off('warning', onWarning)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, onSignal)
    process.off('exit', onExit)
  }
}
