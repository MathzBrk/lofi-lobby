#!/usr/bin/env bash
# Gives /stats its read access: a Cloudflare token with only "Account Analytics Read", made with the
# Keychain "token maker" (cf-token-setup), saved as the Worker secrets CF_API_TOKEN and CF_ACCOUNT_ID.
# No secret value is printed or written to disk.
#   bash scripts/stats-token.sh
set -euo pipefail
WORKER=lofi-lobby
MAKER=$(security find-generic-password -a "$USER" -s cloudflare-token-maker -w) || { echo "run cf-token-setup first"; exit 1; }
ACCOUNT=$(npx --yes wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)
[ -n "$ACCOUNT" ] || { echo "account id not found (npx wrangler login)"; exit 1; }
MAKER="$MAKER" ACCOUNT="$ACCOUNT" python3 - <<'PY' | npx --yes wrangler secret put CF_API_TOKEN --name "$WORKER" >/dev/null
import json, os, sys, urllib.request
H = {"Authorization": "Bearer " + os.environ["MAKER"], "Content-Type": "application/json"}
def call(method, path, body=None):
    r = urllib.request.Request("https://api.cloudflare.com/client/v4" + path, method=method, headers=H,
                               data=json.dumps(body).encode() if body else None)
    return json.load(urllib.request.urlopen(r))["result"]
groups = {g["name"]: g["id"] for g in call("GET", "/user/tokens/permission_groups")}
tok = call("POST", "/user/tokens", {"name": "lofi-lobby-stats",
    "policies": [{"effect": "allow", "resources": {"com.cloudflare.api.account." + os.environ["ACCOUNT"]: "*"},
                  "permission_groups": [{"id": groups["Account Analytics Read"]}]}]})
sys.stdout.write(tok["value"])  # piped straight into wrangler secret put, never shown
PY
unset MAKER
printf '%s' "$ACCOUNT" | npx --yes wrangler secret put CF_ACCOUNT_ID --name "$WORKER" >/dev/null
echo "token lofi-lobby-stats created; CF_API_TOKEN and CF_ACCOUNT_ID saved on the Worker $WORKER"
