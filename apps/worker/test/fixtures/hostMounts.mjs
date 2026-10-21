import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

export const persistentHostMounts = '1 0 8:1 / / rw - ext4 /dev/root rw\n'
  + '2 1 0:2 / /dev/shm rw - tmpfs tmpfs rw\n';

// Model only OS mount evidence; ownership, permissions, inodes and file contents stay real.
export function mockHostMounts(mock, mounts) {
  const readFile = fs.readFile;
  const mocked = mock.method(fs, 'readFile', async (path, ...options) => {
    if (path === '/proc/self/mountinfo') return mounts;
    return readFile(path, ...options);
  });
  syncBuiltinESMExports();
  return () => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  };
}
