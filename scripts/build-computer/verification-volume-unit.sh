#!/bin/sh
set -eu
backing=${1:?path to verification backing file}
volume=${2:?verification mount point}
cat <<UNIT
[Unit]
Description=Foreman Code CI verification volume

[Mount]
What=$backing
Where=$volume
Type=ext4
Options=loop,nosuid,nodev,prjquota,discard

[Install]
WantedBy=multi-user.target
UNIT
