import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  regularFiles, verifyPackage, artifactFiles, copySharpPackages, copySharpPackagesFromStore,
  sharpPackages, assertWorkerDependency,
} from '../../../scripts/worker-artifact-files.mjs';
import { DatabaseSync } from 'node:sqlite';
import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { validateManifest } from '../src/installation.mjs';
import { committedWorkerInputPath, workerReleaseVersion, validateWorkerTarget } from '../../../scripts/worker-artifact-files.mjs';

const { Packr, Unpackr } = createRequire(import.meta.url)('msgpackr');
const packer = new Packr({ useRecords: true, moreTypes: true });
const unpacker = new Unpackr({ useRecords: true, moreTypes: true });

test('artifact versions follow product releases rather than a shared worker package version', () => {
  assert.equal(workerReleaseVersion({ version: '0.0.55' }), '0.0.55');
  assert.equal(workerReleaseVersion({ version: '0.0.54' }), '0.0.54');
  assert.throws(() => workerReleaseVersion({ version: 'unreleased' }), /release version/);
});

test('reviewed build inputs must identify repository artifact JSON rather than an external file', () => {
  const target = 'apps/worker/artifacts/test-hosts/ubuntu-24.04-x64-target.json';
  assert.equal(committedWorkerInputPath('/repo', target), target);
  assert.equal(committedWorkerInputPath('/repo', `/repo/${target}`), target);
  for (const input of ['/approved-target.json', '../target.json', 'apps/worker/src/target.json', 'apps/worker/artifacts/target.txt']) {
    assert.throws(() => committedWorkerInputPath('/repo', input), /committed repository file/);
  }
});

test('packaging accepts Ubuntu x64 and rejects unqualified arm64 targets', () => {
  const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' };
  validateWorkerTarget(target);
  assert.throws(() => validateWorkerTarget({ ...target, arch: 'arm64' }), /qualified only for linux-x64/);
  assert.throws(() => validateWorkerTarget({ ...target, node: 'v24.0.0' }), /Unsupported build target/);
});

function fixture() {
  const files = new Map([['package.json', Buffer.from('{"name":"sharp","version":"0.35.4"}')], ['LICENSE', Buffer.from('license')], ['lib/index.js', Buffer.from('module.exports = {}')]]);
  const index = { requiresBuild: false, manifest: { name: 'sharp', version: '0.35.4' }, algo: 'sha512', files: new Map([...files].map(([path, bytes]) => [path, { size: bytes.length, digest: createHash('sha512').update(bytes).digest('hex') }])) };
  return { files, index };
}

test('package verification rejects changed bytes, sizes, file sets, identities and build hooks', () => {
  const { files, index } = fixture();
  verifyPackage('sharp', '0.35.4', index, files);
  for (const invalid of [{ ...index, requiresBuild: true }, { ...index, manifest: { name: 'other', version: '0.35.4' } }, { ...index, algo: 'sha256' }]) assert.throws(() => verifyPackage('sharp', '0.35.4', invalid, files));
  for (const changed of [new Map([...files, ['extra', Buffer.from('x')]]), new Map([...files].filter(([path]) => path !== 'LICENSE')), new Map(files).set('LICENSE', Buffer.from('License'))]) assert.throws(() => verifyPackage('sharp', '0.35.4', index, changed));
  const withoutLicense = new Map([...files].filter(([path]) => path !== 'LICENSE'));
  assert.throws(() => verifyPackage('sharp', '0.35.4', { ...index, files: new Map([...index.files].filter(([path]) => path !== 'LICENSE')) }, withoutLicense), /license/);
  index.files.get('LICENSE').size++;
  assert.throws(() => verifyPackage('sharp', '0.35.4', index, files));
});

test('recursive inventory retains scoped assets and licenses, excludes nested dependencies and rejects symlinks', async t => {
  const directory = await mkdtemp('/tmp/worker-package-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'node_modules/@img/native/lib'), { recursive: true });
  await writeFile(join(directory, 'node_modules/@img/native/lib/binding.node'), 'native');
  const inventory = await artifactFiles(directory);
  assert.deepEqual(inventory.map(file => file.path), ['node_modules/@img/native/lib/binding.node']);
  await symlink('binding.node', join(directory, 'node_modules/@img/native/lib/alias'));
  await assert.rejects(artifactFiles(directory), /Nonregular/);
  assert.equal((await regularFiles(directory, { excludeNodeModules: true })).size, 0);
});

test('installer accepts scoped native paths while rejecting traversal and duplicate paths', () => {
  const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3', rootPersistent: true, homePersistent: true };
  const manifest = { format: 1, version: '0.1.0', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64), protocolVersion: 1, identityFormat: 1, packageManager: 'pnpm@11.27.0', target: facts,
    files: ['src/cli.mjs', 'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node'].map(path => ({ path, sha256: 'c'.repeat(64), size: 1 })) };
  const expected = { protocolVersion: 1, identityFormat: 1 };
  validateManifest(manifest, facts, expected);
  for (const path of ['node_modules/@img/../secret', '/secret', 'node_modules//secret', 'src/cli.mjs']) assert.throws(() => validateManifest({ ...manifest, files: [...manifest.files, { path, sha256: 'c'.repeat(64), size: 1 }] }, facts, expected));
});


async function nativePackageFixture(t) {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'worker-native-copy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'root');
  const lock = { packages: {} };
  const records = new Map();
  const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  for (const [name, version] of Object.entries(sharpPackages)) {
    const source = join(root, 'node_modules/.pnpm', `${name.replace('/', '+')}@${version}`, 'node_modules', name);
    await mkdir(source, { recursive: true });
    const files = new Map([
      ['package.json', Buffer.from(JSON.stringify({ name, version }))],
      ['LICENSE', Buffer.from('license')],
    ]);
    for (const [path, bytes] of files) await writeFile(join(source, path), bytes);
    lock.packages[`${name}@${version}`] = { resolution: { integrity } };
    records.set(`${integrity}\t${name}@${version}`, {
      requiresBuild: false,
      manifest: { name, version },
      algo: 'sha512',
      files: new Map([...files].map(([path, bytes]) => [path, {
        size: bytes.length,
        digest: createHash('sha512').update(bytes).digest('hex'),
      }])),
    });
  }
  return { directory, root, lock, records, integrity };
}

test('locked native packages use exact TAB keys and copy deterministic verified buffers as siblings', async t => {
  const { directory, root, lock, records, integrity } = await nativePackageFixture(t);
  const first = join(directory, 'first'), second = join(directory, 'second');
  const requested = [];
  const blobs = new Map([...records].map(([key, index]) => [key, packer.pack(index)]));
  const record = key => { requested.push(key); return blobs.get(key); };
  const decode = blob => unpacker.unpack(blob);
  const result = await copySharpPackages({ root, output: first, lock, record, decode });
  assert.deepEqual(result, await copySharpPackages({ root, output: second, lock, record, decode }));
  assert.equal(result.length, 6);
  assert.deepEqual(new Set(requested), new Set(records.keys()));
  for (const entry of result) assert.equal(entry.indexBlobSha256, createHash('sha256').update(blobs.get(`${entry.integrity}\t${entry.name}@${entry.version}`)).digest('hex'));
  assert.deepEqual(await artifactFiles(first), await artifactFiles(second));
  const changed = records.values().next().value;
  changed.files.get('LICENSE').digest = '0'.repeat(128);
  blobs.set(`${integrity}\tsharp@${sharpPackages.sharp}`, packer.pack(changed));
  await assert.rejects(copySharpPackages({ root, output: join(directory, 'bad'), lock, record, decode }), /integrity/);
  await assert.rejects(copySharpPackages({ root, output: join(directory, 'missing'), lock, record: () => undefined, decode }), /index/);
  await assert.rejects(copySharpPackages({ root, output: join(directory, 'malformed'), lock, record: () => Buffer.from([0xc1]), decode }));
});

test('restored installed packages require their cached pnpm index and retain integrity verification', async t => {
  const { directory, root, lock, records } = await nativePackageFixture(t);
  const store = join(root, 'node_modules/.pnpm-store/v11');
  const decode = blob => unpacker.unpack(blob);
  const blobs = new Map([...records].map(([key, index]) => [key, packer.pack(index)]));
  await assert.rejects(copySharpPackagesFromStore({ root, output: join(directory, 'missing'), store, lock, decode }),
    /Restore the pnpm store together with node_modules/);
  await mkdir(store, { recursive: true });
  const database = new DatabaseSync(join(store, 'index.db'));
  try {
    database.exec('CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID');
    const insert = database.prepare('INSERT INTO package_index (key, data) VALUES (?, ?)');
    for (const [key, blob] of blobs) insert.run(key, blob);
  } finally {
    database.close();
  }
  const restoredRoot = join(directory, 'restored');
  await cp(join(root, 'node_modules'), join(restoredRoot, 'node_modules'), { recursive: true });
  await rm(root, { recursive: true });
  const restoredStore = join(restoredRoot, 'node_modules/.pnpm-store/v11');
  const output = join(directory, 'release');
  const packages = await copySharpPackagesFromStore({ root: restoredRoot, output, store: restoredStore, lock, decode });
  assert.equal(packages.length, Object.keys(sharpPackages).length);
  for (const entry of packages) {
    const blob = blobs.get(`${entry.integrity}\t${entry.name}@${entry.version}`);
    assert.equal(entry.indexBlobSha256, createHash('sha256').update(blob).digest('hex'));
  }
  await writeFile(join(restoredRoot, 'node_modules/.pnpm', `sharp@${sharpPackages.sharp}`, 'node_modules/sharp/LICENSE'),
    'changed');
  await assert.rejects(copySharpPackagesFromStore({ root: restoredRoot, output: join(directory, 'changed'),
    store: restoredStore, lock, decode }), /integrity/);
});


test('libvips preserves its published README license table instead of requiring an absent LICENSE file', () => {
  const name = '@img/sharp-libvips-linux-x64', version = '1.3.3';
  const files = new Map([['package.json', Buffer.from(JSON.stringify({ name, version, license: 'LGPL-3.0-or-later' }))], ['README.md', Buffer.from('Dependency licenses: libvips LGPLv3')]]);
  const index = { requiresBuild: false, manifest: { name, version }, algo: 'sha512', files: new Map([...files].map(([path, bytes]) => [path, { size: bytes.length, digest: createHash('sha512').update(bytes).digest('hex') }])) };
  verifyPackage(name, version, index, files);
});


test('worker graph rejects database and control-plane server dependencies without disabling its guard', () => {
  for (const path of ['pg', 'pg/lib/client', 'pg-pool', 'postgres', 'fastify', '@fastify/websocket', 'drizzle-orm/node-postgres', 'kysely']) assert.throws(() => assertWorkerDependency(path), /Forbidden/);
  for (const path of ['node:fs', 'sharp', 'ws', '@foreman-code/contracts/jobs']) assertWorkerDependency(path);
});
