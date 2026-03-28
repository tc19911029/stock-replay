from __future__ import annotations
"""
新舊策略比較模組
"""

from typing import Any


def compare(old_results: dict, new_results: dict) -> dict[str, Any]:
    """
    比較新舊策略的回測結果。
    以驗證集為主要判斷依據（防過擬合）。

    Returns:
        dict with comparison results
    """
    old_val_stats = _aggregate_val_stats(old_results)
    new_val_stats = _aggregate_val_stats(new_results)

    if not old_val_stats or not new_val_stats:
        return {"is_better": False, "reason": "數據不足，無法比較", "details": {}}

    # ── 比較指標 ──────────────────────────────────────────────────────────
    old_sharpe = old_val_stats.get("sharpe_ratio", 0)
    new_sharpe = new_val_stats.get("sharpe_ratio", 0)

    old_wr = old_val_stats.get("win_rate", 0)
    new_wr = new_val_stats.get("win_rate", 0)

    old_pf = old_val_stats.get("profit_factor", 0)
    new_pf = new_val_stats.get("profit_factor", 0)

    old_mdd = old_val_stats.get("max_drawdown", 0)
    new_mdd = new_val_stats.get("max_drawdown", 0)

    old_exp = old_val_stats.get("expectancy", 0)
    new_exp = new_val_stats.get("expectancy", 0)

    # ── 加權評分 ──────────────────────────────────────────────────────────
    # 夏普 40% + 勝率 25% + 盈虧比 20% + 回撤改善 15%
    score_diff = 0
    reasons = []

    sharpe_diff = new_sharpe - old_sharpe
    score_diff += sharpe_diff * 0.4
    if sharpe_diff > 0.05:
        reasons.append(f"夏普率提升 {sharpe_diff:+.3f}")
    elif sharpe_diff < -0.05:
        reasons.append(f"夏普率下降 {sharpe_diff:+.3f}")

    wr_diff = new_wr - old_wr
    score_diff += (wr_diff / 100) * 0.25
    if wr_diff > 2:
        reasons.append(f"勝率提升 {wr_diff:+.1f}%")
    elif wr_diff < -2:
        reasons.append(f"勝率下降 {wr_diff:+.1f}%")

    pf_diff = new_pf - old_pf
    score_diff += pf_diff * 0.2
    if pf_diff > 0.1:
        reasons.append(f"獲利因子提升 {pf_diff:+.3f}")

    # 回撤改善（負值越小越好）
    mdd_improvement = old_mdd - new_mdd  # 正值 = 改善
    score_diff += mdd_improvement * 0.001 * 0.15

    # ── 判斷 ──────────────────────────────────────────────────────────────
    is_better = score_diff > 0.01  # 門檻：至少有微小改善

    if not reasons:
        reasons.append("變化不大" if abs(score_diff) < 0.01 else "綜合表現略有變化")

    return {
        "is_better": is_better,
        "score_diff": round(score_diff, 4),
        "reason": "；".join(reasons),
        "details": {
            "old_sharpe": round(old_sharpe, 3),
            "new_sharpe": round(new_sharpe, 3),
            "old_win_rate": round(old_wr, 1),
            "new_win_rate": round(new_wr, 1),
            "old_profit_factor": round(old_pf, 3),
            "new_profit_factor": round(new_pf, 3),
            "old_max_drawdown": round(old_mdd, 2),
            "new_max_drawdown": round(new_mdd, 2),
            "old_expectancy": round(old_exp, 3),
            "new_expectancy": round(new_exp, 3),
        },
    }


def _aggregate_val_stats(results: dict) -> dict | None:
    """聚合所有市場/週期的驗證集統計"""
    from backtest.metrics import calc_metrics

    all_trades = []
    for key, data in results.items():
        val = data.get("validation", {})
        all_trades.extend(val.get("trades", []))

    if not all_trades:
        return None

    return calc_metrics(all_trades)
