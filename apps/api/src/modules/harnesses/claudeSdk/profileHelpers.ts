import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { inheritedAgentEnvironment } from '../secrets.js'
import { DomainError } from '../../errors.js'

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads')
import(workerData.entrypoint).then(async sdk => {
  const value = await sdk[workerData.method](...workerData.args)
  parentPort.postMessage({ value })
}).catch(() => parentPort.postMessage({ failed: true }))
`

/** SDK filesystem helpers read process.env, so each call loads the SDK in its own profile environment. */
export async function claudeProfileHelper<T>(entrypoint: string, profilePath: string,
  method: 'getSessionInfo' | 'getSessionMessages' | 'listSubagents' | 'getSubagentMessages' | 'forkSession',
  args: readonly unknown[]): Promise<T> {
  const environment = inheritedAgentEnvironment()
  for (const key of Object.keys(environment)) {
    if (/^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$|OPENAI_|CODEX_)/.test(key)) delete environment[key]
  }
  environment.CLAUDE_CONFIG_DIR = profilePath
  const worker = new Worker(workerSource, { eval: true, env: environment, execArgv: [],
    workerData: { entrypoint: pathToFileURL(entrypoint).href, method, args } })
  try {
    return await new Promise<T>((resolve, reject) => {
      const failed = () => reject(new DomainError('CLAUDE_PROFILE_HELPER_FAILED',
        'Claude could not read or fork the selected account session.', 409))
      worker.once('message', (result: { value: T; failed?: boolean }) => result.failed ? failed() : resolve(result.value))
      worker.once('error', failed)
      worker.once('exit', failed)
    })
  } finally {
    await worker.terminate()
  }
}
