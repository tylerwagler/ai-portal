import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Uncaught error:', error, errorInfo);
    }

    public render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen bg-dark-900 text-white flex items-center justify-center p-6">
                    <div className="bg-dark-800 border border-red-900/50 rounded-lg p-8 max-w-lg w-full shadow-2xl">
                        <h2 className="text-2xl font-bold text-red-500 mb-4">Something went wrong</h2>
                        <p className="text-dark-300 mb-6">
                            The application encountered an error while rendering. This is likely due to malformed data from the telemetry API.
                        </p>
                        {/*
                          * Raw error text is shown in development only. In production it can
                          * leak internal paths, endpoint names and schema details, so users
                          * get a generic message and the detail goes to the console instead.
                          */}
                        <div className="bg-dark-900 p-4 rounded border border-dark-700 font-mono text-sm text-red-400 mb-6 overflow-auto max-h-48">
                            {import.meta.env.DEV ? (
                                <>
                                    {this.state.error?.message || 'An unexpected error occurred. Please refresh the page.'}
                                    <br /><br />
                                    <details className="text-dark-400 cursor-pointer">
                                        <summary>Stack trace</summary>
                                        <pre className="text-xs mt-2 whitespace-pre-wrap break-words">
                                            {this.state.error?.stack}
                                        </pre>
                                    </details>
                                </>
                            ) : (
                                'An unexpected error occurred. Please refresh the page.'
                            )}
                        </div>
                        <button
                            onClick={() => window.location.reload()}
                            className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded transition-colors w-full font-semibold"
                        >
                            Reload Dashboard
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
