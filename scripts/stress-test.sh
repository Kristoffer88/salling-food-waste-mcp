#!/usr/bin/env bash
# Stress test the MCP HTTP endpoint to find where rate limiting kicks in.
# Usage: ./scripts/stress-test.sh [URL] [TOTAL_REQUESTS]

URL="${1:-http://localhost:3001/mcp}"
TOTAL="${2:-30}"

BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

echo "Target:   $URL"
echo "Requests: $TOTAL"
echo "---"

ok=0
limited=0
errors=0

for i in $(seq 1 "$TOTAL"); do
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$BODY" \
    "$URL")

  if [ "$status" = "200" ]; then
    printf "  #%02d  %s\n" "$i" "$status"
    ((ok++))
  elif [ "$status" = "429" ]; then
    printf "  #%02d  %s  <- rate limited\n" "$i" "$status"
    ((limited++))
  else
    printf "  #%02d  %s  <- unexpected\n" "$i" "$status"
    ((errors++))
  fi
done

echo "---"
echo "OK: $ok | Rate limited: $limited | Errors: $errors"
echo "First 429 after $ok successful requests"
