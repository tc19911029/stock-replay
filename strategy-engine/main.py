from __future__ import annotations
"""
策略研發引擎 — 主迭代循環
持續自動研究、回測、診斷、優化、迭代。
"""

import sys
import time
import signal
import yaml
from datetime import datetime
from pathlib import Path

# 確保可以 import 本地模組
sys.path.insert(0, str(Path(__file__).parent))

from data.fetcher_a import fetch_all as fetch_a_shares
from data.fetcher_tw import fetch_all as fetch_tw_stocks
from data.resampler import resample
from strategies.registry import load_strategy, save_strategy, next_version
from backtest.engine import run_backtest
from optimizer.diagnoser import diagnose
from optimizer.hypothesizer import generate_hypothesis
from optimizer.mutator import mutate_strategy
from optimizer.comparator import compare
from experiments.tracker import log_round, write_report, log_error

# ── 全域狀態 ──────────────────────────────────────────────────────────────────
_should_stop = False

def _signal_handler(signum, frame):
    """Ctrl+C 優雅停止"""
    global _should_stop
    print("\n⏸  收到停止信號，完成當前輪次後退出...")
    _should_stop = True

signal.signal(signal.SIGINT, _signal_handler)
signal.signal(signal.SIGTERM, _signal_handler)


def load_config(path: str = "config.yaml") -> dict:
    """載入設定檔"""
    config_path = Path(__file__).parent / path
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def fetch_all_data(config: dict) -> dict:
    """
    抓取所有市場的數據，並合成不同 timeframe。

    Returns:
        {market: {timeframe: {symbol: DataFrame}}}
    """
    stock_count = config.get("stock_count_per_market", 50)
    days = config.get("data", {}).get("lookback_days", 500)
    expire = config.get("data", {}).get("cache_expire_hours", 24)

    all_data = {}

    for market in config.get("markets", []):
        print(f"\n📊 抓取 {market} 數據...")

        if market == "a_shares":
            daily_data = fetch_a_shares(stock_count, days, expire)
        elif market == "tw_stocks":
            daily_data = fetch_tw_stocks(stock_count, days, expire)
        else:
            print(f"  ⚠ 未知市場：{market}，跳過")
            continue

        market_data = {}
        for tf in config.get("timeframes", ["daily"]):
            if tf == "daily":
                market_data[tf] = daily_data
            else:
                market_data[tf] = {
                    sym: resample(df, tf) for sym, df in daily_data.items()
                }

        all_data[market] = market_data
        print(f"  ✅ {market} 完成：{len(daily_data)} 支股票 × {len(market_data)} 個週期")

    return all_data


def main():
    """主迭代循環"""
    global _should_stop

    config = load_config()
    stop = config.get("stop_conditions", {})
    max_rounds = stop.get("max_rounds", 100)
    max_hours = stop.get("max_hours", 8)
    patience = stop.get("no_improvement_patience", 10)

    bt_config = config.get("backtest", {})
    train_ratio = bt_config.get("train_ratio", 0.6)
    val_ratio = bt_config.get("validation_ratio", 0.2)

    round_number = 1
    start_time = time.time()
    no_improvement_count = 0
    best_score = None

    print(f"🚀 策略研發引擎啟動 — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"   停止條件：最多 {max_rounds} 輪 | {max_hours} 小時 | 連續 {patience} 輪無改善")
    print(f"   市場：{config.get('markets', [])}")
    print(f"   週期：{config.get('timeframes', [])}")

    # ── 抓取數據（只抓一次，後續用快取）────────────────────────────────────
    print("\n" + "=" * 60)
    print("📥 Step 0: 抓取歷史數據")
    print("=" * 60)
    all_data = fetch_all_data(config)

    if not all_data:
        print("❌ 無法抓取任何數據，引擎結束。")
        return

    # ── 主循環 ────────────────────────────────────────────────────────────
    while not _should_stop:
        print(f"\n{'=' * 60}")
        print(f"📊 第 {round_number} 輪迭代開始")
        print(f"{'=' * 60}")

        try:
            # 1. 載入當前最新策略
            strategy = load_strategy()
            print(f"  📋 當前策略：{strategy.version}（{strategy.name}）")
            print(f"     最低條件數：{strategy.min_conditions}，進場條件：{len(strategy.entry_conditions)} 個")

            # 2. 回測當前策略
            print(f"  ⏳ 回測當前策略...")
            results = {}
            for market in config.get("markets", []):
                for tf in config.get("timeframes", ["daily"]):
                    key = f"{market}_{tf}"
                    market_data = all_data.get(market, {}).get(tf, {})
                    if not market_data:
                        continue

                    train_result = run_backtest(strategy, market_data, market, "train", train_ratio, val_ratio)
                    val_result = run_backtest(strategy, market_data, market, "validation", train_ratio, val_ratio)

                    results[key] = {"train": train_result, "validation": val_result}

                    t_wr = train_result["stats"].get("win_rate", 0)
                    v_wr = val_result["stats"].get("win_rate", 0)
                    print(f"     {key}: 訓練 {t_wr:.1f}%（{train_result['trade_count']}筆）| 驗證 {v_wr:.1f}%（{val_result['trade_count']}筆）")

            # 3. 診斷
            print(f"  🔍 診斷分析...")
            diagnosis = diagnose(results)
            for s in diagnosis.get("suggestions", [])[:3]:
                print(f"     {s}")

            # 4. 產生優化假設
            hypothesis = generate_hypothesis(diagnosis, strategy.parameters)
            print(f"  💡 優化假設：{hypothesis.get('description', '無')}")

            # 5. 突變策略
            new_strategy = mutate_strategy(strategy, hypothesis)
            print(f"  🧬 新版本：{new_strategy.version}")

            # 6. 回測新策略
            print(f"  ⏳ 回測新策略...")
            new_results = {}
            for market in config.get("markets", []):
                for tf in config.get("timeframes", ["daily"]):
                    key = f"{market}_{tf}"
                    market_data = all_data.get(market, {}).get(tf, {})
                    if not market_data:
                        continue

                    new_train = run_backtest(new_strategy, market_data, market, "train", train_ratio, val_ratio)
                    new_val = run_backtest(new_strategy, market_data, market, "validation", train_ratio, val_ratio)
                    new_results[key] = {"train": new_train, "validation": new_val}

            # 7. 比較
            comparison = compare(results, new_results)
            is_better = comparison.get("is_better", False)
            print(f"  {'✅ 新版本更好！' if is_better else '❌ 新版本沒有改善'} — {comparison.get('reason', '')}")

            # 8. 決定是否升級
            if is_better:
                save_strategy(new_strategy)
                no_improvement_count = 0
                print(f"  🎉 升級至 {new_strategy.version}")
            else:
                no_improvement_count += 1
                print(f"  ⏸ 維持 {strategy.version}（連續 {no_improvement_count} 輪無改善）")

            # 9. 記錄
            log_round(round_number, strategy, new_strategy, diagnosis, hypothesis, comparison, results, new_results)
            report_path = write_report(round_number, diagnosis, comparison, strategy.version, new_strategy.version)
            print(f"  📝 報告已存至 {report_path}")

        except Exception as e:
            print(f"  ❌ 第 {round_number} 輪出錯：{e}")
            import traceback
            traceback.print_exc()
            log_error(round_number, e)
            no_improvement_count += 1

        # ── 檢查停止條件 ──────────────────────────────────────────────────
        elapsed_hours = (time.time() - start_time) / 3600

        if round_number >= max_rounds:
            print(f"\n🏁 達到最大輪數 {max_rounds}，停止。")
            break
        if elapsed_hours >= max_hours:
            print(f"\n🏁 達到最大時間 {max_hours} 小時，停止。")
            break
        if no_improvement_count >= patience:
            print(f"\n🏁 連續 {patience} 輪無改善，停止。")
            break

        round_number += 1

    # ── 結束 ──────────────────────────────────────────────────────────────
    elapsed = (time.time() - start_time) / 3600
    print(f"\n{'=' * 60}")
    print(f"🏁 引擎結束。共跑 {round_number} 輪，耗時 {elapsed:.1f} 小時。")
    print(f"   最終策略版本：{load_strategy().version}")
    print(f"   報告存於：strategy-engine/reports/")
    print(f"   實驗日誌：strategy-engine/experiments/logs/")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
