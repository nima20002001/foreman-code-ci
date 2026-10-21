/** Runs `file` under a detached supervisor that outlives the API with the deadline (and any lock descriptors the
 * command inherits). `timeout` runs the command in its own process group and stops it at expiry; whenever it ends, or
 * the caller sends SIGTERM, every process left in that group is killed so none keeps those descriptors. */
export function underDeadline(timeoutMs: number, file: string, args: readonly string[]): [string, string[]] {
  return ['/bin/sh', ['-c', 'trap \'kill -KILL -$! $! 2>/dev/null; exit 143\' TERM; '
    + 'timeout --signal=TERM --kill-after=0.25s "$@" & wait $!; status=$?; kill -KILL -$! 2>/dev/null; exit $status',
  'deadline', `${timeoutMs / 1000}s`, file, ...args]]
}
