import { expect, test } from 'claude-code/testing';
import { register } from '../compact.ts';

test('registers the compaction boundary hook', () => {
  expect(typeof register).toBe('function');
});
