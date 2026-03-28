from __future__ import annotations
"""
績效診斷模組 — 找出策略的弱點
"""

import numpy as np
from typing import Any


def diagnose(results: dict[str, dict]) -> dict[str, Any]:
    """
    分析所有回測結果，找出問題。

    Parameters:
        results: {market_timeframe: {train: {trades, stats}, validation: {trades, stats}}}

    Returns:
        診斷報告 dict
    """
    diagnosis = {
        "summary": {},
        "weak_conditions": [],
        "market_comparison": {},
        "timeframe_comparison": {},
        "overfit_risk": {},
        "suggestions": [],
    }

    all_train_trades = []
    all_val_trades = []

    for key, data in results.items():
        train_data = data.get("train", {})
        val_data = data.get("validation", {})

        train_trades = train_data.get("trades", [])
        val_trades = val_data.get("trades", [])
        train_stats = train_data.get("stats", {})
        val_stats = val_data.get("stats", {})

        all_train_trades.extend(train_trades)
        all_val_trades.extend(val_trades)

        # 市場/週期拆分比較
        parts = key.split("_", 1)
        market = parts[0] if len(parts) > 1 else key
        tf = parts[1] if len(parts) > 1 else "daily"

        diagnosis["market_comparison"][key] = {
            "train_win_rate": train_stats.get("win_rate", 0),
            "val_win_rate": val_stats.get("win_rate", 0),
            "train_sharpe": train_stats.get("sharpe_ratio", 0),
            "val_sharpe": val_stats.get("sharpe_ratio", 0),
            "train_trades": train_stats.get("trade_count", 0),
            "val_trades": val_stats.get("trade_count", 0),
        }

    # ── 條件貢獻度分析 ────────────────────────────────────────────────────
    diagnosis["weak_conditions"] = _analyze_condition_contribution(all_train_trades)

    # ── 過擬合風險 ────────────────────────────────────────────────────────
    from backtest.validator import check_overfit
    from backtest.metrics import calc_metrics
    train_stats = calc_metrics(all_train_trades)
    val_stats = calc_metrics(all_val_trades)
    diagnosis["overfit_risk"] = check_overfit(train_stats, val_stats)

    # ── 整體摘要 ──────────────────────────────────────────────────────────
    diagnosis["summary"] = {
        "total_train_trades": len(all_train_trades),
        "total_val_trades": len(all_val_trades),
        "train_win_rate": train_stats.get("win_rate", 0),
        "val_win_rate": val_stats.get("win_rate", 0),
        "train_sharpe": train_stats.get("sharpe_ratio", 0),
        "val_sharpe": val_stats.get("sharpe_ratio", 0),
        "train_pf": train_stats.get("profit_factor", 0),
        "val_pf": val_stats.get("profit_factor", 0),
    }

    # ── 自動建議 ──────────────────────────────────────────────────────────
    diagnosis["suggestions"] = _generate_suggestions(diagnosis)

    return diagnosis


def _analyze_condition_contribution(trades: list[dict]) -> list[dict]:
    """分析每個條件的貢獻度（有此條件 vs 無此條件的勝率差）"""
    if not trades:
        return []

    # 收集所有條件 ID
    cond_keys = set()
    for t in trades:
        cm = t.get("conditions_met", {})
        cond_keys.update(cm.keys())

    results = []
    for ck in sorted(cond_keys):
        with_cond = [t for t in trades if t.get("conditions_met", {}).get(ck, False)]
        without_cond = [t for t in trades if not t.get("conditions_met", {}).get(ck, False)]

        wr_with = (sum(1 for t in with_cond if t["net_return"] > 0) / len(with_cond) * 100) if with_cond else 0
        wr_without = (sum(1 for t in without_cond if t["net_return"] > 0) / len(without_cond) * 100) if without_cond else 0

        avg_ret_with = np.mean([t["net_return"] for t in with_cond]) if with_cond else 0
        avg_ret_without = np.mean([t["net_return"] for t in without_cond]) if without_cond else 0

        results.append({
            "condition": ck.replace("cond_", ""),
            "with_count": len(with_cond),
            "without_count": len(without_cond),
            "win_rate_with": round(wr_with, 1),
            "win_rate_without": round(wr_without, 1),
            "marginal_value": round(wr_with - wr_without, 1),
            "avg_return_with": round(float(avg_ret_with), 2),
            "avg_return_without": round(float(avg_ret_without), 2),
        })

    return sorted(results, key=lambda x: x["marginal_value"])


def _generate_suggestions(diagnosis: dict) -> list[str]:
    """根據診斷結果產生優化建議"""
    suggestions = []
    summary = diagnosis.get("summary", {})
    overfit = diagnosis.get("overfit_risk", {})
    weak = diagnosis.get("weak_conditions", [])

    # 過擬合建議
    if overfit.get("is_overfit"):
        suggestions.append("⚠ 偵測到過擬合風險，建議放寬條件或減少參數數量")
        for r in overfit.get("reasons", []):
            suggestions.append(f"  → {r}")

    # 弱條件建議
    for w in weak:
        if w["marginal_value"] < -5 and w["with_count"] >= 10:
            suggestions.append(
                f"🔍 條件「{w['condition']}」邊際價值為 {w['marginal_value']}%，"
                f"有它的勝率反而更低，考慮移除或修改"
            )

    # 勝率太低
    val_wr = summary.get("val_win_rate", 0)
    if val_wr < 40:
        suggestions.append(f"📉 驗證集勝率僅 {val_wr}%，策略需要大幅改善")
    elif val_wr < 50:
        suggestions.append(f"📊 驗證集勝率 {val_wr}%，尚有改善空間")

    # 交易數太少
    val_trades = summary.get("total_val_trades", 0)
    if val_trades < 20:
        suggestions.append(f"📌 驗證集僅 {val_trades} 筆交易，統計意義不足，建議放寬進場條件")

    if not suggestions:
        suggestions.append("✅ 目前無明顯問題，可嘗試微調參數")

    return suggestions
