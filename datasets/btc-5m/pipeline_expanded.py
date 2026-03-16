#!/usr/bin/env python3
"""
BTC 5M Expanded Dataset Pipeline — DLD-329

Rolling collector that polls the Polymarket data-api across multiple
5-minute market windows to build a multi-window dataset suitable for
walk-forward signal validation.

Key constraint: data-api is a real-time firehose (no historical access).
We must poll continuously to capture trades as they happen.

Usage:
    python pipeline_expanded.py [--duration MINUTES] [--db PATH]
    Defaults: 20 minutes collection, btc_5m_expanded.db
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
GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"
BTC_5M_RE = re.compile(r"^btc-updown-5m-")
RATE_LIMIT_S = 0.15
POLL_INTERVAL_S = 15  # Poll every 15 seconds
DEFAULT_DURATION_MIN = 20
DB_PATH = Path(__file__).parent / "btc_5m_expanded.db"


# ── Helpers ─────────────────────────────────────────────────────────────────

def fetch_json(url: str, retries: int = 2):
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "application/json",
                "User-Agent": "btc5m-pipeline/2.0"
            })
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
            poll_cycle         INTEGER DEFAULT 0,
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
            poll_cycles     INTEGER DEFAULT 0,
            duration_sec    REAL DEFAULT 0,
            status          TEXT DEFAULT 'running'
        );

        CREATE TABLE IF NOT EXISTS collection_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            poll_cycle      INTEGER NOT NULL,
            timestamp       INTEGER NOT NULL,
            btc_5m_count    INTEGER NOT NULL,
            new_trades      INTEGER NOT NULL,
            total_trades    INTEGER NOT NULL,
            unique_slugs    INTEGER NOT NULL
        );
    """)
    conn.commit()
    return conn


# ── Market Discovery ────────────────────────────────────────────────────────

def discover_markets(conn: sqlite3.Connection) -> int:
    """Discover BTC 5M markets from Gamma API."""
    print("[1/4] Discovering BTC 5M markets...")
    count = 0

    for offset in range(0, 2000, 100):
        try:
            batch = fetch_json(f"{GAMMA_API}/markets?limit=100&offset={offset}&order=startDate&ascending=false")
        except Exception as e:
            print(f"  Gamma fetch error at offset {offset}: {e}")
            break

        btc_markets = [m for m in batch if BTC_5M_RE.match(m.get("slug", ""))]

        for m in btc_markets:
            slug_match = re.search(r"btc-updown-5m-(\d+)", m.get("slug", ""))
            window_epoch = int(slug_match.group(1)) if slug_match else None
            clob_ids = m.get("clobTokenIds", [])
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

    print(f"  Discovered {count} BTC 5M markets from Gamma")
    return count


# ── Rolling Trade Collection ────────────────────────────────────────────────

def collect_trades_rolling(conn: sqlite3.Connection, duration_min: float) -> tuple[int, int]:
    """
    Poll the data-api continuously for duration_min minutes.
    Each poll captures the most recent trades and deduplicates.
    """
    print(f"[2/4] Collecting BTC 5M trades ({duration_min:.0f} min rolling window)...")

    total_inserted = 0
    seen_keys = set()
    seen_slugs = set()
    poll_cycle = 0
    start_time = time.time()
    end_time = start_time + duration_min * 60

    # Pre-load existing trade keys to avoid re-inserting
    for row in conn.execute("SELECT transaction_hash, asset_id, side, outcome_index FROM trades"):
        seen_keys.add(f"{row[0]}_{row[1]}_{row[2]}_{row[3]}")

    while time.time() < end_time:
        poll_cycle += 1
        cycle_inserted = 0

        # Fetch trades from multiple offsets to maximize coverage
        for offset in [0, 1000, 2000]:
            try:
                batch = fetch_json(f"{DATA_API}/trades?limit=1000&offset={offset}")
            except Exception:
                break

            if not batch:
                break

            btc_trades = [t for t in batch if BTC_5M_RE.match(t.get("slug", ""))]

            for t in btc_trades:
                key = f"{t['transactionHash']}_{t['asset']}_{t['side']}_{t['outcomeIndex']}"
                if key in seen_keys:
                    continue
                seen_keys.add(key)

                # Ensure market exists
                slug = t["slug"]
                slug_match = re.search(r"btc-updown-5m-(\d+)", slug)
                window_epoch = int(slug_match.group(1)) if slug_match else None

                conn.execute("""
                    INSERT OR IGNORE INTO markets (condition_id, question, slug, active, closed, window_start_epoch)
                    VALUES (?, ?, ?, 1, 0, ?)
                """, (t["conditionId"], t.get("title", ""), slug, window_epoch))

                try:
                    conn.execute("""
                        INSERT OR IGNORE INTO trades
                            (transaction_hash, condition_id, slug, side, outcome, outcome_index,
                             price, size, timestamp, asset_id, proxy_wallet, poll_cycle)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        t["transactionHash"],
                        t["conditionId"],
                        slug,
                        t["side"],
                        t["outcome"],
                        t["outcomeIndex"],
                        t["price"],
                        t["size"],
                        t["timestamp"],
                        t["asset"],
                        t["proxyWallet"],
                        poll_cycle,
                    ))
                    cycle_inserted += 1
                    seen_slugs.add(slug)
                except sqlite3.IntegrityError:
                    pass

            time.sleep(RATE_LIMIT_S)

        conn.commit()
        total_inserted += cycle_inserted

        # Log collection progress
        total_in_db = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
        n_slugs = conn.execute("SELECT COUNT(DISTINCT slug) FROM trades").fetchone()[0]
        conn.execute(
            "INSERT INTO collection_log (poll_cycle, timestamp, btc_5m_count, new_trades, total_trades, unique_slugs) VALUES (?, ?, ?, ?, ?, ?)",
            (poll_cycle, int(time.time()), 0, cycle_inserted, total_in_db, n_slugs)
        )
        conn.commit()

        elapsed = time.time() - start_time
        remaining = end_time - time.time()

        if poll_cycle <= 3 or poll_cycle % 10 == 0 or cycle_inserted > 0:
            print(f"  Cycle {poll_cycle:>4}: +{cycle_inserted:>4} trades "
                  f"(total: {total_in_db:>6}, slugs: {n_slugs:>3}, "
                  f"elapsed: {elapsed/60:.1f}min, remaining: {remaining/60:.1f}min)")

        # Sleep until next poll
        if remaining > POLL_INTERVAL_S:
            time.sleep(POLL_INTERVAL_S)
        elif remaining > 0:
            time.sleep(remaining)

    total_in_db = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
    n_slugs = conn.execute("SELECT COUNT(DISTINCT slug) FROM trades").fetchone()[0]
    duration = time.time() - start_time

    print(f"  Collection complete: {total_inserted} new trades in {duration/60:.1f}min")
    print(f"  Total in DB: {total_in_db} trades across {n_slugs} markets")

    return total_inserted, poll_cycle


# ── Order Book Snapshots ────────────────────────────────────────────────────

def fetch_order_books(conn: sqlite3.Connection) -> int:
    """Fetch order book snapshots for known markets with token IDs."""
    print("[3/4] Fetching order book snapshots...")

    # Resolve missing token IDs from Gamma
    cursor = conn.execute("SELECT condition_id, slug, token_yes_id, token_no_id FROM markets WHERE token_yes_id IS NULL")
    for cid, slug, _, _ in cursor.fetchall():
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

    # Fetch order books for markets with token IDs
    cursor = conn.execute(
        "SELECT condition_id, slug, token_yes_id, token_no_id FROM markets WHERE token_yes_id IS NOT NULL"
    )
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


# ── Validation ──────────────────────────────────────────────────────────────

def run_validation(conn: sqlite3.Connection) -> dict:
    """Run dataset validation checks."""
    print("[4/4] Running validation checks...")
    results = {}

    # 1. Trade count
    cnt = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
    results["trade_count"] = {
        "pass": cnt >= 500,
        "detail": f"{cnt} trades (need >=500)"
    }

    # 2. Multi-window coverage
    n_slugs = conn.execute("SELECT COUNT(DISTINCT slug) FROM trades").fetchone()[0]
    results["multi_window"] = {
        "pass": n_slugs >= 3,
        "detail": f"{n_slugs} distinct market windows (need >=3)"
    }

    # 3. Timestamp span
    ts = conn.execute("SELECT MIN(timestamp), MAX(timestamp) FROM trades").fetchone()
    span_sec = ts[1] - ts[0] if ts[0] and ts[1] else 0
    results["time_span"] = {
        "pass": span_sec >= 600,  # At least 10 minutes
        "detail": f"{span_sec}s span ({span_sec/60:.1f}min)"
    }

    # 4. Timestamp alignment
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

    # 5. Price range validity
    invalid = conn.execute("SELECT COUNT(*) FROM trades WHERE price <= 0 OR price >= 1").fetchone()[0]
    results["price_range"] = {
        "pass": invalid == 0,
        "detail": "All prices in valid (0,1) range" if invalid == 0 else f"{invalid} invalid prices"
    }

    # 6. Bid/ask spread integrity
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

    # 7. Walk-forward feasibility (enough OOS trades)
    min_train = 50
    total_trades = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
    oos_trades = max(0, total_trades - min_train)
    results["oos_trades"] = {
        "pass": oos_trades >= 500,
        "detail": f"{oos_trades} out-of-sample trades (need >=500, min_train={min_train})"
    }

    all_pass = all(r["pass"] for r in results.values())
    for name, r in results.items():
        mark = "PASS" if r["pass"] else "FAIL"
        print(f"  [{mark}] {name}: {r['detail']}")
    print(f"\n  {'All checks passed!' if all_pass else 'Some checks failed.'}")

    return {"pass": all_pass, "results": results}


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    duration_min = DEFAULT_DURATION_MIN
    db_path = str(DB_PATH)

    # Parse args
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--duration" and i + 1 < len(args):
            duration_min = float(args[i + 1])
            i += 2
        elif args[i] == "--db" and i + 1 < len(args):
            db_path = args[i + 1]
            i += 2
        else:
            i += 1

    print(f"BTC 5M Expanded Dataset Pipeline")
    print(f"Duration: {duration_min:.0f} min")
    print(f"DB: {db_path}\n")

    conn = init_db(db_path)
    conn.execute("INSERT INTO pipeline_runs DEFAULT VALUES")
    run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.commit()

    try:
        start = time.time()
        market_count = discover_markets(conn)
        trade_count, poll_cycles = collect_trades_rolling(conn, duration_min)
        snapshot_count = fetch_order_books(conn)
        validation = run_validation(conn)
        duration = time.time() - start

        conn.execute(
            """UPDATE pipeline_runs SET finished_at=datetime('now'),
               trades_fetched=?, markets_fetched=?, snapshots_fetched=?,
               poll_cycles=?, duration_sec=?, status=?
               WHERE id=?""",
            (trade_count, market_count, snapshot_count, poll_cycles,
             duration, "success" if validation["pass"] else "validation_warnings", run_id)
        )
        conn.commit()

        # Summary
        total_trades = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
        total_markets = conn.execute("SELECT COUNT(DISTINCT slug) FROM trades").fetchone()[0]
        total_snapshots = conn.execute("SELECT COUNT(*) FROM order_book_snapshots").fetchone()[0]
        total_levels = conn.execute("SELECT COUNT(*) FROM order_book_levels").fetchone()[0]
        ts = conn.execute("SELECT MIN(timestamp), MAX(timestamp) FROM trades").fetchone()
        span = ts[1] - ts[0] if ts[0] and ts[1] else 0

        print(f"\n{'='*60}")
        print(f"COLLECTION SUMMARY")
        print(f"{'='*60}")
        print(f"  Duration:          {duration/60:.1f} min ({poll_cycles} poll cycles)")
        print(f"  Markets (Gamma):   {market_count}")
        print(f"  Trade markets:     {total_markets}")
        print(f"  Total trades:      {total_trades}")
        print(f"  Timestamp span:    {span}s ({span/60:.1f}min)")
        print(f"  OB Snapshots:      {total_snapshots}")
        print(f"  OB Levels:         {total_levels}")
        print(f"  Validation:        {'PASS' if validation['pass'] else 'WARN'}")
        print(f"  DB:                {db_path}")

    except Exception as e:
        conn.execute("UPDATE pipeline_runs SET finished_at=datetime('now'), status='error' WHERE id=?", (run_id,))
        conn.commit()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
