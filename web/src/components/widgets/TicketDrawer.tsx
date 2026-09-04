import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useActiveCall } from '../../lib/activeCall';
import { useToast } from '../../lib/toast';
import { TICKET_STATUS_COLORS, TICKET_PRIORITIES } from '../../lib/ticketStatus';

type Agent = { id: number; name: string };

type Ticket = {
    id: number;
    tag: string | null;
    priority: string;
    status: string;
    notes: string | null;
    assigned_agent_name?: string | null;
    created_at: string;
};

function errorMessage(err: unknown) {
    return err instanceof Error ? err.message : 'Something went wrong';
}

// Anchored below CallScreen's card (rendered as its sibling inside the same
// fixed .call-screen-stack) rather than a centered modal — shows what's
// already been logged for this call before letting the agent create another,
// so "Add Ticket" can't accidentally produce a blind duplicate.
export default function TicketDrawer() {
    const { quickTicketOpen, closeQuickTicket, activeCall, lastCall } = useActiveCall();
    const call = activeCall ?? lastCall;
    const showToast = useToast();
    const queryClient = useQueryClient();

    const { data: ticketsData } = useQuery({
        queryKey: ['call-tickets', call?.session_id],
        queryFn: () => apiFetch(`/api/tickets?session_id=${call!.session_id}`),
        enabled: quickTicketOpen && !!call
    });
    const { data: tagsData } = useQuery({ queryKey: ['ticket-tags'], queryFn: () => apiFetch('/api/ticket-tags'), enabled: quickTicketOpen });
    const { data: agentsData } = useQuery({ queryKey: ['agents-assignable'], queryFn: () => apiFetch('/api/agents/assignable'), enabled: quickTicketOpen });

    const tickets: Ticket[] = ticketsData?.tickets ?? [];
    const tags: string[] = tagsData?.tags ?? [];
    const agents: Agent[] = agentsData?.agents ?? [];

    const [tag, setTag] = useState('');
    const [priority, setPriority] = useState('Medium');
    const [assignedAgentId, setAssignedAgentId] = useState<number | ''>('');
    const [notes, setNotes] = useState('');

    // This drawer stays mounted (just hidden) between calls, so without this
    // a draft left unsubmitted for one caller — notes, tag, assignee — would
    // still be sitting in these fields the next time "Add Ticket" is opened
    // for a completely different caller, ready to be submitted against the
    // wrong call. Keyed on session_id specifically (not quickTicketOpen) so
    // toggling the drawer closed and back open for the SAME ongoing call
    // still preserves an in-progress draft.
    useEffect(() => {
        setTag('');
        setPriority('Medium');
        setAssignedAgentId('');
        setNotes('');
    }, [call?.session_id]);

    const create = useMutation({
        mutationFn: () =>
            apiFetch('/api/tickets', {
                method: 'POST',
                body: JSON.stringify({
                    session_id: call?.session_id,
                    caller_number: call?.caller,
                    tag: tag || (tags[0] ?? null),
                    priority,
                    assigned_agent_id: assignedAgentId || null,
                    notes
                })
            }),
        onSuccess: () => {
            showToast('Ticket created');
            setTag('');
            setPriority('Medium');
            setAssignedAgentId('');
            setNotes('');
            queryClient.invalidateQueries({ queryKey: ['call-tickets', call?.session_id] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    // Escape-to-close only, deliberately not the shared useModalA11y Tab-trap
    // — this drawer has no backdrop and, like CallScreen itself, is meant to
    // stay reachable-around, not sealed off: trapping Tab here would block a
    // keyboard user from reaching the call's own Mute/Hold/End controls.
    useEffect(() => {
        if (!quickTicketOpen) return;
        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape') closeQuickTicket();
        }
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [quickTicketOpen, closeQuickTicket]);

    if (!quickTicketOpen || !call) return null;

    return (
        <div className="ticket-drawer" role="dialog" aria-label="Tickets for this call">
            <div className="ticket-drawer-header">
                <h4>Tickets for {call.caller}</h4>
                <button className="btn-icon" onClick={closeQuickTicket} aria-label="Close ticket drawer">
                    <X size={18} />
                </button>
            </div>

            {tickets.length === 0 && <p className="empty">No tickets logged for this call yet.</p>}
            {tickets.map(t => (
                <div key={t.id} className="call-details-ticket">
                    <div className="call-details-ticket-header">
                        <span className="status-pill" style={{ background: TICKET_STATUS_COLORS[t.status] ?? 'var(--status-neutral)' }}>
                            {t.status}
                        </span>
                        <span className="hint">{t.priority} priority</span>
                        {t.tag && <span className="hint">· {t.tag}</span>}
                    </div>
                    {t.notes && <p className="hint">{t.notes}</p>}
                    <p className="hint">
                        {t.assigned_agent_name ? `Assigned to ${t.assigned_agent_name}` : 'Unassigned'} ·{' '}
                        {new Date(t.created_at).toLocaleString()}
                    </p>
                </div>
            ))}

            <h4>New ticket</h4>
            <label>
                Tag
                <select value={tag} onChange={e => setTag(e.target.value)}>
                    <option value="">Select…</option>
                    {tags.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
            </label>
            <label>
                Priority
                <select value={priority} onChange={e => setPriority(e.target.value)}>
                    {TICKET_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
            </label>
            <label>
                Assign to agent
                <select value={assignedAgentId} onChange={e => setAssignedAgentId(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">Unassigned</option>
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
            </label>
            <label>
                Notes
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
            </label>

            <div className="modal-actions">
                <button className="btn btn-secondary" onClick={closeQuickTicket}>Close</button>
                <button className="btn btn-primary" onClick={() => create.mutate()} disabled={create.isPending}>
                    Create ticket
                </button>
            </div>
        </div>
    );
}
