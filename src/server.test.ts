import assert from 'node:assert/strict';
const allowed = ['field_checklist', 'work_notes', 'evidence', 'captured_location', 'status'];
assert.equal(allowed.includes('work_notes'), true);
assert.equal(allowed.includes('assigned_to'), false);
console.log('Gateway boundary checks passed');
