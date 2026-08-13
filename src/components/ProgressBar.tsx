import React from 'react';

interface ProgressBarProps {
  progress: number; // 0.0 to 1.0
  label?: string;
  className?: string;
}

/**
 * Animated progress bar component for model loading
 */
export const ProgressBar: React.FC<ProgressBarProps> = ({
  progress,
  label,
  className = ''
}) => {
  const percentage = Math.round(progress * 100);
  const isIndeterminate = progress === 0;

  return (
    <div className={`space-y-2 ${className}`}>
      {(label || !isIndeterminate) && (
        <div className="flex items-center justify-between text-xs">
          {label && <span className="text-dark-400 font-medium">{label}</span>}
          {!isIndeterminate && (
            <span className="text-accent-cyan font-bold font-mono ml-auto">{percentage}%</span>
          )}
        </div>
      )}
      <div className="relative h-2 bg-dark-800 rounded-full overflow-hidden">
        {isIndeterminate ? (
          /* Indeterminate loading animation - pulsing full bar */
          <div className="absolute inset-0 bg-gradient-to-r from-accent-cyan/60 via-accent-cyan to-accent-cyan/60 shadow-lg shadow-accent-cyan/50 animate-pulse" />
        ) : (
          <>
            {/* Background glow effect */}
            <div className="absolute inset-0 bg-gradient-to-r from-accent-cyan/20 to-accent-cyan/0" />

            {/* Progress bar */}
            <div
              className="absolute inset-y-0 left-0 bg-gradient-to-r from-accent-cyan to-accent-cyan/80 rounded-full transition-all duration-300 ease-out shadow-lg shadow-accent-cyan/50"
              style={{
                width: `${percentage}%`,
              }}
            >
              {/* Shimmer effect */}
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" />
            </div>
          </>
        )}
      </div>
    </div>
  );
};
