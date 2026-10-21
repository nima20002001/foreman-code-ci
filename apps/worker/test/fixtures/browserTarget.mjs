import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function browserHostTarget() {
  const release = await readFile('/etc/os-release', 'utf8');
  const fields = Object.fromEntries(release.split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/g, '')];
  }));
  return { os: fields.ID, osRelease: fields.VERSION_ID, arch: process.arch,
    libc: `glibc-${process.report.getReport().header.glibcVersionRuntime}`, node: process.version };
}

export function matchesBrowserTarget(host, target) {
  return ['os', 'osRelease', 'arch', 'libc', 'node'].every(key => host[key] === target[key]);
}

export async function nativeWorkerTarget(repository) {
  const host = await browserHostTarget();
  for (const directory of ['apps/worker/artifacts', 'apps/worker/artifacts/test-hosts']) {
    for (const name of (await readdir(join(repository, directory))).sort()) {
      if (!name.endsWith('-target.json')) continue;
      const file = `${directory}/${name}`;
      const target = JSON.parse(await readFile(join(repository, file), 'utf8'));
      if (matchesBrowserTarget(host, target)) return { file, target };
    }
  }
  throw new Error(`No committed Worker target matches the native test host: ${JSON.stringify(host)}`);
}
