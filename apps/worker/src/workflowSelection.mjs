import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { openPrivateRoot, anchored } from '../../../apps/api/src/modules/sources/privateFilesystem.ts';
import { readInstalledWorkflowConfiguration, InstalledWorkflowConfigurationSchema }
  from '../../../apps/api/src/modules/runs/remote/installedWorkflowConfiguration.ts';
import { passiveDriverPayloads } from '../../../apps/api/src/modules/harnesses/payloadDiscovery.ts';
import { inventoryPayloadFingerprints } from '../../../apps/api/src/modules/harnesses/payloadFingerprintCache.ts';
import { discoverInstalledClaudeSdk } from '../../../apps/api/src/modules/harnesses/claudeSdk/currentPin.ts';
import { publishManagedJson, managedEntryExists } from './managedState.mjs';
import { WorkerError } from './diagnostics.mjs';
import { workerPath } from './harnessPath.mjs';

const releaseDirectory = fileURLToPath(new URL('../', import.meta.url));
const observedVersions = new Map();

async function executable(name, environment) {
  for (const directory of (environment.PATH ?? '').split(':').filter(path => path.startsWith('/'))) {
    try {
      const path = await realpath(join(directory, name));
      await access(path, constants.X_OK);
      return path;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return null;
}

async function codexSelection(environment, signal) {
  const launcher = await executable('codex', environment);
  if (!launcher) return null;
  const image = await passiveDriverPayloads('codex', launcher);
  let binary = launcher;
  let payloadPaths = image.paths;
  if (!image.complete) {
    const packageDirectory = dirname(dirname(launcher));
    const manifest = join(packageDirectory, 'package.json');
    const metadata = JSON.parse(await readFile(manifest, 'utf8'));
    if (metadata.name !== '@openai/codex') return null;
    const requireLauncher = createRequire(launcher);
    const packageName = `@openai/codex-${process.platform}-${process.arch}`;
    let vendor;
    try { vendor = join(dirname(requireLauncher.resolve(`${packageName}/package.json`)), 'vendor'); }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      vendor = join(packageDirectory, 'vendor');
    }
    const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    binary = await realpath(join(vendor, `${architecture}-unknown-linux-musl`, 'bin/codex'));
    if (!(await passiveDriverPayloads('codex', binary)).complete) return null;
    await access(binary, constants.X_OK);
    payloadPaths = [launcher, manifest];
  } else if (image.paths.length) {
    binary = image.paths[0];
    payloadPaths = [launcher];
  }
  const expectedVersion = await codexVersion(binary, environment, signal, payloadPaths);
  return { codexBinary: binary, expectedVersion, payloadPaths };
}

// Inventory polling reuses version observations; native qualification still checks the installation independently.
async function codexVersion(binary, environment, signal, payloadPaths) {
  const paths = [...new Set([binary, ...payloadPaths])];
  const identity = async () => JSON.stringify({ environment,
    payloads: await Promise.all(paths.map(async path =>
      [path, await inventoryPayloadFingerprints.fingerprint(path, signal)])) });
  const before = await identity();
  const cached = observedVersions.get(binary);
  if (cached?.identity === before) {
    signal.throwIfAborted();
    return cached.version;
  }
  observedVersions.delete(binary);
  const version = await new Promise((resolve, reject) => {
    execFile(binary, ['--version'], { env: { ...environment, NO_COLOR: '1' }, signal,
      timeout: 15_000, maxBuffer: 4096, encoding: 'utf8' }, (error, stdout) => {
      const version = stdout.trim();
      if (error || !/^codex-cli \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version)) {
        reject(new WorkerError('installed_codex_version_unavailable'));
      } else { resolve(version); }
    });
  });
  signal.throwIfAborted();
  if (await identity() !== before) throw new WorkerError('installed_codex_payload_changed');
  if (observedVersions.size >= 512) observedVersions.delete(observedVersions.keys().next().value);
  observedVersions.set(binary, { identity: before, version });
  return version;
}

async function claudeSelection(environment, release, signal) {
  const binary = await executable('claude', environment);
  if (!binary) return null;
  for (const source of [join(release, 'package.json'), binary]) {
    const selection = await claudeSdkSelection(binary, source, environment, release, signal);
    if (selection) return selection;
  }
  return null;
}

async function claudeSdkSelection(binary, source, environment, release, signal) {
  let sdkEntrypoint;
  try { sdkEntrypoint = await realpath(createRequire(source).resolve('@anthropic-ai/claude-agent-sdk')); }
  catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
  const offset = sdkEntrypoint.indexOf('/node_modules/.pnpm/');
  const installedLockPath = offset < 0
    ? join(release, 'artifacts/claude-sdk-lock.yaml')
    : join(sdkEntrypoint.slice(0, offset), 'node_modules/.pnpm/lock.yaml');
  await discoverInstalledClaudeSdk({ entrypoint: sdkEntrypoint, installedLockPath, selectedExecutable: binary }, {
    harnessInstallationId: 'worker-installed-claude',
    environment: { path: environment.PATH ?? '', cwd: release, provenance: 'worker', generation: 'selection' },
  }, signal);
  return { binary, installedLockPath, sdkEntrypoint };
}

function workerSdkNeedsUpgrade(claude, release) {
  if (!claude?.sdkEntrypoint) return false;
  const versions = dirname(release);
  const [version] = relative(versions, claude.sdkEntrypoint).split('/');
  if (!/^\d+\.\d+\.\d+-[a-f0-9]{64}$/u.test(version)) return false;
  const selectedRelease = join(versions, version);
  if (selectedRelease === release
    || !claude.sdkEntrypoint.startsWith(`${selectedRelease}/node_modules/`)) return false;
  return [join(selectedRelease, 'artifacts/claude-sdk-lock.yaml'),
    join(selectedRelease, 'node_modules/.pnpm/lock.yaml')].includes(claude.installedLockPath);
}

async function upgradeClaudeSdk(claude, environment, release, signal) {
  const selection = await claudeSdkSelection(claude.binary, join(release, 'package.json'), environment, release, signal);
  if (!selection || !selection.sdkEntrypoint.startsWith(`${release}/node_modules/`)) {
    throw new WorkerError('installed_claude_sdk_unavailable');
  }
  return selection;
}

/** A launcher from one of this Worker's own releases follows the running release; an explicit one stays. */
function currentLauncher(configuration, release) {
  const launcher = join(release, 'artifacts/graphql-mcp.mjs');
  const releases = `${dirname(release)}/`;
  return configuration.appMcpLauncher.startsWith(releases) ? { ...configuration, appMcpLauncher: launcher } : configuration;
}

async function retainedSelection(previous, environment, release, signal) {
  if (!previous) return null;
  const configuration = currentLauncher(previous, release);
  const binaries = [configuration.codexBinary, configuration.claude?.binary].filter(Boolean);
  try {
    await access(configuration.appMcpLauncher, constants.R_OK);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
  const payloads = [...(configuration.payloadPaths ?? []),
    configuration.claude?.installedLockPath, configuration.claude?.sdkEntrypoint].filter(Boolean);
  try {
    for (const path of binaries) await access(path, constants.X_OK);
    for (const path of payloads) await access(path, constants.R_OK);
  } catch (error) {
    // Keep the selected installation visible as unavailable during payload replacement.
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return configuration;
    throw error;
  }
  // Explicit script selections keep their separate native qualification checks.
  if (configuration.codexBinary && (await passiveDriverPayloads('codex', configuration.codexBinary)).complete) {
    const expectedVersion = await codexVersion(configuration.codexBinary, environment, signal,
      configuration.payloadPaths);
    return { ...configuration, expectedVersion };
  }
  return configuration;
}

/** Pairing approves selection; native qualification and profile grants remain separate. */
export async function refreshWorkflowSelection({ stateDirectory, release = releaseDirectory,
  environment = { ...process.env, PATH: workerPath(process.env.HOME ?? '', process.execPath) },
  assertStateOwnership, signal = AbortSignal.timeout(30_000),
  reportError = error => process.stderr.write(`Workflow harness selection: ${error.code ?? 'installation_unavailable'}\n`) }) {
  release = resolve(release);
  assertStateOwnership();
  signal.throwIfAborted();
  const state = await openPrivateRoot(stateDirectory);
  try {
    const location = { path: join(stateDirectory, 'workflow-runtime.json'), ownerUid: process.getuid() };
    const exists = await managedEntryExists(state, 'workflow-runtime.json');
    const previous = exists ? await readInstalledWorkflowConfiguration(location) : null;
    const retained = await retainedSelection(previous, environment, release, signal);
    let claudeDiscovery = () => claudeSelection(environment, release, signal);
    if (retained?.claude) {
      claudeDiscovery = workerSdkNeedsUpgrade(retained.claude, release)
        ? () => upgradeClaudeSdk(retained.claude, environment, release, signal)
        : () => Promise.resolve(null);
    }
    const selections = await Promise.allSettled([
      retained?.codexBinary ? Promise.resolve(null) : codexSelection(environment, signal),
      claudeDiscovery(),
    ]);
    for (const result of selections) {
      if (result.status === 'rejected') reportError(result.reason);
    }
    signal.throwIfAborted();
    const codex = selections[0].status === 'fulfilled' ? selections[0].value : null;
    const claude = selections[1].status === 'fulfilled' ? selections[1].value : null;
    assertStateOwnership();
    if (retained) {
      const configuration = InstalledWorkflowConfigurationSchema.parse({ ...retained,
        ...(codex ?? {}), ...(claude ? { claude } : {}) });
      if (!isDeepStrictEqual(configuration, previous)) {
        await publishManagedJson(state, 'workflow-runtime.json', configuration);
      }
      return location;
    }
    if (!codex && !claude) {
      if (exists) {
        await unlink(anchored(state, 'workflow-runtime.json'));
        await state.sync();
      }
      return null;
    }
    const appMcpLauncher = join(release, 'artifacts/graphql-mcp.mjs');
    if (await realpath(appMcpLauncher) !== appMcpLauncher) throw new WorkerError('workflow_launcher_retargeted');
    const configuration = InstalledWorkflowConfigurationSchema.parse({ schemaVersion: 1, appMcpLauncher,
      ...(codex ?? {}), ...(claude ? { claude } : {}) });
    if (!isDeepStrictEqual(configuration, previous)) {
      await publishManagedJson(state, 'workflow-runtime.json', configuration);
    }
    return location;
  } finally { await state.close(); }
}
