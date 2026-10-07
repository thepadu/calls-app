import { describe, expect, it } from 'vitest';
import { formatPhone, isValidPhone } from './phoneFormat';

describe('formatPhone', () => {
    it('converts a leading 0 to 254', () => {
        expect(formatPhone('0712345678')).toBe('254712345678');
    });

    it('strips a leading +254', () => {
        expect(formatPhone('+254712345678')).toBe('254712345678');
    });

    it('leaves an already-bare 254 number unchanged', () => {
        expect(formatPhone('254712345678')).toBe('254712345678');
    });

    it('strips whitespace', () => {
        expect(formatPhone(' 0712 345 678 ')).toBe('254712345678');
    });

    it('strips a leading + from an international number', () => {
        expect(formatPhone('+3272232362')).toBe('3272232362');
    });

    it('strips the + and whitespace from a spaced-out Kenya landline number', () => {
        expect(formatPhone('+254 20 7640622')).toBe('254207640622');
    });

    it('converts a redundant "+0..." (a + and a local leading 0 both present) fully to 254, not just stripping the +', () => {
        expect(formatPhone('+0207640622')).toBe('254207640622');
    });
});

describe('isValidPhone', () => {
    it('accepts a valid Safaricom-range number', () => {
        expect(isValidPhone('254712345678')).toBe(true);
    });

    it('accepts a valid Airtel-range (1xx) number', () => {
        expect(isValidPhone('254112345678')).toBe(true);
    });

    it('rejects a Kenya-shaped number that is too short (one digit missing)', () => {
        expect(isValidPhone('25471234567')).toBe(false);
    });

    it('accepts a Kenya landline number — not just mobile (the gap that prompted this fix)', () => {
        expect(isValidPhone('254207640622')).toBe(true);
    });

    it('rejects a non-numeric string', () => {
        expect(isValidPhone('not-a-phone')).toBe(false);
    });

    it('accepts a Belgian international number (the one that prompted this fix)', () => {
        expect(isValidPhone('3272232362')).toBe(true);
    });

    it('accepts a US international number', () => {
        expect(isValidPhone('12025551234')).toBe(true);
    });

    it('rejects an international-shaped number that is too short', () => {
        expect(isValidPhone('1234567')).toBe(false);
    });

    it('rejects an international-shaped number that is too long', () => {
        expect(isValidPhone('1234567890123456')).toBe(false);
    });
});
