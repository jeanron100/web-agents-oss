#!/bin/bash
cd "$(dirname "$0")" || exit 1
bash scripts/quickstart.sh --runner --pull
result=$?
printf '\nPress Return to close this window.\n'
read -r _
exit "$result"
