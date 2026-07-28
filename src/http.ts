import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { SubaruClient } from './client.js';
import { loadConfig, loadDotenv } from './config.js';
import { COMMANDS, SubaruError, type CommandName, type CommandOptions } from './types.js';

loadDotenv();

const PORT = Number(process.env['PORT'] ?? 3000);
const API_TOKEN = process.env['API_TOKEN']?.trim();

if (!API_TOKEN || API_TOKEN.length < 16) {
  console.error(
    'Refusing to start: API_TOKEN must be set to at least 16 characters.\n' +
      'This endpoint can unlock and start your car — it must not be open.\n' +
      'Generate one with: openssl rand -hex 32',
  );
  process.exit(1);
}

const app = express();
app.use(express.json());

/** Constant-time compare so the token can't be recovered by timing the 401. */
function tokenMatches(provided: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(API_TOKEN!);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !tokenMatches(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/**
 * One client for the process, so the MySubaru session cookie is reused across
 * requests rather than re-authenticating on every call.
 */
const client = new SubaruClient(loadConfig());

/** Accept command options from either the JSON body or the query string. */
function readOptions(req: Request): CommandOptions {
  const source = { ...req.query, ...(req.body as Record<string, unknown> | undefined) };
  const bool = (v: unknown) => (v === undefined ? undefined : v !== false && v !== 'false' && v !== '0');
  const num = (v: unknown) => (v === undefined ? undefined : Number(v));

  return {
    noWait: bool(source['noWait']),
    horn: bool(source['horn']),
    delay: num(source['delay']),
    runTimeMinutes: num(source['minutes'] ?? source['runTimeMinutes']),
    frontTemp: num(source['temp'] ?? source['frontTemp']),
    airConditioning: bool(source['ac'] ?? source['airConditioning']),
    rearDefrost: bool(source['defrost'] ?? source['rearDefrost']),
    heatedSeatLeft: source['heatedSeats'] ? 'high' : undefined,
    heatedSeatRight: source['heatedSeats'] ? 'high' : undefined,
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

for (const name of Object.keys(COMMANDS) as CommandName[]) {
  // GET is allowed too: iOS Shortcuts and widgets are far easier to wire up
  // against a plain URL than a POST with a body.
  app.all(`/${name}`, authenticate, async (req: Request, res: Response) => {
    if (!['GET', 'POST'].includes(req.method)) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      res.json(await client.command(name, readOptions(req)));
    } catch (error) {
      const isSubaru = error instanceof SubaruError;
      res.status(isSubaru ? 502 : 500).json({
        error: error instanceof Error ? error.message : String(error),
        ...(isSubaru && error.code ? { code: error.code } : {}),
      });
    }
  });
}

app.get('/status/:serviceRequestId', authenticate, async (req: Request, res: Response) => {
  const raw = req.params['serviceRequestId'];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id) {
    res.status(400).json({ error: 'serviceRequestId is required' });
    return;
  }
  try {
    res.json(await client.status(id));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`subaru-remote listening on :${PORT}`);
  console.log(`  commands: ${Object.keys(COMMANDS).map((c) => `/${c}`).join(' ')}`);
});
