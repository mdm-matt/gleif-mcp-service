#!/usr/bin/env bash
# Guarded deploy for gleif-mcp-service.
# Refuses to deploy if working tree is dirty or local diverges from origin.
# Each deployed revision is labeled with the git SHA for traceability.
set -euo pipefail

SERVICE="gleif-mcp-service"
REGION="us-central1"
PROJECT="gcp-infa-cloud-alliances-bus-d"
FORCE=0

for arg in "$@"; do
  if [ "$arg" = "--force" ]; then FORCE=1; fi
done

if [ "$FORCE" -ne 1 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "❌ Working tree has uncommitted changes. Commit or stash before deploying."
    git status --short
    echo
    echo "    (override with: ./deploy.sh --force)"
    exit 1
  fi

  git fetch origin --quiet
  LOCAL=$(git rev-parse @)
  REMOTE=$(git rev-parse @{u} 2>/dev/null || echo "")
  BASE=$(git merge-base @ @{u} 2>/dev/null || echo "")

  if [ -z "$REMOTE" ]; then
    echo "❌ Current branch is not tracking a remote. Push it first."
    exit 1
  fi
  if [ "$LOCAL" != "$REMOTE" ]; then
    if [ "$LOCAL" = "$BASE" ]; then
      echo "❌ Local is BEHIND origin. Pull before deploying."
      exit 1
    elif [ "$REMOTE" = "$BASE" ]; then
      echo "❌ Local is AHEAD of origin. Push your commits first so GitHub matches what's deployed."
      git log --oneline "$REMOTE..$LOCAL"
      exit 1
    else
      echo "❌ Local and origin have diverged. Resolve before deploying."
      exit 1
    fi
  fi
fi

COMMIT_SHA=$(git rev-parse --short HEAD)
echo "✅ Git is clean and in sync with origin (HEAD=$COMMIT_SHA). Deploying..."

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT" \
  --update-labels "git-sha=$COMMIT_SHA" \
  --quiet
