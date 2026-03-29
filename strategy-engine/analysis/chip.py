from __future__ import annotations
"""
籌碼面分析模組 — 法人買賣超、融資融券等
A 股用 AKShare，台股用 FinMind / TWSE API。
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

CACHE_DIR = Path(__file__).parent.parent / "data" / "cache" / "chip"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


# ═══════════════════════════════════════════════════════════════════════════════
# 台股籌碼（FinMind — 三大法人買賣超）
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_tw_chip(symbol: str, days: int = 60) -> pd.DataFrame | None:
    """
    抓取台股三大法人買賣超數據。

    Returns:
        DataFrame: date, foreign_net, trust_net, dealer_net, total_net
    """
    cache = CACHE_DIR / f"tw_{symbol}.csv"
    if cache.exists():
        mtime = datetime.fromtimestamp(cache.stat().st_mtime)
        if (datetime.now() - mtime) < timedelta(hours=24):
            try:
                return pd.read_csv(cache, parse_dates=["date"])
            except Exception:
                pass

    try:
        from FinMind.data import DataLoader
        dl = DataLoader()

        start = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        df = dl.taiwan_stock_institutional_investors(
            stock_id=symbol, start_date=start
        )

        if df is None or df.empty:
            return None

        # FinMind 回傳的格式：每天每個法人一列
        # name: 外資, 投信, 自營商
        # buy, sell
        pivot = df.pivot_table(
            index="date", columns="name", values="buy", aggfunc="sum"
        ).fillna(0)

        sell_pivot = df.pivot_table(
            index="date", columns="name", values="sell", aggfunc="sum"
        ).fillna(0)

        result = pd.DataFrame(index=pivot.index)
        result["foreign_net"] = pivot.get("Foreign_Investor", 0) - sell_pivot.get("Foreign_Investor", 0)
        result["trust_net"] = pivot.get("Investment_Trust", 0) - sell_pivot.get("Investment_Trust", 0)
        result["dealer_net"] = pivot.get("Dealer_self", 0) - sell_pivot.get("Dealer_self", 0)
        result["total_net"] = result["foreign_net"] + result["trust_net"] + result["dealer_net"]
        result = result.reset_index()
        result["date"] = pd.to_datetime(result["date"])

        result.to_csv(cache, index=False)
        return result

    except Exception as e:
        print(f"  ⚠ 台股 {symbol} 籌碼抓取失敗：{e}")
        return None


# ═══════════════════════════════════════════════════════════════════════════════
# A 股籌碼（AKShare — 主力資金流向）
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_a_chip(symbol: str, days: int = 60) -> pd.DataFrame | None:
    """
    抓取 A 股主力資金流向。

    Returns:
        DataFrame: date, main_net (主力淨流入), retail_net (散戶淨流入)
    """
    cache = CACHE_DIR / f"a_{symbol}.csv"
    if cache.exists():
        mtime = datetime.fromtimestamp(cache.stat().st_mtime)
        if (datetime.now() - mtime) < timedelta(hours=24):
            try:
                return pd.read_csv(cache, parse_dates=["date"])
            except Exception:
                pass

    try:
        import akshare as ak

        df = ak.stock_individual_fund_flow(stock=symbol, market="sh" if symbol.startswith("6") else "sz")

        if df is None or df.empty:
            return None

        # 統一欄位
        result = pd.DataFrame()
        result["date"] = pd.to_datetime(df["日期"])
        result["main_net"] = pd.to_numeric(df.get("主力净流入-净额", 0), errors="coerce").fillna(0)

        # 計算近 N 天
        result = result.sort_values("date").tail(days).reset_index(drop=True)

        result.to_csv(cache, index=False)
        return result

    except Exception as e:
        print(f"  ⚠ A 股 {symbol} 籌碼抓取失敗：{e}")
        return None


# ═══════════════════════════════════════════════════════════════════════════════
# 批量 + 評分
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_chips(symbols: list[str], market: str) -> dict[str, pd.DataFrame]:
    """批量抓取籌碼數據"""
    result = {}
    fetch_fn = fetch_a_chip if market == "a_shares" else fetch_tw_chip

    print(f"  📊 抓取 {market} 籌碼數據（{len(symbols)} 支）...")
    success = 0
    for sym in symbols:
        df = fetch_fn(sym)
        if df is not None and len(df) > 0:
            result[sym] = df
            success += 1

    print(f"  ✅ 籌碼：{success}/{len(symbols)} 成功")
    return result


def score_chip(chip_df: pd.DataFrame | None, market: str = "tw_stocks") -> float:
    """
    籌碼面評分 0-100。

    評分維度：
    - 近 5 日法人/主力淨買超 (40%)：連續買超加分
    - 近 20 日累積淨買超 (30%)：趨勢方向
    - 買超加速度 (30%)：近 5 日 vs 前 5 日
    """
    if chip_df is None or len(chip_df) < 5:
        return 50.0  # 沒數據給中間分

    score = 0.0

    if market == "tw_stocks":
        net_col = "total_net"
    else:
        net_col = "main_net"

    if net_col not in chip_df.columns:
        return 50.0

    values = chip_df[net_col].values

    # 近 5 日淨買超 (40%)
    last5 = values[-5:]
    buy_days = sum(1 for v in last5 if v > 0)
    if buy_days >= 4:
        score += 40
    elif buy_days >= 3:
        score += 30
    elif buy_days >= 2:
        score += 20
    elif buy_days >= 1:
        score += 10

    # 近 20 日累積 (30%)
    last20 = values[-20:] if len(values) >= 20 else values
    total_net = sum(last20)
    if total_net > 0:
        score += 20 + min(10, abs(total_net) / (abs(total_net) + 1e6) * 10)
    else:
        score += max(0, 10 - abs(total_net) / (abs(total_net) + 1e6) * 10)

    # 加速度 (30%)：近 5 日 vs 前 5 日
    if len(values) >= 10:
        recent5 = sum(values[-5:])
        prev5 = sum(values[-10:-5])
        if recent5 > prev5 and recent5 > 0:
            score += 30  # 買超加速
        elif recent5 > 0:
            score += 20  # 持續買超但減速
        elif recent5 > prev5:
            score += 10  # 賣超但趨緩
        else:
            score += 0   # 賣超加速
    else:
        score += 15

    return round(min(100, score), 1)


def score_chip_detailed(chip_df: pd.DataFrame | None, market: str = "tw_stocks") -> dict:
    """
    詳細籌碼面評分，包含子因子分析。

    Returns:
        dict with: total_score, sub_scores, signals
    """
    base_score = score_chip(chip_df, market)

    result = {
        "total_score": base_score,
        "trust_consecutive_buy": 0,    # 投信連買天數
        "foreign_consecutive_buy": 0,  # 外資連買天數
        "chip_concentration": 0,       # 籌碼集中度 0-100
        "signals": [],
    }

    if chip_df is None or len(chip_df) < 5:
        return result

    if market == "tw_stocks":
        # ── 投信連買天數（台股最強因子之一）──────────────────────────────────
        if "trust_net" in chip_df.columns:
            trust_vals = chip_df["trust_net"].values
            consec = 0
            for v in reversed(trust_vals):
                if v > 0:
                    consec += 1
                else:
                    break
            result["trust_consecutive_buy"] = consec

            if consec >= 5:
                result["signals"].append(f"投信連買 {consec} 天（強力作帳訊號）")
                result["total_score"] = min(100, base_score + 15)
            elif consec >= 3:
                result["signals"].append(f"投信連買 {consec} 天")
                result["total_score"] = min(100, base_score + 8)

        # ── 外資連買天數 ──────────────────────────────────────────────────────
        if "foreign_net" in chip_df.columns:
            foreign_vals = chip_df["foreign_net"].values
            consec = 0
            for v in reversed(foreign_vals):
                if v > 0:
                    consec += 1
                else:
                    break
            result["foreign_consecutive_buy"] = consec

            if consec >= 5:
                result["signals"].append(f"外資連買 {consec} 天")
                result["total_score"] = min(100, result["total_score"] + 10)
            elif consec >= 3:
                result["signals"].append(f"外資連買 {consec} 天")
                result["total_score"] = min(100, result["total_score"] + 5)

        # ── 籌碼集中度（三大法人同步買超）──────────────────────────────────
        if all(c in chip_df.columns for c in ["foreign_net", "trust_net", "dealer_net"]):
            last5 = chip_df.tail(5)
            all_buy_days = 0
            for _, row in last5.iterrows():
                if row["foreign_net"] > 0 and row["trust_net"] > 0:
                    all_buy_days += 1
            concentration = int(all_buy_days / 5 * 100)
            result["chip_concentration"] = concentration
            if concentration >= 60:
                result["signals"].append(f"三大法人同步買超 {all_buy_days}/5 天")
                result["total_score"] = min(100, result["total_score"] + 5)

    elif market == "a_shares":
        # ── 主力連買天數 ──────────────────────────────────────────────────────
        if "main_net" in chip_df.columns:
            main_vals = chip_df["main_net"].values
            consec = 0
            for v in reversed(main_vals):
                if v > 0:
                    consec += 1
                else:
                    break

            if consec >= 5:
                result["signals"].append(f"主力連買 {consec} 天")
                result["total_score"] = min(100, base_score + 15)
            elif consec >= 3:
                result["signals"].append(f"主力連買 {consec} 天")
                result["total_score"] = min(100, base_score + 8)

    return result


# ═══════════════════════════════════════════════════════════════════════════════
# 北向資金 / Northbound Flow (A-shares via Stock Connect)
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_northbound_flow(days: int = 20) -> pd.DataFrame | None:
    """
    抓取北向資金（滬股通+深股通）近期資金流向。
    北向資金連續流入 = 外資看多 A 股，具強力指標意義。

    Returns:
        DataFrame: date, north_net (億元)
    """
    cache = CACHE_DIR / "northbound_flow.csv"
    if cache.exists():
        mtime = datetime.fromtimestamp(cache.stat().st_mtime)
        if (datetime.now() - mtime) < timedelta(hours=12):
            try:
                return pd.read_csv(cache, parse_dates=["date"])
            except Exception:
                pass

    try:
        import akshare as ak
        df = ak.stock_hsgt_north_net_flow_in_em()
        if df is None or df.empty:
            return None

        result = pd.DataFrame()
        result["date"] = pd.to_datetime(df["日期"])
        result["north_net"] = pd.to_numeric(df.get("当日净流入", 0), errors="coerce").fillna(0)
        result = result.sort_values("date").tail(days).reset_index(drop=True)

        result.to_csv(cache, index=False)
        return result

    except Exception as e:
        print(f"  ⚠ 北向資金數據抓取失敗：{e}")
        return None


def score_northbound(north_df: pd.DataFrame | None) -> dict:
    """
    北向資金評分（A 股專用）。

    Returns:
        dict: score (0-100), consecutive_days, signals
    """
    result_dict = {"score": 50.0, "consecutive_days": 0, "signals": []}

    if north_df is None or len(north_df) < 5:
        return result_dict

    values = north_df["north_net"].values

    consec = 0
    for v in reversed(values):
        if v > 0:
            consec += 1
        else:
            break
    result_dict["consecutive_days"] = consec

    score = 50.0

    # 近 5 日淨流入天數 (40%)
    last5 = values[-5:]
    inflow_days = sum(1 for v in last5 if v > 0)
    if inflow_days >= 4:
        score += 25
    elif inflow_days >= 3:
        score += 15
    elif inflow_days >= 2:
        score += 5

    # 近 10 日累積流入 (30%)
    last10 = values[-10:] if len(values) >= 10 else values
    total = sum(last10)
    if total > 50:
        score += 20
        result_dict["signals"].append(f"北向10日累積淨流入 {total:.0f}億")
    elif total > 0:
        score += 10

    # 加速度 (30%)
    if len(values) >= 10:
        recent = sum(values[-5:])
        prev = sum(values[-10:-5])
        if recent > prev and recent > 0:
            score += 20
            result_dict["signals"].append("北向資金加速流入")
        elif recent > 0:
            score += 10

    if consec >= 5:
        result_dict["signals"].append(f"北向連續 {consec} 天淨流入（強力看多）")
        score += 10
    elif consec >= 3:
        result_dict["signals"].append(f"北向連續 {consec} 天淨流入")

    result_dict["score"] = min(100, score)
    return result_dict
