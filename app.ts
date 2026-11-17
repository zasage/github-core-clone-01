// The forge's HTTP surface: one Store, four protocols, one server.
// Routes (all state lives in the single Store created by createApp):
//   GET  /healthz               200 {"ok":true} (no auth; the env's boot probe)
//   /api/v3/*                   REST v3 (src/rest.ts; includes the API root)
//   POST /api/graphql           GraphQL v4 (src/graphql.ts)
//   POST /mcp                   MCP over Streamable HTTP (src/mcp.ts)
//   /:owner/:repo.git/*         git smart HTTP (src/git/smart-http.ts)
//   anything else               404 {"message":"Not Found"}
//
// Wiring notes (from the workers' reports + docs/CHECKS.md):
// - req.headers MUST be forwarded to handleGitSmartHttp: `Git-Protocol: version=2`
//   is the only signal that selects the v2 upload-pack advertisement.
// - GraphQL auth goes through ctx: presentedToken from the Authorization header,
//   expectedToken from MAKEFUN_SHOP_TOKEN. MCP reads Authorization itself.
// - A 204 from REST carries body null: send zero bytes for it.
// - DELETE /mcp: this server never issues an Mcp-Session-Id, so the client never
//   has a session to close; answer 405 rather than forwarding an empty body.
// - No wall clock, no randomness anywhere in this file: timestamps come from the
//   Store's deterministic clock.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleGitSmartHttp } from './src/git/smart-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const GIT_PATH = /^\/[^/]+\/[^/]+\.git(\/.*)?$/;

/** The bearer token this process expects, or '' when the env sets none. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** The bearer token a request presented, or null. */
function presentedToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return token === '' ? null : token;
}

/** Flatten node's headers to single-value strings. */
function flatHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** The URL pathname, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Query as a record; repeated keys become arrays. */
function queryOf(req: IncomingMessage): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  try {
    const params = new URL(req.url ?? '/', 'http://entry').searchParams;
    for (const key of new Set(params.keys())) {
      const values = params.getAll(key);
      out[key] = values.length === 1 ? values[0] : values;
    }
  } catch {
    // No usable query string.
  }
  return out;
}

/** Read the whole request body as a Buffer (empty when there is none). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (body === null || body === undefined) {
    res.writeHead(status, { ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-length': body.length, ...headers });
  res.end(body);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const token = expectedToken();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // GraphQL v4. Auth via ctx (presented vs expected token).
        if (method === 'POST' && (path === '/api/graphql' || path === '/api/graphql/')) {
          const bodyText = (await readBody(req)).toString('utf8');
          let bodyJson: unknown = bodyText;
          try {
            bodyJson = bodyText.trim() === '' ? null : JSON.parse(bodyText);
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Request body must be valid JSON.' }] });
            return;
          }
          const result = handleGraphQL(bodyJson, store, {
            presentedToken: presentedToken(req),
            expectedToken: token,
          });
          sendJson(res, result.status, result.body);
          return;
        }

        // MCP over Streamable HTTP.
        if (path === '/mcp' || path === '/mcp/') {
          if (method === 'DELETE') {
            // No session was ever issued, so there is nothing to close.
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const bodyText = (await readBody(req)).toString('utf8');
          const result = handleMcp(bodyText, flatHeaders(req), store, { token });
          const headers: Record<string, string> = { ...result.headers };
          if (!('content-type' in headers)) headers['content-type'] = JSON_TYPE;
          res.writeHead(result.status, { 'content-length': Buffer.byteLength(result.body), ...headers });
          res.end(result.body);
          return;
        }

        // Git smart HTTP. Headers are forwarded: Git-Protocol selects v2 vs v0.
        if (GIT_PATH.test(path)) {
          const body = await readBody(req);
          const query = new URL(req.url ?? '/', 'http://entry').searchParams;
          const result = handleGitSmartHttp(method, path, query, body, {
            repoExists: (owner: string, repo: string) => store.getRepo(owner, repo) !== undefined,
            getRefs: (repoKey: string) => store.refs.get(repoKey) ?? new Map<string, string>(),
            getObjects: () => store.objects,
            setRef: (repoKey: string, ref: string, oid: string) => {
              const refs = store.refs.get(repoKey);
              if (refs === undefined) return;
              if (oid === '0000000000000000000000000000000000000000') refs.delete(ref);
              else refs.set(ref, oid);
            },
            clockNow: () => store.clock.now(),
          }, flatHeaders(req));
          sendBuffer(res, result.status, result.body, result.headers);
          return;
        }

        // REST v3 (the handler owns the /api/v3 prefix check and every route under it).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const bodyText = (await readBody(req)).toString('utf8');
          const result = handleRest(method, path, queryOf(req), flatHeaders(req), bodyText, store, { token });
          sendJson(res, result.status, result.body, result.headers);
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler must never take the server down: answer 500 JSON and stay up.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try {
            res.destroy();
          } catch {
            // Nothing left to do for this socket.
          }
        }
      }
    })();
  });
}
