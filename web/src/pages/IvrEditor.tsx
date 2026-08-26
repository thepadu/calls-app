import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { useToast } from '../lib/toast';
import { useModalA11y } from '../lib/useModalA11y';
import ConfirmDialog from '../components/ConfirmDialog';

type IvrOption = {
    digit: string;
    label: string;
    response_message: string | null;
    action: 'message' | 'transfer_agent' | 'repeat_menu';
};

const ACTIONS: { value: IvrOption['action']; label: string }[] = [
    { value: 'message', label: 'Say a message' },
    { value: 'transfer_agent', label: 'Transfer to an available agent' },
    { value: 'repeat_menu', label: 'Repeat this menu' }
];

const EMPTY_FORM = { digit: '', label: '', response_message: '', action: 'message' as IvrOption['action'] };

function errorMessage(err: unknown) {
    return err instanceof Error ? err.message : 'Something went wrong';
}

export default function IvrEditor() {
    const queryClient = useQueryClient();
    const showToast = useToast();

    const {
        data: greetingData,
        isError: greetingIsError,
        error: greetingError,
        refetch: refetchGreeting
    } = useQuery({ queryKey: ['ivr-config'], queryFn: () => apiFetch('/api/ivr-config') });

    const {
        data: optionsData,
        isError: optionsIsError,
        error: optionsError,
        refetch: refetchOptions
    } = useQuery({ queryKey: ['ivr-options'], queryFn: () => apiFetch('/api/ivr-options') });

    const options: IvrOption[] = useMemo(() => optionsData?.options ?? [], [optionsData]);

    const [greeting, setGreeting] = useState('');
    const [ttsVoice, setTtsVoice] = useState<string>('');
    const [ttsSpeedScale, setTtsSpeedScale] = useState(1.0);
    const [menuEnabled, setMenuEnabled] = useState(true);
    const [drafts, setDrafts] = useState<Record<string, IvrOption>>({});
    const [addOpen, setAddOpen] = useState(false);
    const [addForm, setAddForm] = useState(EMPTY_FORM);
    const [addError, setAddError] = useState('');
    const [pendingDelete, setPendingDelete] = useState<IvrOption | null>(null);

    const greetingDirty =
        greeting !== (greetingData?.greeting ?? '') ||
        ttsVoice !== (greetingData?.tts_voice ?? '') ||
        ttsSpeedScale !== (greetingData?.tts_speed_scale ?? 1.0);

    useEffect(() => {
        // A refetch of ivr-config can be triggered by something totally
        // unrelated to the greeting form itself (e.g. the menu-enabled
        // toggle below, which invalidates the same query) — without this
        // guard, that refetch silently overwrote an agent's in-progress,
        // unsaved greeting/voice/speed edit with the server's old values.
        if (greetingDirty) return;
        if (greetingData?.greeting !== undefined) setGreeting(greetingData.greeting);
        if (greetingData?.tts_voice !== undefined) setTtsVoice(greetingData.tts_voice ?? '');
        if (greetingData?.tts_speed_scale !== undefined) setTtsSpeedScale(greetingData.tts_speed_scale ?? 1.0);
        if (greetingData?.menu_enabled !== undefined) setMenuEnabled(!!greetingData.menu_enabled);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [greetingData]);

    useEffect(() => {
        // Never overwrite an EXISTING draft from a refetch (saving one
        // option used to invalidate the whole list, which reset every
        // OTHER row's in-progress unsaved edit too) — only seed a draft for
        // an option that doesn't have one yet (a genuinely new row) or one
        // that no longer exists on the server (dropped naturally, since
        // only options present in `options` get an entry at all).
        setDrafts(current => Object.fromEntries(options.map(o => [o.digit, current[o.digit] ?? o])));
    }, [options]);

    function invalidateOptions() {
        queryClient.invalidateQueries({ queryKey: ['ivr-options'] });
    }

    const saveGreeting = useMutation({
        mutationFn: () =>
            apiFetch('/api/ivr-config', {
                method: 'PATCH',
                body: JSON.stringify({
                    greeting,
                    tts_voice: ttsVoice || null,
                    tts_speed_scale: ttsSpeedScale
                })
            }),
        onSuccess: () => {
            showToast('Greeting saved');
            queryClient.invalidateQueries({ queryKey: ['ivr-config'] });
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    // Applies immediately on toggle (not batched with "Save greeting") —
    // same pattern as the business-hours/call-rating toggles elsewhere in
    // this app. When disabled, callers hear only the greeting and go
    // straight to the queue (ari-app's runIvrMenu) — no digit-press menu.
    const toggleMenuEnabled = useMutation({
        mutationFn: (enabled: boolean) => apiFetch('/api/ivr-config', { method: 'PATCH', body: JSON.stringify({ menu_enabled: enabled }) }),
        onSuccess: (_data, enabled) => {
            showToast(enabled ? 'Menu enabled' : 'Menu disabled — callers now hear only the greeting');
            queryClient.invalidateQueries({ queryKey: ['ivr-config'] });
        },
        onError: (err: unknown) => {
            showToast(errorMessage(err), 'error');
            setMenuEnabled(current => !current); // roll back the optimistic toggle
        }
    });

    function handleMenuEnabledChange(checked: boolean) {
        setMenuEnabled(checked);
        toggleMenuEnabled.mutate(checked);
    }

    const saveOption = useMutation({
        mutationFn: (digit: string) => {
            const draft = drafts[digit];
            return apiFetch(`/api/ivr-options/${digit}`, {
                method: 'PATCH',
                body: JSON.stringify({ label: draft.label, response_message: draft.response_message, action: draft.action })
            });
        },
        onSuccess: (_data, digit) => {
            showToast(`Option ${digit} saved`);
            invalidateOptions();
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error')
    });

    const deleteOption = useMutation({
        mutationFn: (digit: string) => apiFetch(`/api/ivr-options/${digit}`, { method: 'DELETE' }),
        onSuccess: (_data, digit) => {
            showToast(`Option ${digit} removed`);
            invalidateOptions();
        },
        onError: (err: unknown) => showToast(errorMessage(err), 'error'),
        onSettled: () => setPendingDelete(null)
    });

    const addOption = useMutation({
        mutationFn: () => apiFetch('/api/ivr-options', { method: 'POST', body: JSON.stringify(addForm) }),
        onSuccess: () => {
            showToast(`Option ${addForm.digit} added`);
            setAddOpen(false);
            setAddForm(EMPTY_FORM);
            invalidateOptions();
        },
        onError: (err: unknown) => setAddError(errorMessage(err))
    });

    function updateDraft(digit: string, changes: Partial<IvrOption>) {
        setDrafts(current => ({ ...current, [digit]: { ...current[digit], ...changes } }));
    }

    function isDirty(digit: string) {
        const original = options.find(o => o.digit === digit);
        const draft = drafts[digit];
        if (!original || !draft) return false;
        return (
            original.label !== draft.label ||
            original.response_message !== draft.response_message ||
            original.action !== draft.action
        );
    }

    const addModalRef = useModalA11y(addOpen, () => setAddOpen(false));

    return (
        <div className="ivr-layout">
            <div>
                <div className="panel">
                    <h3>Greeting message</h3>
                    {greetingIsError && (
                        <p className="error">
                            Couldn&apos;t load the greeting ({errorMessage(greetingError)}).{' '}
                            <button className="btn-link" onClick={() => refetchGreeting()}>Retry</button>
                        </p>
                    )}
                    <textarea value={greeting} onChange={e => setGreeting(e.target.value)} rows={2} />

                    <label>
                        Voice
                        <select value={ttsVoice} onChange={e => setTtsVoice(e.target.value)}>
                            <option value="">Default</option>
                            <option value="lady">Lady</option>
                            <option value="man">Man</option>
                        </select>
                    </label>
                    <label>
                        Speaking speed ({ttsSpeedScale.toFixed(2)}× {ttsSpeedScale > 1 ? 'slower' : ttsSpeedScale < 1 ? 'faster' : ''})
                        <input
                            type="range"
                            min={0.5}
                            max={2.0}
                            step={0.05}
                            value={ttsSpeedScale}
                            onChange={e => setTtsSpeedScale(Number(e.target.value))}
                        />
                    </label>
                    <p className="hint">
                        Length scale, not playback speed — higher plays slower with the same natural cadence.
                        {ttsVoice === 'man' && ' The "man" voice needs a second voice model installed on the server to sound different from the default.'}
                    </p>

                    <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
                        <button
                            className="btn btn-primary"
                            onClick={() => saveGreeting.mutate()}
                            disabled={saveGreeting.isPending || !greetingDirty}
                        >
                            Save greeting
                        </button>
                    </div>
                </div>

                <div className="panel">
                    <div className="panel-header">
                        <h3>Menu options</h3>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <label className="toggle-switch" title={menuEnabled ? 'Menu is on' : 'Menu is off — callers hear only the greeting'}>
                                <input
                                    type="checkbox"
                                    checked={menuEnabled}
                                    onChange={e => handleMenuEnabledChange(e.target.checked)}
                                />
                                <span className="toggle-track"><span className="toggle-knob" /></span>
                            </label>
                            <button className="btn btn-primary" onClick={() => setAddOpen(true)}>+ Add option</button>
                        </div>
                    </div>
                    <p className="hint">
                        {menuEnabled
                            ? 'This is exactly what callers hear — edits take effect on the next call.'
                            : 'Menu is off — callers hear only the greeting, then go straight to the queue. Options below are kept but not played.'}
                    </p>
                    {optionsIsError && (
                        <p className="error">
                            Couldn&apos;t load the menu ({errorMessage(optionsError)}).{' '}
                            <button className="btn-link" onClick={() => refetchOptions()}>Retry</button>
                        </p>
                    )}

                    {options.map(option => {
                        const draft = drafts[option.digit] ?? option;
                        return (
                            <div className="ivr-row" key={option.digit}>
                                <div className="ivr-row-digit">{option.digit}</div>
                                <div className="ivr-row-fields">
                                    <label>
                                        Label (shown as &quot;Press {option.digit} for ___&quot;)
                                        <input
                                            value={draft.label}
                                            onChange={e => updateDraft(option.digit, { label: e.target.value })}
                                        />
                                    </label>
                                    <label>
                                        Action
                                        <select
                                            value={draft.action}
                                            onChange={e => updateDraft(option.digit, { action: e.target.value as IvrOption['action'] })}
                                        >
                                            {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                                        </select>
                                    </label>
                                    {draft.action !== 'repeat_menu' && (
                                        <label>
                                            {draft.action === 'transfer_agent' ? 'Message before transferring' : 'Response message'}
                                            <textarea
                                                value={draft.response_message ?? ''}
                                                onChange={e => updateDraft(option.digit, { response_message: e.target.value })}
                                                rows={2}
                                            />
                                        </label>
                                    )}
                                </div>
                                <div className="ivr-row-actions">
                                    <button
                                        className="btn btn-primary"
                                        disabled={!isDirty(option.digit) || saveOption.isPending}
                                        onClick={() => saveOption.mutate(option.digit)}
                                    >
                                        Save
                                    </button>
                                    <button className="btn btn-link btn-link-danger" onClick={() => setPendingDelete(option)}>
                                        Remove
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            <div className="panel">
                <h3>Call flow preview</h3>
                <div className="ivr-preview-greeting">&quot;{greeting} {options.map(o => `Press ${o.digit} for ${o.label}.`).join(' ')}&quot;</div>
                {options.map(o => (
                    <div className="ivr-preview-step" key={o.digit}>
                        <div className="ivr-preview-key">{o.digit}</div>
                        <div className="ivr-preview-text">
                            <strong>{o.label}</strong>
                            {ACTIONS.find(a => a.value === o.action)?.label}
                        </div>
                    </div>
                ))}
            </div>

            {addOpen && (
                <div className="modal-overlay" onClick={() => setAddOpen(false)}>
                    <div ref={addModalRef} className="modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
                        <h3>Add IVR Option</h3>

                        <label>
                            Digit (0-9, *, #)
                            <input
                                maxLength={1}
                                value={addForm.digit}
                                onChange={e => setAddForm({ ...addForm, digit: e.target.value })}
                            />
                        </label>
                        <label>
                            Label
                            <input value={addForm.label} onChange={e => setAddForm({ ...addForm, label: e.target.value })} />
                        </label>
                        <label>
                            Action
                            <select
                                value={addForm.action}
                                onChange={e => setAddForm({ ...addForm, action: e.target.value as IvrOption['action'] })}
                            >
                                {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                            </select>
                        </label>
                        {addForm.action !== 'repeat_menu' && (
                            <label>
                                Response message
                                <textarea
                                    value={addForm.response_message}
                                    onChange={e => setAddForm({ ...addForm, response_message: e.target.value })}
                                    rows={2}
                                />
                            </label>
                        )}

                        {addError && <p className="error">{addError}</p>}

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setAddOpen(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={() => addOption.mutate()} disabled={addOption.isPending}>
                                Add
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <ConfirmDialog
                open={!!pendingDelete}
                title="Remove IVR option"
                message={
                    options.length === 1
                        ? `Remove option ${pendingDelete?.digit} ("${pendingDelete?.label}")? This is the last remaining option — callers will hear only the greeting and go straight to the queue, same as turning the menu off.`
                        : `Remove option ${pendingDelete?.digit} ("${pendingDelete?.label}")? Callers who press ${pendingDelete?.digit} will hear "Invalid input" until you add another.`
                }
                confirmLabel="Remove"
                danger
                onConfirm={() => pendingDelete && deleteOption.mutate(pendingDelete.digit)}
                onCancel={() => setPendingDelete(null)}
            />
        </div>
    );
}
