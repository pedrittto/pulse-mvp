import { Impact } from '@/types';

interface ImpactBadgeProps {
  impact: Impact;
  className?: string;
}

export default function ImpactBadge({ impact, className = '' }: ImpactBadgeProps) {
  const getImpactConfig = (impact: Impact) => {
    switch (impact) {
      case 'L':
        return {
          label: 'Low',
          classes: 'border-gray-200 bg-gray-50 text-gray-700'
        };
      case 'M':
        return {
          label: 'Medium',
          classes: 'border-amber-200 bg-amber-50 text-amber-700'
        };
      case 'H':
        return {
          label: 'High',
          classes: 'border-red-200 bg-red-50 text-red-700'
        };
      case 'C':
        return {
          label: 'Critical',
          classes: 'border-purple-200 bg-purple-50 text-purple-700'
        };
      default:
        return {
          label: 'Unknown',
          classes: 'border-gray-200 bg-gray-50 text-gray-700'
        };
    }
  };

  const config = getImpactConfig(impact);

  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${config.classes} ${className}`}>
      Impact {config.label}
    </span>
  );
}
