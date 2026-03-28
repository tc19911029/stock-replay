from __future__ import annotations
"""
台股數據抓取模組 — 使用 FinMind / yfinance
抓取台灣上市上櫃股票日 K 線數據，支援本地快取。
"""

import os
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from pathlib import Path

CACHE_DIR = Path(__file__).parent / "cache" / "tw_stocks"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ── 台灣 50 指數成分股 ──────────────────────────────────────────────────────
DEFAULT_STOCKS = [
    "2330",  # 台積電
    "2317",  # 鴻海
    "2454",  # 聯發科
    "2308",  # 台達電
    "2881",  # 富邦金
    "2882",  # 國泰金
    "2303",  # 聯電
    "2412",  # 中華電
    "2886",  # 兆豐金
    "1301",  # 台塑
    "1303",  # 南亞
    "2891",  # 中信金
    "3711",  # 日月光投控
    "2884",  # 玉山金
    "2002",  # 中鋼
    "1326",  # 台化
    "2357",  # 華碩
    "5880",  # 合庫金
    "2382",  # 廣達
    "2885",  # 元大金
    "2892",  # 第一金
    "3008",  # 大立光
    "2880",  # 華南金
    "2883",  # 開發金
    "1216",  # 統一
    "2345",  # 智邦
    "2603",  # 長榮
    "6505",  # 台塑化
    "5871",  # 中租-KY
    "2609",  # 陽明
    "2301",  # 光寶科
    "3034",  # 聯詠
    "2395",  # 研華
    "4904",  # 遠傳
    "2327",  # 國巨
    "3045",  # 台灣大
    "2615",  # 萬海
    "9910",  # 豐泰
    "6669",  # 緯穎
    "2379",  # 瑞昱
    "3037",  # 欣興
    "2912",  # 統一超
    "1101",  # 台泥
    "2207",  # 和泰車
    "2474",  # 可成
    "5876",  # 上海商銀
    "2408",  # 南亞科
    "6415",  # 矽力-KY
    "3443",  # 創意
    "2347",  # 聯強
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
    抓取單支台股日 K 線數據。
    優先用 FinMind，失敗用 yfinance 備援。

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

    # 嘗試 FinMind
    df = _fetch_finmind(symbol, days, cache)
    if df is not None:
        return df

    # 備援 yfinance
    return _fetch_yfinance(symbol, days, cache)


def _fetch_finmind(symbol: str, days: int, cache: Path) -> pd.DataFrame | None:
    """使用 FinMind 抓取台股數據"""
    try:
        from FinMind.data import DataLoader
        dl = DataLoader()

        start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        end_date = datetime.now().strftime("%Y-%m-%d")

        df = dl.taiwan_stock_daily(
            stock_id=symbol,
            start_date=start_date,
            end_date=end_date,
        )

        if df is None or df.empty:
            return None

        df = df.rename(columns={
            "date": "date",
            "open": "open",
            "max": "high",
            "min": "low",
            "close": "close",
            "Trading_Volume": "volume",
        })

        df["date"] = pd.to_datetime(df["date"])
        df = df[["date", "open", "high", "low", "close", "volume"]].sort_values("date").reset_index(drop=True)

        # 存入快取
        df.to_csv(cache, index=False)
        return df

    except Exception as e:
        print(f"  ⚠ 台股 {symbol} FinMind 失敗：{e}")
        return None


def _fetch_yfinance(symbol: str, days: int, cache: Path) -> pd.DataFrame | None:
    """使用 yfinance 備援抓取台股數據"""
    try:
        import yfinance as yf
        ticker = f"{symbol}.TW"
        end = datetime.now()
        start = end - timedelta(days=days)

        df = yf.download(ticker, start=start, end=end, progress=False, auto_adjust=True)

        if df is None or df.empty:
            # 嘗試 .TWO（上櫃）
            ticker = f"{symbol}.TWO"
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
        print(f"  ⚠ 台股 {symbol} yfinance 備援也失敗：{e}")
        return None


def fetch_all(stock_count: int = 50, days: int = 500, expire_hours: int = 24) -> dict[str, pd.DataFrame]:
    """
    批量抓取台股數據。

    Returns:
        dict: {symbol: DataFrame}
    """
    stocks = DEFAULT_STOCKS[:stock_count]
    result = {}
    success = 0
    fail = 0

    print(f"📥 開始抓取台股數據（{len(stocks)} 支）...")

    for i, symbol in enumerate(stocks):
        df = fetch_single_stock(symbol, days, expire_hours)
        if df is not None and len(df) >= 60:
            result[symbol] = df
            success += 1
        else:
            fail += 1

        if (i + 1) % 10 == 0:
            print(f"  進度：{i + 1}/{len(stocks)}（成功 {success}，失敗 {fail}）")

    print(f"✅ 台股數據抓取完成：{success} 成功，{fail} 失敗")
    return result
