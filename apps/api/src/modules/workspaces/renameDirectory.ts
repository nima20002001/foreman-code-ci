import { execFile } from 'node:child_process'
import { constants } from 'node:os'
import { promisify } from 'node:util'

const renameProgram = `
import ctypes, errno, os, sys
libc = ctypes.CDLL(None, use_errno=True)
try:
    rename = libc.renameat2
except AttributeError:
    sys.stderr.write(os.strerror(errno.ENOSYS))
    sys.exit(errno.ENOSYS)
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
rename.restype = ctypes.c_int
AT_FDCWD = -100
RENAME_NOREPLACE = 1
if rename(AT_FDCWD, os.fsencode(sys.argv[1]), AT_FDCWD, os.fsencode(sys.argv[2]), RENAME_NOREPLACE) != 0:
    code = ctypes.get_errno()
    sys.stderr.write(os.strerror(code))
    sys.exit(code)
`

/** Returns false on collision; unsupported atomic moves fail without copying. */
export async function renameDirectory(source: string, destination: string): Promise<boolean> {
  try {
    // Node rename can replace an empty directory. The kernel checks exclusivity atomically.
    await promisify(execFile)('python3', ['-I', '-c', renameProgram, source, destination])
    return true
  } catch (error) {
    if ((error as { code?: unknown }).code === constants.errno.EEXIST) return false
    throw error
  }
}
