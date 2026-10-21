import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { expect, it } from 'vitest'
import { checkCodexSchema, parseExport } from '../src/modules/harnesses/compatibility/schema.js'
import { passiveDriverPayloads } from '../src/modules/harnesses/payloadDiscovery.js'
import { copyProviderSchemas } from './helpers/remoteReviewProvider.js'

const require = createRequire(import.meta.url)
const execute = promisify(execFile)

it('provisions locked provider schemas when the installed launcher has no native package', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'provider-schema-export-'))
  try {
    const installed = require.resolve('@openai/codex/bin/codex.js')
    const launcher = join(directory, 'incomplete-package/bin/codex.js')
    await mkdir(dirname(launcher), { recursive: true })
    await copyFile(installed, launcher)
    await copyFile(join(dirname(installed), '../package.json'), join(dirname(launcher), '../package.json'))
    expect(await passiveDriverPayloads('codex', launcher)).toEqual({ complete: false, paths: [] })

    const schemas = join(directory, 'schemas')
    await copyProviderSchemas(schemas, launcher)

    for (const variant of ['stable', 'experimental']) {
      const document = parseExport(await readFile(join(schemas, variant, 'codex_app_server_protocol.schemas.json'), 'utf8'))
      expect(document.definitions).toBeDefined()
      if (variant === 'experimental') expect(() => checkCodexSchema(document)).not.toThrow()
    }
    await expect(access(join(directory, 'incomplete-package/node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 240_000)

it('exports schemas on a cold cache using only the prefetched store and verification install arguments', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'offline-provider-export-'))
  try {
    const { stdout } = await execute('/bin/sh', ['-c', 'command -v corepack'])
    const corepack = stdout.trim()
    const modules = parse(await readFile(new URL('../../../node_modules/.modules.yaml', import.meta.url), 'utf8')) as {
      storeDir: string
    }
    const store = process.env.PNPM_CONFIG_STORE_DIR ?? process.env.npm_config_store_dir ?? dirname(modules.storeDir)
    const bin = join(directory, 'bin')
    await mkdir(bin)
    const policy = new URL('../../worker/artifacts/ci-runtime/verification-policy.mjs', import.meta.url).href
    await writeFile(join(bin, 'corepack'), `#!${process.execPath}
import { execFileSync } from 'node:child_process'
import { verificationInstallArguments } from ${JSON.stringify(policy)}
const [command, ...args] = process.argv.slice(2)
if (command !== 'pnpm' || !args.includes('--offline')) throw new Error('Exporter installation must be offline.')
const allowed = verificationInstallArguments(args)
execFileSync(${JSON.stringify(corepack)}, [command, ...allowed], { stdio: 'inherit', env: process.env })
`, { mode: 0o700 })
    const runner = join(directory, 'export.mjs')
    const helper = new URL('./helpers/remoteReviewProvider.ts', import.meta.url).href
    await writeFile(runner, `import { copyProviderSchemas } from ${JSON.stringify(helper)}\n`
      + 'await copyProviderSchemas(process.argv[2])\n')
    const schemas = join(directory, 'schemas')
    await execute(process.execPath, ['--import', require.resolve('tsx'), runner, schemas], {
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, PNPM_CONFIG_STORE_DIR: store,
        FOREMAN_CODE_TEST_CACHE_ROOT: join(directory, 'cache') },
    })
    const document = parseExport(await readFile(join(schemas, 'experimental/codex_app_server_protocol.schemas.json'), 'utf8'))
    expect(() => checkCodexSchema(document)).not.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 240_000)
