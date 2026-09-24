import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { useToast } from '../lib/toast';
import { useAuth } from '../lib/auth';
import { useModalA11y } from '../lib/useModalA11y';
import { TICKET_STATUS_COLORS, TICKET_PRIORITY_COLORS, TICKET_STATUSES, TICKET_PRIORITIES } from '../lib/ticketStatus';
import Pagination from '../components/Pagination';
import ConfirmDialog from '../components/ConfirmDialog';
import StatusDropdown from '../components/StatusDropdown';
import { Pencil } from 'lucide-react';

type Call = {
    session_id: string;
    caller: string;
    duration: number | null;
    created_at: string;
};

type Ticket = {
    id: number;
    session_id: string | null;
    caller_name: string | null;
    caller_number: string | null;
    tag: string | null;
    priority: string;
    status: string;
    assigned_agent_id: number | null;
    assigned_agent_name: string | null;
    notes: string | null;
    created_at: string;
};

type Agent = { id: number; name: string };

const TICKETS_PAGE_SIZE = 25;
const CALL_PICKER_PAGE_SIZE = 8;

function errorMessage(err: unknown) {
    return err instanceof Error ? err.message : 'Something went wrong';
}

// The one "detail view" convention this app has (see CallDetailsDrawer) —
// a centered modal, not a new slide-in-drawer pattern. Consolidates what
// used to be three separate always-live table controls (Tag, Assigned,
// Notes) plus a standalone notes-only modal into one place, opened per
// ticket instead of shown for every row at once.
function TicketDetailsModal({
    ticket,
    tags,
    agents,
    onClose,
    onSave,
    saving
}: {
    ticket: Ticket;
    tags: string[];
    agents: Agent[];
    onClose: () => void;
    onSave: (changes: { tag: string | null; assigned_agent_id: number | null; notes: string }) => void;
    saving: boolean;
}) {
    const [tag, setTag] = useState(ticket.tag ?? '');
    const [assignedAgentId, setAssignedAgentId] = useState<number | ''>(ticket.assigned_agent_id ?? '');
    const [notes, setNotes] = useState(ticket.notes ?? '');
    const containerRef = useModalA11y(true, onClose);

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div ref={containerRef} className="modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
                <h3>TCK-{ticket.id}</h3>
                <p className="hint">
                    {ticket.caller_number ?? ticket.caller_name ?? '—'} · {new Date(ticket.created_at).toLocaleString()}
                </p>

                <label>
                    Tag
                    <select value={tag} onChange={e => setTag(e.target.value)}>
                        <option value="">No tag</option>
                        {tags.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                </label>
                <label>
                    Assigned to
                    <select value={assignedAgentId} onChange={e => setAssignedAgentId(e.target.value ? Number(e.target.value) : '')}>
                        <option value="">Unassigned</option>
                        {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                </label>
                <label>
                    Notes
                    <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4} placeholder="What happened on this call…" autoFocus />
                </label>

                <div className="modal-actions">
                    <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
                    <button
                        className="btn btn-primary"
                        disabled={saving}
                        onClick={() => onSave({ tag: tag || null, assigned_agent_id: assignedAgentId || null, notes })}
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}

// Mirrors Calls.tsx's CallCard/.calls-mobile-list pattern — a stacked card
// per ticket instead of a table row, swapped in under the same 880px
// breakpoint. Same 6 fields as the desktop table: Priority/Status stay
// live-editable (the actual frequent triage workflow), everything else
// opens the details modal above.
function TicketCard({
    ticket,
    onChangePriority,
    onChangeStatus,
    onOpenDetails,
    disabled
}: {
    ticket: Ticket;
    onChangePriority: (priority: string) => void;
    onChangeStatus: (status: string) => void;
    onOpenDetails: () => void;
    disabled?: boolean;
}) {
    return (
        <div className="ticket-card">
            <div className="ticket-card-top">
                <span className="hint">TCK-{ticket.id}</span>
                <span className="ticket-card-caller">{ticket.caller_number ?? ticket.caller_name ?? '—'}</span>
                <button className="btn btn-link" title="View/edit details" onClick={onOpenDetails}>
                    <Pencil size={16} />
                </button>
            </div>
            {ticket.tag && <div className="hint ticket-card-tag">{ticket.tag}</div>}
            <div className="ticket-card-badges">
                <StatusDropdown value={ticket.priority} options={TICKET_PRIORITIES} colors={TICKET_PRIORITY_COLORS} onChange={onChangePriority} disabled={disabled} />
                <StatusDropdown value={ticket.status} options={TICKET_STATUSES} colors={TICKET_STATUS_COLORS} onChange={onChangeStatus} disabled={disabled} />
            </div>
            <div className="hint ticket-card-date">{new Date(ticket.created_at).toLocaleString()}</div>
        </div>
    );
}

// The one primary action for this page (Gmail/Cloud-Console pattern:
// a button above the table, not a permanent side panel) — picking a recent
// call and filling in the new ticket's fields, both in one modal instead of
// two always-visible panels ("Recent calls" + "New ticket").
function NewTicketModal({
    tags,
    agents,
    onClose,
    onCreate,
    creating
}: {
    tags: string[];
    agents: Agent[];
    onClose: () => void;
    onCreate: (data: { call: Call; tag: string; priority: string; assignedAgentId: number | ''; notes: string }) => void;
    creating: boolean;
}) {
    const [callSearchDraft, setCallSearchDraft] = useState('');
    const [callSearch, setCallSearch] = useState('');
    const [selectedSessionId, setSelectedSessionId] = useState('');
    const [tag, setTag] = useState('');
    const [priority, setPriority] = useState('Medium');
    const [assignedAgentId, setAssignedAgentId] = useState<number | ''>('');
    const [notes, setNotes] = useState('');
    const containerRef = useModalA11y(true, onClose);

    const callParams = new URLSearchParams({ pageSize: String(CALL_PICKER_PAGE_SIZE) });
    if (callSearch) callParams.set('caller', callSearch);
    const { data: callsData, isLoading, isError } = useQuery({
        queryKey: ['calls', 'ticket-picker', callSearch],
        queryFn: () => apiFetch(`/api/calls?${callParams.toString()}`)
    });
    const calls: Call[] = callsData?.calls ?? [];
    const selectedCall = calls.find(c => c.session_id === selectedSessionId) ?? null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div ref={containerRef} className="modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
                <h3>New ticket</h3>

                <label>
                    Find a recent call
                    <input
                        value={callSearchDraft}
                        onChange={e => setCallSearchDraft(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && setCallSearch(callSearchDraft.trim())}
                        onBlur={() => setCallSearch(callSearchDraft.trim())}
                        placeholder="Search by caller number…"
                    />
                </label>
                <label>
                    Call
                    <select value={selectedSessionId} onChange={e => setSelectedSessionId(e.target.value)}>
                        <option value="">
                            {isLoading ? 'Loading…' : isError ? "Couldn't load calls" : calls.length === 0 ? 'No matching calls' : 'Select…'}
                        </option>
                        {calls.map(c => (
                            <option key={c.session_id} value={c.session_id}>
                                {c.caller} — {new Date(c.created_at).toLocaleString()}
                            </option>
                        ))}
                    </select>
                </label>

                {selectedCall && (
                    <>
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
                            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="What happened on this call…" />
                        </label>
                    </>
                )}

                <div className="modal-actions">
                    <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
                    <button
                        className="btn btn-primary"
                        disabled={!selectedCall || creating}
                        onClick={() => selectedCall && onCreate({ call: selectedCall, tag, priority, assignedAgentId, notes })}
                    >
                        Create ticket
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function Tickets() {
    const queryClient = useQueryClient();
    const showToast = useToast();
    const { isSupervisor } = useAuth();

    const [ticketsPage, setTicketsPage] = useState(1);
    const [statusFilter, setStatusFilter] = useState('');
    const [tagFilter, setTagFilter] = useState('');
    const [searchDraft, setSearchDraft] = useState('');
    const [search, setSearch] = useState('');

    function changeStatusFilter(value: string) {
        setStatusFilter(value);
        setTicketsPage(1);
    }

    function changeTagFilter(value: string) {
        setTagFilter(value);
        setTicketsPage(1);
    }

    function applySearch() {
        setSearch(searchDraft.trim());
        setTicketsPage(1);
    }

    const filtersActive = !!(statusFilter || tagFilter || search);

    function clearFilters() {
        setStatusFilter('');
        setTagFilter('');
        setSearchDraft('');
        setSearch('');
        setTicketsPage(1);
    }

    const ticketsParams = new URLSearchParams({ page: String(ticketsPage), pageSize: String(TICKETS_PAGE_SIZE) });
    if (statusFilter) ticketsParams.set('status', statusFilter);
    if (tagFilter) ticketsParams.set('tag', tagFilter);
    if (search) ticketsParams.set('q', search);

    const { data: ticketsData, isLoading: ticketsLoading, isError: ticketsIsError } = useQuery({
        queryKey: ['tickets', ticketsPage, statusFilter, tagFilter, search],
        queryFn: () => apiFetch(`/api/tickets?${ticketsParams.toString()}`)
    });
    const { data: tagsData } = useQuery({ queryKey: ['ticket-tags'], queryFn: () => apiFetch('/api/ticket-tags') });
    const { data: agentsData } = useQuery({ queryKey: ['agents-assignable'], queryFn: () => apiFetch('/api/agents/assignable') });

    const tickets: Ticket[] = ticketsData?.tickets ?? [];
    const ticketsTotal: number = ticketsData?.total ?? 0;
    const ticketsTotalPages: number = ticketsData?.totalPages ?? 1;
    const tags: string[] = tagsData?.tags ?? [];
    const agents: Agent[] = agentsData?.agents ?? [];

    const ticketsStatusMessage = ticketsIsError
        ? "Couldn't load tickets."
        : ticketsLoading
        ? 'Loading…'
        : tickets.length === 0
        ? `No tickets${statusFilter || tagFilter || search ? ' match these filters.' : ' yet.'}`
        : null;

    const [newTicketOpen, setNewTicketOpen] = useState(false);

    const createTicket = useMutation({
        mutationFn: ({ call, tag, priority, assignedAgentId, notes }: { call: Call; tag: string; priority: string; assignedAgentId: number | ''; notes: string }) =>
            apiFetch('/api/tickets', {
                method: 'POST',
                body: JSON.stringify({
                    session_id: call.session_id,
                    caller_number: call.caller,
                    tag: tag || (tags[0] ?? null),
                    priority,
                    assigned_agent_id: assignedAgentId || null,
                    notes
                })
            }),
        onSuccess: () => {
            showToast('Ticket created');
            setNewTicketOpen(false);
            queryClient.invalidateQueries({ queryKey: ['tickets'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    // No success toast — these fire on every inline priority/status change
    // (and every details-modal save) and the row itself already visually
    // updates, so a stacked toast per field is noise rather than new
    // information, especially when triaging several tickets in a row. A
    // failed save is still worth surfacing, so the error toast stays.
    const updateTicket = useMutation({
        mutationFn: ({ id, ...changes }: { id: number; status?: string; priority?: string; tag?: string | null; assigned_agent_id?: number | null; notes?: string }) =>
            apiFetch(`/api/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tickets'] }),
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    const [detailsTicket, setDetailsTicket] = useState<Ticket | null>(null);

    function saveDetails(changes: { tag: string | null; assigned_agent_id: number | null; notes: string }) {
        if (!detailsTicket) return;
        updateTicket.mutate({ id: detailsTicket.id, ...changes }, { onSuccess: () => setDetailsTicket(null) });
    }

    const [addTagOpen, setAddTagOpen] = useState(false);
    const [newTagName, setNewTagName] = useState('');
    const [addTagError, setAddTagError] = useState('');
    const [pendingDeleteTag, setPendingDeleteTag] = useState<string | null>(null);

    function invalidateTags() {
        queryClient.invalidateQueries({ queryKey: ['ticket-tags'] });
    }

    const addTag = useMutation({
        mutationFn: () => apiFetch('/api/ticket-tags', { method: 'POST', body: JSON.stringify({ name: newTagName.trim() }) }),
        onSuccess: () => {
            showToast('Tag added');
            setNewTagName('');
            setAddTagError('');
            invalidateTags();
        },
        onError: (err: unknown) => setAddTagError(errorMessage(err))
    });

    const deleteTag = useMutation({
        mutationFn: (name: string) => apiFetch(`/api/ticket-tags/${encodeURIComponent(name)}`, { method: 'DELETE' }),
        onSuccess: (_data, name) => {
            showToast(`Tag "${name}" removed`);
            invalidateTags();
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error'),
        onSettled: () => setPendingDeleteTag(null)
    });

    const addTagModalRef = useModalA11y(addTagOpen, () => setAddTagOpen(false));

    return (
        <div className="page-narrow">
            <div className="panel">
                <div className="panel-header">
                    <h3>Tickets {ticketsTotal > 0 && <span className="hint" style={{ fontWeight: 400 }}>({ticketsTotal})</span>}</h3>
                    <button className="btn btn-primary" onClick={() => setNewTicketOpen(true)}>+ New ticket</button>
                </div>

                <div className="calls-filter-actions">
                    <input
                        value={searchDraft}
                        onChange={e => setSearchDraft(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && applySearch()}
                        onBlur={applySearch}
                        placeholder="Search by caller…"
                        style={{ width: 140 }}
                    />
                    <select value={statusFilter} onChange={e => changeStatusFilter(e.target.value)}>
                        <option value="">All statuses</option>
                        {TICKET_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <select value={tagFilter} onChange={e => changeTagFilter(e.target.value)}>
                        <option value="">All tags</option>
                        {tags.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    {filtersActive && (
                        <button className="btn btn-secondary" onClick={clearFilters}>Clear</button>
                    )}
                    {isSupervisor && (
                        <button className="btn btn-link" onClick={() => setAddTagOpen(true)} style={{ marginLeft: 'auto' }}>
                            Manage tags
                        </button>
                    )}
                </div>

                <table className="tickets-table">
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Caller</th>
                            <th>Priority</th>
                            <th>Status</th>
                            <th>Created</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {ticketsStatusMessage && (
                            <tr><td colSpan={6} className="empty">{ticketsStatusMessage}</td></tr>
                        )}
                        {tickets.map(t => (
                            <tr key={t.id}>
                                <td className="hint">TCK-{t.id}</td>
                                <td>
                                    {t.caller_number ?? t.caller_name ?? '—'}
                                    {t.tag && <div className="hint" style={{ margin: 0 }}>{t.tag}</div>}
                                </td>
                                <td>
                                    <StatusDropdown
                                        value={t.priority}
                                        options={TICKET_PRIORITIES}
                                        colors={TICKET_PRIORITY_COLORS}
                                        onChange={priority => updateTicket.mutate({ id: t.id, priority })}
                                        disabled={updateTicket.isPending && updateTicket.variables?.id === t.id}
                                    />
                                </td>
                                <td>
                                    <StatusDropdown
                                        value={t.status}
                                        options={TICKET_STATUSES}
                                        colors={TICKET_STATUS_COLORS}
                                        onChange={status => updateTicket.mutate({ id: t.id, status })}
                                        disabled={updateTicket.isPending && updateTicket.variables?.id === t.id}
                                    />
                                </td>
                                <td className="hint">{new Date(t.created_at).toLocaleString()}</td>
                                <td>
                                    <button className="btn btn-link" title="View/edit details" onClick={() => setDetailsTicket(t)}>
                                        <Pencil size={16} />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                <div className="tickets-mobile-list">
                    {ticketsStatusMessage && <p className="empty">{ticketsStatusMessage}</p>}
                    {tickets.map(t => (
                        <TicketCard
                            key={t.id}
                            ticket={t}
                            onChangePriority={priority => updateTicket.mutate({ id: t.id, priority })}
                            onChangeStatus={status => updateTicket.mutate({ id: t.id, status })}
                            onOpenDetails={() => setDetailsTicket(t)}
                            disabled={updateTicket.isPending && updateTicket.variables?.id === t.id}
                        />
                    ))}
                </div>

                <Pagination page={ticketsPage} totalPages={ticketsTotalPages} onPageChange={setTicketsPage} total={ticketsTotal} pageSize={TICKETS_PAGE_SIZE} />
            </div>

            {newTicketOpen && (
                <NewTicketModal
                    tags={tags}
                    agents={agents}
                    onClose={() => setNewTicketOpen(false)}
                    onCreate={data => createTicket.mutate(data)}
                    creating={createTicket.isPending}
                />
            )}

            {detailsTicket && (
                <TicketDetailsModal
                    key={detailsTicket.id}
                    ticket={detailsTicket}
                    tags={tags}
                    agents={agents}
                    onClose={() => setDetailsTicket(null)}
                    onSave={saveDetails}
                    saving={updateTicket.isPending}
                />
            )}

            {addTagOpen && (
                <div className="modal-overlay" onClick={() => setAddTagOpen(false)}>
                    <div ref={addTagModalRef} className="modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
                        <h3>Manage ticket tags</h3>
                        <p className="hint">These are the tags agents can pick from when logging a ticket.</p>

                        {tags.length === 0 && <p className="empty">No tags yet — add one to get started.</p>}
                        {tags.map(t => (
                            <div className="recent-call-row" key={t}>
                                <div style={{ fontWeight: 600 }}>{t}</div>
                                <button className="btn btn-link btn-link-danger" onClick={() => setPendingDeleteTag(t)}>
                                    Remove
                                </button>
                            </div>
                        ))}

                        <label style={{ marginTop: 14 }}>
                            New tag name
                            <input value={newTagName} onChange={e => setNewTagName(e.target.value)} />
                        </label>
                        {addTagError && <p className="error">{addTagError}</p>}

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setAddTagOpen(false)}>Close</button>
                            <button className="btn btn-primary" onClick={() => addTag.mutate()} disabled={addTag.isPending || !newTagName.trim()}>
                                Add
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <ConfirmDialog
                open={!!pendingDeleteTag}
                title="Remove ticket tag"
                message={`Remove the "${pendingDeleteTag}" tag? Agents will no longer be able to select it for new tickets.`}
                confirmLabel="Remove"
                danger
                confirmDisabled={deleteTag.isPending}
                onConfirm={() => pendingDeleteTag && deleteTag.mutate(pendingDeleteTag)}
                onCancel={() => setPendingDeleteTag(null)}
            />
        </div>
    );
}
