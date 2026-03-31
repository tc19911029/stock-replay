"""
GT-Score — Robust Strategy Evaluation Composite

Integrates performance, statistical significance, consistency,
and downside risk into a single objective function for strategy comparison.

Research basis:
- GT-Score (MDPI, Jan 2026): composite objective function that penalizes
  inconsistency and statistical insignificance
- Deflated Sharpe Ratio: adjusts for multiple testing (how many strategy
  variants were tested before arriving at this one)

Usage:
    from backtest.gt_score import compute_gt_score, deflated_sharpe

    gt = compute_gt_score(train_stats, val_stats, window_win_rates)
    ds = deflated_sharpe(sharpe=1.2, n_trades=50, n_variants=20)
"""

from __future__ import annotations

import math
from typing import Any


def compute_gt_score(
    train_stats: dict[str, Any],
    val_stats: dict[str, Any],
    window_win_rates: list[float] | None = None,
) -> dict[str, Any]:
    """
    Compute GT-Score from train/validation stats and walk-forward window results.

    Components (each 0-100, weighted):
    1. Performance (30%): annualized return proxy (avg return × √252)
    2. Statistical significance (20%): t-statistic of returns
    3. Consistency (25%): inverse of win rate variance across WF windows
    4. Downside risk (25%): Sortino-like ratio (return / downside deviation)

    Returns:
        dict with gt_score (0-100), component scores, and interpretation
    """
    if not train_stats or not val_stats:
        return {"gt_score": 0, "reason": "insufficient data"}

    # ── 1. Performance Score (30%) ─────────────────────────────────────────
    avg_return = val_stats.get("avg_return", 0)
    # Annualize: daily avg × √252 (approximate)
    ann_return = avg_return * math.sqrt(252)
    # Score: 0-30% annual = 0-100
    perf_score = min(100, max(0, (ann_return / 0.30) * 100))

    # ── 2. Statistical Significance (20%) ──────────────────────────────────
    n_trades = val_stats.get("n_trades", 0)
    std_return = val_stats.get("std_return", 1)
    t_stat = 0
    if n_trades > 1 and std_return > 0:
        t_stat = avg_return / (std_return / math.sqrt(n_trades))
    # t-stat > 2.0 → significant at 95% CI
    # Score: 0→0, 1→50, 2→100
    sig_score = min(100, max(0, t_stat * 50))

    # ── 3. Consistency Score (25%) ─────────────────────────────────────────
    consistency_score = 50.0  # default if no WF windows
    if window_win_rates and len(window_win_rates) >= 3:
        mean_wr = sum(window_win_rates) / len(window_win_rates)
        variance = sum((wr - mean_wr) ** 2 for wr in window_win_rates) / len(
            window_win_rates
        )
        std_wr = math.sqrt(variance)
        # Low std = high consistency: std < 5% → 100, std > 20% → 0
        consistency_score = max(0, min(100, (1 - std_wr / 20) * 100))

    # ── 4. Downside Risk Score (25%) ───────────────────────────────────────
    max_dd = abs(val_stats.get("max_drawdown", 0))
    # Lower drawdown = better: 0% → 100, 20%+ → 0
    dd_score = max(0, min(100, (1 - max_dd / 20) * 100))

    # Sortino enhancement: if we have downside deviation
    downside_dev = val_stats.get("downside_deviation", None)
    if downside_dev and downside_dev > 0 and avg_return > 0:
        sortino = avg_return / downside_dev
        # Blend Sortino into dd_score
        sortino_score = min(100, sortino * 40)
        dd_score = dd_score * 0.6 + sortino_score * 0.4

    # ── Composite GT-Score ─────────────────────────────────────────────────
    gt_score = round(
        perf_score * 0.30
        + sig_score * 0.20
        + consistency_score * 0.25
        + dd_score * 0.25,
        1,
    )

    # ── Train vs Validation Gap Penalty ────────────────────────────────────
    train_wr = train_stats.get("win_rate", 0)
    val_wr = val_stats.get("win_rate", 0)
    wr_gap = train_wr - val_wr
    if wr_gap > 15:
        gt_score = max(0, gt_score - 20)
    elif wr_gap > 10:
        gt_score = max(0, gt_score - 10)

    return {
        "gt_score": gt_score,
        "components": {
            "performance": round(perf_score, 1),
            "significance": round(sig_score, 1),
            "consistency": round(consistency_score, 1),
            "downside_risk": round(dd_score, 1),
        },
        "t_statistic": round(t_stat, 3),
        "win_rate_gap": round(wr_gap, 1),
        "interpretation": (
            "ROBUST" if gt_score >= 70
            else "ACCEPTABLE" if gt_score >= 50
            else "WEAK" if gt_score >= 30
            else "REJECT"
        ),
    }


def deflated_sharpe(
    sharpe: float,
    n_trades: int,
    n_variants: int,
    skewness: float = 0,
    kurtosis: float = 3,
) -> dict[str, Any]:
    """
    Deflated Sharpe Ratio — adjusts for multiple testing.

    When you test N strategy variants and pick the best Sharpe, the
    probability of the best being genuine (not luck) decreases.

    Based on Bailey & López de Prado (2014).

    Args:
        sharpe:     Observed Sharpe ratio
        n_trades:   Number of trades in backtest
        n_variants: Number of strategy variants tested
        skewness:   Return distribution skewness (0 = normal)
        kurtosis:   Return distribution kurtosis (3 = normal)

    Returns:
        dict with deflated_sharpe, p_value, is_significant
    """
    if n_trades < 2 or n_variants < 1:
        return {
            "deflated_sharpe": sharpe,
            "p_value": 1.0,
            "is_significant": False,
            "reason": "insufficient data",
        }

    # Expected max Sharpe under null hypothesis (all variants are random)
    # E[max(Z_1,...,Z_N)] ≈ √(2 * ln(N)) for N i.i.d. standard normals
    expected_max_sharpe = math.sqrt(2 * math.log(max(n_variants, 2)))

    # Adjust for non-normality
    gamma3 = skewness  # third moment
    gamma4 = kurtosis - 3  # excess kurtosis

    # Standard error of Sharpe estimate
    se_sharpe = math.sqrt(
        (1 + 0.5 * sharpe**2 - gamma3 * sharpe + (gamma4 / 4) * sharpe**2)
        / n_trades
    )

    if se_sharpe <= 0:
        se_sharpe = 1.0 / math.sqrt(n_trades)

    # PSR(SR*) = Φ((SR - SR*) / SE(SR))
    # where SR* is the expected max Sharpe under null
    z_score = (sharpe - expected_max_sharpe) / se_sharpe

    # Approximate standard normal CDF
    p_value = 0.5 * (1 + math.erf(z_score / math.sqrt(2)))

    deflated = sharpe - expected_max_sharpe * se_sharpe

    return {
        "deflated_sharpe": round(deflated, 3),
        "observed_sharpe": round(sharpe, 3),
        "expected_max_sharpe": round(expected_max_sharpe, 3),
        "p_value": round(1 - p_value, 4),  # probability of being lucky
        "is_significant": p_value > 0.95,   # 95% confidence
        "n_variants_tested": n_variants,
    }
