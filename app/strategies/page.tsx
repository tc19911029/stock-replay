'use client';

import { useState } from 'react';
import { PageShell } from '@/components/shared';
import { useSettingsStore } from '@/store/settingsStore';
import {
  BUILT_IN_STRATEGIES,
  StrategyConfig,
  StrategyConditionToggles,
  StrategyThresholds,
} from '@/lib/strategy/StrategyConfig';

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONDITION_LABELS: Record<keyof StrategyConditionToggles, string> = {
  trend:     '趨勢條件',
  position:  '位置條件（不在末升段）',
  kbar:      'K棒條件（長紅突破前高）',
  ma:        '均線條件（多頭排列）',
  volume:    '量能條件（量增）',
  indicator: '指標條件（MACD/KD）',
};

const THRESHOLD_LABELS: Record<keyof StrategyThresholds, string> = {
  maShortPeriod:     '短期均線週期',
  maMidPeriod:       '中期均線週期',
  maLongPeriod:      '長期均線週期',
  kbarMinBodyPct:    'K棒實體最小比例',
  upperShadowMax:    '上影線最大比例',
  volumeRatioMin:    '量比門檻',
  kdMaxEntry:        'KD 進場上限',
  deviationMax:      'MA20 乖離上限',
  minScore:          '最低進場分數',
  marketTrendFilter: '大盤趨勢過濾',
  bullMinScore:      '多頭最低分數',
  sidewaysMinScore:  '盤整最低分數',
  bearMinScore:      '空頭最低分數',
};

function formatThresholdValue(key: keyof StrategyThresholds, value: number | boolean): string {
  if (typeof value === 'boolean') return value ? '啟用' : '停用';
  const pctKeys: Array<keyof StrategyThresholds> = [
    'kbarMinBodyPct', 'upperShadowMax', 'deviationMax',
  ];
  if (pctKeys.includes(key)) return `${(value * 100).toFixed(0)}%`;
  if (key === 'volumeRatioMin') return `${value}x`;
  return String(value);
}

const INPUT_CLASS = 'w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-blue-500';

// ── Strategy Card ─────────────────────────────────────────────────────────────

interface StrategyCardProps {
  strategy: StrategyConfig;
  isActive: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onActivate: () => void;
  onDuplicate: () => void;
  onDelete?: () => void;
}

function StrategyCard({ strategy, isActive, isSelected, onSelect, onActivate, onDuplicate, onDelete }: StrategyCardProps) {
  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer rounded-xl border p-4 transition-all ${
        isSelected
          ? 'border-blue-500 bg-blue-900/20'
          : isActive
          ? 'border-violet-500 bg-violet-900/10'
          : 'border-border bg-secondary/50 hover:border-muted-foreground'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{strategy.name}</span>
            {isActive && (
              <span className="text-xs px-1.5 py-0.5 bg-violet-600 rounded text-foreground">使用中</span>
            )}
            {strategy.isBuiltIn && (
              <span className="text-xs px-1.5 py-0.5 bg-muted rounded text-foreground/80">內建</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{strategy.description}</p>
          <div className="flex gap-3 mt-2 text-xs text-muted-foreground">
            <span>v{strategy.version}</span>
            <span>作者：{strategy.author}</span>
          </div>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <button
            onClick={e => { e.stopPropagation(); onActivate(); }}
            disabled={isActive}
            className={`text-xs px-3 py-1 rounded font-medium transition ${
              isActive
                ? 'bg-violet-800 text-violet-400 cursor-default'
                : 'bg-violet-600 hover:bg-violet-500 text-foreground'
            }`}
          >
            {isActive ? '已啟用' : '啟用'}
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDuplicate(); }}
            className="text-xs px-3 py-1 rounded bg-muted hover:bg-muted text-foreground/80 transition"
          >
            複製
          </button>
          {!strategy.isBuiltIn && onDelete && (
            <button
              onClick={e => { e.stopPropagation(); onDelete(); }}
              className="text-xs px-3 py-1 rounded bg-red-800/60 hover:bg-red-700 text-red-300 transition"
            >
              刪除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Strategy Detail Panel (read-only for built-in, editable for custom) ──────

function StrategyDetail({
  strategy,
  onUpdate,
}: {
  strategy: StrategyConfig;
  onUpdate?: (updates: Partial<Omit<StrategyConfig, 'id' | 'isBuiltIn'>>) => void;
}) {
  const editable = !strategy.isBuiltIn && !!onUpdate;

  return (
    <div className="rounded-xl border border-border bg-secondary/50 p-5 space-y-5">
      {/* Editable name/description for custom strategies */}
      {editable && (
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2 sm:col-span-1">
            <label className="text-xs text-muted-foreground mb-1 block">策略名稱</label>
            <input
              value={strategy.name}
              onChange={e => onUpdate({ name: e.target.value })}
              className={INPUT_CLASS}
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className="text-xs text-muted-foreground mb-1 block">說明</label>
            <input
              value={strategy.description}
              onChange={e => onUpdate({ description: e.target.value })}
              className={INPUT_CLASS}
            />
          </div>
        </div>
      )}

      {/* Condition Toggles */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">條件開關</h3>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(strategy.conditions) as Array<keyof StrategyConditionToggles>).map(key => (
            <label key={key} className="flex items-center gap-2 cursor-pointer">
              {editable ? (
                <input
                  type="checkbox"
                  checked={strategy.conditions[key]}
                  onChange={e => onUpdate({
                    conditions: { ...strategy.conditions, [key]: e.target.checked },
                  })}
                  className="w-3.5 h-3.5 rounded accent-green-500"
                />
              ) : (
                <span className={`w-2 h-2 rounded-full shrink-0 ${strategy.conditions[key] ? 'bg-green-400' : 'bg-muted'}`} />
              )}
              <span className="text-xs text-foreground/80">{CONDITION_LABELS[key]}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Threshold params */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">閾值參數</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          {(Object.keys(strategy.thresholds) as Array<keyof StrategyThresholds>).map(key => {
            const val = strategy.thresholds[key];
            if (typeof val === 'boolean') {
              return (
                <label key={key} className="flex justify-between items-center text-xs cursor-pointer">
                  <span className="text-muted-foreground">{THRESHOLD_LABELS[key]}</span>
                  {editable ? (
                    <input
                      type="checkbox"
                      checked={val}
                      onChange={e => onUpdate({
                        thresholds: { ...strategy.thresholds, [key]: e.target.checked },
                      })}
                      className="w-3.5 h-3.5 rounded accent-blue-500"
                    />
                  ) : (
                    <span className="text-foreground font-mono ml-2">{val ? '啟用' : '停用'}</span>
                  )}
                </label>
              );
            }
            return (
              <div key={key} className="flex justify-between items-center text-xs">
                <span className="text-muted-foreground">{THRESHOLD_LABELS[key]}</span>
                {editable ? (
                  <input
                    type="number"
                    value={val}
                    step={['kbarMinBodyPct', 'upperShadowMax', 'deviationMax'].includes(key) ? 0.01 : key === 'volumeRatioMin' ? 0.1 : 1}
                    onChange={e => onUpdate({
                      thresholds: { ...strategy.thresholds, [key]: Number(e.target.value) },
                    })}
                    className="w-20 bg-secondary border border-border rounded px-2 py-0.5 text-xs text-foreground font-mono text-right focus:outline-none focus:border-blue-500"
                  />
                ) : (
                  <span className="text-foreground font-mono ml-2">
                    {formatThresholdValue(key, val)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Add Custom Strategy Form ────────────────────────────────────────────────

function AddStrategyForm({ onAdd, onCancel, initial }: {
  onAdd: (s: StrategyConfig) => void;
  onCancel: () => void;
  initial?: StrategyConfig;
}) {
  const base = initial ?? BUILT_IN_STRATEGIES[0];
  const [name, setName] = useState(initial ? `${initial.name} (複製)` : '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [conditions, setConditions] = useState<StrategyConditionToggles>({ ...base.conditions });
  const [thresholds, setThresholds] = useState<StrategyThresholds>({ ...base.thresholds });

  function handleSubmit() {
    if (!name.trim()) return;
    const config: StrategyConfig = {
      id: `custom-${Date.now()}`,
      name: name.trim(),
      description: description.trim(),
      version: '1.0.0',
      author: '使用者自訂',
      createdAt: new Date().toISOString(),
      isBuiltIn: false,
      conditions,
      thresholds,
    };
    onAdd(config);
  }

  return (
    <div className="rounded-xl border border-blue-600/50 bg-blue-900/10 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-foreground">
        {initial ? '複製策略' : '新增自訂策略'}
      </h3>
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2 sm:col-span-1">
          <label className="text-xs text-muted-foreground mb-1 block">策略名稱</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="例：我的策略 v1" className={INPUT_CLASS} />
        </div>
        <div className="col-span-2 sm:col-span-1">
          <label className="text-xs text-muted-foreground mb-1 block">說明</label>
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="策略說明..." className={INPUT_CLASS} />
        </div>
      </div>

      {/* Condition toggles */}
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground mb-2">條件開關</h4>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(conditions) as Array<keyof StrategyConditionToggles>).map(key => (
            <label key={key} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={conditions[key]}
                onChange={e => setConditions(c => ({ ...c, [key]: e.target.checked }))}
                className="w-3.5 h-3.5 rounded accent-green-500"
              />
              <span className="text-xs text-foreground/80">{CONDITION_LABELS[key]}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Key thresholds */}
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground mb-2">主要參數</h4>
        <div className="grid grid-cols-2 gap-4">
          {([
            { key: 'minScore' as const, label: '最低進場分數', min: 1, max: 6, step: 1 },
            { key: 'kdMaxEntry' as const, label: 'KD 進場上限', min: 50, max: 100, step: 1 },
            { key: 'volumeRatioMin' as const, label: '量比門檻', min: 1, max: 5, step: 0.1 },
            { key: 'upperShadowMax' as const, label: '上影線最大比例', min: 0, max: 1, step: 0.01 },
            { key: 'deviationMax' as const, label: 'MA20 乖離上限', min: 0, max: 1, step: 0.01 },
            { key: 'bullMinScore' as const, label: '多頭最低分數', min: 1, max: 6, step: 1 },
            { key: 'sidewaysMinScore' as const, label: '盤整最低分數', min: 1, max: 6, step: 1 },
            { key: 'bearMinScore' as const, label: '空頭最低分數', min: 1, max: 6, step: 1 },
          ] as const).map(({ key, label, min, max, step }) => (
            <div key={key}>
              <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
              <input
                type="number" min={min} max={max} step={step}
                value={thresholds[key] as number}
                onChange={e => setThresholds(t => ({ ...t, [key]: Number(e.target.value) }))}
                className={INPUT_CLASS}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={!name.trim()}
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-muted disabled:text-muted-foreground text-foreground text-sm rounded font-medium transition"
        >
          {initial ? '建立複製' : '新增策略'}
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 bg-muted hover:bg-muted text-foreground/80 text-sm rounded transition">
          取消
        </button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function StrategiesPage() {
  const {
    activeStrategyId,
    customStrategies,
    setActiveStrategy,
    addCustomStrategy,
    updateCustomStrategy,
    deleteCustomStrategy,
  } = useSettingsStore();

  const allStrategies = [...BUILT_IN_STRATEGIES, ...customStrategies];
  const [selectedId, setSelectedId] = useState<string>(activeStrategyId);
  const [showAddForm, setShowAddForm] = useState(false);
  const [duplicateSource, setDuplicateSource] = useState<StrategyConfig | null>(null);

  const selectedStrategy = allStrategies.find(s => s.id === selectedId) ?? allStrategies[0];

  function handleAdd(s: StrategyConfig) {
    addCustomStrategy(s);
    setSelectedId(s.id);
    setShowAddForm(false);
    setDuplicateSource(null);
  }

  function handleDuplicate(source: StrategyConfig) {
    setDuplicateSource(source);
    setShowAddForm(true);
  }

  return (
    <PageShell headerSlot={
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">策略管理</span>
        <span className="relative group cursor-help">
          <span className="text-[10px] w-4 h-4 flex items-center justify-center rounded-full bg-muted text-muted-foreground">?</span>
          <div className="absolute z-50 left-0 top-full mt-1 hidden group-hover:block w-60 p-2.5 rounded-lg bg-secondary border border-border text-[11px] text-foreground/80 shadow-lg">
            調整六大條件的門檻參數，或建立自訂策略版本。不同市場環境可切換不同策略。
          </div>
        </span>
        <span className="text-xs text-muted-foreground">
          目前使用：<span className="text-violet-400">{allStrategies.find(s => s.id === activeStrategyId)?.name}</span>
        </span>
      </div>
    }>
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* Strategy Cards Grid */}
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">策略列表</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {allStrategies.map(s => (
              <StrategyCard
                key={s.id}
                strategy={s}
                isActive={s.id === activeStrategyId}
                isSelected={s.id === selectedId}
                onSelect={() => setSelectedId(s.id)}
                onActivate={() => setActiveStrategy(s.id)}
                onDuplicate={() => handleDuplicate(s)}
                onDelete={!s.isBuiltIn ? () => {
                  deleteCustomStrategy(s.id);
                  if (selectedId === s.id) setSelectedId(activeStrategyId);
                } : undefined}
              />
            ))}

            {/* Add custom strategy button */}
            {!showAddForm && (
              <button
                onClick={() => { setDuplicateSource(null); setShowAddForm(true); }}
                className="rounded-xl border border-dashed border-border bg-transparent hover:border-muted-foreground hover:bg-secondary/30 p-4 text-muted-foreground hover:text-foreground/80 transition text-sm font-medium flex items-center justify-center gap-2"
              >
                <span className="text-lg leading-none">+</span>
                新增自訂策略
              </button>
            )}
          </div>
        </div>

        {/* Add / Duplicate Form */}
        {showAddForm && (
          <AddStrategyForm
            onAdd={handleAdd}
            onCancel={() => { setShowAddForm(false); setDuplicateSource(null); }}
            initial={duplicateSource ?? undefined}
          />
        )}

        {/* Strategy Detail (editable for custom strategies) */}
        {selectedStrategy && (
          <div>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              策略詳情：{selectedStrategy.name}
              {!selectedStrategy.isBuiltIn && (
                <span className="text-blue-400 ml-2 font-normal">（可直接編輯）</span>
              )}
            </h2>
            <StrategyDetail
              strategy={selectedStrategy}
              onUpdate={!selectedStrategy.isBuiltIn
                ? (updates) => updateCustomStrategy(selectedStrategy.id, updates)
                : undefined
              }
            />
          </div>
        )}

        {/* Strategy Comparison Table */}
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            策略參數比較
          </h2>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-secondary/60">
                  <th className="text-left px-4 py-2.5 text-muted-foreground font-medium whitespace-nowrap">參數</th>
                  {allStrategies.map(s => (
                    <th key={s.id} className="text-center px-4 py-2.5 font-medium whitespace-nowrap">
                      <span className={s.id === activeStrategyId ? 'text-violet-400' : 'text-foreground/80'}>
                        {s.name}
                      </span>
                      {s.id === activeStrategyId && (
                        <span className="ml-1 text-violet-500">★</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(Object.keys(allStrategies[0].thresholds) as Array<keyof StrategyThresholds>).map((key, i) => (
                  <tr key={key} className={`border-b border-border ${i % 2 === 0 ? '' : 'bg-secondary/20'}`}>
                    <td className="px-4 py-2 text-muted-foreground">{THRESHOLD_LABELS[key]}</td>
                    {allStrategies.map(s => (
                      <td key={s.id} className="px-4 py-2 text-center font-mono text-foreground/90">
                        {formatThresholdValue(key, s.thresholds[key] as number | boolean)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </PageShell>
  );
}
