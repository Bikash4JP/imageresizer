#!/usr/bin/env bash
# Builds the API release tarball consumed by infra/ec2/deploy.sh.
#
#   infra/scripts/package-release.sh <version>   ->  release/image-resizer-<version>.tgz
#
# The tarball carries compiled JS and manifests only — no node_modules. The
# instance runs `npm ci --omit=dev` itself so sharp resolves the libvips binary
# for the instance's own OS/arch (x64 or Graviton arm64) from the lockfile.
set -euo pipefail

VERSION="${1:?usage: package-release.sh <version>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cd "$ROOT"
test -f server/dist/index.js || { echo "server/dist missing — run 'npm run build' first" >&2; exit 1; }

mkdir -p "$STAGE/server" "$STAGE/client" "$STAGE/infra"
# Workspace manifests + lockfile so `npm ci` reproduces the exact audited tree.
cp package.json package-lock.json .npmrc "$STAGE/"
cp server/package.json "$STAGE/server/"
cp client/package.json "$STAGE/client/"
cp -R server/dist "$STAGE/server/dist"
# Deploy tooling is versioned with the release it installs.
cp -R infra/ec2 "$STAGE/infra/ec2"
echo "$VERSION" > "$STAGE/VERSION"

# Defence in depth: refuse to ship anything that looks like a secret.
if find "$STAGE" \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \) ! -name '*.example' | grep -q .; then
  echo "refusing to package: secret-like file found in release" >&2
  exit 1
fi

mkdir -p release
tar -czf "release/image-resizer-${VERSION}.tgz" -C "$STAGE" .
echo "release/image-resizer-${VERSION}.tgz"
