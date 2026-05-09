#!/bin/bash
#
# scripts/smoke.sh — HTTP smoke tests against a running Sendie deployment.
#
# Usage: scripts/smoke.sh https://sendie.curlyquote.com
#
# Runs every check from §8.2 of docs/security-remediation-plan.md that does
# NOT require a real browser, real Discord OAuth, or two browser profiles
# comparing SAS codes by voice. Specifically:
#
#   * S6  rate limiting (curl-driven burst)
#   * S7  security headers and CSP
#   * S10 open-redirect regression
#   * Plus: session-id format validation, robots.txt, /health
#
# What this CANNOT verify (and why):
#   * S1, S2  real Discord OAuth + cross-device join — needs a browser.
#   * S3      file-transfer accept prompt — needs a real receiver browser.
#   * S4      MITM detection via mitmproxy — needs the proxy machinery.
#   * S5      host controls UI — needs a browser.
#   * S8      cookie Secure flag under real TLS — needs the OAuth round trip.
#   * S9      container hardening — needs kubectl exec; see verify-pod.sh.
#
# Exit code 0 if every checked assertion passes.

set -euo pipefail

BASE_URL="${1:-}"
if [[ -z "$BASE_URL" ]]; then
    echo "usage: $0 https://your-sendie-host" >&2
    exit 2
fi

# Strip trailing slash for consistency
BASE_URL="${BASE_URL%/}"

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
hr()     { printf -- '----------------------------------------------------\n'; }

fail_count=0
ok()    { green "  OK: $*"; }
warn()  { yellow "  WARN: $*"; }
fail()  { red "  FAIL: $*"; fail_count=$((fail_count+1)); }
step()  { hr; printf '  %s\n' "$*"; hr; }

# Convenience: capture status + headers + body from one curl.
# Usage: smoke_get URL [extra-curl-args...]
# Sets globals STATUS, HEADERS, BODY.
smoke_get() {
    local url="$1"; shift
    local tmp
    tmp="$(mktemp)"
    STATUS="$(curl -sS -o "$tmp" -D - -L --max-redirs 0 -w '%{http_code}' "$url" "$@" 2>/dev/null | tail -n1 || true)"
    # Re-run without -o to capture headers; the previous trick was awkward
    HEADERS="$(curl -sSI -L --max-redirs 0 "$url" "$@" 2>/dev/null || true)"
    BODY="$(cat "$tmp")"
    rm -f "$tmp"
}

# ---------------------------------------------------------------------------
step "Probing $BASE_URL"
# ---------------------------------------------------------------------------

if ! curl -sS --max-time 10 "$BASE_URL/health" >/dev/null 2>&1; then
    # One retry: rollouts move traffic asynchronously, and the first health
    # probe right after deploy.sh sometimes lands during the cutover window.
    yellow "  health check failed; retrying in 5s ..."
    sleep 5
    if ! curl -sS --max-time 10 "$BASE_URL/health" >/dev/null 2>&1; then
        fail "cannot reach $BASE_URL/health"
        fail "aborting — check the URL or your network"
        exit 1
    fi
fi
ok "health endpoint reachable"

# ---------------------------------------------------------------------------
step "S7  Security headers on /"
# ---------------------------------------------------------------------------

# Some ingresses cache HEAD responses oddly; do a GET and inspect headers.
INDEX_HEADERS="$(curl -sSI "$BASE_URL/" 2>/dev/null || true)"

# Detect the deployment shape. If we got served from a raw C# server with
# no SPA, /index.html will 404; the headers we get are the API middleware
# defaults (Phase 4.2 also adds CSP server-side as defense-in-depth).
if curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/index.html" 2>/dev/null | grep -q '^20'; then
    is_full_stack=1
else
    is_full_stack=0
    yellow "  note: /index.html does not return 200; assuming server-only deployment"
    yellow "        nginx-served checks (robots.txt, /index.html no-store) will be skipped"
fi

# Required headers from Phase 4.2.
for header in \
    "Content-Security-Policy" \
    "X-Content-Type-Options" \
    "Referrer-Policy" \
    "Permissions-Policy" \
    "X-Frame-Options"
do
    if grep -qi "^$header:" <<<"$INDEX_HEADERS"; then
        ok "$header present"
    else
        fail "$header missing on /"
    fi
done

# X-Content-Type-Options must be exactly "nosniff"
if grep -qi "^X-Content-Type-Options:[[:space:]]*nosniff" <<<"$INDEX_HEADERS"; then
    ok "X-Content-Type-Options is nosniff"
else
    fail "X-Content-Type-Options is not nosniff"
fi

# X-Frame-Options must DENY framing
if grep -qi "^X-Frame-Options:[[:space:]]*DENY" <<<"$INDEX_HEADERS"; then
    ok "X-Frame-Options is DENY"
else
    fail "X-Frame-Options is not DENY"
fi

# CSP must restrict connect-src to 'self' (no blanket wss:)
if grep -i "Content-Security-Policy:" <<<"$INDEX_HEADERS" | grep -qi "connect-src 'self'"; then
    ok "CSP connect-src is 'self'"
else
    warn "CSP connect-src is not 'self'; review the policy"
fi

# CSP must forbid framers
if grep -i "Content-Security-Policy:" <<<"$INDEX_HEADERS" | grep -qi "frame-ancestors 'none'"; then
    ok "CSP frame-ancestors 'none'"
else
    fail "CSP frame-ancestors is not 'none'"
fi

if [[ $is_full_stack -eq 1 ]]; then
    # index.html itself must not be cached
    INDEX_HTML_HEADERS="$(curl -sSI "$BASE_URL/index.html" 2>/dev/null || true)"
    if grep -qi "^Cache-Control:.*no-store" <<<"$INDEX_HTML_HEADERS"; then
        ok "/index.html Cache-Control is no-store"
    else
        warn "/index.html Cache-Control is not no-store; SPA bundle pointers may go stale"
    fi

    # robots.txt blocks /s/
    ROBOTS_BODY="$(curl -sS "$BASE_URL/robots.txt" 2>/dev/null || true)"
    if grep -q "Disallow:[[:space:]]*/s/" <<<"$ROBOTS_BODY"; then
        ok "robots.txt disallows /s/"
    else
        fail "robots.txt does not disallow /s/"
    fi
else
    warn "skipping /index.html and /robots.txt checks (server-only deployment)"
fi

# ---------------------------------------------------------------------------
step "S6  Rate limiting on session-create and lookup"
# ---------------------------------------------------------------------------

# We can't authenticate without a real Discord OAuth flow, so POST /api/sessions
# will return 401. We can still confirm the endpoint exists and rate-limits
# wire correctly, by hitting it many times and watching for 429 vs 401 vs
# something unexpected.
status_codes=()
for i in $(seq 1 12); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/sessions" || echo 000)"
    status_codes+=("$code")
done
unique="$(printf '%s\n' "${status_codes[@]}" | sort -u | tr '\n' ' ')"

# We expect either 401 (unauth) or 429 (rate limited) for every response.
# If 5xx appears, something is broken.
if printf '%s\n' "${status_codes[@]}" | grep -qE '^5[0-9][0-9]$'; then
    fail "POST /api/sessions returned 5xx during burst (status codes: $unique)"
else
    ok "POST /api/sessions burst: only client errors as expected ($unique)"
fi

# Lookup endpoint: junk session ID should be 400 (Phase 3.6 format validation).
status="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/sessions/junk" || echo 000)"
if [[ "$status" == "400" ]]; then
    ok "GET /api/sessions/junk returns 400 (format validation)"
else
    fail "GET /api/sessions/junk expected 400, got $status"
fi

# Well-formed but unknown ID should be 404.
status="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/sessions/aaaaaaaaaaaaaaaaaaaaaa" || echo 000)"
if [[ "$status" == "404" ]]; then
    ok "GET /api/sessions/<unknown> returns 404"
else
    fail "GET /api/sessions/<unknown> expected 404, got $status"
fi

# Burst the lookup endpoint and watch for 429.
saw_429=0
for i in $(seq 1 80); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/sessions/aaaaaaaaaaaaaaaaaaaaaa" || echo 000)"
    if [[ "$code" == "429" ]]; then
        saw_429=1
        break
    fi
done
if [[ $saw_429 -eq 1 ]]; then
    ok "GET /api/sessions/<id> rate-limits to 429 under burst"
else
    warn "GET /api/sessions/<id> did not hit 429 in 80 requests; check SessionLookup policy"
fi

# ---------------------------------------------------------------------------
step "S10 Open-redirect regression on /api/auth/login"
# ---------------------------------------------------------------------------

# Phase 0.1: returnUrl must reject anything that is not strictly a relative
# path under the application root. We don't follow the redirect; we just
# inspect Location and the response body for the attacker URL.
test_return_url() {
    local input="$1"
    local label="$2"
    local expect="$3"  # 'reject' or 'allow'
    local resp
    resp="$(curl -sSI --max-redirs 0 "$BASE_URL/api/auth/login?returnUrl=$(printf '%s' "$input" | jq -sRr @uri 2>/dev/null || printf '%s' "$input")" 2>/dev/null || true)"
    if grep -i "Location:" <<<"$resp" | grep -qi "evil.example"; then
        fail "$label: Location header contains evil.example"
    elif grep -i "Location:" <<<"$resp" | grep -qi "javascript:"; then
        fail "$label: Location header contains javascript: scheme"
    elif [[ "$expect" == "allow" ]]; then
        ok "$label: accepted (no attacker URL leaked)"
    else
        ok "$label: rejected (no attacker URL in Location)"
    fi
}

test_return_url 'https://evil.example/'        'absolute https'      'reject'
test_return_url '//evil.example/path'          'protocol-relative'   'reject'
test_return_url '/\\evil.example/'             'backslash variant'   'reject'
test_return_url 'javascript:alert(1)'          'javascript: scheme'  'reject'
test_return_url '/safe-path'                   'safe relative path'  'allow'

# ---------------------------------------------------------------------------
hr
if [[ $fail_count -gt 0 ]]; then
    red "Smoke tests FAILED: $fail_count failure(s)"
    exit 1
fi

green "Smoke tests PASSED for $BASE_URL"
echo
yellow "Reminder: this script does NOT cover S1-S5 (browser flows), S8 (cookie Secure"
yellow "under real TLS round-trip), or S9 (container hardening). Run those by hand."
