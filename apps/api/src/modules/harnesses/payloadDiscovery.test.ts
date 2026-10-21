import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { inventoryDriverPayloads, passiveDriverPayloads } from './payloadDiscovery.js'

const require = createRequire(import.meta.url)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-launcher-payload-'))
  const launcher = join(root, 'package/bin/codex.js')
  const platformPackage = join(root, 'package/node_modules/@openai/codex-linux-x64')
  const payload = join(platformPackage, 'vendor/x86_64-unknown-linux-musl/bin/codex')
  await mkdir(join(root, 'package/bin'), { recursive: true })
  await mkdir(join(platformPackage, 'vendor/x86_64-unknown-linux-musl/bin'), { recursive: true })
  await writeFile(join(platformPackage, 'package.json'), JSON.stringify({ name: '@openai/codex-linux-x64',
    version: '0.154.0', exports: { './package.json': './package.json' } }))
  await writeFile(launcher, await readFile(require.resolve('@openai/codex/bin/codex.js')), { mode: 0o700 })
  await writeFile(payload, Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('inspection-only-fixture')]),
    { mode: 0o700 })
  return { root, launcher, payload }
}

it('resolves the pinned npm launcher payload from its selected standalone installation', async () => {
  const f = await fixture()
  try {
    const found = await passiveDriverPayloads('codex', f.launcher, 'linux', 'x64')
    expect(found).toEqual({ complete: true, paths: [f.payload] })
    await rm(f.payload)
    expect(await passiveDriverPayloads('codex', f.launcher, 'linux', 'x64'))
      .toEqual({ complete: false, paths: [] })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

it.each([passiveDriverPayloads, inventoryDriverPayloads])('rejects modified and arbitrary script launchers without treating their filenames as trust (%#)', async (discover) => {
  const f = await fixture()
  try {
    const original = await readFile(f.launcher)
    const modified = Buffer.from(original)
    modified[modified.length - 2] = modified[modified.length - 2]! ^ 1
    await writeFile(f.launcher, modified)
    expect(await discover('codex', f.launcher, 'linux', 'x64'))
      .toEqual({ complete: false, paths: [] })
    await writeFile(f.launcher, '#!/usr/bin/env node\nprocess.exit(0)\n')
    expect(await discover('codex', f.launcher, 'linux', 'x64'))
      .toEqual({ complete: false, paths: [] })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

it('keeps native image discovery independent of npm dependencies and rejects an unsupported target', async () => {
  const f = await fixture()
  try {
    expect(await passiveDriverPayloads('codex', f.payload, 'linux', 'x64'))
      .toEqual({ complete: true, paths: [] })
    expect(await passiveDriverPayloads('codex', f.launcher, 'linux', 'unknown'))
      .toEqual({ complete: false, paths: [] })
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
