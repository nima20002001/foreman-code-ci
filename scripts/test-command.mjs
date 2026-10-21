import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { stopGroup } from './integration-process.mjs'
import { completeTestResourceCleanup, provisionTestResources, registerTestResourceCleanup } from './test-resources.mjs'

const [separator, command, ...args] = process.argv.slice(2)
if (separator !== '--' || !command) throw new Error('Usage: test-command.mjs -- command [arguments]')
const resources = await provisionTestResources()
const invocation = { directory: resources.environment.FOREMAN_CODE_TEST_ROOT, token: resources.environment.FOREMAN_CODE_TEST_OWNER }
const cleanupId = registerTestResourceCleanup(invocation, { kind: 'suite-process-group', wrapperPid: process.pid })
let child
let shutdown
let interruptedCode
let interrupted
const interruption = new Promise((resolve, reject) => { interrupted = { resolve, reject } })
const interrupt = signal => {
  interruptedCode ??= signal === 'SIGINT' ? 130 : 143
  shutdown ??= stopGroup(child?.pid, { signal })
  void shutdown.then(() => interrupted.resolve(interruptedCode), interrupted.reject)
}
const onSigint = () => interrupt('SIGINT')
const onSigterm = () => interrupt('SIGTERM')
process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)
try {
  const verificationRoot = resources.environment.FOREMAN_CODE_VERIFICATION_ROOT
  const reported = command === 'vitest' && verificationRoot
  const launch = reported
    ? [process.execPath, fileURLToPath(new URL('./verification-reports.mjs', import.meta.url)), '__command',
      verificationRoot, process.cwd(), process.env.npm_lifecycle_event, command, ...args]
    : [command, ...args]
  child = spawn(launch[0], launch.slice(1), { env: resources.environment, stdio: 'inherit', detached: true })
  process.exitCode = await Promise.race([
    new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)))
    }),
    interruption,
  ])
} finally {
  try {
    shutdown ??= stopGroup(child?.pid, { signal: 'SIGTERM' })
    await shutdown
    completeTestResourceCleanup(invocation, cleanupId)
    await resources.close()
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    if (interruptedCode) process.exitCode = interruptedCode
  }
}
