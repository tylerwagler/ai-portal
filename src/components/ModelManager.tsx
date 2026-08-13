import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    Play,
    Square,
    Loader2,
    AlertTriangle,
    CheckCircle2,
    Clock,
    Cpu,
    RefreshCw,
    ChevronDown,
    ChevronUp,
    Settings2,
    ScrollText,
    ArrowUpCircle,
} from 'lucide-react';
import {
    getManagerCatalog,
    loadManagerModel,
    unloadManagerModel,
    getManagerModelLogs,
    refreshManagerUpdates,
    updateManagerModel,
    type HostKey,
    type ManagerModelCatalogEntry,
    type ManagerLoadOverrides,
} from '../api/managerApi';
import { fetchGPUStats } from '../api/gpuApi';
import { useSmoothedValue } from '../hooks/useSmoothedValue';
import { supabase } from '../lib/supabase';
import type { AiServiceMetrics, SlotMetrics } from '../types/gpu';

interface Props {
    session: any;
}

interface GpuVram {
    usedMb: number;
    totalMb: number;
}

// KV cache multipliers for VRAM estimation
const KV_MULTIPLIERS: Record<string, number> = {
    f16: 1.0,
    q8_0: 0.5,
    q4_0: 0.25,
    auto: 1.0,
    fp8: 0.5,
};

// Per-model parameter state for llama models
interface LlamaParams {
    ctx_size: number;
    parallel: number;
    cache_type: string;
}

// Per-model parameter state for vLLM models
interface VllmParams {
    ctx_size: number;
    max_num_seqs: number;
    kv_cache_dtype: string;
}

function estimateVram(vramBase: number, ctxSize: number, vramPer1kCtx: number, cacheType: string): number {
    const mult = KV_MULTIPLIERS[cacheType] ?? 1.0;
    return vramBase + (ctxSize / 1024) * vramPer1kCtx * mult;
}

export const ModelManager = ({ session }: Props) => {
    const [error, setError] = useState<string | null>(null);
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [confirmAction, setConfirmAction] = useState<{ model: string; action: 'load' | 'unload' | 'update'; host: HostKey } | null>(null);
    const [checkingUpdates, setCheckingUpdates] = useState(false);

    // Expanded parameter panels per host
    const [expandedEllie, setExpandedEllie] = useState<string | null>(null);
    const [expandedSparky, setExpandedSparky] = useState<string | null>(null);

    // Per-model parameter overrides
    const [llamaParams, setLlamaParams] = useState<Record<string, LlamaParams>>({});
    const [vllmParams, setVllmParams] = useState<Record<string, VllmParams>>({});

    // Logs viewer — supports multiple open panels
    interface LogsState {
        content: string;
        loading: boolean;
    }
    const [openLogs, setOpenLogs] = useState<Record<string, LogsState>>({});
    const [logsAutoRefresh, setLogsAutoRefresh] = useState(true);

    const jwt = session?.access_token;

    // --- Fetch catalogs from both model-managers ---
    const [ellieCatalog, setEllieCatalog] = useState<ManagerModelCatalogEntry[]>([]);
    const [sparkyCatalog, setSparkyCatalog] = useState<ManagerModelCatalogEntry[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchCatalogs = useCallback(async () => {
        if (!jwt) return;
        try {
            const [ellie, sparky] = await Promise.allSettled([
                getManagerCatalog('ellie', jwt),
                getManagerCatalog('sparky', jwt),
            ]);
            if (ellie.status === 'fulfilled') setEllieCatalog(ellie.value);
            if (sparky.status === 'fulfilled') setSparkyCatalog(sparky.value);
        } catch (err: any) {
            if (!error) setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [jwt]);

    useEffect(() => {
        fetchCatalogs();
        const interval = setInterval(fetchCatalogs, 5000);
        return () => clearInterval(interval);
    }, [fetchCatalogs]);

    // --- Ellie GPU VRAM ---
    const { data: ellieVram } = useQuery<GpuVram>({
        queryKey: ['ellie-vram'],
        queryFn: async () => {
            const res = await fetch('/api/metrics');
            if (!res.ok) throw new Error('Failed to fetch metrics');
            const rawText = await res.text();
            const safeJson = rawText.replace(/: ?(inf|-inf|nan)/gi, ': null');
            const data = JSON.parse(safeJson);
            const gpus = data.gpus || [];
            const usedMb = gpus.reduce((sum: number, g: any) => sum + (g.resources?.memory_used_mb || 0), 0);
            const totalMb = gpus.reduce((sum: number, g: any) => sum + (g.resources?.memory_total_mb || 0), 0);
            return { usedMb, totalMb };
        },
        refetchInterval: 5000,
    });

    // --- Sparky GPU VRAM ---
    const { data: sparkyVram } = useQuery<GpuVram>({
        queryKey: ['sparky-vram'],
        queryFn: async () => {
            const res = await fetch('/api/sparky/metrics');
            if (!res.ok) throw new Error('Failed to fetch Sparky metrics');
            const rawText = await res.text();
            const safeJson = rawText.replace(/: ?(inf|-inf|nan)/gi, ': null');
            const data = JSON.parse(safeJson);
            const gpus = data.gpus || [];
            const usedMb = gpus.reduce((sum: number, g: any) => sum + (g.resources?.memory_used_mb || 0), 0);
            const totalMb = gpus.reduce((sum: number, g: any) => sum + (g.resources?.memory_total_mb || 0), 0);
            return { usedMb, totalMb };
        },
        refetchInterval: 5000,
    });

    // --- AI service metrics (for live throughput + KV cache on running models) ---
    const { data: gpuStats } = useQuery({
        queryKey: ['gpu-stats', 'all'],
        queryFn: () => fetchGPUStats(),
        refetchInterval: 3000,
        staleTime: 0,
    });

    const ellieAiService: AiServiceMetrics | undefined = gpuStats?.hosts?.find(
        (h: any) => h.host === '/api' || h.host?.includes('localhost') || h.host?.includes('127.0.0.1')
    )?.ai_service;

    const sparkyAiService: AiServiceMetrics | undefined = gpuStats?.hosts?.find(
        (h: any) => h.host !== '/api' && !h.host?.includes('localhost') && !h.host?.includes('127.0.0.1')
    )?.ai_service;

    // Initialize llama params from catalog
    useEffect(() => {
        if (!ellieCatalog.length) return;
        setLlamaParams(prev => {
            const next = { ...prev };
            for (const m of ellieCatalog) {
                if (!next[m.id]) {
                    next[m.id] = {
                        ctx_size: m.ctx_size || 0,
                        parallel: m.parallel || 1,
                        cache_type: m.cache_type || 'f16',
                    };
                }
            }
            return next;
        });
    }, [ellieCatalog.length]);

    // Initialize vllm params from catalog
    useEffect(() => {
        if (!sparkyCatalog.length) return;
        setVllmParams(prev => {
            const next = { ...prev };
            for (const m of sparkyCatalog) {
                if (!next[m.id]) {
                    next[m.id] = {
                        ctx_size: m.max_model_len || 0,
                        max_num_seqs: m.max_num_seqs || 64,
                        kv_cache_dtype: m.kv_cache_dtype || 'auto',
                    };
                }
            }
            return next;
        });
    }, [sparkyCatalog.length]);

    const getJwt = async (): Promise<string> => {
        let token = jwt;
        if (!token) {
            const { data } = await supabase.auth.getSession();
            token = data?.session?.access_token;
        }
        if (!token) throw new Error('Not authenticated');
        return token;
    };

    const handleLoad = async (host: HostKey, modelId: string) => {
        setConfirmAction(null);
        setActionLoading(modelId);
        try {
            const token = await getJwt();
            const overrides: ManagerLoadOverrides = {};

            if (host === 'ellie') {
                const catalog = ellieCatalog;
                const params = llamaParams[modelId];
                const cfg = catalog.find(m => m.id === modelId);
                if (params && cfg) {
                    if (params.ctx_size !== (cfg.ctx_size || 0)) overrides.ctx_size = params.ctx_size;
                    if (params.parallel !== (cfg.parallel || 1)) overrides.parallel = params.parallel;
                    if (params.cache_type !== (cfg.cache_type || 'f16')) overrides.cache_type = params.cache_type;
                }
            } else {
                const catalog = sparkyCatalog;
                const params = vllmParams[modelId];
                const cfg = catalog.find(m => m.id === modelId);
                if (params && cfg) {
                    if (params.ctx_size !== (cfg.max_model_len || 0)) overrides.ctx_size = params.ctx_size;
                    if (params.max_num_seqs !== (cfg.max_num_seqs || 64)) overrides.max_num_seqs = params.max_num_seqs;
                    if (params.kv_cache_dtype !== (cfg.kv_cache_dtype || 'auto')) overrides.kv_cache_dtype = params.kv_cache_dtype;
                }
            }

            await loadManagerModel(host, modelId, token, Object.keys(overrides).length > 0 ? overrides : undefined);
            await fetchCatalogs();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setActionLoading(null);
        }
    };

    const handleUnload = async (host: HostKey, modelId: string) => {
        setConfirmAction(null);
        setActionLoading(modelId);
        try {
            const token = await getJwt();
            await unloadManagerModel(host, modelId, token);
            await fetchCatalogs();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setActionLoading(null);
        }
    };

    const handleCheckUpdates = async () => {
        setCheckingUpdates(true);
        try {
            const token = await getJwt();
            await Promise.allSettled([
                refreshManagerUpdates('ellie', token),
                refreshManagerUpdates('sparky', token),
            ]);
            await fetchCatalogs();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setCheckingUpdates(false);
        }
    };

    const handleUpdate = async (host: HostKey, modelId: string) => {
        setConfirmAction(null);
        setActionLoading(modelId);
        try {
            const token = await getJwt();
            await updateManagerModel(host, modelId, token);
            await fetchCatalogs();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setActionLoading(null);
        }
    };

    const logsKey = (host: HostKey, modelId: string) => `${host}:${modelId}`;

    const toggleLogs = async (host: HostKey, modelId: string) => {
        const key = logsKey(host, modelId);
        if (openLogs[key]) {
            setOpenLogs(prev => {
                const next = { ...prev };
                delete next[key];
                return next;
            });
            return;
        }
        setOpenLogs(prev => ({ ...prev, [key]: { content: '', loading: true } }));
        try {
            const result = await getManagerModelLogs(host, modelId, 200);
            setOpenLogs(prev => prev[key] ? { ...prev, [key]: { content: result.logs || '(no logs)', loading: false } } : prev);
        } catch (err: any) {
            setOpenLogs(prev => prev[key] ? { ...prev, [key]: { content: `Error: ${err.message}`, loading: false } } : prev);
        }
    };

    const refreshSingleLog = async (host: HostKey, modelId: string) => {
        const key = logsKey(host, modelId);
        setOpenLogs(prev => prev[key] ? { ...prev, [key]: { ...prev[key], loading: true } } : prev);
        try {
            const result = await getManagerModelLogs(host, modelId, 200);
            setOpenLogs(prev => prev[key] ? { ...prev, [key]: { content: result.logs || '(no logs)', loading: false } } : prev);
        } catch (err: any) {
            setOpenLogs(prev => prev[key] ? { ...prev, [key]: { content: `Error: ${err.message}`, loading: false } } : prev);
        }
    };

    // Auto-refresh all open log panels
    useEffect(() => {
        const keys = Object.keys(openLogs);
        if (keys.length === 0 || !logsAutoRefresh) return;
        const interval = setInterval(async () => {
            for (const key of keys) {
                const [host, modelId] = key.split(':') as [HostKey, string];
                try {
                    const result = await getManagerModelLogs(host, modelId, 200);
                    setOpenLogs(prev => prev[key] ? { ...prev, [key]: { ...prev[key], content: result.logs || '(no logs)' } } : prev);
                } catch { /* ignore */ }
            }
        }, 3000);
        return () => clearInterval(interval);
    }, [Object.keys(openLogs).join(','), logsAutoRefresh]);

    // Sparky GPU budget (percentage-based fallback when no VRAM metrics)
    const sparkyGpuUsed = sparkyCatalog
        .filter(m => m.status === 'running' || m.status === 'starting')
        .reduce((sum, m) => sum + (m.gpu_memory || 0), 0);
    const gpuMax = 0.95;

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 text-accent-cyan animate-spin" />
            </div>
        );
    }

    return (
        <div className="p-8 h-full overflow-auto animate-in fade-in slide-in-from-bottom-2 duration-500">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-3xl font-bold mb-2">Models</h1>
                    <p className="text-dark-400">Manage LLM inference across Ellie and Sparky</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleCheckUpdates}
                        disabled={checkingUpdates}
                        className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-dark-400 hover:text-accent-cyan rounded-lg hover:bg-dark-800 transition-colors disabled:opacity-50"
                        title="Check HuggingFace for model updates"
                    >
                        {checkingUpdates ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpCircle size={14} />}
                        Check Updates
                    </button>
                    <button
                        onClick={() => { setLoading(true); fetchCatalogs(); }}
                        className="text-dark-400 hover:text-accent-cyan p-2 rounded-lg hover:bg-dark-800 transition-colors"
                        title="Refresh"
                    >
                        <RefreshCw size={18} />
                    </button>
                </div>
            </div>

            {error && (
                <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 flex justify-between items-center mb-6">
                    <span>{error}</span>
                    <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200 ml-4">&times;</button>
                </div>
            )}

            {/* Confirmation Dialog */}
            {confirmAction && (
                <div className="bg-dark-900 border border-dark-800 rounded-2xl p-6 shadow-lg animate-in zoom-in-95 duration-200 mb-6">
                    <div className="flex items-center gap-3 mb-4">
                        <AlertTriangle size={20} className="text-yellow-500" />
                        <span className="font-bold text-white">
                            {confirmAction.action === 'load' ? 'Load' : confirmAction.action === 'update' ? 'Update' : 'Unload'} Model
                        </span>
                    </div>
                    <p className="text-dark-400 text-sm mb-6">
                        {(() => {
                            const catalog = confirmAction.host === 'ellie' ? ellieCatalog : sparkyCatalog;
                            const model = catalog.find(m => m.id === confirmAction.model);
                            const name = model?.display_name || confirmAction.model;
                            const hostLabel = confirmAction.host === 'ellie' ? 'Ellie' : 'Sparky';
                            if (confirmAction.action === 'load') {
                                return `Start a container for "${name}" on ${hostLabel}? This will allocate GPU memory.`;
                            }
                            if (confirmAction.action === 'update') {
                                return `Update "${name}" on ${hostLabel}? This will unload the model, clear its cache, and reload it from HuggingFace.`;
                            }
                            return `Stop and remove the container for "${name}" on ${hostLabel}? Active requests will be terminated.`;
                        })()}
                    </p>
                    <div className="flex gap-3 justify-end">
                        <button
                            onClick={() => setConfirmAction(null)}
                            className="px-4 py-2 text-dark-400 hover:text-white text-sm font-medium rounded-lg hover:bg-dark-800 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => {
                                if (confirmAction.action === 'load') handleLoad(confirmAction.host, confirmAction.model);
                                else if (confirmAction.action === 'update') handleUpdate(confirmAction.host, confirmAction.model);
                                else handleUnload(confirmAction.host, confirmAction.model);
                            }}
                            className={`px-4 py-2 text-sm font-bold rounded-lg transition-colors ${confirmAction.action === 'load'
                                ? 'bg-accent-cyan hover:bg-accent-cyan/90 text-dark-950'
                                : confirmAction.action === 'update'
                                ? 'bg-blue-500 hover:bg-blue-500/90 text-white'
                                : 'bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30'
                                }`}
                        >
                            {confirmAction.action === 'load' ? 'Load Model' : confirmAction.action === 'update' ? 'Update Model' : 'Unload Model'}
                        </button>
                    </div>
                </div>
            )}

            {/* Side-by-side grid */}
            <div className="grid grid-cols-2 gap-6">
                {/* ==================== ELLIE ==================== */}
                <HostColumn
                    hostKey="ellie"
                    label="Ellie"
                    backendLabel="llama.cpp"
                    catalog={ellieCatalog}
                    vram={ellieVram}
                    aiService={ellieAiService}
                    actionLoading={actionLoading}
                    expandedModel={expandedEllie}
                    setExpandedModel={setExpandedEllie}
                    openLogs={openLogs}
                    logsAutoRefresh={logsAutoRefresh}
                    setLogsAutoRefresh={setLogsAutoRefresh}
                    onConfirmAction={setConfirmAction}
                    onToggleLogs={toggleLogs}
                    onRefreshLog={refreshSingleLog}
                    paramPanel={(model) => {
                        const params = llamaParams[model.id];
                        if (!params) return null;
                        const totalVramMb = ellieVram?.totalMb || 0;
                        const vramEstMb = model.vram_base
                            ? estimateVram(model.vram_base, params.ctx_size, model.vram_per_1k_ctx || 0, params.cache_type)
                            : 0;
                        return (
                            <LlamaParamPanel
                                model={model}
                                params={params}
                                totalVramMb={totalVramMb}
                                vramEstMb={vramEstMb}
                                onChange={(p) => setLlamaParams(prev => ({ ...prev, [model.id]: p }))}
                            />
                        );
                    }}
                    getVramEst={(model) => {
                        const params = llamaParams[model.id];
                        if (!params || !model.vram_base) return 0;
                        return estimateVram(model.vram_base, params.ctx_size, model.vram_per_1k_ctx || 0, params.cache_type);
                    }}
                />

                {/* ==================== SPARKY ==================== */}
                <HostColumn
                    hostKey="sparky"
                    label="Sparky"
                    backendLabel="vLLM"
                    catalog={sparkyCatalog}
                    vram={sparkyVram}
                    aiService={sparkyAiService}
                    actionLoading={actionLoading}
                    expandedModel={expandedSparky}
                    setExpandedModel={setExpandedSparky}
                    openLogs={openLogs}
                    logsAutoRefresh={logsAutoRefresh}
                    setLogsAutoRefresh={setLogsAutoRefresh}
                    onConfirmAction={setConfirmAction}
                    onToggleLogs={toggleLogs}
                    onRefreshLog={refreshSingleLog}
                    paramPanel={(model) => {
                        const params = vllmParams[model.id];
                        if (!params) return null;
                        const totalVramMb = sparkyVram?.totalMb || 0;
                        const vramEstMb = model.vram_base
                            ? estimateVram(model.vram_base, params.ctx_size, model.vram_per_1k_ctx || 0, params.kv_cache_dtype)
                            : 0;
                        return (
                            <VllmParamPanel
                                model={model}
                                params={params}
                                totalVramMb={totalVramMb}
                                vramEstMb={vramEstMb}
                                onChange={(p) => setVllmParams(prev => ({ ...prev, [model.id]: p }))}
                            />
                        );
                    }}
                    getVramEst={(model) => {
                        const params = vllmParams[model.id];
                        if (!params || !model.vram_base) return 0;
                        return estimateVram(model.vram_base, params.ctx_size, model.vram_per_1k_ctx || 0, params.kv_cache_dtype);
                    }}
                    sparkyGpuUsed={sparkyGpuUsed}
                    gpuMax={gpuMax}
                />
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Unified Host Column
// ---------------------------------------------------------------------------
function HostColumn({
    hostKey, label, backendLabel, catalog, vram, aiService,
    actionLoading, expandedModel, setExpandedModel,
    openLogs, logsAutoRefresh, setLogsAutoRefresh,
    onConfirmAction, onToggleLogs, onRefreshLog,
    paramPanel, getVramEst,
    sparkyGpuUsed, gpuMax,
}: {
    hostKey: HostKey;
    label: string;
    backendLabel: string;
    catalog: ManagerModelCatalogEntry[];
    vram: GpuVram | undefined;
    aiService: AiServiceMetrics | undefined;
    actionLoading: string | null;
    expandedModel: string | null;
    setExpandedModel: (id: string | null) => void;
    openLogs: Record<string, { content: string; loading: boolean }>;
    logsAutoRefresh: boolean;
    setLogsAutoRefresh: (v: boolean) => void;
    onConfirmAction: (a: { model: string; action: 'load' | 'unload' | 'update'; host: HostKey }) => void;
    onToggleLogs: (host: HostKey, modelId: string) => void;
    onRefreshLog: (host: HostKey, modelId: string) => void;
    paramPanel: (model: ManagerModelCatalogEntry) => React.ReactNode;
    getVramEst: (model: ManagerModelCatalogEntry) => number;
    sparkyGpuUsed?: number;
    gpuMax?: number;
}) {
    return (
        <div className="bg-dark-900 border border-dark-800 rounded-2xl overflow-hidden shadow-lg">
            <div className="p-5 border-b border-dark-800 bg-dark-900/50 flex items-center justify-between">
                <h3 className="font-bold text-sm uppercase text-dark-500 tracking-wider">{label} &mdash; {backendLabel}</h3>
                <div className="flex items-center gap-3">
                    <Cpu size={14} className="text-accent-cyan" />
                    {vram && vram.totalMb > 0 ? (
                        <>
                            <span className="text-[10px] font-mono text-dark-400">
                                VRAM {(vram.usedMb / 1024).toFixed(1)}G / {(vram.totalMb / 1024).toFixed(1)}G
                            </span>
                            <div className="w-24 h-2 bg-dark-800 rounded-full overflow-hidden border border-dark-700/50">
                                <div
                                    className={`h-full rounded-full transition-all duration-500 ${
                                        (vram.usedMb / vram.totalMb) > 0.9 ? 'bg-red-500' :
                                        (vram.usedMb / vram.totalMb) > 0.75 ? 'bg-yellow-500' :
                                        'bg-accent-cyan'
                                    }`}
                                    style={{ width: `${(vram.usedMb / vram.totalMb) * 100}%` }}
                                />
                            </div>
                        </>
                    ) : sparkyGpuUsed !== undefined && gpuMax !== undefined ? (
                        <>
                            <span className="text-[10px] font-mono text-dark-400">
                                GPU {(sparkyGpuUsed * 100).toFixed(0)}% / {(gpuMax * 100).toFixed(0)}%
                            </span>
                            <div className="w-24 h-2 bg-dark-800 rounded-full overflow-hidden border border-dark-700/50">
                                <div
                                    className="h-full bg-accent-cyan rounded-full transition-all duration-500"
                                    style={{ width: `${(sparkyGpuUsed / gpuMax) * 100}%` }}
                                />
                            </div>
                        </>
                    ) : null}
                </div>
            </div>

            <div className="divide-y divide-dark-800">
                {catalog.map(model => {
                    const isActive = model.status === 'running' || model.status === 'starting';
                    const isRunning = model.status === 'running';
                    const isStarting = model.status === 'starting';
                    const isError = model.status === 'error';
                    const isExpanded = expandedModel === model.id && !isActive && !isError;
                    const isActionTarget = actionLoading === model.id;
                    const totalVramMb = vram?.totalMb || 0;
                    const vramEstMb = getVramEst(model);
                    const vramExceeded = totalVramMb > 0 && vramEstMb > totalVramMb;

                    // Context size display
                    const ctxDisplay = model.backend === 'llama'
                        ? (model.ctx_size || 0)
                        : (model.max_model_len || 0);

                    const logKey = `${hostKey}:${model.id}`;
                    const showLogsForModel = logKey in openLogs;
                    const modelLogs = openLogs[logKey];

                    return (
                        <div key={model.id} className="group hover:bg-dark-800/30 transition-colors">
                            <div className="p-5">
                                <div className="flex items-center justify-between">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-3 mb-2">
                                            <h4 className="font-bold text-white group-hover:text-accent-cyan transition-colors truncate">
                                                {model.display_name}
                                            </h4>
                                            <StatusBadge status={model.status} />
                                            {model.update_available === true && (
                                                <span className="flex items-center gap-1 bg-blue-500/10 text-blue-400 text-[10px] uppercase font-bold px-2 py-0.5 rounded border border-blue-500/20 flex-shrink-0">
                                                    <ArrowUpCircle size={10} />
                                                    Update
                                                </span>
                                            )}
                                            {model.update_available === false && (
                                                <span title="Up to date" className="flex-shrink-0 flex">
                                                    <CheckCircle2 size={12} className="text-green-500/50" aria-label="Up to date" />
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-3 text-[11px] text-dark-500 flex-wrap">
                                            <span className="font-mono bg-dark-800 px-1.5 py-0.5 rounded border border-dark-700 break-all">
                                                {(() => {
                                                    let name = model.model.replace(/^hf:\/\//, '');
                                                    // hf://org/repo/file.gguf → org/repo
                                                    const parts = name.split('/');
                                                    if (parts.length >= 3) name = parts.slice(0, 2).join('/');
                                                    return name;
                                                })()}
                                            </span>
                                            {(() => {
                                                // GGUF quants: Q4_K_XL, IQ2_M, F16, etc.
                                                const ggufMatch = model.model.match(/[-_]((?:Q|IQ|F|BF)\d[A-Za-z0-9_]*?)(?:\.gguf)?$/i);
                                                if (ggufMatch) return (
                                                    <span className="font-mono text-[10px] bg-purple-500/15 text-purple-400 px-1.5 py-0.5 rounded border border-purple-500/20">
                                                        {ggufMatch[1]}
                                                    </span>
                                                );
                                                // vLLM quants: FP8, FP4, NVFP4, AWQ-4bit, GPTQ-Int4, etc.
                                                const vllmMatch = model.model.match(/[-_]((?:NV)?FP\d|AWQ[-_]?\d*bit|GPTQ[-_]?(?:Int)?\d+|EXL\d|GGUF)(?:$|[-_])/i);
                                                if (vllmMatch) return (
                                                    <span className="font-mono text-[10px] bg-purple-500/15 text-purple-400 px-1.5 py-0.5 rounded border border-purple-500/20">
                                                        {vllmMatch[1]}
                                                    </span>
                                                );
                                                return null;
                                            })()}
                                            <span>Port {model.port}</span>
                                            {model.backend === 'vllm' && model.gpu_memory !== undefined && (
                                                <span>GPU {(model.gpu_memory * 100).toFixed(0)}%</span>
                                            )}
                                            <span>CTX {(ctxDisplay / 1024).toFixed(0)}K</span>
                                            {model.backend === 'llama' && (
                                                <>
                                                    <span>P{model.parallel || 1}</span>
                                                    <span>KV {model.cache_type || 'f16'}</span>
                                                </>
                                            )}
                                        </div>
                                        {model.error && (
                                            <div className="mt-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-1.5">
                                                {model.error}
                                            </div>
                                        )}
                                        {isStarting && model.progress != null && (
                                            <div className="mt-2">
                                                <div className="flex items-center justify-between text-[11px] mb-1">
                                                    <span className="text-accent-cyan">{model.progress_msg || 'Starting...'}</span>
                                                    <span className="text-dark-400">{model.progress}%</span>
                                                </div>
                                                <div className="w-full h-1.5 bg-dark-700 rounded-full overflow-hidden">
                                                    <div
                                                        className="h-full bg-accent-cyan rounded-full transition-all duration-500"
                                                        style={{ width: `${model.progress}%` }}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                                        {/* Logs button */}
                                        {(isActive || isError) && (
                                            <button
                                                onClick={() => onToggleLogs(hostKey, model.id)}
                                                className={`flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium rounded-lg transition-colors ${showLogsForModel ? 'text-accent-cyan bg-dark-800' : 'text-dark-400 hover:text-accent-cyan hover:bg-dark-800'}`}
                                                title="View container logs"
                                            >
                                                <ScrollText size={13} />
                                            </button>
                                        )}

                                        {!isActive && !isError && model.vram_base > 0 && (
                                            <button
                                                onClick={() => setExpandedModel(isExpanded ? null : model.id)}
                                                className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium text-dark-400 hover:text-accent-cyan rounded-lg hover:bg-dark-800 transition-colors"
                                                title="Adjust parameters"
                                            >
                                                <Settings2 size={13} />
                                                {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                                            </button>
                                        )}

                                        {isRunning && (
                                            <button
                                                onClick={() => onConfirmAction({ model: model.id, action: 'unload', host: hostKey })}
                                                disabled={isActionTarget}
                                                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg transition-colors disabled:opacity-50"
                                            >
                                                {isActionTarget ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
                                                Unload
                                            </button>
                                        )}

                                        {isStarting && (
                                            <div className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-yellow-500 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                                                <Loader2 size={14} className="animate-spin" />
                                                Starting...
                                            </div>
                                        )}

                                        {model.update_available === true && !isStarting && (
                                            <button
                                                onClick={() => onConfirmAction({ model: model.id, action: 'update', host: hostKey })}
                                                disabled={isActionTarget}
                                                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 rounded-lg transition-colors disabled:opacity-50"
                                            >
                                                {isActionTarget ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpCircle size={14} />}
                                                Update
                                            </button>
                                        )}

                                        {(model.status === 'stopped' || isError) && (
                                            <button
                                                onClick={() => onConfirmAction({ model: model.id, action: 'load', host: hostKey })}
                                                disabled={isActionTarget || vramExceeded}
                                                className="flex items-center gap-2 px-3 py-1.5 text-sm font-bold text-dark-950 bg-accent-cyan hover:bg-accent-cyan/90 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                title={vramExceeded ? 'Estimated VRAM exceeds GPU memory' : ''}
                                            >
                                                {isActionTarget ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                                                Load
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Parameter Panel */}
                            {isExpanded && paramPanel(model)}

                            {/* Live AI Metrics Panel */}
                            {isRunning && aiService && aiService.status === 'ready' && (
                                <LiveMetricsPanel aiService={aiService} backend={model.backend} />
                            )}

                            {/* Container Logs Panel */}
                            {showLogsForModel && modelLogs && (
                                <LogsPanel
                                    host={hostKey}
                                    modelId={model.id}
                                    content={modelLogs.content}
                                    loading={modelLogs.loading}
                                    autoRefresh={logsAutoRefresh}
                                    setAutoRefresh={setLogsAutoRefresh}
                                    onRefresh={() => onRefreshLog(hostKey, model.id)}
                                />
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Llama Parameter Panel
// ---------------------------------------------------------------------------
function LlamaParamPanel({ model, params, totalVramMb, vramEstMb, onChange }: {
    model: ManagerModelCatalogEntry;
    params: LlamaParams;
    totalVramMb: number;
    vramEstMb: number;
    onChange: (p: LlamaParams) => void;
}) {
    const maxCtx = model.max_ctx || 131072;
    const vramExceeded = totalVramMb > 0 && vramEstMb > totalVramMb;
    const vramPct = totalVramMb > 0 ? (vramEstMb / totalVramMb) * 100 : 0;

    return (
        <div className="px-5 pb-5 pt-2 border-t border-dark-800/50 bg-dark-950/30 animate-in slide-in-from-top-1 duration-200">
            <div className="grid grid-cols-3 gap-4 mb-3">
                <div>
                    <label className="block text-[10px] uppercase font-bold text-dark-500 mb-1">Context</label>
                    <div className="flex items-center gap-1">
                        <input
                            type="number"
                            min={1}
                            max={maxCtx / 1024}
                            value={Math.round(params.ctx_size / 1024)}
                            onChange={(e) => {
                                const k = Math.max(1, Math.min(maxCtx / 1024, Number(e.target.value) || 1));
                                onChange({ ...params, ctx_size: k * 1024 });
                            }}
                            className="w-20 bg-dark-800 border border-dark-700 rounded px-2 py-1 text-sm font-mono text-white focus:border-accent-cyan focus:outline-none"
                        />
                        <span className="text-[11px] text-dark-500">K</span>
                        <span className="text-[10px] text-dark-600 ml-1">/ {maxCtx / 1024}K max</span>
                    </div>
                </div>
                <div>
                    <label className="block text-[10px] uppercase font-bold text-dark-500 mb-1">Parallel</label>
                    <input
                        type="number"
                        min={1}
                        max={8}
                        value={params.parallel}
                        onChange={(e) => onChange({ ...params, parallel: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })}
                        className="w-16 bg-dark-800 border border-dark-700 rounded px-2 py-1 text-sm font-mono text-white focus:border-accent-cyan focus:outline-none"
                    />
                </div>
                <div>
                    <label className="block text-[10px] uppercase font-bold text-dark-500 mb-1">KV Cache</label>
                    <select
                        value={params.cache_type}
                        onChange={(e) => onChange({ ...params, cache_type: e.target.value })}
                        className="bg-dark-800 border border-dark-700 rounded px-2 py-1 text-sm font-mono text-white focus:border-accent-cyan focus:outline-none"
                    >
                        <option value="f16">f16</option>
                        <option value="q8_0">q8_0</option>
                        <option value="q4_0">q4_0</option>
                    </select>
                </div>
            </div>
            {totalVramMb > 0 && vramEstMb > 0 && (
                <VramBar estimateMb={vramEstMb} totalMb={totalVramMb} exceeded={vramExceeded} pct={vramPct} />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// vLLM Parameter Panel
// ---------------------------------------------------------------------------
function VllmParamPanel({ model, params, totalVramMb, vramEstMb, onChange }: {
    model: ManagerModelCatalogEntry;
    params: VllmParams;
    totalVramMb: number;
    vramEstMb: number;
    onChange: (p: VllmParams) => void;
}) {
    const maxCtx = model.max_ctx || (model.max_model_len || 131072);
    const vramExceeded = totalVramMb > 0 && vramEstMb > totalVramMb;
    const vramPct = totalVramMb > 0 ? (vramEstMb / totalVramMb) * 100 : 0;

    return (
        <div className="px-5 pb-5 pt-2 border-t border-dark-800/50 bg-dark-950/30 animate-in slide-in-from-top-1 duration-200">
            <div className="grid grid-cols-3 gap-4 mb-3">
                <div>
                    <label className="block text-[10px] uppercase font-bold text-dark-500 mb-1">Context</label>
                    <div className="flex items-center gap-1">
                        <input
                            type="number"
                            min={1}
                            max={maxCtx / 1024}
                            value={Math.round(params.ctx_size / 1024)}
                            onChange={(e) => {
                                const k = Math.max(1, Math.min(maxCtx / 1024, Number(e.target.value) || 1));
                                onChange({ ...params, ctx_size: k * 1024 });
                            }}
                            className="w-20 bg-dark-800 border border-dark-700 rounded px-2 py-1 text-sm font-mono text-white focus:border-accent-cyan focus:outline-none"
                        />
                        <span className="text-[11px] text-dark-500">K</span>
                        <span className="text-[10px] text-dark-600 ml-1">/ {maxCtx / 1024}K max</span>
                    </div>
                </div>
                <div>
                    <label className="block text-[10px] uppercase font-bold text-dark-500 mb-1">Max Seqs</label>
                    <input
                        type="number"
                        min={1}
                        max={256}
                        value={params.max_num_seqs}
                        onChange={(e) => onChange({ ...params, max_num_seqs: Math.max(1, Math.min(256, Number(e.target.value) || 1)) })}
                        className="w-16 bg-dark-800 border border-dark-700 rounded px-2 py-1 text-sm font-mono text-white focus:border-accent-cyan focus:outline-none"
                    />
                </div>
                <div>
                    <label className="block text-[10px] uppercase font-bold text-dark-500 mb-1">KV Cache</label>
                    <select
                        value={params.kv_cache_dtype}
                        onChange={(e) => onChange({ ...params, kv_cache_dtype: e.target.value })}
                        className="bg-dark-800 border border-dark-700 rounded px-2 py-1 text-sm font-mono text-white focus:border-accent-cyan focus:outline-none"
                    >
                        <option value="auto">auto</option>
                        <option value="fp8">fp8</option>
                    </select>
                </div>
            </div>
            {totalVramMb > 0 && vramEstMb > 0 && (
                <VramBar estimateMb={vramEstMb} totalMb={totalVramMb} exceeded={vramExceeded} pct={vramPct} />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// VRAM Indicator Bar
// ---------------------------------------------------------------------------
function VramBar({ estimateMb, totalMb, exceeded, pct }: {
    estimateMb: number;
    totalMb: number;
    exceeded: boolean;
    pct: number;
}) {
    return (
        <div className="flex items-center gap-3">
            <span className={`text-[11px] font-mono ${exceeded ? 'text-red-400' : 'text-dark-400'}`}>
                ~{(estimateMb / 1024).toFixed(1)} GB / {(totalMb / 1024).toFixed(1)} GB
            </span>
            <div className="flex-1 h-2 bg-dark-800 rounded-full overflow-hidden border border-dark-700/50">
                <div
                    className={`h-full rounded-full transition-all duration-300 ${
                        exceeded ? 'bg-red-500' : pct > 85 ? 'bg-yellow-500' : 'bg-accent-cyan'
                    }`}
                    style={{ width: `${Math.min(pct, 100)}%` }}
                />
            </div>
            {exceeded && (
                <span className="text-[10px] font-bold text-red-400">EXCEEDS VRAM</span>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Unified Live Metrics Panel (throughput, requests, KV cache)
// ---------------------------------------------------------------------------
function LiveMetricsPanel({ aiService, backend }: { aiService: AiServiceMetrics; backend: string }) {
    const isVllm = backend === 'vllm';
    const smoothedGenTPS = useSmoothedValue(aiService.predicted_tokens_seconds || 0, 100);
    const requestsRunning = aiService.requests_processing || 0;
    const requestsWaiting = aiService.requests_deferred || 0;

    // KV cache (backend-aware source)
    const slots = aiService.slots || [];
    let kvCached: number, kvTotal: number, kvPercent: number;
    if (isVllm) {
        const poolTokens = (aiService as any).kv_cache_pool_tokens || 0;
        const usageRatio = aiService.kv_cache_usage_ratio || 0;
        kvTotal = poolTokens;
        kvCached = Math.round(usageRatio * poolTokens);
        kvPercent = usageRatio * 100;
    } else {
        kvCached = slots.reduce((sum, s) => sum + (s.tokens_cached || 0), 0);
        kvTotal = slots.length > 0 ? (slots[0]?.n_ctx || 0) : (aiService.kv_cache_tokens || aiService.n_ctx || 0);
        kvPercent = kvTotal > 0 ? (kvCached / kvTotal) * 100 : 0;
    }

    // vLLM-specific extras
    const avgTTFT = (aiService as any).avg_time_to_first_token_seconds || 0;
    const prefixHitRate = (aiService as any).prefix_cache_hit_rate || 0;

    const slotColors = [
        'bg-cyan-500', 'bg-purple-500', 'bg-emerald-500',
        'bg-amber-500', 'bg-rose-500', 'bg-indigo-500',
    ];

    return (
        <div className="px-5 pb-5 pt-3 border-t border-dark-800/50 bg-dark-950/30">
            {/* Row 1: Gen T/s + Requests */}
            <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="flex flex-col">
                    <span className="text-xs text-dark-500 mb-0.5">Gen</span>
                    <div className="flex items-baseline gap-1">
                        <span className="text-xl font-bold text-accent-cyan font-mono">
                            {smoothedGenTPS.toFixed(1)}
                        </span>
                        <span className="text-xs text-dark-400 font-mono">T/s</span>
                    </div>
                </div>
                <div className="flex flex-col border-l border-dark-700 pl-3">
                    <span className="text-xs text-dark-500 mb-0.5">Requests</span>
                    <div className="flex items-baseline gap-2">
                        <span className="text-xl font-bold text-white font-mono">{requestsRunning}</span>
                        <span className="text-xs text-dark-400">active</span>
                        {requestsWaiting > 0 && (
                            <>
                                <span className="text-dark-600">|</span>
                                <span className="text-sm font-bold text-yellow-400 font-mono">{requestsWaiting}</span>
                                <span className="text-xs text-dark-400">queued</span>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Row 2 (vLLM): TTFT + Prefix Cache */}
            {isVllm && (
                <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="flex flex-col">
                        <span className="text-xs text-dark-500 mb-0.5">Time to First Token</span>
                        <div className="flex items-baseline gap-1">
                            <span className="text-sm font-bold text-white font-mono">
                                {avgTTFT > 0 ? (avgTTFT * 1000).toFixed(0) : '-'}
                            </span>
                            <span className="text-xs text-dark-400 font-mono">ms</span>
                        </div>
                    </div>
                    <div className="flex flex-col border-l border-dark-700 pl-3">
                        <span className="text-xs text-dark-500 mb-0.5">Prefix Cache</span>
                        <div className="flex items-baseline gap-1">
                            <span className="text-sm font-bold text-white font-mono">
                                {(prefixHitRate * 100).toFixed(0)}%
                            </span>
                            <span className="text-xs text-dark-400">hit rate</span>
                        </div>
                    </div>
                </div>
            )}

            {/* KV Cache Bar */}
            {kvTotal > 0 && (
                <>
                    <div className="flex justify-between items-center mb-1">
                        <span className="text-xs text-dark-500">
                            KV Cache <span className="text-dark-600">({kvPercent.toFixed(0)}%)</span>
                        </span>
                        <span className="text-xs text-dark-400 font-mono">
                            {kvCached.toLocaleString()} / {kvTotal.toLocaleString()}
                        </span>
                    </div>

                    {/* Multi-slot stacked bar for llama */}
                    {!isVllm && slots.length > 1 ? (
                        <div className="w-full bg-dark-700 rounded-full h-2 mb-2 overflow-hidden flex">
                            {slots.map((slot, idx) => {
                                const slotCached = slot.tokens_cached || 0;
                                const slotPct = kvTotal > 0 ? (slotCached / kvTotal) * 100 : 0;
                                if (slotPct <= 0) return null;
                                return (
                                    <div
                                        key={slot.id}
                                        className={`h-2 transition-all duration-300 ${slotColors[idx % slotColors.length]} ${slot.state !== 'idle' ? 'animate-pulse' : ''}`}
                                        style={{ width: `${slotPct}%` }}
                                        title={`Slot ${slot.id}: ${slotCached.toLocaleString()} tokens`}
                                    />
                                );
                            })}
                        </div>
                    ) : (
                        <div className="h-2 w-full bg-dark-700 rounded-full overflow-hidden mb-2">
                            <div
                                className={`h-full transition-all duration-300 ${kvPercent >= 90 ? 'bg-red-500' : kvPercent >= 70 ? 'bg-yellow-500' : 'bg-cyan-500'}`}
                                style={{ width: `${kvPercent}%` }}
                            />
                        </div>
                    )}

                    {/* Per-slot detail rows for llama */}
                    {!isVllm && slots.length > 0 && (
                        <div className="flex flex-col gap-1">
                            {slots.map((slot, idx) => (
                                <SlotRow key={slot.id} slot={slot} idx={idx} slotColors={slotColors} />
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function SlotRow({ slot, idx, slotColors }: {
    slot: SlotMetrics;
    idx: number;
    slotColors: string[];
}) {
    const slotCached = slot.tokens_cached || 0;
    const slotUsagePercent = slot.kv_cache?.utilization
        ? slot.kv_cache.utilization * 100
        : (slot.n_ctx > 0 ? (slotCached / slot.n_ctx * 100) : 0);
    const slotTPS = slot.performance?.generation_tokens_per_sec
        || (slot.predicted_ms > 0 ? (slot.predicted_n / (slot.predicted_ms / 1000)) : 0);
    const isActive = slot.state !== 'idle';

    return (
        <div
            className={`flex flex-col gap-1 border-l-2 pl-2 py-1 transition-colors ${isActive ? 'border-cyan-500 bg-cyan-500/5' : 'border-dark-600'}`}
            title={`Slot ${slot.id}: ${slotCached.toLocaleString()} cells cached. ${slotTPS.toFixed(1)} T/s`}
        >
            <div className="flex justify-between items-start">
                <div className="flex flex-col">
                    <div className="flex items-center gap-1.5">
                        <span className={`inline-block w-2 h-2 rounded-full ${slotColors[idx % slotColors.length]}`} />
                        <span className="text-dark-400 font-semibold text-xs">Slot {slot.id}</span>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ml-0.5 mt-0.5 inline-block ${isActive ? 'bg-cyan-500/20 text-cyan-400' : 'bg-dark-700 text-dark-500'}`}>
                        {slot.state.toLowerCase()}
                    </span>
                </div>
                <div className="font-mono text-dark-300 text-[10px]">
                    {slotCached.toLocaleString()} <span className="text-dark-500">/</span> {slot.n_ctx.toLocaleString()} <span className="text-dark-600 text-[9px]">({slotUsagePercent.toFixed(1)}%)</span>
                </div>
            </div>
            <div className="flex justify-between items-center text-[10px] font-mono pl-3 text-dark-500">
                <div>
                    <span className="text-accent-cyan">{slotTPS.toFixed(1)}</span> T/s
                    {slot.performance?.prompt_tokens_per_sec && (
                        <span className="text-dark-600 ml-1">
                            (P: {slot.performance.prompt_tokens_per_sec.toFixed(0)})
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Status Badge
// ---------------------------------------------------------------------------
const StatusBadge = ({ status }: { status: string }) => {
    switch (status) {
        case 'running':
            return (
                <span className="flex items-center gap-1 bg-green-500/10 text-green-400 text-[10px] uppercase font-bold px-2 py-0.5 rounded border border-green-500/20 flex-shrink-0">
                    <CheckCircle2 size={10} />
                    Running
                </span>
            );
        case 'starting':
            return (
                <span className="flex items-center gap-1 bg-yellow-500/10 text-yellow-500 text-[10px] uppercase font-bold px-2 py-0.5 rounded border border-yellow-500/20 animate-pulse flex-shrink-0">
                    <Clock size={10} />
                    Starting
                </span>
            );
        case 'error':
            return (
                <span className="flex items-center gap-1 bg-red-500/10 text-red-400 text-[10px] uppercase font-bold px-2 py-0.5 rounded border border-red-500/20 flex-shrink-0">
                    <AlertTriangle size={10} />
                    Error
                </span>
            );
        default:
            return (
                <span className="text-[10px] uppercase font-bold text-dark-500 bg-dark-800 px-2 py-0.5 rounded border border-dark-700 flex-shrink-0">
                    Not Loaded
                </span>
            );
    }
};

// ---------------------------------------------------------------------------
// Logs Panel (auto-scrolling)
// ---------------------------------------------------------------------------
function LogsPanel({ content, loading, autoRefresh, setAutoRefresh, onRefresh }: {
    host: HostKey;
    modelId: string;
    content: string;
    loading: boolean;
    autoRefresh: boolean;
    setAutoRefresh: (v: boolean) => void;
    onRefresh: () => void;
}) {
    const endRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (autoRefresh && endRef.current) {
            endRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [content, autoRefresh]);

    return (
        <div className="border-t border-dark-800/50 bg-dark-950/30">
            <div className="flex items-center justify-between px-4 py-2 border-b border-dark-800/50">
                <span className="text-xs font-bold uppercase text-dark-500">Container Logs</span>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setAutoRefresh(!autoRefresh)}
                        className={`text-[10px] font-medium px-2 py-0.5 rounded transition-colors ${autoRefresh ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30' : 'text-dark-500 hover:text-dark-300 border border-dark-700'}`}
                        title={autoRefresh ? 'Disable auto-refresh' : 'Enable auto-refresh'}
                    >
                        {autoRefresh ? 'Auto' : 'Manual'}
                    </button>
                    <button
                        onClick={onRefresh}
                        disabled={loading}
                        className="text-dark-400 hover:text-accent-cyan p-1 rounded hover:bg-dark-800 transition-colors disabled:opacity-50"
                        title="Refresh logs"
                    >
                        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>
            </div>
            <pre className="px-4 py-3 text-[11px] font-mono text-dark-300 overflow-x-auto overflow-y-auto max-h-64 whitespace-pre-wrap break-all leading-relaxed">
                {loading && !content ? 'Loading...' : content}
                <div ref={endRef} />
            </pre>
        </div>
    );
}
