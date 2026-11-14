#!/bin/sh
# Docker entrypoint for the web service.
#
# SEED_DEMO_ON_BOOT=1 is set ONLY for the first production deploy and
# removed immediately after: it installs the demo content + the 10
# launch invite codes without anyone needing shell access to the
# production database. The seed is idempotent, but it tops invite
# codes back up to 10 — which must never happen once testers start
# spending them, hence the remove-after-first-boot rule (DEPLOY.md).
if [ "$SEED_DEMO_ON_BOOT" = "1" ]; then
  echo "[entrypoint] SEED_DEMO_ON_BOOT=1 - running demo seed before start"
  bun run db:seed-demo
fi
exec bun run start
