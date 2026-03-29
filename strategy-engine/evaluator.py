"""
策略評分系統 (Strategy Evaluator)

統一評分標準：
  Score = (年化報酬率 * 0.4) + (勝率 * 0.3) - (最大回撤 MDD * 0.3)

所有數值均以百分比表示：
  - 年化報酬率 (%)：假設每年 250 交易日、平均持有 N 天
  - 勝率 (%)：獲利筆數 / 總筆數
  - 最大回撤 MDD (%)：累積權益曲線的最大峰谷落差

使用方式：
  python evaluator.py                     # 評估當前策略
  python evaluator.py --compare v001 v002 # 比較兩個版本
"""

from __future__ import annotations

import sys
import json
import argparse
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))

from strategies.registry import load_strategy, list_versions
from backtest.metrics import calc_metrics


# ── 評分公式 ─────────────────────────────────────────────────────────────────

def calc_strategy_score(metrics: dict, avg_hold_days: float = 5.0) -> dict:
    """
    計算策略綜合得分。

    Parameters:
        metrics: 回測績效指標（from calc_metrics）
        avg_hold_days: 平均持有天數（用於年化計算）

    Returns:
        dict with score breakdown
    """
    trade_count = metrics.get("trade_count", 0)
    if trade_count == 0:
        return {
            "total_score": 0,
            "annualized_return": 0,
            "win_rate": 0,
            "max_drawdown": 0,
            "score_return": 0,
            "score_winrate": 0,
            "score_drawdown": 0,
            "trade_count": 0,
        }

    avg_net_return = metrics.get("avg_net_return", 0)  # % per trade
    win_rate = metrics.get("win_rate", 0)  # %
    max_drawdown = abs(metrics.get("max_drawdown", 0))  # make positive for penalty
    hold_days = metrics.get("avg_hold_days", avg_hold_days)

    # 年化報酬率估算：
    # 假設每年 250 交易日，每筆交易平均持有 hold_days 天
    # 一年可做 250 / hold_days 筆交易
    # 年化 = avg_return * (250 / hold_days)
    trades_per_year = 250.0 / max(hold_days, 1)
    annualized_return = avg_net_return * trades_per_year

    # 核心分項得分
    score_return = annualized_return * 0.35
    score_winrate = win_rate * 0.25
    score_drawdown = max_drawdown * 0.25  # 扣分項

    # 進階風險調整 bonus (15%):
    # - Sortino > 1.0 → good, > 2.0 → excellent
    # - Profit Factor > 1.5 → good, > 2.0 → excellent
    sortino = metrics.get("sortino_ratio", 0)
    profit_factor = metrics.get("profit_factor", 0)

    risk_bonus = 0
    if sortino > 2.0:
        risk_bonus += 5
    elif sortino > 1.0:
        risk_bonus += 3
    elif sortino > 0.5:
        risk_bonus += 1

    if profit_factor > 2.0:
        risk_bonus += 5
    elif profit_factor > 1.5:
        risk_bonus += 3
    elif profit_factor > 1.0:
        risk_bonus += 1

    score_risk = risk_bonus * 0.15

    total_score = score_return + score_winrate - score_drawdown + score_risk

    return {
        "total_score": round(total_score, 2),
        "annualized_return": round(annualized_return, 2),
        "win_rate": round(win_rate, 2),
        "max_drawdown": round(max_drawdown, 2),
        "score_return": round(score_return, 2),
        "score_winrate": round(score_winrate, 2),
        "score_drawdown": round(score_drawdown, 2),
        "score_risk_bonus": round(score_risk, 2),
        "trade_count": trade_count,
        "sharpe_ratio": metrics.get("sharpe_ratio", 0),
        "sortino_ratio": round(sortino, 3),
        "profit_factor": round(profit_factor, 3),
        "calmar_ratio": metrics.get("calmar_ratio", 0),
        "recovery_factor": metrics.get("recovery_factor", 0),
        "avg_hold_days": round(hold_days, 1),
    }


def format_score_report(score: dict, version: str = "", label: str = "") -> str:
    """格式化分數報告"""
    lines = []
    header = f"策略 {version}" if version else "策略"
    if label:
        header += f" ({label})"
    lines.append(f"┌─ {header} {'─' * max(1, 50 - len(header))}")
    lines.append(f"│ 總得分:          {score['total_score']:>8.2f}")
    lines.append(f"│ ─────────────────────────────────")
    lines.append(f"│ 年化報酬 (×0.4): {score['annualized_return']:>7.1f}% → {score['score_return']:>+.2f}")
    lines.append(f"│ 勝率     (×0.3): {score['win_rate']:>7.1f}% → {score['score_winrate']:>+.2f}")
    lines.append(f"│ MDD      (×0.25):{score['max_drawdown']:>7.1f}% → {score['score_drawdown']:>-.2f}")
    lines.append(f"│ 風調 bonus(×0.15):             → {score.get('score_risk_bonus', 0):>+.2f}")
    lines.append(f"│ ─────────────────────────────────")
    lines.append(f"│ 交易筆數:        {score['trade_count']:>5d}")
    lines.append(f"│ 夏普率:          {score['sharpe_ratio']:>8.3f}")
    lines.append(f"│ Sortino 率:      {score.get('sortino_ratio', 0):>8.3f}")
    lines.append(f"│ 獲利因子:        {score['profit_factor']:>8.3f}")
    lines.append(f"│ Calmar 率:       {score.get('calmar_ratio', 0):>8.3f}")
    lines.append(f"│ 平均持有天數:    {score['avg_hold_days']:>8.1f}")
    lines.append(f"└{'─' * 55}")
    return "\n".join(lines)


def compare_scores(old_score: dict, new_score: dict) -> dict:
    """比較兩個版本的得分"""
    diff = new_score["total_score"] - old_score["total_score"]
    is_better = diff > 0.5  # 至少提升 0.5 分才算改善
    return {
        "diff": round(diff, 2),
        "is_better": is_better,
        "return_diff": round(new_score["annualized_return"] - old_score["annualized_return"], 2),
        "winrate_diff": round(new_score["win_rate"] - old_score["win_rate"], 2),
        "drawdown_diff": round(new_score["max_drawdown"] - old_score["max_drawdown"], 2),
    }


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="策略評分系統")
    parser.add_argument("--version", type=str, help="指定策略版本 (e.g., v001)")
    parser.add_argument("--compare", nargs=2, metavar=("OLD", "NEW"), help="比較兩個版本")
    parser.add_argument("--list", action="store_true", help="列出所有版本")

    args = parser.parse_args()

    if args.list:
        versions = list_versions()
        print(f"可用策略版本：{', '.join(versions)}")
        return

    if args.compare:
        print(f"比較功能需要先跑回測。請使用 main.py 跑完回測後查看 experiments/logs/ 目錄。")
        return

    # 評估當前策略
    strategy = load_strategy(args.version)
    print(f"載入策略：{strategy.version} - {strategy.name}")
    print(f"條件數：{strategy.min_conditions}，進場條件：{len(strategy.entry_conditions)} 個")
    print(f"\n需要先跑回測才能計算得分。使用 python main.py 啟動回測循環。")


if __name__ == "__main__":
    main()
