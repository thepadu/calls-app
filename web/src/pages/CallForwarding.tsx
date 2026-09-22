import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { useToast } from '../lib/toast';
import ConfirmDialog from '../components/ConfirmDialog';
import ConfirmToggle from '../components/ConfirmToggle';

type Rule = { id: number; condition: string; destination: string };

type BusinessHours = {
    enabled: boolean;
    open_time: string;
    close_time: string;
    active_days: number[];
    after_hours_message: string;
    updated_at?: string | null;
    updated_by?: string | null;
};

// 'busy'/'always' can be saved here but aren't applied to live call
// routing yet (see the Rules panel's own hint text below) — labeled
// in-place rather than hidden, since existing saved rules of these types
// still need to show up correctly in the dropdown when edited.
const CONDITIONS: { value: string; label: string }[] = [
    { value: 'no_answer', label: 'No answer' },
    { value: 'busy', label: 'Line busy — not yet active' },
    { value: 'always', label: 'Always — not yet active' },
    { value: 'after_hours', label: 'After hours' }
];

const DAYS: { value: number; label: string }[] = [
    { value: 1, label: 'Mon' },
    { value: 2, label: 'Tue' },
    { value: 3, label: 'Wed' },
    { value: 4, label: 'Thu' },
    { value: 5, label: 'Fri' },
    { value: 6, label: 'Sat' },
    { value: 0, label: 'Sun' }
];

function errorMessage(err: unknown) {
    return err instanceof Error ? err.message : 'Something went wrong';
}

function AuditTrail({ updatedAt, updatedBy }: { updatedAt?: string | null; updatedBy?: string | null }) {
    if (!updatedBy) return null;
    return (
        <p className="settings-audit-trail">
            Last changed by {updatedBy}
            {updatedAt && ` · ${new Date(updatedAt).toLocaleString()}`}
        </p>
    );
}

function BusinessHoursPanel() {
    const queryClient = useQueryClient();
    const showToast = useToast();

    const { data, isLoading, isError } = useQuery({ queryKey: ['business-hours'], queryFn: () => apiFetch('/api/business-hours') });
    const hours: BusinessHours | null = data?.hours ?? null;

    const [form, setForm] = useState<BusinessHours | null>(null);

    useEffect(() => {
        if (hours) setForm(hours);
    }, [hours]);

    const save = useMutation({
        mutationFn: (changes: Partial<BusinessHours>) =>
            apiFetch('/api/business-hours', { method: 'PATCH', body: JSON.stringify(changes) }),
        onSuccess: () => {
            showToast('Business hours saved');
            queryClient.invalidateQueries({ queryKey: ['business-hours'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    function toggleDay(day: number) {
        if (!form) return;
        const active = form.active_days.includes(day)
            ? form.active_days.filter(d => d !== day)
            : [...form.active_days, day].sort();
        setForm({ ...form, active_days: active });
    }

    // ConfirmToggle already gates the ON direction behind its own confirm
    // dialog — this only needs to apply the change, optimistically, for
    // either direction, and roll back on a failed save. Without the
    // rollback, a failed PATCH left the toggle showing the new (wrong)
    // state indefinitely, since nothing else re-syncs `form` until an
    // unrelated refetch happens to overwrite it.
    function handleToggleEnabled(next: boolean) {
        if (!form) return;
        setForm({ ...form, enabled: next });
        save.mutate({ enabled: next }, { onError: () => setForm(current => (current ? { ...current, enabled: !next } : current)) });
    }

    // Previously `if (!form) return null` unmounted the whole panel —
    // heading included — until the query resolved, while its sibling
    // panels below rendered immediately, causing a visible page shift. The
    // shell now always renders; only the form body waits on real data.
    if (!form) {
        return (
            <div className="panel">
                <div className="panel-header">
                    <h3>Business hours</h3>
                </div>
                <p className="empty">{isError ? "Couldn't load business hours." : isLoading ? 'Loading…' : null}</p>
            </div>
        );
    }

    const dirty =
        !hours ||
        form.open_time !== hours.open_time ||
        form.close_time !== hours.close_time ||
        form.after_hours_message !== hours.after_hours_message ||
        form.active_days.length !== hours.active_days.length ||
        form.active_days.some(d => !hours.active_days.includes(d));

    return (
        <div className="panel">
            <div className="panel-header">
                <h3>Business hours</h3>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span className="live-badge">Live</span>
                    <ConfirmToggle
                        checked={form.enabled}
                        ariaLabel="Enable business hours"
                        onChange={handleToggleEnabled}
                        confirmTitle="Turn on business hours?"
                        confirmMessage="Callers outside the configured hours will immediately hear the after-hours message below instead of the normal menu, starting with the next call."
                    />
                </div>
            </div>
            <p className="hint">
                Outside these hours, callers hear the message below instead of the normal menu — no agent
                needs to be online for this to work. Times are East Africa Time.
            </p>
            <AuditTrail updatedAt={form.updated_at} updatedBy={form.updated_by} />

            <div className="forwarding-add-row" style={{ gridTemplateColumns: '1fr 1fr', maxWidth: 360 }}>
                <label>
                    Opens
                    <input type="time" value={form.open_time} onChange={e => setForm({ ...form, open_time: e.target.value })} />
                </label>
                <label>
                    Closes
                    <input type="time" value={form.close_time} onChange={e => setForm({ ...form, close_time: e.target.value })} />
                </label>
            </div>

            <label style={{ display: 'block', margin: 'var(--space-14) 0 var(--space-6)' }}>Active days</label>
            <div className="disposition-chips" style={{ marginTop: 0 }}>
                {DAYS.map(d => (
                    <button
                        key={d.value}
                        type="button"
                        className={`chip ${form.active_days.includes(d.value) ? 'chip-selected' : ''}`}
                        onClick={() => toggleDay(d.value)}
                    >
                        {d.label}
                    </button>
                ))}
            </div>

            <label style={{ display: 'block', marginTop: 'var(--space-14)' }}>
                After-hours message
                <textarea
                    value={form.after_hours_message}
                    onChange={e => setForm({ ...form, after_hours_message: e.target.value })}
                    rows={2}
                />
            </label>

            <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 'var(--space-12)' }}>
                <button
                    className="btn btn-primary"
                    disabled={!dirty || save.isPending}
                    onClick={() =>
                        save.mutate({
                            open_time: form.open_time,
                            close_time: form.close_time,
                            active_days: form.active_days,
                            after_hours_message: form.after_hours_message
                        })
                    }
                >
                    Save business hours
                </button>
            </div>
        </div>
    );
}

function CallRatingPanel() {
    const queryClient = useQueryClient();
    const showToast = useToast();

    const { data, isError } = useQuery({ queryKey: ['ivr-config'], queryFn: () => apiFetch('/api/ivr-config') });

    const toggle = useMutation({
        mutationFn: (rating_enabled: boolean) =>
            apiFetch('/api/ivr-config', { method: 'PATCH', body: JSON.stringify({ rating_enabled }) }),
        onSuccess: (_data, rating_enabled) => {
            showToast(rating_enabled ? 'Call rating turned on' : 'Call rating turned off');
            queryClient.invalidateQueries({ queryKey: ['ivr-config'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    return (
        <div className="panel panel-header">
            <div>
                <h3 style={{ marginBottom: 'var(--space-2)' }}>Call rating</h3>
                <p className="hint" style={{ marginBottom: 0 }}>
                    After the agent hangs up, the caller hears a 1-5 rating prompt before the line
                    disconnects. Off by default — changes live call flow.
                </p>
                {isError && <p className="error" style={{ marginBottom: 0 }}>Couldn't load the current setting.</p>}
                <AuditTrail updatedAt={data?.rating_updated_at} updatedBy={data?.rating_updated_by} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center' }}>
                <span className="live-badge">Live</span>
                <ConfirmToggle
                    checked={!!data?.rating_enabled}
                    ariaLabel="Enable call rating"
                    onChange={next => toggle.mutate(next)}
                    confirmTitle="Turn on call rating?"
                    confirmMessage="Every caller will hear a 1-5 rating prompt right before the line disconnects, starting with the next call. This takes effect immediately."
                />
            </div>
        </div>
    );
}

type HoldMusicConfig = {
    active_class: 'default' | 'custom';
    custom_filename?: string | null;
    uploaded_at?: string | null;
    uploaded_by?: string | null;
};

function HoldMusicPanel() {
    const queryClient = useQueryClient();
    const showToast = useToast();
    const [file, setFile] = useState<File | null>(null);

    const { data, isError } = useQuery({ queryKey: ['hold-music'], queryFn: () => apiFetch('/api/hold-music') });
    const config: HoldMusicConfig = data?.config ?? { active_class: 'default' };

    const upload = useMutation({
        mutationFn: () => {
            const formData = new FormData();
            formData.append('file', file as File);
            return apiFetch('/api/hold-music', { method: 'POST', body: formData });
        },
        onSuccess: () => {
            showToast('Hold music updated');
            setFile(null);
            queryClient.invalidateQueries({ queryKey: ['hold-music'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    const reset = useMutation({
        mutationFn: () => apiFetch('/api/hold-music/reset', { method: 'POST' }),
        onSuccess: () => {
            showToast('Hold music reset to default');
            queryClient.invalidateQueries({ queryKey: ['hold-music'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    return (
        <div className="panel">
            <div className="panel-header">
                <h3>Hold music</h3>
            </div>
            {isError && <p className="error">Couldn't load the current hold music setting.</p>}
            <p className="hint">
                Played to callers waiting in the queue. Upload an MP3 (up to 8MB) to replace it, or reset
                back to the default at any time — takes effect immediately, including for callers already
                on hold.
            </p>

            <p className="hint" style={{ margin: '0 0 var(--space-12)' }}>
                Currently playing:{' '}
                {config.active_class === 'custom' ? (
                    <>
                        <strong>{config.custom_filename}</strong>
                        {config.uploaded_at && ` — uploaded ${new Date(config.uploaded_at).toLocaleString()}`}
                        {config.uploaded_by && ` by ${config.uploaded_by}`}
                    </>
                ) : (
                    'default Asterisk hold music'
                )}
            </p>

            <div className="forwarding-add-row" style={{ gridTemplateColumns: 'auto 1fr' }}>
                <input type="file" accept="audio/mpeg,audio/mp3,.mp3" onChange={e => setFile(e.target.files?.[0] ?? null)} />
                <button className="btn btn-primary" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
                    Upload
                </button>
            </div>

            {config.active_class === 'custom' && (
                <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 'var(--space-12)' }}>
                    <button className="btn btn-link" disabled={reset.isPending} onClick={() => reset.mutate()}>
                        Reset to default
                    </button>
                </div>
            )}
        </div>
    );
}

export default function CallForwarding() {
    const queryClient = useQueryClient();
    const showToast = useToast();

    const { data: configData, isError: configIsError } = useQuery({ queryKey: ['forwarding-config'], queryFn: () => apiFetch('/api/forwarding-config') });
    const { data: rulesData, isError: rulesIsError } = useQuery({ queryKey: ['forwarding-rules'], queryFn: () => apiFetch('/api/forwarding-rules') });

    const rules: Rule[] = rulesData?.rules ?? [];

    const [newCondition, setNewCondition] = useState('no_answer');
    const [newDestination, setNewDestination] = useState('');
    const [pendingDelete, setPendingDelete] = useState<Rule | null>(null);

    const toggleEnabled = useMutation({
        mutationFn: (enabled: boolean) => apiFetch('/api/forwarding-config', { method: 'PATCH', body: JSON.stringify({ enabled }) }),
        onSuccess: (_data, enabled) => {
            showToast(enabled ? 'Call forwarding turned on' : 'Call forwarding turned off');
            queryClient.invalidateQueries({ queryKey: ['forwarding-config'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    const addRule = useMutation({
        mutationFn: () =>
            apiFetch('/api/forwarding-rules', {
                method: 'POST',
                body: JSON.stringify({ condition: newCondition, destination: newDestination })
            }),
        onSuccess: () => {
            showToast('Forwarding rule added');
            setNewDestination('');
            queryClient.invalidateQueries({ queryKey: ['forwarding-rules'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    const deleteRule = useMutation({
        mutationFn: (id: number) => apiFetch(`/api/forwarding-rules/${id}`, { method: 'DELETE' }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['forwarding-rules'] }),
        onError: (err: unknown) => showToast(errorMessage(err), 'error'),
        onSettled: () => setPendingDelete(null)
    });

    return (
        <div className="page-narrow">
            <div className="settings-group-label">Live call routing — changes apply to the next call</div>

            <BusinessHoursPanel />

            <div className="panel panel-header">
                <div>
                    <h3 style={{ marginBottom: 'var(--space-2)' }}>Call forwarding</h3>
                    <p className="hint" style={{ marginBottom: 0 }}>Route calls elsewhere based on the rules below.</p>
                    {configIsError && <p className="error" style={{ marginBottom: 0 }}>Couldn't load the current setting.</p>}
                    <AuditTrail updatedAt={configData?.updated_at} updatedBy={configData?.updated_by} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span className="live-badge">Live</span>
                    <ConfirmToggle
                        checked={!!configData?.enabled}
                        ariaLabel="Enable call forwarding"
                        onChange={next => toggleEnabled.mutate(next)}
                        confirmTitle="Turn on call forwarding?"
                        confirmMessage="Calls will start routing according to the rules below the moment this is on. This takes effect immediately."
                    />
                </div>
            </div>

            <div className="panel">
                <div className="panel-header">
                    <h3>Rules</h3>
                </div>
                <p className="hint">
                    "No answer" is live — it fires when nobody at all is online. "Busy" and "always" are saved
                    but not yet applied to live call routing. "After hours" here is superseded by the Business
                    Hours panel above, which has its own dedicated message.
                </p>

                {rulesIsError && <p className="error">Couldn't load forwarding rules.</p>}
                {rules.map(rule => (
                    <div className="forwarding-rule-row" key={rule.id}>
                        <span>{CONDITIONS.find(c => c.value === rule.condition)?.label ?? rule.condition}</span>
                        <span className="hint" style={{ margin: 0 }}>→</span>
                        <span>{rule.destination}</span>
                        <button className="btn btn-link btn-link-danger" onClick={() => setPendingDelete(rule)}>Remove</button>
                    </div>
                ))}

                <div className="forwarding-add-row">
                    <select value={newCondition} onChange={e => setNewCondition(e.target.value)}>
                        {CONDITIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                    <input
                        value={newDestination}
                        onChange={e => setNewDestination(e.target.value)}
                        placeholder="Agent, queue name, or number"
                    />
                    <button className="btn btn-primary" onClick={() => addRule.mutate()} disabled={!newDestination.trim() || addRule.isPending}>
                        + Add rule
                    </button>
                </div>
            </div>

            <ConfirmDialog
                open={!!pendingDelete}
                title="Remove forwarding rule"
                message={`Remove the "${pendingDelete?.condition}" rule?`}
                confirmLabel="Remove"
                danger
                onConfirm={() => pendingDelete && deleteRule.mutate(pendingDelete.id)}
                onCancel={() => setPendingDelete(null)}
            />

            <CallRatingPanel />

            <div className="settings-group-label">Caller experience</div>

            <HoldMusicPanel />
        </div>
    );
}
