from __future__ import annotations
"""
優化假設產生模組 — 根據診斷結果提出改進方向
"""

import random
from typing import Any


def generate_hypothesis(diagnosis: dict, strategy_params: dict) -> dict[str, Any]:
    """
    根據診斷結果，隨機選擇一個優化方向。
    每輪會嘗試不同的策略，避免卡在同一個方向。

    Returns:
        dict with keys: type, description, changes
    """
    weak_conditions = diagnosis.get("weak_conditions", [])
    overfit = diagnosis.get("overfit_risk", {})
    summary = diagnosis.get("summary", {})

    # 收集所有可用的優化方案
    candidates = []

    # ── 方案 A：移除弱條件 ────────────────────────────────────────────────
    for w in weak_conditions:
        if w["marginal_value"] < -3 and w["with_count"] >= 5:
            candidates.append({
                "type": "remove_condition",
                "description": f"移除條件「{w['condition']}」（邊際價值 {w['marginal_value']}%）",
                "target_condition": w["condition"],
                "changes": [f"移除 {w['condition']}"],
                "priority": 3,
            })

    # ── 方案 B：調整最低條件數 ────────────────────────────────────────────
    if overfit.get("is_overfit"):
        candidates.append({
            "type": "reduce_min_conditions",
            "description": "偵測到過擬合，降低最低條件數",
            "changes": ["min_conditions -= 1"],
            "priority": 2,
        })

    val_wr = summary.get("val_win_rate", 50)
    if val_wr < 40:
        candidates.append({
            "type": "increase_min_conditions",
            "description": f"勝率太低（{val_wr:.0f}%），提高最低條件數",
            "changes": ["min_conditions += 1"],
            "priority": 2,
        })

    # ── 方案 C：調整各種參數（永遠可選）────────────────────────────────────
    # ── 方案 D：開啟/關閉基本面和籌碼面過濾 ────────────────────────────────
    if not strategy_params.get("use_fundamental_filter", False):
        candidates.append({
            "type": "toggle_filter",
            "description": "開啟基本面過濾（篩掉基本面差的股票）",
            "param_name": "use_fundamental_filter",
            "old_value": False,
            "new_value": True,
            "changes": ["use_fundamental_filter: False → True"],
            "priority": 3,
        })

    if not strategy_params.get("use_chip_filter", False):
        candidates.append({
            "type": "toggle_filter",
            "description": "開啟籌碼面過濾（篩掉法人賣超的股票）",
            "param_name": "use_chip_filter",
            "old_value": False,
            "new_value": True,
            "changes": ["use_chip_filter: False → True"],
            "priority": 3,
        })

    if strategy_params.get("use_fundamental_filter"):
        candidates.append({
            "type": "adjust_parameter",
            "description": f"調整基本面門檻：{strategy_params.get('min_fundamental_score', 40)} → {strategy_params.get('min_fundamental_score', 40) + 10}",
            "param_name": "min_fundamental_score",
            "old_value": strategy_params.get("min_fundamental_score", 40),
            "new_value": min(80, strategy_params.get("min_fundamental_score", 40) + 10),
            "changes": ["提高基本面門檻"],
            "priority": 2,
        })

    if strategy_params.get("use_chip_filter"):
        candidates.append({
            "type": "adjust_parameter",
            "description": f"調整籌碼門檻：{strategy_params.get('min_chip_score', 40)} → {strategy_params.get('min_chip_score', 40) + 10}",
            "param_name": "min_chip_score",
            "old_value": strategy_params.get("min_chip_score", 40),
            "new_value": min(80, strategy_params.get("min_chip_score", 40) + 10),
            "changes": ["提高籌碼門檻"],
            "priority": 2,
        })

    # ── 方案 E：啟用多因子加權評分模式（取代二元過濾）────────────────────
    mf_analysis = diagnosis.get("multi_factor_analysis", {})
    if not strategy_params.get("use_weighted_scoring", False):
        # Check if multi-factor data suggests weighted scoring would help
        high_wr = mf_analysis.get("high_bonus_win_rate", 50)
        low_wr = mf_analysis.get("low_bonus_win_rate", 50)
        if high_wr > low_wr + 5:
            candidates.append({
                "type": "toggle_filter",
                "description": f"啟用多因子加權評分（高 bonus 勝率 {high_wr:.0f}% > 低 bonus {low_wr:.0f}%）",
                "param_name": "use_weighted_scoring",
                "old_value": False,
                "new_value": True,
                "changes": ["use_weighted_scoring: False → True"],
                "priority": 4,  # high priority - new feature
            })

    if strategy_params.get("use_weighted_scoring", False):
        candidates.append({
            "type": "toggle_filter",
            "description": "關閉多因子加權評分（回到二元過濾）",
            "param_name": "use_weighted_scoring",
            "old_value": True,
            "new_value": False,
            "changes": ["use_weighted_scoring: True → False"],
            "priority": 1,
        })

    # ── 方案 F：新增條件（OBV/週線/RSI/低波動突破）─────────────────────────
    existing_cond_ids = set()
    # Note: we don't have strategy.entry_conditions here, but we can check params
    available_new_conditions = [
        {
            "id": "obv_trend",
            "name": "OBV 趨勢",
            "description": "OBV > OBV_MA20",
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
            "description": "RSI 在 35-75 之間",
            "type": "rsi_neutral_zone",
            "params": {"rsi_low": 35, "rsi_high": 75},
        },
        {
            "id": "low_vol_breakout",
            "name": "低波動突破",
            "description": "ATR 百分位 < 30 且價格 > MA20",
            "type": "low_volatility_breakout",
            "params": {"atr_pct_max": 30},
        },
    ]

    for cond in available_new_conditions:
        candidates.append({
            "type": "add_condition",
            "description": f"新增條件「{cond['name']}」（{cond['description']}）",
            "new_condition": cond,
            "changes": [f"新增 {cond['name']}"],
            "priority": 2,
        })

    # ── 方案 C：調整各種參數（永遠可選）────────────────────────────────────
    adjustable_params = [
        ("volume_multiplier", 0.25, 0.5, 5.0, "量能倍數"),
        ("kbar_min_body_pct", 0.005, 0.005, 0.05, "K棒最小實體"),
        ("hold_days", 1, 1, 20, "持有天數"),
        ("stop_loss_pct", 0.01, -0.15, -0.03, "停損比例"),
        ("ma_fast", 1, 3, 10, "短期均線天數"),
        ("ma_slow", 2, 10, 30, "中期均線天數"),
        ("ma_long", 5, 40, 120, "長期均線天數"),
        ("volume_avg_period", 1, 3, 20, "量能均線天數"),
        ("trailing_stop_pct", 0.005, 0.01, 0.08, "移動停利回撤比例"),
        ("trailing_activate_pct", 0.01, 0.02, 0.10, "移動停利啟動門檻"),
    ]

    for param_name, step, min_val, max_val, label in adjustable_params:
        current = strategy_params.get(param_name, 0)
        direction = random.choice([-1, 1])
        new_val = current + direction * step
        new_val = max(min_val, min(max_val, round(new_val, 4)))

        if abs(new_val - current) < step * 0.1:
            new_val = current - direction * step
            new_val = max(min_val, min(max_val, round(new_val, 4)))

        if new_val != current:
            candidates.append({
                "type": "adjust_parameter",
                "description": f"微調{label}：{current} → {new_val}",
                "param_name": param_name,
                "old_value": current,
                "new_value": new_val,
                "changes": [f"{param_name}: {current} → {new_val}"],
                "priority": 1,
            })

    # ── 隨機選一個方案（加權隨機，高優先級更可能被選到）─────────────────────
    if not candidates:
        return {
            "type": "no_change",
            "description": "沒有可用的優化方案",
            "changes": [],
        }

    weights = [c.get("priority", 1) for c in candidates]
    total = sum(weights)
    probs = [w / total for w in weights]
    chosen = random.choices(candidates, weights=probs, k=1)[0]

    return chosen
