import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { access, mkdir, readFile, readlink, rmdir, statfs, writeFile, unlink } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { prepareVerificationPnpm, assertEffectivePackagePolicy, assertEffectiveVerificationStore } from './verification-policy.mjs';

export async function probeExecutableScratch(directory) {
  const path = `${directory}/qualification-${randomUUID()}`;
  await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700, flag: 'wx' });
  try {
    const result = spawnSync(path, [], { stdio: 'ignore', timeout: 5000 });
    return result.error?.code ?? result.status;
  } finally { await unlink(path); }
}

export function imageToolPath(tool) {
  const installedPostgres = tool.kind === 'postgresql'
    && tool.executable === '/usr/lib/postgresql/17/bin/postgres';
  if ((!tool.executable?.startsWith('/opt/graphql-ci/tools/') && !installedPostgres)
    || tool.executable.includes('..')) {
    throw new Error('Image-owned qualification tool path required.');
  }
  return tool.executable;
}

export function imageToolVersion(kind, output) {
  if (kind !== 'postgresql') return output;
  const version = /PostgreSQL\)\s+(\S+)/u.exec(output)?.[1];
  if (!version) throw new Error('Image tool returned an unsupported version.');
  return version;
}

/** Exercise the same child-cgroup entry and forced descendant cleanup used by native guardians. */
export async function probeNativeCgroupDelegation() {
  const root = '/sys/fs/cgroup';
  const entry = (await readFile('/proc/self/cgroup', 'utf8')).trim();
  if (entry !== '0::/' || (await statfs(root)).type !== 0x63677270) {
    throw new Error('Verification requires its private cgroup v2 root.');
  }
  const path = `${root}/foreman-verification-${randomUUID()}`;
  await mkdir(path);
  const waitForEmpty = async () => {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (/^populated 0$/m.test(await readFile(`${path}/cgroup.events`, 'utf8'))) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Verification child cgroup cleanup did not finish.');
  };
  try {
    const child = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      fs.writeFileSync(process.argv[1] + '/cgroup.procs', String(process.pid));
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        { detached: true, stdio: 'ignore' });
      console.log(child.pid);
      child.unref();
    `, path], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    if (child.error || child.status !== 0 || !/^\d+\s*$/.test(child.stdout)) {
      throw new Error('Verification could not launch a delegated cgroup descendant.', { cause: child.error });
    }
    if (!/^populated 1$/m.test(await readFile(`${path}/cgroup.events`, 'utf8'))) {
      throw new Error('Verification delegated descendant did not remain contained.');
    }
    await writeFile(`${path}/cgroup.kill`, '1');
    await waitForEmpty();
    return true;
  } finally {
    await writeFile(`${path}/cgroup.kill`, '1');
    await waitForEmpty();
    await rmdir(path);
  }
}

/** Runs inside the admitted verification container. It reports observations, never a qualification flag. */
export async function observeVerificationRuntime({ ownerSentinelPaths, tools = [] }) {
  if (!Array.isArray(ownerSentinelPaths) || !ownerSentinelPaths.length
    || ownerSentinelPaths.some(path => typeof path !== 'string' || !path.startsWith('/') || path.includes('\0'))) {
    throw new Error('Original controller-owned sentinel paths required.');
  }
  await mkdir('/job-scratch/tmp', { recursive: true, mode: 0o700 });
  const { env } = await prepareVerificationPnpm(['pnpm', 'config', 'list', '--json']);
  const config = JSON.parse(execFileSync(process.execPath,
    ['/usr/local/lib/node_modules/corepack/dist/corepack.js', 'pnpm', 'config', 'list', '--json'],
    { env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }));
  assertEffectivePackagePolicy(config);
  assertEffectiveVerificationStore(config);
  const status = await readFile('/proc/self/status', 'utf8');
  const shm = await statfs('/dev/shm');
  const tmp = await statfs('/tmp');
  const ownerSentinels = [];
  for (const path of ownerSentinelPaths) {
    let result;
    try { await access(path); result = 'accessible'; }
    catch (error) { result = error.code; }
    ownerSentinels.push({ path, result });
  }
  const cpu = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(' ').map(Number);
  const nativeCgroupDelegation = await probeNativeCgroupDelegation();
  const cgroupLimitWriteErrors = [];
  for (const name of ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max']) {
    const path = `/sys/fs/cgroup/${name}`;
    const value = await readFile(path, 'utf8');
    try { await writeFile(path, value); cgroupLimitWriteErrors.push(null); }
    catch (error) { cgroupLimitWriteErrors.push(error.code); }
  }
  const version = (binary, args = ['--version']) => execFileSync(binary, args,
    { env, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 }).trim();
  const toolchain = { node: process.version, corepack: version(process.execPath, ['/usr/local/lib/node_modules/corepack/dist/corepack.js', '--version']),
    pnpm: version('corepack', ['pnpm', '--version']), git: version('git'), flock: version('flock') };
  const measuredTools = [];
  for (const tool of tools) {
    imageToolPath(tool);
    const bytes = await readFile(tool.executable);
    if (bytes.length > 256 * 1024 * 1024) throw new Error('Image tool exceeds its capture bound.');
    const toolVersion = imageToolVersion(tool.kind, version(tool.executable));
    measuredTools.push({ kind: tool.kind, executable: tool.executable,
      version: toolVersion, binarySha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const writeError = async path => {
    try { await writeFile(path, 'qualification write'); return null; }
    catch (error) { return error.code; }
  };
  const rootfsWriteError = await writeError('/verification-outside');
  const gitWriteErrors = [];
  for (const name of ['HEAD', 'index', 'config']) gitWriteErrors.push(await writeError(`/graphql-job-git/${name}`));
  const scheduler = `/graphql-job-git/graphql-heavy-jobs/${randomUUID()}`;
  await writeFile(scheduler, 'bounded scheduler state', { flag: 'wx', mode: 0o600 });
  const schedulerWrite = (await readFile(scheduler, 'utf8')) === 'bounded scheduler state';
  await unlink(scheduler);
  const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { detached: true, stdio: 'ignore', env });
  descendant.unref();
  return {
    schemaVersion: 1, node: process.version, toolchain, tools: measuredTools, rootfsWriteError,
    verificationEnvironment: process.env.FOREMAN_CODE_VERIFICATION_ENVIRONMENT,
    gitWriteErrors: gitWriteErrors.join(','), schedulerWrite, detachedChildPid: descendant.pid,
    environment: Object.keys(process.env).sort(),
    pidNamespace: await readlink('/proc/self/ns/pid'), networkNamespace: await readlink('/proc/self/ns/net'),
    cgroupNamespace: await readlink('/proc/self/ns/cgroup'), nativeCgroupDelegation, cgroupLimitWriteErrors,
    interfaces: Object.keys(networkInterfaces()).sort(),
    memoryMax: (await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(),
    swapMax: (await readFile('/sys/fs/cgroup/memory.swap.max', 'utf8')).trim(),
    pidsMax: (await readFile('/sys/fs/cgroup/pids.max', 'utf8')).trim(), cpuRatio: cpu[0] / cpu[1],
    capabilities: /^CapEff:\s*(\S+)/m.exec(status)?.[1], noNewPrivileges: /^NoNewPrivs:\s*(\S+)/m.exec(status)?.[1],
    controlExecution: await probeExecutableScratch('/tmp'), scratchExecution: await probeExecutableScratch('/job-scratch/tmp'),
    shmType: shm.type, shmCapacityBytes: shm.blocks * shm.bsize,
    controlTempType: tmp.type, controlTempCapacityBytes: tmp.blocks * tmp.bsize,
    mountInfo: await readFile('/proc/self/mountinfo', 'utf8'), ownerSentinels,
    packagePolicy: { minimumReleaseAge: 2880, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false },
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const input = JSON.parse(process.argv[2] ?? 'null');
  const observation = await observeVerificationRuntime(input);
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}
