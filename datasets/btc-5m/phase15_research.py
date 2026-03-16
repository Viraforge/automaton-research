#!/usr/bin/env python3
"""
Phase 1.5 Signal Research — DLD-341

Comprehensive signal candidate discovery and evaluation on the expanded BTC 5M dataset.
Evaluates all candidates against the 7 evaluation gates:

  1. Trade Count >= 500
  2. Positive EV per trade after 10bps fees
  3. Sharpe >= 1.0 annualized
  4. Profitable in >= 2 of 3 regimes (bull/bear/sideways)
  5. Walk-forward consistent (OOS positive)
  6. <= 5 tunable parameters
  7. Max drawdown < 15% of peak equity

Signal candidates:
  - OFI Momentum (L=50) — prior lead candidate
  - OFI Momentum (L=20) — shorter lookback variant
  - Volume-Weighted Direction (L=30)
  - Mean Reversion (L=30)
  - Volatility Breakout (L=40, mult=1.5)
  - Ensemble (OFI + VWD + Price Momentum)
  - Regime-Filtered OFI (L=50)
"""

import sqlite3
import math
import statistics
import random
import json
from collections import defaultdict, Counter
from pathlib import Path
from datetime import datetime, timezone

DB_PATH = Path(__file__).parent / "btc_5m_expanded.db"
FEE_BPS = 10  # 10 basis points per trade
FEE_RATE = FEE_BPS / 10000  # 0.001
INITIAL_CAPITAL = 10000  # Assumed initial capital for DD% calculation


def load_data(db_path=None):
    """Load all trades and OB snapshots from the expanded dataset."""
    path = str(db_path or DB_PATH)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row

    trades = [dict(r) for r in db.execute(
        "SELECT * FROM trades ORDER BY timestamp, id"
    ).fetchall()]

    markets = [dict(r) for r in db.execute(
        "SELECT * FROM markets ORDER BY window_start_epoch"
    ).fetchall()]

    snapshots = []
    for snap in db.execute("SELECT * FROM order_book_snapshots ORDER BY snapshot_ts, id").fetchall():
        snap_d = dict(snap)
        snap_d["levels"] = [dict(l) for l in db.execute(
            "SELECT * FROM order_book_levels WHERE snapshot_id = ? ORDER BY side, level_index",
            (snap_d["id"],)
        ).fetchall()]
        snapshots.append(snap_d)

    db.close()
    return trades, markets, snapshots


# ---------------------------------------------------------------------------
# Signal Functions
# ---------------------------------------------------------------------------

def signal_ofi_momentum(train_trades, lookback=50):
    """Order flow imbalance momentum. Params: lookback."""
    recent = train_trades[-lookback:]
    up_vol = sum(t["size"] for t in recent if t["outcome"] == "Up")
    down_vol = sum(t["size"] for t in recent if t["outcome"] == "Down")
    total = up_vol + down_vol
    if total == 0:
        return 0
    return (up_vol - down_vol) / total


def signal_ofi_momentum_20(train_trades):
    """OFI Momentum with L=20."""
    return signal_ofi_momentum(train_trades, lookback=20)


def signal_volume_weighted_direction(train_trades, lookback=30):
    """Volume-weighted directional signal with recency bias. Params: lookback."""
    recent = train_trades[-lookback:]
    if not recent:
        return 0
    weighted_sum = 0
    weight_total = 0
    for i, t in enumerate(recent):
        recency = (i + 1) / len(recent)
        vol_weight = t["size"] * recency
        direction = 1 if t["outcome"] == "Up" else -1
        weighted_sum += direction * vol_weight
        weight_total += vol_weight
    return weighted_sum / weight_total if weight_total > 0 else 0


def signal_price_momentum(train_trades, lookback=20):
    """Price momentum signal. Params: lookback."""
    recent = train_trades[-lookback:]
    prices = []
    for t in recent:
        p = t["price"] if t["outcome"] == "Up" else 1 - t["price"]
        prices.append(p)
    if len(prices) < 2:
        return 0
    return statistics.mean(prices) - 0.5


def signal_mean_reversion(train_trades, lookback=30):
    """
    Mean reversion: bet against extreme recent moves.
    If recent win rate is high, bet Down (reversion); if low, bet Up.
    Params: lookback.
    """
    recent = train_trades[-lookback:]
    if not recent:
        return 0
    up_count = sum(1 for t in recent if t["outcome"] == "Up")
    up_ratio = up_count / len(recent)
    # Invert: high up_ratio -> negative signal (bet Down), low -> positive (bet Up)
    return -(up_ratio - 0.5)


def signal_volatility_breakout(train_trades, lookback=40, mult=1.5):
    """
    Volatility breakout: trade when recent price movement exceeds
    mult * rolling volatility. Direction follows the breakout.
    Params: lookback, mult.
    """
    if len(train_trades) < lookback:
        return 0
    recent = train_trades[-lookback:]
    prices = []
    for t in recent:
        p = t["price"] if t["outcome"] == "Up" else 1 - t["price"]
        prices.append(p)

    if len(prices) < 5:
        return 0

    returns = [prices[i] - prices[i - 1] for i in range(1, len(prices))]
    if not returns:
        return 0

    vol = statistics.stdev(returns) if len(returns) > 1 else 0
    if vol == 0:
        return 0

    recent_move = prices[-1] - statistics.mean(prices[:-1])
    z_score = recent_move / vol

    if abs(z_score) > mult:
        return 1.0 if z_score > 0 else -1.0
    return 0


def signal_ensemble(train_trades):
    """Ensemble: OFI(50) + VWD(30) + Price(20). Params: none (sub-signal params fixed)."""
    s1 = signal_ofi_momentum(train_trades, 50)
    s2 = signal_volume_weighted_direction(train_trades, 30)
    s3 = signal_price_momentum(train_trades, 20)
    return (s1 + s2 + s3) / 3


def signal_regime_filtered_ofi(train_trades, lookback=50):
    """OFI Momentum with regime filter — flat in sideways. Params: lookback."""
    regime = detect_regime_3way(train_trades)
    if regime == "sideways":
        return 0
    return signal_ofi_momentum(train_trades, lookback)


# ---------------------------------------------------------------------------
# Regime Detection — 3-way (bull / bear / sideways)
# ---------------------------------------------------------------------------

def detect_regime_3way(trades, window=50):
    """
    Classify market regime into bull, bear, or sideways.
    Uses price path direction and efficiency ratio.
    """
    if len(trades) < window:
        return "sideways"

    prices = []
    for t in trades[-window:]:
        p = t["price"] if t["outcome"] == "Up" else 1 - t["price"]
        prices.append(p)

    net_move = prices[-1] - prices[0]
    total_move = sum(abs(prices[i] - prices[i - 1]) for i in range(1, len(prices)))

    if total_move == 0:
        return "sideways"

    efficiency = abs(net_move) / total_move

    if efficiency < 0.2:
        return "sideways"
    elif net_move > 0:
        return "bull"
    else:
        return "bear"


# ---------------------------------------------------------------------------
# Walk-Forward Backtest with Fee Deduction
# ---------------------------------------------------------------------------

def walk_forward_backtest(trades, signal_fn, threshold=0.0, min_train=50,
                          fee_rate=FEE_RATE, initial_capital=INITIAL_CAPITAL):
    """
    Walk-forward backtest with expanding window and fee deduction.
    Fee is applied as a fraction of trade size on every trade.
    Drawdown % is computed relative to (initial_capital + peak_pnl).
    """
    results = []
    correct = 0
    total = 0
    pnl = 0.0
    pnl_series = []
    peak_equity = initial_capital  # Start with initial capital
    max_dd_pct = 0.0
    equity = initial_capital

    for i in range(min_train, len(trades)):
        train = trades[:i]
        test_trade = trades[i]

        signal = signal_fn(train)
        if abs(signal) < threshold:
            continue

        predicted = "Up" if signal > 0 else "Down"
        actual = test_trade["outcome"]
        entry_price = test_trade["price"]
        size = test_trade["size"]

        # PnL before fees
        if predicted == actual:
            raw_pnl = (1.0 - entry_price) * size
            correct += 1
        else:
            raw_pnl = -entry_price * size

        # Fee deduction: fee_rate * notional (size)
        fee = fee_rate * size
        trade_pnl = raw_pnl - fee

        total += 1
        pnl += trade_pnl
        equity += trade_pnl
        pnl_series.append(trade_pnl)

        # Track drawdown as percentage of peak equity (capital + cumulative PnL)
        if equity > peak_equity:
            peak_equity = equity
        if peak_equity > 0:
            dd_pct = (peak_equity - equity) / peak_equity
            max_dd_pct = max(max_dd_pct, dd_pct)

        results.append({
            "trade_index": i,
            "timestamp": test_trade["timestamp"],
            "slug": test_trade["slug"],
            "signal": round(signal, 4),
            "predicted": predicted,
            "actual": actual,
            "entry_price": round(entry_price, 4),
            "raw_pnl": round(raw_pnl, 4),
            "fee": round(fee, 4),
            "trade_pnl": round(trade_pnl, 4),
            "cum_pnl": round(pnl, 2),
            "equity": round(equity, 2),
        })

    metrics = compute_metrics(pnl_series, correct, total, max_dd_pct)
    return results, metrics


def compute_metrics(pnl_series, correct, total, max_dd_pct=0.0):
    """Compute backtest performance metrics."""
    if total == 0:
        return {"total_trades": 0, "note": "no trades generated"}

    win_rate = correct / total
    avg_pnl = statistics.mean(pnl_series)
    total_pnl = sum(pnl_series)

    if len(pnl_series) > 1:
        std_pnl = statistics.stdev(pnl_series)
        # Annualized Sharpe: 288 5-min periods/day * 365 days
        sharpe = (avg_pnl / std_pnl) * math.sqrt(288 * 365) if std_pnl > 0 else 0
    else:
        std_pnl = 0
        sharpe = 0

    # Absolute max drawdown
    peak = 0
    max_dd_abs = 0
    cum = 0
    for p in pnl_series:
        cum += p
        peak = max(peak, cum)
        dd = peak - cum
        max_dd_abs = max(max_dd_abs, dd)

    wins = [p for p in pnl_series if p > 0]
    losses = [p for p in pnl_series if p < 0]
    gross_profit = sum(wins) if wins else 0
    gross_loss = abs(sum(losses)) if losses else 0
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else (
        float("inf") if gross_profit > 0 else 0
    )

    return {
        "total_trades": total,
        "win_rate": round(win_rate, 4),
        "avg_pnl_per_trade": round(avg_pnl, 4),
        "total_pnl": round(total_pnl, 2),
        "sharpe_ratio": round(sharpe, 2),
        "max_drawdown_abs": round(max_dd_abs, 2),
        "max_drawdown_pct": round(max_dd_pct * 100, 2),
        "profit_factor": round(profit_factor, 2),
        "std_pnl": round(std_pnl, 4),
        "gross_profit": round(gross_profit, 2),
        "gross_loss": round(gross_loss, 2),
    }


# ---------------------------------------------------------------------------
# Regime-Split Evaluation (3-way)
# ---------------------------------------------------------------------------

def regime_split_evaluation(trades, signal_fn, min_train=50):
    """Walk-forward with 3-way regime split (bull/bear/sideways)."""
    results, overall = walk_forward_backtest(trades, signal_fn, min_train=min_train)

    regime_results = defaultdict(list)
    for r in results:
        idx = r["trade_index"]
        regime = detect_regime_3way(trades[:idx], window=min(50, idx))
        regime_results[regime].append(r["trade_pnl"])

    regime_metrics = {}
    for regime, pnls in regime_results.items():
        correct = len([p for p in pnls if p > 0])
        # Compute dd pct for each regime (relative to initial capital fraction)
        peak = INITIAL_CAPITAL
        max_dd_pct = 0
        cum = INITIAL_CAPITAL
        for p in pnls:
            cum += p
            if cum > peak:
                peak = cum
            if peak > 0:
                dd_pct = (peak - cum) / peak
                max_dd_pct = max(max_dd_pct, dd_pct)
        regime_metrics[regime] = compute_metrics(pnls, correct, len(pnls), max_dd_pct)

    return overall, regime_metrics


# ---------------------------------------------------------------------------
# Bootstrap Significance Test
# ---------------------------------------------------------------------------

def bootstrap_significance(pnl_series, n_bootstrap=5000):
    """Bootstrap test: is mean PnL significantly > 0?"""
    if len(pnl_series) < 5:
        return {"p_value": 1.0, "ci_95": (0, 0), "note": "insufficient data"}

    observed_mean = statistics.mean(pnl_series)
    n = len(pnl_series)

    random.seed(42)
    boot_means = []
    for _ in range(n_bootstrap):
        sample = random.choices(pnl_series, k=n)
        boot_means.append(statistics.mean(sample))

    boot_means.sort()

    p_value = sum(1 for m in boot_means if m <= 0) / n_bootstrap
    ci_low = boot_means[int(0.025 * n_bootstrap)]
    ci_high = boot_means[int(0.975 * n_bootstrap)]

    return {
        "observed_mean": round(observed_mean, 6),
        "p_value": round(p_value, 4),
        "ci_95": (round(ci_low, 6), round(ci_high, 6)),
        "significant_at_05": p_value < 0.05,
        "n_samples": n,
        "n_bootstrap": n_bootstrap,
    }


# ---------------------------------------------------------------------------
# Walk-Forward Consistency Check
# ---------------------------------------------------------------------------

def walk_forward_consistency(trades, signal_fn, n_folds=5, min_train=50):
    """
    Check walk-forward consistency by splitting OOS into n_folds sequential segments.
    Each segment should be independently profitable.
    """
    results, overall = walk_forward_backtest(trades, signal_fn, min_train=min_train)
    if not results:
        return {"consistent": False, "note": "no trades"}

    pnl_series = [r["trade_pnl"] for r in results]
    fold_size = len(pnl_series) // n_folds
    if fold_size < 10:
        return {"consistent": False, "note": f"too few trades per fold ({fold_size})"}

    fold_results = []
    profitable_folds = 0
    for i in range(n_folds):
        start = i * fold_size
        end = start + fold_size if i < n_folds - 1 else len(pnl_series)
        fold_pnl = pnl_series[start:end]
        fold_total = sum(fold_pnl)
        fold_avg = statistics.mean(fold_pnl)
        is_profitable = fold_total > 0
        if is_profitable:
            profitable_folds += 1
        fold_results.append({
            "fold": i + 1,
            "trades": len(fold_pnl),
            "total_pnl": round(fold_total, 2),
            "avg_pnl": round(fold_avg, 4),
            "profitable": is_profitable,
        })

    consistent = profitable_folds >= math.ceil(n_folds * 0.6)  # >= 60% of folds profitable

    return {
        "consistent": consistent,
        "profitable_folds": profitable_folds,
        "total_folds": n_folds,
        "folds": fold_results,
    }


# ---------------------------------------------------------------------------
# Signal Candidate Registry
# ---------------------------------------------------------------------------

CANDIDATES = {
    "OFI Momentum (L=50)": {
        "fn": lambda t: signal_ofi_momentum(t, 50),
        "params": ["lookback=50"],
        "param_count": 1,
        "category": "momentum",
    },
    "OFI Momentum (L=20)": {
        "fn": signal_ofi_momentum_20,
        "params": ["lookback=20"],
        "param_count": 1,
        "category": "momentum",
    },
    "Vol-Weighted Dir (L=30)": {
        "fn": signal_volume_weighted_direction,
        "params": ["lookback=30"],
        "param_count": 1,
        "category": "momentum",
    },
    "Mean Reversion (L=30)": {
        "fn": signal_mean_reversion,
        "params": ["lookback=30"],
        "param_count": 1,
        "category": "mean_reversion",
    },
    "Volatility Breakout (L=40, m=1.5)": {
        "fn": lambda t: signal_volatility_breakout(t, 40, 1.5),
        "params": ["lookback=40", "mult=1.5"],
        "param_count": 2,
        "category": "volatility_breakout",
    },
    "Price Momentum (L=20)": {
        "fn": signal_price_momentum,
        "params": ["lookback=20"],
        "param_count": 1,
        "category": "momentum",
    },
    "Ensemble (OFI+VWD+PM)": {
        "fn": signal_ensemble,
        "params": ["ofi_L=50", "vwd_L=30", "pm_L=20"],
        "param_count": 3,
        "category": "ensemble",
    },
    "Regime-Filtered OFI (L=50)": {
        "fn": signal_regime_filtered_ofi,
        "params": ["lookback=50", "regime_window=50"],
        "param_count": 2,
        "category": "momentum",
    },
}


# ---------------------------------------------------------------------------
# Gate Evaluation
# ---------------------------------------------------------------------------

def evaluate_gates(name, candidate, metrics, regime_metrics, boot, wf_consistency):
    """Evaluate a signal candidate against all 7 gates."""
    gates = {}

    # Gate 1: Trade Count >= 500
    gates["trade_count"] = {
        "pass": metrics["total_trades"] >= 500,
        "value": metrics["total_trades"],
        "threshold": 500,
    }

    # Gate 2: Positive EV per trade after 10bps fees
    gates["positive_ev"] = {
        "pass": metrics["avg_pnl_per_trade"] > 0,
        "value": round(metrics["avg_pnl_per_trade"], 4),
        "threshold": "> 0 (after 10bps fees)",
    }

    # Gate 3: Sharpe >= 1.0 annualized
    gates["sharpe"] = {
        "pass": metrics["sharpe_ratio"] >= 1.0,
        "value": metrics["sharpe_ratio"],
        "threshold": 1.0,
    }

    # Gate 4: Profitable in >= 2 of 3 regimes
    profitable_regimes = 0
    regime_detail = {}
    for regime_name in ["bull", "bear", "sideways"]:
        rm = regime_metrics.get(regime_name)
        if rm and rm["total_trades"] > 0:
            is_profitable = rm["total_pnl"] > 0
            regime_detail[regime_name] = {
                "trades": rm["total_trades"],
                "pnl": rm["total_pnl"],
                "profitable": is_profitable,
            }
            if is_profitable:
                profitable_regimes += 1
        else:
            regime_detail[regime_name] = {"trades": 0, "pnl": 0, "profitable": False}
    gates["regime_profitability"] = {
        "pass": profitable_regimes >= 2,
        "value": profitable_regimes,
        "threshold": ">=2 of 3",
        "detail": regime_detail,
    }

    # Gate 5: Walk-forward consistent
    gates["walk_forward"] = {
        "pass": wf_consistency["consistent"],
        "value": f"{wf_consistency.get('profitable_folds', 0)}/{wf_consistency.get('total_folds', 0)} folds profitable",
        "threshold": ">=60% folds profitable",
    }

    # Gate 6: <= 5 tunable parameters
    gates["param_count"] = {
        "pass": candidate["param_count"] <= 5,
        "value": candidate["param_count"],
        "threshold": "<= 5",
    }

    # Gate 7: Max drawdown < 15%
    gates["max_drawdown"] = {
        "pass": metrics["max_drawdown_pct"] < 15.0,
        "value": f"{metrics['max_drawdown_pct']:.2f}%",
        "threshold": "< 15%",
    }

    all_pass = all(g["pass"] for g in gates.values())
    gates_passed = sum(1 for g in gates.values() if g["pass"])

    return {
        "gates": gates,
        "all_pass": all_pass,
        "gates_passed": gates_passed,
        "total_gates": len(gates),
    }


# ---------------------------------------------------------------------------
# Main Research
# ---------------------------------------------------------------------------

def run_research(db_path=None):
    """Run full Phase 1.5 signal research."""
    print("=" * 80)
    print("PHASE 1.5 SIGNAL RESEARCH — DLD-341")
    print(f"Dataset: {db_path or DB_PATH}")
    print(f"Fee: {FEE_BPS}bps per trade")
    print(f"Date: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print("=" * 80)

    trades, markets, snapshots = load_data(db_path)
    n_slugs = len(set(t["slug"] for t in trades))
    ts_range = trades[-1]["timestamp"] - trades[0]["timestamp"] if trades else 0

    print(f"\nDataset: {len(trades)} trades, {n_slugs} markets, {len(snapshots)} OB snapshots")
    print(f"Time span: {ts_range}s ({ts_range / 60:.1f}min / {ts_range / 3600:.2f}h)")

    slug_counts = Counter(t["slug"] for t in trades)
    print(f"Markets with >50 trades: {sum(1 for c in slug_counts.values() if c > 50)}")

    # ─── Candidate Screening ─────────────────────────────────────────────
    print(f"\n{'=' * 80}")
    print("CANDIDATE SCREENING (all signals, walk-forward, 10bps fees)")
    print(f"{'=' * 80}")
    header = (f"{'Signal':>35} {'OOS':>6} {'Win%':>7} {'AvgPnL':>9} {'TotPnL':>10} "
              f"{'Sharpe':>8} {'PF':>6} {'DD%':>7} {'Params':>6}")
    print(f"\n{header}")
    print("-" * 100)

    all_results = {}
    for name, cand in CANDIDATES.items():
        results, metrics = walk_forward_backtest(trades, cand["fn"], min_train=50)
        all_results[name] = {"results": results, "metrics": metrics, "candidate": cand}

        if metrics["total_trades"] > 0:
            print(f"{name:>35} {metrics['total_trades']:>6} {metrics['win_rate']:>7.1%} "
                  f"{metrics['avg_pnl_per_trade']:>9.4f} {metrics['total_pnl']:>10.2f} "
                  f"{metrics['sharpe_ratio']:>8.2f} {metrics['profit_factor']:>6.2f} "
                  f"{metrics['max_drawdown_pct']:>6.2f}% {cand['param_count']:>6}")
        else:
            print(f"{name:>35}   (no trades generated)")

    # ─── Detailed Evaluation per Candidate ────────────────────────────────
    print(f"\n{'=' * 80}")
    print("DETAILED GATE EVALUATION")
    print(f"{'=' * 80}")

    gate_results = {}
    for name, data in all_results.items():
        metrics = data["metrics"]
        cand = data["candidate"]
        results = data["results"]

        if metrics["total_trades"] == 0:
            gate_results[name] = {"all_pass": False, "gates_passed": 0, "total_gates": 7,
                                  "note": "no trades"}
            continue

        # Regime split
        _, regime_metrics = regime_split_evaluation(trades, cand["fn"], min_train=50)

        # Bootstrap
        pnl_series = [r["trade_pnl"] for r in results]
        boot = bootstrap_significance(pnl_series)

        # Walk-forward consistency
        wf = walk_forward_consistency(trades, cand["fn"], n_folds=5, min_train=50)

        # Gate evaluation
        ge = evaluate_gates(name, cand, metrics, regime_metrics, boot, wf)

        gate_results[name] = {
            **ge,
            "metrics": metrics,
            "bootstrap": boot,
            "regime_metrics": {k: v for k, v in regime_metrics.items()},
            "walk_forward": wf,
        }

        print(f"\n--- {name} ({cand['category']}) ---")
        print(f"  Parameters ({cand['param_count']}): {', '.join(cand['params'])}")
        for gname, g in ge["gates"].items():
            status = "PASS" if g["pass"] else "FAIL"
            print(f"  [{status}] {gname}: {g['value']} (threshold: {g['threshold']})")
        print(f"  Bootstrap p-value: {boot['p_value']:.4f} | 95% CI: [{boot['ci_95'][0]:.4f}, {boot['ci_95'][1]:.4f}]")
        print(f"  Result: {ge['gates_passed']}/{ge['total_gates']} gates passed"
              f" {'*** ALL PASS ***' if ge['all_pass'] else ''}")

    # ─── Regime Performance Table ─────────────────────────────────────────
    print(f"\n{'=' * 80}")
    print("REGIME-SPLIT PERFORMANCE TABLE")
    print(f"{'=' * 80}")
    print(f"\n{'Signal':>35} {'Regime':>10} {'Trades':>7} {'Win%':>7} {'PnL':>10} {'Sharpe':>8}")
    print("-" * 85)
    for name, gr in gate_results.items():
        if "regime_metrics" not in gr:
            continue
        for regime_name in ["bull", "bear", "sideways"]:
            rm = gr["regime_metrics"].get(regime_name)
            if rm and rm["total_trades"] > 0:
                print(f"{name:>35} {regime_name:>10} {rm['total_trades']:>7} "
                      f"{rm['win_rate']:>7.1%} {rm['total_pnl']:>10.2f} "
                      f"{rm['sharpe_ratio']:>8.2f}")
            else:
                print(f"{name:>35} {regime_name:>10}       0       -          -        -")

    # ─── Walk-Forward Consistency Table ───────────────────────────────────
    print(f"\n{'=' * 80}")
    print("WALK-FORWARD CONSISTENCY (5-fold sequential)")
    print(f"{'=' * 80}")
    for name, gr in gate_results.items():
        if "walk_forward" not in gr:
            continue
        wf = gr["walk_forward"]
        print(f"\n  {name}: {'CONSISTENT' if wf['consistent'] else 'INCONSISTENT'} "
              f"({wf.get('profitable_folds', 0)}/{wf.get('total_folds', 0)} folds profitable)")
        if "folds" in wf:
            for f in wf["folds"]:
                status = "+" if f["profitable"] else "-"
                print(f"    Fold {f['fold']}: {f['trades']} trades, "
                      f"PnL={f['total_pnl']:>8.2f}, avg={f['avg_pnl']:>7.4f} [{status}]")

    # ─── Summary & Recommendation ────────────────────────────────────────
    print(f"\n{'=' * 80}")
    print("SUMMARY & RECOMMENDATION")
    print(f"{'=' * 80}")

    passing = [(name, gr) for name, gr in gate_results.items() if gr.get("all_pass")]
    partial = [(name, gr) for name, gr in gate_results.items()
               if not gr.get("all_pass") and gr.get("gates_passed", 0) >= 5]

    if passing:
        print(f"\n  CANDIDATES PASSING ALL 7 GATES:")
        for name, gr in passing:
            m = gr["metrics"]
            print(f"    - {name}: Sharpe={m['sharpe_ratio']:.2f}, "
                  f"EV/trade={m['avg_pnl_per_trade']:.4f}, "
                  f"DD={m['max_drawdown_pct']:.2f}%")

        # Rank by Sharpe
        best = max(passing, key=lambda x: x[1]["metrics"]["sharpe_ratio"])
        print(f"\n  TOP CANDIDATE: {best[0]}")
        bm = best[1]["metrics"]
        print(f"    Sharpe: {bm['sharpe_ratio']:.2f}")
        print(f"    EV/trade (after fees): {bm['avg_pnl_per_trade']:.4f}")
        print(f"    Win rate: {bm['win_rate']:.1%}")
        print(f"    Total PnL: {bm['total_pnl']:.2f}")
        print(f"    Max DD: {bm['max_drawdown_pct']:.2f}%")
        print(f"    Trades: {bm['total_trades']}")
        print(f"\n  RECOMMENDATION: Promote {best[0]} to paper trading (Phase 2)")
    elif partial:
        print(f"\n  NO CANDIDATE PASSES ALL 7 GATES")
        print(f"\n  PARTIAL PASSES (>= 5/7 gates):")
        for name, gr in partial:
            print(f"    - {name}: {gr['gates_passed']}/7")
            failed = [gn for gn, g in gr["gates"].items() if not g["pass"]]
            print(f"      Failed: {', '.join(failed)}")
        print(f"\n  RECOMMENDATION: Continue research or expand dataset")
    else:
        print(f"\n  NO CANDIDATE PASSES >= 5 GATES")
        print(f"  RECOMMENDATION: Escalate to CTO — consider project pause or dataset expansion")

    # ─── Caveats ──────────────────────────────────────────────────────────
    print(f"\n{'=' * 80}")
    print("CAVEATS")
    print(f"{'=' * 80}")
    print(f"  - Dataset span: {ts_range / 60:.1f}min ({ts_range / 3600:.2f}h) vs 24h+ target")
    print(f"  - Data source: Polymarket data-api (real-time only, no historical)")
    print(f"  - Regime detection: price path efficiency on rolling 50-trade window")
    print(f"  - Fee model: flat {FEE_BPS}bps per trade (conservative for Polymarket)")
    print(f"  - Initial capital assumption: ${INITIAL_CAPITAL:,} (for DD% calculation)")
    print(f"  - Walk-forward: expanding window, no look-ahead bias")
    if ts_range < 86400:
        print(f"  - WARNING: Short data span may overstate statistical significance")
        print(f"    Results should be validated on 24h+ continuous data before live trading")

    # ─── Return structured results ────────────────────────────────────────
    return {
        "dataset": {
            "total_trades": len(trades),
            "n_markets": n_slugs,
            "time_span_sec": ts_range,
            "fee_bps": FEE_BPS,
        },
        "candidates": {name: {
            "metrics": gr.get("metrics"),
            "gates_passed": gr.get("gates_passed", 0),
            "all_pass": gr.get("all_pass", False),
            "bootstrap": gr.get("bootstrap"),
        } for name, gr in gate_results.items()},
        "passing_candidates": [name for name, gr in gate_results.items() if gr.get("all_pass")],
        "top_candidate": max(passing, key=lambda x: x[1]["metrics"]["sharpe_ratio"])[0] if passing else None,
    }


if __name__ == "__main__":
    import sys
    db = sys.argv[1] if len(sys.argv) > 1 else None
    results = run_research(db)
    # Save structured results
    out_path = Path(__file__).parent / "phase15_results.json"
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\nStructured results saved to {out_path}")
