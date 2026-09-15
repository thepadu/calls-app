import { describe, it, expect } from 'vitest';
import { escapeLikePattern } from './text.js';

describe('escapeLikePattern', () => {
    it('leaves a plain string with no wildcard characters unchanged', () => {
        expect(escapeLikePattern('sam.njoki@chumz.io')).toBe('sam.njoki@chumz.io');
    });

    it('escapes underscore so it matches a literal underscore, not "any character"', () => {
        expect(escapeLikePattern('first_last@chumz.io')).toBe('first\\_last@chumz.io');
    });

    it('escapes percent so it matches a literal percent, not "any run of characters"', () => {
        expect(escapeLikePattern('100%done@chumz.io')).toBe('100\\%done@chumz.io');
    });

    it('escapes a literal backslash before escaping other characters', () => {
        expect(escapeLikePattern('a\\_b')).toBe('a\\\\\\_b');
    });

    it('returns an empty string for null/undefined without throwing', () => {
        expect(escapeLikePattern(null)).toBe('');
        expect(escapeLikePattern(undefined)).toBe('');
    });
});
