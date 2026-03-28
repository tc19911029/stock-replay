from __future__ import annotations
"""
實驗追蹤模組 — 記錄每輪迭代結果
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Any

LOGS_DIR = Path(__file__).parent / "logs"
LOGS_DIR.mkdir(parents=True, exist_ok=True)

REPORTS_DIR = Path(__file__).parent.parent / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)


def log_round(
    round_number: int,
    old_strategy,
    new_strategy,
    diagnosis: dict,
    hypothesis: dict,
    comparison: dict,
    results: dict,
    new_results: dict,
) -> Path:
    """
    記錄一輪迭代結果為 JSON 檔。

    Returns:
        存檔路徑
    """
    record = {
        "round": round_number,
        "timestamp": datetime.now().isoformat(),
        "current_strategy": old_strategy.version,
        "new_strategy": new_strategy.version,
        "what_changed": hypothesis.get("description", ""),
        "hypothesis": hypothesis,
        "comparison": comparison,
        "promoted": comparison.get("is_better", False),
        "diagnosis_summary": diagnosis.get("summary", {}),
        "suggestions": diagnosis.get("suggestions", []),
    }

    path = LOGS_DIR / f"round_{round_number:03d}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2, default=str)

    return path


def write_report(round_number: int, diagnosis: dict, comparison: dict, old_version: str, new_version: str) -> Path:
    """
    輸出 markdown 格式的診斷報告。

    Returns:
        存檔路徑
    """
    summary = diagnosis.get("summary", {})
    overfit = diagnosis.get("overfit_risk", {})
    weak = diagnosis.get("weak_conditions", [])
    suggestions = diagnosis.get("suggestions", [])
    comp = comparison.get("details", {})

    lines = [
        f"# 第 {round_number} 輪迭代報告",
        f"",
        f"**時間**：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"**當前版本**：{old_version} → **新版本**：{new_version}",
        f"**是否升級**：{'✅ 是' if comparison.get('is_better') else '❌ 否'}",
        f"",
        f"---",
        f"",
        f"## 績效摘要",
        f"",
        f"| 指標 | 訓練集 | 驗證集 |",
        f"|------|--------|--------|",
        f"| 勝率 | {summary.get('train_win_rate', 0):.1f}% | {summary.get('val_win_rate', 0):.1f}% |",
        f"| 夏普率 | {summary.get('train_sharpe', 0):.3f} | {summary.get('val_sharpe', 0):.3f} |",
        f"| 獲利因子 | {summary.get('train_pf', 0):.3f} | {summary.get('val_pf', 0):.3f} |",
        f"| 交易數 | {summary.get('total_train_trades', 0)} | {summary.get('total_val_trades', 0)} |",
        f"",
    ]

    # 過擬合風險
    if overfit.get("is_overfit"):
        lines.append("## ⚠ 過擬合風險")
        for r in overfit.get("reasons", []):
            lines.append(f"- {r}")
        lines.append("")

    # 條件貢獻度
    if weak:
        lines.append("## 條件貢獻度分析")
        lines.append("")
        lines.append("| 條件 | 有此條件勝率 | 無此條件勝率 | 邊際價值 |")
        lines.append("|------|------------|------------|---------|")
        for w in weak:
            emoji = "🔴" if w["marginal_value"] < -3 else "🟡" if w["marginal_value"] < 3 else "🟢"
            lines.append(
                f"| {emoji} {w['condition']} | {w['win_rate_with']:.1f}% | "
                f"{w['win_rate_without']:.1f}% | {w['marginal_value']:+.1f}% |"
            )
        lines.append("")

    # 新舊比較
    if comp:
        lines.append("## 新舊版本比較")
        lines.append("")
        lines.append(f"| 指標 | 舊版 | 新版 |")
        lines.append(f"|------|------|------|")
        lines.append(f"| 夏普率 | {comp.get('old_sharpe', 0):.3f} | {comp.get('new_sharpe', 0):.3f} |")
        lines.append(f"| 勝率 | {comp.get('old_win_rate', 0):.1f}% | {comp.get('new_win_rate', 0):.1f}% |")
        lines.append(f"| 獲利因子 | {comp.get('old_profit_factor', 0):.3f} | {comp.get('new_profit_factor', 0):.3f} |")
        lines.append(f"| 最大回撤 | {comp.get('old_max_drawdown', 0):.2f}% | {comp.get('new_max_drawdown', 0):.2f}% |")
        lines.append("")

    # 建議
    if suggestions:
        lines.append("## 優化建議")
        for s in suggestions:
            lines.append(f"- {s}")
        lines.append("")

    report = "\n".join(lines)
    path = REPORTS_DIR / f"round_{round_number:03d}.md"
    with open(path, "w", encoding="utf-8") as f:
        f.write(report)

    return path


def log_error(round_number: int, error: Exception) -> None:
    """記錄錯誤"""
    path = LOGS_DIR / f"error_{round_number:03d}.json"
    record = {
        "round": round_number,
        "timestamp": datetime.now().isoformat(),
        "error": str(error),
        "error_type": type(error).__name__,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
