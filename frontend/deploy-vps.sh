#!/usr/bin/env bash
set -euo pipefail

if ! git diff --quiet || ! git diff --cached --quiet || test -n "$(git status --porcelain --untracked-files=normal)"; then
  echo "Refusing to deploy: repository has uncommitted changes." >&2
  exit 1
fi

git fetch origin main
git pull --ff-only origin main
docker compose config --quiet
docker compose build --pull
docker compose up -d --no-build
docker image prune -f
docker builder prune -f
