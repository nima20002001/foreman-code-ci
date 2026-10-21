#!/bin/bash
# Sourced by the cloud suite so its subprocesses inherit the user bus address.
enable_ci_user_systemd() {
  local command uid
  for command in sudo loginctl systemctl systemd-run; do
    if ! command -v "$command" >/dev/null; then
      echo "User systemd unavailable: executor is missing $command." >&2
      return 1
    fi
  done
  if ! systemctl show --property=Version --value >/dev/null; then
    echo 'User systemd unavailable: executor has no running system manager.' >&2
    return 1
  fi
  uid="$(id -u)"
  export XDG_RUNTIME_DIR="/run/user/$uid"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  if ! sudo -n loginctl enable-linger "$(id -un)" \
    || ! sudo -n systemctl start "user@$uid.service" \
    || ! systemctl --user start dbus.socket; then
    echo 'User systemd unavailable: executor could not start the user manager and D-Bus session.' >&2
    return 1
  fi
  if ! systemd-run --user --wait --collect --quiet --property=Delegate=yes \
    --unit="foreman-ci-systemd-probe-$$" /usr/bin/true; then
    echo 'User systemd unavailable: delegated user service probe failed.' >&2
    return 1
  fi
  echo 'User systemd ready: delegated user service probe passed.'
}

enable_ci_user_systemd
