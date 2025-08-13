interface ConfidenceBadgeProps {
  confidence: number;
  className?: string;
}

export default function ConfidenceBadge({ confidence, className = '' }: ConfidenceBadgeProps) {
  // Clamp confidence to 20-95 range for display
  const clampedConfidence = Math.max(20, Math.min(95, confidence));
  
  // Calculate background width as percentage
  const bgWidth = `${clampedConfidence}%`;
  
  // Get color based on confidence level
  const getConfidenceColor = (conf: number) => {
    if (conf >= 80) return 'bg-green-100 border-green-200 text-green-700';
    if (conf >= 60) return 'bg-blue-100 border-blue-200 text-blue-700';
    if (conf >= 40) return 'bg-yellow-100 border-yellow-200 text-yellow-700';
    return 'bg-red-100 border-red-200 text-red-700';
  };

  const colorClasses = getConfidenceColor(clampedConfidence);

  return (
    <div className={`relative inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border overflow-hidden ${colorClasses} ${className}`}>
      {/* Background progress bar */}
      <div 
        className="absolute inset-0 bg-current opacity-10"
        style={{ width: bgWidth }}
      />
      {/* Text content */}
      <span className="relative z-10">
        Confidence {clampedConfidence}
      </span>
    </div>
  );
}
