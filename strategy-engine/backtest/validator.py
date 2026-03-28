from __future__ import annotations
"""
訓練/驗證/測試集切分 + Walk-Forward 驗證
"""

from typing import Any


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


def check_overfit(train_stats: dict, val_stats: dict) -> dict[str, Any]:
    """
    比較訓練集和驗證集的績效，判斷是否過擬合。

    Returns:
        dict with overfit indicators
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

    # 判斷過擬合
    is_overfit = False
    reasons = []

    if wr_gap > 15:
        is_overfit = True
        reasons.append(f"勝率落差 {wr_gap:.1f}%（訓練 {train_wr:.1f}% vs 驗證 {val_wr:.1f}%）")

    if sharpe_gap > 0.5:
        is_overfit = True
        reasons.append(f"夏普落差 {sharpe_gap:.2f}（訓練 {train_sharpe:.2f} vs 驗證 {val_sharpe:.2f}）")

    if train_pf > 1.5 and val_pf < 1.0:
        is_overfit = True
        reasons.append(f"獲利因子驟降（訓練 {train_pf:.2f} vs 驗證 {val_pf:.2f}）")

    return {
        "is_overfit": is_overfit,
        "win_rate_gap": round(wr_gap, 2),
        "sharpe_gap": round(sharpe_gap, 3),
        "profit_factor_train": round(train_pf, 3),
        "profit_factor_val": round(val_pf, 3),
        "reasons": reasons,
    }
