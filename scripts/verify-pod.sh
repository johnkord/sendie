#!/bin/bash
#
# scripts/verify-pod.sh — Container hardening checks (S9 of remediation plan).
#
# Run inside the running server pod via:
#   kubectl exec -n sendie deployment/sendie-server -- /bin/sh -c \
#     "$(cat scripts/verify-pod.sh)"
#
# The script is shell-only (no bash) so it works in the slim aspnet image
# without us having to install anything. Exits 0 on success.

set -eu

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }

fail_count=0
ok()    { green "  OK: $*"; }
fail()  { red "  FAIL: $*"; fail_count=$((fail_count+1)); }
warn()  { yellow "  WARN: $*"; }

echo '----- Pod identity -----'
uid="$(id -u)"
gid="$(id -g)"
if [ "$uid" = "1001" ]; then
    ok "running as uid 1001 (non-root, Phase 5.1)"
else
    fail "running as uid $uid; expected 1001"
fi
if [ "$gid" = "1001" ]; then
    ok "primary gid is 1001"
else
    warn "gid is $gid; expected 1001 but fsGroup may have remapped"
fi

echo '----- Filesystem permissions on Data Protection keys -----'
keys_dir='/app/data/keys'
if [ -d "$keys_dir" ]; then
    perms="$(stat -c '%a' "$keys_dir" 2>/dev/null || echo unknown)"
    owner="$(stat -c '%U:%G' "$keys_dir" 2>/dev/null || echo unknown)"
    # k8s fsGroup re-applies group-writable perms on mount, and existing
    # PVC contents may be owned by root from a pre-Phase-5 deploy. What
    # actually matters: appuser can read/write these files. Either owner
    # or group set to appuser is sufficient given that nothing else runs
    # in this container.
    case "$owner" in
        appuser:appuser|1001:1001|*:appuser|*:1001)
            ok "$keys_dir is accessible to appuser ($owner, mode $perms)"
            ;;
        *)
            fail "$keys_dir is not appuser-accessible (owner=$owner, mode=$perms)"
            ;;
    esac
else
    fail "$keys_dir does not exist; Data Protection cannot persist keys"
fi

# allowlist.json: same logic
if [ -f /app/data/allowlist.json ]; then
    owner="$(stat -c '%U:%G' /app/data/allowlist.json 2>/dev/null || echo unknown)"
    case "$owner" in
        appuser:appuser|1001:1001|*:appuser|*:1001)
            ok "/app/data/allowlist.json accessible to appuser ($owner)"
            ;;
        *)
            fail "/app/data/allowlist.json not appuser-accessible (owner=$owner)"
            ;;
    esac
fi

echo '----- Process capabilities -----'
if [ -r /proc/1/status ]; then
    capbnd="$(awk '/^CapBnd:/ {print $2}' /proc/1/status)"
    # 0000000000000000 means all capabilities have been dropped.
    if [ "$capbnd" = "0000000000000000" ]; then
        ok "all capabilities dropped (CapBnd=$capbnd)"
    else
        warn "CapBnd=$capbnd; expected 0000000000000000 if drop:[ALL] is in pod spec"
    fi
fi

echo '----- Listening ports -----'
# We expect ASP.NET to listen on 8080. ASP.NET binds to [::]:8080 (IPv6
# dual-stack), so the entry is in /proc/net/tcp6 with a 32-hex-char address.
# Port 8080 == 0x1F90.
if command -v ss >/dev/null 2>&1; then
    if ss -tnlp 2>/dev/null | grep -E '(:8080|:1F90)' >/dev/null; then
        ok "TCP 8080 is listening (via ss)"
    else
        fail "TCP 8080 not listening (via ss)"
    fi
elif [ -r /proc/net/tcp ] || [ -r /proc/net/tcp6 ]; then
    if grep -qiE ': [0-9A-F]+:1F90 ' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
        ok "TCP 8080 is listening (via /proc/net/tcp{,6})"
    else
        fail "TCP 8080 not listening (via /proc/net/tcp{,6})"
    fi
else
    warn "no ss(1) and no /proc/net/tcp{,6}; cannot verify port listening state"
fi

echo
if [ $fail_count -gt 0 ]; then
    red "Pod verification FAILED: $fail_count failure(s)"
    exit 1
fi
green "Pod verification PASSED"
