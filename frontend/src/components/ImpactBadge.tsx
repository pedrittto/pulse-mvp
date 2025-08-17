import { ImpactV3 } from '@/types';

interface ImpactBadgeProps {
  impact: ImpactV3;
  className?: string;
}

export default function ImpactBadge({ impact, className = '' }: ImpactBadgeProps) {
  const useColor = process.env.NEXT_PUBLIC_UI_COLOR_BADGES === '1';
  const getImpactConfig = (impact: ImpactV3['category']) => {
    switch (impact) {
      case 'L':
        return {
          label: 'Low',
          classes: useColor ? 'border-neutral-700 bg-neutral-800/70 text-neutral-200' : 'border-neutral-700 bg-neutral-800/80 text-neutral-200'
        };
      case 'M':
        return {
          label: 'Medium',
          classes: useColor ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-neutral-700 bg-neutral-800/80 text-neutral-200'
        };
      case 'H':
        return {
          label: 'High',
          classes: useColor ? 'border-orange-500/35 bg-orange-500/10 text-orange-300' : 'border-neutral-700 bg-neutral-800/80 text-neutral-200'
        };
      case 'C':
        return {
          label: 'Critical',
          classes: useColor ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-neutral-700 bg-neutral-800/80 text-neutral-200'
        };
      default:
        return {
          label: 'Unknown',
          classes: 'border-neutral-700 bg-neutral-800/80 text-neutral-200'
        };
    }
  };

  const config = getImpactConfig(impact.category);

  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${config.classes} ${className}`}>
      Impact {config.label} ({impact.score})
    </span>
  );
}
