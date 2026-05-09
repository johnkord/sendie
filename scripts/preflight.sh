#!/bin/bash
#
# scripts/preflight.sh — Local pre-deploy checks.
#
# Runs everything that does NOT need a deployed environment:
#   * server tests + build
#   * client tests + build
#   * grep-based hygiene checks (no third-party StreamSaver host, no debug
#     console.log noise leaking into production sources, no obvious secrets
#     in committed config files)
#   * deploy.sh / k8s manifest sanity checks
#
# Exit code 0 on success, non-zero on first failure. Suitable for CI and
# for running manually before pushing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
hr()     { printf -- '----------------------------------------------------\n'; }

fail_count=0
warn_count=0

step()    { hr; printf '  %s\n' "$*"; hr; }
ok()      { green "  OK: $*"; }
warn()    { yellow "  WARN: $*"; warn_count=$((warn_count+1)); }
fail()    { red "  FAIL: $*"; fail_count=$((fail_count+1)); }

# ---------------------------------------------------------------------------
step "1/7  Server tests"
# ---------------------------------------------------------------------------

if ! ( cd server/Sendie.Server.Tests && dotnet test --nologo --verbosity quiet 2>&1 | tail -5 ); then
    fail "dotnet test failed"
else
    ok "dotnet test passed"
fi

# ---------------------------------------------------------------------------
step "2/7  Client tests"
# ---------------------------------------------------------------------------

if ! ( cd client && npm test -- --run 2>&1 | tail -5 ); then
    fail "npm test failed"
else
    ok "npm test passed"
fi

# ---------------------------------------------------------------------------
step "3/7  Client production build"
# ---------------------------------------------------------------------------

if ! ( cd client && npm run build 2>&1 | tail -8 ); then
    fail "client build failed"
else
    ok "client build produced dist/"
fi

# ---------------------------------------------------------------------------
step "4/7  Hygiene: StreamSaver mitm is pinned to our origin"
# ---------------------------------------------------------------------------

# Phase 4.1: StreamSaver's package source contains a hardcoded default URL
# (https://jimmywarting.github.io/StreamSaver.js/mitm.html). That default
# string survives bundling but is overridden at module load by
# streamSaverInit.ts setting `streamSaver.mitm = '/streamsaver/mitm.html'`.
# We therefore check two things:
#   (a) the override path IS present in the bundle (proof the init ran),
#   (b) the third-party URL appears at most once (the dead default), not
#       multiple times (which would suggest something is still using it).

bundle="$(ls client/dist/assets/index-*.js 2>/dev/null | head -n1)"
if [[ -z "$bundle" ]]; then
    fail "could not find client/dist/assets/index-*.js"
else
    if grep -q '/streamsaver/mitm.html' "$bundle"; then
        ok "bundle contains override '/streamsaver/mitm.html'"
    else
        fail "bundle missing override path; streamSaverInit did not run"
    fi

    third_party_count="$(grep -o 'jimmywarting\.github\.io' "$bundle" | wc -l)"
    # Up to 2 occurrences are expected and harmless:
    #   1. StreamSaver's package source contains the URL as a default literal.
    #   2. Our streamSaverInit.ts has an assertion that includes the substring
    #      'jimmywarting.github.io' so a future bundler regression is caught.
    # Anything beyond 2 means somebody re-introduced an actual usage.
    if [[ "$third_party_count" -le 2 ]]; then
        ok "third-party StreamSaver host appears $third_party_count time(s) (dead literals only)"
    else
        fail "third-party StreamSaver host appears $third_party_count times; investigate"
    fi
fi

# Vendored files are present
if [[ -f client/public/streamsaver/mitm.html && -f client/public/streamsaver/sw.js ]]; then
    ok "client/public/streamsaver/{mitm.html,sw.js} present"
else
    fail "client/public/streamsaver/ missing files; run 'npm run vendor:streamsaver' in client/"
fi

# ---------------------------------------------------------------------------
step "5/7  Hygiene: secrets template does not configure CookieEncryptionKey"
# ---------------------------------------------------------------------------

# Phase 0.6: this placeholder was misleading and was removed. If it
# returns, somebody copied an old template back in.
if grep -q "CookieEncryptionKey" k8s/secrets.yaml.template 2>/dev/null; then
    fail "k8s/secrets.yaml.template re-introduces CookieEncryptionKey"
else
    ok "k8s/secrets.yaml.template is clean"
fi

# ---------------------------------------------------------------------------
step "6/7  Hygiene: appsettings.json does not embed Discord secrets"
# ---------------------------------------------------------------------------

# Discord client secret should only ever be supplied via the k8s Secret;
# it must never appear committed in appsettings.json. Empty strings are OK.
if grep -E '"ClientSecret"\s*:\s*"[^"]+"' server/Sendie.Server/appsettings.json >/dev/null 2>&1; then
    fail "server/Sendie.Server/appsettings.json contains a non-empty ClientSecret"
else
    ok "no committed ClientSecret in appsettings.json"
fi

# ---------------------------------------------------------------------------
step "7/7  Hygiene: production AllowedHosts is set"
# ---------------------------------------------------------------------------

if [[ -f server/Sendie.Server/appsettings.Production.json ]]; then
    if grep -q '"AllowedHosts"' server/Sendie.Server/appsettings.Production.json 2>/dev/null; then
        # AllowedHosts of "*" is intentional in production: the k8s ingress
        # is the actual host-filter, and a strict hostname here breaks
        # kubelet probes (which hit /health by pod IP).
        ok "appsettings.Production.json sets AllowedHosts (ingress is the real host filter)"
    else
        warn "appsettings.Production.json does not set AllowedHosts at all"
    fi
else
    warn "no appsettings.Production.json"
fi

# ---------------------------------------------------------------------------
hr
if [[ $fail_count -gt 0 ]]; then
    red "Preflight FAILED: $fail_count failure(s), $warn_count warning(s)"
    exit 1
fi

if [[ $warn_count -gt 0 ]]; then
    yellow "Preflight passed with $warn_count warning(s)"
else
    green "Preflight PASSED with no warnings"
fi
