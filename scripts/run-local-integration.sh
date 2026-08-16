#!/bin/bash
set -e

LOCAL_PORT=8787
LOCAL_URL="http://localhost:${LOCAL_PORT}"
DEV_SECRET="finnplan_local_dev_jwt_secret_9948271038571204"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Eve Finance MCP — Local D1 Integration Test (E2E)        ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# 1. Reset and apply migrations to local D1
echo "📦 Migrating local D1 database..."
npx wrangler d1 execute finance_db --local --file=./drizzle/0000_nice_marvel_boy.sql > /dev/null 2>&1 || true
echo "✅ Local D1 database ready."
echo ""

# 2. Start wrangler dev in background
echo "🚀 Starting wrangler dev on port ${LOCAL_PORT}..."
npx wrangler dev --port ${LOCAL_PORT} --ip 127.0.0.1 > /tmp/wrangler_local_dev.log 2>&1 &
DEV_PID=$!

# Ensure cleanup on exit
cleanup() {
  echo ""
  echo "🛑 Stopping local wrangler dev (PID: ${DEV_PID})..."
  kill -9 $DEV_PID 2>/dev/null || true
  # Kill any lingering wrangler processes on port 8787
  fuser -k ${LOCAL_PORT}/tcp 2>/dev/null || true
}
trap cleanup EXIT

# 3. Wait for local server readiness
echo "⏳ Waiting for local server at ${LOCAL_URL}..."
MAX_RETRIES=20
COUNT=0
until curl -s -o /dev/null -w "%{http_code}" "${LOCAL_URL}/health" | grep -q "200"; do
  sleep 1
  COUNT=$((COUNT + 1))
  if [ $COUNT -ge $MAX_RETRIES ]; then
    echo "❌ Local server failed to start within ${MAX_RETRIES} seconds."
    cat /tmp/wrangler_local_dev.log
    exit 1
  fi
done
echo "✅ Local server is healthy and responding on ${LOCAL_URL}!"
echo ""

# 4. Run integration tests against local server
echo "🧪 Running full E2E user journey against Local D1..."
echo ""
WORKER_URL="${LOCAL_URL}" JWT_SECRET="${DEV_SECRET}" npx tsx --test tests/integration.test.ts
TEST_EXIT=$?
echo ""

# 5. Cleanup test data from local D1
echo "🧹 Cleaning up test data from local D1..."
npx wrangler d1 execute finance_db --local \
  --command="DELETE FROM transactions WHERE user_id LIKE 'usr_inttest_%'; DELETE FROM budgets WHERE user_id LIKE 'usr_inttest_%'; DELETE FROM categories WHERE user_id LIKE 'usr_inttest_%'; DELETE FROM wallets WHERE user_id LIKE 'usr_inttest_%'; DELETE FROM users WHERE id LIKE 'usr_inttest_%';" > /dev/null 2>&1 || true

if [ $TEST_EXIT -eq 0 ]; then
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║  ✅ Local D1 integration tests PASSED!                    ║"
  echo "╚════════════════════════════════════════════════════════════╝"
else
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║  ❌ Local D1 integration tests FAILED (code: ${TEST_EXIT})        ║"
  echo "╚════════════════════════════════════════════════════════════╝"
  exit $TEST_EXIT
fi
