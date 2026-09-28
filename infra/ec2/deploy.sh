#!/usr/bin/env bash
# Activates an unpacked release. Ships inside every release tarball and is
# executed (as root) by /usr/local/sbin/image-resizer-deploy.
#
#   1. install production dependencies (no lifecycle scripts)
#   2. install the systemd unit + nginx site from this release
#   3. render /etc/image-resizer/env from SSM Parameter Store
#   4. atomically repoint /opt/image-resizer/current and restart
#   5. health-check; on failure roll back to the previous release
#   6. prune old releases
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

VERSION="${1:?usage: deploy.sh <version>}"
# shellcheck source=/dev/null
source /etc/image-resizer/deploy.conf
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
NGINX_PROFILE="${NGINX_PROFILE:-alb}"
APP_USER=image-resizer
APP_DIR=/opt/image-resizer
RELEASE="$APP_DIR/releases/$VERSION"
ENV_FILE=/etc/image-resizer/env
SERVICE=image-resizer
HEALTH_URL=http://127.0.0.1:8080/api/v1/health
KEEP_RELEASES=5

log() { echo "[deploy $(date -u +%FT%TZ)] $*"; }

cd "$RELEASE"
log "installing production dependencies for $VERSION"
# --ignore-scripts: no third-party install hooks ever run as root. sharp loads
# its prebuilt libvips from the platform-specific optional dependency.
npm ci --omit=dev --ignore-scripts --workspace @image-resizer/server --no-audit --no-fund --loglevel=error
# Preflight before touching traffic: the native libvips binary must load on this OS/arch.
node -e "console.log('libvips', require('sharp').versions.vips)"

# Code is owned by root and read-only to the service account: a compromised
# process cannot modify what it runs.
chown -R root:"$APP_USER" "$RELEASE"
chmod -R u=rwX,g=rX,o= "$RELEASE"

log "installing service and proxy configuration"
install -m 0644 infra/ec2/image-resizer.service /etc/systemd/system/image-resizer.service
install -m 0644 "infra/ec2/nginx-${NGINX_PROFILE}.conf" /etc/nginx/conf.d/image-resizer.conf
systemctl daemon-reload
nginx -t -q
systemctl reload nginx

log "rendering environment from deploy.conf and SSM Parameter Store ($SSM_PATH)"
tmp_env="$(mktemp)"
chmod 0600 "$tmp_env"
{
  # Infrastructure facts first; an SSM parameter of the same name overrides them.
  printf 'AWS_REGION=%s\n' "$AWS_REGION"
  [[ -n "${FEEDBACK_TABLE:-}" ]] && printf 'FEEDBACK_TABLE=%s\n' "$FEEDBACK_TABLE"
  aws ssm get-parameters-by-path --path "$SSM_PATH" --recursive --with-decryption \
    --query 'Parameters[].[Name,Value]' --output text |
    while IFS=$'\t' read -r name value; do
      key="${name##*/}"
      # Only well-formed variable names; values containing newlines are rejected.
      [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
      [[ "$value" != *$'\n'* ]] || { echo "parameter $key contains a newline" >&2; exit 1; }
      printf '%s=%s\n' "$key" "$value"
    done
} >"$tmp_env"
install -m 0640 -o root -g "$APP_USER" "$tmp_env" "$ENV_FILE"
rm -f "$tmp_env"

previous="$(readlink -f "$APP_DIR/current" 2>/dev/null || true)"
log "activating $VERSION (previous: ${previous:-none})"
ln -sfn "$RELEASE" "$APP_DIR/current.next"
mv -Tf "$APP_DIR/current.next" "$APP_DIR/current"
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"

healthy=""
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done

if [[ -z "$healthy" ]]; then
  log "health check FAILED for $VERSION"
  journalctl -u "$SERVICE" -n 60 --no-pager || true
  if [[ -n "$previous" && -d "$previous" && "$previous" != "$RELEASE" ]]; then
    log "rolling back to $previous"
    ln -sfn "$previous" "$APP_DIR/current.next"
    mv -Tf "$APP_DIR/current.next" "$APP_DIR/current"
    systemctl restart "$SERVICE"
  fi
  exit 1
fi
log "$VERSION is healthy"

# Keep the newest releases (by mtime), never the active or previous one.
active="$(readlink -f "$APP_DIR/current")"
find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk 'NR>'"$KEEP_RELEASES"' {print $2}' |
  while read -r old; do
    [[ "$old" == "$active" || "$old" == "$previous" ]] && continue
    rm -rf "$old"
  done
log "done"
