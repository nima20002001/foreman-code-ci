# Ubuntu laptop CI profile and H2 approval manifest

This is a source/provisioning proposal, not installation or live qualification
evidence. The orchestrator reported Ubuntu 24.04 x86_64, kernel 7.0.0-34,
ordinary ext4 root/home, about 198 GB free and existing user linger. The later
orchestrator report records signed-hash-verified Node **22.23.3** and verified
Podman **4.9.3**, uidmap, slirp and fuse-overlay installation under the separate
dependency approval. CI-A performed none of those actions. The bounded volume
and its mount remain **unapproved**. Recheck current facts in H2 before action.

The sole proposed filesystem profile is a dedicated, fully preallocated ext4
loop-backed CI volume. Rootless OCI execution uses only a directory bind from
that volume; no loop device, host socket, host home or host namespace enters
the build. Root filesystem features, its mount options, SSH, router policy,
sysctls and service/security settings are not changed by this proposal. There
is no automatic ordinary-ext4, XFS, worktree or unbounded storage fallback.

H2 must approve the exact following installation/provisioning facts before
anything runs. These are independent of requesting a product qualification:

| Item | Exact approval requirement |
| --- | --- |
| Runtime packages | Actual Ubuntu package versions/digests for Podman, its OCI runtime/conmon and required rootless storage helpers, resolved by the orchestrator from the selected host's package metadata. No `latest`, automatic update or install is authorized by this document. |
| Worker Node | Existing W07 worker artifact with supported Node >=22, its exact version and artifact digest, installation directory and existing approved service identity. Provider login is unnecessary. Linger already exists; this document does not change it. |
| Build image | Exact existing OCI image digest and provenance, containing Node >=22, Corepack, pnpm **11.27.0**, Git, util-linux/flock and prepared frozen-lockfile build dependencies. Image/dependency acquisition needs separate explicit network approval. Qualification never pulls or installs. |
| Storage budget | Exact finite bytes, source/runtime paths, backing file, worker uid/gid and capacity slot. A 32 GiB volume is a review candidate within the reported free space, not an approved or discovered limit. CPU/RAM/pids values must use actual W08 capacity. |
| Filesystem setup | Human-authorized admin creation of the preallocated regular backing file, ext4 formatting of **that file only**, root-owned protected backing directory/file, fixed-size loop association and manual mount with `rw,nosuid,nodev,nodiscard`. No root block device is formatted or root filesystem reconfigured. |
| Root registration | W12/W09 register the actual resulting source/runtime directories, mount/device/inode identity and exclusive-write binding through their existing authorized product services. No invented root/resource/device ID. |
| Reboot | No new fstab/systemd/mount policy is proposed. After reboot/unmount, the original profile is unavailable until the approved storage is restored and the new boot/mount context is explicitly qualified. No build automatically restarts. |

For H2 review, the admin action template is below. It is **not executable
authorization**. The orchestrator must resolve and review literal approved
paths, bytes, user/group and package/image digests before presenting it for
permission. Never substitute the root device for `BACKING_FILE`.

```text
Create protected backing directory (root:approved-worker-group, mode 0750).
Create a sparse BACKING_FILE with logical size APPROVED_BYTES.
Format BACKING_FILE with mkfs.ext4 and project quotas. Physical allocation grows
  as the volume is used; the installer defaults to a 32 GiB logical ceiling.
Keep BACKING_FILE root-owned, one link, mode 0440; worker group may read it
  for metadata verification but cannot write, truncate or resize it.
Associate the file with a loop device using offset 0 and sizelimit APPROVED_BYTES.
Mount that device at APPROVED_VOLUME_ROOT with rw,nosuid,nodev,nodiscard.
Create source/runtime directories on that same volume, owned by the approved
  worker account, mode 0700. The build only receives its private source bind.
Register actual root-policy/binding/attestation facts and protected runtime
  metadata; request human approval of their complete fingerprint.
```

The producer checks the actual findmnt result, `/sys/dev/block/7:N/loop`
backing/offset/sizelimit, kernel block device sectors, backing file
device/inode/size/permissions and ext4 statfs geometry. Sparse allocation is
accepted; worker-writable, resized, linked, ordinary-root or different mounts fail.
Source and retained logs must share the same finite filesystem. Neither a
caller byte limit nor a saved `ready` JSON object proves these facts.

The same OCI create arguments are used by jobs and qualification: local-only
rootless Podman, no pull/restart/network, private pid/ipc/cgroup namespaces,
all capabilities dropped, no-new-privileges, readonly image, one private source
mount, bounded tmpfs and measured CPU/memory/pids/swap controls. An empty owned
OCI hook directory exists only inside the already approved runtime root;
unexpected mounts or inherited credentials reject the probe.

Qualification uses the existing admitted HRT owner. Reservations precede
guarded native entry; original native exit receipts distinguish wrapper cleanup
from process outcome. The owned container ID/labels and captured cgroup must
prove descendant closure, then the actual owner must close. Unknown closure
retains the original operation for recovery. Approval/context changes or
expiry reject publication; GET performs no native probe.

After installation/root/image approval and product candidate capture, the
orchestrator runs the authenticated product diagnostic. Paired, authorized
computers qualify the captured candidate directly, without another human approval:

```sh
node scripts/ci-runtime-qualification.mjs \
  --config "$CI_QUALIFICATION_CONFIG" \
  --evidence-dir "$CI_QUALIFICATION_EVIDENCE_DIR"
```

The config lives outside build/source mounts, references an existing
approvalId and retained commandId, and names a credential environment variable.
The command never self-approves or directly launches Podman. It POSTs the
existing approval's `/api/management/workspaces/:workspaceId/jobs/runtime-qualifications/:approvalId/run`
and verifies the same qualification/fingerprint through authenticated GET.
Root alone runs this diagnostic and integration/laptop acceptance. Unit tests,
CLI help, package builds and typechecks are not physical qualification evidence.

## Verification storage and measurement

Verification retains approved ext4 storage and rootless Podman. Its version 3
fingerprint additionally requires effective workload byte/inode quotas and the
canonical device/ancestor enforcement facts. The finite device volume used by
the original build profile alone does not prove a per-Job quota. A larger
workload hard limit than the accepted reservation, insufficient inode
enforcement, an unmeasured suite or absent owner review denies verification
entry. This source change does not format, resize, mount or configure a volume.

Source, private store/node_modules, Git/scheduler metadata, workload scratch,
report reserve and retained logs are charged through their accepted namespace
and storage lifecycle. Control temp and private shm must fit the Job memory
limit; storage sub-budgets are not additional device capacity. Device control
headroom is already accounted for by the shared provisioning contract and is
not subtracted again at launch.

`measureVerificationResourceUsage` reads the original active OCI certificate,
boot/owner/cgroup identity, cgroup counters and private namespace allocation.
Hard-linked store content is counted once and symlinks are not followed. Samples
include the private report reserve and retained OCI log; they report byte/inode
pressure rather than substituting host free-space estimates. The orchestrator
must retain repeated cold-cache samples through install, suite execution and
cleanup and publish measured requirements, not universal proposed minima.

The authenticated qualification CLI has separate verification readback mode.
It requires the original version 2 measurement and saved profile agreement and
retains per-suite cold-cache peaks and measured concurrency. It does not invent
an approval, run a replacement operation or turn a build result into
verification evidence. Initial qualification remains one heavy Job, one unit
worker and one integration shard. Actual resource envelopes, safe higher
concurrency and bounded approval validity require owner review and measurements
on the approved device.
