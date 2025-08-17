interface ConfidenceBadgeProps {
  confidence: 'unconfirmed' | 'reported' | 'corroborated' | 'verified' | 'confirmed';
  className?: string;
}

export default function ConfidenceBadge({ confidence, className = '' }: ConfidenceBadgeProps) {
  const style = (() => {
    switch (confidence) {
      case 'unconfirmed':
        return { color: 'border-neutral-700 bg-neutral-800/80 text-neutral-200', text: 'Unconfirmed' };
      case 'reported':
        return { color: 'border-neutral-700 bg-neutral-800/80 text-neutral-200', text: 'Reported' };
      case 'corroborated':
        return { color: 'border-neutral-700 bg-neutral-800/80 text-neutral-200', text: 'Corroborated' };
      case 'verified':
        return { color: 'border-neutral-700 bg-neutral-800/80 text-neutral-200', text: 'Verified' };
      case 'confirmed':
        return { color: 'border-neutral-700 bg-neutral-800/80 text-neutral-200', text: 'Confirmed' };
      default:
        return { color: 'border-neutral-700 bg-neutral-800/80 text-neutral-200', text: 'Unknown' };
    }
  })();

  return (
    <div className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${style.color} ${className}`}>
      <span>{style.text}</span>
    </div>
  );
}
