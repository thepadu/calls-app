import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';

// Service worker registration lives in <PwaUpdatePrompt> (mounted inside
// App) instead of here — it needs to gate the reload behind an explicit
// user click rather than vite-plugin-pwa's default silent auto-reload,
// which could otherwise drop a live call or unsaved work. See that
// component for the full reasoning.

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    </React.StrictMode>
);
