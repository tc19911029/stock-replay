# Strategy Optimization Log

## Scoring Formula

```
Score = (Annualized Return% × 0.4) + (Win Rate% × 0.3) - (Max Drawdown% × 0.3)
```

---

## Round 1 — Multi-Factor Scoring System (2026-03-29)

**Changes:**
- Created `smartMoneyScore.ts`: Smart money detection via OBV, volume asymmetry, CLV, gap patterns
- Added composite ranking: Tech 20% + Surge 25% + Smart Money 30% + Win Rate 25%
- Adaptive exit rules: S-grade stocks hold 8 days, D-grade 4 days
- Python engine: weighted scoring mode (chip 60% + fundamental 40%)

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| OBV Trend | Technical/Chip Proxy | On-Balance Volume uptrend detection |
| Volume Asymmetry | Technical/Chip Proxy | Up-day volume vs down-day volume ratio |
| Close Location Value | Technical | (close-low)/(high-low) buying pressure |
| Institutional Footprint | Technical/Chip Proxy | Gap-up patterns + controlled pullbacks |
| Revenue Momentum Proxy | Fundamental Proxy | 60-day performance + MA60 health |

**Strategy Configs Added:**
- `ZHU_V3_MULTIFACTOR` (generic): minScore=3, volRatio=1.3, KD≤90
- `ZHU_V3_TW` (Taiwan): smart money weight 35%, volRatio=1.4
- `ZHU_V3_CN` (A-share): surge weight 30%, volRatio=1.2, bear minScore=6

**Result:** Committed. Baseline established for multi-factor approach.

---

## Round 2 — Volume-Price Divergence + Mean Reversion (2026-03-29)

**Changes:**
- Added `volumePriceDivergence` component to surge score (10% weight)
- A-share mean reversion filter: blocks RSI>80 + 10d gain>15% entries
- Enhanced Python diagnoser with multi-factor analysis

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Volume-Price Confirmation | Technical | Price up + volume up = healthy |
| Bearish Divergence | Technical | Price up + volume down = distribution risk |
| Bullish Divergence | Technical | Price flat + volume accumulating = opportunity |
| Volume Dry-Up→Spike | Technical | Accumulation completion signal |
| A-Share Mean Reversion | Market-Specific | Block extreme overbought in CN market |

**Result:** Committed. Surge score now 10 components, better at filtering false breakouts.

---

## Round 3 — Consecutive Bullish + Market-Specific Weights (2026-03-29)

**Changes:**
- Consecutive bullish momentum detector: 3-4 up days + volume → +5-15 bonus
- Market-specific composite weights (TW: 35% smart, CN: 30% surge)
- Enhanced Python hypothesizer with trailing stop mutations + weighted scoring toggle

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Consecutive Bullish | Technical | 3+ consecutive up closes with vol increase |
| Market-Specific Weights | System | TW emphasizes smart money, CN emphasizes momentum |

**Result:** Committed. Strategy now adapts to market characteristics.

---

## Round 4 — Evaluator + Investment Trust + Strategy Log (2026-03-29)

**Changes:**
- Created `evaluator.py` with scoring formula implementation
- Added `score_chip_detailed()` for investment trust consecutive buying analysis
- Added strategy log tracking

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Investment Trust Consecutive Buy | Chip | 投信連買 3-5+ days → +8-15 bonus |
| Foreign Investor Consecutive Buy | Chip | 外資連買 3-5+ days → +5-10 bonus |
| Chip Concentration | Chip | 三大法人同步買超 → +5 bonus |
| Strategy Score | System | AnnualReturn×0.4 + WinRate×0.3 - MDD×0.3 |

**Result:** Committed. Self-evaluation loop established.

---

## Round 5 — Sector Momentum + Retry Logic (2026-03-29)

**Changes:**
- Sector heat detection: multiple stocks from same industry passing = hot sector bonus (+5 to +20)
- Exponential backoff retry (3 attempts) for all data fetchers (AKShare, FinMind, yfinance)

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Sector Heat | Sector Rotation | 2 stocks same sector: +5, 3: +10, 4: +15, 5+: +20 |
| Data Retry | Infrastructure | Exponential backoff prevents data gaps |

**Result:** Committed. Captures sector rotation themes.

---

## Round 6 — Retail Sentiment Contrarian + Northbound Flow + Trend Acceleration (2026-03-29)

**Changes:**
- Created `retailSentiment.ts`: proxy for margin trading (融資融券) sentiment
  - Chase-buy detection (FOMO after extended rally)
  - Panic selling detection (margin calls / forced liquidation)
  - Volume exhaustion (distribution phase)
- Created `trendAcceleration.ts`: MA slope acceleration, ROC acceleration, envelope width
- Northbound capital flow (`fetch_northbound_flow`, `score_northbound`) for A-shares
- Contrarian adjustments to composite score and adaptive exit params

**New Factors:**
| Factor | Type | Description |
|--------|------|-------------|
| Retail FOMO Chase | Contrarian | Gap-up + vol spike after extended rally → bearish |
| Panic Capitulation | Contrarian | Vol spike + big red candle near support → bullish |
| Volume Exhaustion | Contrarian | Price highs + declining volume = distribution |
| Trend Acceleration | Technical | MA slope rate of change, envelope width change |
| Northbound Flow | Chip (A-share) | 北向資金連續流入 = 外資看多 |

**Result:** Committed. System now has contrarian + macro flow factors.

---

## Pending Improvements

- [ ] Earnings surprise momentum (營收年增率)
- [ ] Intraday VWAP-based entry optimization
- [ ] Portfolio-level risk parity / max drawdown constraint
- [ ] Machine learning signal combination (gradient boosting on all factors)
- [ ] Cross-market correlation (when TW semi leads, CN semi follows)
