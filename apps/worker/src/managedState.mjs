import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { anchored, openChildDirectory } from '../../../apps/api/src/modules/sources/privateFilesystem.ts';
import { readPrivateJson } from './jobRuntimeCapture.mjs';

export async function optionalManagedJson(directory, name, maximumBytes = 65536) {
  try { return await readPrivateJson(directory, name, maximumBytes); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function managedEntryExists(directory, name) {
  try { await lstat(anchored(directory, name)); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function publishManagedJson(directory, name, value) {
  const temporary = `.managed-${randomUUID()}`;
  const path = anchored(directory, temporary);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(path, anchored(directory, name));
    await directory.sync();
  } finally {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function createManagedStorage(stateDirectory) {
  const managed = await openChildDirectory(stateDirectory, 'managed', true);
  try {
    for (const name of ['workspaces', 'runtime']) {
      const child = await openChildDirectory(managed, name, true);
      try { await child.sync(); } finally { await child.close(); }
    }
    await managed.sync();
    await stateDirectory.sync();
  } finally { await managed.close(); }
}
