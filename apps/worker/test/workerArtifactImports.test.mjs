import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

async function fixture(t) {
  const cache = join(homedir(), '.cache/foreman-tmp');
  await mkdir(cache, { recursive: true });
  const parent = await mkdtemp(join(cache, 'worker-imports-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(join(parent, 'artifacts'));
  const directory = join(parent, 'artifacts-link');
  await symlink('artifacts', directory);
  const root = join(directory, 'repository');
  const environment = {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };
  execFileSync('git', ['clone', '--quiet', '--shared', repository, root], { env: environment });
  for (const path of ['node_modules', 'apps/worker/node_modules', 'apps/api/node_modules',
    'packages/contracts/node_modules']) {
    await symlink(join(repository, path), join(root, path));
  }
  const write = async (path, source) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  };
  const build = () => {
    const git = args => execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8' });
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Worker imports']);
    const commit = git(['rev-parse', 'HEAD']).trim();
    return spawnSync(process.execPath, [join(root, 'scripts/build-worker-artifact.mjs'),
      'apps/worker/artifacts/ubuntu-26.04-x64-target.json', join(directory, 'release')], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
      env: { ...environment, FOREMAN_CODE_WORKER_BUILD_COMMIT: commit, GRAPHQL_WORKER_BUILD_COMMIT: commit },
    });
  };
  return { root, directory, write, build };
}

test('Worker artifacts bundle new transitive API helpers without registering modules', async t => {
  const f = await fixture(t);
  await f.write('apps/api/src/modules/worker-build-fixture/value.ts',
    "export const value = 'bundled from the import graph';\n");
  await f.write('apps/api/src/modules/worker-build-fixture/helper.ts',
    "import { value } from './value.js';\nexport const importedHelper = () => value;\n");
  await appendFile(join(f.root, 'apps/worker/src/workerFactory.mjs'),
    "\nexport { importedHelper } from '../../api/src/modules/worker-build-fixture/helper.ts';\n"
      + "export { HostCiRunner } from '../../api/src/modules/ci-host/runner.ts';\n");
  const result = f.build();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const worker = await import(pathToFileURL(join(f.directory, 'release/src/worker.mjs')).href);
  assert.equal(worker.importedHelper(), 'bundled from the import graph');
  for (const suite of ['unit', 'integration']) {
    await t.test(`${suite} commands use a runnable bundled watchdog when the source has none`, async () => {
      await assertBundledWatchdog(f, worker, suite);
    });
  }
  await t.test('runner startup rejects a missing bundled watchdog', async () => {
    await rm(join(f.directory, 'release/artifacts/verification/ci-watchdog.mjs'), { force: true });
    assert.throws(() => new worker.HostCiRunner(join(f.directory, 'missing-helper')),
      /CI watchdog.*missing/i);
  });
});

async function assertBundledWatchdog(f, worker, suite) {
  const root = join(f.directory, suite);
  const launched = Promise.withResolvers();
  const ports = {
    cpus: 8, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args) => {
      if (file === 'git' && args.includes('worktree') && args.includes('add')) {
        const source = args.at(-2);
        await mkdir(source, { recursive: true });
        await writeFile(join(source, 'package.json'), JSON.stringify({ scripts: { [suite]: 'fixture' } }));
      }
      if (file === 'systemd-run') launched.resolve(args.at(-1));
      return { code: 0, stdout: file === 'git' && args.includes('show') ? '{}' : 'active', stderr: '' };
    },
  };
  const runner = new worker.HostCiRunner(root, ports, {});
  const runId = randomUUID();
  await runner.handle({ operation: 'start', runId, repository: 'example/project',
    commit: 'a'.repeat(40), suite, scope: 'full' });
  const command = await readFile(await launched.promise, 'utf8');
  // This is the command handed to the process launcher, not repository source text.
  const watchdog = / node '([^']+)' -- bash -c/.exec(command)?.[1];
  assert.ok(watchdog, 'The test command must run through the watchdog');
  const location = relative(await realpath(join(f.directory, 'release')), watchdog);
  assert.ok(!isAbsolute(location) && !location.startsWith('..'), 'The helper must belong to the Worker artifact');
  const result = spawnSync(process.execPath, [watchdog, '--', process.execPath, '-e',
    "console.log('watched command completed')"], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, CI_WATCHDOG_DIRECTORY: join(root, 'watchdog') },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /watched command completed/);
}

test('Worker artifacts reject forbidden modules, sensitive files and imports outside source scope', async t => {
  const forbidden = [
    'apps/api/src/server.ts', 'apps/api/src/app.ts', 'apps/api/src/production.ts',
    'apps/api/src/infrastructure/db.ts', 'apps/api/src/infrastructure/database.ts',
    'apps/api/src/db/fixture.ts', 'apps/api/src/migrations/fixture.ts', 'apps/api/src/bootstrap/fixture.ts',
    'apps/api/src/modules/worker-build-fixture/credentials.json',
    'apps/api/src/modules/worker-build-fixture/.env.json',
    'apps/api/src/modules/worker-build-fixture/fixture.test.ts', 'apps/api/fixture.ts',
  ];
  for (const path of forbidden) {
    await t.test(path, async t => {
      const f = await fixture(t);
      await f.write(path, path.endsWith('.json') ? '{"value":"fixture"}\n' : 'export const value = 1;\n');
      await f.write('apps/worker/src/workerFactory.mjs',
        `import '../../${path.slice('apps/'.length)}';\nexport const worker = true;\n`);
      const result = f.build();
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Forbidden snapshot source:/);
    });
  }
});
