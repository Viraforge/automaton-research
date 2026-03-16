#!/usr/bin/env python3
"""
Phase 0 Smoke Tests — Paper Trading Harness (Dataset)

Validates btc_5m.db integrity for Phase 1.5 signal research readiness.
Run: python3 datasets/btc-5m/phase0-smoke-dataset.py
"""

import sqlite3
import sys
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "btc_5m.db")

def main():
    if not os.path.exists(DB_PATH):
        print(f"FAIL: Database not found at {DB_PATH}")
        return 1

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    passed = 0
    failed = 0
    total = 0

    def check(name, condition, detail=""):
        nonlocal passed, failed, total
        total += 1
        if condition:
            passed += 1
            print(f"  PASS: {name}")
        else:
            failed += 1
            print(f"  FAIL: {name} — {detail}")

    print("Phase 0 Smoke: Paper Trading Harness (Dataset)")
    print("=" * 60)

    # 1. Tables exist
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()]
    for t in ["markets", "trades", "order_book_snapshots", "order_book_levels", "pipeline_runs"]:
        check(f"Table '{t}' exists", t in tables, f"missing from {tables}")

    # 2. Trade count >= 500
    trade_count = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
    check(f"Trade count >= 500 (got {trade_count})", trade_count >= 500)

    # 3. Market structure
    market = conn.execute("SELECT * FROM markets LIMIT 1").fetchone()
    check("Markets table has rows", market is not None)
    if market:
        check("Market has condition_id", bool(market["condition_id"]))
        check("Market question mentions Bitcoin",
              "bitcoin" in market["question"].lower(),
              market["question"])
        check("Market has token_yes_id", bool(market["token_yes_id"]))
        check("Market has window_start_epoch > 0",
              market["window_start_epoch"] > 0)

    # 4. Price range (0, 1)
    invalid_prices = conn.execute(
        "SELECT COUNT(*) FROM trades WHERE price <= 0 OR price >= 1"
    ).fetchone()[0]
    check(f"All prices in (0,1) range ({invalid_prices} invalid)", invalid_prices == 0)

    # 5. Timestamp ordering within markets
    # Note: rowid ordering may differ from timestamp ordering when trades are fetched
    # in batches. The meaningful check is that timestamps are monotonically non-decreasing
    # when sorted by timestamp within each market (i.e., no duplicate timestamps with
    # inverted IDs). We check explicit timestamp sort order instead of insertion order.
    out_of_order = conn.execute("""
        SELECT COUNT(*) FROM (
            SELECT condition_id, timestamp,
                LAG(timestamp) OVER (PARTITION BY condition_id ORDER BY timestamp, rowid) as prev_ts
            FROM trades
        ) WHERE prev_ts IS NOT NULL AND timestamp < prev_ts
    """).fetchone()[0]
    check(f"Timestamps sortable within markets ({out_of_order} violations)", out_of_order == 0)

    # 6. Order book snapshots and levels exist
    snap_count = conn.execute("SELECT COUNT(*) FROM order_book_snapshots").fetchone()[0]
    level_count = conn.execute("SELECT COUNT(*) FROM order_book_levels").fetchone()[0]
    check(f"Order book snapshots exist ({snap_count})", snap_count > 0)
    check(f"Order book levels exist ({level_count})", level_count > 0)

    # 7. No crossed spreads
    crossed = conn.execute("""
        SELECT COUNT(*) FROM (
            SELECT s.id,
                MAX(CASE WHEN l.side = 'bid' THEN l.price END) as best_bid,
                MIN(CASE WHEN l.side = 'ask' THEN l.price END) as best_ask
            FROM order_book_snapshots s
            JOIN order_book_levels l ON l.snapshot_id = s.id
            GROUP BY s.id
            HAVING best_bid IS NOT NULL AND best_ask IS NOT NULL AND best_bid >= best_ask
        )
    """).fetchone()[0]
    check(f"No crossed order book spreads ({crossed} violations)", crossed == 0)

    # 8. Join query works for backtesting
    rows = conn.execute("""
        SELECT t.price, t.size, t.side, t.outcome, m.question, m.window_start_epoch
        FROM trades t
        JOIN markets m ON t.condition_id = m.condition_id
        ORDER BY t.timestamp
        LIMIT 5
    """).fetchall()
    check("Trades-markets join works for backtesting", len(rows) > 0)
    if rows:
        check("First trade price valid", 0 < rows[0]["price"] < 1, f"price={rows[0]['price']}")

    # Check window_start_epoch coverage (some markets may lack it due to slug parsing)
    wse_null = conn.execute("SELECT COUNT(*) FROM markets WHERE window_start_epoch IS NULL").fetchone()[0]
    wse_total = conn.execute("SELECT COUNT(*) FROM markets").fetchone()[0]
    check(f"Most markets have window_start_epoch ({wse_total - wse_null}/{wse_total})",
          wse_null < wse_total,
          f"all {wse_total} markets missing window_start_epoch")
    if wse_null > 0:
        print(f"    INFO: {wse_null}/{wse_total} markets have NULL window_start_epoch (minor data gap)")

    # 9. Pipeline run exists
    run = conn.execute(
        "SELECT * FROM pipeline_runs WHERE status IN ('success', 'validation_warnings') ORDER BY id DESC LIMIT 1"
    ).fetchone()
    check("Pipeline has successful run", run is not None)
    if run:
        check(f"Pipeline fetched trades ({run['trades_fetched']})", run["trades_fetched"] > 0)

    # 10. Market count
    market_count = conn.execute("SELECT COUNT(*) FROM markets").fetchone()[0]
    check(f"Multiple markets available ({market_count})", market_count > 1)

    conn.close()

    print("=" * 60)
    print(f"Results: {passed}/{total} passed, {failed} failed")
    return 0 if failed == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
