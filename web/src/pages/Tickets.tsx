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
import { FileText } from 'lucide-react';

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

const RECENT_CALLS_PAGE_SIZE = 8;

function errorMessage(err: unknown) {
    return err instanceof Error ? err.message : 'Something went wrong';
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
    const [recentCallsPage, setRecentCallsPage] = useState(1);

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

    const ticketsParams = new URLSearchParams({ page: String(ticketsPage), pageSize: '25' });
    if (statusFilter) ticketsParams.set('status', statusFilter);
    if (tagFilter) ticketsParams.set('tag', tagFilter);
    if (search) ticketsParams.set('q', search);

    const recentCallsParams = new URLSearchParams({ page: String(recentCallsPage), pageSize: String(RECENT_CALLS_PAGE_SIZE) });

    const { data: callsData, isLoading: callsLoading, isError: callsIsError } = useQuery({
        queryKey: ['calls', 'recent', recentCallsPage],
        queryFn: () => apiFetch(`/api/calls?${recentCallsParams.toString()}`)
    });
    const { data: ticketsData, isLoading: ticketsLoading, isError: ticketsIsError } = useQuery({
        queryKey: ['tickets', ticketsPage, statusFilter, tagFilter, search],
        queryFn: () => apiFetch(`/api/tickets?${ticketsParams.toString()}`)
    });
    const { data: tagsData } = useQuery({ queryKey: ['ticket-tags'], queryFn: () => apiFetch('/api/ticket-tags') });
    const { data: agentsData } = useQuery({ queryKey: ['agents-assignable'], queryFn: () => apiFetch('/api/agents/assignable') });

    const recentCalls: Call[] = callsData?.calls ?? [];
    const recentCallsTotal: number = callsData?.total ?? 0;
    const recentCallsTotalPages: number = callsData?.totalPages ?? 1;
    const tickets: Ticket[] = ticketsData?.tickets ?? [];
    const ticketsTotal: number = ticketsData?.total ?? 0;
    const ticketsTotalPages: number = ticketsData?.totalPages ?? 1;
    const tags: string[] = tagsData?.tags ?? [];
    const agents: Agent[] = agentsData?.agents ?? [];

    const recentCallsStatusMessage = callsIsError ? "Couldn't load calls." : callsLoading ? 'Loading…' : recentCalls.length === 0 ? 'No calls yet.' : null;
    const ticketsStatusMessage = ticketsIsError
        ? "Couldn't load tickets."
        : ticketsLoading
        ? 'Loading…'
        : tickets.length === 0
        ? `No tickets${statusFilter || tagFilter || search ? ' match these filters.' : ' yet.'}`
        : null;

    const [selectedCall, setSelectedCall] = useState<Call | null>(null);
    const [tag, setTag] = useState('');
    const [priority, setPriority] = useState('Medium');
    const [assignedAgentId, setAssignedAgentId] = useState<number | ''>('');
    const [notes, setNotes] = useState('');

    function selectCall(call: Call) {
        setSelectedCall(call);
        setTag('');
        setPriority('Medium');
        setAssignedAgentId('');
        setNotes('');
    }

    const createTicket = useMutation({
        mutationFn: () =>
            apiFetch('/api/tickets', {
                method: 'POST',
                body: JSON.stringify({
                    session_id: selectedCall?.session_id,
                    caller_number: selectedCall?.caller,
                    tag: tag || (tags[0] ?? null),
                    priority,
                    assigned_agent_id: assignedAgentId || null,
                    notes
                })
            }),
        onSuccess: () => {
            showToast('Ticket created');
            setSelectedCall(null);
            queryClient.invalidateQueries({ queryKey: ['tickets'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    // PATCH /api/tickets/:id has always existed, fully built and validated —
    // this was just never wired up to anything, so a ticket's status could
    // never actually change after creation anywhere in the app.
    const updateTicket = useMutation({
        mutationFn: ({ id, ...changes }: { id: number; status?: string; priority?: string; tag?: string | null; assigned_agent_id?: number | null; notes?: string }) =>
            apiFetch(`/api/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
        onSuccess: () => {
            showToast('Ticket updated');
            queryClient.invalidateQueries({ queryKey: ['tickets'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    const [editingNotesTicket, setEditingNotesTicket] = useState<Ticket | null>(null);
    const [notesDraft, setNotesDraft] = useState('');

    function openNotesEditor(t: Ticket) {
        setEditingNotesTicket(t);
        setNotesDraft(t.notes ?? '');
    }

    function saveNotes() {
        if (!editingNotesTicket) return;
        updateTicket.mutate({ id: editingNotesTicket.id, notes: notesDraft }, {
            onSuccess: () => setEditingNotesTicket(null)
        });
    }

    const notesModalRef = useModalA11y(!!editingNotesTicket, () => setEditingNotesTicket(null));

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
            setAddTagOpen(false);
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
        <div className="ivr-layout">
            <div>
                <div className="panel">
                    <h3>Recent calls {recentCallsTotal > 0 && <span className="hint" style={{ fontWeight: 400 }}>({recentCallsTotal})</span>}</h3>
                    {recentCallsStatusMessage && <p className="empty">{recentCallsStatusMessage}</p>}
                    {recentCalls.map(call => (
                        <div className="recent-call-row" key={call.session_id}>
                            <div>
                                <div style={{ fontWeight: 600 }}>{call.caller}</div>
                                <div className="hint" style={{ margin: 0 }}>
                                    {call.duration ?? 0}s · {new Date(call.created_at).toLocaleString()}
                                </div>
                            </div>
                            <button className="btn btn-secondary" onClick={() => selectCall(call)}>
                                + Ticket
                            </button>
                        </div>
                    ))}
                    <Pagination page={recentCallsPage} totalPages={recentCallsTotalPages} onPageChange={setRecentCallsPage} />
                </div>

                <div className="panel">
                    <div className="panel-header">
                        <h3>Tickets {ticketsTotal > 0 && <span className="hint" style={{ fontWeight: 400 }}>({ticketsTotal})</span>}</h3>
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
                        </div>
                    </div>
                    <table>
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Caller</th>
                                <th>Tag</th>
                                <th>Priority</th>
                                <th>Status</th>
                                <th>Assigned</th>
                                <th>Notes</th>
                                <th>Created</th>
                            </tr>
                        </thead>
                        <tbody>
                            {ticketsStatusMessage && (
                                <tr><td colSpan={8} className="empty">{ticketsStatusMessage}</td></tr>
                            )}
                            {tickets.map(t => (
                                <tr key={t.id}>
                                    <td className="hint">TCK-{t.id}</td>
                                    <td>{t.caller_number ?? t.caller_name ?? '—'}</td>
                                    <td>
                                        <select value={t.tag ?? ''} onChange={e => updateTicket.mutate({ id: t.id, tag: e.target.value || null })}>
                                            <option value="">No tag</option>
                                            {tags.map(tg => <option key={tg} value={tg}>{tg}</option>)}
                                        </select>
                                    </td>
                                    <td>
                                        <StatusDropdown
                                            value={t.priority}
                                            options={TICKET_PRIORITIES}
                                            colors={TICKET_PRIORITY_COLORS}
                                            onChange={priority => updateTicket.mutate({ id: t.id, priority })}
                                        />
                                    </td>
                                    <td>
                                        <StatusDropdown
                                            value={t.status}
                                            options={TICKET_STATUSES}
                                            colors={TICKET_STATUS_COLORS}
                                            onChange={status => updateTicket.mutate({ id: t.id, status })}
                                        />
                                    </td>
                                    <td>
                                        <select
                                            value={t.assigned_agent_id ?? ''}
                                            onChange={e => updateTicket.mutate({ id: t.id, assigned_agent_id: e.target.value ? Number(e.target.value) : null })}
                                        >
                                            <option value="">Unassigned</option>
                                            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                                        </select>
                                    </td>
                                    <td>
                                        <button
                                            className="btn btn-link"
                                            title={t.notes ?? 'Add notes'}
                                            onClick={() => openNotesEditor(t)}
                                            style={{ color: t.notes ? '#17A697' : undefined }}
                                        >
                                            <FileText size={16} />
                                        </button>
                                    </td>
                                    <td className="hint">{new Date(t.created_at).toLocaleString()}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <Pagination page={ticketsPage} totalPages={ticketsTotalPages} onPageChange={setTicketsPage} />
                </div>

                {isSupervisor && (
                    <div className="panel">
                        <div className="panel-header">
                            <h3>Ticket tags</h3>
                            <button className="btn btn-primary" onClick={() => setAddTagOpen(true)}>+ Add tag</button>
                        </div>
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
                    </div>
                )}
            </div>

            <div className="panel">
                <h3>New ticket</h3>
                {!selectedCall && (
                    <p className="hint">Pick a call on the left to start a ticket for it.</p>
                )}
                {selectedCall && (
                    <div>
                        <div className="ticket-summary">
                            <div><span>Caller</span><strong>{selectedCall.caller}</strong></div>
                            <div><span>Duration</span><strong>{selectedCall.duration ?? 0}s</strong></div>
                        </div>

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
                            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="What happened on this call..." />
                        </label>

                        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
                            <button className="btn btn-primary" onClick={() => createTicket.mutate()} disabled={createTicket.isPending}>
                                Create ticket
                            </button>
                            <button className="btn btn-secondary" onClick={() => setSelectedCall(null)}>Cancel</button>
                        </div>
                    </div>
                )}
            </div>

            {editingNotesTicket && (
                <div className="modal-overlay" onClick={() => setEditingNotesTicket(null)}>
                    <div ref={notesModalRef} className="modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
                        <h3>Notes — TCK-{editingNotesTicket.id}</h3>
                        <label>
                            Notes
                            <textarea value={notesDraft} onChange={e => setNotesDraft(e.target.value)} rows={5} placeholder="What happened on this call..." autoFocus />
                        </label>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setEditingNotesTicket(null)}>Cancel</button>
                            <button className="btn btn-primary" onClick={saveNotes} disabled={updateTicket.isPending}>
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {addTagOpen && (
                <div className="modal-overlay" onClick={() => setAddTagOpen(false)}>
                    <div ref={addTagModalRef} className="modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
                        <h3>Add ticket tag</h3>
                        <label>
                            Tag name
                            <input value={newTagName} onChange={e => setNewTagName(e.target.value)} autoFocus />
                        </label>
                        {addTagError && <p className="error">{addTagError}</p>}
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setAddTagOpen(false)}>Cancel</button>
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
                onConfirm={() => pendingDeleteTag && deleteTag.mutate(pendingDeleteTag)}
                onCancel={() => setPendingDeleteTag(null)}
            />
        </div>
    );
}
