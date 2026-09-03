import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { useToast } from '../lib/toast';
import ConfirmDialog from '../components/ConfirmDialog';

type Rule = { id: number; condition: string; destination: string };

type BusinessHours = {
    enabled: boolean;
    open_time: string;
    close_time: string;
    active_days: number[];
    after_hours_message: string;
};

const CONDITIONS: { value: string; label: string }[] = [
    { value: 'no_answer', label: 'No answer' },
    { value: 'busy', label: 'Line busy' },
    { value: 'always', label: 'Always' },
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

function BusinessHoursPanel() {
    const queryClient = useQueryClient();
    const showToast = useToast();

    const { data } = useQuery({ queryKey: ['business-hours'], queryFn: () => apiFetch('/api/business-hours') });
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

    if (!form) return null;

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
                <label className="toggle-switch">
                    <input
                        type="checkbox"
                        checked={form.enabled}
                        onChange={e => {
                            setForm({ ...form, enabled: e.target.checked });
                            save.mutate({ enabled: e.target.checked });
                        }}
                    />
                    <span className="toggle-track"><span className="toggle-knob" /></span>
                </label>
            </div>
            <p className="hint">
                Outside these hours, callers hear the message below instead of the normal menu — no agent
                needs to be online for this to work. Times are East Africa Time.
            </p>

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

            <label style={{ display: 'block', margin: '14px 0 6px' }}>Active days</label>
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

            <label style={{ display: 'block', marginTop: 14 }}>
                After-hours message
                <textarea
                    value={form.after_hours_message}
                    onChange={e => setForm({ ...form, after_hours_message: e.target.value })}
                    rows={2}
                />
            </label>

            <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
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
    const [confirmingEnable, setConfirmingEnable] = useState(false);

    const { data } = useQuery({ queryKey: ['ivr-config'], queryFn: () => apiFetch('/api/ivr-config') });

    const toggle = useMutation({
        mutationFn: (rating_enabled: boolean) =>
            apiFetch('/api/ivr-config', { method: 'PATCH', body: JSON.stringify({ rating_enabled }) }),
        onSuccess: (_data, rating_enabled) => {
            showToast(rating_enabled ? 'Call rating turned on' : 'Call rating turned off');
            queryClient.invalidateQueries({ queryKey: ['ivr-config'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    // Only turning it *on* needs a confirm — it's the direction that
    // immediately changes what every caller hears at the end of a call.
    // Turning it back off is always safe to do without one.
    function handleChange(checked: boolean) {
        if (checked) setConfirmingEnable(true);
        else toggle.mutate(false);
    }

    return (
        <div className="panel panel-header">
            <div>
                <h3 style={{ marginBottom: 2 }}>Call rating</h3>
                <p className="hint" style={{ marginBottom: 0 }}>
                    After the agent hangs up, the caller hears a 1-5 rating prompt before the line
                    disconnects. Off by default — changes live call flow.
                </p>
            </div>
            <label className="toggle-switch">
                <input
                    type="checkbox"
                    checked={!!data?.rating_enabled}
                    onChange={e => handleChange(e.target.checked)}
                />
                <span className="toggle-track"><span className="toggle-knob" /></span>
            </label>

            <ConfirmDialog
                open={confirmingEnable}
                title="Turn on call rating?"
                message="Every caller will hear a 1-5 rating prompt right before the line disconnects, starting with the next call. This takes effect immediately."
                confirmLabel="Turn on"
                onConfirm={() => {
                    toggle.mutate(true);
                    setConfirmingEnable(false);
                }}
                onCancel={() => setConfirmingEnable(false)}
            />
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

    const { data } = useQuery({ queryKey: ['hold-music'], queryFn: () => apiFetch('/api/hold-music') });
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
            <p className="hint">
                Played to callers waiting in the queue. Upload an MP3 (up to 8MB) to replace it, or reset
                back to the default at any time — takes effect immediately, including for callers already
                on hold.
            </p>

            <p className="hint" style={{ margin: '0 0 12px' }}>
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
                <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
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

    const { data: configData } = useQuery({ queryKey: ['forwarding-config'], queryFn: () => apiFetch('/api/forwarding-config') });
    const { data: rulesData } = useQuery({ queryKey: ['forwarding-rules'], queryFn: () => apiFetch('/api/forwarding-rules') });

    const rules: Rule[] = rulesData?.rules ?? [];

    const [newCondition, setNewCondition] = useState('no_answer');
    const [newDestination, setNewDestination] = useState('');
    const [pendingDelete, setPendingDelete] = useState<Rule | null>(null);
    const [confirmingEnable, setConfirmingEnable] = useState(false);

    const toggleEnabled = useMutation({
        mutationFn: (enabled: boolean) => apiFetch('/api/forwarding-config', { method: 'PATCH', body: JSON.stringify({ enabled }) }),
        onSuccess: (_data, enabled) => {
            showToast(enabled ? 'Call forwarding turned on' : 'Call forwarding turned off');
            queryClient.invalidateQueries({ queryKey: ['forwarding-config'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    // Same reasoning as the call-rating toggle above — enabling forwarding
    // immediately changes live call routing, disabling it doesn't need the
    // same guard.
    function handleToggleForwarding(checked: boolean) {
        if (checked) setConfirmingEnable(true);
        else toggleEnabled.mutate(false);
    }

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
        <div style={{ maxWidth: 720 }}>
            <BusinessHoursPanel />

            <div className="panel panel-header">
                <div>
                    <h3 style={{ marginBottom: 2 }}>Call forwarding</h3>
                    <p className="hint" style={{ marginBottom: 0 }}>Route calls elsewhere based on the rules below.</p>
                </div>
                <label className="toggle-switch">
                    <input
                        type="checkbox"
                        checked={!!configData?.enabled}
                        onChange={e => handleToggleForwarding(e.target.checked)}
                    />
                    <span className="toggle-track"><span className="toggle-knob" /></span>
                </label>
            </div>

            <ConfirmDialog
                open={confirmingEnable}
                title="Turn on call forwarding?"
                message="Calls will start routing according to the rules below the moment this is on. This takes effect immediately."
                confirmLabel="Turn on"
                onConfirm={() => {
                    toggleEnabled.mutate(true);
                    setConfirmingEnable(false);
                }}
                onCancel={() => setConfirmingEnable(false)}
            />

            <div className="panel">
                <div className="panel-header">
                    <h3>Rules</h3>
                </div>
                <p className="hint">
                    "No answer" is live — it fires when nobody at all is online. "Busy" and "always" are saved
                    but not yet applied to live call routing. "After hours" here is superseded by the Business
                    Hours panel above, which has its own dedicated message.
                </p>

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
            <HoldMusicPanel />
        </div>
    );
}
