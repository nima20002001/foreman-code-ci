import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** Abort rejects execFile before its child closes; shutdown must join both. */
export async function runCiRuntimeCommand(file: string, args: string[], options: {
  env: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal | undefined
}) {
  options.signal?.throwIfAborted()
  const task = execute(file, args, { ...options, encoding: 'utf8', killSignal: 'SIGKILL',
    maxBuffer: 256 * 1024 * 1024 })
  const child = task.child
  const completion = child ? new Promise<void>(resolve => { child.once('close', () => resolve()) }) : undefined
  // execFile's abort handler can use SIGTERM despite its killSignal option.
  const stop = () => { child?.kill('SIGKILL') }
  options.signal?.addEventListener('abort', stop, { once: true })
  if (options.signal?.aborted) stop()
  try {
    return await task
  } finally {
    await completion
    options.signal?.removeEventListener('abort', stop)
  }
}

export function closeCiRuntimeCommand(child: ChildProcess, name: string, signal?: AbortSignal): Promise<void> {
  const stop = () => { child.kill('SIGKILL') }
  let failure: unknown
  const task = new Promise<void>((resolve, reject) => {
    child.once('error', error => { failure = error })
    child.once('close', code => {
      signal?.removeEventListener('abort', stop)
      if (signal?.aborted) reject(signal.reason)
      else if (failure) reject(failure)
      else if (code === 0) resolve()
      else reject(new Error(`${name} exited ${code}`))
    })
  })
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  return task
}
