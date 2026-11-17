// Git smart-HTTP routing: GET /:owner/:repo.git/info/refs and POST
// /:owner/:repo.git/git-upload-pack | git-receive-pack. Pure Node 22 stdlib.
// No wall clock, no randomness: timestamps never enter a response here (commit bytes
// arrive from the client); ctx.clockNow() is accepted for callers that need it and is
// otherwise unused by this layer.
//
// Protocol version for GET /info/refs comes from the Git-Protocol request header, which
// the caller passes as `headers` (the coordinator's app.ts MUST forward req.headers:
// the suite's normal client sends `Git-Protocol: version=2` for upload-pack, its v0
// client sends no header at all, and the two are indistinguishable without it).
// POST /git-upload-pack dispatches on the body itself (a leading `command=` line is v2,
// `want ` is v0), so it needs no header. A missing repository is 404 JSON on both
// services, and the server keeps serving afterwards.

import { ObjectStore } from './objects.ts';
import { encodePktLine, pktLineFlush } from './protocol.ts';
import { buildReceivePackAdvertisementV0, handleReceivePack } from './receive-pack.ts';
import {
  buildUploadPackAdvertisementV0,
  buildUploadPackAdvertisementV2,
  handleUploadPack,
} from './upload-pack.ts';

export interface GitSmartHttpContext {
  readonly repoExists: (owner: string, repo: string) => boolean;
  /** Live ref map for `${owner}/${repo}` (ref name -> tip oid). */
  readonly getRefs: (repoKey: string) => Map<string, string>;
  /** The shared content-addressed object store. */
  readonly getObjects: () => ObjectStore;
  /** Move a ref; a ZERO_OID value deletes it. */
  readonly setRef: (repoKey: string, ref: string, oid: string) => void;
  /** Deterministic clock (unused by this layer; part of the shared context contract). */
  readonly clockNow: () => string;
}

export interface GitSmartHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

export type GitSmartHttpQuery = URLSearchParams | Record<string, string | string[] | undefined> | string;

const JSON_TYPE = 'application/json; charset=utf-8';

function json(status: number, body: unknown): GitSmartHttpResponse {
  const text = `${JSON.stringify(body)}\n`;
  return { status, headers: { 'content-type': JSON_TYPE }, body: Buffer.from(text, 'utf8') };
}

function notFound(): GitSmartHttpResponse {
  return json(404, { message: 'Not Found' });
}

function queryValue(query: GitSmartHttpQuery, name: string): string | undefined {
  if (typeof query === 'string') {
    return new URLSearchParams(query).get(name) ?? undefined;
  }
  if (query instanceof URLSearchParams) {
    return query.get(name) ?? undefined;
  }
  const value = query[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

interface GitRoute {
  readonly owner: string;
  readonly repo: string;
  readonly rest: string;
}

function parseGitPath(path: string): GitRoute | undefined {
  const match = GIT_PATH.exec(path);
  if (!match) return undefined;
  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(match[1]);
    repo = decodeURIComponent(match[2]);
  } catch {
    return undefined;
  }
  return { owner, repo, rest: match[3] ?? '' };
}

/** `# service=<service>` preamble pkt-line, followed by a flush, as smart HTTP requires. */
function servicePreamble(service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  return Buffer.concat([encodePktLine(`# service=${service}\n`), pktLineFlush()]);
}

function headerValue(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Handle one git smart-HTTP request. `query` carries the URL query (for `service=`),
 * `body` the raw request bytes (empty for GET). `headers` carries the request headers
 * and is REQUIRED for a correct upload-pack advertisement: `Git-Protocol: version=2`
 * selects v2, anything else (including no header) selects v0.
 */
export function handleGitSmartHttp(
  method: string,
  path: string,
  query: GitSmartHttpQuery,
  body: Buffer,
  ctx: GitSmartHttpContext,
  headers?: Readonly<Record<string, string>>,
): GitSmartHttpResponse {
  try {
    const route = parseGitPath(path);
    if (!route) return notFound();
    const { owner, repo, rest } = route;
    const repoKey = `${owner}/${repo}`;

    if (method === 'GET' && rest === '/info/refs') {
      const service = queryValue(query, 'service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
      if (!ctx.repoExists(owner, repo)) return notFound();
      const refs = ctx.getRefs(repoKey);
      const objects = ctx.getObjects();
      if (service === 'git-receive-pack') {
        return {
          status: 200,
          headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
          body: Buffer.concat([
            servicePreamble('git-receive-pack'),
            buildReceivePackAdvertisementV0({ refs }),
          ]),
        };
      }
      const protocol = headerValue(headers, 'git-protocol');
      const wantV2 = protocol !== undefined && /version=2/.test(protocol);
      const advertisement = wantV2
        ? buildUploadPackAdvertisementV2()
        : buildUploadPackAdvertisementV0({ refs, objects });
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
        body: Buffer.concat([servicePreamble('git-upload-pack'), advertisement]),
      };
    }

    if (method === 'POST' && rest === '/git-upload-pack') {
      if (!ctx.repoExists(owner, repo)) return notFound();
      const refs = ctx.getRefs(repoKey);
      const objects = ctx.getObjects();
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body: handleUploadPack(body, { refs, objects }),
      };
    }

    if (method === 'POST' && rest === '/git-receive-pack') {
      if (!ctx.repoExists(owner, repo)) return notFound();
      const refs = ctx.getRefs(repoKey);
      const objects = ctx.getObjects();
      const setRef = (ref: string, oid: string): void => ctx.setRef(repoKey, ref, oid);
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
        body: handleReceivePack(body, { refs, objects, setRef }),
      };
    }

    return notFound();
  } catch (err) {
    // A malformed pkt-line or pack must never take the server down: answer 400 and stay up.
    return json(400, { message: (err as Error).message });
  }
}
