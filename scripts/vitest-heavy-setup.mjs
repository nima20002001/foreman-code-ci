import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const commonResult = spawnSync('git', ['rev-parse', '--path-format=absolute',
  process.env.CI_HOST_RUNNER === '1' ? '--git-dir' : '--git-common-dir'], { cwd: root, encoding: 'utf8' })
if (commonResult.status !== 0) throw new Error(commonResult.stderr || 'Cannot find Git common directory')
const common = commonResult.stdout.trim()
const activePath = join(common, 'graphql-heavy-jobs', 'active', 'owner.json')
const running = join(common, 'graphql-heavy-jobs', 'running')
const readOwner = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const owner = (matches) => [readOwner(activePath), ...(existsSync(running) ? readdirSync(running).map((name) => readOwner(join(running, name))) : [])].find((record) => record && matches(record))

function liveOwner(record) {
  if (!Number.isSafeInteger(record?.pid) || record.pid < 1) return false
  try {
    const text = readFileSync(`/proc/${record.pid}/stat`, 'utf8')
    const fields = text.slice(text.lastIndexOf(') ') + 2).split(' ')
    return fields[0] !== 'Z' && fields[19] === record.start
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false
    throw error
  }
}

export default async function setup() {
  const inherited = owner((record) => record.token && record.token === readProductEnvironment(process.env, 'HEAVY_JOB_TOKEN') && liveOwner(record))
  if (inherited?.token && readProductEnvironment(process.env, 'HEAVY_JOB_COMMON') === common && readProductEnvironment(process.env, 'HEAVY_JOB_TOKEN') === inherited.token) return
  const child = spawn(process.execPath, [join(root, 'scripts/heavy-job.mjs'), '--', process.execPath, join(root, 'scripts/heavy-job.mjs'), '__hold'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise((resolveReady, reject) => {
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      for (;;) {
        const end = output.indexOf('\n')
        if (end < 0) break
        const line = output.slice(0, end)
        output = output.slice(end + 1)
        if (line.startsWith('[heavy-job] ')) process.stdout.write(`${line.slice(0, 300)}\n`)
        if (line.startsWith('[heavy-job] running ')) resolveReady()
      }
      if (output.length > 4096) output = output.slice(-4096)
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`Heavy-job holder exited before admission (${code})`)))
  })
  const admitted = owner((record) => record.pid === child.pid)
  if (!admitted?.token || !admitted.tempPath) {
    child.stdin.end()
    throw new Error('Heavy-job holder did not publish its owned slot')
  }
  const previous = Object.fromEntries(['FOREMAN_CODE_HEAVY_JOB_COMMON', 'FOREMAN_CODE_HEAVY_JOB_TOKEN', 'FOREMAN_CODE_HEAVY_BASE_TMPDIR', 'GRAPHQL_HEAVY_JOB_COMMON', 'GRAPHQL_HEAVY_JOB_TOKEN', 'GRAPHQL_HEAVY_BASE_TMPDIR', 'TMPDIR', 'TMP', 'TEMP'].map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    FOREMAN_CODE_HEAVY_JOB_COMMON: common,
    FOREMAN_CODE_HEAVY_JOB_TOKEN: admitted.token,
    FOREMAN_CODE_HEAVY_BASE_TMPDIR: dirname(dirname(admitted.tempPath)),
    GRAPHQL_HEAVY_JOB_COMMON: common,
    GRAPHQL_HEAVY_JOB_TOKEN: admitted.token,
    GRAPHQL_HEAVY_BASE_TMPDIR: dirname(dirname(admitted.tempPath)),
    TMPDIR: admitted.tempPath,
    TMP: admitted.tempPath,
    TEMP: admitted.tempPath,
  })
  return async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const exited = child.exitCode !== null || child.signalCode !== null
    const exit = exited ? Promise.resolve() : new Promise((resolveExit) => child.once('exit', resolveExit))
    child.stdin.end()
    await exit
  }
}
