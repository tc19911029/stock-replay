from __future__ import annotations
"""
策略突變模組 — 根據假設自動修改策略
"""

from strategies.base import StrategyConfig
from strategies.registry import next_version


def mutate_strategy(strategy: StrategyConfig, hypothesis: dict) -> StrategyConfig:
    """
    根據假設修改策略，產生新版本。

    Parameters:
        strategy: 當前策略
        hypothesis: 優化假設 dict

    Returns:
        修改後的新策略
    """
    new_version = next_version()
    new = strategy.clone(new_version)
    new.metadata["hypothesis"] = hypothesis.get("description", "")
    new.metadata["changes"] = hypothesis.get("changes", [])

    h_type = hypothesis.get("type", "")

    if h_type == "remove_condition":
        target = hypothesis.get("target_condition", "")
        new.entry_conditions = [
            c for c in new.entry_conditions if c["id"] != target
        ]
        # 同時降低最低條件數（移除一個條件，門檻也要降）
        if new.min_conditions > len(new.entry_conditions):
            new.min_conditions = max(1, len(new.entry_conditions) - 1)

    elif h_type == "reduce_min_conditions":
        new.min_conditions = max(1, new.min_conditions - 1)

    elif h_type == "increase_min_conditions":
        max_possible = len(new.entry_conditions)
        new.min_conditions = min(max_possible, new.min_conditions + 1)

    elif h_type == "toggle_filter":
        param_name = hypothesis.get("param_name", "")
        new_value = hypothesis.get("new_value", None)
        if param_name and new_value is not None:
            new.parameters[param_name] = new_value

    elif h_type == "adjust_parameter":
        param_name = hypothesis.get("param_name", "")
        new_value = hypothesis.get("new_value", None)
        if param_name and new_value is not None:
            new.parameters[param_name] = new_value
            _sync_condition_params(new, param_name, new_value)

    elif h_type == "add_condition":
        new_cond = hypothesis.get("new_condition")
        if new_cond:
            # Don't add duplicate conditions
            existing_ids = {c["id"] for c in new.entry_conditions}
            if new_cond["id"] not in existing_ids:
                new.entry_conditions.append(new_cond)

    elif h_type == "swap_condition":
        # Replace one condition with another
        old_id = hypothesis.get("old_condition_id", "")
        new_cond = hypothesis.get("new_condition")
        if old_id and new_cond:
            new.entry_conditions = [
                new_cond if c["id"] == old_id else c
                for c in new.entry_conditions
            ]

    return new


def _sync_condition_params(strategy: StrategyConfig, param_name: str, value) -> None:
    """將策略參數同步到對應的條件 params 裡"""
    param_to_cond = {
        "volume_multiplier": ("volume", "multiplier"),
        "kbar_min_body_pct": ("kbar", "min_body_pct"),
        "hold_days": ("hold_days", "days"),
        "stop_loss_pct": ("stop_loss", "pct"),
    }

    if param_name in param_to_cond:
        cond_id, cond_param = param_to_cond[param_name]
        for cond in strategy.entry_conditions + strategy.exit_conditions:
            if cond["id"] == cond_id:
                cond["params"][cond_param] = value
