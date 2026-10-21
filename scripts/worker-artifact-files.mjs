import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

export function committedWorkerInputPath(root, input) {
  const path = relative(root, resolve(root, input));
  if (!path.startsWith('apps/worker/artifacts/') || !safePath(path) || !path.endsWith('.json')) {
    throw new Error('Reviewed target/runtime JSON must be a committed repository file under apps/worker/artifacts/');
  }
  return path;
}

/** Format 1 is shipped in older updaters. Changing this policy requires an old-pin bridge and a new protocol. */
export function assertWorkerUpdateToolchain(product) {
  if (product.packageManager !== 'pnpm@11.27.0') {
    throw new Error('Worker toolchain changes require a bridge release before a versioned update policy can be advertised.');
  }
}

export function workerReleaseVersion(product) {
  if (!/^\d+\.\d+\.\d+$/.test(product.version)) throw new Error('Product release version is invalid');
  return product.version;
}

export function validateWorkerTarget(target) {
  if (target.arch !== 'x64') throw new Error('Sharp assets are qualified only for linux-x64');
  if (target.os !== 'ubuntu' || !/^\d+\.\d+$/.test(target.osRelease)
    || !/^glibc-\d+\.\d+$/.test(target.libc) || !/^v22\.\d+\.\d+$/.test(target.node)) {
    throw new Error('Unsupported build target');
  }
}

export const sharpPackages = Object.freeze({
  sharp: '0.35.4', '@img/colour': '1.1.0', 'detect-libc': '2.1.2', semver: '7.8.5',
  '@img/sharp-linux-x64': '0.35.4', '@img/sharp-libvips-linux-x64': '1.3.3',
});
export function assertWorkerDependency(path) {
  if (/^(?:pg(?:-|$|\/)|postgres(?:$|\/)|@fastify\/|fastify(?:$|\/)|drizzle-orm(?:$|\/)|kysely(?:$|\/))/.test(path)) {
    throw new Error(`Forbidden control-plane dependency: ${path}`);
  }
}
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
export function safePath(path) {
  return typeof path === 'string' && /^[a-zA-Z0-9_@./-]+$/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}

// Package roots are pnpm links; every entry beneath the resolved root must be regular.
export async function regularFiles(directory, { excludeNodeModules = false } = {}) {
  const files = new Map();
  async function walk(path, prefix = '') {
    if (!(await lstat(path)).isDirectory()) throw new Error(`Nonregular directory: ${path}`);
    for (const name of (await readdir(path)).sort()) {
      if (excludeNodeModules && name === 'node_modules') continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!safePath(relative)) throw new Error(`Unsafe file path: ${relative}`);
      const source = join(path, name), info = await lstat(source);
      if (info.isDirectory()) await walk(source, relative);
      else if (info.isFile()) files.set(relative, await readFile(source));
      else throw new Error(`Nonregular package file: ${relative}`);
    }
  }
  await walk(directory);
  return files;
}

// The published tarball omits its monorepo license; retain the license from its npm gitHead.
// https://github.com/cfworker/cfworker/blob/5409fdc2bd144f68e8b28c61c71fcb16600000a6/LICENSE.md
const cfworkerLicense = {
  package: '@cfworker/json-schema@4.1.1', path: 'apps/worker/artifacts/licenses/cfworker.txt',
  sha256: '376944252ab78ca6b41aee44ddea8894927ee67891e77e61eb9d59af63e35094',
};

export function verifyPackage(name, version, index, files, supplementalLicense) {
  if (!index || index.requiresBuild !== false || index.manifest?.name !== name || index.manifest?.version !== version
    || index.algo !== 'sha512' || !(index.files instanceof Map)) throw new Error(`Invalid package index: ${name}@${version}`);
  const expected = new Map([...index.files].filter(([path]) => !path.split('/').includes('node_modules')));
  if (expected.size !== files.size) throw new Error(`Package file set mismatch: ${name}`);
  for (const [path, entry] of expected) {
    const bytes = files.get(path);
    if (!safePath(path) || !bytes || !/^[a-f0-9]{128}$/.test(entry.digest) || entry.size !== bytes.length
      || digest('sha512', bytes) !== entry.digest) throw new Error(`Package integrity mismatch: ${name}/${path}`);
  }
  const manifest = JSON.parse(files.get('package.json'));
  if (manifest.name !== name || manifest.version !== version) throw new Error(`Package identity mismatch: ${name}`);
  // The locked libvips tarball publishes its dependency license table in README.md.
  const licenseTable = name === '@img/sharp-libvips-linux-x64' && manifest.license === 'LGPL-3.0-or-later'
    && files.get('README.md')?.toString('utf8').includes('LGPLv3');
  const upstreamLicense = `${name}@${version}` === cfworkerLicense.package && manifest.license === 'MIT'
    && supplementalLicense && digest('sha256', supplementalLicense) === cfworkerLicense.sha256;
  if (!licenseTable && !upstreamLicense && ![...files.keys()].some(path => /(?:^|\/)(?:LICENSE|LICENCE|COPYING)(?:\.|$)/i.test(path))) throw new Error(`Package license missing: ${name}`);
}

async function withPackageIndex(store, copy) {
  const indexPath = join(store, 'index.db');
  let database;
  try {
    database = new DatabaseSync(indexPath, { readOnly: true });
  } catch (error) {
    throw new Error(`Cannot read pnpm package index at ${indexPath}. Restore the pnpm store together with node_modules `
      + 'or reinstall dependencies before building the Worker artifact.', { cause: error });
  }
  try {
    const query = database.prepare('SELECT data FROM package_index WHERE key = ?');
    return await copy(key => query.get(key)?.data);
  } finally {
    database.close();
  }
}

export async function copySharpPackagesFromStore(options) {
  return withPackageIndex(options.store, record => copySharpPackages({ ...options, record }));
}

export async function copyClaudeSdkPackagesFromStore(options) {
  return withPackageIndex(options.store, record => copyClaudeSdkPackages({ ...options, record }));
}

async function installedPackage(name, from) {
  let directory = from;
  for (;;) {
    try { return await realpath(join(directory, 'node_modules', name)); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Installed dependency is unavailable: ${name}`);
    directory = parent;
  }
}

// The SDK's default entrypoint is bundled; declared peers and native CLI packages need not be runtime imports.
async function claudeRuntimeFiles(root, sdk) {
  const { build } = createRequire(new URL('../apps/worker/package.json', import.meta.url))('esbuild');
  const entrypoint = createRequire(join(root, 'apps/api/package.json')).resolve(sdk);
  const result = await build({ absWorkingDir: root, entryPoints: [entrypoint], bundle: true,
    platform: 'node', format: 'esm', write: false, metafile: true });
  const packages = new Map();
  const names = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const path = await realpath(resolve(root, input));
    const marker = '/node_modules/';
    const offset = path.lastIndexOf(marker);
    if (offset < 0) throw new Error(`SDK runtime module is outside an installed package: ${path}`);
    const parts = path.slice(offset + marker.length).split('/');
    const name = parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/');
    const source = join(path.slice(0, offset), 'node_modules', name);
    const files = packages.get(source) ?? new Set();
    files.add(relative(source, path));
    packages.set(source, files);
    names.add(name);
  }
  return { packages, names };
}

function runtimePackageFiles(files, modules) {
  return new Map([...files].filter(([path]) => modules.has(path)
    || path === 'package.json' || path.endsWith('/package.json')
    || /(?:^|\/)(?:LICENSE|LICENCE|COPYING)(?:\.|$)/i.test(path) || /^README(?:\.|$)/i.test(path)));
}

async function writePackageFiles(destination, files) {
  for (const [path, bytes] of files) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
}

async function copyClaudeSdkPackages({ root, output, lock, record, decode }) {
  const sdk = '@anthropic-ai/claude-agent-sdk';
  const reference = lock.importers?.['apps/api']?.dependencies?.[sdk]?.version;
  if (typeof reference !== 'string') throw new Error('Locked Claude SDK dependency is unavailable.');
  const runtime = await claudeRuntimeFiles(root, sdk);
  const hoisted = new Map();
  const copied = new Map();
  const packages = [];
  async function copy(name, reference, from, parent) {
    if (!runtime.names.has(name)) return;
    const source = await installedPackage(name, from);
    const modules = runtime.packages.get(source);
    if (!modules) return;
    const version = reference.split('(')[0];
    const key = `${name}@${reference}`;
    const metadata = lock.packages?.[`${name}@${version}`];
    const integrity = metadata?.resolution?.integrity;
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity ?? '')) throw new Error(`Missing locked integrity: ${name}`);
    const destination = hoisted.has(name) && hoisted.get(name) !== reference
      ? join(parent, 'node_modules', name) : join(output, 'node_modules', name);
    if (copied.has(destination)) {
      if (copied.get(destination) !== key) throw new Error(`Conflicting artifact dependency: ${name}`);
      return;
    }
    const files = await regularFiles(source, { excludeNodeModules: true });
    const blob = record(`${integrity}\t${name}@${version}`);
    if (!(blob instanceof Uint8Array)) throw new Error(`Invalid package index blob: ${name}@${version}`);
    let supplementalLicense;
    if (`${name}@${version}` === cfworkerLicense.package) {
      supplementalLicense = await readFile(join(root, cfworkerLicense.path));
    }
    verifyPackage(name, version, decode(blob), files, supplementalLicense);
    if (supplementalLicense) {
      await writePackageFiles(join(output, 'artifacts/licenses'), new Map([['cfworker.txt', supplementalLicense]]));
    }
    const shipped = runtimePackageFiles(files, modules);
    await writePackageFiles(destination, shipped);
    copied.set(destination, key);
    if (!hoisted.has(name)) hoisted.set(name, reference);
    packages.push({ name, version, integrity, indexBlobSha256: digest('sha256', blob),
      path: relative(output, destination), files: shipped.size,
      bytes: [...shipped.values()].reduce((sum, bytes) => sum + bytes.length, 0) });
    const snapshot = lock.snapshots?.[key];
    if (!snapshot) throw new Error(`Missing locked dependency graph: ${key}`);
    for (const [dependency, selected] of Object.entries(snapshot.dependencies ?? {})) {
      await copy(dependency, selected, source, destination);
    }
    for (const [dependency, selected] of Object.entries(snapshot.optionalDependencies ?? {})) {
      await copy(dependency, selected, source, destination);
    }
  }
  await copy(sdk, reference, join(root, 'apps/api'), output);
  const selected = packages.find(entry => entry.name === sdk);
  await mkdir(join(output, 'artifacts'), { recursive: true, mode: 0o700 });
  await writeFile(join(output, 'artifacts/claude-sdk-lock.yaml'),
    `packages:\n  '${sdk}@${selected.version}':\n    resolution: {integrity: ${selected.integrity}}\n`,
    { flag: 'wx', mode: 0o600 });
  return packages;
}

export async function copySharpPackages({ root, output, lock, record, decode }) {
  const modules = join(root, 'node_modules/.pnpm'), installed = await readdir(modules), packages = [];
  for (const [name, version] of Object.entries(sharpPackages)) {
    const integrity = lock.packages?.[`${name}@${version}`]?.resolution?.integrity;
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error(`Missing locked integrity: ${name}`);
    const prefix = `${name.replace('/', '+')}@${version}`;
    const candidates = installed.filter(path => path === prefix || path.startsWith(`${prefix}_`));
    if (candidates.length !== 1) throw new Error(`Ambiguous installed package: ${name}`);
    const source = await realpath(join(modules, candidates[0], 'node_modules', name));
    const files = await regularFiles(source, { excludeNodeModules: true });
    const blob = record(`${integrity}\t${name}@${version}`);
    if (!(blob instanceof Uint8Array)) throw new Error(`Invalid package index blob: ${name}@${version}`);
    verifyPackage(name, version, decode(blob), files);
    for (const [path, bytes] of files) {
      const destination = join(output, 'node_modules', name, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      // Write the buffers that passed validation, never reread a mutable source.
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    }
    packages.push({ name, version, integrity, indexBlobSha256: digest('sha256', blob), files: files.size, bytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) });
  }
  return packages;
}

export async function artifactFiles(output) {
  return [...await regularFiles(output)].map(([path, bytes]) => ({ path, sha256: digest('sha256', bytes), size: bytes.length }));
}
