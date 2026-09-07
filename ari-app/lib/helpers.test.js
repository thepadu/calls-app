import { afterEach, describe, expect, it, vi } from 'vitest';
import { errText, safeEqual, isWithinBusinessHours, parseSipUsername } from './helpers.js';

describe('errText', () => {
    it('returns a plain string message unchanged', () => {
        expect(errText(new Error('Channel not found'))).toBe('Channel not found');
    });

    it('stringifies an ARI error whose .message is itself a parsed JSON object', () => {
        // The exact real shape confirmed live: a 404 against an already-gone
        // channel comes back as { message: { message: 'Channel not found' } },
        // not a string — err.message on that prints "[object Object]".
        const ariStyleError = { message: { message: 'Channel not found' } };
        expect(errText(ariStyleError)).toBe('{"message":"Channel not found"}');
    });

    it('falls back to String(err) for something with no .message at all', () => {
        expect(errText('a bare string rejection')).toBe('a bare string rejection');
        expect(errText(null)).toBe('null');
    });
});

describe('safeEqual', () => {
    it('returns true for two identical strings', () => {
        expect(safeEqual('shared-secret-123', 'shared-secret-123')).toBe(true);
    });

    it('returns false for different strings of the same length', () => {
        expect(safeEqual('shared-secret-123', 'shared-secret-456')).toBe(false);
    });

    it('returns false for different-length strings without throwing', () => {
        // crypto.timingSafeEqual itself throws on a length mismatch — the
        // whole reason this wrapper exists is to check length first instead.
        expect(safeEqual('short', 'a-much-longer-value')).toBe(false);
    });

    it('treats a missing header value the same as an empty string, not a crash', () => {
        expect(safeEqual(undefined, 'real-secret')).toBe(false);
        expect(safeEqual(undefined, '')).toBe(true);
    });
});

describe('isWithinBusinessHours', () => {
    // active_days: 0=Sunday..6=Saturday. Nairobi (EAT, UTC+3) has no DST,
    // which is exactly why this function can just add a fixed 3h offset
    // instead of needing a timezone library — worth a test that actually
    // pins the clock, since a bug here would only ever show up at exactly
    // the wrong hour of the day, easy to never notice by hand.
    const weekdayHours = { active_days: [1, 2, 3, 4, 5], open_time: '08:00', close_time: '17:00' };

    afterEach(() => {
        vi.useRealTimers();
    });

    it('is open at 09:00 Nairobi time on a weekday', () => {
        // 2026-09-07 is a Monday; 06:00 UTC = 09:00 EAT.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-07T06:00:00Z'));
        expect(isWithinBusinessHours(weekdayHours)).toBe(true);
    });

    it('is closed at 07:59 Nairobi time, one minute before opening', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-07T04:59:00Z')); // 07:59 EAT
        expect(isWithinBusinessHours(weekdayHours)).toBe(false);
    });

    it('is closed exactly at closing time, not one minute after', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-07T14:00:00Z')); // 17:00 EAT exactly
        expect(isWithinBusinessHours(weekdayHours)).toBe(false);
    });

    it('is closed on a Saturday even during normal weekday hours', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-05T06:00:00Z')); // Saturday, 09:00 EAT
        expect(isWithinBusinessHours(weekdayHours)).toBe(false);
    });
});

describe('parseSipUsername', () => {
    it('extracts the endpoint name from a real channel name', () => {
        expect(parseSipUsername('PJSIP/simon-00000123')).toBe('simon');
    });

    it('matches up to the LAST hyphen, not the first', () => {
        // A sip_username containing its own hyphen (the schema places no
        // constraint on the value) would be truncated by a first-hyphen match.
        expect(parseSipUsername('PJSIP/agent-42-00000abc')).toBe('agent-42');
    });

    it('returns null for a channel name that is not a PJSIP endpoint', () => {
        expect(parseSipUsername('Local/s@from-at-trunk-00000001;1')).toBeNull();
    });

    it('returns null for undefined/empty input without throwing', () => {
        expect(parseSipUsername(undefined)).toBeNull();
        expect(parseSipUsername('')).toBeNull();
    });
});
