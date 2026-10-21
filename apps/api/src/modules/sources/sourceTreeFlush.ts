import { spawn } from 'node:child_process'
import type { FileHandle } from 'node:fs/promises'
import { SourceError } from './manifest.js'
import { componentLogger } from '../diagnostics/logger.js'

// Data waits run on inherited original write descriptors, retaining their writeback
// error cursors. On journaled ext4, directory fsync forces a full metadata commit.
const script = String.raw`
import ctypes
import fcntl
import os
import stat
import sys
import resource

libc = ctypes.CDLL(None, use_errno=True)
libc.sync_file_range.argtypes = [ctypes.c_int, ctypes.c_int64, ctypes.c_int64, ctypes.c_uint]
libc.sync_file_range.restype = ctypes.c_int

root = os.fstat(3)
if not stat.S_ISDIR(root.st_mode) or root.st_uid != os.getuid() or root.st_mode & 0o077:
    raise OSError('Source root is not private')

def mount_id(fd):
    with open('/proc/self/fdinfo/' + str(fd)) as info:
        return next(line.split()[1] for line in info if line.startswith('mnt_id:'))

mount = mount_id(3)

def journaled_ext4():
    if ctypes.sizeof(ctypes.c_void_p) != 8 or int(os.uname().release.split('.')[0]) < 6:
        return False
    if resource.getrlimit(resource.RLIMIT_NOFILE)[0] < 262144:
        return False
    with open('/proc/self/mountinfo') as info:
        mounted = next(line for line in info if line.split()[0] == mount)
    filesystem, device_path, options = mounted.split(' - ', 1)[1].split()
    if filesystem != 'ext4' or any(option == 'dax' or option.startswith('dax=') and option != 'dax=never' for option in options.split(',')):
        return False
    inode_flags = bytearray(8)
    fcntl.ioctl(3, 0x80086601, inode_flags, True)
    if int.from_bytes(inode_flags[:4], sys.byteorder) & 0x02000000:
        return False
    device = os.path.basename(os.path.realpath('/sys/dev/block/' + str(os.major(root.st_dev)) + ':' + str(os.minor(root.st_dev))))
    try:
        with open('/sys/fs/ext4/' + device + '/journal_task') as info:
            task = info.read().strip()
    except (FileNotFoundError, PermissionError):
        return False
    if not task.isdecimal() or int(task) <= 0:
        return False
    try:
        with open('/proc/' + task + '/comm') as info:
            return info.read().strip().startswith('jbd2/' + device + '-')
    except (FileNotFoundError, PermissionError):
        return False

mode = sys.argv[1]
if mode in ('filesystem-qualify', 'filesystem'):
    version = tuple(int(part) for part in os.uname().release.split('-')[0].split('.')[:2])
    # Earlier kernels do not report filesystem writeback errors through syncfs.
    if version < (5, 8) or not hasattr(libc, 'syncfs'):
        sys.exit(2)
    if mode == 'filesystem':
        libc.syncfs.argtypes = [ctypes.c_int]
        libc.syncfs.restype = ctypes.c_int
        if libc.syncfs(3) != 0:
            raise OSError(ctypes.get_errno(), 'Source filesystem writeback failed')
    sys.exit(0)
elif mode == 'qualify':
    sys.exit(0 if journaled_ext4() else 2)
if mode == 'data':
    descriptors = range(4, 4 + int(sys.argv[2]))
    for fd in descriptors:
        file = os.fstat(fd)
        if not stat.S_ISREG(file.st_mode) or file.st_nlink != 1 or file.st_dev != root.st_dev or mount_id(fd) != mount:
            raise OSError('Source file changed')
    # Queue every file before waiting on any one file. The second pass waits
    # existing writeback and schedules any redirtied pages; the last joins it.
    for flags in (2, 3, 5):
        for fd in descriptors:
            if libc.sync_file_range(fd, 0, 0, flags) != 0:
                raise OSError(ctypes.get_errno(), 'Source data writeback failed')
elif mode == 'metadata':
    if not journaled_ext4():
        sys.exit(2)
    # Register a metadata update after every data wait, including when an earlier
    # transaction has already committed. Directory fsync forces a full journal
    # commit and its device barrier, covering all preceding inode/entry updates.
    os.utime(3, None)
    os.fsync(3)
else:
    raise OSError('Unknown source synchronization operation')
`

export async function flushSourceTree(tree: FileHandle, signal: AbortSignal,
  operation: { mode: 'qualify' | 'metadata' | 'filesystem-qualify' | 'filesystem' }
    | { mode: 'data'; files: readonly number[] }): Promise<boolean> {
  signal.throwIfAborted()
  await tree.stat()
  const files = operation.mode === 'data' ? operation.files : []
  const started = performance.now()
  const flushed = await new Promise<boolean>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', script, operation.mode, String(files.length)], {
      stdio: ['ignore', 'ignore', 'ignore', tree.fd, ...files], signal, killSignal: 'SIGKILL',
    })
    let failure: Error | undefined
    child.once('error', error => { failure = error })
    child.once('close', code => {
      if (signal.aborted) reject(signal.reason)
      // Hosts without the optional helper retain complete per-file fsync.
      else if (failure && 'code' in failure && failure.code === 'ENOENT') resolve(false)
      else if (failure) reject(failure)
      else if (code === 0) resolve(true)
      else if (code === 2) resolve(false)
      else reject(new SourceError('SOURCE_TREE_SYNC_FAILED', 'Source synchronization failed.'))
    })
  })
  signal.throwIfAborted()
  componentLogger('engine').debug({ operation: operation.mode, files: files.length,
    durationMs: Math.round(performance.now() - started) }, 'source synchronization completed')
  return flushed
}
