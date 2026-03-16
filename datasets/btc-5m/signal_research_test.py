"""
Tests for signal_research.py — DLD-326

Run: python3 datasets/btc-5m/signal_research_test.py
"""

import sys
import os
import statistics

# Ensure module is importable
sys.path.insert(0, os.path.dirname(__file__))

from signal_research import (
    load_data,
    compute_order_flow_imbalance,
    compute_cumulative_ofi,
    compute_order_book_imbalance,
    compute_price_signals,
    compute_cross_market_signals,
    walk_forward_backtest,
    compute_metrics,
    signal_ofi_momentum,
    signal_ofi_mean_reversion,
    signal_price_momentum,
    signal_volume_weighted_direction,
    signal_ensemble,
    detect_regime,
    regime_split_evaluation,
    bootstrap_significance,
)

passed = 0
failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS: {name}")
    else:
        failed += 1
        print(f"  FAIL: {name} — {detail}")


def test_load_data():
    print("\n--- test_load_data ---")
    trades, markets, snapshots = load_data()
    check("trades loaded", len(trades) >= 500, f"got {len(trades)}")
    check("markets loaded", len(markets) > 0, f"got {len(markets)}")
    check("snapshots loaded", len(snapshots) > 0, f"got {len(snapshots)}")
    check("trade has required fields", all(k in trades[0] for k in ["timestamp", "side", "outcome", "price", "size"]))
    check("snapshot has levels", len(snapshots[0]["levels"]) > 0)
    return trades, markets, snapshots


def test_order_flow_imbalance(trades):
    print("\n--- test_order_flow_imbalance ---")
    ofi = compute_order_flow_imbalance(trades, window_sec=10)
    check("OFI computed", len(ofi) > 0, f"got {len(ofi)} windows")
    check("OFI range [-1,1]", all(-1 <= w["ofi_buysell"] <= 1 for w in ofi))
    check("OFI direction range [-1,1]", all(-1 <= w["ofi_direction"] <= 1 for w in ofi))
    check("volumes positive", all(w["total_vol"] > 0 for w in ofi))
    check("implied prob [0,1]", all(0 <= w["implied_prob_up"] <= 1 for w in ofi))

    # Cumulative OFI
    cum = compute_cumulative_ofi(ofi)
    check("cumulative OFI computed", len(cum) == len(ofi))
    check("cum_ofi field present", "cum_ofi" in cum[0])
    return ofi


def test_order_book_imbalance(snapshots):
    print("\n--- test_order_book_imbalance ---")
    obi = compute_order_book_imbalance(snapshots)
    check("OBI computed", len(obi) > 0, f"got {len(obi)} entries")
    check("OBI range [-1,1]", all(-1 <= o["obi"] <= 1 for o in obi))
    check("spread non-negative", all(o["spread"] >= 0 for o in obi))
    check("mid_price in [0,1]", all(0 <= o["mid_price"] <= 1 for o in obi))
    check("depth fields present", all("bid_depth" in o and "ask_depth" in o for o in obi))

    # Up/Down symmetry: OBI for Up and Down of same market should be roughly opposite
    up = [o for o in obi if o["outcome"] == "Up"]
    down = [o for o in obi if o["outcome"] == "Down"]
    if up and down:
        check("Up/Down OBI antisymmetric", abs(up[0]["obi"] + down[0]["obi"]) < 0.01,
              f"up={up[0]['obi']}, down={down[0]['obi']}")
    return obi


def test_price_signals(trades):
    print("\n--- test_price_signals ---")
    ps = compute_price_signals(trades, lookback_trades=20)
    check("price signals computed", len(ps) > 0, f"got {len(ps)}")
    check("momentum field present", "momentum" in ps[0])
    check("z_score field present", "z_score" in ps[0])
    check("price in [0,1]", all(0 <= p["price"] <= 1 for p in ps))
    check("vwap in [0,1]", all(0 <= p["vwap"] <= 1 for p in ps))
    return ps


def test_cross_market_signals(trades, markets):
    print("\n--- test_cross_market_signals ---")
    cs = compute_cross_market_signals(trades, markets)
    check("cross-market computed", len(cs) > 0, f"got {len(cs)}")
    check("implied prob [0,1]", all(0 <= c["implied_prob_up"] <= 1 for c in cs))
    check("trade count positive", all(c["trade_count"] > 0 for c in cs))
    # Second entry should have spread_from_prev
    if len(cs) > 1:
        check("spread_from_prev computed", "spread_from_prev" in cs[1])
    return cs


def test_signal_functions(trades):
    print("\n--- test_signal_functions ---")
    # All signal functions should return a value in [-1, 1]
    s1 = signal_ofi_momentum(trades[:100], 20)
    check("OFI momentum in range", -1 <= s1 <= 1, f"got {s1}")

    s2 = signal_ofi_mean_reversion(trades[:100], 20)
    check("OFI mean rev = -momentum", abs(s2 + s1) < 1e-10)

    s3 = signal_price_momentum(trades[:100], 20)
    check("price momentum in range", -1 <= s3 <= 1, f"got {s3}")

    s4 = signal_volume_weighted_direction(trades[:100], 30)
    check("vol-weighted dir in range", -1 <= s4 <= 1, f"got {s4}")

    s5 = signal_ensemble(trades[:100])
    check("ensemble in range", -1 <= s5 <= 1, f"got {s5}")

    # Empty/small inputs
    s_empty = signal_ofi_momentum([], 20)
    check("empty trades -> 0", s_empty == 0)

    s_small = signal_ofi_momentum(trades[:5], 20)
    check("small window still works", -1 <= s_small <= 1)


def test_walk_forward_backtest(trades):
    print("\n--- test_walk_forward_backtest ---")
    main_trades = [t for t in trades if t["slug"] == "btc-updown-5m-1773668700"]

    results, metrics = walk_forward_backtest(
        main_trades,
        lambda t: signal_ofi_momentum(t, 50),
        min_train=50
    )

    check("backtest produces trades", metrics["total_trades"] > 0, f"got {metrics['total_trades']}")
    check("win rate in [0,1]", 0 <= metrics["win_rate"] <= 1)
    check("sharpe is finite", not (metrics["sharpe_ratio"] != metrics["sharpe_ratio"]))  # NaN check
    check("max drawdown >= 0", metrics["max_drawdown"] >= 0)
    check("profit factor >= 0", metrics["profit_factor"] >= 0)
    check("cum_pnl field in results", "cum_pnl" in results[-1] if results else True)

    # PnL should sum correctly
    pnl_sum = sum(r["trade_pnl"] for r in results)
    check("PnL sums correctly", abs(pnl_sum - metrics["total_pnl"]) < 1, f"diff={abs(pnl_sum - metrics['total_pnl'])}")


def test_regime_detection(trades):
    print("\n--- test_regime_detection ---")
    regime = detect_regime(trades[:50], window=50)
    check("regime detected", regime in ("trending", "range", "insufficient_data"), f"got {regime}")

    regime_small = detect_regime(trades[:5], window=50)
    check("insufficient data handled", regime_small == "insufficient_data")

    # Regime-split evaluation
    main_trades = [t for t in trades if t["slug"] == "btc-updown-5m-1773668700"]
    overall, regime_metrics = regime_split_evaluation(
        main_trades, lambda t: signal_ofi_momentum(t, 50), min_train=50
    )
    check("regime split has results", len(regime_metrics) > 0)
    check("overall metrics present", overall["total_trades"] > 0)


def test_bootstrap_significance():
    print("\n--- test_bootstrap_significance ---")
    # Clearly positive series
    pos = [1.0] * 50
    result = bootstrap_significance(pos)
    check("positive series significant", result["significant_at_05"])
    check("p-value near 0", result["p_value"] < 0.05, f"p={result['p_value']}")

    # Mixed series
    mixed = [1, -1, 1, -1, 1, -1, 1, -1, 1, -1]
    result2 = bootstrap_significance(mixed)
    check("mixed series not significant", not result2["significant_at_05"] or result2["p_value"] > 0.01)

    # Small sample
    result3 = bootstrap_significance([1, 2])
    check("small sample handled", result3["p_value"] == 1.0)


def test_compute_metrics():
    print("\n--- test_compute_metrics ---")
    # No trades
    m = compute_metrics([], 0, 0)
    check("no trades handled", m["total_trades"] == 0)

    # Perfect trades
    m2 = compute_metrics([10, 10, 10], 3, 3)
    check("perfect win rate", m2["win_rate"] == 1.0)
    check("total PnL correct", m2["total_pnl"] == 30)
    check("max drawdown zero", m2["max_drawdown"] == 0)

    # Mixed trades
    m3 = compute_metrics([10, -5, 10, -5], 2, 4)
    check("mixed win rate 0.5", m3["win_rate"] == 0.5)
    check("mixed PnL positive", m3["total_pnl"] == 10)


if __name__ == "__main__":
    print("=" * 60)
    print("Signal Research Test Suite — DLD-326")
    print("=" * 60)

    trades, markets, snapshots = test_load_data()
    test_order_flow_imbalance(trades)
    test_order_book_imbalance(snapshots)
    test_price_signals(trades)
    test_cross_market_signals(trades, markets)
    test_signal_functions(trades)
    test_walk_forward_backtest(trades)
    test_regime_detection(trades)
    test_bootstrap_significance()
    test_compute_metrics()

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed out of {passed + failed}")
    print(f"{'=' * 60}")

    sys.exit(1 if failed > 0 else 0)
