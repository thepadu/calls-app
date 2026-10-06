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
});

describe('isValidPhone', () => {
    it('accepts a valid Safaricom-range number', () => {
        expect(isValidPhone('254712345678')).toBe(true);
    });

    it('accepts a valid Airtel-range (1xx) number', () => {
        expect(isValidPhone('254112345678')).toBe(true);
    });

    it('rejects a number that is too short', () => {
        expect(isValidPhone('25471234567')).toBe(false);
    });

    it('rejects a number with the wrong prefix', () => {
        expect(isValidPhone('254812345678')).toBe(false);
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

    it('still rejects a malformed Kenya-shaped number even though it is otherwise the right length', () => {
        expect(isValidPhone('254812345678')).toBe(false);
    });
});
