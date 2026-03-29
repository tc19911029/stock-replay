from __future__ import annotations
"""
策略 v002 — 多因子增強版

在 v001 六大條件基礎上，加入：
7. OBV 趨勢確認（資金流向）
8. 週線趨勢確認（跨時間框架）
9. RSI 中性區間（不超買不超賣）

配合新的自適應參數：
- 基於 ATR 波動率的停損調整
- 基於多因子評分的持有天數
- 加權評分模式（chip + fundamental）
"""

from strategies.base import StrategyConfig


def create_v002() -> StrategyConfig:
    """建立 v002 策略"""
    return StrategyConfig(
        version="v002",
        name="多因子增強版 v2",
        entry_conditions=[
            {
                "id": "trend",
                "name": "趨勢",
                "description": "MA5 > MA20",
                "type": "ma_crossover",
                "params": {"fast": 5, "slow": 20, "direction": "bullish"},
            },
            {
                "id": "position",
                "name": "位置",
                "description": "收盤價在 MA60 之上",
                "type": "price_above_ma",
                "params": {"ma_period": 60},
            },
            {
                "id": "kbar",
                "name": "K棒",
                "description": "紅 K 且實體 ≥ 1.5%（放寬門檻）",
                "type": "bullish_candle",
                "params": {"min_body_pct": 0.015},
            },
            {
                "id": "ma_align",
                "name": "均線多排",
                "description": "MA5 > MA10 > MA20",
                "type": "ma_alignment",
                "params": {"periods": [5, 10, 20], "direction": "bullish"},
            },
            {
                "id": "volume",
                "name": "量能",
                "description": "成交量 > 5 日均量 × 1.3（放寬門檻）",
                "type": "volume_surge",
                "params": {"avg_period": 5, "multiplier": 1.3},
            },
            {
                "id": "indicator",
                "name": "指標",
                "description": "MACD 紅柱或 KD 金叉",
                "type": "indicator_confirm",
                "params": {
                    "macd_positive": True,
                    "kd_golden_cross": True,
                    "logic": "or",
                },
            },
            {
                "id": "obv_trend",
                "name": "OBV 趨勢",
                "description": "OBV > OBV_MA20（資金持續流入）",
                "type": "obv_trend",
                "params": {},
            },
            {
                "id": "weekly_confirm",
                "name": "週線確認",
                "description": "收盤 > MA50 且 MA50 上升",
                "type": "weekly_trend_confirm",
                "params": {},
            },
            {
                "id": "rsi_zone",
                "name": "RSI 健康區",
                "description": "RSI 在 35-75 之間（不超買不超賣）",
                "type": "rsi_neutral_zone",
                "params": {"rsi_low": 35, "rsi_high": 75},
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
                "params": {"pct": -0.06},
            },
        ],
        parameters={
            "ma_fast": 5,
            "ma_mid": 10,
            "ma_slow": 20,
            "ma_long": 60,
            "volume_multiplier": 1.3,
            "volume_avg_period": 5,
            "kbar_min_body_pct": 0.015,
            "macd_fast": 12,
            "macd_slow": 26,
            "macd_signal": 9,
            "kd_period": 9,
            "kd_smooth_k": 3,
            "kd_smooth_d": 3,
            "hold_days": 5,
            "stop_loss_pct": -0.06,
            "trailing_stop_pct": 0.03,
            "trailing_activate_pct": 0.05,
            # Multi-factor settings
            "use_fundamental_filter": True,
            "min_fundamental_score": 35,
            "use_chip_filter": True,
            "min_chip_score": 35,
            "use_weighted_scoring": True,
            "min_fundamental_score": 40,
            "min_chip_score": 40,
        },
        min_conditions=5,  # 9 條件中滿足 5 個
        metadata={
            "created_at": "2026-03-29T00:00:00",
            "parent_version": "v001",
            "changes": [
                "新增 OBV 趨勢確認",
                "新增週線趨勢確認 (MA50)",
                "新增 RSI 中性區間",
                "放寬 K 棒門檻 (2% → 1.5%)",
                "放寬量能門檻 (1.5x → 1.3x)",
                "啟用加權評分模式",
                "停損 -7% → -6%",
            ],
            "hypothesis": "加入資金流向和跨時間框架確認，同時放寬單一條件門檻，提高信號品質",
        },
    )
