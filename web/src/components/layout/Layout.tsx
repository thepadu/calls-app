import { ReactNode, useState } from 'react';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import CallScreen from '../widgets/CallScreen';
import WrapUpModal from '../widgets/WrapUpModal';
import FloatingDialer from '../widgets/FloatingDialer';
import LiveAnalyticsBadge from '../widgets/LiveAnalyticsBadge';
import ReadinessChecklist from './ReadinessChecklist';
import { useKeyboardShortcuts } from '../../lib/useKeyboardShortcuts';
import { useActiveCall } from '../../lib/activeCall';
import { useSoftphone } from '../../lib/softphone';
import GlobalPolling from '../../lib/globalPolling';

export default function Layout({ children }: { children: ReactNode }) {
    useKeyboardShortcuts();

    // The sidebar is always visible on desktop — this only matters below
    // the mobile breakpoint, where it becomes an off-canvas drawer (see
    // styles.css). Harmless to carry the state on desktop too rather than
    // conditionally render it, since the CSS ignores it above the breakpoint.
    const [sidebarOpen, setSidebarOpen] = useState(false);

    // Same phase logic CallScreen itself renders on — any call state
    // (ringing, dialing, or active) is the most important thing happening,
    // so the rest of the shell visually steps back for all three, not just
    // once a call is fully connected.
    const { incomingCall, outgoingCall, activeCall: softphoneCall, micPermissionDenied } = useSoftphone();
    const { activeCall: polledCall } = useActiveCall();
    const onCall = !!(incomingCall || outgoingCall || softphoneCall?.remoteNumber || polledCall?.caller);

    return (
        <div className={`app-shell ${onCall ? 'app-shell-on-call' : ''}`}>
            <GlobalPolling />
            <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
            {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
            <CallScreen />
            <div className="app-shell-main">
                <Topbar onMenuClick={() => setSidebarOpen(o => !o)} menuOpen={sidebarOpen} />
                {micPermissionDenied && (
                    <div className="mic-permission-banner">
                        Microphone access is blocked — you won't be able to answer calls until it's allowed. Click the
                        lock or site-info icon next to the address bar, allow Microphone, then reload this page.
                    </div>
                )}
                <main className="app-content">{children}</main>
            </div>
            <LiveAnalyticsBadge />
            <FloatingDialer />
            <WrapUpModal />
            <ReadinessChecklist />
        </div>
    );
}
