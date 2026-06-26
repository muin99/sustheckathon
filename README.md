# QueueStorm Investigator

QueueStorm Investigator is a Node.js API service for the SUST CSE Carnival 2026 Codex Community Hackathon preliminary round. It receives a support complaint with recent transaction history and returns a structured investigation result for support agents.

The service is API-first, evidence-based, and safety-focused. It uses deterministic rules for transaction matching, classification, routing, and fintech safety. OpenRouter is used only as an optional wording assistant; the judged decision fields are protected by local validation and fallback logic.

## Tech Stack

- Node.js 20+
- Built-in `http` server
- Built-in `node:test`
- Optional OpenRouter chat-completions call
- No runtime npm dependencies

## Endpoints

### `GET /health`

Readiness check.

```json
{ "status": "ok" }
```

### `POST /analyze-ticket`

Accepts one ticket and returns one structured analysis.

Required input fields:

- `ticket_id`
- `complaint`

Optional input fields:

- `language`
- `channel`
- `user_type`
- `campaign_context`
- `transaction_history`
- `metadata`

Successful responses include:

- `ticket_id`
- `relevant_transaction_id`
- `evidence_verdict`
- `case_type`
- `severity`
- `department`
- `agent_summary`
- `recommended_next_action`
- `customer_reply`
- `human_review_required`
- `confidence`
- `reason_codes`

Sample request:

```json
{
  "ticket_id": "TKT-001",
  "complaint": "I sent 5000 taka to a wrong number around 2pm today.",
  "language": "en",
  "channel": "in_app_chat",
  "user_type": "customer",
  "transaction_history": [
    {
      "transaction_id": "TXN-9101",
      "timestamp": "2026-04-14T14:08:22Z",
      "type": "transfer",
      "amount": 5000,
      "counterparty": "+8801719876543",
      "status": "completed"
    }
  ]
}
```

Sample response:

```json
{
  "ticket_id": "TKT-001",
  "relevant_transaction_id": "TXN-9101",
  "evidence_verdict": "consistent",
  "case_type": "wrong_transfer",
  "severity": "high",
  "department": "dispute_resolution",
  "agent_summary": "Customer reports a wrong-transfer concern for 5000 BDT (TXN-9101).",
  "recommended_next_action": "Verify TXN-9101 details and handle through the wrong-transfer dispute workflow.",
  "customer_reply": "We have received your request regarding transaction TXN-9101. Please do not share your PIN or OTP with anyone. Our dispute team will review the case and contact you through official support channels.",
  "human_review_required": true,
  "confidence": 0.9,
  "reason_codes": ["wrong_transfer", "transaction_match", "dispute_review"]
}
```

## Models

- Provider: OpenRouter
- API style: OpenAI-compatible `/chat/completions`
- Default model: `openai/gpt-4o-mini`
- Purpose: optional improvement of `agent_summary`, `recommended_next_action`, and `customer_reply`
- Fallback: deterministic rules return a valid response if OpenRouter is unavailable, slow, or returns invalid JSON

OpenRouter output is never allowed to override transaction IDs, enum decisions, evidence verdict, department, severity, or safety rules.

## Evidence Reasoning

The analyzer uses local rules for:

- transaction ID, amount, type, status, counterparty, and recency matching
- duplicate payment detection
- wrong-transfer ambiguity detection
- established-recipient inconsistency detection
- merchant settlement routing
- agent cash-in issue routing
- phishing and social-engineering detection
- Bangla digit normalization

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

The service prevents unsafe customer-facing output:

- no request for PIN, OTP, password, full card number, or credentials
- no unauthorized refund, reversal, account unblock, or recovery promise
- no instruction to contact suspicious third parties
- prompt-injection text inside complaints is ignored
- malformed input returns controlled JSON errors

Safe customer replies use official-channel language and avoid financial guarantees.

## Environment Variables

Copy `.env.example` and set real values only in your runtime environment.

```bash
OPENROUTER_API_KEY=your_openrouter_api_key_here
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_HTTP_REFERER=https://your-domain.example
OPENROUTER_APP_TITLE=QueueStorm-Investigator
LLM_TIMEOUT_MS=10000
```

For local or VM deployment, `PORT=8000` may also be set. On cPanel, leave `PORT` unset unless the hosting panel asks for it.

## Local Runbook

```bash
npm install
npm test
npm start
```

Health check:

```bash
curl http://localhost:8000/health
```

Sample request:

```bash
curl -X POST http://localhost:8000/analyze-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticket_id":"LOCAL-TEST","complaint":"Someone called and asked for my OTP.","transaction_history":[]}'
```
### Public API

- Base URL: https://sust1.onukrom.xyz/
- Health Check: https://sust1.onukrom.xyz/health
- Ticket Analyzer: https://sust1.onukrom.xyz/analyze-ticket
- 
## Tests

```bash
npm test
```

The test suite covers:

- all public sample cases
- exact required output fields and enum values
- malformed JSON and empty complaints
- missing transaction history
- prompt-injection attempts
- OTP/PIN phishing reports
- ambiguous transaction matches
- Bangla/Banglish cases
- deterministic fallback behavior

If the service is already running, endpoint smoke tests can be run with:

```bash
npm run test:api
```

## Deployment

The submitted base URL must expose:

```text
GET  /health
POST /analyze-ticket
```

### cPanel / PNR Hosting

Use these Node.js app settings:

```text
Application root: queuestorm-investigator
Application startup file: app.js
Application mode: Production
Application URL: your chosen domain or subdomain
```

Set the OpenRouter environment variables in the cPanel Node.js application settings. Do not commit `.env`.

After creating the app:

1. Run NPM install from cPanel.
2. Restart the Node.js application.
3. Test `https://your-domain/health`.
4. Test `https://your-domain/analyze-ticket`.

### Docker Fallback

```bash
docker build -t queuestorm-investigator .
docker run -p 8000:8000 --env-file .env queuestorm-investigator
```

### Code Fallback

```bash
npm install
npm test
npm start
```

## Required Deliverables

Included in this repository:

- `README.md`
- `package.json`
- `app.js`
- `src/`
- `test/`
- `.env.example`
- `Dockerfile`
- `sample_output.json`
- `instructions/SUST_Preli_Sample_Cases.json`

## Limitations

- This service does not integrate with real payment, ledger, dispute, merchant, or fraud systems.
- It uses synthetic input data only.
- Unusual or underspecified complaints may return `other` or `insufficient_data` rather than guessing.
- OpenRouter quota, availability, and cost are the responsibility of the deploying team.

## Data And Secrets

No real customer data is required. Do not commit `.env`, API keys, tokens, or production secrets.
