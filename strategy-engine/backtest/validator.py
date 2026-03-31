from __future__ import annotations
"""
訓練/驗證/測試集切分 + Walk-Forward 驗證 + GT-Score 過擬合檢測
"""

import math
from typing import Any

from backtest.gt_score import compute_gt_score, deflated_sharpe


def split_data(data: dict, train_ratio: float = 0.6, val_ratio: float = 0.2) -> dict:
    """
    將每支股票的數據按時間切分成 train / validation / test。

    Returns:
        dict with keys 'train', 'validation', 'test'，每個是 {symbol: df}
    """
    import pandas as pd

    result = {"train": {}, "validation": {}, "test": {}}

    for symbol, df in data.items():
        n = len(df)
        train_end = int(n * train_ratio)
        val_end = int(n * (train_ratio + val_ratio))

        result["train"][symbol] = df.iloc[:train_end].copy()
        result["validation"][symbol] = df.iloc[train_end:val_end].copy()
        result["test"][symbol] = df.iloc[val_end:].copy()

    return result


def check_overfit(
    train_stats: dict,
    val_stats: dict,
    window_win_rates: list[float] | None = None,
    n_variants_tested: int = 1,
) -> dict[str, Any]:
    """
    Enhanced overfit detection combining classic gap checks with GT-Score
    and Deflated Sharpe Ratio.

    Args:
        train_stats:        Training set performance metrics
        val_stats:          Validation set performance metrics
        window_win_rates:   Win rates from each walk-forward window (for consistency)
        n_variants_tested:  How many strategy variants were tested (for Deflated Sharpe)

    Returns:
        dict with overfit indicators, GT-Score, and Deflated Sharpe
    """
    if not train_stats or not val_stats:
        return {"is_overfit": None, "reason": "數據不足"}

    train_wr = train_stats.get("win_rate", 0)
    val_wr = val_stats.get("win_rate", 0)
    wr_gap = train_wr - val_wr

    train_sharpe = train_stats.get("sharpe_ratio", 0)
    val_sharpe = val_stats.get("sharpe_ratio", 0)
    sharpe_gap = train_sharpe - val_sharpe

    train_pf = train_stats.get("profit_factor", 0)
    val_pf = val_stats.get("profit_factor", 0)

    # ── Classic gap checks ─────────────────────────────────────────────────
    is_overfit = False
    reasons: list[str] = []

    if wr_gap > 15:
        is_overfit = True
        reasons.append(f"勝率落差 {wr_gap:.1f}%（訓練 {train_wr:.1f}% vs 驗證 {val_wr:.1f}%）")

    if sharpe_gap > 0.5:
        is_overfit = True
        reasons.append(f"夏普落差 {sharpe_gap:.2f}（訓練 {train_sharpe:.2f} vs 驗證 {val_sharpe:.2f}）")

    if train_pf > 1.5 and val_pf < 1.0:
        is_overfit = True
        reasons.append(f"獲利因子驟降（訓練 {train_pf:.2f} vs 驗證 {val_pf:.2f}）")

    # ── GT-Score (composite robustness metric) ─────────────────────────────
    gt = compute_gt_score(train_stats, val_stats, window_win_rates)
    if gt.get("gt_score", 100) < 30:
        is_overfit = True
        reasons.append(f"GT-Score 過低: {gt['gt_score']} ({gt.get('interpretation', 'REJECT')})")

    # ── Deflated Sharpe Ratio (multi-testing adjustment) ───────────────────
    ds: dict[str, Any] = {}
    if n_variants_tested > 1 and val_sharpe > 0:
        n_trades = val_stats.get("n_trades", val_stats.get("count", 30))
        ds = deflated_sharpe(
            sharpe=val_sharpe,
            n_trades=n_trades,
            n_variants=n_variants_tested,
        )
        if not ds.get("is_significant", True):
            reasons.append(
                f"Deflated Sharpe 不顯著: p={ds.get('p_value', 1):.3f}"
                f"（測試了 {n_variants_tested} 個策略變體）"
            )

    # ── Consistency check from walk-forward windows ────────────────────────
    consistency_pct = None
    if window_win_rates and len(window_win_rates) >= 3:
        above_50 = sum(1 for wr in window_win_rates if wr > 50)
        consistency_pct = round(above_50 / len(window_win_rates) * 100, 1)
        if consistency_pct < 50:
            is_overfit = True
            reasons.append(
                f"WF 一致性差: 僅 {consistency_pct}% 窗口勝率 >50%"
            )

    return {
        "is_overfit": is_overfit,
        "win_rate_gap": round(wr_gap, 2),
        "sharpe_gap": round(sharpe_gap, 3),
        "profit_factor_train": round(train_pf, 3),
        "profit_factor_val": round(val_pf, 3),
        "gt_score": gt,
        "deflated_sharpe": ds if ds else None,
        "wf_consistency_pct": consistency_pct,
        "reasons": reasons,
    }
