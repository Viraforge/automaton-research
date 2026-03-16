#!/usr/bin/env python3
"""Tests for signal_validation.py — DLD-329"""

import math
import sqlite3
import statistics
import tempfile
from pathlib import Path
from collections import Counter

import signal_validation as sv


def make_test_db(trades_data, markets_data=None):
    """Create a temp SQLite DB with test data."""
    path = tempfile.mktemp(suffix=".db")
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE markets (
            condition_id TEXT PRIMARY KEY, question TEXT, slug TEXT,
            token_yes_id TEXT, token_no_id TEXT, active INT DEFAULT 1,
            closed INT DEFAULT 0, accepting_orders INT DEFAULT 1,
            volume REAL, start_date TEXT, end_date TEXT,
            window_start_epoch INT, fetched_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_hash TEXT,
            condition_id TEXT, slug TEXT, side TEXT, outcome TEXT,
            outcome_index INT, price REAL, size REAL, timestamp INT,
            asset_id TEXT, proxy_wallet TEXT,
            fetched_at TEXT DEFAULT (datetime('now')), poll_cycle INT DEFAULT 0,
            UNIQUE(transaction_hash, asset_id, side, outcome_index)
        );
        CREATE TABLE order_book_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT, condition_id TEXT,
            asset_id TEXT, outcome TEXT, snapshot_ts INT,
            fetched_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE order_book_levels (
            id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_id INT,
            side TEXT, price REAL, size REAL, level_index INT
        );
        CREATE TABLE pipeline_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT,
            finished_at TEXT, trades_fetched INT, markets_fetched INT,
            snapshots_fetched INT, poll_cycles INT, duration_sec REAL, status TEXT
        );
        CREATE TABLE collection_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, poll_cycle INT,
            timestamp INT, btc_5m_count INT, new_trades INT,
            total_trades INT, unique_slugs INT
        );
    """)

    # Insert markets
    slugs = set()
    for t in trades_data:
        slug = t.get("slug", "btc-updown-5m-1000")
        slugs.add(slug)
    for slug in slugs:
        epoch = int(slug.split("-")[-1]) if slug.split("-")[-1].isdigit() else 0
        conn.execute(
            "INSERT OR IGNORE INTO markets (condition_id, question, slug, window_start_epoch) VALUES (?, ?, ?, ?)",
            (f"cid_{slug}", f"Q: {slug}", slug, epoch)
        )

    # Insert trades
    for i, t in enumerate(trades_data):
        conn.execute("""
            INSERT INTO trades (transaction_hash, condition_id, slug, side, outcome,
                               outcome_index, price, size, timestamp, asset_id, proxy_wallet)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            t.get("transactionHash", f"tx_{i}"),
            t.get("conditionId", f"cid_{t.get('slug', 'btc-updown-5m-1000')}"),
            t.get("slug", "btc-updown-5m-1000"),
            t.get("side", "BUY"),
            t.get("outcome", "Up"),
            t.get("outcomeIndex", 0 if t.get("outcome", "Up") == "Up" else 1),
            t.get("price", 0.5),
            t.get("size", 10.0),
            t.get("timestamp", 1000 + i),
            t.get("asset", f"asset_{i}"),
            t.get("proxyWallet", "wallet_test"),
        ))

    conn.commit()
    conn.close()
    return path


def generate_trades(n, slug="btc-updown-5m-1000", start_ts=1000, up_ratio=0.5):
    """Generate n synthetic trades."""
    import random
    random.seed(42)
    trades = []
    for i in range(n):
        outcome = "Up" if random.random() < up_ratio else "Down"
        trades.append({
            "slug": slug,
            "side": random.choice(["BUY", "SELL"]),
            "outcome": outcome,
            "price": round(random.uniform(0.3, 0.7), 2),
            "size": round(random.uniform(1, 50), 1),
            "timestamp": start_ts + i,
        })
    return trades


def generate_multi_window_trades(n_per_window=200, n_windows=5):
    """Generate trades across multiple market windows."""
    all_trades = []
    for w in range(n_windows):
        epoch = 1000 + w * 300
        slug = f"btc-updown-5m-{epoch}"
        trades = generate_trades(n_per_window, slug=slug, start_ts=epoch)
        all_trades.extend(trades)
    return all_trades


# ─── Tests ───

def test_signal_ofi_momentum():
    """OFI momentum produces signal in [-1, 1]."""
    trades = generate_trades(100)
    db_path = make_test_db(trades)
    loaded, _, _ = sv.load_expanded_data(db_path)
    signal = sv.signal_ofi_momentum(loaded, lookback=50)
    assert -1 <= signal <= 1, f"Signal out of range: {signal}"
    print("  PASS: signal_ofi_momentum in [-1,1]")
    Path(db_path).unlink()


def test_signal_ofi_momentum_all_up():
    """OFI momentum = 1.0 when all trades are Up."""
    trades = [{"outcome": "Up", "size": 10, "slug": "btc-updown-5m-1000", "price": 0.5, "side": "BUY", "timestamp": i} for i in range(100)]
    db_path = make_test_db(trades)
    loaded, _, _ = sv.load_expanded_data(db_path)
    signal = sv.signal_ofi_momentum(loaded, lookback=50)
    assert signal == 1.0, f"Expected 1.0, got {signal}"
    print("  PASS: OFI momentum = 1.0 for all-Up trades")
    Path(db_path).unlink()


def test_signal_ofi_momentum_all_down():
    """OFI momentum = -1.0 when all trades are Down."""
    trades = [{"outcome": "Down", "size": 10, "slug": "btc-updown-5m-1000", "price": 0.5, "side": "SELL", "timestamp": i} for i in range(100)]
    db_path = make_test_db(trades)
    loaded, _, _ = sv.load_expanded_data(db_path)
    signal = sv.signal_ofi_momentum(loaded, lookback=50)
    assert signal == -1.0, f"Expected -1.0, got {signal}"
    print("  PASS: OFI momentum = -1.0 for all-Down trades")
    Path(db_path).unlink()


def test_regime_detection_trending():
    """Trending regime detected when prices move directionally."""
    trades = [{"outcome": "Up", "price": 0.3 + i * 0.005, "size": 10, "timestamp": i, "slug": "btc-updown-5m-1000", "side": "BUY"} for i in range(60)]
    regime = sv.detect_regime(trades, window=50)
    assert regime == "trending", f"Expected 'trending', got '{regime}'"
    print("  PASS: trending regime detected for directional prices")


def test_regime_detection_range():
    """Range regime detected when prices oscillate."""
    import math
    trades = [{"outcome": "Up", "price": 0.5 + 0.05 * math.sin(i * 0.5), "size": 10, "timestamp": i, "slug": "btc-updown-5m-1000", "side": "BUY"} for i in range(60)]
    regime = sv.detect_regime(trades, window=50)
    assert regime == "range", f"Expected 'range', got '{regime}'"
    print("  PASS: range regime detected for oscillating prices")


def test_regime_detection_insufficient():
    """Insufficient data handled correctly."""
    trades = [{"outcome": "Up", "price": 0.5, "size": 10, "timestamp": i, "slug": "btc-updown-5m-1000", "side": "BUY"} for i in range(10)]
    regime = sv.detect_regime(trades, window=50)
    assert regime == "insufficient_data"
    print("  PASS: insufficient_data for short window")


def test_walk_forward_produces_results():
    """Walk-forward produces OOS results for sufficient data."""
    trades = generate_trades(200)
    db_path = make_test_db(trades)
    loaded, _, _ = sv.load_expanded_data(db_path)
    results, metrics = sv.walk_forward_backtest(loaded, sv.signal_ofi_momentum, min_train=50)
    assert metrics["total_trades"] > 0, "Expected OOS trades"
    assert metrics["total_trades"] == 150, f"Expected 150 OOS trades, got {metrics['total_trades']}"
    print(f"  PASS: walk-forward produced {metrics['total_trades']} OOS trades")
    Path(db_path).unlink()


def test_walk_forward_min_train():
    """Walk-forward respects min_train parameter."""
    trades = generate_trades(100)
    db_path = make_test_db(trades)
    loaded, _, _ = sv.load_expanded_data(db_path)
    results, metrics = sv.walk_forward_backtest(loaded, sv.signal_ofi_momentum, min_train=80)
    assert metrics["total_trades"] == 20, f"Expected 20 OOS, got {metrics['total_trades']}"
    print(f"  PASS: min_train=80 produces exactly 20 OOS trades")
    Path(db_path).unlink()


def test_walk_forward_insufficient_data():
    """Walk-forward handles too few trades gracefully."""
    trades = generate_trades(30)
    db_path = make_test_db(trades)
    loaded, _, _ = sv.load_expanded_data(db_path)
    results, metrics = sv.walk_forward_backtest(loaded, sv.signal_ofi_momentum, min_train=50)
    assert metrics["total_trades"] == 0
    print("  PASS: no OOS trades when data < min_train")
    Path(db_path).unlink()


def test_bootstrap_significance_random():
    """Bootstrap test for random data should have high p-value."""
    import random
    random.seed(42)
    pnl = [random.gauss(0, 1) for _ in range(200)]
    boot = sv.bootstrap_significance(pnl)
    assert boot["p_value_two_sided"] > 0.05, f"Random PnL should not be significant, p={boot['p_value_two_sided']}"
    print(f"  PASS: random PnL not significant (p={boot['p_value_two_sided']:.3f})")


def test_bootstrap_significance_positive():
    """Bootstrap test for consistently positive PnL should be significant."""
    import random
    random.seed(42)
    pnl = [random.gauss(1, 0.3) for _ in range(200)]
    boot = sv.bootstrap_significance(pnl)
    assert boot["significant_at_05"], f"Positive PnL should be significant, p={boot['p_value_two_sided']}"
    print(f"  PASS: positive PnL is significant (p={boot['p_value_two_sided']:.4f})")


def test_bootstrap_confidence_interval():
    """Bootstrap CI should contain the observed mean."""
    import random
    random.seed(42)
    pnl = [random.gauss(0.5, 1) for _ in range(100)]
    boot = sv.bootstrap_significance(pnl)
    assert boot["ci_95"][0] <= boot["observed_mean"] <= boot["ci_95"][1], \
        f"Mean {boot['observed_mean']} not in CI {boot['ci_95']}"
    print(f"  PASS: observed mean in 95% CI")


def test_compute_metrics():
    """Metrics computation sanity checks."""
    pnl = [1.0, -0.5, 0.8, -0.3, 1.2, -0.4, 0.6]
    m = sv.compute_metrics(pnl, correct=4, total=7)
    assert m["total_trades"] == 7
    assert abs(m["win_rate"] - 4/7) < 0.01
    assert m["total_pnl"] == round(sum(pnl), 2)
    assert m["max_drawdown"] >= 0
    assert m["profit_factor"] > 0
    print(f"  PASS: metrics computation correct")


def test_compute_metrics_empty():
    """Metrics handles empty PnL series."""
    m = sv.compute_metrics([], correct=0, total=0)
    assert m["total_trades"] == 0
    print("  PASS: empty metrics handled")


def test_regime_split_evaluation():
    """Regime split returns metrics for each regime."""
    trades = generate_trades(200)
    db_path = make_test_db(trades)
    loaded, _, _ = sv.load_expanded_data(db_path)
    overall, regime = sv.regime_split_evaluation(loaded, sv.signal_ofi_momentum, min_train=50)
    assert overall["total_trades"] > 0
    assert len(regime) > 0
    for rn, rm in regime.items():
        assert rm["total_trades"] >= 0
    print(f"  PASS: regime split: {list(regime.keys())}")
    Path(db_path).unlink()


def test_multi_window_walk_forward():
    """Walk-forward works across multiple market windows."""
    trades = generate_multi_window_trades(n_per_window=200, n_windows=5)
    db_path = make_test_db(trades)
    loaded, _, _ = sv.load_expanded_data(db_path)
    results, metrics = sv.walk_forward_backtest(loaded, sv.signal_ofi_momentum, min_train=50)
    assert metrics["total_trades"] >= 900, f"Expected >= 900 OOS trades, got {metrics['total_trades']}"
    # Check trades span multiple slugs
    slugs = set(r["slug"] for r in results)
    assert len(slugs) >= 3, f"Expected OOS trades from >= 3 windows, got {len(slugs)}"
    print(f"  PASS: multi-window walk-forward: {metrics['total_trades']} OOS, {len(slugs)} windows")
    Path(db_path).unlink()


def test_per_market_analysis():
    """Per-market analysis returns results for each market."""
    trades = generate_multi_window_trades(n_per_window=150, n_windows=4)
    db_path = make_test_db(trades)
    loaded, _, _ = sv.load_expanded_data(db_path)
    pm = sv.per_market_analysis(loaded, sv.signal_ofi_momentum, min_train=50)
    assert len(pm) == 4
    for slug, info in pm.items():
        if "metrics" in info:
            assert info["metrics"]["total_trades"] > 0
    print(f"  PASS: per-market analysis: {len(pm)} markets")
    Path(db_path).unlink()


def test_signal_regime_filtered():
    """Regime-filtered signal returns 0 for trending regime."""
    # Create strongly trending trades
    trades = [{"outcome": "Up", "price": 0.3 + i * 0.005, "size": 10, "timestamp": i, "slug": "btc-updown-5m-1000", "side": "BUY"} for i in range(100)]
    signal = sv.signal_regime_filtered_ofi(trades, lookback=50)
    assert signal == 0, f"Expected 0 in trending regime, got {signal}"
    print("  PASS: regime-filtered signal = 0 in trending")


def test_signal_regime_filtered_range():
    """Regime-filtered signal produces non-zero for range regime."""
    import math
    trades = [{"outcome": "Up" if i % 3 < 2 else "Down",
               "price": 0.5 + 0.02 * math.sin(i * 0.3),
               "size": 10, "timestamp": i,
               "slug": "btc-updown-5m-1000", "side": "BUY"} for i in range(100)]
    signal = sv.signal_regime_filtered_ofi(trades, lookback=50)
    # Should be non-zero since it's range-bound with Up-heavy flow
    assert signal != 0, f"Expected non-zero in range regime, got {signal}"
    print(f"  PASS: regime-filtered signal non-zero in range ({signal:.4f})")


def test_ensemble_signal():
    """Ensemble produces reasonable signal."""
    trades = generate_trades(100)
    db_path = make_test_db(trades)
    loaded, _, _ = sv.load_expanded_data(db_path)
    signal = sv.signal_ensemble(loaded)
    assert -1 <= signal <= 1, f"Ensemble out of range: {signal}"
    print(f"  PASS: ensemble signal in range ({signal:.4f})")
    Path(db_path).unlink()


def test_sharpe_ratio_calculation():
    """Sharpe ratio calculation is consistent."""
    # Near-constant positive PnL with tiny variance
    pnl = [0.1 + 0.0001 * i for i in range(100)]
    m = sv.compute_metrics(pnl, correct=100, total=100)
    assert m["sharpe_ratio"] > 100, f"Expected very high Sharpe, got {m['sharpe_ratio']}"
    print(f"  PASS: Sharpe for near-constant positive PnL is very high ({m['sharpe_ratio']})")


def test_profit_factor():
    """Profit factor calculation."""
    pnl = [2.0, -1.0, 3.0, -1.5]
    m = sv.compute_metrics(pnl, correct=2, total=4)
    expected_pf = (2.0 + 3.0) / (1.0 + 1.5)
    assert abs(m["profit_factor"] - round(expected_pf, 2)) < 0.01
    print(f"  PASS: profit factor = {m['profit_factor']}")


def test_max_drawdown():
    """Max drawdown is correctly computed."""
    pnl = [1.0, 1.0, -3.0, 1.0]  # DD = 3.0 - 1.0 = 1.0 after peak
    m = sv.compute_metrics(pnl, correct=3, total=4)
    # Peak at cum=2.0, trough at cum=-1.0, DD=3.0
    assert m["max_drawdown"] == 3.0, f"Expected DD=3.0, got {m['max_drawdown']}"
    print(f"  PASS: max drawdown = {m['max_drawdown']}")


# ─── Run all tests ───

if __name__ == "__main__":
    tests = [
        test_signal_ofi_momentum,
        test_signal_ofi_momentum_all_up,
        test_signal_ofi_momentum_all_down,
        test_regime_detection_trending,
        test_regime_detection_range,
        test_regime_detection_insufficient,
        test_walk_forward_produces_results,
        test_walk_forward_min_train,
        test_walk_forward_insufficient_data,
        test_bootstrap_significance_random,
        test_bootstrap_significance_positive,
        test_bootstrap_confidence_interval,
        test_compute_metrics,
        test_compute_metrics_empty,
        test_regime_split_evaluation,
        test_multi_window_walk_forward,
        test_per_market_analysis,
        test_signal_regime_filtered,
        test_signal_regime_filtered_range,
        test_ensemble_signal,
        test_sharpe_ratio_calculation,
        test_profit_factor,
        test_max_drawdown,
    ]

    passed = 0
    failed = 0
    print(f"Running {len(tests)} tests...\n")
    for test in tests:
        try:
            test()
            passed += 1
        except Exception as e:
            print(f"  FAIL: {test.__name__}: {e}")
            failed += 1

    print(f"\n{'='*50}")
    print(f"Results: {passed}/{passed+failed} passed, {failed} failed")
    if failed == 0:
        print("All tests passed!")
