import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { inspectQuotaHelperAbi } from './quota-helper-abi.mjs';
import { copyBuiltBrowserRuntime } from '../apps/worker/src/browserRuntimeInstall.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';
import {
  assertWorkerSnapshotSource, rsyncWriterEntrypoint, schemaWorkerEntrypoint,
  verificationScripts, workerContractAliases, workerEntryPoints,
} from './worker-snapshot-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/worker/package.json'));
const { build } = require('esbuild');
const { parse } = require('yaml');
const { Unpackr } = require('msgpackr');
const unpacker = new Unpackr({ useRecords: true, moreTypes: true });
import {
  copySharpPackagesFromStore, copyClaudeSdkPackagesFromStore, artifactFiles, assertWorkerDependency,
  committedWorkerInputPath, workerReleaseVersion, validateWorkerTarget, assertWorkerUpdateToolchain,
} from './worker-artifact-files.mjs';
const [targetFile, outputDirectory, runtimeFile] = process.argv.slice(2);
if (!targetFile || !outputDirectory) throw new Error('Usage: build-worker-artifact.mjs apps/worker/artifacts/approved-target.json /new-output-directory [apps/worker/artifacts/reviewed-runtime.json]');
const requestedCommit = readProductEnvironment(process.env, 'WORKER_BUILD_COMMIT');
if (requestedCommit && !/^[a-f0-9]{40}$/.test(requestedCommit)) throw new Error('Invalid captured commit');
const commit = execFileSync('git', ['rev-parse', requestedCommit ? `${requestedCommit}^{commit}` : 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const snapshot = new Map();
function snapshotSource(path) {
  assertWorkerSnapshotSource(path);
  if (!snapshot.has(path)) {
    const bytes = execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const gitBlobSha1 = execFileSync('git', ['rev-parse', `${commit}:${path}`], { cwd: root, encoding: 'utf8' }).trim();
    snapshot.set(path, { bytes, gitBlobSha1, sha256: hash(bytes) });
  }
  return snapshot.get(path).bytes;
}
async function requirePinnedSource(path) {
  if (!snapshotSource(path).equals(await readFile(join(root, path)))) throw new Error(`Uncommitted build control input: ${path}`);
}
for (const path of ['scripts/build-worker-artifact.mjs', 'scripts/worker-artifact-files.mjs', 'packages/contracts/package.json', 'packages/contracts/src/productEnvironment.mjs', 'apps/worker/package.json', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) await requirePinnedSource(path);
await requirePinnedSource('scripts/quota-helper-abi.mjs');
await requirePinnedSource('scripts/worker-snapshot-policy.mjs');
await requirePinnedSource('apps/worker/artifacts/licenses/cfworker.txt');
function reviewedInput(input) {
  const path = committedWorkerInputPath(root, input);
  let bytes;
  try {
    bytes = snapshotSource(path);
  } catch (error) {
    throw new Error(`Reviewed input ${path} must exist in captured commit ${commit}. Commit and review it before building.`,
      { cause: error });
  }
  return { path, value: JSON.parse(bytes.toString('utf8')) };
}
assertWorkerUpdateToolchain(JSON.parse(snapshotSource('package.json')));
const targetInput = reviewedInput(targetFile);
const target = targetInput.value;
validateWorkerTarget(target);
const runtimeInput = runtimeFile ? reviewedInput(runtimeFile) : null;
const runtime = runtimeInput?.value;
if (runtime && (runtime.format !== 1 || runtime.runtime !== 'node' || runtime.platform !== 'linux' || runtime.arch !== target.arch || runtime.version !== target.node
  || !/^[a-f0-9]{64}$/.test(runtime.archive?.sha256) || !/^[a-f0-9]{64}$/.test(runtime.nodeExecutable?.sha256)
  || !/^[A-F0-9]{40}$/.test(runtime.trustedRelease?.primarySignerFingerprint))) throw new Error('Reviewed runtime does not match target');
// Fresh directories only: never mix files from another release or ship credentials.
const output = resolve(outputDirectory); await mkdir(output, { mode: 0o700 }); await mkdir(join(output, 'src'));
const buildOptions = { absWorkingDir: root, outdir: join(output, 'src'), outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true, sourcemap: false, packages: 'bundle', external: ['sharp'],
  alias: workerContractAliases(JSON.parse(snapshotSource('packages/contracts/package.json')).exports),
  plugins: [{ name: 'committed-source-snapshot', setup(builder) {
    builder.onResolve({ filter: /.*/ }, input => { assertWorkerDependency(input.path); });
    builder.onLoad({ filter: /\.(?:[cm]?[jt]s|json)$/ }, (input) => {
      const path = relative(root, input.path);
      if (path.startsWith('node_modules/') || path.includes('/node_modules/')) return;
      return { contents: snapshotSource(path).toString('utf8'), loader: path.endsWith('.json') ? 'json' : path.endsWith('ts') ? 'ts' : 'js', resolveDir: dirname(input.path) };
    });
  } }],
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
  banner: { js: "import { createRequire as workerCreateRequire } from 'node:module'; const require = workerCreateRequire(import.meta.url);" } };
const built = await build({ ...buildOptions, entryPoints: workerEntryPoints });
if (rsyncWriterEntrypoint in built.metafile.inputs) throw new Error('Standalone rsync writer imported by normal worker graph');
const writer = await build({ ...buildOptions, entryPoints: { 'rsync-writer': rsyncWriterEntrypoint } });
const schemaWorker = await build({ ...buildOptions,
  entryPoints: { schemaWorker: schemaWorkerEntrypoint } });
for (const source of new Set([...Object.keys(built.metafile.inputs), ...Object.keys(writer.metafile.inputs), ...Object.keys(schemaWorker.metafile.inputs)])) {
  if (!source.startsWith('node_modules/') && !source.includes('/node_modules/')) snapshotSource(source);
}
for (const entry of [...Object.values(built.metafile.outputs), ...Object.values(writer.metafile.outputs), ...Object.values(schemaWorker.metafile.outputs)]) for (const dependency of entry.imports) {
  if (dependency.external && !isBuiltin(dependency.path) && dependency.path !== 'sharp') throw new Error(`Unbundled dependency: ${dependency.path}`);
}
for (const name of ['installation.mjs', 'diagnostics.mjs', 'service.mjs', 'install-cli.mjs', 'runtime.mjs', 'setup.mjs', 'companion.mjs', 'setupInput.mjs', 'companionServer.mjs', 'companionService.mjs', 'companionLauncher.mjs', 'harnessPath.mjs',
  'updateSupervisor.mjs', 'update-supervisor-cli.mjs', 'updateOperation.mjs', 'ciSmokeTiming.mjs', 'browserRuntimeInstall.mjs', 'browserRuntime.mjs', 'browserDeviceExtension.mjs']) {
  await writeFile(join(output, 'src', name), snapshotSource(`apps/worker/src/${name}`), { mode: 0o600 });
}
await mkdir(join(output, 'artifacts'));
const quotaQuerySource = 'apps/worker/artifacts/job-quota-query.c';
const quotaQueryPath = join(output, 'artifacts/job-quota-query.c');
await writeFile(quotaQueryPath, snapshotSource(quotaQuerySource), { mode: 0o600 });
execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', quotaQueryPath,
  '-o', join(output, 'artifacts/job-quota-query')], { stdio: ['ignore', 'pipe', 'pipe'] });
await inspectQuotaHelperAbi(join(output, 'artifacts/job-quota-query'), target);

await writeFile(join(output, 'artifacts/graphql.svg'), snapshotSource('apps/web/public/graphql.svg'), { mode: 0o600 });
await writeFile(join(output, 'artifacts/graphql-mcp.mjs'), snapshotSource('scripts/graphql-mcp.mjs'), { mode: 0o600 });
await writeFile(join(output, 'artifacts/graphql-worker.service.in'), snapshotSource('apps/worker/artifacts/graphql-worker.service.in'), { mode: 0o600 });
await writeFile(join(output, 'artifacts/companion.html'), snapshotSource('apps/worker/artifacts/companion.html'), { mode: 0o600 });
const ciRuntimeControls = ['Containerfile', 'corepack', 'context.mjs', 'seed-policy.mjs', 'verification-policy.mjs', 'verification-observation.mjs'];
await mkdir(join(output, 'artifacts/ci-runtime'));
for (const name of ciRuntimeControls) {
  await writeFile(join(output, 'artifacts/ci-runtime', name), snapshotSource(`apps/worker/artifacts/ci-runtime/${name}`),
    { mode: name === 'corepack' ? 0o700 : 0o600 });
}
const committedScripts = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', ...verificationScripts],
  { cwd: root, encoding: 'utf8' }).trim().split('\n'));
if (verificationScripts.every(path => committedScripts.has(path))) {
  await mkdir(join(output, 'artifacts/verification'));
  for (const path of verificationScripts) {
    await writeFile(join(output, 'artifacts/verification', path.slice('scripts/'.length)), snapshotSource(path), { mode: 0o600 });
  }
  for (const path of ['apps/worker/src/diagnostics.mjs', 'packages/contracts/src/verificationEnvironment.mjs',
    'packages/contracts/src/integrationScheduling.mjs']) {
    const destination = join(output, 'artifacts', path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, snapshotSource(path), { mode: 0o600 });
  }
}
await writeFile(join(output, 'install'), snapshotSource('apps/worker/artifacts/install.sh.in').toString('utf8').replaceAll('@NODE_VERSION@', target.node), { mode: 0o700 });
if (runtime) await writeFile(join(output, 'artifacts/node-runtime.json'), snapshotSource(runtimeInput.path), { mode: 0o600 });
const { storeDir: store } = parse(await readFile(join(root, 'node_modules/.modules.yaml'), 'utf8'));
const nativePackages = await copySharpPackagesFromStore({
  root,
  output,
  store,
  lock: parse(snapshotSource('pnpm-lock.yaml').toString('utf8')),
  decode: blob => unpacker.unpack(blob),
});
const runtimePackages = await copyClaudeSdkPackagesFromStore({
  root, output, store, lock: parse(snapshotSource('pnpm-lock.yaml').toString('utf8')),
  decode: blob => unpacker.unpack(blob),
});
const releaseVersion = workerReleaseVersion(JSON.parse(snapshotSource('package.json').toString('utf8')));
let browserRuntime;
let browserRuntimeStatus;
try {
  browserRuntime = await copyBuiltBrowserRuntime({ directory: process.env.FOREMAN_CODE_BROWSER_RUNTIME_ARTIFACTS,
    commit, target, output: join(output, 'artifacts/browser-runtime') });
  browserRuntimeStatus = { state: 'ready', retryable: false, reason: null };
} catch (error) {
  browserRuntimeStatus = { state: 'failed', retryable: true, reason: error.message };
  console.warn(`Core Worker artifact built; browser runtime unavailable: ${error.message}`);
}
const files = await artifactFiles(output);
if (files.length > 512 || files.some(file => file.size > 64 * 1024 * 1024)) {
  throw new Error('Worker artifact exceeds its existing ordinary package limits. Browser runtime chunks must remain separate and bounded.');
}
const manifest = { format: 1, version: releaseVersion, commit, lockfileSha256: hash(snapshotSource('pnpm-lock.yaml')), packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target, nativePackages, runtimePackages, workerApiModules: Object.keys(built.metafile.inputs).filter(path => path.startsWith('apps/api/')).sort(), rsyncWriterApiModules: Object.keys(writer.metafile.inputs).filter(path => path.startsWith('apps/api/')).sort(), sourceSnapshot: { commit, files: [...snapshot.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, { gitBlobSha1, sha256 }]) => ({ path, gitBlobSha1, sha256 })) },
  browserRuntimeStatus,
  ...(browserRuntime ? { browserRuntime: { descriptorPath: 'artifacts/browser-runtime/browser-runtime.json', descriptorSha256: browserRuntime.descriptorSha256,
    manifestSha256: browserRuntime.descriptor.manifestSha256, sourceInputs: browserRuntime.descriptor.sourceInputs } } : {}),
  ...(runtime ? { runtime: { metadataPath: 'artifacts/node-runtime.json', version: runtime.version, archiveSha256: runtime.archive.sha256, executableSha256: runtime.nodeExecutable.sha256, qualification: 'future installation requires actual target readback' } } : {}), files };
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ manifestSha256: hash(await readFile(join(output, 'manifest.json'))), version: releaseVersion, commit: manifest.commit, files: files.length }));
