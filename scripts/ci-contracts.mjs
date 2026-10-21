import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)

export function contractsCacheKey(root) {
  const tree = spawnSync('git', ['rev-parse', 'HEAD:packages/contracts'], { cwd: root, encoding: 'utf8' })
  if (tree.status !== 0) throw new Error(tree.stderr || 'Cannot read contracts inputs')
  const hash = createHash('sha256').update(process.version).update(process.platform).update(process.arch).update(tree.stdout.trim())
  for (const name of ['pnpm-lock.yaml', 'tsconfig.base.json', 'tsconfig.json']) {
    if (existsSync(join(root, name))) hash.update(name).update(readFileSync(join(root, name)))
  }
  return hash.digest('hex')
}

export function contractsReady(root) {
  const output = join(root, 'packages/contracts/dist')
  const stamp = join(output, '.ci-cache-key')
  return existsSync(stamp) && existsSync(join(output, 'index.js'))
    && readFileSync(stamp, 'utf8') === contractsCacheKey(root)
}

function copy(source, destination) {
  mkdirSync(destination, { recursive: true })
  const result = spawnSync('cp', ['-a', '--reflink=auto', `${source}/.`, destination], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Cannot copy contracts build')
}

function build(root, cache, command) {
  const key = contractsCacheKey(root)
  const output = join(root, 'packages/contracts/dist')
  const stamp = join(output, '.ci-cache-key')
  if (contractsReady(root)) {
    console.log('[ci-cache] contracts build reused')
    return 0
  }
  const cached = join(cache, key)
  if (existsSync(join(cached, '.ci-cache-key'))) {
    rmSync(output, { recursive: true, force: true })
    copy(cached, output)
    console.log('[ci-cache] contracts build restored')
    return 0
  }
  rmSync(output, { recursive: true, force: true })
  const result = spawnSync(command[0], command.slice(1), { cwd: process.cwd(), stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) return result.status ?? 1
  if (!existsSync(join(output, 'index.js'))) throw new Error('Contracts compiler produced no entry point')
  writeFileSync(stamp, key)
  const temporary = join(cache, `${key}.${randomUUID()}`)
  try {
    copy(output, temporary)
    renameSync(temporary, cached)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  console.log('[ci-cache] contracts build saved')
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [action, root, cache, divider, ...command] = process.argv.slice(2)
  if (action === 'key' && root) console.log(contractsCacheKey(root))
  else if (action === 'ready' && root) process.exitCode = contractsReady(root) ? 0 : 1
  else if ((action === 'build' || action === 'locked-build') && root && cache && divider === '--' && command.length) {
    mkdirSync(cache, { recursive: true })
    if (action === 'locked-build') process.exitCode = build(root, cache, command)
    else {
      const result = spawnSync('flock', [join(cache, `${contractsCacheKey(root)}.lock`),
        process.execPath, script, 'locked-build', root, cache, '--', ...command], { stdio: 'inherit' })
      if (result.error) throw result.error
      process.exitCode = result.status ?? 1
    }
  } else throw new Error('Usage: ci-contracts.mjs key|ready root | build root cache -- compiler [args...]')
}
