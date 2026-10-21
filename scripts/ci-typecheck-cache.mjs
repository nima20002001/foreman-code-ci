import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const cache = process.env.FOREMAN_CODE_CI_TYPECHECK_CACHE
const [divider, command, ...args] = process.argv.slice(2)
if (!cache || divider !== '--' || !command) {
  throw new Error('Usage: FOREMAN_CODE_CI_TYPECHECK_CACHE=directory ci-typecheck-cache.mjs -- command [args...]')
}

const projects = ['apps/api', 'apps/web', 'packages/contracts']

function copyState(from, to) {
  if (!existsSync(from)) return
  mkdirSync(dirname(to), { recursive: true })
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
}

// Only no-emit compiler state is retained. Emitting builds need their outputs and build info kept together.
for (const project of projects) {
  copyState(join(cache, project), resolve(project, 'node_modules/.cache/tsc'))
}

const result = spawnSync(command, args, { stdio: 'inherit',
  env: { ...process.env, FOREMAN_CODE_CI_TYPECHECK_CACHE_ACTIVE: '1' },
})

// TypeScript also stores diagnostics for failed checks and validates them against the next run's inputs.
for (const project of projects) {
  copyState(resolve(project, 'node_modules/.cache/tsc'), join(cache, project))
}

if (result.error) throw result.error
process.exitCode = result.status ?? 1
