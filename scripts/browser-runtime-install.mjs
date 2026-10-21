import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BROWSER_RUNTIME_MAGIC, BROWSER_RUNTIME_CHUNK_BYTES, hashBrowserRuntimeFile,
  validateBrowserRuntimeManifest, checkBrowserRuntimeReadiness, createBrowserRuntimeDirectory,
  removeBrowserRuntimeDirectory } from '../apps/worker/src/browserRuntimeInstall.mjs';
import { validateWorkerTarget } from './worker-artifact-files.mjs';
import { assertWorkerSnapshotSource, workerContractAliases } from './worker-snapshot-policy.mjs';

const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const controls = new Set(['runtime/browser/manifest.json', 'runtime/browser/runtime-lock.json', 'runtime/browser/LICENSES.txt',
  'scripts/browser-runtime-install.mjs', 'apps/worker/src/browserRuntimeInstall.mjs', 'scripts/worker-artifact-files.mjs',
  'scripts/worker-snapshot-policy.mjs', 'runtime/browser/licenses/MIT.txt', 'runtime/browser/credits.py', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/contracts/package.json']);
const safePath = path => typeof path === 'string' && /^[a-zA-Z0-9_@.+/[\]-]+$/.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..');
const invariant = (condition, message) => { if (!condition) throw new Error(`Browser runtime assembly: ${message}`); };

async function sourceSnapshot(repository, commit, run) {
  invariant(/^[a-f0-9]{40}$/.test(commit), 'exact source commit required');
  const files = new Map();
  const read = async path => {
    if (!controls.has(path)) assertWorkerSnapshotSource(path);
    if (files.has(path)) return files.get(path).bytes;
    const result = await run('git', ['show', `${commit}:${path}`], { cwd: repository, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    const bytes = Buffer.from(result.stdout);
    const { stdout } = await run('git', ['rev-parse', `${commit}:${path}`], { cwd: repository });
    files.set(path, { bytes, path, gitBlobSha1: String(stdout).trim(), sha256: sha256(bytes) });
    return bytes;
  };
  for (const path of controls) {
    invariant((await read(path)).equals(await readFile(join(repository, path))), `uncommitted control input ${path}`);
  }
  return { read, entries: () => [...files.values()].map(({ path, gitBlobSha1, sha256 }) => ({ path, gitBlobSha1, sha256 }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}

async function requireNativeTarget(target) {
  validateWorkerTarget(target);
  const osRelease = await readFile('/etc/os-release', 'utf8');
  const values = Object.fromEntries(osRelease.split('\n').filter(line => /^[A-Z_]+=/.test(line))
    .map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, '')]; }));
  invariant(values.ID === target.os && values.VERSION_ID === target.osRelease && process.arch === target.arch
    && process.version === target.node && `glibc-${process.report.getReport().header.glibcVersionRuntime}` === target.libc,
  'build on the exact committed supported target; cross-building is not qualified');
}

export async function downloadBrowserRuntimeArtifact(url, destination, expected, fetchArtifact = globalThis.fetch) {
  invariant(digest.test(expected ?? ''), 'expected artifact digest required');
  invariant(new URL(url).protocol === 'https:', 'invalid artifact URL');
  const response = await fetchArtifact(url, { redirect: 'follow' });
  invariant(response.ok && response.body, `artifact unavailable (${response.status})`);
  const handle = await open(destination, 'wx', 0o600), hash = createHash('sha256');
  let size = 0;
  try {
    for await (const value of response.body) {
      const bytes = Buffer.from(value); size += bytes.length;
      invariant(size <= 2 * 1024 ** 3, 'artifact too large');
      hash.update(bytes); await handle.writeFile(bytes);
    }
    const sha256 = hash.digest('hex');
    invariant(sha256 === expected, 'upstream artifact checksum mismatch');
    await handle.sync(); return { url, sha256, size };
  } finally { await handle.close(); }
}

async function extractPinnedPython({ archive, unit, run }) {
  // The executable archive is checksum-pinned before extraction; no untrusted user archives enter this build path.
  const { stdout } = await run('tar', ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 });
  for (const entry of String(stdout).trim().split('\n')) {
    invariant(entry.startsWith('python/') && safePath(entry.replace(/\/$/, '')), 'unsafe Python archive entry');
  }
  await run('tar', ['--extract', '--gzip', '--file', archive, '--directory', unit, '--no-same-owner', '--no-same-permissions']);
}

async function extractChromium(python, archive, destination, run) {
  const script = `import os,pathlib,stat,sys,zipfile
root=pathlib.Path(sys.argv[2]); root.mkdir(mode=0o700)
with zipfile.ZipFile(sys.argv[1]) as archive:
 for item in archive.infolist():
  parts=pathlib.PurePosixPath(item.filename).parts
  assert parts and not item.filename.startswith('/') and all(part not in ['.','..'] for part in parts) and '\\\\' not in item.filename
  assert not stat.S_ISLNK(item.external_attr >> 16)
  path=root.joinpath(*parts)
  if item.is_dir(): path.mkdir(mode=0o700,parents=True,exist_ok=True); continue
  path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
  with archive.open(item) as source, path.open('xb') as output:
   while chunk:=source.read(1048576): output.write(chunk)
  path.chmod(0o700 if item.external_attr >> 16 & 0o111 else 0o600)
`;
  await run(python, ['-I', '-B', '-c', script, archive, destination], { maxBuffer: 65536 });
}

async function resolvePythonLock({ python, inputs, target, temporary, previous, run }) {
  if (previous) {
    invariant(previous.format === 1 && previous.kind === 'foreman-browser-resolved-lock'
      && JSON.stringify(previous.target) === JSON.stringify(target) && previous.python.sha256 === inputs.python.sha256
      && previous.chromium.version === inputs.chromium.version && previous.chromium.sha256 === inputs.chromium.sha256,
    'incompatible resolved lock');
    return previous;
  }
  const report = join(temporary, 'pip-report.json');
  const requirements = inputs.packages.map(item => `${item.name}==${item.version}`);
  await run(python, ['-I', '-B', '-m', 'pip', '--isolated', 'install', '--dry-run', '--ignore-installed', '--only-binary=:all:',
    '--disable-pip-version-check', '--report', report, '--index-url', 'https://pypi.org/simple', ...requirements],
  { timeout: 600000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PIP_CONFIG_FILE: '/dev/null' } });
  const resolved = JSON.parse(await readFile(report, 'utf8'));
  invariant(resolved.version === '1' && typeof resolved.pip_version === 'string' && Array.isArray(resolved.install), 'invalid resolver report');
  const packages = resolved.install.map(item => ({ name: item.metadata.name, version: item.metadata.version,
    url: item.download_info.url, sha256: item.download_info.archive_info.hashes.sha256,
    filename: decodeURIComponent(basename(new URL(item.download_info.url).pathname)) }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { format: 1, kind: 'foreman-browser-resolved-lock', target, resolver: `pip==${resolved.pip_version}`,
    python: inputs.python, chromium: inputs.chromium, packages };
}

function validateWheelClosure(lock, inputs) {
  invariant(lock.packages.length > 0 && lock.packages.length <= 1000, 'invalid resolved wheel count');
  const names = new Set();
  for (const item of lock.packages) {
    const name = item.name.toLowerCase().replace(/[-_.]+/g, '-');
    invariant(!names.has(name) && /^[a-zA-Z0-9_.+-]+$/.test(item.version) && safePath(item.filename)
      && !item.filename.includes('/') && item.filename.endsWith('.whl') && digest.test(item.sha256)
      && new URL(item.url).protocol === 'https:', 'invalid locked wheel');
    names.add(name);
  }
  for (const required of inputs.packages) {
    const selected = lock.packages.find(item => item.name.toLowerCase().replace(/[-_.]+/g, '-') === required.name);
    invariant(selected?.version === required.version && selected.sha256 === required.wheelSha256, `unpublished or altered ${required.name} wheel`);
  }
}

async function installLockedWheels({ lock, inputs, python, wheelhouse, unit, licenseTexts, fetchArtifact, run }) {
  validateWheelClosure(lock, inputs);
  await mkdir(wheelhouse, { mode: 0o700 });
  for (const wheel of lock.packages) await downloadBrowserRuntimeArtifact(wheel.url, join(wheelhouse, wheel.filename), wheel.sha256, fetchArtifact);
  const requirements = join(wheelhouse, 'requirements.lock');
  await writeFile(requirements, lock.packages.map(item => `${item.name}==${item.version} --hash=sha256:${item.sha256}`).sort().join('\n') + '\n', { mode: 0o600 });
  await run(python, ['-I', '-B', '-m', 'pip', '--isolated', 'install', '--no-index', '--no-compile', '--require-hashes',
    '--only-binary=:all:', '--find-links', wheelhouse, '--requirement', requirements, '--disable-pip-version-check'],
  { timeout: 600000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PIP_CONFIG_FILE: '/dev/null' } });
  await run(python, ['-I', '-B', '-m', 'pip', '--isolated', 'check'], { timeout: 60000, maxBuffer: 65536 });
  await copyFile(requirements, join(unit, 'requirements.lock'));
  const script = `import email,json,pathlib,sys,zipfile
root=pathlib.Path(sys.argv[2]); root.mkdir(mode=0o700,parents=True)
inventory=[]; license_texts=json.loads(sys.argv[3])
for wheel in sorted(pathlib.Path(sys.argv[1]).glob('*.whl')):
 with zipfile.ZipFile(wheel) as archive:
  metadata_name=next(name for name in archive.namelist() if name.endswith('.dist-info/METADATA'))
  metadata=archive.read(metadata_name); parsed=email.message_from_bytes(metadata)
  prefix=parsed['Name']+'-'+parsed['Version']; directory=root/prefix; directory.mkdir(mode=0o700)
  (directory/'METADATA').write_bytes(metadata)
  notices=[name for name in archive.namelist() if not name.endswith('/') and any(part.lower().startswith(('license','licence','copying','notice')) for part in pathlib.PurePosixPath(name).parts)]
  files=['METADATA']; source={'kind':'wheel'}
  for index,name in enumerate(notices):
   filename=str(index)+'-'+pathlib.PurePosixPath(name).name
   (directory/filename).write_bytes(archive.read(name)); files.append(filename)
  if not notices and len(parsed.get('License',''))<=100:
   expression=(parsed.get('License-Expression') or parsed.get('License','')).strip()
   terms=license_texts.get(expression)
   assert terms, 'Missing license text: '+prefix+' ('+expression+')'
   (directory/'LICENSE.txt').write_text(terms['text']); files.append('LICENSE.txt')
   source={'kind':'spdx','expression':expression,'url':terms['url'],'sha256':terms['sha256']}
  inventory.append({'package':prefix,'files':files,'licenseSource':source})
(root/'index.json').write_text(json.dumps(inventory,indent=2)+'\\n')
`;
  await run(python, ['-I', '-B', '-c', script, wheelhouse, join(unit, 'licenses/python-packages'), JSON.stringify(licenseTexts)], { maxBuffer: 65536 });
}

/** Runtime supports the managed Python/module interface only, never pip-generated console launchers. */
export async function normalizeBrowserPythonEntrypoints({ python, unit, run = execute }) {
  const script = `import csv,io,json,pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve(); binary=root/'python'/'bin'
for path in sorted(binary.iterdir()):
 if path.name not in ('python','python3','python3.13'):
  assert path.is_file() or path.is_symlink(), 'Unexpected Python entrypoint directory'
  path.unlink()
for info in sorted((root/'python').glob('lib/python*/site-packages/*.dist-info')):
 direct=info/'direct_url.json'
 if direct.exists() and json.loads(direct.read_text()).get('url','').startswith('file:'): direct.unlink()
 record=info/'RECORD'
 if not record.exists(): continue
 rows=[]
 for row in csv.reader(io.StringIO(record.read_text())):
  target=(info.parent/row[0]).resolve()
  if not target.exists(): continue
  if target==record.resolve(): row=[row[0],'','']
  rows.append(row)
 output=io.StringIO(newline=''); writer=csv.writer(output,lineterminator='\\n')
 writer.writerows(sorted(rows,key=lambda row:row[0])); record.write_text(output.getvalue())
`;
  await run(python, ['-I', '-B', '-c', script, unit], { timeout: 60000, maxBuffer: 65536 });
}

export async function copyNativeLicenses(inputs, repository, unit) {
  const seen = new Set();
  for (const input of inputs.filter(path => path.includes('node_modules/'))) {
    let directory = dirname(resolve(repository, input)), manifest;
    for (;;) {
      try {
        manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (typeof manifest.name === 'string' && typeof manifest.version === 'string') break;
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      invariant(basename(directory) !== 'node_modules' && dirname(directory) !== directory,
        `native dependency package metadata missing: ${input}`);
      directory = dirname(directory);
    }
    if (seen.has(directory)) continue;
    seen.add(directory);
    const name = `${manifest.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${manifest.version}`;
    const destination = join(unit, 'licenses/native-packages', name); await mkdir(destination, { recursive: true, mode: 0o700 });
    const licenses = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(name));
    invariant(licenses.length > 0, `native dependency notice missing: ${manifest.name}`);
    for (const path of licenses) if ((await lstat(join(directory, path))).isFile()) await copyFile(join(directory, path), join(destination, path));
    await writeFile(join(destination, 'package.json'), `${JSON.stringify({ name: manifest.name, version: manifest.version, license: manifest.license }, null, 2)}\n`);
  }
}

async function bundleNativeHost({ repository, unit, snapshot }) {
  const require = createRequire(join(repository, 'apps/worker/package.json')), { build } = require('esbuild');
  const exports = JSON.parse(await snapshot.read('packages/contracts/package.json')).exports;
  const result = await build({ absWorkingDir: repository, entryPoints: ['apps/api/src/modules/browser-runtime/hostFactory.ts'],
    outfile: join(unit, 'native-host.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true,
    legalComments: 'linked', sourcemap: false, alias: workerContractAliases(exports),
    define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
    banner: { js: "import { createRequire as runtimeRequire } from 'node:module'; const require = runtimeRequire(import.meta.url);" },
    plugins: [{ name: 'browser-runtime-exact-source', setup(builder) {
      builder.onLoad({ filter: /\.(?:[cm]?[jt]s|json)$/ }, async input => {
        const path = relative(repository, input.path);
        if (path.includes('node_modules/')) return;
        const contents = await snapshot.read(path);
        return { contents: contents.toString('utf8'), loader: path.endsWith('.ts') ? 'ts' : path.endsWith('.json') ? 'json' : 'js', resolveDir: dirname(input.path) };
      });
    } }] });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) invariant(!dependency.external || isBuiltin(dependency.path), `unbundled native module ${dependency.path}`);
  }
  await copyNativeLicenses(Object.keys(result.metafile.inputs), repository, unit);
}

async function listUnitFiles(directory) {
  const root = await realpath(directory), files = [];
  async function walk(path, prefix, ancestors) {
    const actual = await realpath(path);
    invariant(actual === root || actual.startsWith(`${root}/`), 'unit symlink escaped private root');
    const info = await lstat(actual);
    if (info.isDirectory()) {
      invariant(!ancestors.has(actual), 'unit directory cycle');
      const next = new Set(ancestors); next.add(actual);
      await chmod(actual, 0o700);
      for (const name of (await readdir(actual)).sort()) {
        if (name === '__pycache__' || name.endsWith('.pyc')) { await rm(join(actual, name), { recursive: true, force: true }); continue; }
        await walk(join(actual, name), prefix ? `${prefix}/${name}` : name, next);
      }
    } else {
      invariant(info.isFile() && safePath(prefix), `unit contains a nonregular or unsafe file: ${JSON.stringify({
        path: prefix, regular: info.isFile(),
      })}`);
      const mode = info.mode & 0o111 ? 0o700 : 0o600;
      await chmod(actual, mode);
      files.push({ path: prefix, ...await hashBrowserRuntimeFile(actual), mode, source: actual });
    }
  }
  await walk(root, '', new Set());
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Exported artifact packer also accepts tiny fixture units through its public interface. */
export async function packBrowserRuntime({ unit, output, manifest, outputOwned = false, onProgress }) {
  const files = await listUnitFiles(unit);
  onProgress?.('runtime-inventory-hashed');
  manifest = validateBrowserRuntimeManifest({ ...manifest, files: files.map(({ source, ...file }) => file) }, manifest.target);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  if (!outputOwned) await mkdir(output, { mode: 0o700 });
  const archive = join(output, '.runtime.gz');
  async function* payload() {
    yield Buffer.from(BROWSER_RUNTIME_MAGIC); yield length; yield bytes;
    for (const file of files) for await (const chunk of createReadStream(file.source)) yield chunk;
  }
  try {
    await pipeline(Readable.from(payload()), createGzip({ level: 6 }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    onProgress?.('runtime-compressed');
    const identity = await hashBrowserRuntimeFile(archive), handle = await open(archive, 'r'), chunks = [];
    try {
      let offset = 0;
      while (offset < identity.size) {
        const bytes = Buffer.alloc(Math.min(BROWSER_RUNTIME_CHUNK_BYTES, identity.size - offset));
        const read = await handle.read(bytes, 0, bytes.length, offset); invariant(read.bytesRead === bytes.length, 'truncated assembled archive');
        const path = `chunk-${String(chunks.length).padStart(6, '0')}.bin`;
        await writeFile(join(output, path), bytes, { flag: 'wx', mode: 0o600 });
        chunks.push({ path, size: bytes.length, sha256: sha256(bytes) }); offset += bytes.length;
      }
    } finally { await handle.close(); }
    invariant(chunks.length <= 256, 'runtime unit exceeds bounded chunk inventory');
    const descriptor = { format: 1, kind: 'foreman-browser-runtime-artifact', target: manifest.target,
      runtimeVersion: manifest.runtimeVersion, sourceCommit: manifest.sourceCommit, sourceInputs: manifest.sourceInputs,
      archiveSha256: identity.sha256, compressedBytes: identity.size, manifestSha256: sha256(bytes), chunks };
    const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
    await writeFile(join(output, 'browser-runtime.json'), descriptorBytes, { flag: 'wx', mode: 0o600 });
    return { descriptor, descriptorSha256: sha256(descriptorBytes), manifest };
  } finally { await rm(archive, { force: true }); }
}

export async function collectChromiumNotices(chromium, unit, temporary, run) {
  const runtimeDirectory = await createBrowserRuntimeDirectory(temporary);
  try {
  const { stdout, stderr } = await run(join(unit, 'python/bin/python3'), ['-I', '-B', join(unit, 'credits.py'),
    chromium, '--headless=new', '--allow-chrome-scheme-url', '--no-first-run', '--disable-background-networking', '--disable-component-update',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${join(temporary, 'credits-profile')}`, 'chrome://credits/'], { timeout: 60000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, TMPDIR: runtimeDirectory?.temporaryDirectory ?? process.env.TMPDIR } });
  invariant(String(stdout).length > 1000 && /license|copyright/i.test(String(stdout)),
    `Chromium credits unavailable: ${JSON.stringify({ bytes: Buffer.byteLength(String(stdout)),
      page: String(stdout).slice(0, 300), stderr: String(stderr ?? '').slice(-1500) })}`);
  await mkdir(join(unit, 'licenses'), { recursive: true, mode: 0o700 });
  await writeFile(join(unit, 'licenses/chromium-credits.html'), stdout, { mode: 0o600 });
  } finally { await removeBrowserRuntimeDirectory(runtimeDirectory); }
}

/** Deliberate release assembly only. Startup/install consume its locked immutable output. */
export async function assembleBrowserRuntime({ repository, commit, target, foremanVersion, output, resolvedLock,
  run = execute, fetchArtifact = globalThis.fetch, readiness = checkBrowserRuntimeReadiness, onProgress }) {
  // Reservation happens before any cleanup scope. An existing destination is never owned or deleted here.
  await mkdir(output, { mode: 0o700 });
  let temporary;
  try {
  await requireNativeTarget(target);
  const snapshot = await sourceSnapshot(repository, commit, run);
  const recipe = JSON.parse(await snapshot.read('runtime/browser/manifest.json'));
  const inputs = JSON.parse(await snapshot.read('runtime/browser/runtime-lock.json'));
  invariant(recipe.kind === 'foreman-browser-runtime-recipe' && inputs.kind === 'foreman-browser-build-inputs', 'invalid source recipe');
  temporary = await mkdtemp(join(dirname(resolve(output)), '.browser-build-'));
  const unit = join(temporary, 'unit'); await mkdir(unit, { mode: 0o700 });
    const pythonArchive = join(temporary, 'python.tar.gz');
    await downloadBrowserRuntimeArtifact(inputs.python.url, pythonArchive, inputs.python.sha256, fetchArtifact);
    await extractPinnedPython({ archive: pythonArchive, unit, run });
    onProgress?.('python-extracted');
    const python = join(unit, 'python/bin/python3');
    const lock = await resolvePythonLock({ python, inputs, target, temporary, previous: resolvedLock, run });
    const licenseTexts = {};
    for (const [expression, entry] of Object.entries(inputs.licenseTexts)) {
      const bytes = await snapshot.read(entry.path);
      invariant(sha256(bytes) === entry.sha256, `license text checksum mismatch: ${expression}`);
      licenseTexts[expression] = { ...entry, text: bytes.toString('utf8') };
    }
    await installLockedWheels({ lock, inputs, python, licenseTexts, wheelhouse: join(temporary, 'wheels'), unit, fetchArtifact, run });
    await normalizeBrowserPythonEntrypoints({ python, unit, run });
    onProgress?.('python-dependencies-installed');
    const chromiumArchive = join(temporary, 'chromium.zip');
    const chromium = await downloadBrowserRuntimeArtifact(inputs.chromium.url, chromiumArchive,
      resolvedLock?.chromium.sha256 ?? inputs.chromium.sha256, fetchArtifact);
    lock.chromium = { ...inputs.chromium, ...chromium };
    await extractChromium(python, chromiumArchive, join(unit, 'chromium'), run);
    onProgress?.('chromium-extracted');
    await writeFile(join(unit, 'bridge.py'), await snapshot.read(recipe.bridgeSource), { mode: 0o600 });
    await writeFile(join(unit, 'browser-use.md'), await snapshot.read(recipe.skillSource), { mode: 0o600 });
    await bundleNativeHost({ repository, unit, snapshot });
    await writeFile(join(unit, 'credits.py'), await snapshot.read('runtime/browser/credits.py'), { mode: 0o600 });
    await collectChromiumNotices(join(unit, 'chromium/chrome-linux64/chrome'), unit, temporary, run);
    onProgress?.('host-and-browser-notices-built');
    const pythonNotices = (await listUnitFiles(join(unit, 'python'))).filter(file => /(?:license|licence|copying|notice)/i.test(file.path));
    invariant(pythonNotices.length > 0, 'standalone Python notices missing');
    await writeFile(join(unit, 'LICENSES.txt'), (await snapshot.read('runtime/browser/LICENSES.txt')).toString()
      + '\nBundled notice inventory:\nlicenses/chromium-credits.html\nlicenses/python-packages/index.json\nlicenses/native-packages/\n'
      + pythonNotices.map(file => `python/${file.path}`).join('\n') + '\n', { mode: 0o600 });
    lock.nativeDependencyLockSha256 = sha256(await snapshot.read('pnpm-lock.yaml'));
    const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
    await writeFile(join(unit, 'runtime-lock.json'), lockBytes, { mode: 0o600 });
    onProgress?.('dependency-notices-indexed');
    const manifest = { format: 1, kind: 'foreman-browser-runtime', runtimeVersion: recipe.runtimeVersion, foremanVersion,
      profileFormat: recipe.profileFormat, target, sourceCommit: commit, sourceInputs: snapshot.entries(),
      pythonVersion: recipe.pythonVersion, browserUseVersion: recipe.browserUseVersion, browserHarnessVersion: recipe.browserHarnessVersion,
      chromiumVersion: recipe.chromiumVersion, chromiumRevision: recipe.chromiumRevision,
      pythonEntrypointPolicy: 'managed-python-module-only',
      resolvedLockSha256: sha256(lockBytes), pythonExecutable: 'python/bin/python3', chromiumExecutable: 'chromium/chrome-linux64/chrome',
      bridgeScript: 'bridge.py', nativeHostModule: 'native-host.mjs', skill: 'browser-use.md' };
    await writeFile(join(unit, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    invariant((await readiness({ rootDirectory: unit, pythonExecutable: python,
      chromiumExecutable: join(unit, manifest.chromiumExecutable) }))?.ready === true, 'runtime readiness was not confirmed');
    onProgress?.('runtime-readiness-verified');
    await rm(join(unit, 'manifest.json'));
    const result = await packBrowserRuntime({ unit, output, manifest, outputOwned: true, onProgress });
    onProgress?.('runtime-packed');
    await writeFile(join(output, 'resolved-lock.json'), lockBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(join(output, 'index.json'), `${JSON.stringify({ format: 1, sourceCommit: commit,
      artifacts: [{ directory: '.', target, descriptorSha256: result.descriptorSha256 }] })}\n`, { flag: 'wx', mode: 0o600 });
    return result;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, targetFile, output, lockFile] = process.argv.slice(2);
  invariant(command === 'assemble' && targetFile && output, 'usage: browser-runtime-install.mjs assemble <approved-target.json> <new-output-directory> [resolved-lock.json]');
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { stdout } = await execute('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const commit = String(stdout).trim();
  const target = JSON.parse(await readFile(resolve(repository, targetFile), 'utf8'));
  const foremanVersion = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version;
  const result = await assembleBrowserRuntime({ repository, commit, target, foremanVersion, output: resolve(output),
    ...(lockFile ? { resolvedLock: JSON.parse(await readFile(resolve(lockFile), 'utf8')) } : {}) });
  process.stdout.write(`${JSON.stringify({ descriptorSha256: result.descriptorSha256, manifestSha256: result.descriptor.manifestSha256 })}\n`);
}
