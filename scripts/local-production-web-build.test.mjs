import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildProductionSource, withProductionSourceSnapshot } from './local-production-runtime.mjs'

const execute = promisify(execFile)

test('production snapshots reuse unchanged web output and rebuild changed or missing output', async t => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'production-web-cache-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const repository = join(directory, 'repository')
  await mkdir(join(repository, 'scripts'), { recursive: true })
  for (const name of ['heavy-job.mjs', 'heavy-job-slots.mjs', 'sleep.mjs']) {
    await copyFile(new URL(name, import.meta.url), join(repository, 'scripts', name))
  }
  await mkdir(join(repository, 'packages/contracts/src'), { recursive: true })
  await copyFile(new URL('../packages/contracts/src/productEnvironment.mjs', import.meta.url),
    join(repository, 'packages/contracts/src/productEnvironment.mjs'))
  await mkdir(join(repository, 'apps/web/src'), { recursive: true })
  await writeFile(join(repository, 'apps/web/src/app.js'), 'browser input')
  await writeFile(join(repository, 'package.json'), '{"type":"module"}')
  await writeFile(join(repository, '.gitignore'), 'node_modules/\ndist/\n.logs/\n')
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('GIT_') && !/^(?:GRAPHQL|FOREMAN_CODE)_HEAVY_/.test(key)))
  Object.assign(environment, { FOREMAN_CODE_HEAVY_BASE_TMPDIR: parent, FOREMAN_CODE_VERIFICATION_ROOT: '',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
  delete environment.CI_HOST_RUNNER
  const git = args => execute('git', args, { cwd: repository, env: environment })
  await git(['init', '-q'])
  await git(['remote', 'add', 'origin', repository])
  const commit = async () => {
    await git(['add', '.'])
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'])
  }
  await commit()
  const bin = join(directory, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'corepack'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.mkdirSync('apps/web/dist', { recursive: true });
fs.writeFileSync('apps/web/dist/index.html', 'bundle');
fs.appendFileSync(${JSON.stringify(join(directory, 'builds'))}, 'built\\n');
`)
  await chmod(join(bin, 'corepack'), 0o755)
  environment.PATH = `${bin}:${environment.PATH}`
  const builds = async () => (await readFile(join(directory, 'builds'), 'utf8')).trim().split('\n').length
  const build = () => withProductionSourceSnapshot(repository, join(directory, 'build'), async ({ source }) => {
    for (const tool of ['typescript', 'vite', '@vitejs/plugin-react', '@tailwindcss/vite']) {
      const module = join(source, 'apps/web/node_modules', tool)
      await mkdir(module, { recursive: true })
      await writeFile(join(module, 'index.js'), 'module.exports = {}')
    }
    await buildProductionSource(async (command, args) => {
      if (args.includes('vite') || args.includes('--build')) {
        await execute(command, args, { cwd: source, env: environment, timeout: 15000 })
      }
    })
  })
  await build()
  assert.equal(await builds(), 1)
  await build()
  assert.equal(await builds(), 1, 'An unchanged snapshot must retain and reuse the browser bundle')
  await writeFile(join(repository, 'apps/web/src/app.js'), 'changed browser input')
  await commit()
  await build()
  assert.equal(await builds(), 2, 'Changed browser inputs must rebuild')
  await rm(join(directory, 'build/source/apps/web/dist/index.html'))
  await build()
  assert.equal(await builds(), 3, 'Missing output must rebuild')
})
