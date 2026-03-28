from __future__ import annotations
"""
向量化回測引擎
用 pandas 批量計算，不用事件驅動循環。
"""

import pandas as pd
import numpy as np
from analysis.technical import compute_all_indicators, evaluate_conditions
from strategies.base import StrategyConfig


def run_backtest(
    strategy: StrategyConfig,
    data: dict[str, pd.DataFrame],
    market: str = "tw_stocks",
    split: str = "all",
    train_ratio: float = 0.6,
    val_ratio: float = 0.2,
    cost_config: dict = None,
) -> dict:
    """
    對多支股票跑回測。

    Parameters:
        strategy: 策略配置
        data: {symbol: daily_df} 字典
        market: 'tw_stocks' 或 'a_shares'
        split: 'train' | 'validation' | 'test' | 'all'
        train_ratio: 訓練集比例
        val_ratio: 驗證集比例
        cost_config: 成本參數 dict

    Returns:
        dict with keys: trades (list), stats (dict), per_stock (dict)
    """
    if cost_config is None:
        cost_config = _default_cost(market)

    all_trades = []
    per_stock = {}

    for symbol, df in data.items():
        if len(df) < 60:
            continue

        try:
            trades = _backtest_single(strategy, df, symbol, split, train_ratio, val_ratio, cost_config)
            all_trades.extend(trades)
            per_stock[symbol] = {
                "trade_count": len(trades),
                "wins": sum(1 for t in trades if t["net_return"] > 0),
            }
        except Exception as e:
            # 單支股票失敗不停止
            per_stock[symbol] = {"error": str(e)}

    from backtest.metrics import calc_metrics
    stats = calc_metrics(all_trades)

    return {
        "trades": all_trades,
        "stats": stats,
        "per_stock": per_stock,
        "trade_count": len(all_trades),
    }


def _backtest_single(
    strategy: StrategyConfig,
    df: pd.DataFrame,
    symbol: str,
    split: str,
    train_ratio: float,
    val_ratio: float,
    cost_config: dict,
) -> list[dict]:
    """單支股票回測"""

    # 1. 計算技術指標
    df_ind = compute_all_indicators(df)

    # 2. 時間切分
    n = len(df_ind)
    if split == "train":
        df_ind = df_ind.iloc[:int(n * train_ratio)]
    elif split == "validation":
        start = int(n * train_ratio)
        end = int(n * (train_ratio + val_ratio))
        df_ind = df_ind.iloc[start:end]
    elif split == "test":
        start = int(n * (train_ratio + val_ratio))
        df_ind = df_ind.iloc[start:]
    # else: 'all' → 用全部

    if len(df_ind) < 30:
        return []

    # 3. 評估進場條件
    cond_df = evaluate_conditions(df_ind, strategy.entry_conditions, strategy.parameters)

    # 4. 找出進場信號（total_score >= min_conditions）
    min_score = strategy.min_conditions
    signal_mask = cond_df["total_score"] >= min_score
    signal_indices = df_ind.index[signal_mask].tolist()

    # 5. 模擬交易
    hold_days = strategy.parameters.get("hold_days", 5)
    stop_loss_pct = strategy.parameters.get("stop_loss_pct", -0.07)
    slippage = cost_config.get("slippage", 0.001)
    trades = []

    i = 0
    while i < len(signal_indices):
        sig_idx = signal_indices[i]
        sig_pos = df_ind.index.get_loc(sig_idx)

        # 進場：信號日的下一根 K 線開盤價 + 滑價
        entry_pos = sig_pos + 1
        if entry_pos >= len(df_ind):
            i += 1
            continue

        entry_row = df_ind.iloc[entry_pos]
        entry_price = entry_row["open"] * (1 + slippage)
        entry_date = str(entry_row["date"])[:10] if pd.notna(entry_row["date"]) else ""

        # 出場邏輯：持有 N 天或觸發停損
        exit_price = None
        exit_date = ""
        exit_reason = "hold_days"
        hold = 0

        for j in range(1, hold_days + 1):
            check_pos = entry_pos + j
            if check_pos >= len(df_ind):
                break

            row = df_ind.iloc[check_pos]
            hold += 1

            # 停損檢查（盤中最低價）
            if entry_price > 0:
                intraday_low_ret = (row["low"] - entry_price) / entry_price
                if intraday_low_ret <= stop_loss_pct:
                    exit_price = entry_price * (1 + stop_loss_pct)
                    exit_date = str(row["date"])[:10] if pd.notna(row["date"]) else ""
                    exit_reason = "stop_loss"
                    break

            # 持有到期
            if j == hold_days:
                exit_price = row["close"] * (1 - slippage)
                exit_date = str(row["date"])[:10] if pd.notna(row["date"]) else ""
                exit_reason = "hold_days"

        if exit_price is None:
            # 數據不足，用最後一根收盤
            last_row = df_ind.iloc[min(entry_pos + hold, len(df_ind) - 1)]
            exit_price = last_row["close"] * (1 - slippage)
            exit_date = str(last_row["date"])[:10] if pd.notna(last_row["date"]) else ""
            exit_reason = "data_end"

        # 計算報酬
        gross_return = (exit_price - entry_price) / entry_price if entry_price > 0 else 0

        # 計算手續費
        cost = _calc_cost(entry_price, exit_price, cost_config)
        net_return = gross_return - cost

        # 記錄各條件是否滿足
        cond_row = cond_df.loc[sig_idx]
        conditions_met = {
            c: bool(cond_row[c]) for c in cond_df.columns if c.startswith("cond_")
        }

        trades.append({
            "symbol": symbol,
            "signal_date": str(df_ind.iloc[sig_pos]["date"])[:10],
            "entry_date": entry_date,
            "entry_price": round(entry_price, 4),
            "exit_date": exit_date,
            "exit_price": round(exit_price, 4),
            "exit_reason": exit_reason,
            "hold_days": hold,
            "gross_return": round(gross_return * 100, 2),  # 百分比
            "net_return": round(net_return * 100, 2),
            "cost_pct": round(cost * 100, 4),
            "score": int(cond_row["total_score"]),
            "conditions_met": conditions_met,
        })

        # 跳過持有期間的信號（避免重複進場）
        skip_until = entry_pos + hold_days
        while i < len(signal_indices) and df_ind.index.get_loc(signal_indices[i]) < skip_until:
            i += 1

    return trades


def _default_cost(market: str) -> dict:
    """預設交易成本"""
    if market == "a_shares":
        return {
            "buy_commission": 0.0003,   # 佣金 0.03%
            "sell_commission": 0.0003,
            "sell_tax": 0.001,          # 印花稅 0.1%
            "slippage": 0.001,
        }
    else:  # tw_stocks
        return {
            "buy_commission": 0.001425 * 0.6,  # 手續費六折
            "sell_commission": 0.001425 * 0.6,
            "sell_tax": 0.003,                  # 證交稅 0.3%
            "slippage": 0.001,
        }


def _calc_cost(entry_price: float, exit_price: float, config: dict) -> float:
    """計算總交易成本（佔比）"""
    buy_cost = config.get("buy_commission", 0.001)
    sell_cost = config.get("sell_commission", 0.001) + config.get("sell_tax", 0.003)
    return buy_cost + sell_cost
