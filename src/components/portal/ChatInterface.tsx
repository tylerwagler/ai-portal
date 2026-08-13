import React, { useState, useRef, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { SSEDecoder } from '../../lib/sse';
import { Send, Loader2, AlertCircle, Zap, User, Bot, Activity, ChevronDown, ChevronRight, Brain, CheckCircle, XCircle, Clock, Save, FolderOpen, Plus, Trash2 } from 'lucide-react';

interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string;
    thinking?: string;
    isThinkingComplete?: boolean;
    timestamp: Date;
}

interface ChatMetrics {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    messageCount: number;
}

type ModelStatus = 'checking' | 'loaded' | 'loading' | 'error' | 'unknown';

interface ChatSession {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
}

interface ChatModel {
    id: string;
    alias: string;
    backend: string;
    host: string;
    is_local: boolean;
}

export const ChatInterface = () => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [webChatKey, setWebChatKey] = useState<string>('');
    const [model, setModel] = useState('');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());
    const [modelStatus, setModelStatus] = useState<ModelStatus>('checking');
    const [modelInfo, setModelInfo] = useState<string>('');
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
    const [showSessions, setShowSessions] = useState(false);
    const [availableModels, setAvailableModels] = useState<ChatModel[]>([]);
    const [showModelPicker, setShowModelPicker] = useState(false);
    const modelPickerRef = useRef<HTMLDivElement>(null);
    const [metrics, setMetrics] = useState<ChatMetrics>({
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        messageCount: 0
    });

    const toggleThinking = (index: number) => {
        setExpandedThinking(prev => {
            const next = new Set(prev);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    };

    // Model loading is now handled via the Hardware tab
    // const loadModel = async (modelId: string) => { ... };

    const fetchSessions = async () => {
        const { data, error } = await supabase
            .from('chat_sessions')
            .select('*')
            .order('updated_at', { ascending: false });

        if (error) {
            console.error('Error fetching sessions:', error);
        } else {
            setSessions(data || []);
        }
    };

    const createNewSession = async () => {
        if (messages.length === 0) {
            // Just clear for a fresh start
            setCurrentSessionId(null);
            return;
        }

        // Generate title from first user message
        const firstUserMessage = messages.find(m => m.role === 'user');
        const title = firstUserMessage
            ? firstUserMessage.content.substring(0, 50) + (firstUserMessage.content.length > 50 ? '...' : '')
            : 'New Chat';

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        const { data, error } = await supabase
            .from('chat_sessions')
            .insert([{ user_id: user.id, title }])
            .select()
            .single();

        if (error) {
            console.error('Error creating session:', error);
            setError('Failed to create session');
        } else {
            setCurrentSessionId(data.id);
            setSessions(prev => [data, ...prev]);

            // Save current messages to the new session
            await saveMessagesToSession(data.id);
        }
    };

    const saveMessagesToSession = async (sessionId: string) => {
        if (messages.length === 0) return;

        const messagesToSave = messages.map(msg => ({
            session_id: sessionId,
            role: msg.role,
            content: msg.content,
            thinking: msg.thinking || null,
            created_at: msg.timestamp.toISOString()
        }));

        const { error } = await supabase
            .from('chat_messages')
            .insert(messagesToSave);

        if (error) {
            console.error('Error saving messages:', error);
            setError('Failed to save messages');
        }
    };

    const loadSession = async (sessionId: string) => {
        const { data, error } = await supabase
            .from('chat_messages')
            .select('*')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true });

        if (error) {
            console.error('Error loading session:', error);
            setError('Failed to load session');
        } else {
            const loadedMessages: Message[] = data.map(msg => ({
                role: msg.role as 'user' | 'assistant' | 'system',
                content: msg.content,
                thinking: msg.thinking,
                isThinkingComplete: true,
                timestamp: new Date(msg.created_at)
            }));

            setMessages(loadedMessages);
            setCurrentSessionId(sessionId);
            setShowSessions(false);
        }
    };

    const deleteSession = async (sessionId: string) => {
        if (!confirm('Delete this chat session?')) return;

        const { error } = await supabase
            .from('chat_sessions')
            .delete()
            .eq('id', sessionId);

        if (error) {
            console.error('Error deleting session:', error);
            setError('Failed to delete session');
        } else {
            setSessions(prev => prev.filter(s => s.id !== sessionId));
            if (currentSessionId === sessionId) {
                setCurrentSessionId(null);
                setMessages([]);
            }
        }
    };

    const fetchApiKeys = async () => {
        const { data, error } = await supabase
            .from('api_keys')
            .select('*')
            .eq('name', 'WebChat')
            .single();

        if (error) {
            console.error('Error fetching WebChat API key:', error);
            setError('Failed to load WebChat API key. Please contact support.');
        } else if (data) {
            setWebChatKey(data.api_key);
        } else {
            setError('WebChat API key not found. Please contact support.');
        }
    };

    const fetchChatModels = useCallback(async () => {
        try {
            const res = await fetch('/api/model/chat-models');
            if (!res.ok) {
                setModelStatus('error');
                setModelInfo('Server unavailable');
                return;
            }
            const models: ChatModel[] = await res.json();
            setAvailableModels(models);

            if (models.length === 0) {
                setModelStatus('error');
                setModelInfo('No models ready');
                return;
            }

            setModelStatus('loaded');

            // Auto-select first model if none selected or current selection went offline
            if (!model || !models.find(m => m.id === model)) {
                setModel(models[0].id);
                setModelInfo(models[0].alias);
            } else {
                const selected = models.find(m => m.id === model);
                if (selected) setModelInfo(selected.alias);
            }
        } catch {
            setModelStatus('error');
            setModelInfo('Cannot connect to server');
        }
    }, [model]);

    useEffect(() => {
        fetchApiKeys();
        fetchSessions();
    }, []);

    useEffect(() => {
        fetchChatModels();
        const interval = setInterval(fetchChatModels, 10000);
        return () => clearInterval(interval);
    }, [fetchChatModels]);

    // Close model picker on outside click
    useEffect(() => {
        if (!showModelPicker) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
                setShowModelPicker(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [showModelPicker]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const parseThinkingTags = (content: string): { content: string; thinking?: string; isThinkingComplete?: boolean } => {
        // Check for complete thinking blocks first
        const completeThinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
        const completeMatches = content.match(completeThinkingRegex);

        if (completeMatches) {
            // Extract complete thinking content
            const thinking = completeMatches
                .map(match => match.replace(/<\/?thinking>/g, '').trim())
                .join('\n\n');

            // Remove thinking tags from main content
            const cleanContent = content.replace(completeThinkingRegex, '').trim();

            return { content: cleanContent, thinking, isThinkingComplete: true };
        }

        // Check for incomplete thinking block (streaming in progress)
        const openThinkingMatch = content.match(/<thinking>([\s\S]*?)$/);
        if (openThinkingMatch) {
            // Extract incomplete thinking content
            const thinking = openThinkingMatch[1];

            // Remove thinking tag and content from main content
            const cleanContent = content.replace(/<thinking>[\s\S]*$/, '').trim();

            return { content: cleanContent, thinking, isThinkingComplete: false };
        }

        // No thinking tags found
        return { content };
    };

    const sendMessage = async () => {
        if (!input.trim() || !webChatKey) return;

        if (!webChatKey) {
            setError('WebChat API key not available');
            return;
        }

        const userMessage: Message = {
            role: 'user',
            content: input.trim(),
            timestamp: new Date()
        };

        setMessages(prev => [...prev, userMessage]);
        setInput('');

        // Refocus input after sending
        setTimeout(() => inputRef.current?.focus(), 0);
        setIsLoading(true);
        setError(null);

        // Create a placeholder for streaming response
        const placeholderIndex = messages.length + 1;
        setMessages(prev => [...prev, {
            role: 'assistant',
            content: '',
            timestamp: new Date()
        }]);

        try {
            const response = await fetch('/llama/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${webChatKey}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        ...messages.map(m => ({ role: m.role, content: m.content })),
                        { role: 'user', content: userMessage.content }
                    ],
                    stream: true,
                    max_tokens: 4096,
                    temperature: 0.7
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.error?.message || `HTTP ${response.status}: ${response.statusText}`);
            }

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let accumulatedContent = '';
            let lastUsage: any = null;

            if (!reader) {
                throw new Error('Response body is not readable');
            }

            // SSE frames are not aligned to network chunks, so decoding is buffered
            // (see SSEDecoder) — parsing each chunk in isolation drops any frame
            // that straddled a boundary.
            const sse = new SSEDecoder();

            const handlePayload = (data: string) => {
                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta?.content;

                    if (delta) {
                        accumulatedContent += delta;

                        // Update the message in real-time
                        setMessages(prev => {
                            const newMessages = [...prev];
                            const { content, thinking, isThinkingComplete } = parseThinkingTags(accumulatedContent);
                            newMessages[placeholderIndex] = {
                                role: 'assistant',
                                content,
                                thinking,
                                isThinkingComplete,
                                timestamp: new Date()
                            };
                            return newMessages;
                        });
                    }

                    // Capture usage data from the final chunk
                    if (parsed.usage) {
                        lastUsage = parsed.usage;
                    }
                } catch {
                    // Skip invalid JSON chunks
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                sse.push(decoder.decode(value, { stream: true })).forEach(handlePayload);
            }

            // Emit a final frame if the stream ended without a trailing newline
            sse.flush().forEach(handlePayload);

            // Update metrics with final usage data
            if (lastUsage) {
                setMetrics(prev => ({
                    totalTokens: prev.totalTokens + (lastUsage.total_tokens || 0),
                    promptTokens: prev.promptTokens + (lastUsage.prompt_tokens || 0),
                    completionTokens: prev.completionTokens + (lastUsage.completion_tokens || 0),
                    messageCount: prev.messageCount + 1
                }));
            }

            // Auto-save to current session if one exists.
            // Build the assistant message from the accumulated stream rather than
            // reading it back out of `messages`: that closure predates this send,
            // so indexing it returned undefined and threw inside the filter.
            if (currentSessionId) {
                const { content: finalContent, thinking: finalThinking } = parseThinkingTags(accumulatedContent);
                const assistantMessage: Message = {
                    role: 'assistant',
                    content: finalContent,
                    thinking: finalThinking,
                    timestamp: new Date()
                };
                const latestMessages = [userMessage, assistantMessage].filter(m => m.content);
                if (latestMessages.length > 0) {
                    const messagesToSave = latestMessages.map(msg => ({
                        session_id: currentSessionId,
                        role: msg.role,
                        content: msg.content,
                        thinking: msg.thinking || null,
                        created_at: msg.timestamp.toISOString()
                    }));

                    await supabase.from('chat_messages').insert(messagesToSave);
                }
            }
        } catch (err: any) {
            console.error('Chat error:', err);
            setError(err.message || 'Failed to send message');
            // Remove the placeholder message on error
            setMessages(prev => prev.slice(0, -1));
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    return (
        <div className="flex flex-col h-full bg-dark-950">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-dark-800/50 bg-dark-900/50 backdrop-blur-md">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-accent-cyan/10 rounded-lg border border-accent-cyan/20">
                        <Bot className="text-accent-cyan" size={20} />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-white tracking-tight">
                            AI Chat
                        </h2>
                        <div ref={modelPickerRef} className="relative mt-1">
                            <button
                                onClick={() => setShowModelPicker(!showModelPicker)}
                                className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-dark-800/50 border border-dark-700/50 hover:border-accent-cyan/30 transition-colors"
                            >
                                {modelStatus === 'loaded' && <CheckCircle size={12} className="text-green-400 flex-shrink-0" />}
                                {modelStatus === 'loading' && <Loader2 size={12} className="text-yellow-400 animate-spin flex-shrink-0" />}
                                {modelStatus === 'checking' && <Clock size={12} className="text-dark-500 animate-pulse flex-shrink-0" />}
                                {modelStatus === 'error' && <XCircle size={12} className="text-red-400 flex-shrink-0" />}
                                {(modelStatus === 'unknown') && <Clock size={12} className="text-dark-500 flex-shrink-0" />}
                                <span className="text-xs text-white font-medium truncate max-w-48">
                                    {modelInfo || 'Select Model'}
                                </span>
                                <ChevronDown size={12} className={`text-dark-400 flex-shrink-0 transition-transform ${showModelPicker ? 'rotate-180' : ''}`} />
                            </button>

                            {showModelPicker && (
                                <div className="absolute top-full left-0 mt-1 w-72 bg-dark-900 border border-dark-700 rounded-lg shadow-xl z-50 overflow-hidden">
                                    {availableModels.length === 0 ? (
                                        <div className="px-4 py-3 text-sm text-dark-500">No models ready</div>
                                    ) : (
                                        availableModels.map(m => (
                                            <button
                                                key={m.id}
                                                onClick={() => {
                                                    setModel(m.id);
                                                    setModelInfo(m.alias);
                                                    setShowModelPicker(false);
                                                }}
                                                className={`w-full px-4 py-2.5 flex items-center gap-3 hover:bg-dark-800/50 transition-colors text-left ${
                                                    model === m.id ? 'bg-accent-cyan/10' : ''
                                                }`}
                                            >
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-sm font-medium text-white truncate">{m.alias}</div>
                                                    <div className="text-[10px] text-dark-500">
                                                        {m.is_local ? 'Ellie' : 'Sparky'} · {m.backend === 'llama' ? 'llama.cpp' : 'vLLM'}
                                                    </div>
                                                </div>
                                                {model === m.id && <CheckCircle size={14} className="text-accent-cyan flex-shrink-0" />}
                                            </button>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <button
                        onClick={() => {
                            setMessages([]);
                            setCurrentSessionId(null);
                            setMetrics({ totalTokens: 0, promptTokens: 0, completionTokens: 0, messageCount: 0 });
                        }}
                        className="p-2 rounded-lg transition-colors text-dark-400 hover:text-accent-cyan hover:bg-dark-800"
                        title="New Chat"
                    >
                        <Plus size={20} />
                    </button>

                    {messages.length > 0 && !currentSessionId && (
                        <button
                            onClick={createNewSession}
                            className="p-2 rounded-lg transition-colors text-dark-400 hover:text-green-400 hover:bg-dark-800"
                            title="Save Chat"
                        >
                            <Save size={20} />
                        </button>
                    )}

                    <button
                        onClick={() => setShowSessions(!showSessions)}
                        className={`p-2 rounded-lg transition-colors ${
                            showSessions
                                ? 'bg-accent-cyan/10 text-accent-cyan'
                                : 'text-dark-400 hover:text-accent-cyan hover:bg-dark-800'
                        }`}
                        title="Chat Sessions"
                    >
                        <FolderOpen size={20} />
                    </button>
                </div>
            </div>

            {/* Sessions Panel */}
            {showSessions && (
                <div className="px-6 py-4 bg-dark-900/30 border-b border-dark-800/50 animate-in slide-in-from-top duration-200">
                    <h3 className="text-xs font-bold uppercase text-dark-500 mb-3 tracking-wider">Saved Sessions</h3>
                    {sessions.length === 0 ? (
                        <p className="text-sm text-dark-500 py-4 text-center">No saved sessions yet</p>
                    ) : (
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                            {sessions.map(session => (
                                <div
                                    key={session.id}
                                    className={`flex items-center justify-between p-3 rounded-lg hover:bg-dark-800/50 transition-colors cursor-pointer ${
                                        currentSessionId === session.id ? 'bg-accent-cyan/10 border border-accent-cyan/20' : 'bg-dark-800/30'
                                    }`}
                                    onClick={() => loadSession(session.id)}
                                >
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-white truncate">{session.title}</p>
                                        <p className="text-[10px] text-dark-500 mt-0.5">
                                            {new Date(session.updated_at).toLocaleDateString()} {new Date(session.updated_at).toLocaleTimeString()}
                                        </p>
                                    </div>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            deleteSession(session.id);
                                        }}
                                        className="ml-2 p-1.5 text-dark-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                                        title="Delete session"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
                {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
                        <div className="p-6 bg-dark-900/50 rounded-2xl border border-dark-800/50">
                            <Zap className="text-accent-cyan mx-auto mb-4" size={48} />
                            <h3 className="text-xl font-bold text-white mb-2">
                                Start a conversation
                            </h3>
                            <p className="text-sm text-dark-400 max-w-md">
                                Your messages are tracked to your account and API key for accurate usage monitoring.
                            </p>
                        </div>
                    </div>
                ) : (
                    <>
                        {messages.map((msg, idx) => (
                            <div
                                key={idx}
                                className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                            >
                                {msg.role === 'assistant' && (
                                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent-cyan/10 border border-accent-cyan/20 flex items-center justify-center">
                                        <Bot className="text-accent-cyan" size={16} />
                                    </div>
                                )}

                                <div className={`max-w-3xl space-y-2 ${msg.role === 'user' ? '' : 'w-full'}`}>
                                    {/* Thinking Section (Assistant only) */}
                                    {msg.role === 'assistant' && msg.thinking && (
                                        <div className="bg-dark-900/50 border border-dark-800/50 rounded-xl overflow-hidden">
                                            <button
                                                onClick={() => toggleThinking(idx)}
                                                className="w-full px-4 py-2 flex items-center gap-2 hover:bg-dark-800/50 transition-colors text-left"
                                            >
                                                {(expandedThinking.has(idx) || !msg.isThinkingComplete) ? (
                                                    <ChevronDown size={16} className="text-purple-400" />
                                                ) : (
                                                    <ChevronRight size={16} className="text-purple-400" />
                                                )}
                                                <Brain size={14} className="text-purple-400" />
                                                <span className="text-xs font-bold text-purple-400 uppercase tracking-wider">
                                                    Thinking
                                                    {!msg.isThinkingComplete && (
                                                        <span className="ml-2 animate-pulse">...</span>
                                                    )}
                                                </span>
                                                <span className="ml-auto text-[10px] text-dark-500">
                                                    {msg.thinking.length} characters
                                                </span>
                                            </button>
                                            {(expandedThinking.has(idx) || !msg.isThinkingComplete) && (
                                                <div className="px-4 py-3 border-t border-dark-800/50 bg-dark-950/50 animate-in slide-in-from-top duration-200">
                                                    <div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-dark-300 font-mono">
                                                        {msg.thinking}
                                                        {!msg.isThinkingComplete && (
                                                            <span className="inline-block w-2 h-3 bg-purple-400 animate-pulse ml-1"></span>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Main Message Content */}
                                    <div
                                        className={`rounded-2xl px-5 py-3 ${
                                            msg.role === 'user'
                                                ? 'bg-accent-cyan/10 border border-accent-cyan/20 text-white'
                                                : 'bg-dark-900 border border-dark-800 text-dark-100'
                                        }`}
                                    >
                                        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                                            {msg.content || (msg.role === 'assistant' && isLoading ? '...' : '')}
                                        </div>
                                        <div className="mt-2 text-[10px] text-dark-500 font-mono">
                                            {msg.timestamp.toLocaleTimeString()}
                                        </div>
                                    </div>
                                </div>

                                {msg.role === 'user' && (
                                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-dark-800 border border-dark-700 flex items-center justify-center">
                                        <User className="text-dark-400" size={16} />
                                    </div>
                                )}
                            </div>
                        ))}
                    </>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Error Display */}
            {error && (
                <div className="mx-6 mb-4 bg-red-500/10 border border-red-500/20 rounded-lg p-4 flex items-start gap-3 animate-in slide-in-from-bottom duration-200">
                    <AlertCircle className="text-red-400 flex-shrink-0 mt-0.5" size={18} />
                    <div className="flex-1">
                        <p className="text-sm font-medium text-red-400">{error}</p>
                    </div>
                    <button
                        onClick={() => setError(null)}
                        className="text-red-400 hover:text-red-300 text-xs font-bold"
                    >
                        Dismiss
                    </button>
                </div>
            )}

            {/* Metrics Bar */}
            {metrics.messageCount > 0 && (
                <div className="px-6 py-3 border-t border-dark-800/50 bg-dark-900/70 backdrop-blur-md">
                    <div className="flex items-center gap-6">
                        <div className="flex items-center gap-2">
                            <Activity className="text-accent-cyan" size={14} />
                            <span className="text-[10px] uppercase font-bold text-dark-500 tracking-wider">Session Stats</span>
                        </div>
                        <div className="flex items-center gap-6 text-xs font-mono">
                            <div className="flex items-center gap-2">
                                <span className="text-dark-500">Messages:</span>
                                <span className="text-white font-bold">{metrics.messageCount}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-dark-500">Total Tokens:</span>
                                <span className="text-accent-cyan font-bold">{metrics.totalTokens.toLocaleString()}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-dark-500">Prompt:</span>
                                <span className="text-white">{metrics.promptTokens.toLocaleString()}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-dark-500">Completion:</span>
                                <span className="text-white">{metrics.completionTokens.toLocaleString()}</span>
                            </div>
                        </div>
                        <button
                            onClick={() => {
                                setMessages([]);
                                setMetrics({ totalTokens: 0, promptTokens: 0, completionTokens: 0, messageCount: 0 });
                            }}
                            className="ml-auto text-xs text-dark-500 hover:text-red-400 transition-colors"
                        >
                            Clear Chat
                        </button>
                    </div>
                </div>
            )}

            {/* Input Area */}
            <div className="px-6 py-4 border-t border-dark-800/50 bg-dark-900/50 backdrop-blur-md">
                {/* Thinking Indicator */}
                {isLoading && (
                    <div className="mb-3 flex items-center gap-2 text-xs text-accent-cyan animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <Loader2 size={14} className="animate-spin" />
                        <span className="font-medium">Generating response...</span>
                    </div>
                )}

                <div className="flex gap-3">
                    <textarea
                        ref={inputRef}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyPress}
                        placeholder={!webChatKey ? "Loading..." : !model ? "Select a model to start chatting..." : "Type your message..."}
                        disabled={isLoading || !webChatKey || !model}
                        className="flex-1 bg-dark-950 border border-dark-800 rounded-xl px-4 py-3 text-white placeholder-dark-500 focus:outline-none focus:border-accent-cyan transition-colors resize-none disabled:opacity-50 disabled:cursor-not-allowed"
                        rows={3}
                    />
                    <button
                        onClick={sendMessage}
                        disabled={isLoading || !input.trim() || !webChatKey || !model}
                        className="px-6 bg-accent-cyan hover:bg-accent-cyan/90 disabled:opacity-50 disabled:cursor-not-allowed text-dark-950 rounded-xl font-bold transition-all active:scale-95 flex items-center justify-center gap-2 shadow-lg shadow-accent-cyan/20"
                    >
                        {isLoading ? (
                            <Loader2 size={20} className="animate-spin" />
                        ) : (
                            <Send size={20} />
                        )}
                    </button>
                </div>
                <p className="mt-2 text-[10px] text-dark-500 text-center">
                    Press Enter to send • Shift+Enter for new line • Usage tracked to your API key
                </p>
            </div>
        </div>
    );
};
