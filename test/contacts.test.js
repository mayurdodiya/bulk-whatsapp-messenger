import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContacts } from '../src/contacts.js';

test('keeps formatted international number as one', () => {
  assert.deepEqual(parseContacts('+91 98765-43210', '').valid, ['919876543210']);
});
test('handles brackets and inner spaces', () => {
  assert.deepEqual(parseContacts('(022) 1234 5678', '91').valid, ['912212345678']);
});
test('prepends country code (with +)', () => {
  assert.deepEqual(parseContacts('9876543210', '+91').valid, ['919876543210']);
});
test('strips leading trunk zero before adding code', () => {
  assert.deepEqual(parseContacts('09876543210', '91').valid, ['919876543210']);
});
test('does not double an existing country code', () => {
  assert.deepEqual(parseContacts('919876543210', '91').valid, ['919876543210']);
});
test('00 prefix means international', () => {
  assert.deepEqual(parseContacts('0044 7911 123456', '91').valid, ['447911123456']);
});
test('splits on newline comma semicolon tab', () => {
  const r = parseContacts('9876543210\n9876543211,9876543212;9876543213\t9876543214', '91');
  assert.equal(r.valid.length, 5);
});
test('short numbers are invalid, blanks ignored, duplicates counted', () => {
  const r = parseContacts('123\n\n  \n9876543210\n+91 9876543210', '91');
  assert.deepEqual(r.invalid, ['123']);
  assert.deepEqual(r.valid, ['919876543210']);
  assert.equal(r.duplicates, 1);
});
test('too long is invalid', () => {
  assert.equal(parseContacts('+1234567890123456', '').invalid.length, 1);
});

test('counts valid entries typed without a country code', () => {
  const r = parseContacts('9876543210\n+91 9876543211\n0044 7911 123456\n919876543212', '');
  assert.equal(r.valid.length, 4);
  assert.equal(r.withoutCode, 2);
});
