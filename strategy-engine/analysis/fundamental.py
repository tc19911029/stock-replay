from __future__ import annotations
"""
基本面分析模組 — 營收成長、EPS、毛利率等
A 股用 AKShare，台股用 FinMind。
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

CACHE_DIR = Path(__file__).parent.parent / "data" / "cache" / "fundamental"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _cache_path(symbol: str, market: str) -> Path:
    return CACHE_DIR / f"{market}_{symbol}.json"


def _is_fresh(path: Path, hours: int = 72) -> bool:
    if not path.exists():
        return False
    return (datetime.now() - datetime.fromtimestamp(path.stat().st_mtime)) < timedelta(hours=hours)


# ═══════════════════════════════════════════════════════════════════════════════
# A 股基本面（AKShare）
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_a_share_fundamental(symbol: str) -> dict[str, Any] | None:
    """抓取單支 A 股基本面數據"""
    cache = _cache_path(symbol, "a")
    if _is_fresh(cache):
        try:
            import json
            return json.loads(cache.read_text(encoding="utf-8"))
        except Exception:
            pass

    try:
        import akshare as ak

        # 財務指標
        df_fin = ak.stock_financial_abstract_ths(symbol=symbol, indicator="按报告期")
        if df_fin is not None and not df_fin.empty:
            latest = df_fin.iloc[0]
            result = {
                "symbol": symbol,
                "market": "a_shares",
                "fetched_at": datetime.now().isoformat(),
                # 營收成長率
                "revenue_growth": _safe_float(latest.get("营业总收入同比增长率")),
                # 淨利成長率
                "profit_growth": _safe_float(latest.get("归母净利润同比增长率")),
                # 毛利率
                "gross_margin": _safe_float(latest.get("毛利率")),
                # 淨利率
                "net_margin": _safe_float(latest.get("净利率")),
                # ROE
                "roe": _safe_float(latest.get("加权净资产收益率")),
                # EPS
                "eps": _safe_float(latest.get("基本每股收益")),
            }

            # 存快取
            import json
            cache.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            return result

    except Exception as e:
        print(f"  ⚠ A 股 {symbol} 基本面抓取失敗：{e}")

    return None


# ═══════════════════════════════════════════════════════════════════════════════
# 台股基本面（FinMind）
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_tw_fundamental(symbol: str) -> dict[str, Any] | None:
    """抓取單支台股基本面數據"""
    cache = _cache_path(symbol, "tw")
    if _is_fresh(cache):
        try:
            import json
            return json.loads(cache.read_text(encoding="utf-8"))
        except Exception:
            pass

    try:
        from FinMind.data import DataLoader
        dl = DataLoader()

        # 月營收
        start = (datetime.now() - timedelta(days=400)).strftime("%Y-%m-%d")
        rev = dl.taiwan_stock_month_revenue(stock_id=symbol, start_date=start)

        revenue_growth = None
        if rev is not None and len(rev) >= 13:
            latest_rev = rev.iloc[-1]["revenue"]
            yoy_rev = rev.iloc[-13]["revenue"]
            if yoy_rev > 0:
                revenue_growth = round((latest_rev - yoy_rev) / yoy_rev * 100, 2)

        # 財報（EPS、毛利率、ROE）
        fin_start = (datetime.now() - timedelta(days=500)).strftime("%Y-%m-%d")
        fin = dl.taiwan_stock_financial_statement(
            stock_id=symbol, start_date=fin_start
        )

        eps = None
        gross_margin = None
        net_margin = None
        roe = None

        if fin is not None and not fin.empty:
            # 取最近一期的數據
            for _, row in fin.iterrows():
                t = row.get("type", "")
                v = _safe_float(row.get("value"))
                if t == "EPS" and v is not None:
                    eps = v
                elif t == "GrossProfit" and v is not None:
                    gross_margin = v

        result = {
            "symbol": symbol,
            "market": "tw_stocks",
            "fetched_at": datetime.now().isoformat(),
            "revenue_growth": revenue_growth,
            "profit_growth": None,  # FinMind 不直接提供
            "gross_margin": gross_margin,
            "net_margin": net_margin,
            "roe": roe,
            "eps": eps,
        }

        import json
        cache.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        return result

    except Exception as e:
        print(f"  ⚠ 台股 {symbol} 基本面抓取失敗：{e}")

    return None


# ═══════════════════════════════════════════════════════════════════════════════
# 批量抓取 + 評分
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_fundamentals(symbols: list[str], market: str) -> dict[str, dict]:
    """批量抓取基本面數據"""
    result = {}
    fetch_fn = fetch_a_share_fundamental if market == "a_shares" else fetch_tw_fundamental

    print(f"  📊 抓取 {market} 基本面數據（{len(symbols)} 支）...")
    success = 0
    for sym in symbols:
        data = fetch_fn(sym)
        if data:
            result[sym] = data
            success += 1

    print(f"  ✅ 基本面：{success}/{len(symbols)} 成功")
    return result


def score_fundamental(data: dict[str, Any] | None) -> float:
    """
    基本面評分 0-100。

    評分維度：
    - 營收成長率 (30%)：正成長加分，高成長更多
    - 毛利率 (20%)：越高越好
    - ROE (20%)：越高越好
    - EPS (15%)：正值加分
    - 淨利率 (15%)：正值加分
    """
    if not data:
        return 50.0  # 沒數據給中間分

    score = 0.0

    # 營收成長 (30%)
    rg = data.get("revenue_growth")
    if rg is not None:
        if rg > 30:
            score += 30
        elif rg > 15:
            score += 25
        elif rg > 5:
            score += 20
        elif rg > 0:
            score += 15
        elif rg > -10:
            score += 8
        else:
            score += 0
    else:
        score += 15  # 沒數據給中間

    # 毛利率 (20%)
    gm = data.get("gross_margin")
    if gm is not None:
        if gm > 50:
            score += 20
        elif gm > 30:
            score += 16
        elif gm > 15:
            score += 12
        elif gm > 0:
            score += 8
        else:
            score += 0
    else:
        score += 10

    # ROE (20%)
    roe = data.get("roe")
    if roe is not None:
        if roe > 20:
            score += 20
        elif roe > 15:
            score += 16
        elif roe > 10:
            score += 12
        elif roe > 5:
            score += 8
        else:
            score += 4
    else:
        score += 10

    # EPS (15%)
    eps = data.get("eps")
    if eps is not None:
        if eps > 5:
            score += 15
        elif eps > 2:
            score += 12
        elif eps > 0.5:
            score += 8
        elif eps > 0:
            score += 5
        else:
            score += 0
    else:
        score += 7

    # 淨利率 (15%)
    nm = data.get("net_margin")
    if nm is not None:
        if nm > 20:
            score += 15
        elif nm > 10:
            score += 12
        elif nm > 5:
            score += 8
        elif nm > 0:
            score += 5
        else:
            score += 0
    else:
        score += 7

    return round(score, 1)


def score_fundamental_detailed(data: dict[str, Any] | None) -> dict:
    """
    詳細基本面評分，含營收驚喜偵測。

    台股特色：月營收公開，營收年增率連續加速 = 「營收驚喜」。
    A 股特色：單季淨利年增率 + ROE 趨勢。

    Returns:
        dict: total_score, revenue_surprise, signals
    """
    base_score = score_fundamental(data)
    result = {
        "total_score": base_score,
        "revenue_surprise": False,
        "revenue_acceleration": False,
        "high_roe_grower": False,
        "signals": [],
    }

    if not data:
        return result

    rg = data.get("revenue_growth")
    roe = data.get("roe")
    eps = data.get("eps")

    # ── 營收驚喜偵測 ──────────────────────────────────────────────────────
    # Revenue growth > 20% AND positive = surprise
    if rg is not None and rg > 20:
        result["revenue_surprise"] = True
        result["signals"].append(f"營收年增 {rg:.1f}%（驚喜）")
        result["total_score"] = min(100, base_score + 10)

    # Revenue acceleration: growth > 30% = strong momentum
    if rg is not None and rg > 30:
        result["revenue_acceleration"] = True
        result["signals"].append(f"營收加速成長 {rg:.1f}%")
        result["total_score"] = min(100, result["total_score"] + 5)

    # ── 高 ROE 成長股 ────────────────────────────────────────────────────
    if roe is not None and roe > 15 and eps is not None and eps > 2:
        result["high_roe_grower"] = True
        result["signals"].append(f"高ROE成長 (ROE={roe:.1f}%, EPS={eps:.1f})")
        result["total_score"] = min(100, result["total_score"] + 5)

    # ── 營收衰退警告 ──────────────────────────────────────────────────────
    if rg is not None and rg < -15:
        result["signals"].append(f"⚠ 營收衰退 {rg:.1f}%")
        result["total_score"] = max(0, result["total_score"] - 10)

    return result


def _safe_float(val) -> float | None:
    """安全轉換為 float"""
    if val is None:
        return None
    try:
        v = float(val)
        return v if not np.isnan(v) else None
    except (ValueError, TypeError):
        return None
