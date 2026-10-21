#!/bin/sh
# Root-once setup for a computer that runs CI Jobs. Everything later (offline packages, image,
# protected runtime refresh and requalification) the app does itself as the computer's user.
#
#   sudo [BACKING=/existing/volume.ext4] scripts/build-computer/install.sh <user> <job-quota-query> [volume-GiB] [installation-plan.json]
#
# BACKING adopts an already provisioned volume file (its protected runtime records that path).
#
# - an ext4 volume with project quotas, mounted persistently at ~/.local/share/foreman-code/ci-verification/volume
# - the read-only quota observer from the Worker artifact, with only the capability its quota reads need
# - rootless podman prerequisites (podman, crun, subordinate ids)
# - with an installation plan: the control and per-Job quota directories (provision-quotas.py)
set -eu
user=${1:?usage: install.sh <user> <job-quota-query> [volume-GiB] [installation-plan.json]}
observer=${2:?path to artifacts/job-quota-query in the Worker artifact}
size=${3:-32}
plan=${4:-}
[ "$(id -u)" -eq 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
home=$(getent passwd "$user" | cut -d: -f6)
[ -n "$home" ] || { echo "Unknown user $user." >&2; exit 1; }
base=$home/.local/share/foreman-code/ci-verification
volume=$base/volume
backing=${BACKING:-/var/lib/foreman-code-ci/verification.ext4}

apt-get install -y --no-install-recommends podman crun uidmap e2fsprogs quota libcap2-bin
grep -q "^$user:" /etc/subuid || usermod --add-subuids 100000-165535 "$user"
grep -q "^$user:" /etc/subgid || usermod --add-subgids 100000-165535 "$user"

# The Worker measures the backing file at capture: its directory stays traversable, not listable.
[ -d "$(dirname "$backing")" ] || install -d -m 0711 "$(dirname "$backing")"
if [ ! -f "$backing" ]; then
  sh "$(dirname "$0")/create-volume.sh" "$backing" "${size}G"
fi
for directory in "$home/.local/share/foreman-code" "$base" "$volume"; do
  [ -d "$directory" ] || install -d -m 0700 -o "$user" -g "$(id -gn "$user")" "$directory"
done
unit=$(systemd-escape -p --suffix=mount "$volume")
sh "$(dirname "$0")/verification-volume-unit.sh" "$backing" "$volume" > "/etc/systemd/system/$unit"
systemctl daemon-reload
systemctl enable --now "$unit"
# Updating an active mount unit does not apply its options until remounted.
mount -o remount,discard "$volume"
# Reclaim blocks deleted before discard was enabled as well.
fstrim "$volume"
# An adopted volume keeps its own root ownership and modes.
if [ -z "${BACKING:-}" ]; then chown "$user:$(id -gn "$user")" "$volume"; chmod 0700 "$volume"; fi

# The protected runtime pins the observer's digest: an installed observer is never replaced here.
if [ ! -x /usr/local/lib/foreman-code-ci/job-quota-query ]; then
  install -d -m 0755 /usr/local/lib/foreman-code-ci
  install -m 0755 "$observer" /usr/local/lib/foreman-code-ci/job-quota-query
  setcap cap_sys_admin=ep /usr/local/lib/foreman-code-ci/job-quota-query
fi

if [ -n "$plan" ]; then python3 "$(dirname "$0")/provision-quotas.py" "$plan"; fi
echo "Build computer volume ready at $volume"
