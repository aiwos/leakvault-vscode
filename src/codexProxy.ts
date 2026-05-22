import * as http from 'http';
import * as https from 'https';
import { scan } from './credentialScanner';

export type DetectionCallback = (count: number, handles: string[]) => void;

// ---------------------------------------------------------------------------
// Recursively walk a parsed JSON value and redact every string leaf.
// Returns the redacted clone and the union of all handles found.
// ---------------------------------------------------------------------------
function scanDeep(value: unknown, allHandles: string[]): unknown {
  if (typeof value === 'string') {
    const r = scan(value);
    for (const h of r.handles) {
      if (!allHandles.includes(h)) allHandles.push(h);
    }
    return r.redacted;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scanDeep(v, allHandles));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scanDeep(v, allHandles);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// CodexProxy — local HTTP server that sits between the Codex binary and
// api.openai.com.  openai_base_url in ~/.codex/config.toml is pointed at
// http://127.0.0.1:<port> so every API request flows through here before
// reaching OpenAI's servers.
// ---------------------------------------------------------------------------
export class CodexProxy {
  private server: http.Server | undefined;
  private _port = 0;
  private readonly onDetect: DetectionCallback;

  constructor(onDetect: DetectionCallback) {
    this.onDetect = onDetect;
  }

  get port(): number {
    return this._port;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({ error: 'leakvault-proxy error', detail: String(err) }));
        });
      });
      this.server.listen(0, '0.0.0.0', () => {
        const addr = this.server!.address() as { port: number };
        this._port = addr.port;
        resolve(this._port);
      });
      this.server.on('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Buffer the full request body before inspecting.
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks);

    let bodyToForward = rawBody;
    const contentType = req.headers['content-type'] ?? '';

    if (contentType.includes('application/json') && rawBody.length > 0) {
      try {
        const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
        const handles: string[] = [];
        const redacted = scanDeep(parsed, handles);
        if (handles.length > 0) {
          this.onDetect(handles.length, handles);
          bodyToForward = Buffer.from(JSON.stringify(redacted), 'utf8');
        }
      } catch {
        // Not valid JSON — forward as-is.
      }
    }

    // Route to the correct upstream based on path prefix.
    // ChatGPT-auth Codex uses /backend-api/... → chatgpt.com
    // API-key Codex uses /v1/... → api.openai.com
    const reqPath = req.url ?? '/';
    const isChatGPT = reqPath.startsWith('/backend-api/');
    const upstream = isChatGPT ? 'chatgpt.com' : 'api.openai.com';

    // Build forwarding headers: replace Host, recalculate Content-Length.
    const forwardHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (lower === 'host' || lower === 'content-length') continue;
      if (v !== undefined) forwardHeaders[k] = v as string | string[];
    }
    forwardHeaders['host'] = upstream;
    forwardHeaders['content-length'] = String(bodyToForward.length);

    await new Promise<void>((resolve, reject) => {
      const proxyReq = https.request(
        {
          hostname: upstream,
          port: 443,
          path: reqPath,
          method: req.method,
          headers: forwardHeaders,
        },
        (proxyRes) => {
          res.writeHead(
            proxyRes.statusCode ?? 200,
            proxyRes.headers as http.OutgoingHttpHeaders,
          );
          proxyRes.pipe(res, { end: true });
          proxyRes.on('end', resolve);
          proxyRes.on('error', reject);
        },
      );
      proxyReq.on('error', reject);
      proxyReq.write(bodyToForward);
      proxyReq.end();
    });
  }
}
