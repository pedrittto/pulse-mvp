import { ImpactV3 } from '@/types';

interface ImpactBadgeProps {
  impact: ImpactV3;
  className?: string;
}

export default function ImpactBadge({ impact, className = '' }: ImpactBadgeProps) {
  const getImpactConfig = (impact: ImpactV3['category']) => {
    switch (impact) {
      case 'L':
        return {
          label: 'Low',
          classes: 'border-neutral-700 bg-neutral-800/80 text-neutral-200'
        };
      case 'M':
        return {
          label: 'Medium',
          classes: 'border-neutral-700 bg-neutral-800/80 text-neutral-200'
        };
      case 'H':
        return {
          label: 'High',
          classes: 'border-neutral-700 bg-neutral-800/80 text-neutral-200 ring-1 ring-red-400/40'
        };
      case 'C':
        return {
          label: 'Critical',
          classes: 'border-neutral-700 bg-neutral-800/80 text-neutral-200 ring-1 ring-red-400/40'
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
