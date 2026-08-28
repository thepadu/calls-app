import { Suspense, lazy, ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { AuthProvider, useAuth } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './lib/toast';
import { SoftphoneProvider } from './lib/softphone';
import { ActiveCallProvider } from './lib/activeCall';
import Layout from './components/layout/Layout';
import PwaUpdatePrompt from './components/PwaUpdatePrompt';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const LiveQueue = lazy(() => import('./pages/LiveQueue'));
const Calls = lazy(() => import('./pages/Calls'));
const Tickets = lazy(() => import('./pages/Tickets'));
const Contacts = lazy(() => import('./pages/Contacts'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Agents = lazy(() => import('./pages/Agents'));
const IvrEditor = lazy(() => import('./pages/IvrEditor'));
const CallForwarding = lazy(() => import('./pages/CallForwarding'));

function RequireSupervisor({ children }: { children: ReactNode }) {
    const { user, loading, isSupervisor, checkFailed } = useAuth();

    if (loading) return null;
    if (!isSupervisor) {
        return (
            <div className="panel">
                <h3>Supervisors only</h3>
                <p className="hint">
                    {checkFailed
                        ? "Couldn't verify your session — try refreshing."
                        : user
                            ? `Signed in as ${user.email}, role: agent.`
                            : 'Not signed in.'}{' '}
                    This page needs supervisor access.
                </p>
            </div>
        );
    }

    return <>{children}</>;
}

function AppRoutes() {
    return (
        <Suspense fallback={<div className="page-loading">Loading…</div>}>
            <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/queue" element={<LiveQueue />} />
                <Route path="/calls" element={<Calls />} />
                <Route path="/outbound" element={<Navigate to="/calls" replace />} />
                <Route path="/forwarding" element={<Navigate to="/settings" replace />} />
                <Route path="/tickets" element={<Tickets />} />
                <Route path="/contacts" element={<Contacts />} />
                <Route
                    path="/analytics"
                    element={
                        <RequireSupervisor>
                            <Analytics />
                        </RequireSupervisor>
                    }
                />
                <Route
                    path="/agents"
                    element={
                        <RequireSupervisor>
                            <Agents />
                        </RequireSupervisor>
                    }
                />
                <Route
                    path="/ivr"
                    element={
                        <RequireSupervisor>
                            <IvrEditor />
                        </RequireSupervisor>
                    }
                />
                <Route
                    path="/settings"
                    element={
                        <RequireSupervisor>
                            <CallForwarding />
                        </RequireSupervisor>
                    }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </Suspense>
    );
}

export default function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <ThemeProvider>
                <ToastProvider>
                    <PwaUpdatePrompt />
                    <AuthProvider>
                        <SoftphoneProvider>
                            <ActiveCallProvider>
                                <BrowserRouter basename="/app">
                                    <Layout>
                                        <AppRoutes />
                                    </Layout>
                                </BrowserRouter>
                            </ActiveCallProvider>
                        </SoftphoneProvider>
                    </AuthProvider>
                </ToastProvider>
            </ThemeProvider>
        </QueryClientProvider>
    );
}
