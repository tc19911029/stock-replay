#!/usr/bin/env python3
"""
下載 A 股（滬深300）和台股（台灣50）歷史日線數據
存為 data/cn_stocks.csv 和 data/tw_stocks.csv
"""

import os
import time
import pandas as pd
from datetime import datetime, timedelta

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
os.makedirs(DATA_DIR, exist_ok=True)

END_DATE = datetime.now().strftime('%Y-%m-%d')
START_DATE = (datetime.now() - timedelta(days=365 * 3)).strftime('%Y-%m-%d')


def download_cn_stocks():
    """下載 A 股滬深300成分股日線數據"""
    import akshare as ak

    print("=== 下載 A 股滬深300成分股 ===")
    # 取得滬深300成分股列表
    try:
        hs300 = ak.index_stock_cons_csindex(symbol="000300")
        symbols = hs300['成分券代码'].tolist()
        names = hs300['成分券名称'].tolist()
    except Exception as e:
        print(f"取得滬深300成分股失敗: {e}")
        # 備用：手動列出部分核心成分股
        symbols = [
            "600519", "601318", "600036", "601166", "600900",
            "601288", "601398", "601939", "600276", "000858",
            "002415", "600309", "601888", "000333", "002594",
            "000651", "000001", "601166", "601012", "600887",
        ]
        names = symbols  # 用代碼代替名稱

    print(f"成分股數量: {len(symbols)}")
    all_data = []
    success = 0
    fail = 0

    for i, (sym, name) in enumerate(zip(symbols, names)):
        try:
            print(f"  [{i+1}/{len(symbols)}] {sym} {name}...", end=" ", flush=True)
            df = ak.stock_zh_a_hist(
                symbol=sym,
                period="daily",
                start_date=START_DATE.replace('-', ''),
                end_date=END_DATE.replace('-', ''),
                adjust="qfq"  # 前復權
            )
            if df is not None and len(df) > 0:
                df = df.rename(columns={
                    '日期': 'date', '开盘': 'open', '收盘': 'close',
                    '最高': 'high', '最低': 'low', '成交量': 'volume',
                })
                df['symbol'] = sym
                df['name'] = name
                df['market'] = 'CN'
                df = df[['date', 'symbol', 'name', 'market', 'open', 'high', 'low', 'close', 'volume']]
                all_data.append(df)
                success += 1
                print(f"✓ {len(df)} 筆")
            else:
                fail += 1
                print("✗ 無數據")
        except Exception as e:
            fail += 1
            print(f"✗ {e}")
        time.sleep(1)  # 避免限速

    if all_data:
        result = pd.concat(all_data, ignore_index=True)
        result.to_csv(os.path.join(DATA_DIR, 'cn_stocks.csv'), index=False)
        print(f"\nA股下載完成: {success} 支成功, {fail} 支失敗, 共 {len(result)} 筆數據")
        return success, fail, len(result)
    return 0, fail, 0


def download_tw_stocks():
    """下載台股台灣50成分股日線數據"""
    from FinMind.data import DataLoader

    print("\n=== 下載台股台灣50成分股 ===")
    dl = DataLoader()

    # 台灣50成分股（主要）
    tw50_symbols = [
        "2330", "2317", "2454", "2308", "2382", "2303", "2412", "2891", "2881", "2886",
        "2882", "3711", "2884", "1303", "1301", "2002", "3008", "1216", "2885", "5880",
        "2207", "3034", "2301", "5871", "2357", "6505", "2395", "1101", "2912", "4904",
        "2892", "3037", "2880", "1326", "2887", "4938", "2345", "3231", "5876", "6669",
        "2327", "3045", "2883", "1590", "6446", "2603", "3443", "2474", "8046", "3661",
    ]

    print(f"成分股數量: {len(tw50_symbols)}")
    all_data = []
    success = 0
    fail = 0

    for i, sym in enumerate(tw50_symbols):
        try:
            print(f"  [{i+1}/{len(tw50_symbols)}] {sym}...", end=" ", flush=True)
            df = dl.taiwan_stock_daily(
                stock_id=sym,
                start_date=START_DATE,
                end_date=END_DATE,
            )
            if df is not None and len(df) > 0:
                df = df.rename(columns={
                    'date': 'date', 'open': 'open', 'close': 'close',
                    'max': 'high', 'min': 'low', 'Trading_Volume': 'volume',
                })
                df['symbol'] = sym
                df['name'] = sym  # FinMind 不回傳名稱
                df['market'] = 'TW'
                df = df[['date', 'symbol', 'name', 'market', 'open', 'high', 'low', 'close', 'volume']]
                all_data.append(df)
                success += 1
                print(f"✓ {len(df)} 筆")
            else:
                fail += 1
                print("✗ 無數據")
        except Exception as e:
            fail += 1
            print(f"✗ {e}")
        time.sleep(1)

    if all_data:
        result = pd.concat(all_data, ignore_index=True)
        result.to_csv(os.path.join(DATA_DIR, 'tw_stocks.csv'), index=False)
        print(f"\n台股下載完成: {success} 支成功, {fail} 支失敗, 共 {len(result)} 筆數據")
        return success, fail, len(result)
    return 0, fail, 0


if __name__ == '__main__':
    print(f"數據範圍: {START_DATE} ~ {END_DATE}\n")

    cn_s, cn_f, cn_n = download_cn_stocks()
    tw_s, tw_f, tw_n = download_tw_stocks()

    # 寫入 DATA_LOG.md
    log_path = os.path.join(DATA_DIR, '..', 'DATA_LOG.md')
    with open(log_path, 'w') as f:
        f.write(f"# 數據下載記錄\n\n")
        f.write(f"- 下載日期: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
        f.write(f"- 數據範圍: {START_DATE} ~ {END_DATE}\n\n")
        f.write(f"## A股（滬深300）\n")
        f.write(f"- 成功: {cn_s} 支, 失敗: {cn_f} 支\n")
        f.write(f"- 總筆數: {cn_n}\n")
        f.write(f"- 檔案: data/cn_stocks.csv\n\n")
        f.write(f"## 台股（台灣50）\n")
        f.write(f"- 成功: {tw_s} 支, 失敗: {tw_f} 支\n")
        f.write(f"- 總筆數: {tw_n}\n")
        f.write(f"- 檔案: data/tw_stocks.csv\n")

    print("\n=== 完成！已寫入 DATA_LOG.md ===")
