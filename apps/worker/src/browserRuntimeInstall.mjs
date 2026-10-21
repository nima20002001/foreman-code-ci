import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createReadStream, constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export const BROWSER_RUNTIME_MAGIC = 'FOREMAN_BROWSER_RUNTIME_1\n';
export const BROWSER_RUNTIME_CHUNK_BYTES = 16 * 1024 * 1024;
const digest = /^[a-f0-9]{64}$/;
const maxExpanded = 4 * 1024 * 1024 * 1024;
const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function invariant(condition, message) { if (!condition) throw new Error(`BROWSER_RUNTIME_INVALID: ${message}`); }
function safePath(path) {
  return typeof path === 'string' && path.length <= 1024 && /^[a-zA-Z0-9_@.+/[\]-]+$/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}
export function matchesBrowserRuntimeTarget(actual, expected) {
  return ['os', 'osRelease', 'arch', 'libc'].every(key => actual?.[key] === expected?.[key])
    && /^v22\./.test(actual?.node ?? '') && /^v22\./.test(expected?.node ?? '');
}

export function validateBrowserRuntimeManifest(manifest, target) {
  invariant(manifest?.format === 1 && manifest.kind === 'foreman-browser-runtime', 'unsupported unit format');
  invariant(/^\d+\.\d+\.\d+$/.test(manifest.runtimeVersion) && /^\d+\.\d+\.\d+$/.test(manifest.foremanVersion), 'invalid versions');
  invariant(/^[a-f0-9]{40}$/.test(manifest.sourceCommit) && manifest.profileFormat === 1, 'unsupported profile format');
  invariant(manifest.target?.os === 'ubuntu' && manifest.target.arch === 'x64'
    && /^glibc-\d+\.\d+$/.test(manifest.target.libc), 'unsupported Foreman target');
  if (target) invariant(matchesBrowserRuntimeTarget(manifest.target, target), 'target mismatch');
  invariant(digest.test(manifest.resolvedLockSha256) && Array.isArray(manifest.files)
    && manifest.files.length > 0 && manifest.files.length <= 100000, 'missing locked file inventory');
  const paths = new Set();
  let bytes = 0;
  for (const file of manifest.files) {
    invariant(safePath(file.path) && !['manifest.json', 'readiness.json'].includes(file.path) && !paths.has(file.path), 'unsafe or duplicate file');
    invariant(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 1024 ** 3 && digest.test(file.sha256), 'invalid file identity');
    invariant(file.mode === 0o600 || file.mode === 0o700, 'nonprivate file mode');
    paths.add(file.path); bytes += file.size;
  }
  invariant(bytes <= maxExpanded, 'runtime expanded size is unsupported');
  for (const path of paths) {
    let parent = dirname(path);
    while (parent !== '.') { invariant(!paths.has(parent), 'file used as directory'); parent = dirname(parent); }
  }
  for (const entry of ['pythonExecutable', 'chromiumExecutable', 'bridgeScript', 'nativeHostModule', 'skill']) {
    invariant(paths.has(manifest[entry]), `missing ${entry}`);
  }
  invariant(paths.has('runtime-lock.json') && paths.has('LICENSES.txt'), 'missing provenance or notices');
  return manifest;
}

async function privateDirectory(directory, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  invariant(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0
    && (process.getuid === undefined || info.uid === process.getuid()), 'directory is not private');
}

/** Only the short alias lives outside managed storage; Chromium's temporary bytes stay in storageParent. */
export async function createBrowserRuntimeDirectory(storageParent) {
  const suffix = '/org.chromium.Chromium.XXXXXX/SingletonSocket';
  const fits = path => Buffer.byteLength(path + suffix) < 108;
  if (process.env.TMPDIR && fits(process.env.TMPDIR)) return null;
  await privateDirectory(storageParent);
  const directory = await mkdtemp(join(storageParent, '.browser-tmp-'));
  let aliasDirectory = null;
  try {
    if (fits(directory)) return { directory, aliasDirectory, temporaryDirectory: directory };
    aliasDirectory = await mkdtemp('/var/tmp/foreman-browser-');
    const temporaryDirectory = join(aliasDirectory, 'data');
    invariant(fits(temporaryDirectory), 'browser socket directory exceeds the native address bound');
    await symlink(directory, temporaryDirectory);
    return { directory, aliasDirectory, temporaryDirectory };
  } catch (error) {
    if (aliasDirectory) await rm(aliasDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function removeBrowserRuntimeDirectory(runtime) {
  if (!runtime) return;
  const { directory, aliasDirectory, temporaryDirectory } = runtime;
  invariant(isAbsolute(directory) && /^\.browser-tmp-[a-zA-Z0-9]{6}$/.test(basename(directory)), 'invalid browser temporary directory');
  if (aliasDirectory) {
    invariant(dirname(aliasDirectory) === '/var/tmp' && /^foreman-browser-[a-zA-Z0-9]{6}$/.test(basename(aliasDirectory))
      && temporaryDirectory === join(aliasDirectory, 'data'), 'invalid browser socket alias');
  } else invariant(temporaryDirectory === directory, 'invalid browser temporary path');
  for (const path of [directory, aliasDirectory].filter(Boolean)) {
    try { await privateDirectory(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (aliasDirectory) {
    try { invariant(await readlink(temporaryDirectory) === directory, 'browser socket alias changed'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(aliasDirectory, { recursive: true, force: true });
  }
  await rm(directory, { recursive: true, force: true });
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncUnit(directory, files) {
  const directories = new Set([directory, join(directory, 'empty-workspace')]);
  for (const file of files) {
    let parent = dirname(join(directory, file.path));
    while (parent !== directory) { directories.add(parent); parent = dirname(parent); }
  }
  for (const path of ['manifest.json', 'readiness.json']) {
    const handle = await open(join(directory, path), 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  for (const parent of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(parent);
}

async function privateJson(path, value) {
  const temporary = `${path}.${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); await syncDirectory(dirname(path)); }
  finally { await rm(temporary, { force: true }); }
}

export async function writeBrowserRuntimeStatus(root, status) {
  const directory = join(root, 'browser-runtime');
  await privateDirectory(directory, true);
  await privateJson(join(directory, 'status.json'), status);
  return status;
}

export async function readBrowserRuntimeStatus(root) {
  try { return JSON.parse(await readRegularFile(join(root, 'browser-runtime/status.json'), 16384)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function readBrowserRuntimeDrain(browserStateDirectory) {
  try {
    await privateDirectory(browserStateDirectory);
    const record = JSON.parse(await readRegularFile(join(browserStateDirectory, 'runtime-drain.json'), 16384));
    invariant(typeof record.commandId === 'string' && record.commandId.length > 0 && record.commandId.length <= 200
      && ['draining', 'canceled'].includes(record.state), 'invalid browser drain record');
    return record;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** The installer calls this only after stopping the host; active hosts cancel through their control socket. */
export async function cancelStoppedBrowserRuntimeDrain(browserStateDirectory, commandId) {
  const record = await readBrowserRuntimeDrain(browserStateDirectory);
  if (!record || record.state === 'canceled') return;
  invariant(record.commandId === commandId, 'Another runtime update owns this drain.');
  await privateJson(join(browserStateDirectory, 'runtime-drain.json'), { commandId, state: 'canceled' });
}

async function withRuntimeLock(runtimeRoot, operation) {
  invariant(isAbsolute(runtimeRoot), 'runtime root must be absolute');
  await privateDirectory(runtimeRoot, true);
  const handle = await open(runtimeRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await new Promise((yes, no) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'inherit', handle.fd] });
      child.once('error', no);
      child.once('close', code => code === 0 ? yes() : no(new Error('BROWSER_RUNTIME_INSTALL_BUSY')));
    });
    return await operation();
  } finally { await handle.close(); }
}

async function readRegularFile(path, limit) {
  const info = await lstat(path);
  invariant(info.isFile() && !info.isSymbolicLink() && info.size <= limit, 'invalid regular file');
  return readFile(path);
}

export async function hashBrowserRuntimeFile(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), size: bytes };
}

export async function readBrowserRuntimeArtifact(artifact, expectedSha256) {
  invariant(digest.test(expectedSha256), 'missing approved descriptor digest');
  const bytes = await readRegularFile(join(artifact, 'browser-runtime.json'), 1024 * 1024);
  invariant(hash(bytes) === expectedSha256, 'descriptor checksum mismatch');
  const descriptor = JSON.parse(bytes);
  invariant(descriptor.format === 1 && descriptor.kind === 'foreman-browser-runtime-artifact'
    && digest.test(descriptor.archiveSha256) && digest.test(descriptor.manifestSha256), 'invalid archive identity');
  invariant(Array.isArray(descriptor.chunks) && descriptor.chunks.length > 0 && descriptor.chunks.length <= 256, 'invalid chunk count');
  let total = 0;
  for (const [index, chunk] of descriptor.chunks.entries()) {
    invariant(chunk.path === `chunk-${String(index).padStart(6, '0')}.bin` && digest.test(chunk.sha256)
      && Number.isSafeInteger(chunk.size) && chunk.size > 0 && chunk.size <= BROWSER_RUNTIME_CHUNK_BYTES, 'invalid chunk');
    total += chunk.size;
  }
  invariant(total === descriptor.compressedBytes && total <= maxExpanded, 'invalid archive size');
  return descriptor;
}

/** Consume a runner-built unit without launching target executables on the release assembler. */
export async function copyBuiltBrowserRuntime({ directory, output, target, commit }) {
  invariant(directory, 'Build browser units on a matching target runner and supply its artifact index.');
  const index = JSON.parse(await readRegularFile(join(directory, 'index.json'), 1024 * 1024));
  invariant(index.format === 1 && index.sourceCommit === commit && Array.isArray(index.artifacts), 'build index source mismatch');
  const candidates = index.artifacts.filter(entry => matchesBrowserRuntimeTarget(entry.target, target));
  invariant(candidates.length === 1, 'No unique browser unit from a matching target runner.');
  const entry = candidates[0];
  invariant(entry.directory === '.' || safePath(entry.directory), 'unsafe build artifact directory');
  const artifact = join(directory, entry.directory);
  const descriptor = await readBrowserRuntimeArtifact(artifact, entry.descriptorSha256);
  invariant(descriptor.sourceCommit === commit && matchesBrowserRuntimeTarget(descriptor.target, target), 'build artifact target or source mismatch');
  await mkdir(output, { mode: 0o700 });
  const archiveHash = createHash('sha256');
  try {
    for (const chunk of descriptor.chunks) {
      const bytes = await readRegularFile(join(artifact, chunk.path), BROWSER_RUNTIME_CHUNK_BYTES);
      invariant(bytes.length === chunk.size && hash(bytes) === chunk.sha256, 'build chunk checksum mismatch');
      archiveHash.update(bytes);
      await writeFile(join(output, chunk.path), bytes, { flag: 'wx', mode: 0o600 });
    }
    invariant(archiveHash.digest('hex') === descriptor.archiveSha256, 'build archive checksum mismatch');
    const bytes = await readRegularFile(join(artifact, 'browser-runtime.json'), 1024 * 1024);
    invariant(hash(bytes) === entry.descriptorSha256, 'build descriptor changed during copy');
    await writeFile(join(output, 'browser-runtime.json'), bytes, { flag: 'wx', mode: 0o600 });
    return { descriptor, descriptorSha256: entry.descriptorSha256 };
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}

async function collectArchive(artifact, descriptor, destination, signal) {
  const handle = await open(destination, 'wx', 0o600), combined = createHash('sha256');
  try {
    for (const chunk of descriptor.chunks) {
      signal?.throwIfAborted();
      const bytes = await readRegularFile(join(artifact, chunk.path), BROWSER_RUNTIME_CHUNK_BYTES);
      invariant(bytes.length === chunk.size && hash(bytes) === chunk.sha256, 'chunk checksum mismatch');
      combined.update(bytes); await handle.writeFile(bytes);
    }
    invariant(combined.digest('hex') === descriptor.archiveSha256, 'archive checksum mismatch');
    await handle.sync();
  } finally { await handle.close(); }
}

class RuntimeReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); this.read = 0; }
  async exact(size) {
    invariant(size >= 0 && size <= 16 * 1024 * 1024, 'invalid archive read');
    const result = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      if (!this.buffer.length) {
        const next = await this.iterator.next();
        invariant(!next.done, 'truncated archive'); this.buffer = next.value;
      }
      const length = Math.min(size - offset, this.buffer.length);
      this.buffer.copy(result, offset, 0, length);
      this.buffer = this.buffer.subarray(length); offset += length; this.read += length;
      invariant(this.read <= maxExpanded + 32 * 1024 * 1024, 'expanded archive exceeds limit');
    }
    return result;
  }
  async end() { invariant(!this.buffer.length && (await this.iterator.next()).done, 'unexpected archive bytes'); }
}

async function extractRuntime(archive, descriptor, directory, target, signal) {
  const source = createReadStream(archive), stream = createGunzip();
  source.once('error', error => stream.destroy(error)); source.pipe(stream);
  const reader = new RuntimeReader(stream);
  try {
    invariant((await reader.exact(Buffer.byteLength(BROWSER_RUNTIME_MAGIC))).toString() === BROWSER_RUNTIME_MAGIC, 'invalid archive header');
    const length = (await reader.exact(4)).readUInt32BE();
    invariant(length > 0 && length <= 16 * 1024 * 1024, 'manifest too large');
    const bytes = await reader.exact(length);
    invariant(hash(bytes) === descriptor.manifestSha256, 'manifest checksum mismatch');
    const manifest = validateBrowserRuntimeManifest(JSON.parse(bytes), target);
    const disk = await statfs(directory);
    invariant(disk.bavail * disk.bsize >= manifest.files.reduce((sum, file) => sum + file.size, 0) + 16 * 1024 * 1024, 'insufficient runtime disk space');
    for (const file of manifest.files) {
      signal?.throwIfAborted();
      const path = join(directory, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, 'wx', file.mode), digest = createHash('sha256');
      try {
        let remaining = file.size;
        while (remaining) {
          signal?.throwIfAborted();
          const bytes = await reader.exact(Math.min(remaining, 1024 * 1024));
          digest.update(bytes); await handle.writeFile(bytes); remaining -= bytes.length;
        }
        invariant(digest.digest('hex') === file.sha256, 'runtime file checksum mismatch');
        await handle.sync();
      } finally { await handle.close(); }
    }
    await reader.end();
    await writeFile(join(directory, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
    return manifest;
  } finally { source.destroy(); stream.destroy(); }
}

function installedDescriptor(directory, manifest, manifestSha256) {
  return { rootDirectory: directory, runtimeVersion: manifest.runtimeVersion, profileFormat: manifest.profileFormat,
    manifestSha256, target: manifest.target, chromiumVersion: manifest.chromiumVersion,
    pythonExecutable: join(directory, manifest.pythonExecutable), chromiumExecutable: join(directory, manifest.chromiumExecutable),
    bridgeScript: join(directory, manifest.bridgeScript), nativeHostModule: join(directory, manifest.nativeHostModule),
    skill: join(directory, manifest.skill) };
}

async function verifyInstalled(directory, expected, target, requireReady = true) {
  await privateDirectory(directory);
  await privateDirectory(join(directory, 'empty-workspace'));
  invariant((await readdir(join(directory, 'empty-workspace'))).length === 0, 'Harness workspace must remain empty');
  const bytes = await readRegularFile(join(directory, 'manifest.json'), 16 * 1024 * 1024);
  invariant(hash(bytes) === expected, 'installed manifest mismatch');
  const manifest = validateBrowserRuntimeManifest(JSON.parse(bytes), target), base = await realpath(directory);
  for (const file of manifest.files) {
    const path = join(directory, file.path), info = await lstat(path);
    invariant(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === file.mode
      && (await realpath(path)).startsWith(`${base}/`), 'installed file escaped private unit');
    const actual = await hashBrowserRuntimeFile(path);
    invariant(actual.sha256 === file.sha256 && actual.size === file.size, 'installed file checksum mismatch');
  }
  invariant(hash(await readFile(join(directory, 'runtime-lock.json'))) === manifest.resolvedLockSha256, 'resolved lock mismatch');
  if (requireReady) {
    const ready = JSON.parse(await readRegularFile(join(directory, 'readiness.json'), 16384));
    invariant(ready.manifestSha256 === expected && ready.ready === true, 'runtime readiness is unconfirmed');
  }
  return installedDescriptor(directory, manifest, expected);
}

async function currentReference(runtimeRoot, name = 'current') {
  try {
    const target = await readlink(join(runtimeRoot, name));
    invariant(/^versions\/[a-f0-9]{64}$/.test(target), 'invalid runtime pointer'); return target;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function switchRuntime(runtimeRoot, name, reference) {
  if (reference === null) { await rm(join(runtimeRoot, name), { force: true }); await syncDirectory(runtimeRoot); return; }
  invariant(/^versions\/[a-f0-9]{64}$/.test(reference), 'invalid runtime destination');
  const temporary = join(runtimeRoot, `.${name}-${randomUUID()}`);
  try { await symlink(reference, temporary); await rename(temporary, join(runtimeRoot, name)); await syncDirectory(runtimeRoot); }
  finally { await rm(temporary, { force: true }); }
}

/** Called once by bootstrap, never from profile/computer card reads. No executable is launched here. */
export async function readInstalledBrowserRuntime({ runtimeRoot, target }) {
  await privateDirectory(runtimeRoot);
  const reference = await currentReference(runtimeRoot);
  if (!reference) throw new Error('BROWSER_RUNTIME_MISSING');
  return verifyInstalled(join(runtimeRoot, reference), reference.slice('versions/'.length), target);
}

/** Installation-only readiness uses temporary managed data and the normal Chromium sandbox. */
export async function checkBrowserRuntimeReadiness(descriptor, { signal } = {}) {
  const manifest = JSON.parse(await readFile(join(descriptor.rootDirectory, 'manifest.json'), 'utf8'));
  const workspace = join(descriptor.rootDirectory, 'empty-workspace');
  await privateDirectory(workspace, true);
  invariant((await readdir(workspace)).length === 0, 'Harness workspace must remain empty');
  const script = `import importlib.metadata as m,json,os,pathlib,shutil,subprocess,sys,tempfile,time,urllib.request,urllib.parse
assert not list(pathlib.Path(os.environ['BH_AGENT_WORKSPACE']).iterdir())
import browser_use, browser_harness.helpers
from websockets.sync.client import connect
configuration=json.loads(sys.argv[1])
assert sys.version.split()[0] == configuration['pythonVersion']
assert m.version('browser-use') == configuration['browserUseVersion']
assert m.version('browser-harness') == configuration['browserHarnessVersion']
directory=tempfile.mkdtemp(prefix='foreman-browser-ready-')
child=None
try:
 child=subprocess.Popen([configuration['chromiumExecutable'],'--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+directory,'--no-first-run','--disable-background-networking','--disable-component-update','data:text/html,<title>Foreman Browser Ready</title>'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 port_file=pathlib.Path(directory)/'DevToolsActivePort'
 deadline=time.monotonic()+30
 while not port_file.exists():
  if child.poll() is not None: raise RuntimeError('Chromium readiness launch failed: '+child.stderr.read(4096).decode(errors='replace'))
  if time.monotonic()>deadline: raise RuntimeError('Chromium readiness timed out')
  time.sleep(.05)
 port=int(port_file.read_text().splitlines()[0]); origin='http://127.0.0.1:'+str(port)
 with urllib.request.urlopen(origin+'/json/version',timeout=5) as response: version=json.load(response)
 assert version['Browser'].split('/')[-1] == configuration['chromiumVersion']
 assert urllib.parse.urlparse(version['webSocketDebuggerUrl']).hostname in ['127.0.0.1','localhost','::1']
 observed=False
 while time.monotonic()<deadline:
  with urllib.request.urlopen(origin+'/json/list',timeout=5) as response: pages=json.load(response)
  selected=next((page for page in pages if page.get('type')=='page' and page.get('title')=='Foreman Browser Ready'),None)
  if selected:
   with connect(selected['webSocketDebuggerUrl'],open_timeout=5) as channel:
    channel.send(json.dumps({'id':1,'method':'Runtime.evaluate','params':{'expression':'document.title','returnByValue':True}}))
    while True:
     answer=json.loads(channel.recv(timeout=5))
     if answer.get('id')==1:
      observed=answer.get('result',{}).get('result',{}).get('value')=='Foreman Browser Ready'; break
   break
  time.sleep(.05)
 assert observed, 'Readiness page was not observed'
 with connect(version['webSocketDebuggerUrl'],open_timeout=5) as channel:
  channel.send(json.dumps({'id':2,'method':'Browser.close'}))
 child.wait(timeout=10)
 assert child.returncode==0, 'Chromium did not shut down cleanly'
 print(json.dumps({'ready':True}))
finally:
 if child is not None and child.poll() is None:
  child.terminate()
  try: child.wait(timeout=5)
  except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)
 shutil.rmtree(directory)
`;
  const home = await mkdtemp(join(dirname(descriptor.rootDirectory), '.browser-readiness-'));
  let runtimeDirectory;
  try {
    runtimeDirectory = await createBrowserRuntimeDirectory(home);
    const { stdout } = await execute(descriptor.pythonExecutable, ['-I', '-B', '-c', script,
      JSON.stringify({ pythonVersion: manifest.pythonVersion, browserUseVersion: manifest.browserUseVersion,
        browserHarnessVersion: manifest.browserHarnessVersion, chromiumVersion: manifest.chromiumVersion,
        chromiumExecutable: descriptor.chromiumExecutable })],
    { timeout: 60000, maxBuffer: 65536, signal, cwd: workspace,
      env: { PATH: `${join(descriptor.rootDirectory, 'python', 'bin')}:/usr/bin:/bin`, LANG: 'C.UTF-8',
        HOME: home, BH_AGENT_WORKSPACE: workspace,
        TMPDIR: runtimeDirectory?.temporaryDirectory ?? process.env.TMPDIR,
        ...(process.env.CHROME_DEVEL_SANDBOX ? { CHROME_DEVEL_SANDBOX: process.env.CHROME_DEVEL_SANDBOX } : {}),
        PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' } });
    invariant(JSON.parse(stdout.trim()).ready === true, 'readiness returned no confirmation');
    invariant((await readdir(workspace)).length === 0, 'Harness workspace must remain empty');
    return { ready: true };
  } finally {
    try { await removeBrowserRuntimeDirectory(runtimeDirectory); }
    finally { await rm(home, { recursive: true, force: true }); }
  }
}

/** Stage first. Activation is separate for running Worker/Main update handoff. */
export async function stageBrowserRuntime({ runtimeRoot, artifact, expectedSha256, target, signal,
  readiness = checkBrowserRuntimeReadiness, activate = true, drain }) {
  const staged = await withRuntimeLock(runtimeRoot, async () => {
    const descriptor = await readBrowserRuntimeArtifact(artifact, expectedSha256);
    const versions = join(runtimeRoot, 'versions'); await privateDirectory(versions, true);
    const destination = join(versions, descriptor.manifestSha256);
    try { return await verifyInstalled(destination, descriptor.manifestSha256, target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const stage = await mkdtemp(join(versions, '.stage-'));
    const archive = join(stage, 'archive.gz');
    const unit = join(stage, 'unit'); await mkdir(unit, { mode: 0o700 });
    try {
      await collectArchive(artifact, descriptor, archive, signal);
      const manifest = await extractRuntime(archive, descriptor, unit, target, signal);
      // Empty managed workspace is structural metadata, never a shipped helper/config file.
      await privateDirectory(join(unit, 'empty-workspace'), true);
      const candidate = installedDescriptor(unit, manifest, descriptor.manifestSha256);
      invariant((await readiness(candidate, { signal }))?.ready === true, 'readiness was not confirmed');
      signal?.throwIfAborted();
      await privateJson(join(unit, 'readiness.json'), { ready: true, manifestSha256: descriptor.manifestSha256 });
      await verifyInstalled(unit, descriptor.manifestSha256, target);
      await syncUnit(unit, manifest.files);
      await rename(unit, destination); await syncDirectory(versions);
      return installedDescriptor(destination, manifest, descriptor.manifestSha256);
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
  if (!activate) return staged;
  return activateBrowserRuntime({ runtimeRoot, staged, drain, signal });
}

/** Drain closes owned leases and returns a durable compatible profile checkpoint before any cutover. */
export async function activateBrowserRuntime({ runtimeRoot, staged, drain, signal, onPrepared, transactionId = randomUUID() }) {
  invariant(typeof drain === 'function', 'activation requires the host drain callback');
  return withRuntimeLock(runtimeRoot, async () => {
    const reference = `versions/${staged.manifestSha256}`;
    invariant(resolve(staged.rootDirectory) === resolve(runtimeRoot, reference), 'foreign staged runtime');
    const installed = await verifyInstalled(staged.rootDirectory, staged.manifestSha256, staged.target);
    const previousReference = await currentReference(runtimeRoot);
    if (previousReference === reference) return { ...installed, previousReference, profileCheckpointId: null, changed: false };
    const checkpoint = await drain({ signal, current: previousReference, next: installed });
    signal?.throwIfAborted();
    if (previousReference) invariant(typeof checkpoint?.profileCheckpointId === 'string' && checkpoint.profileCheckpointId.length > 0,
      'replacement requires compatible profile checkpoint');
    const receipt = { transactionId, previousReference, nextReference: reference, profileCheckpointId: checkpoint?.profileCheckpointId ?? null,
      profileStateRoot: checkpoint?.profileStateRoot ?? null, nativeHostModule: installed.nativeHostModule, state: 'activating', changed: true };
    await privateJson(join(runtimeRoot, 'activation.json'), receipt);
    if (onPrepared) await onPrepared(receipt);
    if (previousReference) await switchRuntime(runtimeRoot, 'previous', previousReference);
    await switchRuntime(runtimeRoot, 'current', reference);
    await privateJson(join(runtimeRoot, 'activation.json'), { ...receipt, state: 'active' });
    return { ...installed, ...receipt, state: 'active' };
  });
}

/** Restore the profile checkpoint before permitting an older Chromium to open those profiles. */
export async function rollbackBrowserRuntime({ runtimeRoot, previousReference, nextReference, profileCheckpointId, drain, restoreProfiles, changed }) {
  if (changed === false) return;
  invariant(typeof drain === 'function', 'rollback requires host drain');
  return withRuntimeLock(runtimeRoot, async () => {
    const selected = await currentReference(runtimeRoot);
    if (nextReference) invariant(selected === nextReference || selected === previousReference || selected === null,
      'a different runtime transaction is selected');
    await drain();
    if (previousReference) {
      invariant(/^versions\/[a-f0-9]{64}$/.test(previousReference), 'invalid retained runtime');
      await verifyInstalled(join(runtimeRoot, previousReference), previousReference.slice('versions/'.length));
    }
    if (previousReference || profileCheckpointId) {
      invariant(profileCheckpointId && typeof restoreProfiles === 'function', 'profile rollback is unavailable');
      await restoreProfiles(profileCheckpointId);
    }
    await switchRuntime(runtimeRoot, 'current', previousReference ?? null);
    await privateJson(join(runtimeRoot, 'activation.json'), { state: 'rolled-back', previousReference, profileCheckpointId });
  });
}

/** The caller already holds stopped-host ownership; this helper never kills processes or steals leases. */
export async function offlineBrowserRuntimeLifecycle({ nativeHostModule, profileStateRoot }) {
  invariant(isAbsolute(nativeHostModule) && isAbsolute(profileStateRoot), 'private offline lifecycle locations required');
  const host = await import(pathToFileURL(nativeHostModule).href);
  invariant(typeof host.createBrowserRuntimeProfileCheckpoint === 'function'
    && typeof host.restoreBrowserRuntimeProfiles === 'function', 'native profile recovery exports unavailable');
  return {
    drain: async () => host.createBrowserRuntimeProfileCheckpoint({ profileStateRoot }),
    restoreProfiles: checkpointId => host.restoreBrowserRuntimeProfiles({ profileStateRoot, checkpointId }),
  };
}

export async function readBrowserRuntimeActivation(runtimeRoot) {
  try { return JSON.parse(await readRegularFile(join(runtimeRoot, 'activation.json'), 65536)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Keep current and compatible rollback units only after the application reports a healthy cutover. */
export async function pruneBrowserRuntimeVersions(runtimeRoot) {
  await withRuntimeLock(runtimeRoot, async () => {
    const current = await currentReference(runtimeRoot);
    const retained = new Set([current, await currentReference(runtimeRoot, 'previous')]);
    const activation = await readBrowserRuntimeActivation(runtimeRoot);
    if (current && activation?.state === 'active' && activation.nextReference === current && activation.profileStateRoot) {
      const installed = await verifyInstalled(join(runtimeRoot, current), current.slice('versions/'.length));
      const host = await import(pathToFileURL(installed.nativeHostModule).href);
      invariant(typeof host.pruneBrowserRuntimeProfiles === 'function', 'native profile retention export unavailable');
      await host.pruneBrowserRuntimeProfiles({ profileStateRoot: activation.profileStateRoot,
        retainedCheckpointIds: activation.profileCheckpointId ? [activation.profileCheckpointId] : [] });
    }
    const versions = join(runtimeRoot, 'versions');
    for (const name of await readdir(versions)) {
      if (digest.test(name) && !retained.has(`versions/${name}`)) await rm(join(versions, name), { recursive: true, force: true });
    }
    await syncDirectory(versions);
  });
}

/** Worker descriptors remain ordinary small files; large runtime bytes stay in bounded archive chunks. */
export async function stageBundledBrowserRuntime({ root, artifact, manifest, target, signal, readiness }) {
  const entry = manifest.files.find(file => file.path === 'artifacts/browser-runtime/browser-runtime.json');
  if (!entry) return null;
  return stageBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime'), artifact: join(artifact, 'artifacts/browser-runtime'),
    expectedSha256: entry.sha256, target, signal, readiness, activate: false });
}

/** Optional browser setup may fail independently of the verified core release. Cancellation is not optional. */
export async function prepareBundledBrowserRuntime(options) {
  try {
    const runtime = await stageBundledBrowserRuntime(options);
    return { runtime, failure: null };
  } catch (error) {
    options.signal?.throwIfAborted();
    return { runtime: null, failure: { reason: error.message } };
  }
}
