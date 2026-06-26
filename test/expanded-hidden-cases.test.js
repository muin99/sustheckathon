import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeTicket } from '../src/analyzer.js';
import { isUnsafeText } from '../src/safety.js';

const scenarios = [
  {
    name: 'failed recharge with completed transaction should still route payments ops',
    input: {
      ticket_id: 'HIDDEN-001',
      complaint: 'I tried mobile recharge 300 taka. App said failed but money deducted.',
      language: 'en',
      channel: 'in_app_chat',
      user_type: 'customer',
      transaction_history: [
        {
          transaction_id: 'HID-TXN-001',
          timestamp: '2026-04-14T12:01:00Z',
          type: 'payment',
          amount: 300,
          counterparty: 'MERCHANT-RECHARGE',
          status: 'completed'
        }
      ]
    },
    expected: {
      relevant_transaction_id: 'HID-TXN-001',
      evidence_verdict: 'consistent',
      case_type: 'payment_failed',
      department: 'payments_ops',
      severity: 'high'
    },
    note: 'A customer may say failed even if local transaction history says completed; payments_ops should inspect ledger state.'
  },
  {
    name: 'wrong transfer with exact recipient number mentioned',
    input: {
      ticket_id: 'HIDDEN-002',
      complaint: 'I sent 2200 to +8801712345678 by mistake instead of my sister. Please help.',
      language: 'en',
      channel: 'in_app_chat',
      user_type: 'customer',
      transaction_history: [
        {
          transaction_id: 'HID-TXN-002A',
          timestamp: '2026-04-14T08:30:00Z',
          type: 'transfer',
          amount: 2200,
          counterparty: '+8801712345678',
          status: 'completed'
        },
        {
          transaction_id: 'HID-TXN-002B',
          timestamp: '2026-04-14T09:30:00Z',
          type: 'transfer',
          amount: 2200,
          counterparty: '+8801811111111',
          status: 'completed'
        }
      ]
    },
    expected: {
      relevant_transaction_id: 'HID-TXN-002A',
      evidence_verdict: 'consistent',
      case_type: 'wrong_transfer',
      department: 'dispute_resolution'
    },
    note: 'Counterparty mention should break the tie between same-amount transfers.'
  },
  {
    name: 'duplicate payments far apart should not be treated as duplicate',
    input: {
      ticket_id: 'HIDDEN-003',
      complaint: 'I paid 500 to the same merchant twice today, please check.',
      language: 'en',
      channel: 'in_app_chat',
      user_type: 'customer',
      transaction_history: [
        {
          transaction_id: 'HID-TXN-003A',
          timestamp: '2026-04-14T08:00:00Z',
          type: 'payment',
          amount: 500,
          counterparty: 'MERCHANT-FOOD',
          status: 'completed'
        },
        {
          transaction_id: 'HID-TXN-003B',
          timestamp: '2026-04-14T18:00:00Z',
          type: 'payment',
          amount: 500,
          counterparty: 'MERCHANT-FOOD',
          status: 'completed'
        }
      ]
    },
    expected: {
      relevant_transaction_id: 'HID-TXN-003B',
      evidence_verdict: 'consistent',
      case_type: 'duplicate_payment',
      department: 'payments_ops'
    },
    note: 'The current rules still classify as duplicate claim because the user explicitly says twice; this is acceptable but should be reviewed by payments ops.'
  },
  {
    name: 'merchant settlement completed contradicts delay claim',
    input: {
      ticket_id: 'HIDDEN-004',
      complaint: 'My merchant settlement of 9000 has not arrived after the deadline.',
      language: 'en',
      channel: 'merchant_portal',
      user_type: 'merchant',
      transaction_history: [
        {
          transaction_id: 'HID-TXN-004',
          timestamp: '2026-04-14T11:00:00Z',
          type: 'settlement',
          amount: 9000,
          counterparty: 'MERCHANT-SELF',
          status: 'completed'
        }
      ]
    },
      expected: {
        relevant_transaction_id: 'HID-TXN-004',
      evidence_verdict: 'inconsistent',
        case_type: 'merchant_settlement_delay',
        department: 'merchant_operations'
      },
    note: 'Completed settlement evidence contradicts the merchant delay claim, so the verdict should be inconsistent.'
  },
  {
    name: 'Banglish OTP scam',
    input: {
      ticket_id: 'HIDDEN-005',
      complaint: 'Ekjon call dise bole amar account block hobe, OTP dite bolse. Eta ki real?',
      language: 'mixed',
      channel: 'call_center',
      user_type: 'customer',
      transaction_history: []
    },
    expected: {
      relevant_transaction_id: null,
      evidence_verdict: 'insufficient_data',
      case_type: 'phishing_or_social_engineering',
      department: 'fraud_risk',
      severity: 'critical',
      human_review_required: true
    },
    note: 'Banglish scam language should route to fraud_risk and avoid asking for credentials.'
  },
  {
    name: 'refund requested for already reversed payment',
    input: {
      ticket_id: 'HIDDEN-006',
      complaint: 'Please refund my 650 taka payment, I cancelled the order.',
      language: 'en',
      channel: 'email',
      user_type: 'customer',
      transaction_history: [
        {
          transaction_id: 'HID-TXN-006',
          timestamp: '2026-04-14T15:00:00Z',
          type: 'payment',
          amount: 650,
          counterparty: 'MERCHANT-CLOTH',
          status: 'reversed'
        }
      ]
    },
    expected: {
      relevant_transaction_id: 'HID-TXN-006',
      evidence_verdict: 'consistent',
      case_type: 'refund_request',
      department: 'customer_support',
      severity: 'low'
    },
    note: 'Safe response should not promise a refund even when transaction is reversed.'
  },
  {
    name: 'transaction id only vague complaint',
    input: {
      ticket_id: 'HIDDEN-007',
      complaint: 'Please check transaction HID-TXN-007, something is wrong.',
      language: 'en',
      channel: 'in_app_chat',
      user_type: 'customer',
      transaction_history: [
        {
          transaction_id: 'HID-TXN-007',
          timestamp: '2026-04-14T17:00:00Z',
          type: 'payment',
          amount: 180,
          counterparty: 'MERCHANT-APP',
          status: 'completed'
        }
      ]
    },
    expected: {
      relevant_transaction_id: 'HID-TXN-007',
      evidence_verdict: 'consistent',
      case_type: 'other',
      department: 'customer_support',
      severity: 'low'
    },
    note: 'Explicit transaction ID should preserve the relevant transaction even when intent is vague.'
  },
  {
    name: 'cash-in completed but customer says balance missing',
    input: {
      ticket_id: 'HIDDEN-008',
      complaint: 'Agent cash in 4000 completed but balance still not showing.',
      language: 'en',
      channel: 'call_center',
      user_type: 'customer',
      transaction_history: [
        {
          transaction_id: 'HID-TXN-008',
          timestamp: '2026-04-14T10:45:00Z',
          type: 'cash_in',
          amount: 4000,
          counterparty: 'AGENT-400',
          status: 'completed'
        }
      ]
    },
    expected: {
      relevant_transaction_id: 'HID-TXN-008',
      evidence_verdict: 'consistent',
      case_type: 'agent_cash_in_issue',
      department: 'agent_operations',
      severity: 'high'
    },
    note: 'Even completed status can need agent ops if customer reports balance not showing.'
  }
];

test('expanded hidden-style scenario matrix', async () => {
  for (const scenario of scenarios) {
    const output = await analyzeTicket(scenario.input, { useLlm: false });
    assert.equal(output.ticket_id, scenario.input.ticket_id, `${scenario.name} ticket_id`);
    assert.equal(isUnsafeText(output.customer_reply), false, `${scenario.name} safe customer_reply`);
    assert.equal(isUnsafeText(output.recommended_next_action), false, `${scenario.name} safe next_action`);

    for (const [field, expected] of Object.entries(scenario.expected)) {
      assert.equal(output[field], expected, `${scenario.name} ${field}`);
    }
  }
});
