import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative, isAbsolute, sep } from 'node:path';

// A reboot keeps flushed file contents and flushed directory entries separately.
// The real filesystem still performs every install operation and recovery read.
export async function recordPersistence(t, root) {
  const disk = { ...fs };
  const persisted = new Map();
  const snapshots = [];
  const rootId = String((await disk.lstat(root)).ino);
  const inside = path => typeof path === 'string'
    && !isAbsolute(relative(root, path))
    && relative(root, path) !== '..'
    && !relative(root, path).startsWith(`..${sep}`);

  async function entry(path) {
    const info = await disk.lstat(path);
    const id = String(info.ino);
    const node = { id, mode: info.mode & 0o777, kind: 'file' };
    if (info.isDirectory()) node.kind = 'directory';
    if (info.isSymbolicLink()) {
      node.kind = 'link';
      node.target = await disk.readlink(path);
      // Symlink targets are immutable; a reused inode can belong to a different link.
      node.id = `${id}:${node.target}`;
    }
    return node;
  }

  async function flush(path, recursive = false) {
    const node = await entry(path);
    if (node.kind === 'directory') {
      node.children = [];
      for (const name of await disk.readdir(path)) {
        const childPath = join(path, name);
        const child = await entry(childPath);
        node.children.push({ name, id: child.id });
        if (!persisted.has(child.id)) {
          if (child.kind === 'directory') child.children = [];
          if (child.kind === 'file') child.bytes = Buffer.alloc(0);
          persisted.set(child.id, child);
        }
        if (recursive) await flush(childPath, true);
      }
    } else if (node.kind === 'file') {
      node.bytes = await disk.readFile(path);
    }
    persisted.set(node.id, node);
  }

  await flush(root, true);
  const snapshot = label => snapshots.push({ label, nodes: structuredClone(persisted) });
  const mocks = [];
  mocks.push(t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await disk.open(path, ...args);
    if (inside(path)) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        snapshot(`before sync ${relative(root, path) || '.'}`);
        await sync();
        await flush(path);
        snapshot(`after sync ${relative(root, path) || '.'}`);
      };
    }
    return handle;
  }));
  for (const operation of ['mkdir', 'copyFile', 'rename', 'symlink']) {
    mocks.push(t.mock.method(fs, operation, async (...args) => {
      const path = ['copyFile', 'rename', 'symlink'].includes(operation) ? args[1] : args[0];
      const observed = inside(path);
      if (observed) snapshot(`before ${operation} ${relative(root, path)}`);
      const result = await disk[operation](...args);
      if (observed) snapshot(`after ${operation} ${relative(root, path)}`);
      return result;
    }));
  }
  syncBuiltinESMExports();

  return {
    snapshots,
    stop() {
      for (const mock of mocks) mock.mock.restore();
      syncBuiltinESMExports();
    },
    async reboot(snapshot) {
      await disk.rm(root, { recursive: true, force: true });
      async function restore(id, path) {
        const node = snapshot.nodes.get(id);
        if (!node) throw new Error('A persisted directory entry has no inode in the snapshot');
        if (node.kind === 'directory') {
          await disk.mkdir(path, { mode: node.mode });
          for (const child of node.children) await restore(child.id, join(path, child.name));
        } else if (node.kind === 'link') {
          await disk.symlink(node.target, path);
        } else {
          await disk.writeFile(path, node.bytes, { mode: node.mode });
        }
      }
      await restore(rootId, root);
    },
  };
}
