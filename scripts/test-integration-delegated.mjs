import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// An explicit host test entry point; systemd owns and collects this invocation's delegated scope.
const child = spawn('systemd-run', [
  '--user', '--scope', '--collect', '--quiet', '--property=Delegate=yes', '--',
  process.execPath, fileURLToPath(new URL('./test-integration.mjs', import.meta.url)), ...process.argv.slice(2),
], { stdio: 'inherit' })

try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
} catch (error) {
  console.error(`Delegated integration runner failed: ${error.message}`)
  process.exitCode = 1
}
