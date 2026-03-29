from __future__ import annotations
"""
績效指標計算模組
"""

import numpy as np
from typing import Any


def calc_metrics(trades: list[dict]) -> dict[str, Any]:
    """
    計算回測績效指標。

    Parameters:
        trades: 交易列表，每筆含 net_return (%)

    Returns:
        dict of metrics
    """
    if not trades:
        return _empty_metrics()

    returns = np.array([t["net_return"] for t in trades])
    gross_returns = np.array([t["gross_return"] for t in trades])

    wins = returns[returns > 0]
    losses = returns[returns <= 0]

    win_count = len(wins)
    loss_count = len(losses)
    total = len(returns)

    win_rate = (win_count / total * 100) if total > 0 else 0
    avg_net = float(np.mean(returns)) if total > 0 else 0
    avg_gross = float(np.mean(gross_returns)) if total > 0 else 0
    median_return = float(np.median(returns)) if total > 0 else 0

    avg_win = float(np.mean(wins)) if len(wins) > 0 else 0
    avg_loss = float(np.mean(losses)) if len(losses) > 0 else 0

    # 盈虧比
    payoff_ratio = abs(avg_win / avg_loss) if avg_loss != 0 else 0

    # 獲利因子 Profit Factor
    total_gain = float(np.sum(wins)) if len(wins) > 0 else 0
    total_loss = float(np.abs(np.sum(losses))) if len(losses) > 0 else 0
    profit_factor = total_gain / total_loss if total_loss > 0 else 0

    # 夏普率（簡化版，假設無風險利率 = 0）
    std_return = float(np.std(returns)) if total > 1 else 0
    sharpe_ratio = (avg_net / std_return) if std_return > 0 else 0

    # 最大回撤（基於累積報酬曲線）
    cum_returns = np.cumsum(returns)
    peak = np.maximum.accumulate(cum_returns)
    drawdown = cum_returns - peak
    max_drawdown = float(np.min(drawdown)) if len(drawdown) > 0 else 0

    # 最大連續虧損次數
    max_consec_loss = _max_consecutive_losses(returns)

    # 平均持有天數
    avg_hold = float(np.mean([t.get("hold_days", 0) for t in trades]))

    # 期望值
    expectancy = (win_rate / 100) * avg_win - (1 - win_rate / 100) * abs(avg_loss)

    # Sortino ratio (downside deviation only — penalizes bad volatility, not good)
    downside_returns = returns[returns < 0]
    downside_std = float(np.std(downside_returns)) if len(downside_returns) > 1 else 0
    sortino_ratio = (avg_net / downside_std) if downside_std > 0 else 0

    # Calmar ratio (return / max drawdown — risk-adjusted return)
    calmar_ratio = abs(avg_net / max_drawdown) if max_drawdown < 0 else 0

    # Recovery factor (total return / |max drawdown|)
    total_return = float(np.sum(returns))
    recovery_factor = abs(total_return / max_drawdown) if max_drawdown < 0 else 0

    # Win/loss streak analysis
    max_consec_win = _max_consecutive_wins(returns)

    return {
        "trade_count": total,
        "win_count": win_count,
        "loss_count": loss_count,
        "win_rate": round(win_rate, 2),
        "avg_net_return": round(avg_net, 3),
        "avg_gross_return": round(avg_gross, 3),
        "median_return": round(median_return, 3),
        "max_gain": round(float(np.max(returns)), 2) if total > 0 else 0,
        "max_loss": round(float(np.min(returns)), 2) if total > 0 else 0,
        "avg_win": round(avg_win, 3),
        "avg_loss": round(avg_loss, 3),
        "payoff_ratio": round(payoff_ratio, 3),
        "profit_factor": round(profit_factor, 3),
        "sharpe_ratio": round(sharpe_ratio, 3),
        "sortino_ratio": round(sortino_ratio, 3),
        "calmar_ratio": round(calmar_ratio, 3),
        "recovery_factor": round(recovery_factor, 3),
        "max_drawdown": round(max_drawdown, 2),
        "max_consecutive_losses": max_consec_loss,
        "max_consecutive_wins": max_consec_win,
        "avg_hold_days": round(avg_hold, 1),
        "expectancy": round(expectancy, 3),
        "total_net_return": round(float(np.sum(returns)), 2),
    }


def _max_consecutive_losses(returns: np.ndarray) -> int:
    """計算最大連續虧損次數"""
    max_streak = 0
    current_streak = 0
    for r in returns:
        if r <= 0:
            current_streak += 1
            max_streak = max(max_streak, current_streak)
        else:
            current_streak = 0
    return max_streak


def _max_consecutive_wins(returns: np.ndarray) -> int:
    """計算最大連續獲利次數"""
    max_streak = 0
    current_streak = 0
    for r in returns:
        if r > 0:
            current_streak += 1
            max_streak = max(max_streak, current_streak)
        else:
            current_streak = 0
    return max_streak


def _empty_metrics() -> dict:
    """空回測結果"""
    return {
        "trade_count": 0, "win_count": 0, "loss_count": 0,
        "win_rate": 0, "avg_net_return": 0, "avg_gross_return": 0,
        "median_return": 0, "max_gain": 0, "max_loss": 0,
        "avg_win": 0, "avg_loss": 0, "payoff_ratio": 0,
        "profit_factor": 0, "sharpe_ratio": 0, "sortino_ratio": 0,
        "calmar_ratio": 0, "recovery_factor": 0, "max_drawdown": 0,
        "max_consecutive_losses": 0, "max_consecutive_wins": 0,
        "avg_hold_days": 0, "expectancy": 0, "total_net_return": 0,
    }
