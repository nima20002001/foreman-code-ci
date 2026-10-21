import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_MANAGER, RELEASE_AGE_MINUTES, sha256 } from './seed-policy.mjs';

const imageRoot = '/opt/graphql-ci';
export const VERIFICATION_SCRATCH = '/job-scratch';
const corepack = '/usr/local/lib/node_modules/corepack/dist/corepack.js';

export function verificationEnvironment(environment, memoryBytes = 2 * 2**30) {
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 64 * 2**20) {
    throw new Error('Verification requires a finite kernel memory reservation.');
  }
  const heapMiB = Math.floor(memoryBytes / 2**20 * 0.75);
  const clean = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/^(?:npm_config_|pnpm_|corepack_|node_options$|node_path$)/i.test(key)));
  return {
    ...clean,
    HOME: `${VERIFICATION_SCRATCH}/home`,
    XDG_CACHE_HOME: `${VERIFICATION_SCRATCH}/cache`,
    XDG_CONFIG_HOME: `${VERIFICATION_SCRATCH}/config`,
    XDG_DATA_HOME: `${VERIFICATION_SCRATCH}/data`,
    TMPDIR: `${VERIFICATION_SCRATCH}/tmp`,
    COREPACK_HOME: `${imageRoot}/seed/corepack-cache`,
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_DEFAULT_TO_LATEST: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    NODE_OPTIONS: `--max-old-space-size=${heapMiB}`,
    PNPM_CONFIG_OFFLINE: 'true',
    PNPM_CONFIG_STORE_DIR: `${VERIFICATION_SCRATCH}/pnpm-store`,
    PNPM_CONFIG_CACHE_DIR: `${VERIFICATION_SCRATCH}/cache/pnpm`,
    PNPM_CONFIG_VERIFY_STORE_INTEGRITY: 'true',
    PNPM_CONFIG_WORKSPACE_CONCURRENCY: '1',
    PNPM_CONFIG_USERCONFIG: '/dev/null',
    PNPM_CONFIG_GLOBALCONFIG: '/dev/null',
    CI: '1',
  };
}

export function verificationInstallArguments(argv) {
  if (argv[0] !== 'install') return argv;
  const allowed = new Set(['install', '--frozen-lockfile', '--offline', '--prod=false']);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--store-dir' && argv[index + 1] === `${VERIFICATION_SCRATCH}/pnpm-store`) {
      index++;
      continue;
    }
    if (!allowed.has(argument)) throw new Error('Verification install arguments cannot change dependency policy.');
  }
  return ['install', '--frozen-lockfile', '--offline', '--prod=false'];
}

export function assertVerificationPackageArguments(args) {
  let commandIndex = 0;
  while (['--filter', '-F'].includes(args[commandIndex])) commandIndex += 2;
  const deploy = args[commandIndex] === 'deploy';
  const configurationOption = /^--(?:minimum-release-age|config\.|userconfig|globalconfig|store-dir|cache-dir|offline|prod|prefix|ignore-pnpmfile|verify-store-integrity)/;
  for (const argument of args) {
    if (!configurationOption.test(argument)) continue;
    if (['--offline', '--prod=false'].includes(argument)) continue;
    if (deploy && argument === '--prod') continue;
    throw new Error('Caller package configuration overrides are unavailable in verification.');
  }
}

export function assertEffectivePackagePolicy(config) {
  const value = key => config[key] ?? config[key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)];
  if (Number(value('minimumReleaseAge')) !== RELEASE_AGE_MINUTES
    || ![true, 'true'].includes(value('minimumReleaseAgeStrict'))
    || ![false, 'false'].includes(value('minimumReleaseAgeIgnoreMissingTime'))
    || (value('minimumReleaseAgeExclude')?.length ?? 0) !== 0) {
    throw new Error('Effective strict 48-hour dependency policy changed.');
  }
}

export function assertEffectiveVerificationStore(config) {
  const value = key => config[key] ?? config[key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)];
  if (Number(value('workspaceConcurrency')) !== 1) {
    throw new Error('Recursive workspace commands require one package at a time within the Job reservation.');
  }
  if (![true, 'true'].includes(value('offline')) || ![true, 'true'].includes(value('verifyStoreIntegrity'))
    || value('storeDir') !== `${VERIFICATION_SCRATCH}/pnpm-store`
    || value('cacheDir') !== `${VERIFICATION_SCRATCH}/cache/pnpm`) {
    throw new Error('Effective offline Job-private dependency store changed.');
  }
}

export async function assertDependencyInputs(root, receipt) {
  for (const file of receipt.dependencyInputs) {
    const bytes = await readFile(resolve(root, file.path));
    if (sha256(bytes) !== file.sha256) throw new Error('Committed dependency inputs differ from the approved offline seed.');
  }
}

async function createVerificationDirectories(scratchDirectory) {
  for (const directory of ['home', 'cache', 'config', 'data', 'tmp']) {
    await mkdir(`${scratchDirectory}/${directory}`, { recursive: true, mode: 0o700 });
  }
}

async function copySeedDirectory(source, destination) {
  const existing = await lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const options = { recursive: true, force: false, errorOnExist: true };
  if (!existing) return cp(source, destination, options);
  if (!existing.isDirectory() || existing.uid !== process.getuid() || existing.mode & 0o077
    || (await readdir(destination)).length) {
    throw new Error('Seed destination must be a fresh private directory.');
  }
  for (const name of await readdir(source)) await cp(join(source, name), join(destination, name), options);
}

export async function copyVerificationSeed(seedDirectory, scratchDirectory, receiptBytes) {
  await createVerificationDirectories(scratchDirectory);
  const marker = `${scratchDirectory}/seed-receipt.sha256`;
  const existing = await readFile(marker, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing === null) {
    await copySeedDirectory(`${seedDirectory}/pnpm-store`, `${scratchDirectory}/pnpm-store`);
    await copySeedDirectory(`${seedDirectory}/registry-cache`, `${scratchDirectory}/cache/pnpm`);
    await writeFile(marker, sha256(receiptBytes), { flag: 'wx', mode: 0o600 });
  } else if (existing !== sha256(receiptBytes)) throw new Error('Job-local store belongs to another approved seed.');
}

export async function prepareVerificationWorkspace(args, seedDirectory, scratchDirectory, receiptBytes) {
  const readOnlyConfig = args[0] === 'config' && (
    args[1] === 'get' && args.length === 3
    || args[1] === 'list' && (args.length === 2 || args.length === 3 && args[2] === '--json'));
  if (readOnlyConfig) await createVerificationDirectories(scratchDirectory);
  else await copyVerificationSeed(seedDirectory, scratchDirectory, receiptBytes);
}

/** Every invocation uses image-controlled pnpm and configuration; workloads never share a writable installer store. */
export async function prepareVerificationPnpm(argv, environment = process.env) {
  if (argv[0] !== 'pnpm') throw new Error('The verification runtime uses its pinned pnpm only.');
  const memoryBytes = Number((await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim());
  const env = verificationEnvironment(environment, memoryBytes);
  if (argv.length === 2 && ['--version', '-v'].includes(argv[1])) return { argv, env };
  const receiptBytes = await readFile(`${imageRoot}/seed-receipt.json`);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  if (receipt.packageManager !== PACKAGE_MANAGER) throw new Error('Pinned offline package manager unavailable.');
  await assertDependencyInputs('/workspace', receipt);
  const args = verificationInstallArguments(argv.slice(1));
  assertVerificationPackageArguments(args);
  await prepareVerificationWorkspace(args, `${imageRoot}/seed`, VERIFICATION_SCRATCH, receiptBytes);
  const config = JSON.parse(execFileSync(process.execPath, [corepack, 'pnpm', 'config', 'list', '--json'],
    { env, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000 }));
  assertEffectivePackagePolicy(config);
  assertEffectiveVerificationStore(config);
  return { argv: ['pnpm', ...args], env };
}

const POSTGRES = '/usr/lib/postgresql/17/bin';
const TEST_DATABASE = 'FOREMAN_CODE_CI_TEST_DATABASE';
/** `pnpm test` needs the disposable test server on 127.0.0.1:55439; nested pnpm calls reuse the outer one. */
export function needsTestDatabase(argv, environment) {
  const script = argv[1] === 'run' ? argv[2] : argv[1];
  return ['test', 'test:integration'].includes(script) && environment[TEST_DATABASE] !== 'running';
}

/** A private PostgreSQL in job scratch, with the ownership markers the repository's test resources require. */
export async function startTestDatabase(environment) {
  const root = `${VERIFICATION_SCRATCH}/postgres`;
  await mkdir(`${root}/socket`, { recursive: true, mode: 0o700 });
  await writeFile(`${root}/password`, 'graphql_test_disposable_only\n', { mode: 0o600 });
  const env = { ...environment, PGPASSWORD: 'graphql_test_disposable_only', LC_ALL: 'C.UTF-8' };
  execFileSync(`${POSTGRES}/initdb`, ['-D', `${root}/data`, '-U', 'graphql_test_admin', '--pwfile', `${root}/password`,
    '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C.UTF-8', '--no-sync'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  const server = spawn(`${POSTGRES}/postgres`, ['-D', `${root}/data`, '-h', '127.0.0.1', '-p', '55439', '-k', `${root}/socket`,
    '-c', 'max_connections=800', '-c', 'max_locks_per_transaction=512', '-c', 'fsync=off', '-c', 'synchronous_commit=off',
    '-c', 'full_page_writes=off', '-c', 'dynamic_shared_memory_type=mmap', '-c', 'log_min_messages=warning'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  const exited = new Promise(resolve => server.once('exit', resolve));
  const psql = (database, sql) => execFileSync(`${POSTGRES}/psql`, ['-h', '127.0.0.1', '-p', '55439', '-U', 'graphql_test_admin',
    '-d', database, '-v', 'ON_ERROR_STOP=1', '-qc', sql], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let attempt = 0; ; attempt++) {
    try { execFileSync(`${POSTGRES}/pg_isready`, ['-q', '-h', '127.0.0.1', '-p', '55439', '-U', 'graphql_test_admin', '-d', 'postgres'], { env, stdio: 'ignore' }); break; }
    catch (error) {
      if (attempt >= 120 || server.exitCode !== null) throw new Error('The disposable test PostgreSQL did not start.', { cause: error });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  psql('postgres', 'CREATE DATABASE graphql_test_control');
  psql('postgres', "COMMENT ON DATABASE postgres IS 'graphql-disposable-test-server'");
  psql('graphql_test_control', "COMMENT ON DATABASE graphql_test_control IS 'graphql-disposable-test-server'; REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  return { stop: async () => { if (server.exitCode === null) server.kill('SIGINT'); await exited; } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { argv, env } = await prepareVerificationPnpm(process.argv.slice(2));
    const database = needsTestDatabase(argv, env) ? await startTestDatabase(env) : null;
    const child = spawn(process.execPath, [corepack, ...argv], { env: database ? { ...env, [TEST_DATABASE]: 'running',
      TEST_DATABASE_URL: 'postgresql://graphql_test_admin:graphql_test_disposable_only@127.0.0.1:55439/postgres' } : env,
      stdio: 'inherit', shell: false });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 127; });
    child.once('exit', (code, signal) => {
      process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : 130);
      void database?.stop();
    });
  } catch (error) {
    process.stderr.write(`Offline verification preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
