import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSeedFile } from '../apps/worker/artifacts/ci-runtime/seed-policy.mjs';
import { buildCiRuntimeContext } from '../apps/worker/artifacts/ci-runtime/context.mjs';

export { buildCiRuntimeContext };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (![3, 4].includes(process.argv.length)) throw new Error('Usage: build-ci-runtime-context.mjs /new/private/context [/private/offline-seed-config.json]');
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let offlineSeed;
  if (process.argv[3]) {
    const path = resolve(process.argv[3]);
    const config = JSON.parse((await readSeedFile(dirname(path), path.slice(dirname(path).length + 1), 16384)).toString('utf8'));
    if (!config.directory?.startsWith('/') || !config.receiptPath?.startsWith('/')) throw new Error('Absolute reviewed seed paths required.');
    offlineSeed = config;
  }
  const receipt = await buildCiRuntimeContext({ repository, output: resolve(process.argv[2]), offlineSeed });
  console.log(JSON.stringify({ sourceCommit: receipt.sourceCommit, files: receipt.files.length }));
}
