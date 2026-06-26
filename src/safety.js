const CREDENTIAL_REQUEST_PATTERNS = [
  /\b(send|share|provide|give|tell|submit|enter|confirm|verify)\b.{0,50}\b(pin|otp|password|passcode|full card|card number|cvv)\b/i,
  /\b(pin|otp|password|passcode|full card|card number|cvv)\b.{0,50}\b(send|share|provide|give|tell|submit|enter|confirm|verify)\b/i,
  /ওটিপি.{0,30}(দিন|দেন|শেয়ার|শেয়ার|বলুন|পাঠান)/i,
  /পিন.{0,30}(দিন|দেন|শেয়ার|শেয়ার|বলুন|পাঠান)/i
];

const UNSAFE_PROMISE_PATTERNS = [
  /\b(we will|we'll|we have|your money will|amount will)\b.{0,40}\b(refund|reverse|reversed|recover|return|unblock)\b/i,
  /\b(refund|reversal|reversed|recovered|unblocked)\b.{0,30}\b(done|confirmed|completed|guaranteed|processed)\b/i,
  /ফেরত.{0,30}(দেওয়া হবে|দিয়ে দেব|দিয়ে দেব|নিশ্চিত)/i
];

const THIRD_PARTY_PATTERNS = [
  /\b(call|contact|message|whatsapp|telegram)\b.{0,40}\b(the caller|that number|third party|agent directly|recipient directly)\b/i
];

export function hasUnsafeCredentialRequest(text = '') {
  const normalized = stripSafeCredentialWarnings(text);
  return CREDENTIAL_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasUnsafeFinancialPromise(text = '') {
  return UNSAFE_PROMISE_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasUnsafeThirdPartyInstruction(text = '') {
  return THIRD_PARTY_PATTERNS.some((pattern) => pattern.test(text));
}

export function isUnsafeText(text = '') {
  return (
    hasUnsafeCredentialRequest(text) ||
    hasUnsafeFinancialPromise(text) ||
    hasUnsafeThirdPartyInstruction(text)
  );
}

export function sanitizeText(text = '', fallback, language = 'en') {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value || isUnsafeText(value)) {
    return fallback || genericSafeReply(language);
  }
  return value
    .replace(/\bwe will refund you\b/gi, 'any eligible amount will be returned through official channels')
    .replace(/\bwe will reverse\b/gi, 'our team will review')
    .replace(/\byour transaction has been reversed\b/gi, 'your transaction will be reviewed');
}

export function genericSafeReply(language = 'en') {
  if (language === 'bn') {
    return 'আপনার অভিযোগটি আমরা পেয়েছি। আমাদের দল বিষয়টি যাচাই করবে এবং অফিসিয়াল চ্যানেলে আপনাকে জানাবে। অনুগ্রহ করে কারো সাথে আপনার পিন বা ওটিপি শেয়ার করবেন না।';
  }
  return 'We have received your concern. Our team will review the case and contact you through official support channels. Please do not share your PIN or OTP with anyone.';
}

function stripSafeCredentialWarnings(text) {
  return String(text)
    .replace(/\bwe never ask for (your )?(pin|otp|password|passcode|full card number|card number|cvv)(\b|,|\s|or|and|under|\.|-)+/gi, '')
    .replace(/\b(please\s+)?do not share (your )?(pin|otp|password|passcode)(,?\s*(or|and)\s*(your )?(pin|otp|password|passcode))* with anyone\b/gi, '')
    .replace(/\bplease do not share these with anyone\b/gi, '')
    .replace(/\bnever share (your )?(pin|otp|password|passcode)(,?\s*(or|and)\s*(your )?(pin|otp|password|passcode))*\b/gi, '')
    .replace(/\bwe never ask for (your )?(pin|otp|password|passcode)(,?\s*(or|and)\s*(your )?(pin|otp|password|passcode))*\b/gi, '')
    .replace(/(পিন|ওটিপি|পাসওয়ার্ড|পাসওয়ার্ড).{0,20}(শেয়ার|শেয়ার) করবেন না/gi, '')
    .replace(/আমরা কখনো.{0,40}(পিন|ওটিপি|পাসওয়ার্ড|পাসওয়ার্ড).{0,20}চাই না/gi, '');
}
