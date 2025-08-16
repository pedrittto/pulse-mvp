import { VerificationStatus } from '@/types';

interface VerificationBadgeProps {
  verification: VerificationStatus;
  className?: string;
}

export default function VerificationBadge({ verification, className = '' }: VerificationBadgeProps) {
  // Get color and text based on verification status
  const getVerificationStyle = (status: VerificationStatus) => {
    switch (status) {
      case 'verified':
        return {
          color: 'bg-green-100 border-green-200 text-green-700',
          text: 'Verified'
        };
      case 'confirmed':
        return {
          color: 'bg-blue-100 border-blue-200 text-blue-700',
          text: 'Confirmed'
        };
      case 'reported':
        return {
          color: 'bg-gray-100 border-gray-200 text-gray-700',
          text: 'Reported'
        };
      case 'unconfirmed':
        return {
          color: 'bg-amber-100 border-amber-200 text-amber-700',
          text: 'Unconfirmed'
        };
      default:
        return {
          color: 'bg-gray-100 border-gray-200 text-gray-700',
          text: 'Unknown'
        };
    }
  };

  const style = getVerificationStyle(verification);

  return (
    <div className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${style.color} ${className}`}>
      <span>{style.text}</span>
    </div>
  );
}
