interface ConfidenceBadgeProps {
  confidence: 'unconfirmed' | 'reported' | 'corroborated' | 'verified' | 'confirmed';
  className?: string;
}

export default function ConfidenceBadge({ confidence, className = '' }: ConfidenceBadgeProps) {
  const COLOR_ON = (process.env.NEXT_PUBLIC_UI_COLOR_BADGES ?? '1').toString().toLowerCase();
  const useColor = COLOR_ON === '1' || COLOR_ON === 'true';
  const style = (() => {
    if (!useColor) {
      const neutral = 'border-neutral-700 bg-neutral-800/80 text-neutral-200';
      switch (confidence) {
        case 'unconfirmed': return { color: neutral, text: 'Unconfirmed' };
        case 'reported': return { color: neutral, text: 'Reported' };
        case 'corroborated': return { color: neutral, text: 'Corroborated' };
        case 'verified': return { color: neutral, text: 'Verified' };
        case 'confirmed': return { color: neutral, text: 'Confirmed' };
        default: return { color: neutral, text: 'Unknown' };
      }
    }
    switch (confidence) {
      case 'unconfirmed':
        return { color: 'border-zinc-700 bg-zinc-800/70 text-zinc-300', text: 'Unconfirmed' };
      case 'reported':
        return { color: 'border-amber-500/30 bg-amber-500/10 text-amber-300', text: 'Reported' };
      case 'corroborated':
        return { color: 'border-sky-500/30 bg-sky-500/10 text-sky-300', text: 'Corroborated' };
      case 'verified':
        return { color: 'border-green-500/30 bg-green-500/10 text-green-300', text: 'Verified' };
      case 'confirmed':
        return { color: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300', text: 'Confirmed' };
      default:
        return { color: 'border-zinc-700 bg-zinc-800/70 text-zinc-300', text: 'Unknown' };
    }
  })();

  return (
    <div className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${style.color} ${className}`}>
      <span>{style.text}</span>
    </div>
  );
}
