interface ConfidenceBadgeProps {
  confidence: 'unconfirmed' | 'reported' | 'corroborated' | 'verified' | 'confirmed';
  className?: string;
}

export default function ConfidenceBadge({ confidence, className = '' }: ConfidenceBadgeProps) {
  const style = (() => {
    switch (confidence) {
      case 'unconfirmed':
        return { color: 'bg-red-100 border-red-200 text-red-700', text: 'Unconfirmed 🔴' };
      case 'reported':
        return { color: 'bg-orange-100 border-orange-200 text-orange-700', text: 'Reported 🟠' };
      case 'corroborated':
        return { color: 'bg-yellow-100 border-yellow-200 text-yellow-700', text: 'Corroborated 🟡' };
      case 'verified':
        return { color: 'bg-green-100 border-green-200 text-green-700', text: 'Verified 🟢' };
      case 'confirmed':
        return { color: 'bg-blue-100 border-blue-200 text-blue-700', text: 'Confirmed 🔵' };
      default:
        return { color: 'bg-gray-100 border-gray-200 text-gray-700', text: 'Unknown' };
    }
  })();

  return (
    <div className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${style.color} ${className}`}>
      <span>{style.text}</span>
    </div>
  );
}
