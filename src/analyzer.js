import { callLlm } from './llm.js';
import { genericSafeReply, sanitizeText } from './safety.js';

const CASE_TYPES = new Set([
  'wrong_transfer',
  'payment_failed',
  'refund_request',
  'duplicate_payment',
  'merchant_settlement_delay',
  'agent_cash_in_issue',
  'phishing_or_social_engineering',
  'other'
]);

const VERDICTS = new Set(['consistent', 'inconsistent', 'insufficient_data']);
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const DEPARTMENTS = new Set([
  'customer_support',
  'dispute_resolution',
  'payments_ops',
  'merchant_operations',
  'agent_operations',
  'fraud_risk'
]);

const BN_DIGITS = new Map([
  ['০', '0'],
  ['১', '1'],
  ['২', '2'],
  ['৩', '3'],
  ['৪', '4'],
  ['৫', '5'],
  ['৬', '6'],
  ['৭', '7'],
  ['৮', '8'],
  ['৯', '9']
]);

export async function analyzeTicket(ticket, options = {}) {
  const facts = buildFacts(ticket);
  const ruleResult = analyzeWithRules(ticket, facts);
  let llmResult = null;

  if (options.useLlm !== false && shouldAskLlm(ruleResult, facts)) {
    llmResult = await callLlm({
      complaint: ticket.complaint,
      language: facts.language,
      user_type: ticket.user_type || 'unknown',
      transaction_history: facts.transactions,
      rule_result: ruleResult,
      allowed_enums: {
        evidence_verdict: [...VERDICTS],
        case_type: [...CASE_TYPES],
        severity: [...SEVERITIES],
        department: [...DEPARTMENTS]
      }
    });
  }

  return finalizeResponse(ticket, facts, mergeLlm(ruleResult, llmResult));
}

export function analyzeWithRules(ticket, facts = buildFacts(ticket)) {
  if (facts.isPhishing) {
    return makeResult({
      ticket,
      facts,
      case_type: 'phishing_or_social_engineering',
      relevant_transaction_id: null,
      evidence_verdict: 'insufficient_data',
      severity: 'critical',
      department: 'fraud_risk',
      human_review_required: true,
      confidence: 0.95,
      reason_codes: ['phishing', 'credential_protection', 'critical_escalation']
    });
  }

  const duplicate = findDuplicatePayment(facts.transactions, facts);
  if (facts.isDuplicatePayment || duplicate) {
    const txn = duplicate?.duplicate || bestTransaction(facts, ['payment']);
    return makeResult({
      ticket,
      facts,
      case_type: 'duplicate_payment',
      relevant_transaction_id: txn?.transaction_id || null,
      evidence_verdict: duplicate || txn ? 'consistent' : 'insufficient_data',
      severity: duplicate || txn ? 'high' : 'medium',
      department: 'payments_ops',
      human_review_required: Boolean(duplicate || txn),
      confidence: duplicate ? 0.93 : 0.68,
      reason_codes: duplicate
        ? ['duplicate_payment', 'biller_verification_required']
        : ['duplicate_payment_claim', 'needs_transaction_match']
    });
  }

  if (facts.isMerchantSettlement) {
    const txn = bestTransaction(facts, ['settlement']);
    const completedButClaimedMissing = txn?.status === 'completed' &&
      hasAny(facts.lower, ['not arrived', 'not received', 'not settled', 'has not arrived', 'have not received', 'পাইনি', 'আসেনি']);
    return makeResult({
      ticket,
      facts,
      case_type: 'merchant_settlement_delay',
      relevant_transaction_id: txn?.transaction_id || null,
      evidence_verdict: txn ? completedButClaimedMissing ? 'inconsistent' : 'consistent' : 'insufficient_data',
      severity: 'medium',
      department: 'merchant_operations',
      human_review_required: completedButClaimedMissing,
      confidence: txn ? completedButClaimedMissing ? 0.76 : 0.92 : 0.66,
      reason_codes: ['merchant_settlement', completedButClaimedMissing ? 'evidence_inconsistent' : txn?.status || 'needs_settlement_details'].filter(Boolean)
    });
  }

  if (facts.isAgentCashIn) {
    const txn = bestTransaction(facts, ['cash_in']);
    return makeResult({
      ticket,
      facts,
      case_type: 'agent_cash_in_issue',
      relevant_transaction_id: txn?.transaction_id || null,
      evidence_verdict: txn ? 'consistent' : 'insufficient_data',
      severity: txn ? 'high' : 'medium',
      department: 'agent_operations',
      human_review_required: Boolean(txn),
      confidence: txn ? 0.88 : 0.65,
      reason_codes: ['agent_cash_in', txn?.status === 'pending' ? 'pending_transaction' : null, 'agent_ops'].filter(Boolean)
    });
  }

  if (facts.isPaymentFailed) {
    const txn = bestTransaction(facts, ['payment']);
    return makeResult({
      ticket,
      facts,
      case_type: 'payment_failed',
      relevant_transaction_id: txn?.transaction_id || null,
      evidence_verdict: txn ? 'consistent' : 'insufficient_data',
      severity: txn ? 'high' : 'medium',
      department: 'payments_ops',
      human_review_required: false,
      confidence: txn ? 0.9 : 0.65,
      reason_codes: ['payment_failed', facts.hasDeductedSignal ? 'potential_balance_deduction' : null].filter(Boolean)
    });
  }

  if (facts.isWrongTransfer) {
    const matches = rankedTransactions(facts, ['transfer']).filter((item) => item.score >= 4);
    const top = matches[0];
    const second = matches[1];
    const ambiguous = top && second && top.score - second.score <= 1;
    const repeatedRecipient = top?.txn && countSameCounterpartyTransfers(facts.transactions, top.txn.counterparty) >= 3;
    const noMatch = !top;

    return makeResult({
      ticket,
      facts,
      case_type: 'wrong_transfer',
      relevant_transaction_id: ambiguous || noMatch ? null : top.txn.transaction_id,
      evidence_verdict: ambiguous || noMatch ? 'insufficient_data' : repeatedRecipient ? 'inconsistent' : 'consistent',
      severity: ambiguous ? 'medium' : repeatedRecipient ? 'medium' : top ? 'high' : 'medium',
      department: 'dispute_resolution',
      human_review_required: Boolean(!ambiguous && top),
      confidence: ambiguous ? 0.65 : repeatedRecipient ? 0.75 : top ? 0.9 : 0.6,
      reason_codes: ambiguous
        ? ['ambiguous_match', 'needs_clarification']
        : repeatedRecipient
          ? ['wrong_transfer_claim', 'established_recipient_pattern', 'evidence_inconsistent']
          : top
            ? ['wrong_transfer', 'transaction_match', 'dispute_review']
            : ['wrong_transfer_claim', 'needs_transaction_match']
    });
  }

  if (facts.isRefundRequest) {
    const txn = bestTransaction(facts, ['payment', 'refund', 'transfer']);
    return makeResult({
      ticket,
      facts,
      case_type: 'refund_request',
      relevant_transaction_id: txn?.transaction_id || null,
      evidence_verdict: txn ? 'consistent' : 'insufficient_data',
      severity: 'low',
      department: 'customer_support',
      human_review_required: false,
      confidence: txn ? 0.85 : 0.62,
      reason_codes: ['refund_request', 'merchant_policy_dependent']
    });
  }

  const vague = facts.amounts.length === 0 &&
    !facts.hasTxnIdMention &&
    facts.complaintWordCount < 10 &&
    !hasAny(facts.lower, ['transaction', 'cash out', 'cash-out', 'cashout', 'লেনদেন']);
  if (vague || facts.transactions.length !== 1) {
    return makeResult({
      ticket,
      facts,
      case_type: 'other',
      relevant_transaction_id: null,
      evidence_verdict: 'insufficient_data',
      severity: 'low',
      department: 'customer_support',
      human_review_required: false,
      confidence: 0.6,
      reason_codes: ['vague_complaint', 'needs_clarification']
    });
  }

  const onlyTxn = facts.transactions[0];
  return makeResult({
    ticket,
    facts,
    case_type: 'other',
    relevant_transaction_id: onlyTxn?.transaction_id || null,
    evidence_verdict: onlyTxn ? 'consistent' : 'insufficient_data',
    severity: 'low',
    department: 'customer_support',
    human_review_required: false,
    confidence: 0.55,
    reason_codes: ['general_support']
  });
}

export function buildFacts(ticket) {
  const complaint = normalizeText(ticket.complaint || '');
  const lower = complaint.toLowerCase();
  const transactions = Array.isArray(ticket.transaction_history) ? ticket.transaction_history.filter(isObject) : [];
  const language = inferLanguage(ticket.language, complaint);
  const amounts = extractAmounts(complaint);
  const phoneDigits = extractPhoneDigits(complaint);
  const txnIds = extractTxnIds(complaint);

  return {
    complaint,
    lower,
    language,
    transactions,
    amounts,
    phoneDigits,
    txnIds,
    complaintWordCount: complaint.trim().split(/\s+/).filter(Boolean).length,
    hasTxnIdMention: txnIds.length > 0,
    isPhishing: hasAny(lower, [
      'otp',
      'pin',
      'password',
      'passcode',
      'blocked if',
      'account will be blocked',
      'fake',
      'fraud',
      'scam',
      'suspicious',
      'ওটিপি',
      'পিন',
      'পাসওয়ার্ড',
      'পাসওয়ার্ড',
      'ব্লক'
    ]) && hasAny(lower, ['asked', 'share', 'call', 'sms', 'message', 'বলেছে', 'চেয়েছে', 'চেয়েছে', 'শেয়ার', 'শেয়ার']),
    isDuplicatePayment: hasAny(lower, ['twice', 'duplicate', 'double', 'deducted twice', 'charged twice', 'দুইবার', 'ডাবল']),
    isMerchantSettlement: ((ticket.user_type === 'merchant' || ticket.channel === 'merchant_portal') &&
      hasAny(lower, ['settlement', 'settled', 'sales', 'payout', 'batch', 'সেটেলমেন্ট'])) ||
      hasAny(lower, ['settlement delay', 'settlement not', 'not settled', 'সেটেলমেন্ট']),
    isAgentCashIn: hasAny(lower, ['agent', 'cash in', 'cash-in', 'cashin', 'এজেন্ট', 'ক্যাশ ইন']) &&
      hasAny(lower, ['balance', 'not reflected', "didn't get", 'not received', 'আসেনি', 'পাইনি', 'ব্যালেন্স']),
    isPaymentFailed: (hasAny(lower, ['failed', 'failure', 'app showed failed', 'payment failed', 'ফেইল', 'ব্যর্থ']) &&
      (hasAny(lower, ['payment', 'pay', 'recharge', 'bill', 'merchant', 'পেমেন্ট', 'রিচার্জ', 'বিল']) ||
        transactions.some((txn) => txn.type === 'payment'))) ||
      (hasAny(lower, ['deducted', 'deduct', 'কেটে', 'কাটা']) && hasAny(lower, ['payment', 'pay', 'recharge', 'bill', 'পেমেন্ট', 'রিচার্জ', 'বিল'])),
    isWrongTransfer: hasAny(lower, ['wrong number', 'wrong person', 'wrong recipient', 'by mistake', 'mistake', 'reverse it', "didn't get it", 'did not get it', 'did not get', 'not received', 'ভুল', 'পাঠিয়েছি', 'পাঠিয়েছি']) &&
      hasAny(lower, ['sent', 'transfer', 'number', 'recipient', 'brother', 'person', 'পাঠ', 'নাম্বার']),
    isRefundRequest: hasAny(lower, ['refund', 'return my money', 'money back', 'changed my mind', 'don\'t want', 'ফেরত', 'রিফান্ড']),
    hasDeductedSignal: hasAny(lower, ['deducted', 'balance was deducted', 'কেটে', 'কাটা'])
  };
}

function makeResult(values) {
  const result = { ...values };
  delete result.ticket;
  delete result.facts;
  return result;
}

function finalizeResponse(ticket, facts, result) {
  const safe = {
    ticket_id: String(ticket.ticket_id),
    relevant_transaction_id: typeof result.relevant_transaction_id === 'string' ? result.relevant_transaction_id : null,
    evidence_verdict: VERDICTS.has(result.evidence_verdict) ? result.evidence_verdict : 'insufficient_data',
    case_type: CASE_TYPES.has(result.case_type) ? result.case_type : 'other',
    severity: SEVERITIES.has(result.severity) ? result.severity : 'low',
    department: DEPARTMENTS.has(result.department) ? result.department : departmentFor(result.case_type),
    agent_summary: result.agent_summary || summaryFor(ticket, facts, result),
    recommended_next_action: result.recommended_next_action || nextActionFor(facts, result),
    customer_reply: result.customer_reply || replyFor(facts, result),
    human_review_required: Boolean(result.human_review_required),
    confidence: clampConfidence(result.confidence),
    reason_codes: Array.isArray(result.reason_codes) ? result.reason_codes.map(String).slice(0, 6) : []
  };

  safe.department = DEPARTMENTS.has(safe.department) ? safe.department : departmentFor(safe.case_type);
  safe.agent_summary = sanitizeText(safe.agent_summary, summaryFor(ticket, facts, safe), 'en');
  safe.recommended_next_action = sanitizeText(safe.recommended_next_action, nextActionFor(facts, safe), 'en');
  safe.customer_reply = sanitizeText(safe.customer_reply, replyFor(facts, safe), facts.language);
  return safe;
}

function mergeLlm(ruleResult, llmResult) {
  if (!llmResult || typeof llmResult !== 'object') {
    return ruleResult;
  }
  return {
    ...ruleResult,
    agent_summary: typeof llmResult.agent_summary === 'string' ? llmResult.agent_summary : ruleResult.agent_summary,
    recommended_next_action: typeof llmResult.recommended_next_action === 'string' ? llmResult.recommended_next_action : ruleResult.recommended_next_action,
    customer_reply: typeof llmResult.customer_reply === 'string' ? llmResult.customer_reply : ruleResult.customer_reply
  };
}

function shouldAskLlm(ruleResult, facts) {
  if (facts.language === 'bn' || facts.language === 'mixed') return true;
  if (ruleResult.confidence < 0.7) return true;
  return false;
}

function summaryFor(ticket, facts, result) {
  const txn = findTxnById(facts.transactions, result.relevant_transaction_id);
  const amount = txn ? `${txn.amount} BDT` : facts.amounts[0] ? `${facts.amounts[0]} BDT` : 'the reported amount';
  const txnText = txn ? ` (${txn.transaction_id})` : '';

  switch (result.case_type) {
    case 'phishing_or_social_engineering':
      return 'Customer reports a possible phishing or social engineering attempt involving sensitive credentials.';
    case 'duplicate_payment':
      return txn
        ? `Customer reports a possible duplicate payment for ${amount}${txnText}. Payments operations should verify the duplicate.`
        : 'Customer reports a possible duplicate payment, but the matching transaction is not clear from the provided history.';
    case 'merchant_settlement_delay':
      return txn
        ? `Merchant reports delayed settlement of ${amount}${txnText}; transaction status is ${txn.status}.`
        : 'Merchant reports a settlement delay, but no matching settlement transaction is available.';
    case 'agent_cash_in_issue':
      return txn
        ? `Customer reports cash-in of ${amount}${txnText} not reflected in balance; transaction status is ${txn.status}.`
        : 'Customer reports an agent cash-in issue, but no matching cash-in transaction is available.';
    case 'payment_failed':
      return txn
        ? `Customer reports a failed payment with possible balance deduction for ${amount}${txnText}.`
        : 'Customer reports a failed payment or deducted balance, but the matching transaction is unclear.';
    case 'wrong_transfer':
      if (result.evidence_verdict === 'inconsistent') {
        return `Customer claims a wrong transfer, but transaction history suggests an established recipient pattern.`;
      }
      return txn
        ? `Customer reports a wrong-transfer concern for ${amount}${txnText}.`
        : 'Customer reports a transfer issue, but multiple or no transactions match clearly.';
    case 'refund_request':
      return txn
        ? `Customer requests refund guidance for ${amount}${txnText}.`
        : 'Customer requests a refund, but no matching transaction is clear from the provided history.';
    default:
      return 'Customer provided a general or vague support complaint with insufficient detail to identify a specific transaction.';
  }
}

function nextActionFor(facts, result) {
  switch (result.case_type) {
    case 'phishing_or_social_engineering':
      return 'Escalate to fraud_risk. Remind the customer that official support never asks for PIN, OTP, password, or full card number.';
    case 'duplicate_payment':
      return result.relevant_transaction_id
        ? `Verify ${result.relevant_transaction_id} with payments_ops and the biller; process only eligible reversals through official workflow.`
        : 'Ask for the transaction ID or biller details before starting duplicate-payment verification.';
    case 'merchant_settlement_delay':
      return result.relevant_transaction_id
        ? `Route ${result.relevant_transaction_id} to merchant_operations to verify settlement batch status and communicate an ETA.`
        : 'Ask the merchant for settlement date, amount, and merchant ID, then route to merchant_operations.';
    case 'agent_cash_in_issue':
      return result.relevant_transaction_id
        ? `Investigate ${result.relevant_transaction_id} with agent_operations and confirm the cash-in settlement state.`
        : 'Ask for agent ID, amount, time, and transaction ID, then route to agent_operations if matched.';
    case 'payment_failed':
      return result.relevant_transaction_id
        ? `Investigate ${result.relevant_transaction_id} ledger status; any eligible amount should be handled through the standard reversal flow.`
        : 'Ask for transaction ID, amount, and time to locate the failed payment.';
    case 'wrong_transfer':
      if (result.evidence_verdict === 'insufficient_data') {
        return 'Ask for the recipient number or transaction ID before initiating any dispute.';
      }
      return `Verify ${result.relevant_transaction_id} details and handle through the wrong-transfer dispute workflow.`;
    case 'refund_request':
      return 'Explain that refund eligibility depends on merchant or policy review and avoid promising a refund.';
    default:
      return 'Ask the customer for transaction ID, amount, approximate time, and a short description of what went wrong.';
  }
}

function replyFor(facts, result) {
  const txn = result.relevant_transaction_id;
  if (facts.language === 'bn') {
    if (result.case_type === 'agent_cash_in_issue') {
      return `আপনার লেনদেন ${txn || ''} এর বিষয়ে আমরা অবগত হয়েছি। আমাদের এজেন্ট অপারেশন্স দল এটি যাচাই করবে এবং অফিসিয়াল চ্যানেলে আপনাকে জানাবে। অনুগ্রহ করে কারো সাথে আপনার পিন বা ওটিপি শেয়ার করবেন না।`.replace(/\s+এর/, ' এর');
    }
    if (result.case_type === 'phishing_or_social_engineering') {
      return 'সতর্ক থাকার জন্য ধন্যবাদ। আমরা কখনো আপনার পিন, ওটিপি বা পাসওয়ার্ড চাই না। এগুলো কারো সাথে শেয়ার করবেন না। আমাদের ফ্রড দল বিষয়টি পর্যালোচনা করবে।';
    }
    return genericSafeReply('bn');
  }

  switch (result.case_type) {
    case 'phishing_or_social_engineering':
      return 'Thank you for reaching out before sharing any information. We never ask for your PIN, OTP, or password under any circumstances. Please do not share these with anyone. Our fraud team will review this incident.';
    case 'duplicate_payment':
      return txn
        ? `We have noted the possible duplicate payment for transaction ${txn}. Our payments team will verify it, and any eligible amount will be returned through official channels. Please do not share your PIN or OTP with anyone.`
        : 'We have noted your possible duplicate payment concern. Please share the transaction ID or biller details so we can identify it. Please do not share your PIN or OTP with anyone.';
    case 'merchant_settlement_delay':
      return txn
        ? `We have noted your concern about settlement ${txn}. Our merchant operations team will check the batch status and update you through official channels.`
        : 'We have noted your settlement concern. Please share the settlement ID, amount, and date so our merchant operations team can check it.';
    case 'agent_cash_in_issue':
      return txn
        ? `We have noted your concern about cash-in transaction ${txn}. Our agent operations team will verify it and update you through official channels. Please do not share your PIN or OTP with anyone.`
        : 'We have noted your cash-in concern. Please share the transaction ID, agent ID, amount, and time so we can check it. Please do not share your PIN or OTP with anyone.';
    case 'payment_failed':
      return txn
        ? `We have noted that transaction ${txn} may have caused an unexpected balance deduction. Our payments team will review it, and any eligible amount will be returned through official channels. Please do not share your PIN or OTP with anyone.`
        : 'We have noted your failed payment concern. Please share the transaction ID, amount, and time so we can check it. Please do not share your PIN or OTP with anyone.';
    case 'wrong_transfer':
      if (result.evidence_verdict === 'insufficient_data') {
        return 'Thank you for reaching out. We need the recipient number or transaction ID to identify the right transfer. Please do not share your PIN or OTP with anyone.';
      }
      return `We have received your request regarding transaction ${txn}. Please do not share your PIN or OTP with anyone. Our dispute team will review the case and contact you through official support channels.`;
    case 'refund_request':
      return 'Thank you for reaching out. Refund eligibility depends on the merchant or applicable policy. Our team can guide you through the official process. Please do not share your PIN or OTP with anyone.';
    default:
      return 'Thank you for reaching out. To help you faster, please share the transaction ID, amount, approximate time, and what went wrong. Please do not share your PIN or OTP with anyone.';
  }
}

function departmentFor(caseType) {
  return {
    wrong_transfer: 'dispute_resolution',
    payment_failed: 'payments_ops',
    refund_request: 'customer_support',
    duplicate_payment: 'payments_ops',
    merchant_settlement_delay: 'merchant_operations',
    agent_cash_in_issue: 'agent_operations',
    phishing_or_social_engineering: 'fraud_risk',
    other: 'customer_support'
  }[caseType] || 'customer_support';
}

function rankedTransactions(facts, preferredTypes = []) {
  return facts.transactions
    .map((txn, index) => ({ txn, score: scoreTransaction(txn, facts, preferredTypes), index }))
    .sort((a, b) => b.score - a.score || newestTime(b.txn) - newestTime(a.txn) || a.index - b.index);
}

function bestTransaction(facts, preferredTypes = []) {
  const ranked = rankedTransactions(facts, preferredTypes);
  if (!ranked.length) return null;
  if (ranked[0].score < 2 && facts.amounts.length > 0) return null;
  return ranked[0].txn;
}

function scoreTransaction(txn, facts, preferredTypes = []) {
  let score = 0;
  if (preferredTypes.includes(txn.type)) score += 3;
  if (facts.amounts.some((amount) => nearlyEqual(amount, Number(txn.amount)))) score += 4;
  if (facts.txnIds.includes(String(txn.transaction_id).toLowerCase())) score += 8;
  if (txn.counterparty && facts.lower.includes(String(txn.counterparty).toLowerCase())) score += 5;
  const counterpartyDigits = digitsOnly(txn.counterparty);
  if (counterpartyDigits && facts.phoneDigits.some((digits) => digits.endsWith(counterpartyDigits.slice(-8)) || counterpartyDigits.endsWith(digits.slice(-8)))) score += 5;
  if (txn.status === 'failed' && facts.isPaymentFailed) score += 3;
  if (txn.status === 'pending' && (facts.isAgentCashIn || facts.isMerchantSettlement)) score += 3;
  return score;
}

function findDuplicatePayment(transactions, facts) {
  const payments = transactions
    .filter((txn) => txn.type === 'payment' && ['completed', 'pending'].includes(txn.status))
    .sort((a, b) => newestTime(a) - newestTime(b));

  for (let i = 0; i < payments.length; i += 1) {
    for (let j = i + 1; j < payments.length; j += 1) {
      const a = payments[i];
      const b = payments[j];
      const seconds = Math.abs(newestTime(b) - newestTime(a)) / 1000;
      if (
        nearlyEqual(Number(a.amount), Number(b.amount)) &&
        String(a.counterparty) === String(b.counterparty) &&
        seconds <= 600 &&
        (facts.amounts.length === 0 || facts.amounts.some((amount) => nearlyEqual(amount, Number(b.amount))))
      ) {
        return { original: a, duplicate: b };
      }
    }
  }
  return null;
}

function countSameCounterpartyTransfers(transactions, counterparty) {
  if (!counterparty) return 0;
  return transactions.filter((txn) => txn.type === 'transfer' && txn.counterparty === counterparty && txn.status === 'completed').length;
}

function findTxnById(transactions, id) {
  return transactions.find((txn) => txn.transaction_id === id);
}

function extractAmounts(text) {
  return [...text.matchAll(/(?:৳|tk|taka|bdt)?\s*(\d+(?:\.\d+)?)(?:\s*(?:tk|taka|bdt|টাকা))?/gi)]
    .map((match) => Number(match[1]))
    .filter((num) => Number.isFinite(num) && num > 0 && num < 100000000);
}

function extractPhoneDigits(text) {
  return [...text.matchAll(/(?:\+?88)?01\d{9}|\+8801\d{9}/g)].map((match) => digitsOnly(match[0]));
}

function extractTxnIds(text) {
  return [...text.matchAll(/\btxn[-_a-z0-9]*\b/gi)].map((match) => match[0].toLowerCase());
}

function normalizeText(text) {
  return String(text)
    .replace(/[০-৯]/g, (char) => BN_DIGITS.get(char) || char)
    .replace(/\s+/g, ' ')
    .trim();
}

function inferLanguage(language, complaint) {
  if (language === 'bn' || language === 'mixed' || language === 'en') return language;
  return /[\u0980-\u09FF]/.test(complaint) ? 'bn' : 'en';
}

function hasAny(text, values) {
  return values.some((value) => text.includes(value));
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function digitsOnly(value = '') {
  return String(value).replace(/\D/g, '');
}

function nearlyEqual(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.001;
}

function newestTime(txn) {
  const time = Date.parse(txn.timestamp || '');
  return Number.isFinite(time) ? time : 0;
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.max(0, Math.min(1, Number(number.toFixed(2))));
}
