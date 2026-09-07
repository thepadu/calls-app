import { describe, it, expect } from 'vitest';
import { isValidE164, normalizePhone } from './phone.js';

describe('isValidE164', () => {
    it('accepts a real Kenyan number', () => {
        expect(isValidE164('+254712345678')).toBe(true);
    });

    it('accepts a real Rwandan number (not +254-hardcoded)', () => {
        expect(isValidE164('+250712345678')).toBe(true);
    });

    it('rejects a number missing the leading +', () => {
        expect(isValidE164('254712345678')).toBe(false);
    });

    it('rejects fewer than 8 digits', () => {
        expect(isValidE164('+1234567')).toBe(false);
    });

    it('rejects more than 15 digits', () => {
        expect(isValidE164('+1234567890123456')).toBe(false);
    });

    it('rejects non-digit characters', () => {
        expect(isValidE164('+254-712-345-678')).toBe(false);
    });

    it('rejects null/undefined/empty without throwing', () => {
        expect(isValidE164(null)).toBe(false);
        expect(isValidE164(undefined)).toBe(false);
        expect(isValidE164('')).toBe(false);
    });
});

describe('normalizePhone', () => {
    it('returns null for null/undefined/empty', () => {
        expect(normalizePhone(null)).toBeNull();
        expect(normalizePhone(undefined)).toBeNull();
        expect(normalizePhone('')).toBeNull();
    });

    it('strips a leading + from an already-international number', () => {
        expect(normalizePhone('+254712345678')).toBe('254712345678');
    });

    it('converts a local 0-prefixed number to 254-prefixed', () => {
        expect(normalizePhone('0712345678')).toBe('254712345678');
    });

    it('leaves an already-bare (no +, no leading 0) number unchanged', () => {
        expect(normalizePhone('254712345678')).toBe('254712345678');
    });

    it('strips embedded and surrounding whitespace before normalizing', () => {
        expect(normalizePhone(' +254 712 345 678 ')).toBe('254712345678');
    });

    it('only converts a genuine leading 0, not a 0 elsewhere in the number', () => {
        // a number that happens to contain a 0 later must not be mistaken
        // for a local-format number just because normalizePhone looks at
        // the first character
        expect(normalizePhone('254701234567')).toBe('254701234567');
    });
});
