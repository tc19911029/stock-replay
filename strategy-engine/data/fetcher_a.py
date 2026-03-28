from __future__ import annotations
"""
A 股數據抓取模組 — 使用 AKShare
抓取滬深 A 股日 K 線數據，支援本地快取。
"""

import os
import json
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from pathlib import Path

CACHE_DIR = Path(__file__).parent / "cache" / "a_shares"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ── 滬深 300 前 50 大型股（按市值） ──────────────────────────────────────────
DEFAULT_STOCKS = [
    "600519",  # 貴州茅台
    "601318",  # 中國平安
    "600036",  # 招商銀行
    "600276",  # 恆瑞醫藥
    "601166",  # 興業銀行
    "600900",  # 長江電力
    "601398",  # 工商銀行
    "600030",  # 中信證券
    "600887",  # 伊利股份
    "601888",  # 中國中免
    "600309",  # 萬華化學
    "002714",  # 牧原股份
    "000858",  # 五糧液
    "002475",  # 立訊精密
    "600585",  # 海螺水泥
    "601012",  # 隆基綠能
    "300750",  # 寧德時代
    "002594",  # 比亞迪
    "600809",  # 山西汾酒
    "601668",  # 中國建築
    "600031",  # 三一重工
    "000333",  # 美的集團
    "000001",  # 平安銀行
    "600048",  # 保利發展
    "601899",  # 紫金礦業
    "002352",  # 順豐控股
    "300059",  # 東方財富
    "600000",  # 浦發銀行
    "601288",  # 農業銀行
    "600104",  # 上汽集團
    "000002",  # 萬科A
    "002304",  # 洋河股份
    "600050",  # 中國聯通
    "601601",  # 中國太保
    "000568",  # 瀘州老窖
    "600436",  # 片仔癀
    "601857",  # 中國石油
    "603259",  # 藥明康德
    "002230",  # 科大訊飛
    "000725",  # 京東方A
    "600196",  # 復星醫藥
    "002415",  # 海康威視
    "601633",  # 長城汽車
    "300274",  # 陽光電源
    "600745",  # 聞泰科技
    "002049",  # 紫光國微
    "603986",  # 兆易創新
    "300408",  # 三環集團
    "601066",  # 中信建投
    "000063",  # 中興通訊
]


def _cache_path(symbol: str) -> Path:
    """取得快取檔案路徑"""
    return CACHE_DIR / f"{symbol}.csv"


def _is_cache_valid(path: Path, expire_hours: int = 24) -> bool:
    """檢查快取是否仍有效"""
    if not path.exists():
        return False
    mtime = datetime.fromtimestamp(path.stat().st_mtime)
    return (datetime.now() - mtime) < timedelta(hours=expire_hours)


def fetch_single_stock(symbol: str, days: int = 500, expire_hours: int = 24) -> pd.DataFrame | None:
    """
    抓取單支 A 股日 K 線數據。
    優先使用本地快取，過期才重新抓取。

    Returns:
        DataFrame with columns: date, open, high, low, close, volume
    """
    cache = _cache_path(symbol)

    if _is_cache_valid(cache, expire_hours):
        try:
            df = pd.read_csv(cache, parse_dates=["date"])
            if len(df) > 0:
                return df
        except Exception:
            pass

    # 從 AKShare 抓取
    try:
        import akshare as ak
        end_date = datetime.now().strftime("%Y%m%d")
        start_date = (datetime.now() - timedelta(days=days)).strftime("%Y%m%d")

        df = ak.stock_zh_a_hist(
            symbol=symbol,
            period="daily",
            start_date=start_date,
            end_date=end_date,
            adjust="qfq",  # 前復權
        )

        if df is None or df.empty:
            return None

        # 統一欄位名
        df = df.rename(columns={
            "日期": "date",
            "开盘": "open",
            "最高": "high",
            "最低": "low",
            "收盘": "close",
            "成交量": "volume",
        })

        df["date"] = pd.to_datetime(df["date"])
        df = df[["date", "open", "high", "low", "close", "volume"]].sort_values("date").reset_index(drop=True)

        # 存入快取
        df.to_csv(cache, index=False)
        return df

    except Exception as e:
        print(f"  ⚠ A 股 {symbol} 抓取失敗：{e}")
        # 嘗試 yfinance 備援
        return _fetch_yfinance_fallback(symbol, days, cache)


def _fetch_yfinance_fallback(symbol: str, days: int, cache: Path) -> pd.DataFrame | None:
    """AKShare 失敗時，用 yfinance 備援"""
    try:
        import yfinance as yf
        suffix = ".SS" if symbol.startswith("6") else ".SZ"
        ticker = f"{symbol}{suffix}"
        end = datetime.now()
        start = end - timedelta(days=days)

        df = yf.download(ticker, start=start, end=end, progress=False, auto_adjust=True)

        if df is None or df.empty:
            return None

        df = df.reset_index()
        df = df.rename(columns={
            "Date": "date",
            "Open": "open",
            "High": "high",
            "Low": "low",
            "Close": "close",
            "Volume": "volume",
        })
        df = df[["date", "open", "high", "low", "close", "volume"]].sort_values("date").reset_index(drop=True)

        # 存入快取
        df.to_csv(cache, index=False)
        return df

    except Exception as e:
        print(f"  ⚠ A 股 {symbol} yfinance 備援也失敗：{e}")
        return None


def fetch_all(stock_count: int = 50, days: int = 500, expire_hours: int = 24) -> dict[str, pd.DataFrame]:
    """
    批量抓取 A 股數據。

    Returns:
        dict: {symbol: DataFrame}
    """
    stocks = DEFAULT_STOCKS[:stock_count]
    result = {}
    success = 0
    fail = 0

    print(f"📥 開始抓取 A 股數據（{len(stocks)} 支）...")

    for i, symbol in enumerate(stocks):
        df = fetch_single_stock(symbol, days, expire_hours)
        if df is not None and len(df) >= 60:  # 至少 60 根 K 線
            result[symbol] = df
            success += 1
        else:
            fail += 1

        if (i + 1) % 10 == 0:
            print(f"  進度：{i + 1}/{len(stocks)}（成功 {success}，失敗 {fail}）")

    print(f"✅ A 股數據抓取完成：{success} 成功，{fail} 失敗")
    return result
