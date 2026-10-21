import { accessSync, constants, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Discover installed user tools without sourcing profiles or inheriting a caller's
// PATH. NVM's npm launchers are symlinks into the same user-owned installation.
export function workerPath(home, node) {
  const directories = [dirname(node), '/usr/bin', '/bin'];
  const uid = process.getuid();
  const optionalAbsence = error => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  };
  function owned(path, directory, owner = uid) {
    const info = lstatSync(path);
    const writable = owner === 0 ? 0o022 : 0o002;
    return info.uid === owner && !(info.mode & writable) && (directory ? info.isDirectory() : info.isFile());
  }
  function trusted(path, directory = true, root = home, owner = uid) {
    if (!path.startsWith(`${root}/`)) return false;
    const parts = relative(root, path).split('/');
    let current = root;
    if (!owned(current, true, owner)) return false;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      if (!owned(current, i < parts.length - 1 || directory, owner)) return false;
    }
    return true;
  }
  function add(directory, root = home, owner = uid) {
    try {
      if (!trusted(directory, true, root, owner)) return;
      const installed = ['codex', 'claude'].some((name) => {
        try {
          const launcher = realpathSync(join(directory, name));
          if (!trusted(launcher, false, root, owner)) return false;
          accessSync(launcher, constants.X_OK);
          return true;
        } catch (error) { optionalAbsence(error); return false; }
      });
      if (installed) directories.push(directory);
    } catch (error) { optionalAbsence(error); }
  }
  add('/usr/local/bin', '/usr', 0);
  let canonicalHome;
  try {
    if (typeof home === 'string' && home.startsWith('/') && resolve(home) === home
      && /^[/a-zA-Z0-9_.-]+$/.test(home) && owned(home, true)) {
      canonicalHome = realpathSync(home);
    }
  } catch (error) { optionalAbsence(error); }
  if (canonicalHome && /^[/a-zA-Z0-9_.-]+$/.test(canonicalHome)) {
    // Resolve ancestors before checking installations; the home itself cannot be a symlink.
    home = canonicalHome;
    add(join(home, '.local/bin'));
    const versions = join(home, '.nvm/versions/node');
    try {
      if (trusted(versions)) {
        for (const entry of readdirSync(versions, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))) add(join(versions, entry.name, 'bin'));
      }
    } catch (error) { optionalAbsence(error); }
  }
  return [...new Set(directories)].join(':');
}
