#!/usr/bin/env bash
# Idempotent provisioning for an Image Resizer API instance (Amazon Linux 2023).
#
# Reads /etc/image-resizer/deploy.conf, which CloudFormation user-data writes:
#   ARTIFACT_BUCKET  private S3 bucket holding releases and these scripts
#   SSM_PATH         Parameter Store path with the API's environment variables
#   AWS_REGION       region of the bucket, table and parameters
#   FEEDBACK_TABLE   DynamoDB table for ratings and reviews
#   NGINX_PROFILE    "tls" (single server: nginx terminates HTTPS for CloudFront)
#                    or "alb" (behind a load balancer: plain HTTP on port 80)
#   ORIGIN_DOMAIN    tls only: e.g. origin.example.com
#   ACME_EMAIL       tls only, optional: Let's Encrypt expiry notices
#
# Runs at first boot (user-data) and again before every deploy, so a changed
# script converges existing instances too. With --no-deploy it only prepares
# the host; otherwise it finishes by deploying the release recorded in
# s3://$ARTIFACT_BUCKET/releases/LATEST (if one exists).
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

CONF=/etc/image-resizer/deploy.conf
[[ -r "$CONF" ]] || { echo "$CONF missing: it is written by the CloudFormation user-data" >&2; exit 1; }
# shellcheck source=/dev/null
source "$CONF"
: "${ARTIFACT_BUCKET:?}" "${SSM_PATH:?}" "${AWS_REGION:?}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
NGINX_PROFILE="${NGINX_PROFILE:-alb}"
NODE_VERSION="${NODE_VERSION:-v22.23.3}"
CERTBOT_VERSION=5.8.0
APP_USER=image-resizer
APP_DIR=/opt/image-resizer
DEPLOY_AFTER=1
[[ "${1:-}" == "--no-deploy" ]] && DEPLOY_AFTER=0

log() { echo "[bootstrap $(date -u +%FT%TZ)] $*"; }

log "installing OS packages and security updates"
# AL2023 repositories are version-locked; --releasever=latest picks up current security fixes.
dnf -y -q --releasever=latest upgrade --security || log "security update step reported an error (continuing)"
dnf -y -q install nginx tar xz

# Small instances get a swap file as a safety margin for large images.
if [[ ! -f /swapfile ]] && (( $(awk '/MemTotal/ {print $2}' /proc/meminfo) < 3500000 )); then
  log "adding 2 GiB swap"
  fallocate -l 2G /swapfile
  chmod 0600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

if ! /usr/local/bin/node --version 2>/dev/null | grep -qx "$NODE_VERSION"; then
  case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64) NODE_ARCH=arm64 ;;
    *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
  log "installing Node.js $NODE_VERSION ($NODE_ARCH), checksum-verified"
  tmp="$(mktemp -d)"
  tarball="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/${NODE_VERSION}/${tarball}"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  (cd "$tmp" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /usr/local/lib/nodejs && mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp/$tarball" -C /usr/local/lib/nodejs --strip-components=1
  ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  ln -sf /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm
  rm -rf "$tmp"
fi

log "creating service account and directories"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin "$APP_USER"
install -d -m 0755 -o root -g root "$APP_DIR" "$APP_DIR/releases"
chgrp "$APP_USER" /etc/image-resizer
chmod 0750 /etc/image-resizer
chmod 0640 "$CONF"

aws s3 cp --only-show-errors "s3://${ARTIFACT_BUCKET}/bootstrap/fetch-and-deploy.sh" /usr/local/sbin/image-resizer-deploy
chmod 0750 /usr/local/sbin/image-resizer-deploy

if [[ "$NGINX_PROFILE" == "tls" ]]; then
  : "${ORIGIN_DOMAIN:?ORIGIN_DOMAIN is required for the tls profile}"
  if [[ ! -x /opt/certbot/bin/certbot ]] || ! /opt/certbot/bin/certbot --version 2>&1 | grep -q "$CERTBOT_VERSION"; then
    log "installing certbot $CERTBOT_VERSION (isolated virtualenv on Python 3.11)"
    dnf -y -q install python3.11 python3.11-pip augeas-libs
    rm -rf /opt/certbot
    python3.11 -m venv /opt/certbot
    /opt/certbot/bin/pip install --quiet --upgrade pip
    /opt/certbot/bin/pip install --quiet "certbot==${CERTBOT_VERSION}" "certbot-dns-route53==${CERTBOT_VERSION}"
  fi
  # DNS-01 via Route 53 (instance role, scoped to this one TXT record): port 80
  # never has to be opened, and the origin stays reachable only from CloudFront.
  log "ensuring a certificate for $ORIGIN_DOMAIN"
  email_args=(--register-unsafely-without-email)
  [[ -n "${ACME_EMAIL:-}" ]] && email_args=(--email "$ACME_EMAIL")
  /opt/certbot/bin/certbot certonly --non-interactive --agree-tos "${email_args[@]}" \
    --dns-route53 --cert-name origin -d "$ORIGIN_DOMAIN" --keep-until-expiring --quiet

  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/bin/sh\nsystemctl reload nginx\n' >/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  cat >/etc/systemd/system/certbot-renew.service <<'EOF'
[Unit]
Description=Renew Let's Encrypt certificates
[Service]
Type=oneshot
ExecStart=/opt/certbot/bin/certbot renew --quiet
EOF
  cat >/etc/systemd/system/certbot-renew.timer <<'EOF'
[Unit]
Description=Renew Let's Encrypt certificates twice a day
[Timer]
OnCalendar=*-*-* 03,15:00:00
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now certbot-renew.timer
fi

rm -f /etc/nginx/conf.d/default.conf
systemctl enable --now nginx

if (( DEPLOY_AFTER )); then
  if latest="$(aws s3 cp --only-show-errors "s3://${ARTIFACT_BUCKET}/releases/LATEST" - 2>/dev/null)"; then
    read -r version checksum <<<"$latest"
    log "deploying current release $version"
    /usr/local/sbin/image-resizer-deploy "$version" "$checksum"
  else
    log "no release published yet; the pipeline will deploy on its first run"
  fi
fi
log "done"
