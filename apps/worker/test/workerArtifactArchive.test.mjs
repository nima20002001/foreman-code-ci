import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { downloadWorkerArtifact, fetchGitHubAsset } from '../src/update.mjs';

const fixtureRoot = join(homedir(), '.cache', 'foreman-tmp');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2',
  rootPersistent: true, homePersistent: true, storagePersistent: true };

function tarEntry(path, bytes, type = '0', declaredSize = bytes.length) {
  const header = Buffer.alloc(512);
  header.write(path);
  header.write('0000600\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${declaredSize.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

async function fixture(t) {
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  const base = await mkdtemp(join(fixtureRoot, 'worker-archive-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bytes = Buffer.from('release payload');
  const { os, osRelease, arch, libc, node } = facts;
  const manifest = { format: 1, version: '1.2.0', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1,
    target: { os, osRelease, arch, libc, node },
    files: [{ path: 'src/cli.mjs', size: bytes.length, sha256: hash(bytes) }] };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const release = { version: manifest.version, manifest, manifestSha256: hash(manifestBytes),
    github: { repository: 'octo/site', tag: `worker-${'c'.repeat(40)}` } };
  const directory = join(base, 'candidate');
  const download = entries => downloadWorkerArtifact({ release, directory, facts,
    request: async () => { throw new Error('GitHub carrier must not request chunks'); },
    fetchAsset: async ({ github, destination, maxBytes }) => {
      assert.deepEqual(github, release.github);
      assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes < 2 * 1024 * 1024,
        'The carrier must receive a manifest-derived compressed byte limit');
      await writeFile(destination, gzipSync(Buffer.concat([
        tarEntry('manifest.json', manifestBytes), ...entries, Buffer.alloc(1024),
      ])));
    } });
  return { base, directory, bytes, manifest, release, download };
}

test('streams the announced files and keeps their authenticated manifest', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.download([tarEntry('src/cli.mjs', f.bytes)]), f.manifest);
  assert.deepEqual(await readFile(join(f.directory, f.manifest.files[0].path)), f.bytes);
  assert.equal(hash(await readFile(join(f.directory, 'manifest.json'))), f.release.manifestSha256);
});

async function waitForDownload(predicate) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await nextTurn();
  }
  assert.fail('The fake downloader did not reach the expected state.');
}

async function stalledDownloader(t, { partial = false, alwaysStall = false } = {}) {
  const previousPath = process.env.PATH;
  const controller = new AbortController();
  let outcome;
  t.after(async () => {
    controller.abort(new Error('Fixture closed'));
    await outcome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const f = await fixture(t);
  const manifestBytes = Buffer.from(`${JSON.stringify(f.manifest)}\n`);
  const archive = gzipSync(Buffer.concat([
    tarEntry('manifest.json', manifestBytes), tarEntry('src/cli.mjs', f.bytes), Buffer.alloc(1024),
  ]));
  await writeFile(join(f.base, 'asset.tar.gz'), archive);
  await writeFile(join(f.base, 'attempts'), '0');
  await writeFile(join(f.base, 'gh'), `#!/usr/bin/env node
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const base = __dirname;
const attempts = join(base, 'attempts');
const attempt = Number(readFileSync(attempts, 'utf8')) + 1;
const archive = readFileSync(join(base, 'asset.tar.gz'));
if (attempt > 1 && !${alwaysStall}) {
  process.stdout.end(archive);
} else {
  if (${partial}) process.stdout.write(archive.subarray(0, 10));
  process.on('SIGTERM', () => {
    writeFileSync(join(base, 'aborted-' + attempt), 'aborted');
    process.exit(0);
  });
  let progressed = false;
  setInterval(() => {
    if (!progressed && existsSync(join(base, 'progress'))) {
      progressed = true;
      process.stdout.write(archive.subarray(10, 20));
    }
  }, 5);
}
writeFileSync(attempts, String(attempt));
`, { mode: 0o700 });
  process.env.PATH = `${f.base}:${previousPath ?? ''}`;
  let retries = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return { ...f,
    attempts: async () => Number(await readFile(join(f.base, 'attempts'), 'utf8')),
    received: async size => {
      const scratch = (await readdir(f.base)).find(name => name.startsWith('.worker-github-'));
      if (!scratch) return false;
      return lstat(join(f.base, scratch, 'artifact.tar.gz')).then(info => info.size >= size, error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
    },
    retries: () => retries,
    start: (timeoutMs = 600_000) => {
      outcome = downloadWorkerArtifact({ release: f.release, directory: f.directory, facts,
        signal: controller.signal, timeoutMs,
        log: (_message, fields) => { if (fields.retryMs) retries++; },
      }).then(manifest => ({ manifest }), error => ({ error }));
      return outcome;
    },
  };
}

for (const partial of [false, true]) {
  test(`retries a GitHub bundle after 60 seconds without bytes${partial ? ' following progress' : ''}`, async t => {
    const f = await stalledDownloader(t, { partial });
    const outcome = f.start();
    await waitForDownload(async () => await f.attempts() === 1 && (!partial || await f.received(10)));
    if (partial) {
      t.mock.timers.tick(45_000);
      await writeFile(join(f.base, 'progress'), 'send bytes');
      await waitForDownload(() => f.received(20));
    }
    t.mock.timers.tick(59_999);
    await nextTurn();
    assert.equal(await f.attempts(), 1);
    t.mock.timers.tick(1);
    await waitForDownload(() => f.retries() === 1);
    t.mock.timers.tick(5000);
    await waitForDownload(async () => await f.attempts() === 2);
    assert.deepEqual(await outcome, { manifest: f.manifest });
    assert.equal(await readFile(join(f.base, 'aborted-1'), 'utf8'), 'aborted');
    assert.deepEqual(await readFile(join(f.directory, f.manifest.files[0].path)), f.bytes);
  });
}

test('stall retries retain the original bundle download deadline', async t => {
  const f = await stalledDownloader(t, { alwaysStall: true });
  const outcome = f.start(90_000);
  await waitForDownload(async () => await f.attempts() === 1);
  t.mock.timers.tick(60_000);
  await waitForDownload(() => f.retries() === 1);
  t.mock.timers.tick(5000);
  await waitForDownload(async () => await f.attempts() === 2);
  t.mock.timers.tick(25_000);
  const { error } = await outcome;
  assert.equal(error.code, 'WORKER_RELEASE_ASSET_UNAVAILABLE');
  assert.match(error.message, /90000 ms/);
  assert.equal(await f.attempts(), 2);
  assert.equal(await readFile(join(f.base, 'aborted-2'), 'utf8'), 'aborted');
  assert.equal((await readdir(f.base)).some(name => name.startsWith('.worker-github-')), false);
});

for (const [label, entries, code] of [
  ['undeclared compressed member', bytes => [tarEntry('extra.bin', Buffer.alloc(2 * 1024 * 1024)),
    tarEntry('src/cli.mjs', bytes)], 'artifact_archive_invalid'],
  ['oversized declared member', () => [tarEntry('src/cli.mjs', Buffer.alloc(2 * 1024 * 1024))],
    'artifact_file_size_mismatch'],
  ['non-regular member', bytes => [tarEntry('extra-link', Buffer.alloc(0), '2'), tarEntry('src/cli.mjs', bytes)],
    'artifact_archive_invalid'],
  ['duplicate declared member', bytes => [tarEntry('src/cli.mjs', bytes), tarEntry('src/cli.mjs', bytes)],
    'artifact_archive_invalid'],
  ['escaping member', bytes => [tarEntry('../outside.bin', Buffer.from('outside')), tarEntry('src/cli.mjs', bytes)],
    'artifact_archive_invalid'],
]) {
  test(`rejects ${label} before retaining an installation`, async t => {
    const f = await fixture(t);
    await assert.rejects(f.download(entries(f.bytes)), { code });
    assert.equal(await lstat(f.directory).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }), null);
    assert.deepEqual(await readdir(f.base), []);
    await writeFile(join(f.base, 'update-status.json'), JSON.stringify({ state: 'failed' }));
    assert.deepEqual(JSON.parse(await readFile(join(f.base, 'update-status.json'), 'utf8')), { state: 'failed' });
  });
}

test('rejects an oversized compressed carrier before opening its archive', async t => {
  const f = await fixture(t);
  await assert.rejects(downloadWorkerArtifact({ release: f.release, directory: f.directory, facts,
    fetchAsset: async ({ destination, maxBytes }) => {
      assert.ok(Number.isSafeInteger(maxBytes));
      await writeFile(destination, Buffer.alloc(maxBytes + 1));
    } }), { code: 'artifact_archive_size_mismatch' });
  assert.deepEqual(await readdir(f.base), []);
});

test('the GitHub downloader caps streamed stdout before writing an oversized asset', async t => {
  const f = await fixture(t);
  const binaries = join(f.base, 'bin');
  await mkdir(binaries, { mode: 0o700 });
  await writeFile(join(binaries, 'gh'), `#!/usr/bin/env node
const { writeFile } = require('node:fs/promises');
const destination = process.argv[process.argv.indexOf('--output') + 1];
const bytes = Buffer.alloc(2 * 1024 * 1024);
if (destination === '-') {
  process.stdout.write(bytes);
} else {
  writeFile(destination, bytes).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath ?? ''}`;
  const destination = join(f.base, 'download.tar.gz');
  try {
    await assert.rejects(fetchGitHubAsset({ github: f.release.github, asset: 'fixture.tar.gz',
      destination, maxBytes: 1024, signal: AbortSignal.timeout(5000) }),
    { code: 'artifact_archive_size_mismatch' });
    assert.equal(await lstat(destination).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }), null);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

for (const { failure, script } of [
  { failure: 'missing executable', script: null },
  { failure: 'missing authentication', script: 'echo "Run gh auth login to authenticate" >&2\nexit 4\n' },
  { failure: 'denied access', script: 'echo "HTTP 403: Resource not accessible by integration" >&2\nexit 1\n' },
  { failure: 'invalid credentials', script: 'echo "HTTP 401: Bad credentials" >&2\nexit 1\n' },
]) {
  test(`GitHub download fails permanently for ${failure} without a retry wait`, async t => {
    const f = await fixture(t);
    const binaries = join(f.base, 'bin');
    await mkdir(binaries);
    if (script) await writeFile(join(binaries, 'gh'), `#!/bin/sh\n${script}`, { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = binaries;
    t.after(() => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    });
    const retries = [];
    await assert.rejects(downloadWorkerArtifact({ release: f.release, directory: f.directory, facts,
      timeoutMs: 150, log: (_message, fields) => { if (fields.retryMs) retries.push(fields.retryMs); },
    }), { code: 'worker_update_github_configuration' });
    assert.deepEqual(retries, []);
    await assert.rejects(lstat(f.directory), { code: 'ENOENT' });
  });
}

test('GitHub rate limiting remains a transient download failure', async t => {
  const f = await fixture(t);
  const binaries = join(f.base, 'bin');
  await mkdir(binaries);
  await writeFile(join(binaries, 'gh'),
    '#!/bin/sh\necho "HTTP 403: API rate limit exceeded" >&2\nexit 1\n', { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = binaries;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  await assert.rejects(fetchGitHubAsset({ github: f.release.github, asset: 'bundle.tar.gz',
    destination: join(f.base, 'download.tar.gz'), maxBytes: 1024,
  }), { code: 'worker_update_github_unavailable' });
});
