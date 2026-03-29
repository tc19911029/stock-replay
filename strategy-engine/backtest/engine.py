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
    fundamental_data: dict = None,
    chip_data: dict = None,
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

    # Multi-factor scoring mode (v3): weighted scoring instead of binary filter
    use_fundamental = strategy.parameters.get("use_fundamental_filter", False)
    min_fundamental_score = strategy.parameters.get("min_fundamental_score", 40)
    use_chip = strategy.parameters.get("use_chip_filter", False)
    min_chip_score = strategy.parameters.get("min_chip_score", 40)
    use_weighted_scoring = strategy.parameters.get("use_weighted_scoring", False)

    for symbol, df in data.items():
        if len(df) < 60:
            continue

        # Calculate multi-factor bonus scores
        f_score = 50.0
        c_score = 50.0

        if fundamental_data:
            from analysis.fundamental import score_fundamental, score_fundamental_detailed
            f_detail = score_fundamental_detailed(fundamental_data.get(symbol))
            f_score = f_detail.get("total_score", score_fundamental(fundamental_data.get(symbol)))

        if chip_data:
            from analysis.chip import score_chip, score_chip_detailed
            chip_detail = score_chip_detailed(chip_data.get(symbol), market)
            c_score = chip_detail.get("total_score", score_chip(chip_data.get(symbol), market))

        if use_weighted_scoring:
            # Weighted scoring mode: chip + fundamental influence signal quality,
            # not binary filter. Low scores penalize signal strength instead of
            # removing the stock entirely.
            # Only skip if both scores are very low (< 25)
            if f_score < 25 and c_score < 25:
                per_stock[symbol] = {
                    "skipped": "multi_factor_too_weak",
                    "f_score": f_score,
                    "c_score": c_score,
                }
                continue
        else:
            # Legacy binary filter mode
            if use_fundamental and f_score < min_fundamental_score:
                per_stock[symbol] = {"skipped": "fundamental", "score": f_score}
                continue
            if use_chip and c_score < min_chip_score:
                per_stock[symbol] = {"skipped": "chip", "score": c_score}
                continue

        try:
            # Pass multi-factor scores to single backtest for adaptive hold days
            multi_factor_bonus = _calc_multi_factor_bonus(f_score, c_score)
            trades = _backtest_single(
                strategy, df, symbol, split, train_ratio, val_ratio,
                cost_config, multi_factor_bonus=multi_factor_bonus,
            )
            all_trades.extend(trades)
            per_stock[symbol] = {
                "trade_count": len(trades),
                "wins": sum(1 for t in trades if t["net_return"] > 0),
                "f_score": round(f_score, 1),
                "c_score": round(c_score, 1),
                "multi_factor_bonus": round(multi_factor_bonus, 2),
            }
        except Exception as e:
            per_stock[symbol] = {"error": str(e)}

    from backtest.metrics import calc_metrics
    stats = calc_metrics(all_trades)

    return {
        "trades": all_trades,
        "stats": stats,
        "per_stock": per_stock,
        "trade_count": len(all_trades),
    }


def _calc_multi_factor_bonus(f_score: float, c_score: float) -> float:
    """
    Calculate multi-factor bonus from fundamental + chip scores.

    Returns a bonus multiplier (0.0 to 1.0):
    - 1.0 = strong fundamental + chip support → longer hold, wider stop
    - 0.5 = neutral
    - 0.0 = weak → shorter hold, tighter stop

    This replaces the binary filter with a graduated quality signal.
    """
    # Weighted: chip 60% (more timely), fundamental 40% (more stable)
    weighted = c_score * 0.6 + f_score * 0.4
    return max(0.0, min(1.0, weighted / 100.0))


def _backtest_single(
    strategy: StrategyConfig,
    df: pd.DataFrame,
    symbol: str,
    split: str,
    train_ratio: float,
    val_ratio: float,
    cost_config: dict,
    multi_factor_bonus: float = 0.5,
) -> list[dict]:
    """單支股票回測"""

    # 1. 計算技術指標
    df_ind = compute_all_indicators(df)

    # 2. ��間切分
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

    # 5. 模擬交易 with adaptive parameters based on multi-factor bonus
    base_hold_days = strategy.parameters.get("hold_days", 5)
    base_stop_loss = strategy.parameters.get("stop_loss_pct", -0.07)
    slippage = cost_config.get("slippage", 0.001)

    # Volatility regime adjustment
    if "atr_pct" in df_ind.columns and len(df_ind) > 0:
        last_atr_pct = df_ind["atr_pct"].iloc[-1]
        if pd.notna(last_atr_pct):
            if last_atr_pct >= 90:  # EXTREME
                base_stop_loss = base_stop_loss * 1.5
                base_hold_days = max(2, int(base_hold_days * 0.6))
            elif last_atr_pct >= 70:  # HIGH
                base_stop_loss = base_stop_loss * 1.25
                base_hold_days = max(2, int(base_hold_days * 0.8))
            elif last_atr_pct <= 20:  # LOW
                base_stop_loss = base_stop_loss * 0.75
                base_hold_days = min(10, int(base_hold_days * 1.2))

    # Adaptive hold days: strong multi-factor → hold longer
    # bonus 0.8+ → +3 days, 0.6-0.8 → +1, 0.4-0.6 → 0, <0.4 → -1
    if multi_factor_bonus >= 0.8:
        hold_days = base_hold_days + 3
        stop_loss_pct = base_stop_loss * 0.85  # wider stop (less negative)
    elif multi_factor_bonus >= 0.6:
        hold_days = base_hold_days + 1
        stop_loss_pct = base_stop_loss
    elif multi_factor_bonus >= 0.4:
        hold_days = base_hold_days
        stop_loss_pct = base_stop_loss
    else:
        hold_days = max(2, base_hold_days - 1)
        stop_loss_pct = base_stop_loss * 1.15  # tighter stop (more negative)

    # Take-profit and trailing stop parameters
    take_profit_pct = strategy.parameters.get("take_profit_pct", None)  # e.g., 0.08 for 8%
    trailing_stop_pct = strategy.parameters.get("trailing_stop_pct", None)  # e.g., 0.05 for 5% from peak

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

        # 出場邏輯：持有 N 天或觸發停損/停利/移動停損
        exit_price = None
        exit_date = ""
        exit_reason = "hold_days"
        hold = 0
        peak_price = entry_price  # Track highest price for trailing stop

        for j in range(1, hold_days + 1):
            check_pos = entry_pos + j
            if check_pos >= len(df_ind):
                break

            row = df_ind.iloc[check_pos]
            hold += 1

            # Update peak price (using intraday high)
            if row["high"] > peak_price:
                peak_price = row["high"]

            if entry_price > 0:
                # 停損檢查（盤中最低價）
                intraday_low_ret = (row["low"] - entry_price) / entry_price
                if intraday_low_ret <= stop_loss_pct:
                    exit_price = entry_price * (1 + stop_loss_pct)
                    exit_date = str(row["date"])[:10] if pd.notna(row["date"]) else ""
                    exit_reason = "stop_loss"
                    break

                # 停利檢查（盤中最高價）
                if take_profit_pct is not None:
                    intraday_high_ret = (row["high"] - entry_price) / entry_price
                    if intraday_high_ret >= take_profit_pct:
                        exit_price = entry_price * (1 + take_profit_pct)
                        exit_date = str(row["date"])[:10] if pd.notna(row["date"]) else ""
                        exit_reason = "take_profit"
                        break

                # 移動停損檢查（從最高點回落超過 trailing_stop_pct）
                if trailing_stop_pct is not None and peak_price > entry_price:
                    drawdown_from_peak = (row["low"] - peak_price) / peak_price
                    if drawdown_from_peak <= -trailing_stop_pct:
                        exit_price = peak_price * (1 - trailing_stop_pct)
                        # Don't exit below entry stop loss
                        exit_price = max(exit_price, entry_price * (1 + stop_loss_pct))
                        exit_date = str(row["date"])[:10] if pd.notna(row["date"]) else ""
                        exit_reason = "trailing_stop"
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
            "multi_factor_bonus": round(multi_factor_bonus, 2),
            "adaptive_hold_days": hold_days,
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
