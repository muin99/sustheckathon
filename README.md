# QueueStorm Investigator

Zero-dependency Node.js API for the SUST CSE Carnival 2026 Codex Community Hackathon preliminary round.

The service receives one digital finance support ticket, investigates the complaint against recent transaction history, and returns a structured JSON decision for support agents.

## Tech Stack

- Node.js 20+
- Built-in `http` server
- Built-in `node:test`
- Optional OpenAI-style Agent Router LLM integration
- No npm runtime dependencies

## Run Locally

```bash
npm start
```

The default port is `8000`.

```bash
curl http://localhost:8000/health
```

Expected response:

```json
{ "status": "ok" }
```

## API

### `GET /health`

Returns service readiness:

```json
{ "status": "ok" }
```

### `POST /analyze-ticket`

Accepts the hackathon ticket schema:

```json
{
  "ticket_id": "TKT-001",
  "complaint": "I sent 5000 taka to a wrong number around 2pm today.",
  "language": "en",
  "channel": "in_app_chat",
  "user_type": "customer",
  "transaction_history": []
}
```

Returns:

```json
{
  "ticket_id": "TKT-001",
  "relevant_transaction_id": null,
  "evidence_verdict": "insufficient_data",
  "case_type": "wrong_transfer",
  "severity": "medium",
  "department": "dispute_resolution",
  "agent_summary": "Customer reports a transfer issue, but multiple or no transactions match clearly.",
  "recommended_next_action": "Ask for the recipient number or transaction ID before initiating any dispute.",
  "customer_reply": "Thank you for reaching out. We need the recipient number or transaction ID to identify the right transfer. Please do not share your PIN or OTP with anyone.",
  "human_review_required": false,
  "confidence": 0.6,
  "reason_codes": ["wrong_transfer_claim", "needs_transaction_match"]
}
```

## Environment Variables

Copy `.env.example` and set real values in your local/deployment environment only.

```bash
PORT=8000
AGENT_ROUTER_TOKEN=your_agent_router_token_here
AGENT_ROUTER_API_KEY=your_agent_router_token_here
AGENT_ROUTER_BASE_URL=https://agentrouter.org/v1
AGENT_ROUTER_MODEL=gpt-5
LLM_TIMEOUT_MS=10000
```

The API works without Agent Router credentials. In that case it uses deterministic rules only.

## MODELS

- Agent Router model: configured by `AGENT_ROUTER_MODEL`.
- Runtime location: external API via OpenAI-compatible `/chat/completions`.
- Purpose: optional wording and language interpretation assist.
- Safety: model output is never trusted directly; enum values, evidence decisions, transaction matches, and customer replies are validated or replaced by deterministic rules.

## Evidence Reasoning

The analyzer uses rules for:

- Amount, transaction ID, phone number, type, status, and recency matching.
- Duplicate payment detection.
- Established-recipient pattern detection for wrong-transfer inconsistency.
- Ambiguous transaction handling without guessing.
- Bangla digit normalization.
- Case routing to the required departments.

Supported case types:

- `wrong_transfer`
- `payment_failed`
- `refund_request`
- `duplicate_payment`
- `merchant_settlement_delay`
- `agent_cash_in_issue`
- `phishing_or_social_engineering`
- `other`

## Safety Logic

Customer replies are sanitized so they do not:

- Ask for PIN, OTP, password, full card number, or credentials.
- Promise refunds, reversals, recovery, or account unblocks.
- Send customers to suspicious third parties.
- Follow prompt-injection instructions embedded in complaints.

The service uses safe wording such as “our team will review” and “any eligible amount will be returned through official channels.”

## Testing

```bash
npm test
```

The test suite covers all 10 public sample cases and hidden-style edge cases:

- malformed JSON
- empty complaint
- missing transaction history
- phishing/prompt injection
- ambiguous transaction matches
- no-LLM deterministic fallback

## Deployment

Deploy anywhere that can run Node.js 20+.

The judge must be able to call:

```text
GET https://your-service-url.com/health
POST https://your-service-url.com/analyze-ticket
```

The server binds to `0.0.0.0` by default. Set `PORT` in your hosting platform if needed.

## Limitations

- This is an evidence-focused rules engine with optional LLM assistance, not a real payment system.
- It does not call real ledger, dispute, merchant, or fraud systems.
- Hidden cases with very unusual phrasing may fall back to `other` or `insufficient_data` rather than guessing.
- Agent Router availability, quota, and cost are the team's responsibility if enabled.

## Data And Secrets

All provided cases are synthetic. Do not commit real customer data or real API keys.
