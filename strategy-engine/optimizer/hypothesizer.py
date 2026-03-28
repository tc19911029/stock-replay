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
    adjustable_params = [
        ("volume_multiplier", 0.25, 0.5, 5.0, "量能倍數"),
        ("kbar_min_body_pct", 0.005, 0.005, 0.05, "K棒最小實體"),
        ("hold_days", 1, 1, 20, "持有天數"),
        ("stop_loss_pct", 0.01, -0.15, -0.03, "停損比例"),
        ("ma_fast", 1, 3, 10, "短期均線天數"),
        ("ma_slow", 2, 10, 30, "中期均線天數"),
        ("ma_long", 5, 40, 120, "長期均線天數"),
        ("volume_avg_period", 1, 3, 20, "量能均線天數"),
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
