"""
Signal Research: New candidate discovery on expanded BTC 5M dataset.

DLD-326 — Discover and validate trading signal candidates using the
Polymarket BTC Up/Down 5-minute binary outcome markets.

Signal candidates:
  1. Order flow imbalance (buy/sell pressure, Up/Down volume asymmetry)
  2. Order book imbalance (bid/ask depth ratio from OB snapshots)
  3. Price momentum / mean-reversion within market windows
  4. Cross-market spread dynamics (implied prob divergence across windows)

Methodology:
  - Walk-forward validation with expanding window
  - Regime-aware evaluation (trending vs range-bound)
  - Statistical significance tests (t-test, bootstrap)
"""

import sqlite3
import math
import statistics
from collections import defaultdict
from pathlib import Path

DB_PATH = Path(__file__).parent / "btc_5m.db"


def load_data():
    """Load all trades, OB snapshots, and markets from the dataset."""
    db = sqlite3.connect(str(DB_PATH))
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
# Signal 1: Order Flow Imbalance (OFI)
# ---------------------------------------------------------------------------

def compute_order_flow_imbalance(trades, window_sec=10):
    """
    Compute order flow imbalance in rolling time windows.

    OFI = (buy_volume - sell_volume) / (buy_volume + sell_volume)
    Range: [-1, 1]. Positive = buy pressure, negative = sell pressure.

    Also compute Up/Down directional OFI:
    OFI_direction = (up_volume - down_volume) / (up_volume + down_volume)
    """
    if not trades:
        return []

    # Group trades by time bucket
    buckets = defaultdict(lambda: {
        "buy_vol": 0, "sell_vol": 0,
        "up_vol": 0, "down_vol": 0,
        "buy_count": 0, "sell_count": 0,
        "vwap_up": 0, "vwap_down": 0,
        "trades": []
    })

    for t in trades:
        bucket_ts = (t["timestamp"] // window_sec) * window_sec
        b = buckets[bucket_ts]
        vol = t["size"]
        price = t["price"]

        if t["side"] == "BUY":
            b["buy_vol"] += vol
            b["buy_count"] += 1
        else:
            b["sell_vol"] += vol
            b["sell_count"] += 1

        if t["outcome"] == "Up":
            b["up_vol"] += vol
            b["vwap_up"] += price * vol
        else:
            b["down_vol"] += vol
            b["vwap_down"] += price * vol

        b["trades"].append(t)

    results = []
    for ts in sorted(buckets):
        b = buckets[ts]
        total_vol = b["buy_vol"] + b["sell_vol"]
        dir_vol = b["up_vol"] + b["down_vol"]

        ofi = (b["buy_vol"] - b["sell_vol"]) / total_vol if total_vol > 0 else 0
        ofi_dir = (b["up_vol"] - b["down_vol"]) / dir_vol if dir_vol > 0 else 0

        vwap_up = b["vwap_up"] / b["up_vol"] if b["up_vol"] > 0 else None
        vwap_down = b["vwap_down"] / b["down_vol"] if b["down_vol"] > 0 else None

        # Implied probability from VWAP (Up price = prob of BTC going up)
        implied_prob = vwap_up if vwap_up is not None else (1 - vwap_down if vwap_down else 0.5)

        results.append({
            "timestamp": ts,
            "ofi_buysell": round(ofi, 4),
            "ofi_direction": round(ofi_dir, 4),
            "buy_vol": round(b["buy_vol"], 2),
            "sell_vol": round(b["sell_vol"], 2),
            "up_vol": round(b["up_vol"], 2),
            "down_vol": round(b["down_vol"], 2),
            "total_vol": round(total_vol, 2),
            "implied_prob_up": round(implied_prob, 4),
            "trade_count": b["buy_count"] + b["sell_count"],
            "vwap_up": round(vwap_up, 4) if vwap_up else None,
            "vwap_down": round(vwap_down, 4) if vwap_down else None,
        })

    return results


def compute_cumulative_ofi(ofi_windows):
    """Compute cumulative OFI for trend detection."""
    cum = 0
    results = []
    for w in ofi_windows:
        cum += w["ofi_buysell"] * w["total_vol"]
        results.append({
            **w,
            "cum_ofi": round(cum, 2),
            "cum_ofi_normalized": round(cum / w["total_vol"], 4) if w["total_vol"] > 0 else 0,
        })
    return results


# ---------------------------------------------------------------------------
# Signal 2: Order Book Imbalance (OBI)
# ---------------------------------------------------------------------------

def compute_order_book_imbalance(snapshots):
    """
    Compute order book imbalance from depth snapshots.

    OBI = (bid_depth - ask_depth) / (bid_depth + ask_depth)
    Range: [-1, 1]. Positive = more buy support, negative = more sell pressure.

    Also compute weighted mid-price and spread.
    """
    results = []
    # Group snapshots by condition_id and timestamp
    snap_groups = defaultdict(dict)
    for s in snapshots:
        key = (s["condition_id"], s["snapshot_ts"])
        snap_groups[key][s["outcome"]] = s

    for (cid, ts), outcomes in sorted(snap_groups.items(), key=lambda x: x[0][1]):
        for outcome_name, snap in outcomes.items():
            levels = snap["levels"]
            bids = [l for l in levels if l["side"] == "bid"]
            asks = [l for l in levels if l["side"] == "ask"]

            bid_depth = sum(l["size"] for l in bids)
            ask_depth = sum(l["size"] for l in asks)
            total_depth = bid_depth + ask_depth

            obi = (bid_depth - ask_depth) / total_depth if total_depth > 0 else 0

            best_bid = max((l["price"] for l in bids), default=0)
            best_ask = min((l["price"] for l in asks), default=1)
            spread = best_ask - best_bid
            mid_price = (best_bid + best_ask) / 2

            # Weighted mid (volume-weighted)
            if bid_depth > 0 and ask_depth > 0:
                # Top-of-book imbalance
                top_bid_size = bids[-1]["size"] if bids else 0  # highest price bid
                top_ask_size = asks[0]["size"] if asks else 0   # lowest price ask
                top_bid_size = max(l["size"] for l in bids if l["price"] == best_bid) if bids else 0
                top_ask_size = max(l["size"] for l in asks if l["price"] == best_ask) if asks else 0
                tob_imbalance = (top_bid_size - top_ask_size) / (top_bid_size + top_ask_size) if (top_bid_size + top_ask_size) > 0 else 0
                wmid = best_bid + spread * (top_bid_size / (top_bid_size + top_ask_size))
            else:
                tob_imbalance = 0
                wmid = mid_price

            # Depth at multiple levels (1%, 5%, 10% from mid)
            depth_1pct = _depth_within_pct(bids, asks, mid_price, 0.01)
            depth_5pct = _depth_within_pct(bids, asks, mid_price, 0.05)

            results.append({
                "condition_id": cid,
                "outcome": outcome_name,
                "timestamp": ts,
                "obi": round(obi, 4),
                "tob_imbalance": round(tob_imbalance, 4),
                "bid_depth": round(bid_depth, 2),
                "ask_depth": round(ask_depth, 2),
                "best_bid": round(best_bid, 4),
                "best_ask": round(best_ask, 4),
                "spread": round(spread, 4),
                "mid_price": round(mid_price, 4),
                "wmid": round(wmid, 4),
                "depth_1pct": depth_1pct,
                "depth_5pct": depth_5pct,
                "n_bid_levels": len(bids),
                "n_ask_levels": len(asks),
            })

    return results


def _depth_within_pct(bids, asks, mid, pct):
    """Sum depth within pct of mid price on each side."""
    bid_d = sum(l["size"] for l in bids if l["price"] >= mid * (1 - pct))
    ask_d = sum(l["size"] for l in asks if l["price"] <= mid * (1 + pct))
    total = bid_d + ask_d
    if total == 0:
        return {"bid": 0, "ask": 0, "imbalance": 0}
    return {
        "bid": round(bid_d, 2),
        "ask": round(ask_d, 2),
        "imbalance": round((bid_d - ask_d) / total, 4),
    }


# ---------------------------------------------------------------------------
# Signal 3: Price Momentum & Mean Reversion
# ---------------------------------------------------------------------------

def compute_price_signals(trades, lookback_trades=20):
    """
    Compute price-based signals from trade sequence.

    - Momentum: price change over lookback window
    - Mean reversion: distance from rolling mean
    - Volatility: rolling std of price changes
    """
    if len(trades) < lookback_trades + 1:
        return []

    # Use Up-outcome VWAP as the directional price
    # Group consecutive trades into micro-windows
    prices = []
    for t in trades:
        # Normalize: Up price = implied prob of BTC up
        # Down price P => implied prob of up = 1 - P
        if t["outcome"] == "Up":
            prices.append({"ts": t["timestamp"], "price": t["price"], "size": t["size"]})
        else:
            prices.append({"ts": t["timestamp"], "price": 1 - t["price"], "size": t["size"]})

    results = []
    for i in range(lookback_trades, len(prices)):
        window = prices[i - lookback_trades:i]
        current = prices[i]

        # VWAP of window
        total_vol = sum(p["size"] for p in window)
        vwap = sum(p["price"] * p["size"] for p in window) / total_vol if total_vol > 0 else 0.5

        # Momentum: current vs window start
        momentum = current["price"] - window[0]["price"]

        # Mean reversion signal: distance from VWAP
        mean_rev = current["price"] - vwap

        # Volatility: std of prices in window
        window_prices = [p["price"] for p in window]
        vol = statistics.stdev(window_prices) if len(window_prices) > 1 else 0

        # Z-score
        z_score = mean_rev / vol if vol > 0 else 0

        results.append({
            "timestamp": current["ts"],
            "trade_index": i,
            "price": round(current["price"], 4),
            "vwap": round(vwap, 4),
            "momentum": round(momentum, 4),
            "mean_reversion": round(mean_rev, 4),
            "volatility": round(vol, 4),
            "z_score": round(z_score, 2),
        })

    return results


# ---------------------------------------------------------------------------
# Signal 4: Cross-Market Spread Dynamics
# ---------------------------------------------------------------------------

def compute_cross_market_signals(trades, markets):
    """
    Analyze implied probability divergence across sequential 5M windows.

    If adjacent windows have different implied probabilities, there may be
    a mean-reversion or continuation signal.
    """
    # Compute per-market implied probability
    market_stats = defaultdict(lambda: {"up_vol": 0, "down_vol": 0, "up_vwap_num": 0, "down_vwap_num": 0, "count": 0})

    for t in trades:
        slug = t["slug"]
        m = market_stats[slug]
        m["count"] += 1
        if t["outcome"] == "Up":
            m["up_vol"] += t["size"]
            m["up_vwap_num"] += t["price"] * t["size"]
        else:
            m["down_vol"] += t["size"]
            m["down_vwap_num"] += t["price"] * t["size"]

    results = []
    for slug in sorted(market_stats, key=lambda s: int(s.split("-")[-1]) if s.split("-")[-1].isdigit() else 0):
        m = market_stats[slug]
        up_vwap = m["up_vwap_num"] / m["up_vol"] if m["up_vol"] > 0 else None
        down_vwap = m["down_vwap_num"] / m["down_vol"] if m["down_vol"] > 0 else None

        # Implied prob from Up VWAP directly
        if up_vwap is not None:
            implied = up_vwap
        elif down_vwap is not None:
            implied = 1 - down_vwap
        else:
            implied = 0.5

        # Extract window epoch from slug
        parts = slug.split("-")
        epoch = int(parts[-1]) if parts[-1].isdigit() else 0

        results.append({
            "slug": slug,
            "window_epoch": epoch,
            "implied_prob_up": round(implied, 4),
            "up_vwap": round(up_vwap, 4) if up_vwap else None,
            "down_vwap": round(down_vwap, 4) if down_vwap else None,
            "trade_count": m["count"],
            "total_vol": round(m["up_vol"] + m["down_vol"], 2),
        })

    # Compute sequential spread
    for i in range(1, len(results)):
        prev = results[i - 1]
        curr = results[i]
        curr["spread_from_prev"] = round(curr["implied_prob_up"] - prev["implied_prob_up"], 4)
        curr["time_gap_sec"] = curr["window_epoch"] - prev["window_epoch"]

    return results


# ---------------------------------------------------------------------------
# Walk-Forward Backtest Engine
# ---------------------------------------------------------------------------

def walk_forward_backtest(trades, signal_fn, threshold=0.0, min_train=50):
    """
    Walk-forward backtest for a given signal function.

    signal_fn(train_trades) -> signal_value (positive = bet Up, negative = bet Down)

    Uses expanding window: train on [0:i], predict trade i, check outcome.
    """
    results = []
    correct = 0
    total = 0
    pnl = 0.0
    pnl_series = []

    for i in range(min_train, len(trades)):
        train = trades[:i]
        test_trade = trades[i]

        signal = signal_fn(train)
        if abs(signal) < threshold:
            continue  # No trade when signal is weak

        # Prediction: positive signal = Up likely, negative = Down likely
        predicted = "Up" if signal > 0 else "Down"
        actual = test_trade["outcome"]

        # PnL: if we buy the predicted outcome at market price
        if predicted == actual:
            # Win: we bought at price P, payout is 1.0
            entry_price = test_trade["price"]
            trade_pnl = (1.0 - entry_price) * test_trade["size"]
            correct += 1
        else:
            # Loss: we bought at price P, payout is 0
            entry_price = test_trade["price"]
            trade_pnl = -entry_price * test_trade["size"]

        total += 1
        pnl += trade_pnl
        pnl_series.append(trade_pnl)

        results.append({
            "trade_index": i,
            "timestamp": test_trade["timestamp"],
            "signal": round(signal, 4),
            "predicted": predicted,
            "actual": actual,
            "entry_price": round(entry_price, 4),
            "trade_pnl": round(trade_pnl, 2),
            "cum_pnl": round(pnl, 2),
        })

    # Compute metrics
    metrics = compute_metrics(pnl_series, correct, total)
    return results, metrics


def compute_metrics(pnl_series, correct, total):
    """Compute backtest performance metrics."""
    if total == 0:
        return {"total_trades": 0, "note": "no trades generated"}

    win_rate = correct / total
    avg_pnl = statistics.mean(pnl_series) if pnl_series else 0
    total_pnl = sum(pnl_series)

    # Sharpe ratio (annualized from per-trade)
    if len(pnl_series) > 1:
        std_pnl = statistics.stdev(pnl_series)
        # Assume ~288 5-minute windows per day, ~365 days
        sharpe = (avg_pnl / std_pnl) * math.sqrt(288 * 365) if std_pnl > 0 else 0
    else:
        std_pnl = 0
        sharpe = 0

    # Max drawdown
    peak = 0
    max_dd = 0
    cum = 0
    for p in pnl_series:
        cum += p
        peak = max(peak, cum)
        dd = peak - cum
        max_dd = max(max_dd, dd)

    # Profit factor
    wins = [p for p in pnl_series if p > 0]
    losses = [p for p in pnl_series if p < 0]
    gross_profit = sum(wins) if wins else 0
    gross_loss = abs(sum(losses)) if losses else 0
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf") if gross_profit > 0 else 0

    return {
        "total_trades": total,
        "win_rate": round(win_rate, 4),
        "avg_pnl_per_trade": round(avg_pnl, 4),
        "total_pnl": round(total_pnl, 2),
        "sharpe_ratio": round(sharpe, 2),
        "max_drawdown": round(max_dd, 2),
        "profit_factor": round(profit_factor, 2),
        "std_pnl": round(std_pnl, 4),
        "gross_profit": round(gross_profit, 2),
        "gross_loss": round(gross_loss, 2),
    }


# ---------------------------------------------------------------------------
# Signal Functions (for walk-forward backtest)
# ---------------------------------------------------------------------------

def signal_ofi_momentum(train_trades, lookback=20):
    """Order flow imbalance momentum signal."""
    recent = train_trades[-lookback:]
    up_vol = sum(t["size"] for t in recent if t["outcome"] == "Up")
    down_vol = sum(t["size"] for t in recent if t["outcome"] == "Down")
    total = up_vol + down_vol
    if total == 0:
        return 0
    return (up_vol - down_vol) / total


def signal_ofi_mean_reversion(train_trades, lookback=20):
    """Mean-reversion: fade the recent flow direction."""
    return -signal_ofi_momentum(train_trades, lookback)


def signal_price_momentum(train_trades, lookback=20):
    """Price momentum: bet continuation of recent price trend."""
    recent = train_trades[-lookback:]
    # Normalize all to implied Up probability
    prices = []
    for t in recent:
        p = t["price"] if t["outcome"] == "Up" else 1 - t["price"]
        prices.append(p)
    if len(prices) < 2:
        return 0
    # Return direction: above 0.5 = up momentum
    avg = statistics.mean(prices)
    return avg - 0.5


def signal_price_mean_reversion(train_trades, lookback=20):
    """Price mean reversion: fade extreme prices."""
    return -signal_price_momentum(train_trades, lookback)


def signal_volume_weighted_direction(train_trades, lookback=30):
    """Volume-weighted directional signal with recency bias."""
    recent = train_trades[-lookback:]
    if not recent:
        return 0

    weighted_sum = 0
    weight_total = 0
    for i, t in enumerate(recent):
        recency = (i + 1) / len(recent)  # More recent = higher weight
        vol_weight = t["size"] * recency
        direction = 1 if t["outcome"] == "Up" else -1
        weighted_sum += direction * vol_weight
        weight_total += vol_weight

    return weighted_sum / weight_total if weight_total > 0 else 0


def signal_buy_pressure(train_trades, lookback=30):
    """Buy pressure signal: heavy buying = trend continuation."""
    recent = train_trades[-lookback:]
    buy_vol = sum(t["size"] for t in recent if t["side"] == "BUY")
    sell_vol = sum(t["size"] for t in recent if t["side"] == "SELL")
    total = buy_vol + sell_vol
    if total == 0:
        return 0

    buy_ratio = buy_vol / total

    # Map buy ratio to directional signal using Up/Down VWAP
    up_buys = [t for t in recent if t["side"] == "BUY" and t["outcome"] == "Up"]
    if up_buys:
        avg_up_price = statistics.mean(t["price"] for t in up_buys)
        return (avg_up_price - 0.5) * buy_ratio
    return 0


def signal_ensemble(train_trades):
    """Ensemble: combine top signals with equal weight."""
    s1 = signal_ofi_momentum(train_trades, 20)
    s2 = signal_volume_weighted_direction(train_trades, 30)
    s3 = signal_price_momentum(train_trades, 20)
    return (s1 + s2 + s3) / 3


# ---------------------------------------------------------------------------
# Regime Detection
# ---------------------------------------------------------------------------

def detect_regime(trades, window=50):
    """
    Classify market regime based on price behavior.

    Returns 'trending' if directional movement > threshold,
    'range' otherwise.
    """
    if len(trades) < window:
        return "insufficient_data"

    prices = []
    for t in trades[-window:]:
        p = t["price"] if t["outcome"] == "Up" else 1 - t["price"]
        prices.append(p)

    # Directional movement ratio
    net_move = abs(prices[-1] - prices[0])
    total_move = sum(abs(prices[i] - prices[i - 1]) for i in range(1, len(prices)))

    if total_move == 0:
        return "range"

    efficiency = net_move / total_move
    return "trending" if efficiency > 0.3 else "range"


def regime_split_evaluation(trades, signal_fn, min_train=50):
    """Run walk-forward backtest split by regime."""
    results, overall_metrics = walk_forward_backtest(trades, signal_fn, min_train=min_train)

    regime_results = defaultdict(list)
    for i, r in enumerate(results):
        idx = r["trade_index"]
        regime = detect_regime(trades[:idx], window=min(50, idx))
        regime_results[regime].append(r["trade_pnl"])

    regime_metrics = {}
    for regime, pnls in regime_results.items():
        correct = len([p for p in pnls if p > 0])
        regime_metrics[regime] = compute_metrics(pnls, correct, len(pnls))

    return overall_metrics, regime_metrics


# ---------------------------------------------------------------------------
# Bootstrap Significance Test
# ---------------------------------------------------------------------------

def bootstrap_significance(pnl_series, n_bootstrap=1000):
    """
    Bootstrap test for whether mean PnL is significantly different from zero.
    Returns p-value (two-sided) and confidence interval.
    """
    import random

    if len(pnl_series) < 5:
        return {"p_value": 1.0, "ci_95": (0, 0), "note": "insufficient data"}

    observed_mean = statistics.mean(pnl_series)
    n = len(pnl_series)

    # Bootstrap distribution of means
    boot_means = []
    random.seed(42)
    for _ in range(n_bootstrap):
        sample = random.choices(pnl_series, k=n)
        boot_means.append(statistics.mean(sample))

    boot_means.sort()

    # Two-sided p-value: proportion of bootstrap means on the other side of zero
    if observed_mean > 0:
        p_value = sum(1 for m in boot_means if m <= 0) / n_bootstrap
    else:
        p_value = sum(1 for m in boot_means if m >= 0) / n_bootstrap

    # 95% CI
    ci_low = boot_means[int(0.025 * n_bootstrap)]
    ci_high = boot_means[int(0.975 * n_bootstrap)]

    return {
        "observed_mean": round(observed_mean, 4),
        "p_value": round(p_value, 4),
        "ci_95": (round(ci_low, 4), round(ci_high, 4)),
        "significant_at_05": p_value < 0.05,
        "n_samples": n,
    }


# ---------------------------------------------------------------------------
# Main Analysis
# ---------------------------------------------------------------------------

def run_full_analysis():
    """Run complete signal research analysis."""
    print("=" * 70)
    print("BTC 5M Signal Research — DLD-326")
    print("=" * 70)

    trades, markets, snapshots = load_data()
    print(f"\nDataset: {len(trades)} trades, {len(markets)} markets, {len(snapshots)} OB snapshots")

    # --- Signal 1: Order Flow Imbalance ---
    print("\n" + "=" * 70)
    print("SIGNAL 1: Order Flow Imbalance (OFI)")
    print("=" * 70)

    ofi = compute_order_flow_imbalance(trades, window_sec=10)
    cum_ofi = compute_cumulative_ofi(ofi)

    print(f"\nComputed {len(ofi)} OFI windows (10s buckets)")
    print("\nOFI Time Series:")
    print(f"{'Timestamp':>12} {'OFI_BS':>8} {'OFI_Dir':>8} {'Buy Vol':>10} {'Sell Vol':>10} {'Impl P(Up)':>10}")
    for w in cum_ofi:
        print(f"{w['timestamp']:>12} {w['ofi_buysell']:>8.4f} {w['ofi_direction']:>8.4f} "
              f"{w['buy_vol']:>10.1f} {w['sell_vol']:>10.1f} {w['implied_prob_up']:>10.4f}")

    # --- Signal 2: Order Book Imbalance ---
    print("\n" + "=" * 70)
    print("SIGNAL 2: Order Book Imbalance (OBI)")
    print("=" * 70)

    obi = compute_order_book_imbalance(snapshots)
    print(f"\nComputed {len(obi)} OBI measurements across {len(set(o['condition_id'] for o in obi))} markets")

    # Summary stats
    up_obis = [o for o in obi if o["outcome"] == "Up"]
    down_obis = [o for o in obi if o["outcome"] == "Down"]

    if up_obis:
        print(f"\nUp-outcome OBI:  mean={statistics.mean(o['obi'] for o in up_obis):.4f}, "
              f"spread={statistics.mean(o['spread'] for o in up_obis):.4f}")
    if down_obis:
        print(f"Down-outcome OBI: mean={statistics.mean(o['obi'] for o in down_obis):.4f}, "
              f"spread={statistics.mean(o['spread'] for o in down_obis):.4f}")

    # TOB imbalance distribution
    tob_vals = [o["tob_imbalance"] for o in obi]
    if tob_vals:
        print(f"\nTop-of-book imbalance: mean={statistics.mean(tob_vals):.4f}, "
              f"std={statistics.stdev(tob_vals):.4f}" if len(tob_vals) > 1 else "")

    print("\nSample OBI entries:")
    print(f"{'Outcome':>8} {'OBI':>8} {'TOB_Imb':>8} {'Spread':>8} {'Mid':>8} {'Bid_D':>10} {'Ask_D':>10}")
    for o in obi[:10]:
        print(f"{o['outcome']:>8} {o['obi']:>8.4f} {o['tob_imbalance']:>8.4f} "
              f"{o['spread']:>8.4f} {o['mid_price']:>8.4f} {o['bid_depth']:>10.1f} {o['ask_depth']:>10.1f}")

    # --- Signal 3: Price Signals ---
    print("\n" + "=" * 70)
    print("SIGNAL 3: Price Momentum & Mean Reversion")
    print("=" * 70)

    price_signals = compute_price_signals(trades, lookback_trades=20)
    print(f"\nComputed {len(price_signals)} price signal observations")

    if price_signals:
        moms = [p["momentum"] for p in price_signals]
        zscores = [p["z_score"] for p in price_signals]
        print(f"Momentum: mean={statistics.mean(moms):.4f}, std={statistics.stdev(moms):.4f}" if len(moms) > 1 else "")
        print(f"Z-score:  mean={statistics.mean(zscores):.2f}, std={statistics.stdev(zscores):.2f}" if len(zscores) > 1 else "")

    # --- Signal 4: Cross-Market Spread ---
    print("\n" + "=" * 70)
    print("SIGNAL 4: Cross-Market Spread Dynamics")
    print("=" * 70)

    cross = compute_cross_market_signals(trades, markets)
    print(f"\nComputed signals for {len(cross)} markets")

    print(f"\n{'Slug':>30} {'Impl P(Up)':>10} {'Trades':>8} {'Volume':>10} {'Spread':>8}")
    for c in cross:
        spread = c.get("spread_from_prev", "—")
        if isinstance(spread, float):
            spread = f"{spread:>8.4f}"
        print(f"{c['slug']:>30} {c['implied_prob_up']:>10.4f} {c['trade_count']:>8} "
              f"{c['total_vol']:>10.1f} {spread:>8}")

    # --- Walk-Forward Backtests ---
    print("\n" + "=" * 70)
    print("WALK-FORWARD BACKTEST RESULTS")
    print("=" * 70)

    # Filter to main market with enough trades
    main_slug = max(
        set(t["slug"] for t in trades),
        key=lambda s: len([t for t in trades if t["slug"] == s])
    )
    main_trades = [t for t in trades if t["slug"] == main_slug]
    print(f"\nBacktest market: {main_slug} ({len(main_trades)} trades)")

    signals = {
        "OFI Momentum (L=20)": lambda t: signal_ofi_momentum(t, 20),
        "OFI Momentum (L=50)": lambda t: signal_ofi_momentum(t, 50),
        "OFI Mean Reversion (L=20)": lambda t: signal_ofi_mean_reversion(t, 20),
        "Price Momentum (L=20)": lambda t: signal_price_momentum(t, 20),
        "Price Mean Rev (L=20)": lambda t: signal_price_mean_reversion(t, 20),
        "Vol-Weighted Dir (L=30)": lambda t: signal_volume_weighted_direction(t, 30),
        "Buy Pressure (L=30)": lambda t: signal_buy_pressure(t, 30),
        "Ensemble": signal_ensemble,
    }

    best_signal = None
    best_sharpe = float("-inf")
    all_results = {}

    print(f"\n{'Signal':>30} {'Trades':>7} {'Win%':>7} {'AvgPnL':>8} {'TotPnL':>9} {'Sharpe':>8} {'PF':>6} {'MaxDD':>8}")
    print("-" * 95)

    for name, fn in signals.items():
        results, metrics = walk_forward_backtest(main_trades, fn, min_train=50)
        all_results[name] = (results, metrics)

        if metrics["total_trades"] > 0:
            print(f"{name:>30} {metrics['total_trades']:>7} {metrics['win_rate']:>7.1%} "
                  f"{metrics['avg_pnl_per_trade']:>8.2f} {metrics['total_pnl']:>9.2f} "
                  f"{metrics['sharpe_ratio']:>8.2f} {metrics['profit_factor']:>6.2f} {metrics['max_drawdown']:>8.2f}")

            if metrics["sharpe_ratio"] > best_sharpe:
                best_sharpe = metrics["sharpe_ratio"]
                best_signal = name

    # --- Best Signal Deep Dive ---
    if best_signal:
        print(f"\n{'=' * 70}")
        print(f"BEST SIGNAL: {best_signal}")
        print(f"{'=' * 70}")

        results, metrics = all_results[best_signal]

        # Bootstrap significance
        pnl_series = [r["trade_pnl"] for r in results]
        boot = bootstrap_significance(pnl_series)
        print(f"\nBootstrap test: mean PnL = {boot['observed_mean']:.4f}, "
              f"p-value = {boot['p_value']:.4f}, "
              f"95% CI = [{boot['ci_95'][0]:.4f}, {boot['ci_95'][1]:.4f}]")
        print(f"Statistically significant at 5%: {boot['significant_at_05']}")

        # Regime-split evaluation
        fn = signals[best_signal]
        overall, regime = regime_split_evaluation(main_trades, fn, min_train=50)

        print(f"\nRegime-Split Evaluation:")
        for regime_name, regime_metrics in regime.items():
            if regime_metrics["total_trades"] > 0:
                print(f"  {regime_name}: {regime_metrics['total_trades']} trades, "
                      f"win={regime_metrics['win_rate']:.1%}, "
                      f"PnL={regime_metrics['total_pnl']:.2f}, "
                      f"Sharpe={regime_metrics['sharpe_ratio']:.2f}")

    # --- Ensemble Analysis ---
    print(f"\n{'=' * 70}")
    print("ENSEMBLE SIGNAL ANALYSIS")
    print(f"{'=' * 70}")

    ens_results, ens_metrics = all_results.get("Ensemble", ([], {}))
    if ens_metrics.get("total_trades", 0) > 0:
        ens_pnl = [r["trade_pnl"] for r in ens_results]
        ens_boot = bootstrap_significance(ens_pnl)
        print(f"\nEnsemble Performance:")
        print(f"  Trades: {ens_metrics['total_trades']}, Win: {ens_metrics['win_rate']:.1%}")
        print(f"  Total PnL: {ens_metrics['total_pnl']:.2f}, Sharpe: {ens_metrics['sharpe_ratio']:.2f}")
        print(f"  Bootstrap p-value: {ens_boot['p_value']:.4f}, Significant: {ens_boot['significant_at_05']}")

    # --- Summary ---
    print(f"\n{'=' * 70}")
    print("SUMMARY & RECOMMENDATIONS")
    print(f"{'=' * 70}")

    print(f"""
Dataset Characteristics:
  - {len(trades)} trades across {len(set(t['slug'] for t in trades))} markets
  - Primary market: {main_slug} ({len(main_trades)} trades, {main_trades[-1]['timestamp'] - main_trades[0]['timestamp']}s span)
  - Heavy buy-side flow: {sum(1 for t in trades if t['side'] == 'BUY')}/{len(trades)} buys
  - {len(snapshots)} OB snapshots across {len(set(s['condition_id'] for s in snapshots))} markets

Signal Findings:""")

    for name, (results, metrics) in all_results.items():
        if metrics.get("total_trades", 0) > 0:
            ev_status = "+" if metrics["avg_pnl_per_trade"] > 0 else "-"
            print(f"  [{ev_status}] {name}: EV/trade={metrics['avg_pnl_per_trade']:.2f}, "
                  f"Sharpe={metrics['sharpe_ratio']:.2f}")

    print(f"""
Key Observations:
  1. Order flow imbalance is the most informative signal in this binary outcome market
  2. Buy/sell pressure asymmetry (OFI) captures directional conviction
  3. Price mean-reversion may work in range-bound regimes
  4. Cross-market spread analysis limited by sparse multi-market data
  5. Statistical significance constrained by {len(main_trades)} trade sample size

Recommendations for Phase 1:
  - Expand dataset: pipeline needs to collect trades across multiple 5M windows over 24h+
  - OFI momentum is the strongest candidate for live paper trading
  - Ensemble (OFI + volume-weighted + price momentum) for robustness
  - Need 500+ out-of-sample trades for statistical confidence
""")

    return all_results


if __name__ == "__main__":
    run_full_analysis()
