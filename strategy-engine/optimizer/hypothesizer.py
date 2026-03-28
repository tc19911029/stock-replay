from __future__ import annotations
"""
優化假設產生模組 — 根據診斷結果提出改進方向
"""

import random
from typing import Any


def generate_hypothesis(diagnosis: dict, strategy_params: dict) -> dict[str, Any]:
    """
    根據診斷結果，產生一個優化假設。

    Returns:
        dict with keys: type, description, changes
    """
    suggestions = diagnosis.get("suggestions", [])
    weak_conditions = diagnosis.get("weak_conditions", [])
    overfit = diagnosis.get("overfit_risk", {})
    summary = diagnosis.get("summary", {})

    # ── 策略 1：移除最弱的條件 ────────────────────────────────────────────
    worst_cond = None
    for w in weak_conditions:
        if w["marginal_value"] < -3 and w["with_count"] >= 5:
            worst_cond = w
            break

    if worst_cond:
        return {
            "type": "remove_condition",
            "description": f"移除條件「{worst_cond['condition']}」（邊際價值 {worst_cond['marginal_value']}%，有它反而更差）",
            "target_condition": worst_cond["condition"],
            "changes": [f"移除 {worst_cond['condition']}"],
        }

    # ── 策略 2：過擬合 → 放寬條件 ────────────────────────────────────────
    if overfit.get("is_overfit"):
        return {
            "type": "reduce_min_conditions",
            "description": "偵測到過擬合，降低最低條件數以增加交易數",
            "changes": ["min_conditions -= 1"],
        }

    # ── 策略 3：勝率太低 → 加嚴條件 ──────────────────────────────────────
    val_wr = summary.get("val_win_rate", 50)
    if val_wr < 40:
        return {
            "type": "increase_min_conditions",
            "description": f"勝率太低（{val_wr}%），提高最低條件數以過濾弱信號",
            "changes": ["min_conditions += 1"],
        }

    # ── 策略 4：調整參數 ─────────────────────────────────────────────────
    adjustable_params = [
        ("volume_multiplier", 0.25, 0.5, 5.0, "量能倍數"),
        ("kbar_min_body_pct", 0.005, 0.005, 0.05, "K棒最小實體"),
        ("hold_days", 1, 1, 20, "持有天數"),
        ("stop_loss_pct", 0.01, -0.15, -0.03, "停損比例"),
    ]

    param_name, step, min_val, max_val, label = random.choice(adjustable_params)
    current = strategy_params.get(param_name, 0)

    # 隨機加或減
    direction = random.choice([-1, 1])
    new_val = current + direction * step
    new_val = max(min_val, min(max_val, new_val))

    if abs(new_val - current) < step * 0.1:
        # 已到邊界，反向
        new_val = current - direction * step
        new_val = max(min_val, min(max_val, new_val))

    return {
        "type": "adjust_parameter",
        "description": f"微調{label}：{current} → {round(new_val, 4)}",
        "param_name": param_name,
        "old_value": current,
        "new_value": round(new_val, 4),
        "changes": [f"{param_name}: {current} → {round(new_val, 4)}"],
    }
