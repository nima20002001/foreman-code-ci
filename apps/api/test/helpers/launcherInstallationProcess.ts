import { execFile } from 'node:child_process'
import type { LauncherInstallation } from '../../src/modules/harnesses/appMcpLauncher.js'

type LauncherOperation =
  | { kind: 'install'; launcher: string }
  | { kind: 'older-install'; launcher: string; snapshot?: LauncherInstallation }
  | { kind: 'register'; launcher: string; installation: LauncherInstallation }
  | { kind: 'recognize'; launcher: string; entry: Record<string, unknown> | Record<string, unknown>[] }
  | { kind: 'upgrade'; home: string }

const launcherModule = new URL('../../src/modules/harnesses/appMcpLauncher.ts', import.meta.url).href
const upgradeModule = new URL('../../src/modules/harnesses/productionMcpUpgrade.ts', import.meta.url).href
const source = new URL('../../../../scripts/graphql-mcp.mjs', import.meta.url).href
const program = `
  import { randomUUID } from 'node:crypto';
  import { realpathSync } from 'node:fs';
  import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
  import { dirname } from 'node:path';
  import { installManagedLauncher, isAppLauncher, writeLauncherInstallation } from ${JSON.stringify(launcherModule)};
  const operation = JSON.parse(process.argv[1]);
  const source = new URL(${JSON.stringify(source)});
  if (operation.kind === 'older-install') {
    // The pre-update writer copies the launcher and replaces only version/executables.
    const destination = operation.launcher;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = destination + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, await readFile(source), { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    const metadata = destination + '.installation.json';
    let installation = operation.snapshot;
    if (!installation) {
      try {
        installation = JSON.parse(await readFile(metadata, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const executables = (installation?.executables ?? []).filter(entry => entry.path !== process.execPath);
    executables.push({ path: process.execPath, realpath: realpathSync(process.execPath) });
    const pending = metadata + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(pending, JSON.stringify({ version: 1, executables }), { mode: 0o600, flag: 'wx' });
      await rename(pending, metadata);
    } finally {
      await rm(pending, { force: true });
    }
  } else if (operation.kind === 'install') {
    process.stdout.write('started\\n');
    await installManagedLauncher(source, operation.launcher);
  } else if (operation.kind === 'register') {
    await writeLauncherInstallation(operation.launcher, operation.installation);
  } else if (operation.kind === 'upgrade') {
    const { upgradeProductionMcpLauncher } = await import(${JSON.stringify(upgradeModule)});
    await upgradeProductionMcpLauncher(operation.home);
  } else if (operation.kind === 'recognize') {
    delete process.env.GRAPHQL_APP_MCP_DIRECTORY;
    process.env.FOREMAN_CODE_APP_MCP_DIRECTORY = dirname(operation.launcher);
    const recognized = Array.isArray(operation.entry)
      ? operation.entry.map(entry => isAppLauncher(entry)) : isAppLauncher(operation.entry);
    console.log(JSON.stringify(recognized));
  } else {
    throw new Error('Unknown launcher operation');
  }
`

export function runLauncherProcess(
  operation: LauncherOperation, runtime = process.execPath, onStarted?: () => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(runtime, [
      '--import', import.meta.resolve('tsx'), '--input-type=module', '-e', program, JSON.stringify(operation),
    ], { timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
    if (onStarted) child.stdout?.once('data', onStarted)
  })
}
