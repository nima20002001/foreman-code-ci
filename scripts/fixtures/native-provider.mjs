import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function nativeProviderFixture(root) {
  const targets = {
    'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
    'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  }
  const target = `${process.platform}-${process.arch}`
  const name = `@openai/codex-${target}`
  const version = '0.154.0'
  const provider = join(root, 'apps/api/node_modules/@openai/codex')
  const native = join(provider, 'node_modules', name)
  const payload = join(native, 'vendor', targets[target], 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
  mkdirSync(dirname(payload), { recursive: true })
  mkdirSync(join(provider, 'bin'), { recursive: true })
  writeFileSync(join(root, 'apps/api/package.json'), JSON.stringify({ dependencies: { '@openai/codex': version } }))
  writeFileSync(join(provider, 'package.json'), JSON.stringify({ name: '@openai/codex', version,
    optionalDependencies: { [name]: `npm:@openai/codex@${version}-${target}` } }))
  writeFileSync(join(provider, 'bin/codex.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  writeFileSync(join(native, 'package.json'), JSON.stringify({ name: '@openai/codex', version: `${version}-${target}` }))
  writeFileSync(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
packages:
  '@openai/codex@${version}-${target}':
    resolution: {integrity: sha512-fixture}
snapshots:
  '@openai/codex@${version}':
    optionalDependencies:
      '${name}': '@openai/codex@${version}-${target}'
  '@openai/codex@${version}-${target}':
    optional: true
`)
  symlinkSync(process.execPath, payload)
  return { payload, name }
}
