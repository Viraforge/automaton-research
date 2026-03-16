#!/usr/bin/env python3
"""Tests for Phase 1.5 Signal Research — DLD-341"""

import math
import statistics
import random
import pytest
from phase15_research import (
    signal_ofi_momentum,
    signal_ofi_momentum_20,
    signal_volume_weighted_direction,
    signal_price_momentum,
    signal_mean_reversion,
    signal_volatility_breakout,
    signal_ensemble,
    signal_regime_filtered_ofi,
    detect_regime_3way,
    walk_forward_backtest,
    compute_metrics,
    regime_split_evaluation,
    bootstrap_significance,
    walk_forward_consistency,
    evaluate_gates,
    CANDIDATES,
    FEE_RATE,
    INITIAL_CAPITAL,
    load_data,
    run_research,
    DB_PATH,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_trade(outcome="Up", price=0.5, size=10.0, timestamp=1000, slug="test"):
    return {
        "outcome": outcome,
        "price": price,
        "size": size,
        "timestamp": timestamp,
        "slug": slug,
        "id": random.randint(1, 100000),
    }


def make_trades(n, up_ratio=0.5, price=0.5, size=10.0):
    trades = []
    for i in range(n):
        outcome = "Up" if i < int(n * up_ratio) else "Down"
        trades.append(make_trade(outcome=outcome, price=price, size=size, timestamp=1000 + i, slug=f"m-{i % 3}"))
    random.seed(42)
    random.shuffle(trades)
    return trades


# ---------------------------------------------------------------------------
# Signal Function Tests
# ---------------------------------------------------------------------------

class TestOFIMomentum:
    def test_all_up(self):
        trades = [make_trade("Up", size=10) for _ in range(50)]
        assert signal_ofi_momentum(trades, 50) == 1.0

    def test_all_down(self):
        trades = [make_trade("Down", size=10) for _ in range(50)]
        assert signal_ofi_momentum(trades, 50) == -1.0

    def test_balanced(self):
        trades = [make_trade("Up", size=10) for _ in range(25)]
        trades += [make_trade("Down", size=10) for _ in range(25)]
        assert signal_ofi_momentum(trades, 50) == 0.0

    def test_lookback_window(self):
        old = [make_trade("Down", size=10) for _ in range(50)]
        recent = [make_trade("Up", size=10) for _ in range(20)]
        all_trades = old + recent
        sig = signal_ofi_momentum(all_trades, lookback=20)
        assert sig == 1.0

    def test_empty(self):
        assert signal_ofi_momentum([], 50) == 0


class TestOFIMomentum20:
    def test_uses_lookback_20(self):
        trades = [make_trade("Down") for _ in range(50)]
        trades += [make_trade("Up") for _ in range(20)]
        assert signal_ofi_momentum_20(trades) == 1.0


class TestVolumeWeightedDirection:
    def test_all_up(self):
        trades = [make_trade("Up", size=10) for _ in range(30)]
        sig = signal_volume_weighted_direction(trades, 30)
        assert sig > 0

    def test_all_down(self):
        trades = [make_trade("Down", size=10) for _ in range(30)]
        sig = signal_volume_weighted_direction(trades, 30)
        assert sig < 0

    def test_empty(self):
        assert signal_volume_weighted_direction([], 30) == 0


class TestPriceMomentum:
    def test_high_price_up(self):
        trades = [make_trade("Up", price=0.7) for _ in range(20)]
        sig = signal_price_momentum(trades, 20)
        assert sig > 0  # prices > 0.5 -> positive momentum

    def test_low_price_up(self):
        trades = [make_trade("Up", price=0.3) for _ in range(20)]
        sig = signal_price_momentum(trades, 20)
        assert sig < 0  # prices < 0.5 -> negative momentum


class TestMeanReversion:
    def test_high_up_ratio_gives_negative(self):
        trades = [make_trade("Up") for _ in range(30)]
        sig = signal_mean_reversion(trades, 30)
        assert sig < 0  # Reversal: too many ups -> bet Down

    def test_low_up_ratio_gives_positive(self):
        trades = [make_trade("Down") for _ in range(30)]
        sig = signal_mean_reversion(trades, 30)
        assert sig > 0  # Reversal: too many downs -> bet Up

    def test_balanced_gives_zero(self):
        trades = [make_trade("Up") for _ in range(15)]
        trades += [make_trade("Down") for _ in range(15)]
        sig = signal_mean_reversion(trades, 30)
        assert sig == 0.0

    def test_empty(self):
        assert signal_mean_reversion([], 30) == 0


class TestVolatilityBreakout:
    def test_no_breakout_returns_zero(self):
        # Flat prices -> no breakout
        trades = [make_trade("Up", price=0.5) for _ in range(40)]
        sig = signal_volatility_breakout(trades, 40, 1.5)
        assert sig == 0

    def test_insufficient_data(self):
        trades = [make_trade() for _ in range(10)]
        assert signal_volatility_breakout(trades, 40, 1.5) == 0


class TestEnsemble:
    def test_combines_three_signals(self):
        trades = [make_trade("Up", size=10, price=0.6) for _ in range(50)]
        sig = signal_ensemble(trades)
        # All sub-signals should be positive -> positive ensemble
        assert sig > 0


class TestRegimeFilteredOFI:
    def test_sideways_returns_zero(self):
        # Create trades that produce sideways regime
        trades = []
        for i in range(100):
            outcome = "Up" if i % 2 == 0 else "Down"
            trades.append(make_trade(outcome, price=0.5, timestamp=1000 + i))
        sig = signal_regime_filtered_ofi(trades, 50)
        assert sig == 0  # sideways -> no trade


# ---------------------------------------------------------------------------
# Regime Detection Tests
# ---------------------------------------------------------------------------

class TestDetectRegime3Way:
    def test_sideways(self):
        trades = []
        for i in range(50):
            outcome = "Up" if i % 2 == 0 else "Down"
            trades.append(make_trade(outcome, price=0.5))
        regime = detect_regime_3way(trades, 50)
        assert regime == "sideways"

    def test_insufficient_data(self):
        trades = [make_trade() for _ in range(10)]
        regime = detect_regime_3way(trades, 50)
        assert regime == "sideways"

    def test_returns_valid_regime(self):
        trades = make_trades(100, up_ratio=0.5)
        regime = detect_regime_3way(trades, 50)
        assert regime in ("bull", "bear", "sideways")


# ---------------------------------------------------------------------------
# Walk-Forward Backtest Tests
# ---------------------------------------------------------------------------

class TestWalkForwardBacktest:
    def test_basic_run(self):
        trades = make_trades(200, up_ratio=0.6, size=10)
        results, metrics = walk_forward_backtest(
            trades, lambda t: signal_ofi_momentum(t, 50), min_train=50
        )
        assert metrics["total_trades"] > 0
        assert metrics["total_trades"] == len(results)

    def test_fee_deduction(self):
        trades = make_trades(200, up_ratio=0.6, size=100)
        # Run with fees
        _, metrics_fee = walk_forward_backtest(trades, lambda t: signal_ofi_momentum(t, 50),
                                               fee_rate=FEE_RATE, min_train=50)
        # Run without fees
        _, metrics_no_fee = walk_forward_backtest(trades, lambda t: signal_ofi_momentum(t, 50),
                                                   fee_rate=0.0, min_train=50)
        # With fees should produce lower PnL
        assert metrics_fee["total_pnl"] < metrics_no_fee["total_pnl"]

    def test_drawdown_pct_uses_initial_capital(self):
        trades = make_trades(200, up_ratio=0.5, size=10)
        results, metrics = walk_forward_backtest(trades, lambda t: signal_ofi_momentum(t, 50),
                                                  min_train=50, initial_capital=10000)
        # DD% should be reasonable with initial capital
        assert metrics["max_drawdown_pct"] < 100  # Should not exceed 100% with $10k capital

    def test_no_trades_with_zero_signal(self):
        trades = make_trades(100, up_ratio=0.5)
        results, metrics = walk_forward_backtest(
            trades, lambda t: 0, threshold=0.1, min_train=50
        )
        assert metrics["total_trades"] == 0

    def test_results_have_fee_field(self):
        trades = make_trades(100, up_ratio=0.6, size=10)
        results, _ = walk_forward_backtest(trades, lambda t: signal_ofi_momentum(t, 50), min_train=50)
        if results:
            assert "fee" in results[0]
            assert results[0]["fee"] > 0


# ---------------------------------------------------------------------------
# Compute Metrics Tests
# ---------------------------------------------------------------------------

class TestComputeMetrics:
    def test_basic_metrics(self):
        pnl = [1.0, -0.5, 0.8, -0.3, 1.2]
        metrics = compute_metrics(pnl, correct=3, total=5, max_dd_pct=0.05)
        assert metrics["total_trades"] == 5
        assert metrics["win_rate"] == 0.6
        assert abs(metrics["avg_pnl_per_trade"] - 0.44) < 0.01
        assert metrics["max_drawdown_pct"] == 5.0

    def test_zero_trades(self):
        metrics = compute_metrics([], 0, 0)
        assert metrics["total_trades"] == 0

    def test_sharpe_positive(self):
        pnl = [1.0, 1.0, 1.0, 1.0, 1.0]
        metrics = compute_metrics(pnl, 5, 5)
        # All identical positive PnL -> very high Sharpe (or inf if std=0)
        # std is 0 so sharpe is 0 by our convention
        assert metrics["sharpe_ratio"] == 0 or metrics["sharpe_ratio"] > 0

    def test_profit_factor(self):
        pnl = [10, -5, 8, -3]
        metrics = compute_metrics(pnl, 2, 4)
        assert metrics["profit_factor"] == round(18 / 8, 2)


# ---------------------------------------------------------------------------
# Regime Split Tests
# ---------------------------------------------------------------------------

class TestRegimeSplitEvaluation:
    def test_returns_regime_metrics(self):
        trades = make_trades(200, up_ratio=0.6)
        overall, regime_metrics = regime_split_evaluation(
            trades, lambda t: signal_ofi_momentum(t, 50), min_train=50
        )
        assert overall["total_trades"] > 0
        # Should have at least one regime
        assert len(regime_metrics) > 0
        for regime, rm in regime_metrics.items():
            assert regime in ("bull", "bear", "sideways")
            assert "total_trades" in rm


# ---------------------------------------------------------------------------
# Bootstrap Tests
# ---------------------------------------------------------------------------

class TestBootstrapSignificance:
    def test_positive_signal(self):
        pnl = [1.0] * 100
        boot = bootstrap_significance(pnl)
        assert boot["p_value"] == 0.0
        assert boot["significant_at_05"]

    def test_negative_signal(self):
        pnl = [-1.0] * 100
        boot = bootstrap_significance(pnl)
        assert boot["p_value"] == 1.0
        assert not boot["significant_at_05"]

    def test_insufficient_data(self):
        boot = bootstrap_significance([1.0, 2.0])
        assert boot["p_value"] == 1.0


# ---------------------------------------------------------------------------
# Walk-Forward Consistency Tests
# ---------------------------------------------------------------------------

class TestWalkForwardConsistency:
    def test_consistent_signal(self):
        # Generate trades where OFI momentum consistently works
        trades = make_trades(500, up_ratio=0.65, size=10)
        wf = walk_forward_consistency(trades, lambda t: signal_ofi_momentum(t, 50),
                                       n_folds=5, min_train=50)
        assert "consistent" in wf
        assert "folds" in wf or "note" in wf

    def test_no_trades(self):
        trades = make_trades(100, up_ratio=0.5)
        wf = walk_forward_consistency(trades, lambda t: 0,
                                       n_folds=5, min_train=50)
        assert not wf["consistent"]


# ---------------------------------------------------------------------------
# Gate Evaluation Tests
# ---------------------------------------------------------------------------

class TestEvaluateGates:
    def test_all_pass(self):
        metrics = {
            "total_trades": 1000,
            "avg_pnl_per_trade": 5.0,
            "sharpe_ratio": 10.0,
            "max_drawdown_pct": 5.0,
        }
        regime_metrics = {
            "bull": {"total_trades": 300, "total_pnl": 100},
            "bear": {"total_trades": 300, "total_pnl": 50},
            "sideways": {"total_trades": 400, "total_pnl": 200},
        }
        boot = {"p_value": 0.0, "significant_at_05": True}
        wf = {"consistent": True, "profitable_folds": 4, "total_folds": 5}
        candidate = {"param_count": 2, "params": ["a", "b"]}

        result = evaluate_gates("test", candidate, metrics, regime_metrics, boot, wf)
        assert result["all_pass"]
        assert result["gates_passed"] == 7

    def test_fail_trade_count(self):
        metrics = {
            "total_trades": 100,
            "avg_pnl_per_trade": 5.0,
            "sharpe_ratio": 10.0,
            "max_drawdown_pct": 5.0,
        }
        regime_metrics = {"bull": {"total_trades": 50, "total_pnl": 10},
                          "bear": {"total_trades": 50, "total_pnl": 10},
                          "sideways": {"total_trades": 0, "total_pnl": 0}}
        boot = {"p_value": 0.0, "significant_at_05": True}
        wf = {"consistent": True, "profitable_folds": 4, "total_folds": 5}
        candidate = {"param_count": 1, "params": ["a"]}

        result = evaluate_gates("test", candidate, metrics, regime_metrics, boot, wf)
        assert not result["all_pass"]
        assert not result["gates"]["trade_count"]["pass"]

    def test_fail_drawdown(self):
        metrics = {
            "total_trades": 1000,
            "avg_pnl_per_trade": 5.0,
            "sharpe_ratio": 10.0,
            "max_drawdown_pct": 20.0,
        }
        regime_metrics = {"bull": {"total_trades": 500, "total_pnl": 100},
                          "bear": {"total_trades": 500, "total_pnl": 50},
                          "sideways": {"total_trades": 0, "total_pnl": 0}}
        boot = {"p_value": 0.0, "significant_at_05": True}
        wf = {"consistent": True, "profitable_folds": 4, "total_folds": 5}
        candidate = {"param_count": 1, "params": ["a"]}

        result = evaluate_gates("test", candidate, metrics, regime_metrics, boot, wf)
        assert not result["all_pass"]
        assert not result["gates"]["max_drawdown"]["pass"]

    def test_regime_gate_needs_2_of_3(self):
        metrics = {
            "total_trades": 1000,
            "avg_pnl_per_trade": 5.0,
            "sharpe_ratio": 10.0,
            "max_drawdown_pct": 5.0,
        }
        regime_metrics = {
            "bull": {"total_trades": 300, "total_pnl": 100},
            "bear": {"total_trades": 300, "total_pnl": -50},  # Unprofitable
            "sideways": {"total_trades": 400, "total_pnl": -100},  # Unprofitable
        }
        boot = {"p_value": 0.0, "significant_at_05": True}
        wf = {"consistent": True, "profitable_folds": 4, "total_folds": 5}
        candidate = {"param_count": 1, "params": ["a"]}

        result = evaluate_gates("test", candidate, metrics, regime_metrics, boot, wf)
        assert not result["gates"]["regime_profitability"]["pass"]


# ---------------------------------------------------------------------------
# Candidate Registry Tests
# ---------------------------------------------------------------------------

class TestCandidateRegistry:
    def test_all_candidates_have_required_fields(self):
        for name, cand in CANDIDATES.items():
            assert "fn" in cand
            assert "params" in cand
            assert "param_count" in cand
            assert "category" in cand
            assert cand["param_count"] <= 5

    def test_all_candidates_callable(self):
        trades = make_trades(100, up_ratio=0.6)
        for name, cand in CANDIDATES.items():
            sig = cand["fn"](trades)
            assert isinstance(sig, (int, float)), f"{name} returned {type(sig)}"


# ---------------------------------------------------------------------------
# Integration Test on Real Dataset
# ---------------------------------------------------------------------------

class TestIntegrationRealDataset:
    @pytest.fixture(autouse=True)
    def skip_if_no_db(self):
        if not DB_PATH.exists():
            pytest.skip("No expanded dataset available")

    def test_load_data(self):
        trades, markets, snapshots = load_data()
        assert len(trades) >= 500
        assert len(markets) > 0

    def test_run_research(self):
        results = run_research()
        assert "dataset" in results
        assert "candidates" in results
        assert results["dataset"]["total_trades"] >= 500
        assert results["dataset"]["fee_bps"] == 10

    def test_top_candidates_pass_all_gates(self):
        results = run_research()
        passing = results["passing_candidates"]
        # We expect at least one candidate to pass
        assert len(passing) > 0
        # Each passing candidate should have 7/7
        for name in passing:
            cand = results["candidates"][name]
            assert cand["all_pass"]
            assert cand["gates_passed"] == 7

    def test_fee_impact(self):
        trades, _, _ = load_data()
        # Run with and without fees
        _, m_fee = walk_forward_backtest(trades, lambda t: signal_ofi_momentum(t, 50),
                                         fee_rate=FEE_RATE, min_train=50)
        _, m_no_fee = walk_forward_backtest(trades, lambda t: signal_ofi_momentum(t, 50),
                                             fee_rate=0.0, min_train=50)
        assert m_fee["total_pnl"] < m_no_fee["total_pnl"]
        # Fee impact should be meaningful but not wipe out profits
        assert m_fee["total_pnl"] > 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
