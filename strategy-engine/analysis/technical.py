from __future__ import annotations
"""
技術分析模組 — 向量化指標計算
用 pandas 向量化計算，不用 for loop。
"""

import pandas as pd
import numpy as np


def compute_all_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """
    計算所有技術指標，回傳加了指標欄位的 DataFrame。

    Input columns: date, open, high, low, close, volume
    Output: 原始欄位 + ma5, ma10, ma20, ma60, macd, signal, osc, k, d, rsi14, vol_avg5, vol_avg20
    """
    out = df.copy()

    # ── 均線 ──────────────────────────────────────────────────────────────
    out["ma5"]  = out["close"].rolling(5).mean()
    out["ma10"] = out["close"].rolling(10).mean()
    out["ma20"] = out["close"].rolling(20).mean()
    out["ma60"] = out["close"].rolling(60).mean()

    # ── MACD (12, 26, 9) ─────────────────────────────────────────────────
    ema12 = out["close"].ewm(span=12, adjust=False).mean()
    ema26 = out["close"].ewm(span=26, adjust=False).mean()
    out["macd_dif"]    = ema12 - ema26
    out["macd_signal"] = out["macd_dif"].ewm(span=9, adjust=False).mean()
    out["macd_osc"]    = out["macd_dif"] - out["macd_signal"]

    # ── KD (9, 3, 3) ─────────────────────────────────────────────────────
    low9  = out["low"].rolling(9).min()
    high9 = out["high"].rolling(9).max()
    rsv   = (out["close"] - low9) / (high9 - low9).replace(0, np.nan) * 100

    k_values = [50.0]  # 初始 K=50
    d_values = [50.0]  # 初始 D=50
    for i in range(1, len(rsv)):
        r = rsv.iloc[i]
        if pd.isna(r):
            k_values.append(k_values[-1])
            d_values.append(d_values[-1])
        else:
            k = k_values[-1] * 2/3 + r * 1/3
            d = d_values[-1] * 2/3 + k * 1/3
            k_values.append(k)
            d_values.append(d)
    out["kd_k"] = k_values
    out["kd_d"] = d_values

    # ── RSI (14) ──────────────────────────────────────────────────────────
    delta = out["close"].diff()
    gain  = delta.clip(lower=0)
    loss  = (-delta).clip(lower=0)
    avg_gain = gain.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    out["rsi14"] = 100 - (100 / (1 + rs))

    # ── 成交量均量 ────────────────────────────────────────────────────────
    out["vol_avg5"]  = out["volume"].rolling(5).mean()
    out["vol_avg20"] = out["volume"].rolling(20).mean()

    # ── K 棒實體比例 ──────────────────────────────────────────────────────
    body = (out["close"] - out["open"]).abs()
    total_range = (out["high"] - out["low"]).replace(0, np.nan)
    out["body_pct"] = body / out["close"].shift(1).replace(0, np.nan)  # 實體佔前日收盤的比例
    out["is_red"]   = (out["close"] > out["open"]).astype(int)

    # ── ATR (14) — 波動率 ──────────────────────────────────────────────
    tr = pd.concat([
        out["high"] - out["low"],
        (out["high"] - out["close"].shift(1)).abs(),
        (out["low"] - out["close"].shift(1)).abs(),
    ], axis=1).max(axis=1)
    out["atr14"] = tr.rolling(14).mean()

    # ── OBV (On-Balance Volume) — 籌碼流向代理 ──────────────────────────
    direction = np.where(out["close"] > out["close"].shift(1), 1,
                np.where(out["close"] < out["close"].shift(1), -1, 0))
    out["obv"] = (out["volume"] * direction).cumsum()
    out["obv_ma20"] = out["obv"].rolling(20).mean()

    # ── 波動率百分位 (120 日) ─────────────────────────────────────────────
    out["atr_pct"] = out["atr14"].rolling(120).rank(pct=True) * 100

    # ── 週線 MA10 (≈ 日線 MA50) 簡化版 ──────────────────────────────────
    out["ma50"] = out["close"].rolling(50).mean()

    return out


def evaluate_conditions(df: pd.DataFrame, conditions: list[dict], params: dict) -> pd.DataFrame:
    """
    向量化評估進場條件。
    回傳 DataFrame，每個條件一個 bool 欄位，加上 total_score 欄位。

    Parameters:
        df: 已計算指標的 DataFrame
        conditions: 策略的 entry_conditions 列表
        params: 策略的 parameters dict

    Returns:
        DataFrame with columns: [cond_{id} for each condition] + [total_score]
    """
    result = pd.DataFrame(index=df.index)

    for cond in conditions:
        cid = cond["id"]
        ctype = cond["type"]
        cp = cond.get("params", {})

        if ctype == "ma_crossover":
            fast = df[f"ma{cp.get('fast', params.get('ma_fast', 5))}"]
            slow = df[f"ma{cp.get('slow', params.get('ma_slow', 20))}"]
            result[f"cond_{cid}"] = (fast > slow)

        elif ctype == "price_above_ma":
            period = cp.get("ma_period", params.get("ma_long", 60))
            result[f"cond_{cid}"] = (df["close"] > df[f"ma{period}"])

        elif ctype == "bullish_candle":
            min_body = cp.get("min_body_pct", params.get("kbar_min_body_pct", 0.02))
            result[f"cond_{cid}"] = (df["is_red"] == 1) & (df["body_pct"] >= min_body)

        elif ctype == "ma_alignment":
            periods = cp.get("periods", [5, 10, 20])
            cols = [f"ma{p}" for p in sorted(periods)]
            # MA5 > MA10 > MA20
            aligned = pd.Series(True, index=df.index)
            for i in range(len(cols) - 1):
                aligned = aligned & (df[cols[i]] > df[cols[i + 1]])
            result[f"cond_{cid}"] = aligned

        elif ctype == "volume_surge":
            avg_period = cp.get("avg_period", params.get("volume_avg_period", 5))
            multiplier = cp.get("multiplier", params.get("volume_multiplier", 1.5))
            vol_avg = df["volume"].rolling(avg_period).mean()
            result[f"cond_{cid}"] = (df["volume"] > vol_avg * multiplier)

        elif ctype == "indicator_confirm":
            macd_ok = (df["macd_osc"] > 0) if cp.get("macd_positive", True) else pd.Series(True, index=df.index)
            kd_ok = (df["kd_k"] > df["kd_d"]) if cp.get("kd_golden_cross", True) else pd.Series(True, index=df.index)
            logic = cp.get("logic", "or")
            if logic == "or":
                result[f"cond_{cid}"] = macd_ok | kd_ok
            else:
                result[f"cond_{cid}"] = macd_ok & kd_ok

        elif ctype == "obv_trend":
            # OBV 趨勢：OBV 在其 MA20 之上 = 資金持續流入
            result[f"cond_{cid}"] = (df["obv"] > df["obv_ma20"])

        elif ctype == "low_volatility_breakout":
            # 低波動突破：ATR 百分位 < 30 且價格突破 MA20
            threshold = cp.get("atr_pct_max", 30)
            result[f"cond_{cid}"] = (df["atr_pct"] < threshold) & (df["close"] > df["ma20"])

        elif ctype == "weekly_trend_confirm":
            # 週線趨勢確認（簡化版）：價格 > MA50 且 MA50 上升
            result[f"cond_{cid}"] = (df["close"] > df["ma50"]) & (df["ma50"] > df["ma50"].shift(5))

        elif ctype == "rsi_neutral_zone":
            # RSI 中性區間：不超買不超賣（40-70 = 健康趨勢中的進場）
            low = cp.get("rsi_low", 40)
            high = cp.get("rsi_high", 70)
            result[f"cond_{cid}"] = (df["rsi14"] >= low) & (df["rsi14"] <= high)

        elif ctype == "rsi_rising":
            # RSI 上升趨勢：近 N 日 RSI 在上升
            lookback = cp.get("lookback", 3)
            result[f"cond_{cid}"] = df["rsi14"] > df["rsi14"].shift(lookback)

        elif ctype == "macd_accelerating":
            # MACD 柱加速：OSC 為正且增加中
            result[f"cond_{cid}"] = (df["macd_osc"] > 0) & (df["macd_osc"] > df["macd_osc"].shift(1))

        elif ctype == "ma_slope_positive":
            # 均線斜率為正：MA 在上升
            period = cp.get("period", 20)
            ma_col = f"ma{period}"
            if ma_col in df.columns:
                result[f"cond_{cid}"] = df[ma_col] > df[ma_col].shift(5)
            else:
                result[f"cond_{cid}"] = False

        elif ctype == "volume_dry_up":
            # 量縮：成交量低於均量的 threshold 倍（盤整蓄勢）
            threshold = cp.get("threshold", 0.7)
            result[f"cond_{cid}"] = df["volume"] < df["vol_avg20"] * threshold

        else:
            # 未知條件類型，預設 False
            result[f"cond_{cid}"] = False

    # 計算總分（滿足幾個條件）
    cond_cols = [c for c in result.columns if c.startswith("cond_")]
    result["total_score"] = result[cond_cols].sum(axis=1)

    return result
