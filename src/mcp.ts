// src/mcp.ts — Model Context Protocol endpoint (POST /mcp) for the github-core-clone-01 forge.
//
// Handler: handleMcp(bodyText, headers, store, ctx) -> { status, headers, body }.
//   bodyText: the raw request body as text (a JSON-RPC 2.0 object, or an array of them).
//   headers:  the request headers (a Headers instance, a plain record, or node's
//             IncomingHttpHeaders); only Authorization is read.
//   store:    the shared Store (same store the REST and GraphQL surfaces use); all tool
//             mutations go through the operations exported by './graphql.ts', so an object
//             created over MCP is the same record REST reads back, with the same id.
//   ctx:      { token } — the expected bearer token (or the env's MAKEFUN_SHOP_TOKEN when
//             ctx.token is absent). A request without the right bearer is exactly 401.
//   Returns body as a JSON string; app.ts should send it verbatim with the returned headers.
//
// Protocol (per program/env/src/mcp-client.ts + checks-mcp.ts, and docs/CHECKS.md §6):
//   - Modern revision 2026-07-28: no handshake; every request declares it in _meta and in the
//     MCP-Protocol-Version header. `server/discover` answers a DiscoverResult whose
//     supportedVersions is a non-empty list of YYYY-MM-DD revisions.
//   - Legacy handshake (2025-11-25 first, then 2025-06-18, 2025-03-26, 2024-11-05): the
//     client sends `initialize` with params {protocolVersion, capabilities:{}, clientInfo}
//     and id "initialize-1" WITHOUT the MCP-Protocol-Version header; the server echoes the
//     revision it chose. Then `notifications/initialized` (no id) and the session proceeds.
//     No Mcp-Session-Id is issued (it is optional), so there is no session to DELETE.
//   - `tools/list` offers the six required tools (static list, byte-identical every call).
//   - `tools/call` matches a tool name as a SUFFIX, case-insensitive (a "github__" prefix is
//     allowed), and maps the documented github-mcp-server arguments onto the schema.
//   - Unknown tool -> JSON-RPC -32602 (never HTTP 500); missing required argument ->
//     isError:true; a body that is not JSON -> HTTP 400 with -32700; no Authorization -> 401.
//   - Every request is answered synchronously in well under 3 seconds; JSON-RPC ids are
//     echoed exactly, so concurrent calls keep their own ids and arguments.
//   - Answers are application/json (no SSE).

import type { Store } from './store.ts';
import {
  createRepoRecord,
  storeCreateComment,
  storeCreateIssue,
  storeCreatePull,
  storeFindRepo,
  storeIssueObject,
  storeListIssues,
  storeListPulls,
  storeMergePull,
  storePullObject,
  storeRepoObject,
  storeViewerLogin,
} from './graphql.ts';

/** The bearer context the handler accepts. */
export interface McpContext {
  /** The expected bearer token (falls back to process.env.MAKEFUN_SHOP_TOKEN). */
  token?: string | null;
}

export interface McpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// -----------------------------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

/** Revisions this server speaks, newest first. The client negotiates to one of these. */
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const LEGACY_REVISIONS: readonly string[] = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

// -----------------------------------------------------------------------------------------------
// The tool list (static: two tools/list calls answer byte-identical JSON)
// -----------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login of the new repository (defaults to the authenticated user).' }),
        name: Object.freeze({ type: 'string', description: 'Name of the repository to create.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full name "owner/repo" (alternative to owner + repo).' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full name "owner/repo" (alternative to owner + repo).' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full name "owner/repo" (alternative to owner + repo).' }),
        title: Object.freeze({ type: 'string', description: 'Title of the issue.' }),
        body: Object.freeze({ type: 'string', description: 'Body of the issue.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full name "owner/repo" (alternative to owner + repo).' }),
        state: Object.freeze({ type: 'string', description: 'Issue state filter: open, closed, or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full name "owner/repo" (alternative to owner + repo).' }),
        title: Object.freeze({ type: 'string', description: 'Title of the pull request.' }),
        body: Object.freeze({ type: 'string', description: 'Body of the pull request.' }),
        head: Object.freeze({ type: 'string', description: 'Head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'Base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        full_name: Object.freeze({ type: 'string', description: 'Full name "owner/repo" (alternative to owner + repo).' }),
        pull_number: Object.freeze({ type: 'integer', description: 'Number of the pull request to merge.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

/** Canonical tool names plus the aliases the suite accepts, by canonical name. */
const TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  create_repo: Object.freeze(['create_repository', 'repo_create', 'repos_create', 'repository_create']),
  get_repo: Object.freeze(['get_repository', 'repo_get', 'repos_get', 'repository_get']),
  create_issue: Object.freeze(['issue_create', 'issues_create']),
  list_issues: Object.freeze(['issues_list', 'issue_list']),
  create_pull_request: Object.freeze(['pull_request_create', 'pulls_create', 'create_pr', 'pr_create']),
  merge_pull_request: Object.freeze(['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge']),
});

// -----------------------------------------------------------------------------------------------
// Small utilities
// -----------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

/** Normalize a tool name for matching: lowercase, every non-alphanumeric removed. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The canonical tool a requested name serves (suffix, case-insensitive), or null. */
function findTool(requested: string): ToolDef | null {
  const wanted = normalizeName(requested);
  if (wanted === '') return null;
  for (const tool of TOOLS) {
    const candidates = [tool.name, ...(TOOL_ALIASES[tool.name] ?? [])].map(normalizeName);
    for (const candidate of candidates) {
      if (wanted === candidate) return tool;
      if (wanted.length > candidate.length && wanted.endsWith(candidate)) return tool;
    }
  }
  return null;
}

/** Read one request header from a Headers instance, a plain record, or node headers. */
function getHeader(headers: unknown, name: string): string | null {
  if (headers === null || headers === undefined) return null;
  const wanted = name.toLowerCase();
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (name: string) => string | null }).get(name);
    return typeof value === 'string' ? value : null;
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === wanted) {
        if (typeof value === 'string') return value;
        if (Array.isArray(value) && typeof value[0] === 'string') return value[0] as string;
        return null;
      }
    }
  }
  return null;
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): McpResult {
  return {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/** A tool result: text content plus the same payload as structured content. */
function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// -----------------------------------------------------------------------------------------------
// Argument mapping (defensive: the suite maps onto the schema's property names, so the
// canonical names below are what normally arrive; the synonyms cover direct callers)
// -----------------------------------------------------------------------------------------------

function pickString(args: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = str(args[key]);
    if (value !== '') return value;
  }
  return '';
}

/** Resolve { owner, repo } from the arguments (owner/repo, their synonyms, or full_name). */
function resolveOwnerRepo(args: Record<string, unknown>, viewerLogin: string): { owner: string; repo: string } {
  let owner = pickString(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']);
  let repo = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0] as string;
      if (repo === '') repo = parts[1] as string;
    }
  }
  if (owner === '') owner = viewerLogin;
  return { owner, repo };
}

// -----------------------------------------------------------------------------------------------
// Tool implementations (all act on the shared store via './graphql.ts')
// -----------------------------------------------------------------------------------------------

interface ToolOutcome {
  /** A tool result object (to be wrapped as the tools/call result), or an RPC error code. */
  result?: Record<string, unknown>;
  rpcErrorCode?: number;
  rpcErrorMessage?: string;
}

function callCreateRepo(store: Store, args: Record<string, unknown>): ToolOutcome {
  const viewerLogin = storeViewerLogin(store);
  const { owner } = resolveOwnerRepo(args, viewerLogin);
  const name = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
  if (name === '') return { result: toolError('Missing required argument: name') };
  const description = pickString(args, ['description', 'about', 'summary', 'body']);
  const isPrivate = args.private === true || args.is_private === true;
  const rec = createRepoRecord(store, owner, name, description, isPrivate);
  const out = storeRepoObject(store, rec);
  out.owner = { login: str(rec.owner), id: 1000 };
  return { result: toolResult(out) };
}

function callGetRepo(store: Store, args: Record<string, unknown>): ToolOutcome {
  const viewerLogin = storeViewerLogin(store);
  const { owner, repo } = resolveOwnerRepo(args, viewerLogin);
  if (repo === '') return { result: toolError('Missing required argument: repo') };
  const rec = storeFindRepo(store, owner, repo);
  if (rec === null) return { result: toolError(`Repository not found: ${owner}/${repo}`) };
  const out = storeRepoObject(store, rec);
  out.owner = { login: str(rec.owner), id: 1000 };
  return { result: toolResult(out) };
}

function callCreateIssue(store: Store, args: Record<string, unknown>): ToolOutcome {
  const viewerLogin = storeViewerLogin(store);
  const { owner, repo } = resolveOwnerRepo(args, viewerLogin);
  const title = pickString(args, ['title', 'issue_title', 'subject']);
  const missing: string[] = [];
  if (owner === '' && repo === '') missing.push('owner, repo');
  if (repo === '') missing.push('repo');
  if (title === '') missing.push('title');
  if (missing.length > 0) return { result: toolError(`Missing required argument(s): ${missing.join(', ')}`) };
  const fullName = `${owner}/${repo}`;
  if (storeFindRepo(store, owner, repo) === null) {
    return { result: toolError(`Repository not found: ${fullName}`) };
  }
  const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']);
  const rec = storeCreateIssue(store, fullName, title, body);
  const out = storeIssueObject(store, rec);
  (out as Record<string, unknown>).full_name = fullName;
  return { result: toolResult(out) };
}

function callListIssues(store: Store, args: Record<string, unknown>): ToolOutcome {
  const viewerLogin = storeViewerLogin(store);
  const { owner, repo } = resolveOwnerRepo(args, viewerLogin);
  if (repo === '') return { result: toolError('Missing required argument: repo') };
  const fullName = `${owner}/${repo}`;
  if (storeFindRepo(store, owner, repo) === null) {
    return { result: toolError(`Repository not found: ${fullName}`) };
  }
  const state = pickString(args, ['state', 'status']).toLowerCase();
  let issues = storeListIssues(store, fullName);
  if (state === 'open') issues = issues.filter((issue) => str(issue.state).toLowerCase() !== 'closed');
  else if (state === 'closed') issues = issues.filter((issue) => str(issue.state).toLowerCase() === 'closed');
  const payload = issues.map((issue) => {
    const out = storeIssueObject(store, issue);
    (out as Record<string, unknown>).full_name = fullName;
    return out;
  });
  return { result: toolResult(payload) };
}

function callCreatePullRequest(store: Store, args: Record<string, unknown>): ToolOutcome {
  const viewerLogin = storeViewerLogin(store);
  const { owner, repo } = resolveOwnerRepo(args, viewerLogin);
  const title = pickString(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
  const head = pickString(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
  const base = pickString(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
  const missing: string[] = [];
  if (repo === '') missing.push('repo');
  if (title === '') missing.push('title');
  if (head === '') missing.push('head');
  if (base === '') missing.push('base');
  if (missing.length > 0) return { result: toolError(`Missing required argument(s): ${missing.join(', ')}`) };
  const fullName = `${owner}/${repo}`;
  if (storeFindRepo(store, owner, repo) === null) {
    return { result: toolError(`Repository not found: ${fullName}`) };
  }
  const body = pickString(args, ['body', 'description', 'content', 'text']);
  const { rec, error } = storeCreatePull(store, fullName, title, body, base, head);
  if (rec === null || error !== null) {
    return { result: toolError(error ?? 'Could not create the pull request') };
  }
  const out = storePullObject(store, rec);
  (out as Record<string, unknown>).full_name = fullName;
  return { result: toolResult(out) };
}

function callMergePullRequest(store: Store, args: Record<string, unknown>): ToolOutcome {
  const viewerLogin = storeViewerLogin(store);
  const { owner, repo } = resolveOwnerRepo(args, viewerLogin);
  const pullNumber = num(args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number ?? args.issue_number ?? args.index);
  if (repo === '') return { result: toolError('Missing required argument: repo') };
  if (pullNumber === null) return { result: toolError('Missing required argument: pull_number') };
  const fullName = `${owner}/${repo}`;
  const pull = storeListPulls(store, fullName).find((item) => Number(item.number) === pullNumber);
  if (pull === undefined) {
    return { result: toolError(`Pull request not found: ${fullName}#${pullNumber}`) };
  }
  const { mergeSha } = storeMergePull(store, pull);
  const out = storePullObject(store, pull);
  (out as Record<string, unknown>).full_name = fullName;
  (out as Record<string, unknown>).sha = mergeSha;
  (out as Record<string, unknown>).message = `Merged pull request #${pullNumber}`;
  return { result: toolResult(out) };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = findTool(name);
  if (tool === null) {
    return { rpcErrorCode: JSON_RPC_INVALID_PARAMS, rpcErrorMessage: `Unknown tool: ${name}` };
  }
  switch (tool.name) {
    case 'create_repo':
      return callCreateRepo(store, args);
    case 'get_repo':
      return callGetRepo(store, args);
    case 'create_issue':
      return callCreateIssue(store, args);
    case 'list_issues':
      return callListIssues(store, args);
    case 'create_pull_request':
      return callCreatePullRequest(store, args);
    case 'merge_pull_request':
      return callMergePullRequest(store, args);
    default:
      return { rpcErrorCode: JSON_RPC_INVALID_PARAMS, rpcErrorMessage: `Unknown tool: ${name}` };
  }
}

// -----------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// -----------------------------------------------------------------------------------------------

function checkAuth(headers: unknown, ctx: McpContext | undefined): boolean {
  const authorization = getHeader(headers, 'authorization');
  if (authorization === null) return false;
  const match = /^Bearer\s+(.+)$/.exec(authorization.trim());
  const presented = match === null ? '' : (match[1] as string);
  if (presented === '') return false;
  const expected = ctx?.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return presented === expected;
  return true;
}

function handleOne(store: Store, request: unknown): { status: number; body: unknown } | null {
  if (!isRecord(request)) {
    return { status: 200, body: rpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request') };
  }
  const id = 'id' in request ? request.id : undefined;
  const method = str(request.method);
  const params = isRecord(request.params) ? (request.params as Record<string, unknown>) : {};

  // Notifications (no id) are acknowledged with no response body.
  if (method.startsWith('notifications/')) return null;
  if (id === undefined) return null;

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return {
      status: 200,
      body: rpcResult(id, {
        resultType: 'discover',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...serverInfo },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...serverInfo } },
      }),
    };
  }

  if (method === 'initialize') {
    const requested = str(params.protocolVersion);
    const negotiated = SUPPORTED_VERSIONS.includes(requested)
      ? requested
      : LEGACY_REVISIONS.includes(requested)
        ? requested
        : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    // The static list serializes identically on every call.
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const name = str(params.name);
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (name === '') {
      return { status: 200, body: rpcError(id, JSON_RPC_INVALID_PARAMS, 'Missing required argument: name') };
    }
    const outcome = callTool(store, name, args);
    if (outcome.rpcErrorCode !== undefined) {
      return { status: 200, body: rpcError(id, outcome.rpcErrorCode, outcome.rpcErrorMessage ?? 'Invalid params') };
    }
    return { status: 200, body: rpcResult(id, outcome.result ?? toolError('The tool returned no result')) };
  }

  return { status: 200, body: rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`) };
}

/**
 * Handle one POST /mcp request.
 * `bodyText` is the raw request body. Returns { status, headers, body } with body a JSON
 * string (or '' for a notification acknowledgement). A JSON-RPC batch (an array body) is
 * answered with an array of responses in request order.
 */
export function handleMcp(bodyText: string, headers: unknown, store: Store, ctx: McpContext | undefined): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' } });
  }
  if (!checkAuth(headers, ctx)) {
    const id = isRecord(parsed) && 'id' in parsed ? parsed.id : null;
    return jsonResponse(401, { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message: 'Unauthorized' } });
  }
  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const entry of parsed) {
      const answered = handleOne(store, entry);
      if (answered !== null) responses.push(answered.body);
    }
    return jsonResponse(200, responses);
  }
  const answered = handleOne(store, parsed);
  if (answered === null) {
    // A notification: no JSON-RPC response. Streamable HTTP answers 202 with an empty body.
    return { status: 202, headers: { 'content-type': 'application/json' }, body: '' };
  }
  return jsonResponse(answered.status, answered.body);
}
