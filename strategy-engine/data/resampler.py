from __future__ import annotations
"""
K 線週期轉換模組
將日 K 數據合成為週 K 或月 K。
"""

import pandas as pd


def resample_to_weekly(daily: pd.DataFrame) -> pd.DataFrame:
    """
    日 K → 週 K 合成。
    以每週最後一個交易日為基準。

    Parameters:
        daily: DataFrame with columns [date, open, high, low, close, volume]

    Returns:
        DataFrame with same columns, resampled to weekly
    """
    df = daily.copy()
    df["date"] = pd.to_datetime(df["date"])
    df = df.set_index("date")

    weekly = df.resample("W").agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
    }).dropna()

    weekly = weekly.reset_index()
    return weekly


def resample_to_monthly(daily: pd.DataFrame) -> pd.DataFrame:
    """
    日 K → 月 K 合成。
    以每月最後一個交易日為基準。

    Parameters:
        daily: DataFrame with columns [date, open, high, low, close, volume]

    Returns:
        DataFrame with same columns, resampled to monthly
    """
    df = daily.copy()
    df["date"] = pd.to_datetime(df["date"])
    df = df.set_index("date")

    monthly = df.resample("ME").agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
    }).dropna()

    monthly = monthly.reset_index()
    return monthly


def resample(daily: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """
    根據指定的 timeframe 合成 K 線。

    Parameters:
        daily: 日 K 數據
        timeframe: 'daily' | 'weekly' | 'monthly'

    Returns:
        合成後的 DataFrame
    """
    if timeframe == "weekly":
        return resample_to_weekly(daily)
    elif timeframe == "monthly":
        return resample_to_monthly(daily)
    else:
        return daily.copy()
