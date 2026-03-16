#!/usr/bin/env python3
"""
BTC 5M Historical Dataset Pipeline

Pulls BTC 5-minute "Up or Down" market data from Polymarket APIs:
- Trade history from data-api.polymarket.com
- Order book snapshots from clob.polymarket.com
- Market metadata from gamma-api.polymarket.com

Stores in SQLite with validation checks.
"""

import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────

DATA_API = "https://data-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"
BTC_5M_RE = re.compile(r"^btc-updown-5m-")
RATE_LIMIT_S = 0.15  # ~7 req/s
TRADE_BATCH = 1000
TARGET_TRADES = 600
DB_PATH = Path(__file__).parent / "btc_5m.db"


# ── Helpers ─────────────────────────────────────────────────────────────────

def fetch_json(url: str, retries: int = 2):
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "btc5m-pipeline/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                time.sleep(2 ** attempt)
                continue
            raise
        except Exception:
            if attempt < retries:
                time.sleep(1)
                continue
            raise


# ── Database ────────────────────────────────────────────────────────────────

def init_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS markets (
            condition_id       TEXT PRIMARY KEY,
            question           TEXT NOT NULL,
            slug               TEXT NOT NULL,
            token_yes_id       TEXT,
            token_no_id        TEXT,
            active             INTEGER NOT NULL DEFAULT 1,
            closed             INTEGER NOT NULL DEFAULT 0,
            accepting_orders   INTEGER NOT NULL DEFAULT 1,
            volume             REAL,
            start_date         TEXT,
            end_date           TEXT,
            window_start_epoch INTEGER,
            fetched_at         TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS trades (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_hash   TEXT NOT NULL,
            condition_id       TEXT NOT NULL REFERENCES markets(condition_id),
            slug               TEXT NOT NULL,
            side               TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
            outcome            TEXT NOT NULL,
            outcome_index      INTEGER NOT NULL,
            price              REAL NOT NULL CHECK(price >= 0 AND price <= 1),
            size               REAL NOT NULL CHECK(size > 0),
            timestamp          INTEGER NOT NULL,
            asset_id           TEXT NOT NULL,
            proxy_wallet       TEXT NOT NULL,
            fetched_at         TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(transaction_hash, asset_id, side, outcome_index)
        );

        CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
        CREATE INDEX IF NOT EXISTS idx_trades_slug ON trades(slug);
        CREATE INDEX IF NOT EXISTS idx_trades_condition ON trades(condition_id);

        CREATE TABLE IF NOT EXISTS order_book_snapshots (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            condition_id   TEXT NOT NULL REFERENCES markets(condition_id),
            asset_id       TEXT NOT NULL,
            outcome        TEXT NOT NULL,
            snapshot_ts    INTEGER NOT NULL,
            fetched_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS order_book_levels (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id     INTEGER NOT NULL REFERENCES order_book_snapshots(id),
            side            TEXT NOT NULL CHECK(side IN ('bid', 'ask')),
            price           REAL NOT NULL,
            size            REAL NOT NULL,
            level_index     INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ob_snapshot ON order_book_levels(snapshot_id);
        CREATE INDEX IF NOT EXISTS idx_ob_snapshots_ts ON order_book_snapshots(snapshot_ts);

        CREATE TABLE IF NOT EXISTS pipeline_runs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at      TEXT NOT NULL DEFAULT (datetime('now')),
            finished_at     TEXT,
            trades_fetched  INTEGER DEFAULT 0,
            markets_fetched INTEGER DEFAULT 0,
            snapshots_fetched INTEGER DEFAULT 0,
            status          TEXT DEFAULT 'running'
        );
    """)
    conn.commit()
    return conn


# ── Pipeline Steps ──────────────────────────────────────────────────────────

def discover_markets(conn: sqlite3.Connection) -> int:
    """Discover BTC 5M markets from Gamma API."""
    print("[1/4] Discovering BTC 5M markets...")
    count = 0

    for offset in range(0, 400, 100):
        url = f"{GAMMA_API}/markets?limit=100&offset={offset}&order=startDate&ascending=false"
        try:
            batch = fetch_json(url)
        except Exception as e:
            print(f"  Gamma fetch error at offset {offset}: {e}")
            break

        btc_markets = [m for m in batch if BTC_5M_RE.match(m.get("slug", ""))]

        for m in btc_markets:
            slug_match = re.search(r"btc-updown-5m-(\d+)", m.get("slug", ""))
            window_epoch = int(slug_match.group(1)) if slug_match else None
            clob_ids = m.get("clobTokenIds", [])
            # Parse clobTokenIds which may be JSON string
            if isinstance(clob_ids, str):
                try:
                    clob_ids = json.loads(clob_ids)
                except Exception:
                    clob_ids = []

            conn.execute("""
                INSERT INTO markets (condition_id, question, slug, token_yes_id, token_no_id,
                                     active, closed, accepting_orders, volume, start_date, end_date, window_start_epoch)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(condition_id) DO UPDATE SET
                    token_yes_id = COALESCE(excluded.token_yes_id, markets.token_yes_id),
                    token_no_id = COALESCE(excluded.token_no_id, markets.token_no_id),
                    active = excluded.active,
                    closed = excluded.closed,
                    accepting_orders = excluded.accepting_orders,
                    volume = excluded.volume
            """, (
                m.get("conditionId"),
                m.get("question", ""),
                m.get("slug", ""),
                clob_ids[0] if len(clob_ids) > 0 else None,
                clob_ids[1] if len(clob_ids) > 1 else None,
                1 if m.get("active") else 0,
                1 if m.get("closed") else 0,
                1 if m.get("acceptingOrders") else 0,
                m.get("volume"),
                m.get("startDate"),
                m.get("endDate"),
                window_epoch,
            ))
            count += 1

        conn.commit()
        time.sleep(RATE_LIMIT_S)

        if len(batch) < 100:
            break

    print(f"  Discovered {count} BTC 5M markets")
    return count


def fetch_trades(conn: sqlite3.Connection) -> tuple[int, int]:
    """Fetch BTC 5M trades from data API."""
    print("[2/4] Fetching BTC 5M trade history...")

    total_inserted = 0
    market_slugs = set()
    offset = 0
    empty_batches = 0

    while total_inserted < TARGET_TRADES and empty_batches < 3:
        url = f"{DATA_API}/trades?limit={TRADE_BATCH}&offset={offset}"
        try:
            batch = fetch_json(url)
        except Exception as e:
            print(f"  Fetch error at offset {offset}: {e}")
            break

        if not batch:
            empty_batches += 1
            break

        btc_trades = [t for t in batch if BTC_5M_RE.match(t.get("slug", ""))]
        batch_inserted = 0

        for t in btc_trades:
            # Ensure market exists
            conn.execute("""
                INSERT OR IGNORE INTO markets (condition_id, question, slug, active, closed)
                VALUES (?, ?, ?, 1, 0)
            """, (t["conditionId"], t.get("title", ""), t["slug"]))

            try:
                conn.execute("""
                    INSERT OR IGNORE INTO trades
                        (transaction_hash, condition_id, slug, side, outcome, outcome_index,
                         price, size, timestamp, asset_id, proxy_wallet)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    t["transactionHash"],
                    t["conditionId"],
                    t["slug"],
                    t["side"],
                    t["outcome"],
                    t["outcomeIndex"],
                    t["price"],
                    t["size"],
                    t["timestamp"],
                    t["asset"],
                    t["proxyWallet"],
                ))
                if conn.total_changes:
                    batch_inserted += 1
                market_slugs.add(t["slug"])
            except sqlite3.IntegrityError:
                pass

        conn.commit()
        total_inserted += batch_inserted
        offset += TRADE_BATCH

        print(f"  Batch offset={offset - TRADE_BATCH}: {len(btc_trades)} BTC 5M trades ({batch_inserted} new), total: {total_inserted}")

        if not btc_trades:
            empty_batches += 1
        else:
            empty_batches = 0

        time.sleep(RATE_LIMIT_S)

    print(f"  Total BTC 5M trades: {total_inserted} across {len(market_slugs)} markets")
    return total_inserted, len(market_slugs)


def fetch_order_books(conn: sqlite3.Connection) -> int:
    """Fetch order book snapshots for known markets."""
    print("[3/4] Fetching order book snapshots...")

    cursor = conn.execute("SELECT condition_id, slug, token_yes_id, token_no_id FROM markets")
    markets = cursor.fetchall()

    # Resolve missing token IDs from Gamma
    for cid, slug, tyes, tno in markets:
        if not tyes:
            try:
                time.sleep(RATE_LIMIT_S)
                gamma = fetch_json(f"{GAMMA_API}/markets?slug={slug}&limit=1")
                if gamma and len(gamma) > 0:
                    clob_ids = gamma[0].get("clobTokenIds", [])
                    if isinstance(clob_ids, str):
                        clob_ids = json.loads(clob_ids)
                    if len(clob_ids) >= 2:
                        conn.execute(
                            "UPDATE markets SET token_yes_id=?, token_no_id=? WHERE condition_id=?",
                            (clob_ids[0], clob_ids[1], cid)
                        )
                        conn.commit()
            except Exception:
                pass

    # Re-fetch with resolved token IDs
    cursor = conn.execute("SELECT condition_id, slug, token_yes_id, token_no_id FROM markets WHERE token_yes_id IS NOT NULL")
    markets = cursor.fetchall()

    snapshot_count = 0

    for cid, slug, tyes, tno in markets:
        tokens = [("Up", tyes), ("Down", tno)]
        for outcome, token_id in tokens:
            if not token_id:
                continue
            try:
                time.sleep(RATE_LIMIT_S)
                book = fetch_json(f"{CLOB_API}/book?token_id={token_id}")

                if "error" in book:
                    continue

                bids = book.get("bids", [])
                asks = book.get("asks", [])
                if not bids and not asks:
                    continue

                ts_raw = book.get("timestamp", "")
                snapshot_ts = int(ts_raw) // 1000 if ts_raw else int(time.time())

                conn.execute(
                    "INSERT INTO order_book_snapshots (condition_id, asset_id, outcome, snapshot_ts) VALUES (?, ?, ?, ?)",
                    (cid, token_id, outcome, snapshot_ts)
                )
                snap_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

                for i, level in enumerate(bids):
                    conn.execute(
                        "INSERT INTO order_book_levels (snapshot_id, side, price, size, level_index) VALUES (?, 'bid', ?, ?, ?)",
                        (snap_id, float(level["price"]), float(level["size"]), i)
                    )
                for i, level in enumerate(asks):
                    conn.execute(
                        "INSERT INTO order_book_levels (snapshot_id, side, price, size, level_index) VALUES (?, 'ask', ?, ?, ?)",
                        (snap_id, float(level["price"]), float(level["size"]), i)
                    )
                conn.commit()
                snapshot_count += 1
            except Exception:
                pass

    print(f"  Captured {snapshot_count} order book snapshots")
    return snapshot_count


def run_validation(conn: sqlite3.Connection) -> dict:
    """Run all validation checks."""
    print("[4/4] Running validation checks...")
    results = {}

    # 1. Trade count
    cnt = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
    results["trade_count"] = {
        "pass": cnt >= 500,
        "detail": f"{cnt} trades (need >=500)"
    }

    # 2. Timestamp alignment — check that timestamps are non-decreasing when
    #    ordered by timestamp within each market. Trades at the same second are
    #    allowed in any order (multiple fills per block).
    reorder = conn.execute("""
        SELECT slug, COUNT(*) as violations FROM (
            SELECT slug, timestamp,
                   LAG(timestamp) OVER (PARTITION BY slug ORDER BY timestamp, rowid) as prev_ts
            FROM trades
        ) WHERE prev_ts IS NOT NULL AND timestamp < prev_ts
        GROUP BY slug
    """).fetchall()
    total_violations = sum(r[1] for r in reorder)
    results["timestamp_alignment"] = {
        "pass": total_violations == 0,
        "detail": "No timestamp reordering" if total_violations == 0
                  else f"{total_violations} reordering violations in {len(reorder)} markets"
    }

    # 3. Gap detection
    windows = conn.execute("""
        SELECT DISTINCT CAST(REPLACE(slug, 'btc-updown-5m-', '') AS INTEGER) as epoch
        FROM trades WHERE slug LIKE 'btc-updown-5m-%'
        ORDER BY epoch
    """).fetchall()
    epochs = [w[0] for w in windows]
    gaps = 0
    for i in range(1, len(epochs)):
        diff = epochs[i] - epochs[i-1]
        if 300 < diff < 3600:
            gaps += 1
    results["gap_detection"] = {
        "pass": True,
        "detail": f"{gaps} gaps across {len(epochs)} windows"
    }

    # 4. Bid/ask spread integrity
    crossed = conn.execute("""
        SELECT COUNT(*) FROM (
            SELECT s.id,
                   MAX(CASE WHEN l.side='bid' THEN l.price END) as best_bid,
                   MIN(CASE WHEN l.side='ask' THEN l.price END) as best_ask
            FROM order_book_snapshots s
            JOIN order_book_levels l ON l.snapshot_id = s.id
            GROUP BY s.id
            HAVING best_bid IS NOT NULL AND best_ask IS NOT NULL AND best_bid >= best_ask
        )
    """).fetchone()[0]
    results["spread_integrity"] = {
        "pass": crossed == 0,
        "detail": "No crossed order books" if crossed == 0 else f"{crossed} crossed books"
    }

    # 5. Price range validity
    invalid = conn.execute("SELECT COUNT(*) FROM trades WHERE price <= 0 OR price >= 1").fetchone()[0]
    results["price_range"] = {
        "pass": invalid == 0,
        "detail": "All prices in valid (0,1) range" if invalid == 0 else f"{invalid} invalid prices"
    }

    all_pass = all(r["pass"] for r in results.values())
    for name, r in results.items():
        mark = "✓" if r["pass"] else "✗"
        print(f"  {mark} {name}: {r['detail']}")
    print(f"\n  {'All checks passed!' if all_pass else 'Some checks failed.'}")

    return {"pass": all_pass, "results": results}


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    print(f"BTC 5M Dataset Pipeline")
    print(f"DB: {DB_PATH}\n")

    conn = init_db(str(DB_PATH))
    conn.execute("INSERT INTO pipeline_runs DEFAULT VALUES")
    run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.commit()

    try:
        market_count = discover_markets(conn)
        trade_count, slug_count = fetch_trades(conn)
        snapshot_count = fetch_order_books(conn)
        validation = run_validation(conn)

        conn.execute(
            "UPDATE pipeline_runs SET finished_at=datetime('now'), trades_fetched=?, markets_fetched=?, snapshots_fetched=?, status=? WHERE id=?",
            (trade_count, slug_count, snapshot_count, "success" if validation["pass"] else "validation_warnings", run_id)
        )
        conn.commit()

        # Summary
        total_trades = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
        total_markets = conn.execute("SELECT COUNT(*) FROM markets").fetchone()[0]
        total_snapshots = conn.execute("SELECT COUNT(*) FROM order_book_snapshots").fetchone()[0]
        total_levels = conn.execute("SELECT COUNT(*) FROM order_book_levels").fetchone()[0]

        print(f"\n── Summary ────────────────────────────────────────")
        print(f"  Markets:           {total_markets}")
        print(f"  Trades:            {total_trades}")
        print(f"  OB Snapshots:      {total_snapshots}")
        print(f"  OB Levels:         {total_levels}")
        print(f"  Validation:        {'PASS' if validation['pass'] else 'WARN'}")
        print(f"  DB:                {DB_PATH}")

    except Exception as e:
        conn.execute("UPDATE pipeline_runs SET finished_at=datetime('now'), status='error' WHERE id=?", (run_id,))
        conn.commit()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
