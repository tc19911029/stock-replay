#!/usr/bin/env python3
"""
台股大師共識突破選股策略 — 獨立回測腳本

綜合朱家泓、權證小哥、蔡森核心方法：
  進場：均線多頭排列 + 20日新高突破 + 量增1.5倍 + KD黃金交叉 + 流動性門檻
  出場：停利15% / 停損-7% / 跌破MA20 / 時間停損20天
  資金：最多5檔，每檔20%，按法人買超排序

Usage:
  python scripts/tw_consensus_backtest.py                    # TW50 快速驗證
  python scripts/tw_consensus_backtest.py --universe full    # 全市場
  python scripts/tw_consensus_backtest.py --force-download   # 強制重新下載
  python scripts/tw_consensus_backtest.py --no-plot          # 不產生圖表
"""

from __future__ import annotations

import argparse
import os
import pickle
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

# ─── 路徑設定 ──────────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
CACHE_DIR = DATA_DIR / "cache" / "consensus"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ─── 策略參數 ──────────────────────────────────────────────────────────────────
# 進場
MA_SHORT = 5
MA_MID = 20
MA_LONG = 60
BREAKOUT_WINDOW = 20        # 20日新高
VOLUME_MULTIPLIER = 1.5     # 量增倍數
KD_PERIOD = 9               # KD 參數
MIN_AVG_VOL_20 = 500_000   # 20日均量門檻（股）
MIN_PRICE = 10.0            # 最低股價

# 出場
TAKE_PROFIT = 0.15          # 停利 15%
STOP_LOSS = -0.07           # 停損 -7%
TIME_STOP_DAYS = 20         # 時間停損

# 資金管理
INITIAL_CAPITAL = 1_000_000
MAX_POSITIONS = 5

# 交易成本
BROKER_FEE = 0.001425       # 券商手續費 0.1425%
BROKER_DISCOUNT = 0.6       # 手續費折扣
TAX_RATE = 0.003            # 交易稅 0.3%（賣出）
SLIPPAGE = 0.001            # 滑價 0.1%

# 回測區間
BACKTEST_START = "2025-03-01"
BACKTEST_END = "2026-03-28"
DATA_START = "2024-10-01"   # 多抓 120 天作均線緩衝

# ─── 台灣50成分股 ──────────────────────────────────────────────────────────────
TW50_SYMBOLS = [
    "2330", "2317", "2454", "2308", "2382", "2303", "2412", "2891", "2881", "2886",
    "2882", "3711", "2884", "1303", "1301", "2002", "3008", "1216", "2885", "5880",
    "2207", "3034", "2301", "5871", "2357", "6505", "2395", "1101", "2912", "4904",
    "2892", "3037", "2880", "1326", "2887", "4938", "2345", "3231", "5876", "6669",
    "2327", "3045", "2883", "1590", "6446", "2603", "3443", "2474", "8046", "3661",
]


# ═══════════════════════════════════════════════════════════════════════════════
# 1. 資料下載
# ═══════════════════════════════════════════════════════════════════════════════

def get_full_stock_list() -> list[str]:
    """從 FinMind 取得全市場上市股票清單（4碼數字）"""
    from FinMind.data import DataLoader
    dl = DataLoader()
    info = dl.taiwan_stock_info()
    mask = info["stock_id"].str.match(r"^\d{4}$")
    return sorted(info.loc[mask, "stock_id"].unique().tolist())


def download_stock_data(
    symbols: list[str],
    start_date: str,
    end_date: str,
    cache_path: Path,
    force: bool = False,
) -> dict[str, pd.DataFrame]:
    """下載股價資料，支援 pickle 快取"""
    if cache_path.exists() and not force:
        print(f"📦 載入快取: {cache_path}")
        with open(cache_path, "rb") as f:
            return pickle.load(f)

    from FinMind.data import DataLoader
    dl = DataLoader()

    all_data: dict[str, pd.DataFrame] = {}
    total = len(symbols)

    print(f"📥 下載 {total} 檔股票 ({start_date} ~ {end_date})")
    for i, sym in enumerate(symbols):
        if (i + 1) % 20 == 0 or i == 0:
            print(f"  進度: {i + 1}/{total}")
        try:
            df = dl.taiwan_stock_daily(
                stock_id=sym,
                start_date=start_date,
                end_date=end_date,
            )
            if df is not None and len(df) > 60:
                df = df.rename(columns={
                    "max": "high",
                    "min": "low",
                    "Trading_Volume": "volume",
                })
                df["date"] = pd.to_datetime(df["date"])
                df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0)
                for col in ("open", "high", "low", "close"):
                    df[col] = pd.to_numeric(df[col], errors="coerce")
                df = df.dropna(subset=["close"])
                # 過濾掉 open/close/high/low 為 0 的異常資料（除權息日等）
                df = df[(df["close"] > 0) & (df["open"] > 0)]
                df = df.sort_values("date").reset_index(drop=True)
                all_data[sym] = df[["date", "stock_id", "open", "high", "low", "close", "volume"]]
        except Exception as e:
            print(f"  ⚠ {sym}: {e}")

        # 控速
        if (i + 1) % 5 == 0:
            time.sleep(1.2)

    print(f"  ✅ 成功下載 {len(all_data)}/{total} 檔")

    with open(cache_path, "wb") as f:
        pickle.dump(all_data, f)
    print(f"  💾 已存快取: {cache_path}")

    return all_data


def download_institutional_data(
    symbols: list[str],
    start_date: str,
    end_date: str,
    cache_path: Path,
    force: bool = False,
) -> dict[str, pd.DataFrame]:
    """下載三大法人買賣超（可選，用於排序）"""
    if cache_path.exists() and not force:
        print(f"📦 載入法人快取: {cache_path}")
        with open(cache_path, "rb") as f:
            return pickle.load(f)

    from FinMind.data import DataLoader
    dl = DataLoader()

    all_inst: dict[str, pd.DataFrame] = {}
    total = len(symbols)

    print(f"📥 下載 {total} 檔法人資料 ({start_date} ~ {end_date})")
    for i, sym in enumerate(symbols):
        if (i + 1) % 20 == 0 or i == 0:
            print(f"  進度: {i + 1}/{total}")
        try:
            df = dl.taiwan_stock_institutional_investors(
                stock_id=sym,
                start_date=start_date,
                end_date=end_date,
            )
            if df is not None and not df.empty:
                df["date"] = pd.to_datetime(df["date"])
                df["buy"] = pd.to_numeric(df.get("buy", 0), errors="coerce").fillna(0)
                df["sell"] = pd.to_numeric(df.get("sell", 0), errors="coerce").fillna(0)
                all_inst[sym] = df
        except Exception:
            pass

        if (i + 1) % 5 == 0:
            time.sleep(1.2)

    print(f"  ✅ 成功下載 {len(all_inst)}/{total} 檔法人資料")

    with open(cache_path, "wb") as f:
        pickle.dump(all_inst, f)

    return all_inst


# ═══════════════════════════════════════════════════════════════════════════════
# 2. 技術指標計算
# ═══════════════════════════════════════════════════════════════════════════════

def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """計算策略所需的所有技術指標"""
    out = df.copy()

    # 均線
    out["ma5"] = out["close"].rolling(MA_SHORT).mean()
    out["ma20"] = out["close"].rolling(MA_MID).mean()
    out["ma60"] = out["close"].rolling(MA_LONG).mean()

    # 20 日新高（收盤價）
    out["high_20d"] = out["close"].rolling(BREAKOUT_WINDOW).max()

    # 成交量均線
    out["vol_avg5"] = out["volume"].rolling(5).mean()
    out["vol_avg20"] = out["volume"].rolling(20).mean()

    # KD (9, 3, 3) — 迭代法（精確）
    low_n = out["low"].rolling(KD_PERIOD).min()
    high_n = out["high"].rolling(KD_PERIOD).max()
    denom = (high_n - low_n).replace(0, np.nan)
    rsv = (out["close"] - low_n) / denom * 100

    k_values = [50.0]
    d_values = [50.0]
    for i in range(1, len(rsv)):
        r = rsv.iloc[i]
        if pd.isna(r):
            k_values.append(k_values[-1])
            d_values.append(d_values[-1])
        else:
            k = k_values[-1] * 2 / 3 + r * 1 / 3
            d = d_values[-1] * 2 / 3 + k * 1 / 3
            k_values.append(k)
            d_values.append(d)
    out["kd_k"] = k_values[: len(out)]
    out["kd_d"] = d_values[: len(out)]

    return out


# ═══════════════════════════════════════════════════════════════════════════════
# 3. 訊號檢查
# ═══════════════════════════════════════════════════════════════════════════════

def check_entry(row: pd.Series, prev_row: pd.Series) -> bool:
    """檢查是否符合全部 5 個進場條件"""
    # 1. 均線多頭排列: close > MA5 > MA20 > MA60
    if not (row["close"] > row["ma5"] > row["ma20"] > row["ma60"]):
        return False

    # 2. 創 20 日新高
    if row["close"] < row["high_20d"]:
        return False

    # 3. 量增 1.5 倍
    if pd.isna(row["vol_avg5"]) or row["vol_avg5"] <= 0:
        return False
    if row["volume"] < row["vol_avg5"] * VOLUME_MULTIPLIER:
        return False

    # 4. KD 黃金交叉 + K 值上升
    if not (row["kd_k"] > row["kd_d"] and row["kd_k"] > prev_row["kd_k"]):
        return False

    # 5. 流動性門檻
    if pd.isna(row["vol_avg20"]) or row["vol_avg20"] < MIN_AVG_VOL_20:
        return False
    if row["close"] < MIN_PRICE:
        return False

    return True


# ═══════════════════════════════════════════════════════════════════════════════
# 4. 回測引擎
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class Position:
    symbol: str
    shares: int
    entry_price: float
    entry_date: pd.Timestamp
    cost: float


@dataclass
class Trade:
    symbol: str
    entry_date: pd.Timestamp
    exit_date: pd.Timestamp
    entry_price: float
    exit_price: float
    shares: int
    pnl: float
    pnl_pct: float
    reason: str
    hold_days: int


@dataclass
class BacktestEngine:
    capital: float = INITIAL_CAPITAL
    positions: dict[str, Position] = field(default_factory=dict)
    trades: list[Trade] = field(default_factory=list)
    equity_curve: list[dict] = field(default_factory=list)

    def buy(self, symbol: str, price: float, date: pd.Timestamp, alloc: float) -> bool:
        """買入（含手續費 + 滑價）"""
        actual_price = price * (1 + BROKER_FEE * BROKER_DISCOUNT + SLIPPAGE)
        shares = int(alloc / actual_price / 1000) * 1000  # 整張（1000股）
        if shares <= 0:
            return False
        total_cost = shares * actual_price
        if total_cost > self.capital:
            shares = int(self.capital / actual_price / 1000) * 1000
            if shares <= 0:
                return False
            total_cost = shares * actual_price

        self.capital -= total_cost
        self.positions[symbol] = Position(
            symbol=symbol,
            shares=shares,
            entry_price=price,
            entry_date=date,
            cost=total_cost,
        )
        return True

    def sell(self, symbol: str, price: float, date: pd.Timestamp, reason: str) -> None:
        """賣出（含手續費 + 交易稅 + 滑價）"""
        pos = self.positions[symbol]
        actual_price = price * (1 - BROKER_FEE * BROKER_DISCOUNT - TAX_RATE - SLIPPAGE)
        revenue = pos.shares * actual_price
        pnl = revenue - pos.cost
        pnl_pct = pnl / pos.cost * 100

        hold_days = (date - pos.entry_date).days

        self.capital += revenue
        self.trades.append(Trade(
            symbol=symbol,
            entry_date=pos.entry_date,
            exit_date=date,
            entry_price=pos.entry_price,
            exit_price=price,
            shares=pos.shares,
            pnl=pnl,
            pnl_pct=pnl_pct,
            reason=reason,
            hold_days=hold_days,
        ))
        del self.positions[symbol]

    def total_equity(self, prices: dict[str, float]) -> float:
        """計算當前總權益"""
        holdings = sum(
            pos.shares * prices.get(sym, pos.entry_price)
            for sym, pos in self.positions.items()
        )
        return self.capital + holdings


def get_institutional_score(
    inst_data: dict[str, pd.DataFrame],
    symbol: str,
    date: pd.Timestamp,
) -> float:
    """計算近 5 日法人淨買超金額（用於排序）"""
    if symbol not in inst_data:
        return 0.0
    df = inst_data[symbol]
    cutoff = date - pd.Timedelta(days=7)
    recent = df[(df["date"] >= cutoff) & (df["date"] <= date)]
    if recent.empty:
        return 0.0
    return float(recent["buy"].sum() - recent["sell"].sum())


def run_backtest(
    stock_data: dict[str, pd.DataFrame],
    inst_data: dict[str, pd.DataFrame],
    start_date: str,
    end_date: str,
) -> BacktestEngine:
    """執行回測主循環"""
    bt = BacktestEngine()

    # 取得所有交易日
    all_dates: set[pd.Timestamp] = set()
    for df in stock_data.values():
        mask = (df["date"] >= pd.Timestamp(start_date)) & (df["date"] <= pd.Timestamp(end_date))
        all_dates.update(df.loc[mask, "date"].tolist())
    trading_dates = sorted(all_dates)

    print(f"\n🔄 回測中... ({start_date} ~ {end_date}, {len(trading_dates)} 個交易日)")

    for date in trading_dates:
        current_prices: dict[str, float] = {}

        # ── 步驟 1：收集當日價格 ──
        for sym, df in stock_data.items():
            today = df[df["date"] == date]
            if not today.empty:
                current_prices[sym] = float(today.iloc[0]["close"])

        # ── 步驟 2：檢查持倉出場條件 ──
        for sym in list(bt.positions.keys()):
            if sym not in stock_data:
                continue
            df = stock_data[sym]
            today = df[df["date"] == date]
            if today.empty:
                continue
            row = today.iloc[0]
            pos = bt.positions[sym]

            current_return = (row["close"] - pos.entry_price) / pos.entry_price
            hold_days = (date - pos.entry_date).days

            # 出場優先順序
            if current_return >= TAKE_PROFIT:
                bt.sell(sym, row["close"], date, "take_profit_15pct")
            elif current_return <= STOP_LOSS:
                bt.sell(sym, row["close"], date, "stop_loss_7pct")
            elif not pd.isna(row["ma20"]) and row["close"] < row["ma20"]:
                bt.sell(sym, row["close"], date, "below_ma20")
            elif hold_days >= TIME_STOP_DAYS:
                bt.sell(sym, row["close"], date, "time_stop_20d")

        # ── 步驟 3：掃描新進場訊號 ──
        if len(bt.positions) < MAX_POSITIONS:
            candidates: list[dict[str, Any]] = []

            for sym, df in stock_data.items():
                if sym in bt.positions:
                    continue
                today_mask = df["date"] == date
                if not today_mask.any():
                    continue
                idx = df.index[today_mask][0]
                if idx < 1:
                    continue

                row = df.iloc[idx]
                prev_row = df.iloc[idx - 1]

                # 確保指標已就緒
                if pd.isna(row["ma60"]) or pd.isna(row["high_20d"]):
                    continue

                if check_entry(row, prev_row):
                    inst_score = get_institutional_score(inst_data, sym, date)
                    candidates.append({
                        "symbol": sym,
                        "close": float(row["close"]),
                        "inst_score": inst_score,
                        # 用隔日開盤買入：這裡用 next-day open 模擬
                        "next_idx": idx + 1,
                    })

            # 按法人買超排序
            candidates.sort(key=lambda x: x["inst_score"], reverse=True)

            slots = MAX_POSITIONS - len(bt.positions)
            total_eq = bt.total_equity(current_prices)
            alloc_per = total_eq / MAX_POSITIONS

            for cand in candidates[:slots]:
                sym = cand["symbol"]
                df = stock_data[sym]
                next_idx = cand["next_idx"]

                # 用隔日開盤價買入
                if next_idx < len(df):
                    next_row = df.iloc[next_idx]
                    buy_price = float(next_row["open"])
                    buy_date = next_row["date"]
                    if buy_price > 0:
                        bt.buy(sym, buy_price, buy_date, alloc_per)
                else:
                    # 無隔日資料，用當日收盤
                    bt.buy(sym, cand["close"], date, alloc_per)

        # ── 步驟 4：記錄權益曲線 ──
        bt.equity_curve.append({
            "date": date,
            "equity": bt.total_equity(current_prices),
        })

    # 結束時強制平倉
    for sym in list(bt.positions.keys()):
        if sym in current_prices:
            bt.sell(sym, current_prices[sym], trading_dates[-1], "backtest_end")

    return bt


# ═══════════════════════════════════════════════════════════════════════════════
# 5. 績效報告
# ═══════════════════════════════════════════════════════════════════════════════

def performance_report(bt: BacktestEngine, show_plot: bool = True) -> None:
    """輸出完整績效報告"""
    trades_df = pd.DataFrame([
        {
            "symbol": t.symbol,
            "entry_date": t.entry_date,
            "exit_date": t.exit_date,
            "entry_price": t.entry_price,
            "exit_price": t.exit_price,
            "shares": t.shares,
            "pnl": t.pnl,
            "pnl_pct": t.pnl_pct,
            "reason": t.reason,
            "hold_days": t.hold_days,
        }
        for t in bt.trades
    ])
    equity_df = pd.DataFrame(bt.equity_curve)

    if trades_df.empty:
        print("\n❌ 無任何交易產生")
        return

    total_trades = len(trades_df)
    winning = trades_df[trades_df["pnl"] > 0]
    losing = trades_df[trades_df["pnl"] <= 0]

    win_rate = len(winning) / total_trades * 100
    avg_win = winning["pnl_pct"].mean() if not winning.empty else 0
    avg_loss = losing["pnl_pct"].mean() if not losing.empty else 0
    payoff_ratio = abs(avg_win / avg_loss) if avg_loss != 0 else float("inf")

    # 總報酬
    final_equity = equity_df["equity"].iloc[-1]
    total_return = (final_equity / INITIAL_CAPITAL - 1) * 100

    # 最大回撤
    equity_df["peak"] = equity_df["equity"].cummax()
    equity_df["drawdown"] = (equity_df["equity"] - equity_df["peak"]) / equity_df["peak"] * 100
    max_dd = equity_df["drawdown"].min()

    # 年化報酬
    days = (equity_df["date"].iloc[-1] - equity_df["date"].iloc[0]).days
    ann_return = ((final_equity / INITIAL_CAPITAL) ** (365 / max(days, 1)) - 1) * 100 if days > 0 else 0

    # Sharpe（簡化）
    if len(trades_df) > 1:
        std_ret = trades_df["pnl_pct"].std()
        sharpe = trades_df["pnl_pct"].mean() / std_ret if std_ret > 0 else 0
    else:
        sharpe = 0

    # 獲利因子
    total_gain = winning["pnl"].sum() if not winning.empty else 0
    total_loss_abs = abs(losing["pnl"].sum()) if not losing.empty else 0
    profit_factor = total_gain / total_loss_abs if total_loss_abs > 0 else float("inf")

    # 期望值
    expectancy = (win_rate / 100) * avg_win - (1 - win_rate / 100) * abs(avg_loss)

    print("\n" + "=" * 65)
    print("  台股大師共識突破選股策略 — 回測績效報告")
    print("=" * 65)
    print(f"  回測區間：{equity_df['date'].iloc[0].strftime('%Y-%m-%d')} ~ {equity_df['date'].iloc[-1].strftime('%Y-%m-%d')}")
    print(f"  初始資金：{INITIAL_CAPITAL:>15,.0f} TWD")
    print(f"  期末資金：{final_equity:>15,.0f} TWD")
    print(f"  總報酬率：{total_return:>+14.2f}%")
    print(f"  年化報酬：{ann_return:>+14.2f}%")
    print(f"  最大回撤：{max_dd:>14.2f}%")
    print("-" * 65)
    print(f"  總交易次數：{total_trades:>10}")
    print(f"  勝率：{win_rate:>16.1f}%")
    print(f"  平均獲利：{avg_win:>+14.2f}%")
    print(f"  平均虧損：{avg_loss:>+14.2f}%")
    print(f"  盈虧比：{payoff_ratio:>16.2f}")
    print(f"  獲利因子：{profit_factor:>14.2f}")
    print(f"  期望值：{expectancy:>+16.2f}%")
    print(f"  Sharpe：{sharpe:>16.2f}")
    print(f"  平均持有天數：{trades_df['hold_days'].mean():>8.1f}")

    # ── 出場原因分布 ──
    print("\n  📊 出場原因分布：")
    for reason, count in trades_df["reason"].value_counts().items():
        pct = count / total_trades * 100
        print(f"    {reason:20s}: {count:3d} 次 ({pct:5.1f}%)")

    # ── 每月報酬統計 ──
    trades_df["exit_month"] = trades_df["exit_date"].dt.to_period("M")
    monthly = trades_df.groupby("exit_month").agg(
        trades=("pnl", "count"),
        total_pnl=("pnl", "sum"),
        avg_pnl_pct=("pnl_pct", "mean"),
        win_rate=("pnl", lambda x: (x > 0).mean() * 100),
    )
    print("\n  📅 每月統計：")
    print(f"    {'月份':>10s} | {'筆數':>4s} | {'總損益':>12s} | {'平均%':>8s} | {'勝率':>6s}")
    print("    " + "-" * 52)
    for period, row in monthly.iterrows():
        print(
            f"    {str(period):>10s} | {int(row['trades']):>4d} | "
            f"{row['total_pnl']:>+12,.0f} | {row['avg_pnl_pct']:>+7.2f}% | {row['win_rate']:>5.1f}%"
        )

    # ── 獲利最多的前 10 筆 ──
    print("\n  🏆 獲利最多前 10 筆：")
    top_wins = trades_df.nlargest(10, "pnl_pct")
    for _, t in top_wins.iterrows():
        print(
            f"    {t['symbol']:>6s}  {t['entry_date'].strftime('%m/%d')}→{t['exit_date'].strftime('%m/%d')}  "
            f"{t['pnl_pct']:>+7.2f}%  PnL {t['pnl']:>+10,.0f}"
        )

    # ── 虧損最大前 10 筆 ──
    print("\n  💀 虧損最大前 10 筆：")
    top_losses = trades_df.nsmallest(10, "pnl_pct")
    for _, t in top_losses.iterrows():
        print(
            f"    {t['symbol']:>6s}  {t['entry_date'].strftime('%m/%d')}→{t['exit_date'].strftime('%m/%d')}  "
            f"{t['pnl_pct']:>+7.2f}%  PnL {t['pnl']:>+10,.0f}"
        )

    # ── 持倉天數分布 ──
    print("\n  📈 持倉天數分布：")
    bins = [0, 5, 10, 15, 20, 999]
    labels = ["1-5天", "6-10天", "11-15天", "16-20天", ">20天"]
    trades_df["hold_bin"] = pd.cut(trades_df["hold_days"], bins=bins, labels=labels)
    for label in labels:
        count = (trades_df["hold_bin"] == label).sum()
        if count > 0:
            sub = trades_df[trades_df["hold_bin"] == label]
            avg_ret = sub["pnl_pct"].mean()
            print(f"    {label:>8s}: {count:3d} 筆  平均報酬 {avg_ret:>+7.2f}%")

    print("=" * 65)

    # ── 繪製權益曲線 ──
    if show_plot:
        try:
            import matplotlib

            matplotlib.use("Agg")
            import matplotlib.pyplot as plt

            fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 8), gridspec_kw={"height_ratios": [3, 1]})

            ax1.plot(equity_df["date"], equity_df["equity"], "b-", linewidth=1.5)
            ax1.axhline(y=INITIAL_CAPITAL, color="gray", linestyle="--", alpha=0.5)
            ax1.set_title("Equity Curve — Master Consensus Breakout Strategy", fontsize=14)
            ax1.set_ylabel("Equity (TWD)")
            ax1.grid(True, alpha=0.3)
            ax1.ticklabel_format(style="plain", axis="y")

            ax2.fill_between(equity_df["date"], equity_df["drawdown"], 0, color="red", alpha=0.3)
            ax2.set_ylabel("Drawdown (%)")
            ax2.set_xlabel("Date")
            ax2.grid(True, alpha=0.3)

            plt.tight_layout()
            chart_path = DATA_DIR / "consensus_equity_curve.png"
            plt.savefig(chart_path, dpi=150)
            print(f"\n  📊 權益曲線已儲存: {chart_path}")
            plt.close()
        except ImportError:
            print("\n  ⚠ matplotlib 未安裝，跳過圖表")


# ═══════════════════════════════════════════════════════════════════════════════
# 6. 主程式
# ═══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="台股大師共識突破選股策略回測")
    parser.add_argument("--universe", choices=["tw50", "full"], default="tw50", help="股票池 (default: tw50)")
    parser.add_argument("--force-download", action="store_true", help="強制重新下載資料")
    parser.add_argument("--no-plot", action="store_true", help="不產生圖表")
    parser.add_argument("--no-institutional", action="store_true", help="跳過法人資料下載")
    args = parser.parse_args()

    print("=" * 65)
    print("  台股大師共識突破選股策略 — 回測系統")
    print("  朱家泓 × 權證小哥 × 蔡森 共識因子")
    print("=" * 65)
    print(f"  股票池：{'台灣50' if args.universe == 'tw50' else '全市場'}")
    print(f"  回測區間：{BACKTEST_START} ~ {BACKTEST_END}")
    print(f"  初始資金：{INITIAL_CAPITAL:,} TWD")
    print(f"  策略：MA多頭({MA_SHORT}/{MA_MID}/{MA_LONG}) + {BREAKOUT_WINDOW}日突破 + 量增{VOLUME_MULTIPLIER}x + KD黃金交叉")
    print(f"  出場：停利{TAKE_PROFIT:.0%} / 停損{STOP_LOSS:.0%} / 跌破MA20 / {TIME_STOP_DAYS}天")
    print()

    # ── 決定股票池 ──
    if args.universe == "full":
        print("📋 取得全市場股票清單...")
        symbols = get_full_stock_list()
        cache_suffix = "full"
    else:
        symbols = TW50_SYMBOLS
        cache_suffix = "tw50"

    # ── 下載股價資料 ──
    price_cache = CACHE_DIR / f"prices_{cache_suffix}.pkl"
    stock_data = download_stock_data(
        symbols, DATA_START, BACKTEST_END, price_cache, force=args.force_download
    )

    # ── 計算指標 ──
    print("\n📐 計算技術指標...")
    for sym in list(stock_data.keys()):
        stock_data[sym] = compute_indicators(stock_data[sym])
    print(f"  ✅ {len(stock_data)} 檔完成")

    # ── 下載法人資料（可選）──
    inst_data: dict[str, pd.DataFrame] = {}
    if not args.no_institutional:
        inst_cache = CACHE_DIR / f"inst_{cache_suffix}.pkl"
        inst_data = download_institutional_data(
            list(stock_data.keys()), BACKTEST_START, BACKTEST_END, inst_cache, force=args.force_download
        )

    # ── 執行回測 ──
    bt = run_backtest(stock_data, inst_data, BACKTEST_START, BACKTEST_END)

    # ── 輸出報告 ──
    performance_report(bt, show_plot=not args.no_plot)


if __name__ == "__main__":
    main()
