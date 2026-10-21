/* global process, setInterval, clearInterval */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const stateDirectory = process.argv[2]
const releaseDirectory = process.argv[3]
const worker = await import(pathToFileURL(join(releaseDirectory, 'src', 'worker.mjs')).href)
if (process.argv[4] === 'initialize') {
  await worker.initializeInstalledNativeRuntime(stateDirectory)
  process.exit(0)
}
const { readWorkerStatus } = await import(pathToFileURL(join(releaseDirectory, 'src', 'runtime.mjs')).href)
const timer = setInterval(() => {
  void readWorkerStatus(stateDirectory).then(view => process.send?.({ kind: 'status', view }))
}, 25)
const runtime = await worker.startConfiguredWorker({ stateDirectory })
let closing = false
async function close() {
  if (closing) return
  closing = true
  clearInterval(timer)
  try {
    await runtime.stop()
    process.exit(0)
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exit(1)
  }
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
