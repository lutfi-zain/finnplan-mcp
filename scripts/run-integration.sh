#!/bin/bash
set -e

WORKER_URL="${WORKER_URL:-https://finnplan-mcp.lutfidmz.workers.dev}"
JWT_SECRET="${JWT_SECRET:-finnplan_production_secret_key_8492048591823746}"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Eve Finance MCP — Remote Cloudflare D1 Integration (E2E)  ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# 1. Deploy latest code
echo "🚀 Deploying worker to Cloudflare..."
npm run deploy
echo ""

# 2. Wait a moment for deployment propagation
echo "⏳ Waiting 3 seconds for deployment propagation..."
sleep 3

# 3. Verify worker is reachable
echo "🔍 Verifying worker health at ${WORKER_URL}..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${WORKER_URL}/health" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" != "200" ]; then
  echo "❌ Worker not reachable (HTTP ${HTTP_STATUS}). Aborting."
  exit 1
fi
echo "✅ Worker is live and healthy!"
echo ""

# 4. Run integration tests
echo "🧪 Running integration tests against ${WORKER_URL}..."
echo ""
WORKER_URL="${WORKER_URL}" JWT_SECRET="${JWT_SECRET}" npx tsx --test tests/integration.test.ts
TEST_EXIT=$?
echo ""

# 5. Cleanup test data from remote D1 (unless KEEP_DATA=1)
if [ "$KEEP_DATA" = "1" ]; then
  echo "ℹ️  KEEP_DATA=1 detected. Skipping teardown/cleanup so test data stays in D1."
else
  echo "🧹 Cleaning up test data from remote D1..."
  npx wrangler d1 execute finance_db --remote \
    --command="DELETE FROM transactions WHERE transaction_user_id LIKE 'usr_%'; DELETE FROM budgets WHERE budget_user_id LIKE 'usr_%'; DELETE FROM categories WHERE category_user_id LIKE 'usr_%'; DELETE FROM wallets WHERE wallet_user_id LIKE 'usr_%'; DELETE FROM users WHERE user_id LIKE 'usr_%';" 2>/dev/null || true
  echo "✅ Test data cleaned up."
fi
echo ""

if [ $TEST_EXIT -eq 0 ]; then
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║  ✅ All remote D1 integration tests PASSED!               ║"
  echo "╚════════════════════════════════════════════════════════════╝"
else
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║  ❌ Remote integration tests FAILED (exit code: ${TEST_EXIT})      ║"
  echo "╚════════════════════════════════════════════════════════════╝"
  exit $TEST_EXIT
fi
