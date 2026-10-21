# Independent Job project quotas

Verification Jobs use installer-provisioned ext4 project-quota directories. The
protected runtime descriptor and fingerprint record `quotaPool`: a pinned
`queryExecutable` and `queryBinarySha256`, the mounted `blockDevice`, the observed
`volumeCapacityInodes`, and independent `slots`. Each slot records a UUID
namespace, project ID, byte and inode hard limits, and its directory filesystem
identity. Project IDs are distinct from one another and from the control project.
The total hard limits, including control storage, fit the device and volume.

The worker artifact supplies the read-only `artifacts/job-quota-query` observer
and its C source. The artifact build requires a Linux x64 C compiler. Installation
preserves execution permission for this observer without granting elevated
privileges. The observer reads filesystem/project identity, inheritance, current
usage and hard limits using `FS_IOC_FSGETXATTR`, `Q_GETINFO` and `Q_GETQUOTA`.
The installer must explicitly provide any host permissions required for these
read operations. The application never runs quota mutation commands, adds
privileges, or exposes the observer as an agent tool. Its executable and digest
are protected installation inputs, not values supplied by a Job or agent.

The installer must provision every slot's project identity, inheritance and hard
limits before qualification. Readback alone does not establish enforcement:
qualification exercises byte and inode exhaustion and independent sibling
writes through the actual runtime. Its measured allowance and the reviewed
owner configuration bound admission to four Main Jobs or two laptop Jobs. The
source reservation service uses those same measured limits for verification
preparation. Other source workflows retain their existing limits.

A Job receives a fresh materialization UUID within its claimed quota slot. The
immutable source receipt records the slot; source, Git metadata, dependencies,
scratch and reports stay under that identity. Attempt and slot claims are synced
before source copying. Recovery restores the original claim and directory,
including a crash between writing the two claims.

After Main retains the canonical source snapshot and closes the process and
publication, it authorizes cleanup of that original Job directory. Cleanup is
bounded by the original deadline, preserves control-side release records, and
keeps the slot claimed until the kernel reports no remaining Job blocks or
inodes, including open deleted files. Cancellation applies the same rule to
incomplete preparations. Retried cleanup reads the original records and cannot
release or delete a later Job's ownership. Reservations are reclaimed only after
this physical cleanup succeeds.

Manual before-entry recovery is an explicitly reviewed signed stop operation. It
uses the grant's immutable expiry, including when the automatic cleanup budget
has expired. The CLI cannot renew that grant. It preserves native-entry fences,
checks any preparatory verification owner without treating metadata as a launch,
and retires that owner only after source/quota cleanup. Completed signed closure
replay reads the retained result and original journal without another cleanup.

Project-quota recovery records the original filesystem UUID and volume identity,
the current boot and restored root identity, and the reviewed block device. The
observer obtains UUIDs through read-only filesystem ioctls; capture stores the
observed UUID in the protected pool. Recovery checks UUID, project IDs, limits,
inheritance and namespace inodes before deleting the original materialization.
The existing immutable loopback backing-file proof remains available for volumes
that use it; its size is volume geometry rather than a single Job's allowance.

## Root-once installation

`scripts/build-computer/install.sh` is the only step that needs root on a build
computer. It installs rootless podman prerequisites, creates the ext4 project-quota
volume and mounts it persistently at `~/.local/share/foreman-code/ci-verification/volume`
as a system mount unit, installs the Worker artifact's quota observer with only
`cap_sys_admin`, and, given an installation plan, provisions the control and
per-Job quota directories (`provision-quotas.py`). After that, the app prepares the
offline package seed, verification image, protected runtime refresh and
requalification as the computer's own user (`build_computer_prepare`), including
automatically when a commit changes dependency files.
