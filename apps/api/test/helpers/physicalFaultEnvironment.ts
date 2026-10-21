import { userInfo } from 'node:os'

/** test-command isolates HOME/XDG; physical faults use the account's installed image and existing user bus. */
export function physicalFaultEnvironment(): Record<string, string> {
  const account = userInfo()
  const runtime = `/run/user/${account.uid}`
  return {
    HOME: account.homedir,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
    LANG: 'C.UTF-8',
  }
}
