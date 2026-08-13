import { useState, useEffect, useRef } from 'react';

/**
 * Hook to smooth a value over time
 * @param value The target value to smooth towards
 * @param duration Duration of the smoothing in ms (default 300ms)
 * @returns The current smoothed value
 */
export function useSmoothedValue(value: number, duration: number = 300): number {
    const [currentValue, setCurrentValue] = useState(value);
    const startValueRef = useRef(value);
    const targetValueRef = useRef(value);
    const startTimeRef = useRef<number | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        // Mark as mounted when component mounts
        mountedRef.current = true;

        // If target hasn't changed, do nothing
        if (value === targetValueRef.current) return;

        // Update target
        startValueRef.current = currentValue;
        targetValueRef.current = value;
        startTimeRef.current = null;

        // A non-positive duration means "no animation" — jump straight to the
        // target. Animating would divide by zero and produce NaN.
        if (duration <= 0) {
            setCurrentValue(value);
            return;
        }

        const animate = (timestamp: number) => {
            // Check if component is still mounted before continuing
            if (!mountedRef.current) return;

            // Compare against null, not falsiness: a timestamp of 0 is valid and
            // would otherwise reset the clock on every frame, stalling forever.
            if (startTimeRef.current === null) startTimeRef.current = timestamp;

            const elapsed = timestamp - startTimeRef.current;
            const progress = Math.min(elapsed / duration, 1);

            // Easing function (easeOutCubic)
            const easeOut = 1 - Math.pow(1 - progress, 3);

            const nextValue = startValueRef.current + (targetValueRef.current - startValueRef.current) * easeOut;

            // Only update state if component is still mounted
            if (mountedRef.current) {
                setCurrentValue(nextValue);
            }

            if (progress < 1 && mountedRef.current) {
                animationFrameRef.current = requestAnimationFrame(animate);
            } else {
                startTimeRef.current = null;
            }
        };

        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
        }

        animationFrameRef.current = requestAnimationFrame(animate);

        return () => {
            // Mark component as unmounted
            mountedRef.current = false;
            // Cancel any pending animation
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, [value, duration]);

    // If we are very close to target (or at start), just return it to avoid small diffs
    return currentValue;
}
