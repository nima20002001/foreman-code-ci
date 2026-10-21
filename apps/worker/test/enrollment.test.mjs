import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm, chmod, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, generateKeyPairSync, randomUUID, sign, verify, X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { tsImport } = await import(require.resolve('tsx/esm/api'));
const { enrollWorker, enrollWorkerCode, boundedPost, pairingErrorMessage } = await tsImport('../src/enrollment.mjs', import.meta.url);
const { encodeWorkerEnrollmentCode } = await tsImport('../../../packages/contracts/src/deviceSetup.ts', import.meta.url);
const { loadOrCreateWorkerIdentity, publicKeyFingerprint, mainEnrollmentProofMessage, mainIdentityProofMessage, pairingProof } = await tsImport('../../../packages/contracts/src/deviceIdentityNode.ts', import.meta.url);
const { ensurePairedManagedSetup } = await tsImport('../src/managedSetup.mjs', import.meta.url);
const { loadApprovedRoots } = await tsImport('../src/approvedRoots.mjs', import.meta.url);
const { openPrivateRoot } = await tsImport('../../api/src/modules/sources/privateFilesystem.ts', import.meta.url);

async function fixture(t, { symlinkedParent = false } = {}) {
  // Enrollment qualifies ancestors too; shared job scratch may have other owners or writers.
  const directory = await realpath(await mkdtemp(join(homedir(), '.worker-enroll-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let stateDirectory = directory;
  if (symlinkedParent) {
    await mkdir(join(directory, 'storage/state'), { recursive: true, mode: 0o700 });
    await symlink(join(directory, 'storage'), join(directory, 'cache'));
    stateDirectory = join(directory, 'cache/state');
  }
  const identity = await loadOrCreateWorkerIdentity(stateDirectory);
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const input = { mainId: randomUUID(), mainPublicKeyFingerprint: publicKeyFingerprint(publicKey), endpoint: 'wss://main.example/device/connect', grant: 'a'.repeat(43), requestId: randomUUID() };
  const enrollmentFile = join(stateDirectory, 'enrollment.json');
  await writeFile(enrollmentFile, JSON.stringify(input), { mode: 0o600 });
  return { stateDirectory, home: directory, identity, enrollmentFile, appVersion: '0.1.0', input, key, publicKey };
}

test('rejected unsafe setup releases its Worker lock and lets the process exit', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(openPrivateRoot(`${f.stateDirectory}/.`), { code: 'SOURCE_FILESYSTEM_UNSUPPORTED' });
  const unsafe = join(f.home, 'unsafe');
  const state = join(unsafe, 'state');
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(unsafe, 0o777);
  const apiPackage = new URL('../../api/package.json', import.meta.url).href;
  const setupModule = new URL('../src/managedSetup.mjs', import.meta.url).href;
  const runtimeModule = new URL('../src/runtime.mjs', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { acquireWorkerLock, readWorkerStatus } from ${JSON.stringify(runtimeModule)};
    const require = createRequire(${JSON.stringify(apiPackage)});
    const { tsImport } = await import(require.resolve('tsx/esm/api'));
    const { ensurePairedManagedSetup } = await tsImport(${JSON.stringify(setupModule)}, import.meta.url);
    const stateDirectory = ${JSON.stringify(state)};
    await assert.rejects(ensurePairedManagedSetup({ stateDirectory }),
      { code: 'SOURCE_FILESYSTEM_UNSUPPORTED' });
    assert.equal(await readWorkerStatus(stateDirectory), null);
    const unlock = await acquireWorkerLock(stateDirectory);
    await unlock();
  `;
  // A leaked socket keeps the child alive; the parent bounds that failure as well as the assertions.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    timeout: 10_000,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('fresh selected-main proof precedes grant; persisted credential never enters CLI result', async (t) => {
  const f = await fixture(t); const calls = [];
  const result = await enrollWorker({ ...f, post: async (url, body) => {
    calls.push(url);
    if (url.endsWith('/device/challenge')) {
      assert.equal(body.grant, undefined);
      return { request: body, mainApplicationVersion: '0.1.0', mainPublicKey: f.publicKey, mainPublicKeyFingerprint: f.input.mainPublicKeyFingerprint, signature: sign(null, Buffer.from(mainEnrollmentProofMessage(body, '0.1.0')), f.key.privateKey).toString('base64url') };
    }
    assert.equal(verify(null, Buffer.from(pairingProof(body)), f.identity.publicKey, Buffer.from(body.signature, 'base64url')), true);
    return { registration: { mainId: f.input.mainId, deviceId: randomUUID(), workerInstallationId: f.identity.workerInstallationId, publicKeyFingerprint: f.identity.publicKeyFingerprint, keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] }, credential: 'b'.repeat(64), expiresAt: '2026-12-01T00:00:00.000Z' };
  } });
  assert.deepEqual(calls, ['https://main.example/device/challenge', 'https://main.example/device/pair']);
  assert.equal(JSON.stringify(result).includes('b'.repeat(64)), false);
  const persisted = JSON.parse(await readFile(join(f.stateDirectory, 'pairing.json'), 'utf8'));
  assert.equal(persisted.mainPublicKeyFingerprint, f.input.mainPublicKeyFingerprint);
  assert.equal(persisted.credential, 'b'.repeat(64));
});

test('forged main proof blocks before sending grant or persisting pairing', async (t) => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(enrollWorker({ ...f, post: async () => { calls++; return {}; } }), /wrong_main_proof/);
  assert.equal(calls, 1);
  await assert.rejects(readFile(join(f.stateDirectory, 'pairing.json')), { code: 'ENOENT' });
});

test('connection-purpose proof cannot authorize enrollment or release its grant', async (t) => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(enrollWorker({ ...f, post: async (_url, body) => {
    calls++;
    const request = { ...body, audience: 'graphql-worker-main-v1' };
    return { request, mainApplicationVersion: '0.1.0', mainPublicKey: f.publicKey, mainPublicKeyFingerprint: f.input.mainPublicKeyFingerprint, signature: sign(null, Buffer.from(mainIdentityProofMessage(request, '0.1.0')), f.key.privateKey).toString('base64url') };
  } }), /wrong_main_proof/);
  assert.equal(calls, 1);
  await assert.rejects(readFile(join(f.stateDirectory, 'pairing.json')), { code: 'ENOENT' });
});

test('bounded enrollment response classifies overflow, HTTP, JSON and network failure without exposing response or error text', async () => {
  await assert.rejects(boundedPost('https://main.example', {}, async () => new Response('a'.repeat(16_385))), /enrollment_response_too_large/);
  await assert.rejects(boundedPost('https://main.example', {}, async () => new Response('secret server detail', { status: 401 })), { code: 'enrollment_http_401' });
  await assert.rejects(boundedPost('https://main.example', {}, async () => new Response('secret non-JSON')), { code: 'enrollment_response_invalid' });
  await assert.rejects(boundedPost('https://main.example', {}, async () => { throw new TypeError('secret TLS or URL detail'); }), { code: 'enrollment_transport_failed' });
});

function mainProof(f, body) {
  return { request: body, mainApplicationVersion: '0.1.0', mainPublicKey: f.publicKey, mainPublicKeyFingerprint: f.input.mainPublicKeyFingerprint, signature: sign(null, Buffer.from(mainEnrollmentProofMessage(body, '0.1.0')), f.key.privateKey).toString('base64url') };
}

for (const inputKind of ['file', 'code']) {
  test(`pairing from ${inputKind} through a symlinked cache parent persists canonical roots and resumes setup`, async t => {
    const f = await fixture(t, { symlinkedParent: true });
    await assert.rejects(openPrivateRoot(f.stateDirectory), { code: 'SOURCE_FILESYSTEM_UNSUPPORTED' });
    const enrollmentCode = encodeWorkerEnrollmentCode({ version: 1, kind: 'enrollment',
      workerInstallationId: f.identity.workerInstallationId, publicKeyFingerprint: f.identity.publicKeyFingerprint,
      enrollment: f.input, expiresAt: '2099-01-01T00:00:00.000Z' });
    const post = async (url, body) => {
      if (url.endsWith('/device/challenge')) return mainProof(f, body);
      return { registration: { mainId: f.input.mainId, deviceId: randomUUID(),
        workerInstallationId: f.identity.workerInstallationId, publicKeyFingerprint: f.identity.publicKeyFingerprint,
        keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] },
        credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' };
    };
    const enroll = inputKind === 'file' ? enrollWorker : enrollWorkerCode;
    const result = await enroll({ ...f, enrollmentCode, post });
    const canonicalState = await realpath(f.stateDirectory);
    const pairing = JSON.parse(await readFile(join(canonicalState, 'pairing.json'), 'utf8'));
    assert.equal(pairing.deviceId, result.deviceId);
    const approved = await loadApprovedRoots(f.stateDirectory, pairing);
    assert.equal(approved.bases[0].canonicalPath, join(canonicalState, 'managed/workspaces'));
    assert.equal(approved.managedRuntimeRoot, join(canonicalState, 'managed/runtime'));
    const status = await ensurePairedManagedSetup({ stateDirectory: f.stateDirectory, pairing, home: f.home });
    assert.equal(status.state, 'runtime-unavailable');
    assert.deepEqual(await loadApprovedRoots(canonicalState, pairing), approved);
  });
}

test('pairing rejects a symlinked state directory before transport or managed approval', async t => {
  const f = await fixture(t);
  const stateLink = join(f.home, 'state-link');
  await symlink(f.stateDirectory, stateLink);
  let calls = 0;
  await assert.rejects(enrollWorker({ ...f, stateDirectory: stateLink, post: async () => { calls++; } }),
    { code: 'private_directory_required' });
  assert.equal(calls, 0);
  await assert.rejects(ensurePairedManagedSetup({ stateDirectory: stateLink }),
    { code: 'private_directory_required' });
  await assert.rejects(readFile(join(f.stateDirectory, 'pairing.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.stateDirectory, 'approved-roots.json')), { code: 'ENOENT' });
});

test('private setup code delegates fresh proof and persists only target-scoped public trust', async (t) => {
  const f = await fixture(t);
  const certificatePem = rootCertificates.find(value => new X509Certificate(value).ca);
  const tlsTrust = { certificatePem, sha256: createHash('sha256').update(new X509Certificate(certificatePem).raw).digest('hex') };
  const enrollmentCode = encodeWorkerEnrollmentCode({ version: 1, kind: 'enrollment', workerInstallationId: f.identity.workerInstallationId,
    publicKeyFingerprint: f.identity.publicKeyFingerprint, enrollment: f.input, expiresAt: '2099-01-01T00:00:00.000Z', tlsTrust });
  const calls = [];
  const result = await enrollWorkerCode({ ...f, enrollmentCode, post: async (url, body) => {
    calls.push(url);
    if (url.endsWith('/device/challenge')) { assert.equal(body.grant, undefined); return mainProof(f, body); }
    assert.equal(body.requestId, f.input.requestId);
    assert.equal(body.grant, f.input.grant);
    return { registration: { mainId: f.input.mainId, deviceId: randomUUID(), workerInstallationId: f.identity.workerInstallationId,
      publicKeyFingerprint: f.identity.publicKeyFingerprint, keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] },
      credential: 'b'.repeat(64), expiresAt: '2026-12-01T00:00:00.000Z' };
  } });
  assert.deepEqual(calls, ['https://main.example/device/challenge', 'https://main.example/device/pair']);
  const persisted = JSON.parse(await readFile(join(f.stateDirectory, 'pairing.json'), 'utf8'));
  assert.deepEqual(persisted.tlsTrust, tlsTrust);
  assert.equal(persisted.endpoint, f.input.endpoint);
  assert.equal(JSON.stringify(result).includes(enrollmentCode), false);
  assert.equal(JSON.stringify(result).includes('b'.repeat(64)), false);
});

test('private setup code for another installation rejects before any transport', async (t) => {
  const f = await fixture(t); let calls = 0;
  const enrollmentCode = encodeWorkerEnrollmentCode({ version: 1, kind: 'enrollment', workerInstallationId: randomUUID(),
    publicKeyFingerprint: f.identity.publicKeyFingerprint, enrollment: f.input, expiresAt: '2099-01-01T00:00:00.000Z' });
  await assert.rejects(enrollWorkerCode({ ...f, enrollmentCode, post: async () => { calls++; } }), { code: 'setup_code_identity_mismatch' });
  assert.equal(calls, 0);
  await assert.rejects(readFile(join(f.stateDirectory, 'pairing.json')), { code: 'ENOENT' });
});

test('missing, malformed JSON, schema and nonprivate enrollment files are actionable local errors with no network calls', async (t) => {
  const f = await fixture(t); let calls = 0;
  const check = async (code) => {
    await assert.rejects(enrollWorker({ ...f, post: async () => { calls++; } }), (error) => {
      assert.equal(error.code, code);
      assert.ok(pairingErrorMessage(error).length < 600);
      assert.equal(pairingErrorMessage(error).includes(f.input.grant), false);
      return true;
    });
  };
  await writeFile(f.enrollmentFile, '{secret malformed grant');
  await check('pairing_file_json_invalid');
  await writeFile(f.enrollmentFile, JSON.stringify({ ...f.input, requestId: 'secret invalid ID' }));
  await check('pairing_file_schema_invalid');
  await chmod(f.enrollmentFile, 0o000);
  await check('pairing_file_unreadable');
  await chmod(f.enrollmentFile, 0o644);
  await check('private_enrollment_file_required');
  await chmod(f.enrollmentFile, 0o600);
  await writeFile(f.enrollmentFile, 'a'.repeat(16_385));
  await check('private_enrollment_file_required');
  await rm(f.enrollmentFile);
  await check('pairing_file_missing');
  assert.equal(calls, 0);
  await assert.rejects(readFile(join(f.stateDirectory, 'pairing.json')), { code: 'ENOENT' });
});

test('challenge network failure is distinct from an uncertain pairing outcome', async (t) => {
  const f = await fixture(t);
  await assert.rejects(enrollWorker({ ...f, post: async () => { throw new TypeError(f.input.grant); } }), (error) => {
    assert.equal(error.code, 'pairing_main_unreachable');
    assert.match(pairingErrorMessage(error), /connectivity/);
    assert.equal(pairingErrorMessage(error).includes(f.input.grant), false);
    return true;
  });
});

test('HTTP rejection identifies status and recovery without echoing server content', async (t) => {
  const f = await fixture(t);
  for (const status of [400, 401, 403, 409]) {
    await assert.rejects(enrollWorker({ ...f, post: async (url, body) => url.endsWith('/device/challenge') ? mainProof(f, body)
      : boundedPost(url, body, async () => new Response(f.input.grant, { status })) }), (error) => {
      assert.equal(error.code, 'pairing_http_rejected');
      assert.match(pairingErrorMessage(error), new RegExp(`HTTP ${status}`));
      assert.equal(pairingErrorMessage(error).includes(f.input.grant), false);
      return true;
    });
  }
  await assert.rejects(readFile(join(f.stateDirectory, 'pairing.json')), { code: 'ENOENT' });
});

test('lost accepted response retries the original enrollment request and identity without local recovery side effects', async (t) => {
  const f = await fixture(t);
  const originalFile = await readFile(f.enrollmentFile);
  const originalIdentity = await readFile(join(f.stateDirectory, 'identity.json'));
  const accepted = { registration: { mainId: f.input.mainId, deviceId: randomUUID(), workerInstallationId: f.identity.workerInstallationId, publicKeyFingerprint: f.identity.publicKeyFingerprint, keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] }, credential: 'b'.repeat(64), expiresAt: '2026-12-01T00:00:00.000Z' };
  const requests = [];
  const post = async (url, body) => {
    if (url.endsWith('/device/challenge')) return mainProof(f, body);
    requests.push(body);
    if (requests.length === 1) throw new Error('secret lost response');
    return accepted;
  };
  await assert.rejects(enrollWorker({ ...f, post }), (error) => {
    assert.equal(error.code, 'pairing_outcome_unknown');
    assert.match(pairingErrorMessage(error), /original.*enrollment file and requestId/);
    assert.match(pairingErrorMessage(error), /do not create a new identity or requestId/);
    assert.equal(pairingErrorMessage(error).includes('secret'), false);
    return true;
  });
  await assert.rejects(readFile(join(f.stateDirectory, 'pairing.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.enrollmentFile), originalFile);
  assert.deepEqual(await readFile(join(f.stateDirectory, 'identity.json')), originalIdentity);
  const result = await enrollWorker({ ...f, post });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1].requestId, f.input.requestId);
  assert.equal(result.deviceId, accepted.registration.deviceId);
  assert.deepEqual(await readFile(f.enrollmentFile), originalFile);
  assert.deepEqual(await readFile(join(f.stateDirectory, 'identity.json')), originalIdentity);
});

test('invalid success responses and transient HTTP statuses retain uncertainty and original retry instructions', async (t) => {
  const f = await fixture(t);
  for (const response of [() => ({}), () => boundedPost('https://main.example', {}, async () => new Response('secret non-JSON')),
    ...[408, 429, 500, 503].map((status) => () => boundedPost('https://main.example', {}, async () => new Response('secret server detail', { status })))]) {
    await assert.rejects(enrollWorker({ ...f, post: async (url, body) => url.endsWith('/device/challenge') ? mainProof(f, body) : response() }), (error) => {
      assert.equal(error.code, 'pairing_outcome_unknown');
      assert.match(pairingErrorMessage(error), /Retry the same pair command/);
      assert.equal(pairingErrorMessage(error).includes('secret'), false);
      return true;
    });
  }
  await assert.rejects(readFile(join(f.stateDirectory, 'pairing.json')), { code: 'ENOENT' });
});
