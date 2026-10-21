import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export function quotaHelperRequirements(header, metadata) {
  if (header.length < 64 || header.subarray(0, 4).toString('hex') !== '7f454c46'
    || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) {
    throw new Error('Quota observer must be a Linux x64 ELF executable');
  }
  const interpreter = metadata.match(/Requesting program interpreter:\s*([^\]]+)\]/)?.[1];
  const libraries = [...metadata.matchAll(/\(NEEDED\).*?Shared library:\s*\[([^\]]+)\]/g)]
    .map(match => match[1]);
  const versions = [...new Set([...metadata.matchAll(/Name:\s+(GLIBC_[\w.]+)/g)].map(match => match[1]))];
  return { interpreter, libraries, versions };
}

export function validateQuotaHelperRequirements(requirements, target) {
  const targetVersion = /^glibc-(\d+)\.(\d+)$/.exec(target.libc);
  if (!targetVersion || target.arch !== 'x64') throw new Error('Unsupported quota observer target');
  if (requirements.interpreter !== '/lib64/ld-linux-x86-64.so.2'
    || requirements.libraries.length !== 1 || requirements.libraries[0] !== 'libc.so.6'
    || requirements.versions.length === 0) {
    throw new Error('Quota observer has unsupported loader or library requirements');
  }
  const maximum = targetVersion.slice(1).map(Number);
  for (const version of requirements.versions) {
    // The relative-relocation ABI tag represents glibc 2.36 loader support.
    const numericVersion = version === 'GLIBC_ABI_DT_RELR' ? 'GLIBC_2.36' : version;
    const match = /^GLIBC_(\d+)\.(\d+)(?:\.(\d+))?$/.exec(numericVersion);
    if (!match) throw new Error(`Unsupported quota observer symbol version: ${version}`);
    const required = match.slice(1).map(value => Number(value ?? 0));
    const tooRecent = required[0] > maximum[0]
      || required[0] === maximum[0] && (required[1] > maximum[1]
        || required[1] === maximum[1] && required[2] > 0);
    if (tooRecent) throw new Error(`Quota observer requires ${version}, exceeding ${target.libc}`);
  }
  return requirements;
}

export async function inspectQuotaHelperAbi(file, target) {
  const header = await readFile(file);
  const metadata = execFileSync('readelf', ['--wide', '--program-headers', '--dynamic', '--version-info', file],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return validateQuotaHelperRequirements(quotaHelperRequirements(header, metadata), target);
}
