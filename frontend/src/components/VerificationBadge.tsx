import { VerificationV1 } from '@/types';

interface VerificationBadgeProps {
  verification: VerificationV1;
  className?: string;
}

export default function VerificationBadge({ verification, className = '' }: VerificationBadgeProps) {
  // Get color and text based on verification status
  const getVerificationStyle = (status: VerificationV1['state']) => {
    switch (status) {
      case 'verified':
        return {
          color: 'border-neutral-700 bg-neutral-800/80 text-neutral-200',
          text: 'Verified'
        };
      case 'confirmed':
        return {
          color: 'border-neutral-700 bg-neutral-800/80 text-neutral-200',
          text: 'Confirmed'
        };
      case 'reported':
        return {
          color: 'border-neutral-700 bg-neutral-800/80 text-neutral-200',
          text: 'Reported'
        };
      case 'unconfirmed':
        return {
          color: 'border-neutral-700 bg-neutral-800/80 text-neutral-200',
          text: 'Unconfirmed'
        };
      default:
        return {
          color: 'border-neutral-700 bg-neutral-800/80 text-neutral-200',
          text: 'Unknown'
        };
    }
  };

  const style = getVerificationStyle(verification.state);

  return (
    <div className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${style.color} ${className}`}>
      <span>{style.text}</span>
    </div>
  );
}
