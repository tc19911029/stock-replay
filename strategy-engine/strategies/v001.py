from __future__ import annotations
"""
策略 v001 — 基於前端六大條件的基礎版本

參考前端 lib/analysis/trendAnalysis.ts 的六大進場條件：
1. 趨勢：MA5 > MA20（短期趨勢向上）
2. 位置：收盤價在 MA60 之上（中期趨勢確認）
3. K 棒：紅 K（收盤 > 開盤），實體 ≥ 2%
4. 均線：MA5 > MA10 > MA20（多頭排列）
5. 量能：成交量 > 5 日均量 × 1.5
6. 指標：MACD 柱狀體 > 0（紅柱）或 KD 金叉（K > D）

出場：固定持有 5 個交易日
"""

from strategies.base import StrategyConfig


def create_v001() -> StrategyConfig:
    """建立 v001 策略"""
    return StrategyConfig(
        version="v001",
        name="六大條件基礎版",
        entry_conditions=[
            {
                "id": "trend",
                "name": "趨勢",
                "description": "MA5 > MA20（短期趨勢向上）",
                "type": "ma_crossover",
                "params": {"fast": 5, "slow": 20, "direction": "bullish"},
            },
            {
                "id": "position",
                "name": "位置",
                "description": "收盤價在 MA60 之上（中期趨勢確認）",
                "type": "price_above_ma",
                "params": {"ma_period": 60},
            },
            {
                "id": "kbar",
                "name": "K棒",
                "description": "紅 K 且實體 ≥ 2%",
                "type": "bullish_candle",
                "params": {"min_body_pct": 0.02},
            },
            {
                "id": "ma_align",
                "name": "均線多排",
                "description": "MA5 > MA10 > MA20（多頭排列）",
                "type": "ma_alignment",
                "params": {"periods": [5, 10, 20], "direction": "bullish"},
            },
            {
                "id": "volume",
                "name": "量能",
                "description": "成交量 > 5 日均量 × 1.5",
                "type": "volume_surge",
                "params": {"avg_period": 5, "multiplier": 1.5},
            },
            {
                "id": "indicator",
                "name": "指標",
                "description": "MACD 紅柱（OSC > 0）或 KD 金叉（K > D）",
                "type": "indicator_confirm",
                "params": {
                    "macd_positive": True,
                    "kd_golden_cross": True,
                    "logic": "or",  # 任一成立即可
                },
            },
        ],
        exit_conditions=[
            {
                "id": "hold_days",
                "name": "固定持有天數",
                "type": "hold_period",
                "params": {"days": 5},
            },
            {
                "id": "stop_loss",
                "name": "停損",
                "type": "stop_loss",
                "params": {"pct": -0.07},  # -7%
            },
        ],
        parameters={
            "ma_fast": 5,
            "ma_mid": 10,
            "ma_slow": 20,
            "ma_long": 60,
            "volume_multiplier": 1.5,
            "volume_avg_period": 5,
            "kbar_min_body_pct": 0.02,
            "macd_fast": 12,
            "macd_slow": 26,
            "macd_signal": 9,
            "kd_period": 9,
            "kd_smooth_k": 3,
            "kd_smooth_d": 3,
            "hold_days": 5,
            "stop_loss_pct": -0.07,
        },
        min_conditions=4,  # 至少滿足 4 個條件才進場
        metadata={
            "created_at": "2026-03-29T00:00:00",
            "parent_version": None,
            "changes": ["初始版本，基於前端六大條件"],
            "hypothesis": "將前端掃描選股的六大條件搬到 Python，作為策略迭代的起點",
        },
    )
