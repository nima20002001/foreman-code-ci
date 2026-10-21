import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assembleBrowserRuntime } from '../../../../scripts/browser-runtime-install.mjs';
import { activateBrowserRuntime, offlineBrowserRuntimeLifecycle, stageBrowserRuntime,
  readInstalledBrowserRuntime, copyBuiltBrowserRuntime } from '../../src/browserRuntimeInstall.mjs';
import { browserHostTarget } from './browserTarget.mjs';
import { configureBrowserSandbox } from './browserSandbox.mjs';

const execute = promisify(execFile);

export async function installedBrowserFixture() {
  await configureBrowserSandbox();
  const repository = fileURLToPath(new URL('../../../../', import.meta.url));
  const target = await browserHostTarget();
  const parent = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, 'browser-acceptance-'));
  try {
    const { stdout } = await execute('git', ['rev-parse', 'HEAD'], { cwd: repository });
    const product = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
    const artifact = join(directory, 'artifact');
    const started = performance.now();
    const progress = phase => process.stdout.write(`[browser-build] ${phase}: ${Math.round(performance.now() - started)} ms\n`);
    process.stdout.write(`Assembling native browser runtime for ${JSON.stringify(target)}\n`);
    const packed = await assembleBrowserRuntime({ repository, commit: stdout.trim(), target,
      foremanVersion: product.version, output: artifact, onProgress: progress });
    const consumed = join(directory, 'consumed');
    await copyBuiltBrowserRuntime({ directory: artifact, output: consumed, target, commit: stdout.trim() });
    const runtimeRoot = join(directory, 'installed');
    const staged = await stageBrowserRuntime({ runtimeRoot, artifact: consumed,
      expectedSha256: packed.descriptorSha256, target, activate: false });
    progress('runtime-staged-and-verified');
    const lifecycle = await offlineBrowserRuntimeLifecycle({ nativeHostModule: staged.nativeHostModule,
      profileStateRoot: join(directory, 'profiles') });
    await activateBrowserRuntime({ runtimeRoot, staged, drain: lifecycle.drain });
    progress('runtime-activated');
    const runtime = await readInstalledBrowserRuntime({ runtimeRoot, target });
    return { runtime, directory, target, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
