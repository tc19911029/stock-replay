from __future__ import annotations
"""
策略版本註冊表 — 管理所有策略版本
"""

import json
from pathlib import Path
from strategies.base import StrategyConfig
from strategies.v001 import create_v001

STRATEGIES_DIR = Path(__file__).parent


def get_latest_version() -> str:
    """取得最新策略版本號"""
    json_files = sorted(STRATEGIES_DIR.glob("v*.json"), reverse=True)
    if json_files:
        return json_files[0].stem  # e.g., "v002"
    return "v001"


def load_strategy(version: str = None) -> StrategyConfig:
    """
    載入策略。如果指定版本存在 JSON 則讀取，
    否則回傳預設的 v001。
    """
    if version is None:
        version = get_latest_version()

    json_path = STRATEGIES_DIR / f"{version}.json"

    if json_path.exists():
        return StrategyConfig.from_json(json_path)

    # 預設回傳 v001
    return create_v001()


def save_strategy(strategy: StrategyConfig) -> Path:
    """儲存策略為 JSON 檔"""
    path = STRATEGIES_DIR / f"{strategy.version}.json"
    strategy.to_json(path)
    print(f"  💾 策略 {strategy.version} 已儲存至 {path}")
    return path


def list_versions() -> list[str]:
    """列出所有策略版本"""
    # 內建版本
    versions = ["v001"]
    # JSON 檔版本
    for f in sorted(STRATEGIES_DIR.glob("v*.json")):
        v = f.stem
        if v not in versions:
            versions.append(v)
    return versions


def next_version() -> str:
    """產生下一個版本號"""
    latest = get_latest_version()
    num = int(latest.replace("v", "").lstrip("0") or "0")
    return f"v{num + 1:03d}"
