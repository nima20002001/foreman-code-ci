/* global require, process, setImmediate */
const { spawn } = require('node:child_process')
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { createInterface } = require('node:readline')

const binary = process.env.NATIVE_CONFIG_BINARY
const events = process.env.NATIVE_CONFIG_EVENTS
const faultFile = process.env.NATIVE_CONFIG_FAULT
if (!binary || !events || !faultFile) throw new Error('Native config fault proxy requires isolated fixture paths')
const args = process.argv.slice(2)
const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
const record = event => appendFileSync(events, JSON.stringify({ ...event, pid: child.pid }) + '\n')
record({ kind: 'start', operation: args[0] })
child.stderr.pipe(process.stderr)
child.on('error', error => { throw error })
child.stdin.on('error', error => {
  if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') throw error
})
// Remain alive long enough to observe the native exit when the owner stops the process group.
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('close', (code, signal) => {
  record({ kind: 'close', code, signal })
  process.exit(code ?? 1)
})

if (args[0] !== 'app-server' || args[1] === 'generate-json-schema') {
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
} else {
  let writeId
  let fault
  const crash = () => child.kill('SIGKILL')
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line)
    if (message.method === 'config/batchWrite') {
      writeId = message.id
      fault = JSON.parse(readFileSync(faultFile, 'utf8'))
      record({ kind: 'write-request', fault: fault.kind })
      if (fault.kind === 'external-before-write') writeFileSync(fault.file, fault.content)
      if (fault.kind === 'crash-before-write') {
        crash()
        return
      }
      child.stdin.write(line + '\n')
      if (fault.kind === 'crash-during-write') setImmediate(crash)
      return
    }
    child.stdin.write(line + '\n')
  })
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (writeId !== undefined && message.id === writeId) {
      record({ kind: 'write-response', succeeded: Object.hasOwn(message, 'result') })
      if (fault.kind === 'crash-after-write' || fault.kind === 'crash-during-write') {
        crash()
        return
      }
      if (fault.kind === 'external-after-write') writeFileSync(fault.file, fault.content)
    }
    process.stdout.write(line + '\n')
  })
}
