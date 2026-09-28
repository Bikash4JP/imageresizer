#!/usr/bin/env bash
# Installed as /usr/local/sbin/image-resizer-deploy. Run as root, normally via
# SSM Run Command from the deploy pipeline (no SSH, no inbound ports):
#
#   image-resizer-deploy <version> <sha256>
#
# Downloads the release tarball from the private artifact bucket, verifies its
# SHA-256 against the value computed in CI, unpacks it and hands over to the
# release's own infra/ec2/deploy.sh.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

VERSION="${1:?usage: image-resizer-deploy <version> <sha256>}"
EXPECTED_SHA256="${2:?usage: image-resizer-deploy <version> <sha256>}"
[[ "$VERSION" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "invalid version" >&2; exit 2; }
[[ "$EXPECTED_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid sha256" >&2; exit 2; }

# shellcheck source=/dev/null
source /etc/image-resizer/deploy.conf
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
APP_DIR=/opt/image-resizer
RELEASE_DIR="$APP_DIR/releases/$VERSION"
TARBALL="$(mktemp --suffix=.tgz)"
trap 'rm -f "$TARBALL"' EXIT

aws s3 cp --only-show-errors "s3://${ARTIFACT_BUCKET}/releases/image-resizer-${VERSION}.tgz" "$TARBALL"
echo "${EXPECTED_SHA256}  ${TARBALL}" | sha256sum -c --quiet - || { echo "checksum mismatch — refusing to deploy" >&2; exit 3; }

rm -rf "$RELEASE_DIR.partial"
install -d -m 0755 "$RELEASE_DIR.partial"
tar -xzf "$TARBALL" -C "$RELEASE_DIR.partial" --no-same-owner
rm -rf "$RELEASE_DIR"
mv "$RELEASE_DIR.partial" "$RELEASE_DIR"

exec bash "$RELEASE_DIR/infra/ec2/deploy.sh" "$VERSION"
