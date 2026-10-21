import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { readProductEnvironment } from '../../../packages/contracts/src/productEnvironment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { workerPath } from '../src/harnessPath.mjs';
import { mockHostMounts, persistentHostMounts } from './fixtures/hostMounts.mjs';

const artifact = readProductEnvironment(process.env, 'WORKER_ARTIFACT_DIRECTORY');
const persistentHostPreload = new URL('./fixtures/persistentHost.mjs', import.meta.url).href;
test('packaged worker help and native initialization load current contracts without execution authority', { skip: !artifact }, async t => {
  const output = execFileSync(process.execPath, [join(artifact, 'src/cli.mjs'), '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.match(output, /^Foreman Code worker\n/);
  assert.match(output, /Pairing retries reuse the original enrollment file/);
  const state = await mkdtemp(join(persistentFixtureRoot, 'worker-native-initialization-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const initialized = JSON.parse(execFileSync(process.execPath,
    ['--import', persistentHostPreload, join(artifact, 'src/cli.mjs'), 'initialize-native-runtime', '--state', state],
    { encoding: 'utf8', timeout: 10000 }));
  assert.deepEqual(initialized, { nativeRuntime: 'initialized', executionAuthorized: false });
  const status = JSON.parse(execFileSync(process.execPath,
    [join(artifact, 'src/cli.mjs'), 'doctor', '--state', state], { encoding: 'utf8', timeout: 5000 }));
  assert.equal(status.pairing, 'unpaired');
  assert.equal(status.service.active, false);
});
test('packaged schema checker accepts the actual pinned Codex export', {
  skip: !artifact || !readProductEnvironment(process.env, 'WORKER_CODEX_BINARY'),
}, async (t) => {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'worker-schema-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = { PATH: workerPath(directory, process.execPath), HOME: directory, CODEX_HOME: join(directory, 'codex') };
  const exported = spawnSync(readProductEnvironment(process.env, 'WORKER_CODEX_BINARY'),
    ['app-server', 'generate-json-schema', '--experimental', '--out', join(directory, 'schemas')],
    { cwd: directory, env: environment, encoding: 'utf8', timeout: 10000 });
  assert.equal(exported.status, 0, exported.stderr);
  const schema = join(directory, 'schemas/codex_app_server_protocol.schemas.json');
  const result = spawnSync(process.execPath, [join(artifact, 'src/schemaWorker.mjs'), 'codex', schema],
    { cwd: directory, env: environment, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, schemaSha256: createHash('sha256').update(await readFile(schema)).digest('hex'),
  });
});
test('packaged rsync writer has separate source/output receipts and keeps diagnostics off protocol stdout', { skip: !artifact }, async () => {
  const manifest = JSON.parse(await readFile(join(artifact, 'manifest.json'), 'utf8'));
  const entrypoint = 'apps/api/src/modules/byte-transfer/rsyncWriterCli.ts';
  assert.ok(!manifest.workerApiModules.includes(entrypoint));
  assert.ok(manifest.rsyncWriterApiModules.includes(entrypoint));
  assert.ok(manifest.sourceSnapshot.files.some(file => file.path === entrypoint));
  const output = manifest.files.find(file => file.path === 'src/rsync-writer.mjs');
  assert.ok(output);
  assert.equal(createHash('sha256').update(await readFile(join(artifact, output.path))).digest('hex'), output.sha256);
  const invalid = spawnSync(process.execPath, [join(artifact, output.path), '--invalid'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr.trim(), 'Rsync writer failed: Invalid rsync writer invocation; original ownership retained');
});

test('built worker factory accepts supplied real registration and rejects placeholder servers', { skip: !artifact }, async () => {
  const { createWorkerConnection } = await import(pathToFileURL(join(artifact, 'src/worker.mjs')).href);
  const pairing = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://package-check.example/device/connect', credential: 'a'.repeat(64), mainPublicKeyFingerprint: 'b'.repeat(64) };
  const registration = { namespace: 'package-check-v1', version: 1, role: 'duplex', maxJsonBytes: 1024, maxBinaryBytes: 1024, handle: async (payload, context) => ({ payload, bytes: context.bytes }) };
  const connection = createWorkerConnection({ pairing, bootId: randomUUID(), appVersion: '0.1.0', extensions: [registration] });
  assert.equal(connection.status().phase, 'disconnected');
  assert.deepEqual(connection.capabilities(), []);
  await assert.rejects(connection.request(registration.namespace, { probe: true }), /unavailable/);
  await connection.stop();
  assert.throws(() => createWorkerConnection({ pairing, bootId: randomUUID(), appVersion: '0.1.0', extensions: [{ ...registration, handle: undefined }] }), /actual domain handler/);
});

test('packaged Worker entry loads installed domains and releases an unpaired installation', { skip: !artifact }, async t => {
  t.after(mockHostMounts(t.mock, persistentHostMounts));
  const { startConfiguredWorker } = await import(pathToFileURL(join(artifact, 'src/worker.mjs')).href);
  const state = await mkdtemp(join(persistentFixtureRoot, 'worker-unpaired-entry-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(startConfiguredWorker({ stateDirectory: state }), { code: 'ENOENT' });
    const status = JSON.parse(execFileSync(process.execPath,
      [join(artifact, 'src/cli.mjs'), 'doctor', '--state', state], { encoding: 'utf8', timeout: 5000 }));
    assert.equal(status.pairing, 'unpaired');
    assert.equal(status.service.active, false);
  }
});

test('packaged bytes match manifest and doctor import creates no worker authority', { skip: !artifact }, async (t) => {
  const manifest = JSON.parse(await readFile(join(artifact, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.some((file) => file.path === 'src/worker.mjs'));
  for (const file of manifest.files) assert.equal(createHash('sha256').update(await readFile(join(artifact, file.path))).digest('hex'), file.sha256);
  assert.equal((await statfs('/dev/shm')).type, 0x01021994);
  const state = await mkdtemp(join('/dev/shm', 'worker-artifact-probe-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const result = JSON.parse(execFileSync(process.execPath, [join(artifact, 'src/cli.mjs'), 'doctor', '--state', state], { encoding: 'utf8', timeout: 5000 }));
  assert.equal(result.versions.commit, manifest.commit);
  assert.equal(result.versions.lockfileSha256, manifest.lockfileSha256);
  assert.equal(result.service.active, false);
  assert.equal(result.pairing, 'unpaired');
  await assert.rejects(readFile(join(state, 'identity.json')), { code: 'ENOENT' });
  // This verified tmpfs state is intentionally unqualified.
  assert.equal(result.persistentState, false);
  const initialization = spawnSync(process.execPath,
    [join(artifact, 'src/cli.mjs'), 'initialize-native-runtime', '--state', state],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(initialization.status, 1);
  assert.equal(initialization.stderr.trim(), 'nonpersistent_storage');
  for (const name of ['workflow-operations.json', 'job-runtime-operations.json']) {
    await assert.rejects(readFile(join(state, name)), { code: 'ENOENT' });
  }
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(artifact, 'src/cli.mjs'), 'run', '--state', state], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 1);
  assert.equal(run.stderr.trim(), 'nonpersistent_storage');
  await assert.rejects(readFile(join(state, 'identity.json')), { code: 'ENOENT' });
});
