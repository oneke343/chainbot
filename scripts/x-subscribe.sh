#!/usr/bin/env bash
set -euo pipefail

# Requires curl and jq. Use the app-only Bearer Token for the webhook's X App.
if (( $# < 2 )); then
  echo "Usage: X_BEARER_TOKEN=... $0 WEBHOOK_ID USERNAME [USERNAME ...]" >&2
  exit 2
fi
: "${X_BEARER_TOKEN:?Set X_BEARER_TOKEN to your X App bearer token}"

webhook_id="$1"
shift

for account in "$@"; do
  username="${account#@}"
  user_id="$(curl --fail --silent --show-error \
    --header "Authorization: Bearer $X_BEARER_TOKEN" \
    "https://api.x.com/2/users/by/username/$username" | jq -er '.data.id')"

  payload="$(jq -nc \
    --arg user_id "$user_id" \
    --arg webhook_id "$webhook_id" \
    --arg tag "@$username" \
    '{event_type: "post.create", filter: {user_id: $user_id}, webhook_id: $webhook_id, tag: $tag}')"

  printf 'Subscribing @%s (%s)\n' "$username" "$user_id" >&2
  curl --fail --silent --show-error \
    --request POST \
    --header "Authorization: Bearer $X_BEARER_TOKEN" \
    --header 'Content-Type: application/json' \
    --data "$payload" \
    'https://api.x.com/2/activity/subscriptions' | jq .
done
