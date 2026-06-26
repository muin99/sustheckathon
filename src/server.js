import http from 'node:http';
import { analyzeTicket } from './analyzer.js';

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 400 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function validateTicket(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { statusCode: 400, message: 'Request body must be a JSON object.' };
  }
  if (typeof input.ticket_id !== 'string' || input.ticket_id.trim() === '') {
    return { statusCode: 400, message: 'Missing required field: ticket_id.' };
  }
  if (typeof input.complaint !== 'string') {
    return { statusCode: 400, message: 'Missing required field: complaint.' };
  }
  if (input.complaint.trim() === '') {
    return { statusCode: 422, message: 'Complaint must not be empty.' };
  }
  if (input.transaction_history !== undefined && !Array.isArray(input.transaction_history)) {
    return { statusCode: 400, message: 'transaction_history must be an array when provided.' };
  }
  return null;
}

async function handleAnalyzeTicket(req, res) {
  let parsed;
  try {
    const body = await readBody(req);
    parsed = JSON.parse(body || '{}');
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: 'Malformed JSON request body.' });
    return;
  }

  const validationError = validateTicket(parsed);
  if (validationError) {
    sendJson(res, validationError.statusCode, { error: validationError.message });
    return;
  }

  try {
    const analysis = await analyzeTicket(parsed);
    sendJson(res, 200, analysis);
  } catch {
    sendJson(res, 500, { error: 'Internal analysis error.' });
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/analyze-ticket') {
      await handleAnalyzeTicket(req, res);
      return;
    }

    sendJson(res, 404, { error: 'Not found.' });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(PORT, HOST, () => {
    console.log(`QueueStorm Investigator listening on http://${HOST}:${PORT}`);
  });
}
