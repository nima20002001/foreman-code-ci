import { execFileSync } from 'node:child_process'
import { createHmac, pbkdf2Sync } from 'node:crypto'
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, read, rmSync, writeSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createPool } from '../../apps/api/src/infrastructure/pool.ts'

function int32(value) {
  const bytes = Buffer.alloc(4)
  bytes.writeInt32BE(value)
  return bytes
}

function message(type, payload) {
  return Buffer.concat([Buffer.from(type), int32(payload.length + 4), payload])
}

function authenticate(socket) {
  let buffer = Buffer.alloc(0)
  let step = 0
  let first
  let challenge
  const auth = (code, text = '') => socket.write(message('R', Buffer.concat([int32(code), Buffer.from(text)])))
  socket.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes])
    while (buffer.length >= 5) {
      const offset = step === 0 ? 0 : 1
      const size = buffer.readInt32BE(offset) + offset
      if (buffer.length < size) return
      const payload = buffer.subarray(offset + 4, size)
      buffer = buffer.subarray(size)
      if (step === 0) auth(10, 'SCRAM-SHA-256\0\0')
      if (step === 1) {
        first = payload.subarray(payload.indexOf(0) + 5).toString().slice(3)
        const nonce = first.split(',').find(field => field.startsWith('r=')).slice(2)
        challenge = `r=${nonce}server,s=${Buffer.from('fixture-salt').toString('base64')},i=4096`
        auth(11, challenge)
      }
      if (step === 2) {
        const final = payload.toString().split(',p=')[0]
        const salted = pbkdf2Sync('fixture-password', 'fixture-salt', 4096, 32, 'sha256')
        const serverKey = createHmac('sha256', salted).update('Server Key').digest()
        const signature = createHmac('sha256', serverKey).update(`${first},${challenge},${final}`).digest('base64')
        auth(12, `v=${signature}`)
        auth(0)
        socket.write(message('Z', Buffer.from('I')))
      }
      if (step > 2) socket.end()
      step += 1
    }
  })
}

const cache = join(homedir(), '.cache', 'foreman-tmp')
mkdirSync(cache, { recursive: true })
const directory = mkdtempSync(join(cache, 'database-authentication-'))
const pipe = join(directory, 'filesystem-read')
execFileSync('mkfifo', [pipe])
const fd = openSync(pipe, constants.O_RDWR)
const sockets = new Set()
const server = createServer(socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  authenticate(socket)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const pool = createPool({
  connectionString: `postgresql://fixture:fixture-password@127.0.0.1:${server.address().port}/fixture`,
  maxConnections: 40,
  connectionTimeoutMs: 5000,
}, 'authentication-probe')
const blockedReads = Number(process.argv[2])
const reads = Array.from({ length: blockedReads }, () => new Promise((resolve, reject) => {
  read(fd, Buffer.alloc(1), 0, 1, null, error => error ? reject(error) : resolve())
}))
let released = false
const releaseReads = () => {
  if (released || !blockedReads) return
  released = true
  writeSync(fd, Buffer.alloc(blockedReads))
}
const timer = setTimeout(releaseReads, 1500)
try {
  const started = performance.now()
  const results = await Promise.allSettled(Array.from({ length: 17 }, () => pool.connect()))
  const elapsedMs = Math.round(performance.now() - started)
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason.message)
  for (const result of results) if (result.status === 'fulfilled') result.value.release()
  console.log(JSON.stringify({ threads: process.env.UV_THREADPOOL_SIZE ?? '4', blockedReads, elapsedMs,
    connected: results.length - errors.length, errors }))
} finally {
  clearTimeout(timer)
  releaseReads()
  await Promise.all(reads)
  await pool.end()
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
  closeSync(fd)
  rmSync(directory, { recursive: true, force: true })
}
