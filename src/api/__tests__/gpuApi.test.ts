import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchGPUStats, fetchGPUMetrics } from '../gpuApi';
import { mockGPUStats, mockMultiGPUStats } from '@/test/mocks/gpuData';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock fetch
global.fetch = vi.fn();

describe('gpuApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchGPUStats', () => {
    it('should fetch GPU stats from single host successfully', async () => {
      localStorageMock.setItem('temper_remote_hosts', JSON.stringify(['http://localhost:3001']));

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          gpus: [mockGPUStats.gpus[0]],
          host: mockGPUStats.hosts[0].host_metrics,
          ai_service: mockGPUStats.hosts[0].ai_service,
        }),
      });

      const result = await fetchGPUStats();

      expect(result.gpus).toHaveLength(1);
      expect(result.gpus[0].name).toBe('NVIDIA RTX 4090');
      expect(result.gpus[0].host).toBe('http://localhost:3001');
      expect(result.gpus[0].uniqueId).toBe('http://localhost:3001-0');
      expect(result.hosts).toHaveLength(1);
    });

    it('should fetch GPU stats from multiple hosts successfully', async () => {
      localStorageMock.setItem('temper_remote_hosts', JSON.stringify([
        'http://host1:3001',
        'http://host2:3001',
      ]));

      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            gpus: [{ ...mockGPUStats.gpus[0], index: 0 }],
            host: mockGPUStats.hosts[0].host_metrics,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            gpus: [{ ...mockGPUStats.gpus[0], index: 0 }],
            host: mockGPUStats.hosts[0].host_metrics,
          }),
        });

      const result = await fetchGPUStats();

      expect(result.gpus).toHaveLength(2);
      expect(result.hosts).toHaveLength(2);
      expect(result.gpus[0].host).toBe('http://host1:3001');
      expect(result.gpus[1].host).toBe('http://host2:3001');
    });

    it('should handle partial failures with Promise.allSettled', async () => {
      localStorageMock.setItem('temper_remote_hosts', JSON.stringify([
        'http://good-host:3001',
        'http://bad-host:3001',
      ]));

      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            gpus: [mockGPUStats.gpus[0]],
            host: mockGPUStats.hosts[0].host_metrics,
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        });

      const result = await fetchGPUStats();

      // Should still return data from successful host
      expect(result.gpus).toHaveLength(1);
      expect(result.hosts).toHaveLength(1);
      expect(result.gpus[0].host).toBe('http://good-host:3001');
    });

    it('should sanitize invalid JSON (inf/nan values)', async () => {
      localStorageMock.setItem('temper_remote_hosts', JSON.stringify(['http://localhost:3001']));

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        text: async () => `{
          "gpus": [{
            "index": 0,
            "temperature": inf,
            "power_usage_mw": -inf,
            "fan_speed_percent": nan
          }],
          "host": {}
        }`,
      });

      const result = await fetchGPUStats();

      expect(result.gpus).toHaveLength(1);
      expect(result.gpus[0].temperature).toBeNull();
      expect(result.gpus[0].power_usage_mw).toBeNull();
      expect(result.gpus[0].fan_speed_percent).toBeNull();
    });

    it('should throw error when no hosts configured', async () => {
      // An explicitly empty host list means the user removed every host, which
      // must signal the UI to show the "Add Host" prompt. Note this is distinct
      // from an absent key, which falls back to the built-in defaults below.
      localStorageMock.setItem('temper_remote_hosts', JSON.stringify([]));

      await expect(fetchGPUStats()).rejects.toThrow('NO_HOSTS_CONFIGURED');
    });

    it('should use default /api when no hosts in localStorage', async () => {
      localStorageMock.clear();

      // Mock import.meta.env to not have VITE_GPU_API_BASE
      vi.stubGlobal('import', {
        meta: { env: {} }
      });

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          gpus: [mockGPUStats.gpus[0]],
          host: mockGPUStats.hosts[0].host_metrics,
        }),
      });

      const result = await fetchGPUStats();

      expect(global.fetch).toHaveBeenCalledWith('/api/metrics');
      expect(result.gpus).toHaveLength(1);
    });
  });

  describe('fetchGPUMetrics', () => {
    beforeEach(() => {
      localStorageMock.setItem('temper_remote_hosts', JSON.stringify(['http://localhost:3001']));
    });

    it('should fetch metrics for specific GPU by ID', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          gpus: mockMultiGPUStats.gpus,
          host: mockGPUStats.hosts[0].host_metrics,
        }),
      });

      const result = await fetchGPUMetrics('0');

      expect(result).toHaveLength(1);
      expect(result[0].index).toBe(0);
    });

    it('should throw error for invalid GPU ID (non-numeric)', async () => {
      await expect(fetchGPUMetrics('abc')).rejects.toThrow('Invalid GPU ID');
    });

    it('should throw error for empty GPU ID', async () => {
      await expect(fetchGPUMetrics('')).rejects.toThrow('Invalid GPU ID');
    });

    it('should throw error for negative GPU index', async () => {
      await expect(fetchGPUMetrics('-1')).rejects.toThrow('GPU index cannot be negative');
    });

    it('should throw error for GPU index out of range', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          gpus: mockGPUStats.gpus, // Only 1 GPU
          host: mockGPUStats.hosts[0].host_metrics,
        }),
      });

      await expect(fetchGPUMetrics('5')).rejects.toThrow('GPU index 5 out of range');
    });
  });
});
