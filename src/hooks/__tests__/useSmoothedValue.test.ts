import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSmoothedValue } from '../useSmoothedValue';

/**
 * The hook drives its animation with requestAnimationFrame, which fake timers
 * cannot advance deterministically. Instead we stub rAF and pump frames by hand
 * so each test controls the exact timestamp the hook sees.
 */
let pending: Map<number, FrameRequestCallback>;
let nextHandle: number;
let now: number;

beforeEach(() => {
  pending = new Map();
  nextHandle = 1;
  now = 0;

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const handle = nextHandle++;
    pending.set(handle, cb);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    pending.delete(handle);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Advance the clock by `ms` and flush exactly one animation frame. */
function frame(ms: number) {
  now += ms;
  const due = [...pending.values()];
  pending.clear();
  act(() => {
    due.forEach((cb) => cb(now));
  });
}

describe('useSmoothedValue', () => {
  it('should initialize with the provided value', () => {
    const { result } = renderHook(() => useSmoothedValue(50));
    expect(result.current).toBe(50);
  });

  it('should smoothly transition from 0 to 100', () => {
    const { result, rerender } = renderHook(
      ({ value, duration }) => useSmoothedValue(value, duration),
      { initialProps: { value: 0, duration: 300 } }
    );

    expect(result.current).toBe(0);

    // Update target value
    rerender({ value: 100, duration: 300 });

    frame(0); // first frame establishes the animation start time
    frame(150); // halfway through the 300ms animation

    // Value should be between 0 and 100 (approximately halfway due to easing)
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(100);

    // Fast-forward to completion
    frame(200);

    expect(result.current).toBeCloseTo(100, 1);
  });

  it('should apply easeOutCubic easing function', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSmoothedValue(value, 300),
      { initialProps: { value: 0 } }
    );

    rerender({ value: 100 });

    frame(0);
    frame(150);

    // At 50% elapsed, easeOutCubic gives 1 - 0.5^3 = 0.875, so ~87.5.
    // Either way it must exceed the linear interpolation of 50.
    expect(result.current).toBeGreaterThan(50);
    expect(result.current).toBeCloseTo(87.5, 1);
  });

  it('should handle rapid value changes', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSmoothedValue(value, 300),
      { initialProps: { value: 0 } }
    );

    // Change value multiple times quickly, letting a frame elapse between each
    rerender({ value: 50 });
    frame(50);

    rerender({ value: 100 });
    frame(50);

    rerender({ value: 75 });
    frame(50); // establishes start time for the final leg

    // Should still animate to the final value
    frame(300);

    expect(result.current).toBeCloseTo(75, 1);
  });

  it('should handle zero duration as instant change', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSmoothedValue(value, 0),
      { initialProps: { value: 0 } }
    );

    rerender({ value: 100 });

    // With zero duration the hook must settle synchronously, with no frames
    expect(result.current).toBe(100);
    expect(pending.size).toBe(0);
  });

  it('should handle negative values correctly', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSmoothedValue(value, 300),
      { initialProps: { value: 0 } }
    );

    rerender({ value: -50 });

    frame(0);
    frame(300);

    expect(result.current).toBeCloseTo(-50, 1);
  });

  it('should cleanup animation frame on unmount', () => {
    const cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame');

    const { unmount, rerender } = renderHook(
      ({ value }) => useSmoothedValue(value, 300),
      { initialProps: { value: 0 } }
    );

    rerender({ value: 100 });

    unmount();

    expect(cancelAnimationFrameSpy).toHaveBeenCalled();
  });

  it('should not animate if target value has not changed', () => {
    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame');

    const { rerender } = renderHook(
      ({ value }) => useSmoothedValue(value, 300),
      { initialProps: { value: 50 } }
    );

    const initialCallCount = requestAnimationFrameSpy.mock.calls.length;

    // Rerender with same value
    rerender({ value: 50 });

    // Should not trigger new animation
    expect(requestAnimationFrameSpy.mock.calls.length).toBe(initialCallCount);
  });

  it('should handle decimal values correctly', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSmoothedValue(value, 300),
      { initialProps: { value: 0.5 } }
    );

    rerender({ value: 1.5 });

    frame(0);
    frame(300);

    expect(result.current).toBeCloseTo(1.5, 2);
  });
});
