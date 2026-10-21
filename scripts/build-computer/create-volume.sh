#!/bin/sh
set -eu
backing=${1:?usage: create-volume.sh <new-backing-file> <size>}
size=${2:?volume size required}

# Refuse replacement before sizing or formatting touches the destination.
(set -C; : > "$backing")
truncate -s "$size" "$backing"
mkfs.ext4 -q -O quota,project -E quotatype=prjquota "$backing"
