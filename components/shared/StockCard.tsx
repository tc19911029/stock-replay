import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface StockCardProps {
  symbol: string;
  name: string;
  price?: number;
  changePercent?: number;
  volume?: number;
  sixScore?: number;
  trendState?: string;
  className?: string;
  onClick?: () => void;
  children?: React.ReactNode;
}

export function StockCard({
  symbol,
  name,
  price,
  changePercent,
  volume,
  sixScore,
  trendState,
  className,
  onClick,
  children,
}: StockCardProps) {
  const isUp = (changePercent ?? 0) > 0;
  const isDown = (changePercent ?? 0) < 0;
  const ticker = symbol.replace(/\.(TW|TWO)$/i, '');

  return (
    <Card
      className={cn(
        'transition-colors',
        onClick && 'cursor-pointer hover:bg-muted/50',
        className
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}
    >
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-semibold text-muted-foreground">
                {ticker}
              </span>
              {sixScore !== undefined && (
                <Badge
                  variant={sixScore >= 5 ? 'default' : 'secondary'}
                  className="text-xs px-1.5 py-0"
                >
                  {sixScore}/6
                </Badge>
              )}
              {trendState && (
                <TrendBadge state={trendState} />
              )}
            </div>
            <p className="text-sm font-medium truncate mt-0.5">{name}</p>
          </div>

          {price !== undefined && (
            <div className="text-right shrink-0">
              <div className={cn('text-lg font-semibold tabular-nums', isUp && 'text-bull', isDown && 'text-bear')}>
                {price.toFixed(2)}
              </div>
              {changePercent !== undefined && (
                <div className={cn('flex items-center justify-end gap-0.5 text-sm tabular-nums', isUp && 'text-bull', isDown && 'text-bear', !isUp && !isDown && 'text-muted-foreground')}>
                  {isUp ? <TrendingUp className="w-3.5 h-3.5" /> : isDown ? <TrendingDown className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
                  {isUp ? '+' : ''}{changePercent.toFixed(2)}%
                </div>
              )}
            </div>
          )}
        </div>
      </CardHeader>

      {(volume !== undefined || children) && (
        <CardContent className="px-4 pb-4 pt-0">
          {volume !== undefined && (
            <p className="text-xs text-muted-foreground">
              成交量 {(volume / 1000).toFixed(0)}K 張
            </p>
          )}
          {children}
        </CardContent>
      )}
    </Card>
  );
}

function TrendBadge({ state }: { state: string }) {
  const map: Record<string, { label: string; className: string }> = {
    '多頭': { label: '多頭', className: 'border-bull/40 text-bull bg-bull/10' },
    '空頭': { label: '空頭', className: 'border-bear/40 text-bear bg-bear/10' },
    '盤整': { label: '盤整', className: 'border-border text-muted-foreground' },
  };
  const cfg = map[state] ?? { label: state, className: 'border-border text-muted-foreground' };
  return (
    <Badge variant="outline" className={cn('text-xs px-1.5 py-0', cfg.className)}>
      {cfg.label}
    </Badge>
  );
}
