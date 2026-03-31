#!/usr/bin/env python3
"""
5日爆發動能策略 — 短線爆發回測

核心邏輯：布林壓縮→爆發 + 天量 + 強勢紅K = 短線噴出
目標：5天內賺10%

進場：BB壓縮釋放 + 量爆3倍 + 大紅K + 趨勢支撐 + RSI加速區
出場：停利10% / 停損-5% / 追蹤停利3% / 時間停損5天

Usage:
  python scripts/tw_explosive_5day.py
  python scripts/tw_explosive_5day.py --universe full
  python scripts/tw_explosive_5day.py --force-download
"""

from __future__ import annotations

import argparse
import os
import pickle
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

# ─── 路徑 ──────────────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
CACHE_DIR = DATA_DIR / "cache" / "explosive"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ─── 策略參數 ──────────────────────────────────────────────────────────────────
# 進場
BB_PERIOD = 20
BB_STD = 2.0
BB_SQUEEZE_LOOKBACK = 5         # 近5日內曾出現BB壓縮
BB_EXPANSION_RATIO = 1.2        # 頻寬擴張1.2倍才算釋放
VOLUME_EXPLOSION = 2.0          # 量爆2倍（20日均量）
MIN_BODY_PCT = 0.015            # 紅K實體 ≥ 1.5%
MIN_CLOSE_POSITION = 0.70       # 收盤在日內振幅頂部70%
RSI_PERIOD = 14
RSI_LOW = 40                    # RSI 加速區下限
RSI_HIGH = 75                   # RSI 加速區上限
MIN_AVG_VOL_20 = 200_000       # 流動性（股）
MIN_PRICE = 10.0

# 出場
TAKE_PROFIT = 0.10              # 停利 10%
STOP_LOSS = -0.05               # 停損 -5%
TRAILING_ACTIVATION = 0.05      # 獲利5%後啟動追蹤停利
TRAILING_STOP_PCT = 0.03        # 從最高點回撤3%出場
TIME_STOP_DAYS = 5              # 5個交易日

# 資金
INITIAL_CAPITAL = 1_000_000
MAX_POSITIONS = 3

# 成本
BROKER_FEE = 0.001425
BROKER_DISCOUNT = 0.6
TAX_RATE = 0.003
SLIPPAGE = 0.001

# 回測區間
BACKTEST_START = "2025-03-01"
BACKTEST_END = "2026-03-28"
DATA_START = "2024-10-01"

# ─── TW50 ──────────────────────────────────────────────────────────────────────
TW50_SYMBOLS = [
    "2330", "2317", "2454", "2308", "2382", "2303", "2412", "2891", "2881", "2886",
    "2882", "3711", "2884", "1303", "1301", "2002", "3008", "1216", "2885", "5880",
    "2207", "3034", "2301", "5871", "2357", "6505", "2395", "1101", "2912", "4904",
    "2892", "3037", "2880", "1326", "2887", "4938", "2345", "3231", "5876", "6669",
    "2327", "3045", "2883", "1590", "6446", "2603", "3443", "2474", "8046", "3661",
]


# ═══════════════════════════════════════════════════════════════════════════════
# 1. 資料下載（複用快取機制）
# ═══════════════════════════════════════════════════════════════════════════════

def get_full_stock_list() -> list[str]:
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
            df = dl.taiwan_stock_daily(stock_id=sym, start_date=start_date, end_date=end_date)
            if df is not None and len(df) > 60:
                df = df.rename(columns={"max": "high", "min": "low", "Trading_Volume": "volume"})
                df["date"] = pd.to_datetime(df["date"])
                df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0)
                for col in ("open", "high", "low", "close"):
                    df[col] = pd.to_numeric(df[col], errors="coerce")
                df = df[(df["close"] > 0) & (df["open"] > 0)]
                df = df.dropna(subset=["close"])
                df = df.sort_values("date").reset_index(drop=True)
                all_data[sym] = df[["date", "stock_id", "open", "high", "low", "close", "volume"]]
        except Exception as e:
            print(f"  ⚠ {sym}: {e}")
        if (i + 1) % 5 == 0:
            time.sleep(1.2)

    print(f"  ✅ 成功 {len(all_data)}/{total}")
    with open(cache_path, "wb") as f:
        pickle.dump(all_data, f)
    return all_data


# ═══════════════════════════════════════════════════════════════════════════════
# 2. 指標計算
# ═══════════════════════════════════════════════════════════════════════════════

def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()

    # MA20
    out["ma20"] = out["close"].rolling(20).mean()

    # 20日新高
    out["high_20d"] = out["close"].rolling(20).max()

    # Bollinger Bands (20, 2σ)
    out["bb_mid"] = out["ma20"]
    bb_std = out["close"].rolling(BB_PERIOD).std()
    out["bb_upper"] = out["bb_mid"] + BB_STD * bb_std
    out["bb_lower"] = out["bb_mid"] - BB_STD * bb_std
    out["bb_bandwidth"] = (out["bb_upper"] - out["bb_lower"]) / out["bb_mid"].replace(0, np.nan)

    # BB 壓縮：近 N 日最低頻寬
    out["bb_bw_min5"] = out["bb_bandwidth"].rolling(BB_SQUEEZE_LOOKBACK).min()
    # BB 壓縮：20日最低頻寬
    out["bb_bw_min20"] = out["bb_bandwidth"].rolling(20).min()

    # RSI (14)
    delta = out["close"].diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = gain.ewm(alpha=1 / RSI_PERIOD, min_periods=RSI_PERIOD, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / RSI_PERIOD, min_periods=RSI_PERIOD, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    out["rsi"] = 100 - (100 / (1 + rs))

    # 成交量均量
    out["vol_avg20"] = out["volume"].rolling(20).mean()

    # K棒特徵
    out["body"] = out["close"] - out["open"]
    out["body_pct"] = out["body"].abs() / out["close"].replace(0, np.nan)
    day_range = out["high"] - out["low"]
    out["close_position"] = (out["close"] - out["low"]) / day_range.replace(0, np.nan)
    out["is_red"] = (out["close"] > out["open"]).astype(int)

    # 量比（今日 / 20日均量）
    out["vol_ratio"] = out["volume"] / out["vol_avg20"].replace(0, np.nan)

    return out


# ═══════════════════════════════════════════════════════════════════════════════
# 3. 進場訊號
# ═══════════════════════════════════════════════════════════════════════════════

def check_entry(row: pd.Series, df: pd.DataFrame, idx: int) -> bool:
    """6 個條件全部滿足才進場"""

    # 1. BB 壓縮→釋放
    #    近5日內有壓縮（頻寬接近20日最低），且當日頻寬擴張 > 1.3倍最低
    if pd.isna(row["bb_bandwidth"]) or pd.isna(row["bb_bw_min5"]):
        return False
    if row["bb_bw_min5"] <= 0:
        return False
    expansion_ratio = row["bb_bandwidth"] / row["bb_bw_min5"]
    if expansion_ratio < BB_EXPANSION_RATIO:
        return False

    # 2. 量爆 3 倍
    if pd.isna(row["vol_ratio"]) or row["vol_ratio"] < VOLUME_EXPLOSION:
        return False

    # 3. 大紅K：實體≥2%，收盤在振幅頂部80%
    if row["is_red"] != 1:
        return False
    if pd.isna(row["body_pct"]) or row["body_pct"] < MIN_BODY_PCT:
        return False
    if pd.isna(row["close_position"]) or row["close_position"] < MIN_CLOSE_POSITION:
        return False

    # 4. 趨勢支撐：收盤 > MA20 且 20日新高
    if pd.isna(row["ma20"]) or row["close"] <= row["ma20"]:
        return False
    if pd.isna(row.get("high_20d")) or row["close"] < row["high_20d"]:
        return False

    # 5. RSI 加速區 (40-75)
    if pd.isna(row["rsi"]) or not (RSI_LOW <= row["rsi"] <= RSI_HIGH):
        return False

    # 6. 流動性門檻
    if pd.isna(row["vol_avg20"]) or row["vol_avg20"] < MIN_AVG_VOL_20:
        return False
    if row["close"] < MIN_PRICE:
        return False

    return True


# ═══════════════════════════════════════════════════════════════════════════════
# 4. 回測引擎（含追蹤停利）
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class Position:
    symbol: str
    shares: int
    entry_price: float
    entry_date: pd.Timestamp
    cost: float
    peak_price: float  # 追蹤用


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
        actual_price = price * (1 + BROKER_FEE * BROKER_DISCOUNT + SLIPPAGE)
        shares = int(alloc / actual_price / 1000) * 1000
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
            symbol=symbol, shares=shares, entry_price=price,
            entry_date=date, cost=total_cost, peak_price=price,
        )
        return True

    def sell(self, symbol: str, price: float, date: pd.Timestamp, reason: str) -> None:
        pos = self.positions[symbol]
        actual_price = price * (1 - BROKER_FEE * BROKER_DISCOUNT - TAX_RATE - SLIPPAGE)
        revenue = pos.shares * actual_price
        pnl = revenue - pos.cost
        pnl_pct = pnl / pos.cost * 100
        hold_days = (date - pos.entry_date).days
        self.capital += revenue
        self.trades.append(Trade(
            symbol=symbol, entry_date=pos.entry_date, exit_date=date,
            entry_price=pos.entry_price, exit_price=price,
            shares=pos.shares, pnl=pnl, pnl_pct=pnl_pct,
            reason=reason, hold_days=hold_days,
        ))
        del self.positions[symbol]

    def total_equity(self, prices: dict[str, float]) -> float:
        holdings = sum(
            pos.shares * prices.get(sym, pos.entry_price)
            for sym, pos in self.positions.items()
        )
        return self.capital + holdings


def run_backtest(stock_data: dict[str, pd.DataFrame], start_date: str, end_date: str) -> BacktestEngine:
    bt = BacktestEngine()

    all_dates: set[pd.Timestamp] = set()
    for df in stock_data.values():
        mask = (df["date"] >= pd.Timestamp(start_date)) & (df["date"] <= pd.Timestamp(end_date))
        all_dates.update(df.loc[mask, "date"].tolist())
    trading_dates = sorted(all_dates)

    print(f"\n🔄 回測中... ({start_date} ~ {end_date}, {len(trading_dates)} 交易日)")

    for date in trading_dates:
        current_prices: dict[str, float] = {}
        for sym, df in stock_data.items():
            today = df[df["date"] == date]
            if not today.empty:
                current_prices[sym] = float(today.iloc[0]["close"])

        # ── 出場檢查 ──
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

            # 更新峰值
            if row["close"] > pos.peak_price:
                pos.peak_price = row["close"]

            # 出場優先順序
            if current_return >= TAKE_PROFIT:
                bt.sell(sym, row["close"], date, "take_profit_10pct")
            elif current_return <= STOP_LOSS:
                bt.sell(sym, row["close"], date, "stop_loss_5pct")
            elif current_return >= TRAILING_ACTIVATION:
                # 追蹤停利：從最高點回撤 3%
                drawdown_from_peak = (pos.peak_price - row["close"]) / pos.peak_price
                if drawdown_from_peak >= TRAILING_STOP_PCT:
                    bt.sell(sym, row["close"], date, "trailing_stop_3pct")
            elif hold_days >= TIME_STOP_DAYS:
                bt.sell(sym, row["close"], date, "time_stop_5d")

        # ── 進場掃描 ──
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

                if check_entry(row, df, idx):
                    candidates.append({
                        "symbol": sym,
                        "close": float(row["close"]),
                        "vol_ratio": float(row["vol_ratio"]) if not pd.isna(row["vol_ratio"]) else 0,
                        "next_idx": idx + 1,
                    })

            # 按量比排序（量越大越優先）
            candidates.sort(key=lambda x: x["vol_ratio"], reverse=True)

            slots = MAX_POSITIONS - len(bt.positions)
            total_eq = bt.total_equity(current_prices)
            alloc = total_eq / MAX_POSITIONS

            for cand in candidates[:slots]:
                sym = cand["symbol"]
                df = stock_data[sym]
                next_idx = cand["next_idx"]
                if next_idx < len(df):
                    next_row = df.iloc[next_idx]
                    buy_price = float(next_row["open"])
                    if buy_price > 0:
                        bt.buy(sym, buy_price, next_row["date"], alloc)
                else:
                    bt.buy(sym, cand["close"], date, alloc)

        # 記錄權益
        bt.equity_curve.append({"date": date, "equity": bt.total_equity(current_prices)})

    # 結束平倉
    for sym in list(bt.positions.keys()):
        if sym in current_prices:
            bt.sell(sym, current_prices[sym], trading_dates[-1], "backtest_end")

    return bt


# ═══════════════════════════════════════════════════════════════════════════════
# 5. 績效報告
# ═══════════════════════════════════════════════════════════════════════════════

def performance_report(bt: BacktestEngine, show_plot: bool = True) -> None:
    trades_df = pd.DataFrame([{
        "symbol": t.symbol, "entry_date": t.entry_date, "exit_date": t.exit_date,
        "entry_price": t.entry_price, "exit_price": t.exit_price,
        "shares": t.shares, "pnl": t.pnl, "pnl_pct": t.pnl_pct,
        "reason": t.reason, "hold_days": t.hold_days,
    } for t in bt.trades])
    equity_df = pd.DataFrame(bt.equity_curve)

    if trades_df.empty:
        print("\n❌ 無任何交易")
        return

    total_trades = len(trades_df)
    winning = trades_df[trades_df["pnl"] > 0]
    losing = trades_df[trades_df["pnl"] <= 0]

    win_rate = len(winning) / total_trades * 100
    avg_win = winning["pnl_pct"].mean() if not winning.empty else 0
    avg_loss = losing["pnl_pct"].mean() if not losing.empty else 0
    payoff_ratio = abs(avg_win / avg_loss) if avg_loss != 0 else float("inf")

    final_equity = equity_df["equity"].iloc[-1]
    total_return = (final_equity / INITIAL_CAPITAL - 1) * 100

    equity_df["peak"] = equity_df["equity"].cummax()
    equity_df["drawdown"] = (equity_df["equity"] - equity_df["peak"]) / equity_df["peak"] * 100
    max_dd = equity_df["drawdown"].min()

    days = (equity_df["date"].iloc[-1] - equity_df["date"].iloc[0]).days
    ann_return = ((final_equity / INITIAL_CAPITAL) ** (365 / max(days, 1)) - 1) * 100

    total_gain = winning["pnl"].sum() if not winning.empty else 0
    total_loss_abs = abs(losing["pnl"].sum()) if not losing.empty else 0
    profit_factor = total_gain / total_loss_abs if total_loss_abs > 0 else float("inf")

    # 10%+ 爆擊率
    big_winners = trades_df[trades_df["pnl_pct"] >= 10]
    big_winner_rate = len(big_winners) / total_trades * 100

    print("\n" + "=" * 65)
    print("  🚀 5日爆發動能策略 — 回測績效報告")
    print("=" * 65)
    print(f"  回測區間：{equity_df['date'].iloc[0].strftime('%Y-%m-%d')} ~ {equity_df['date'].iloc[-1].strftime('%Y-%m-%d')}")
    print(f"  初始資金：{INITIAL_CAPITAL:>15,} TWD")
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
    print(f"  平均持有天數：{trades_df['hold_days'].mean():>8.1f}")
    print("-" * 65)
    print(f"  💥 10%+爆擊次數：{len(big_winners):>6} / {total_trades} ({big_winner_rate:.1f}%)")

    # 出場原因
    print("\n  📊 出場原因：")
    for reason, count in trades_df["reason"].value_counts().items():
        pct = count / total_trades * 100
        avg_ret = trades_df[trades_df["reason"] == reason]["pnl_pct"].mean()
        print(f"    {reason:22s}: {count:3d} 次 ({pct:5.1f}%)  平均 {avg_ret:>+7.2f}%")

    # 每月
    trades_df["exit_month"] = trades_df["exit_date"].dt.to_period("M")
    monthly = trades_df.groupby("exit_month").agg(
        trades=("pnl", "count"), total_pnl=("pnl", "sum"),
        avg_pnl_pct=("pnl_pct", "mean"), win_rate=("pnl", lambda x: (x > 0).mean() * 100),
    )
    print("\n  📅 每月統計：")
    print(f"    {'月份':>10s} | {'筆數':>4s} | {'總損益':>12s} | {'平均%':>8s} | {'勝率':>6s}")
    print("    " + "-" * 52)
    for period, row in monthly.iterrows():
        print(f"    {str(period):>10s} | {int(row['trades']):>4d} | "
              f"{row['total_pnl']:>+12,.0f} | {row['avg_pnl_pct']:>+7.2f}% | {row['win_rate']:>5.1f}%")

    # Top winners
    print("\n  🏆 最佳交易：")
    for _, t in trades_df.nlargest(min(10, len(trades_df)), "pnl_pct").iterrows():
        print(f"    {t['symbol']:>6s}  {t['entry_date'].strftime('%m/%d')}→{t['exit_date'].strftime('%m/%d')}  "
              f"{t['pnl_pct']:>+7.2f}%  {t['hold_days']}天  {t['reason']}")

    # Top losers
    print("\n  💀 最差交易：")
    for _, t in trades_df.nsmallest(min(10, len(trades_df)), "pnl_pct").iterrows():
        print(f"    {t['symbol']:>6s}  {t['entry_date'].strftime('%m/%d')}→{t['exit_date'].strftime('%m/%d')}  "
              f"{t['pnl_pct']:>+7.2f}%  {t['hold_days']}天  {t['reason']}")

    print("=" * 65)

    if show_plot:
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt

            fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 8), gridspec_kw={"height_ratios": [3, 1]})
            ax1.plot(equity_df["date"], equity_df["equity"], "r-", linewidth=1.5)
            ax1.axhline(y=INITIAL_CAPITAL, color="gray", linestyle="--", alpha=0.5)
            ax1.set_title("Equity Curve — 5-Day Explosive Momentum Strategy", fontsize=14)
            ax1.set_ylabel("Equity (TWD)")
            ax1.grid(True, alpha=0.3)
            ax1.ticklabel_format(style="plain", axis="y")

            ax2.fill_between(equity_df["date"], equity_df["drawdown"], 0, color="red", alpha=0.3)
            ax2.set_ylabel("Drawdown (%)")
            ax2.set_xlabel("Date")
            ax2.grid(True, alpha=0.3)

            plt.tight_layout()
            chart_path = DATA_DIR / "explosive_5day_equity.png"
            plt.savefig(chart_path, dpi=150)
            print(f"\n  📊 圖表: {chart_path}")
            plt.close()
        except ImportError:
            print("\n  ⚠ matplotlib 未安裝")


# ═══════════════════════════════════════════════════════════════════════════════
# 6. 主程式
# ═══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="5日爆發動能策略回測")
    parser.add_argument("--universe", choices=["tw50", "full"], default="tw50")
    parser.add_argument("--force-download", action="store_true")
    parser.add_argument("--no-plot", action="store_true")
    args = parser.parse_args()

    print("=" * 65)
    print("  🚀 5日爆發動能策略 — BB壓縮釋放 + 天量 + 強勢紅K")
    print("=" * 65)
    print(f"  股票池：{'台灣50' if args.universe == 'tw50' else '全市場'}")
    print(f"  進場：BB壓縮釋放{BB_EXPANSION_RATIO}x + 量爆{VOLUME_EXPLOSION}x + 紅K≥{MIN_BODY_PCT:.0%} + RSI {RSI_LOW}-{RSI_HIGH}")
    print(f"  出場：停利{TAKE_PROFIT:.0%} / 停損{STOP_LOSS:.0%} / 追蹤{TRAILING_STOP_PCT:.0%} / {TIME_STOP_DAYS}天")
    print(f"  持倉：最多{MAX_POSITIONS}檔，每檔{100//MAX_POSITIONS}%")
    print()

    symbols = get_full_stock_list() if args.universe == "full" else TW50_SYMBOLS
    cache_suffix = "full" if args.universe == "full" else "tw50"

    price_cache = CACHE_DIR / f"prices_{cache_suffix}.pkl"
    stock_data = download_stock_data(symbols, DATA_START, BACKTEST_END, price_cache, force=args.force_download)

    print("\n📐 計算指標 (BB, RSI, 量比)...")
    for sym in list(stock_data.keys()):
        stock_data[sym] = compute_indicators(stock_data[sym])
    print(f"  ✅ {len(stock_data)} 檔")

    bt = run_backtest(stock_data, BACKTEST_START, BACKTEST_END)
    performance_report(bt, show_plot=not args.no_plot)


if __name__ == "__main__":
    main()
