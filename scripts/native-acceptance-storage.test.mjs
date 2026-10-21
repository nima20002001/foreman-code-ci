import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { withNativeAcceptanceStorage } from './native-acceptance-storage.mjs'
import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'

async function fixture(execute) {
  const root = await mkdtemp(join(tmpdir(), 'foreman-code-storage-test-'))
  const codex = join(root, 'source-codex')
  await mkdir(codex, { recursive: true })
  const source = { HOME: root, TMPDIR: root, CODEX_HOME: codex,
    XDG_DATA_HOME: join(root, 'source-data'), XDG_CACHE_HOME: join(root, 'source-cache') }
  try {
    await writeFile(join(codex, 'auth.json'), 'codex-fixture-credential')
    await writeFile(join(codex, 'config.toml'), 'model = "fixture-model"')
    await writeFile(join(codex, 'models_cache.json'), '{"models":[]}')
    await writeFile(join(codex, 'history.jsonl'), 'original-history')
    await execute(source)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('native subprocesses keep configuration and credentials but write disposable histories', async () => {
  await fixture(async source => {
    let owned
    const result = await withNativeAcceptanceStorage(source, async environment => {
      owned = environment
      assert.equal(environment.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY,
        join(source.HOME, '.local', 'share', 'graphql', 'mcp'))
      assert.equal(await readFile(join(environment.CODEX_HOME, 'auth.json'), 'utf8'), 'codex-fixture-credential')
      assert.equal(await readFile(join(environment.CODEX_HOME, 'config.toml'), 'utf8'), 'model = "fixture-model"')
      assert.equal((await stat(join(environment.CODEX_HOME, 'auth.json'))).mode & 0o777, 0o600)
      await assert.rejects(access(join(environment.CODEX_HOME, 'history.jsonl')), { code: 'ENOENT' })
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        writeFileSync(join(process.env.CODEX_HOME, 'history.jsonl'), 'new-history');
        writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), 'refreshed');
        writeFileSync(join(process.env.TMPDIR, 'scratch'), 'scratch');
      `], { env: environment, encoding: 'utf8' })
      assert.equal(child.status, 0, child.stderr)
      return 'completed'
    })
    assert.equal(result, 'completed')
    for (const name of ['CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) {
      await assert.rejects(access(owned[name]), { code: 'ENOENT' })
    }
    assert.equal(await readFile(join(source.CODEX_HOME, 'history.jsonl'), 'utf8'), 'original-history')
    assert.equal(await readFile(join(source.CODEX_HOME, 'auth.json'), 'utf8'), 'codex-fixture-credential')
  })
})

for (const name of ['FOREMAN_CODE_APP_MCP_DIRECTORY', 'GRAPHQL_APP_MCP_DIRECTORY']) {
  test(`preserves ${name} provenance while native route writes use owned storage`, async () => {
    await fixture(async source => {
      const original = join(source.HOME, 'source-mcp')
      source[name] = original
      let owned
      await withNativeAcceptanceStorage(source, async environment => {
        owned = environment.FOREMAN_CODE_NATIVE_TEST_ROOT
        assert.equal(environment.FOREMAN_CODE_NATIVE_SOURCE_APP_MCP_DIRECTORY, original)
        assert.equal(readProductEnvironment(environment, 'APP_MCP_DIRECTORY'), join(owned, 'app-mcp'))
        assert.equal(environment.GRAPHQL_APP_MCP_DIRECTORY, undefined)
        assert.equal(source[name], original)
      })
      await assert.rejects(access(owned), { code: 'ENOENT' })
      await assert.rejects(access(original), { code: 'ENOENT' })
    })
  })
}

test('failed native operations remove their storage and preserve the original failure', async () => {
  await fixture(async source => {
    const failure = new Error('native-operation-failed')
    let owned
    await assert.rejects(withNativeAcceptanceStorage(source, async environment => {
      owned = environment.CODEX_HOME
      await writeFile(join(owned, 'history.jsonl'), 'failed-history')
      throw failure
    }), error => error === failure)
    await assert.rejects(access(owned), { code: 'ENOENT' })
    assert.equal(await readFile(join(source.CODEX_HOME, 'history.jsonl'), 'utf8'), 'original-history')
  })
})

test('linked plugin caches keep aliases inside owned storage and preserve missing versions', async () => {
  await fixture(async source => {
    const plugins = join(source.HOME, 'source-plugins')
    const cache = join(plugins, 'cache', 'fixture')
    await mkdir(join(cache, 'available'), { recursive: true })
    await symlink(plugins, join(source.CODEX_HOME, 'plugins'))
    await writeFile(join(cache, 'available', 'plugin.json'), 'original-plugin')
    await symlink('removed', join(cache, 'latest'))
    await symlink(join(cache, 'available'), join(cache, 'selected'))
    let owned
    await withNativeAcceptanceStorage(source, async environment => {
      owned = join(environment.CODEX_HOME, 'plugins', 'cache', 'fixture')
      await assert.rejects(access(join(owned, 'latest')), { code: 'ENOENT' })
      assert.equal(await readlink(join(owned, 'latest')), 'removed')
      assert.equal(await readFile(join(owned, 'selected', 'plugin.json'), 'utf8'), 'original-plugin')
      await writeFile(join(owned, 'selected', 'plugin.json'), 'fixture-plugin-write')
      assert.equal(await readFile(join(cache, 'available', 'plugin.json'), 'utf8'), 'original-plugin')
    })
    await assert.rejects(access(owned), { code: 'ENOENT' })
    assert.equal(await readlink(join(cache, 'latest')), 'removed')
  })
})

test('external plugin assets are copied without sharing their writable target', async () => {
  await fixture(async source => {
    const cache = join(source.CODEX_HOME, 'plugins', 'cache')
    const original = join(source.HOME, 'external-plugin')
    await mkdir(cache, { recursive: true })
    await mkdir(original)
    await writeFile(join(original, 'plugin.json'), 'external-original')
    await symlink(original, join(cache, 'external'))
    await withNativeAcceptanceStorage(source, async environment => {
      const asset = join(environment.CODEX_HOME, 'plugins', 'cache', 'external', 'plugin.json')
      assert.equal(await readFile(asset, 'utf8'), 'external-original')
      await writeFile(asset, 'fixture-external-write')
      assert.equal(await readFile(join(original, 'plugin.json'), 'utf8'), 'external-original')
    })
  })
})

test('failed configuration copies remove partial storage without running the native operation', async () => {
  await fixture(async source => {
    await symlink(join(source.HOME, 'missing-plugin'), join(source.CODEX_HOME, 'skills'))
    let executed = false
    await assert.rejects(withNativeAcceptanceStorage(source, async () => { executed = true }), { code: 'ENOENT' })
    assert.equal(executed, false)
    assert.deepEqual((await readdir(source.TMPDIR)).filter(name => name.startsWith('foreman-code-native-')), [])
    assert.equal(await readFile(join(source.CODEX_HOME, 'auth.json'), 'utf8'), 'codex-fixture-credential')
  })
})
