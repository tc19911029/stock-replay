from __future__ import annotations
"""
策略基類 — 定義策略的結構化格式
"""

import json
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Any
from pathlib import Path


@dataclass
class StrategyConfig:
    """策略配置結構"""
    version: str                         # 版本號，例如 "v001"
    name: str                            # 策略名稱
    entry_conditions: list[dict]         # 進場條件列表
    exit_conditions: list[dict]          # 出場條件列表
    parameters: dict                     # 可調參數
    min_conditions: int = 4              # 至少滿足 N 個進場條件才觸發
    metadata: dict = field(default_factory=lambda: {
        "created_at": datetime.now().isoformat(),
        "parent_version": None,
        "changes": [],
        "hypothesis": None,
    })

    def to_dict(self) -> dict:
        """轉成 dict（可序列化為 JSON）"""
        return asdict(self)

    def to_json(self, path: str | Path) -> None:
        """存成 JSON 檔"""
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2, default=str)

    @classmethod
    def from_json(cls, path: str | Path) -> "StrategyConfig":
        """從 JSON 檔讀取"""
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return cls(**data)

    def clone(self, new_version: str) -> "StrategyConfig":
        """複製一份新版本"""
        import copy
        new = copy.deepcopy(self)
        new.metadata["parent_version"] = self.version
        new.metadata["created_at"] = datetime.now().isoformat()
        new.metadata["changes"] = []
        new.version = new_version
        return new
