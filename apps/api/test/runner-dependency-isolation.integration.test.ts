import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { pnpmInstall } from '../src/modules/ci-host/warmSetup.js'

it('keeps real pnpm store and another checkout intact after a suite overwrites its dependency', async () => {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'dependency-isolation-'))
  try {
    const environment = { ...process.env }
    // The fixture's workspace chooses the import method; developer install overrides must not replace it.
    delete environment.npm_config_package_import_method
    delete environment.pnpm_config_package_import_method
    const first = join(root, 'first')
    const second = join(root, 'second')
    const dependency = join(root, 'package')
    const cache = join(root, 'cache')
    await mkdir(first)
    await mkdir(dependency)
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'dependency', version: '1.0.0' }))
    await writeFile(join(dependency, 'index.js'), 'pristine')
    execFileSync('tar', ['-czf', join(first, 'dependency.tgz'), '-C', root, 'package'])
    await writeFile(join(first, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.27.0',
      dependencies: { dependency: 'file:./dependency.tgz' } }))
    await writeFile(join(first, 'pnpm-workspace.yaml'), 'packageImportMethod: clone-or-copy\n')
    execFileSync('corepack', ['pnpm', 'install', '--lockfile-only', '--offline', '--ignore-scripts'], { cwd: first, env: environment })
    await cp(first, second, { recursive: true })
    const install = async (cwd: string) => {
      const script = ['finish() { exit "$1"; }', ...await pnpmInstall(cwd, cache, join(root, 'message.json'))].join('\n')
      return new Promise<void>((resolve, reject) => {
        const child = spawn('bash', ['-c', script], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
        let output = ''
        child.stdout.on('data', data => { output += data })
        child.stderr.on('data', data => { output += data })
        child.once('error', reject)
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(output)))
      })
    }
    await install(first)
    await install(second)
    const store = join(cache, 'pnpm-store')
    const digest = createHash('sha512').update('pristine').digest('hex')
    const files = await readdir(store, { recursive: true })
    const storedFile = files.find(file => file.endsWith(digest.slice(2)))
    if (!storedFile) throw new Error('Dependency content is missing from the pnpm store')
    await writeFile(join(first, 'node_modules/dependency/index.js'), 'modified by suite')
    expect(await readFile(join(first, 'node_modules/dependency/index.js'), 'utf8')).toBe('modified by suite')
    expect(await readFile(join(store, storedFile), 'utf8')).toBe('pristine')
    expect(await readFile(join(second, 'node_modules/dependency/index.js'), 'utf8')).toBe('pristine')
    await rm(join(first, 'node_modules'), { recursive: true })
    await install(first)
    expect(await readFile(join(first, 'node_modules/dependency/index.js'), 'utf8')).toBe('pristine')
  } finally { await rm(root, { recursive: true, force: true }) }
})
