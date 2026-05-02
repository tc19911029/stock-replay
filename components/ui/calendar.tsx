'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DayPicker } from 'react-day-picker';
import { cn } from '@/lib/utils';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

export function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col',
        month: 'space-y-3',
        month_caption: 'flex justify-center items-center h-7 relative',
        caption_label: 'text-sm font-medium',
        nav: 'absolute inset-0 flex items-center justify-between px-1 pointer-events-none',
        button_previous: 'pointer-events-auto h-7 w-7 flex items-center justify-center rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground',
        button_next: 'pointer-events-auto h-7 w-7 flex items-center justify-center rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground',
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'text-muted-foreground w-9 text-center text-[0.75rem] font-normal pb-1',
        weeks: '',
        week: 'flex mt-1',
        day: 'h-9 w-9 p-0 flex items-center justify-center',
        day_button: cn(
          'h-8 w-8 rounded-full text-sm transition-colors',
          'hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring',
        ),
        selected: 'bg-sky-500 text-white hover:bg-sky-500 rounded-full',
        today: 'font-semibold text-foreground',
        outside: 'text-muted-foreground/30',
        disabled: 'text-muted-foreground/20 cursor-not-allowed',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === 'left'
            ? <ChevronLeft className="h-4 w-4" />
            : <ChevronRight className="h-4 w-4" />,
      }}
      {...props}
    />
  );
}
