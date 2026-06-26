import { createServer } from './src/server.js';

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

createServer().listen(PORT, HOST, () => {
  console.log(`QueueStorm Investigator listening on http://${HOST}:${PORT}`);
});
