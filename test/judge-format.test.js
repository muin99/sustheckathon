import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { analyzeTicket } from '../src/analyzer.js';
import { isUnsafeText } from '../src/safety.js';

const samplePack = JSON.parse(
  await readFile(new URL('../instructions/SUST_Preli_Sample_Cases.json', import.meta.url), 'utf8')
);

const requiredFields = [
  'ticket_id',
  'relevant_transaction_id',
  'evidence_verdict',
  'case_type',
  'severity',
  'department',
  'agent_summary',
  'recommended_next_action',
  'customer_reply',
  'human_review_required'
];

const optionalFields = ['confidence', 'reason_codes'];

const allowed = {
  evidence_verdict: new Set(samplePack._meta.allowed_enums.evidence_verdict),
  case_type: new Set(samplePack._meta.allowed_enums.case_type),
  severity: new Set(samplePack._meta.allowed_enums.severity),
  department: new Set(samplePack._meta.allowed_enums.department)
};

const severityRank = { low: 1, medium: 2, high: 3, critical: 4 };

function assertJudgeShape(output, input) {
  assert.deepEqual(
    Object.keys(output),
    [...requiredFields, ...optionalFields],
    `${input.ticket_id} output keys/order should match expected schema plus optional fields`
  );

  assert.equal(output.ticket_id, input.ticket_id, 'ticket_id must echo input');
  assert.ok(output.relevant_transaction_id === null || typeof output.relevant_transaction_id === 'string');
  assert.ok(allowed.evidence_verdict.has(output.evidence_verdict), 'invalid evidence_verdict enum');
  assert.ok(allowed.case_type.has(output.case_type), 'invalid case_type enum');
  assert.ok(allowed.severity.has(output.severity), 'invalid severity enum');
  assert.ok(allowed.department.has(output.department), 'invalid department enum');
  assert.equal(typeof output.agent_summary, 'string');
  assert.equal(typeof output.recommended_next_action, 'string');
  assert.equal(typeof output.customer_reply, 'string');
  assert.equal(typeof output.human_review_required, 'boolean');
  assert.equal(typeof output.confidence, 'number');
  assert.ok(output.confidence >= 0 && output.confidence <= 1, 'confidence must be 0..1');
  assert.ok(Array.isArray(output.reason_codes), 'reason_codes must be array');
  assert.doesNotThrow(() => JSON.stringify(output));
  assert.equal(isUnsafeText(output.customer_reply), false, 'unsafe customer_reply');
  assert.equal(isUnsafeText(output.recommended_next_action), false, 'unsafe recommended_next_action');
}

test('every public sample response is judge-shaped and functionally equivalent', async () => {
  for (const sample of samplePack.cases) {
    const actual = await analyzeTicket(sample.input, { useLlm: false });
    const expected = sample.expected_output;
    assertJudgeShape(actual, sample.input);

    assert.equal(actual.relevant_transaction_id, expected.relevant_transaction_id, `${sample.id} relevant_transaction_id`);
    assert.equal(actual.evidence_verdict, expected.evidence_verdict, `${sample.id} evidence_verdict`);
    assert.equal(actual.case_type, expected.case_type, `${sample.id} case_type`);
    assert.equal(actual.department, expected.department, `${sample.id} department`);
    assert.equal(actual.human_review_required, expected.human_review_required, `${sample.id} human_review_required`);
    assert.ok(
      Math.abs(severityRank[actual.severity] - severityRank[expected.severity]) <= 0,
      `${sample.id} severity`
    );
  }
});

test('hidden-style edge cases keep schema, safety, and core decisions', async () => {
  const edgeCases = [
    {
      name: 'cash-out vague should not become agent cash-in',
      input: {
        ticket_id: 'EDGE-FORMAT-001',
        complaint: 'My cash out failed, please check this transaction.',
        transaction_history: [
          {
            transaction_id: 'CASHOUT-1',
            timestamp: '2026-04-14T10:00:00Z',
            type: 'cash_out',
            amount: 1500,
            counterparty: 'AGENT-9',
            status: 'failed'
          }
        ]
      },
      expected: {
        case_type: 'other',
        department: 'customer_support',
        evidence_verdict: 'consistent'
      }
    },
    {
      name: 'explicit transaction id should select matching transaction',
      input: {
        ticket_id: 'EDGE-FORMAT-002',
        complaint: 'Please check TXN-SPECIFIC-2, I sent 450 by mistake.',
        transaction_history: [
          {
            transaction_id: 'TXN-SPECIFIC-1',
            timestamp: '2026-04-14T10:00:00Z',
            type: 'transfer',
            amount: 450,
            counterparty: '+8801711111111',
            status: 'completed'
          },
          {
            transaction_id: 'TXN-SPECIFIC-2',
            timestamp: '2026-04-14T10:10:00Z',
            type: 'transfer',
            amount: 450,
            counterparty: '+8801811111111',
            status: 'completed'
          }
        ]
      },
      expected: {
        case_type: 'wrong_transfer',
        relevant_transaction_id: 'TXN-SPECIFIC-2',
        evidence_verdict: 'consistent'
      }
    },
    {
      name: 'merchant settlement pending',
      input: {
        ticket_id: 'EDGE-FORMAT-003',
        complaint: 'Merchant payout settlement of 12000 is still not settled after the expected time.',
        channel: 'merchant_portal',
        user_type: 'merchant',
        transaction_history: [
          {
            transaction_id: 'SETTLE-12000',
            timestamp: '2026-04-13T18:00:00Z',
            type: 'settlement',
            amount: 12000,
            counterparty: 'MERCHANT-SELF',
            status: 'pending'
          }
        ]
      },
      expected: {
        case_type: 'merchant_settlement_delay',
        department: 'merchant_operations',
        relevant_transaction_id: 'SETTLE-12000'
      }
    },
    {
      name: 'credential leakage report after sharing otp',
      input: {
        ticket_id: 'EDGE-FORMAT-004',
        complaint: 'A caller asked for my OTP and I shared it. Now I am worried.',
        transaction_history: []
      },
      expected: {
        case_type: 'phishing_or_social_engineering',
        department: 'fraud_risk',
        severity: 'critical',
        human_review_required: true
      }
    }
  ];

  for (const item of edgeCases) {
    const actual = await analyzeTicket(item.input, { useLlm: false });
    assertJudgeShape(actual, item.input);
    for (const [field, expected] of Object.entries(item.expected)) {
      assert.equal(actual[field], expected, `${item.name} ${field}`);
    }
  }
});

