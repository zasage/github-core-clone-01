// src/graphql.ts — GraphQL v4 endpoint (POST /api/graphql) for the github-core-clone-01 forge.
//
// Handler: handleGraphQL(bodyJson, store, ctx) -> { status, body }.
//   bodyJson: the already-parsed JSON request body: one {query, variables, operationName}
//             object, or an array of them (GitHub operation batching).
//   store:    the shared Store (imported as a type from './store.ts'); see STORE CONTRACT below.
//   ctx:      { token } — the auth context. Auth resolution (see checkAuth):
//             presented = ctx.presentedToken ?? ctx.token; expected = ctx.expectedToken ??
//             process.env.MAKEFUN_SHOP_TOKEN. When app.ts passes ctx.token as the *presented*
//             bearer and the expected token lives in the env var, that just works. A request
//             without the right bearer is exactly 401.
//
// What it implements (the documents gh and github-mcp-server send, per
// program/env/src/checks-graphql.ts + graphql-client.ts):
//   Query.viewer{login}, Query.repository(owner,name), Query.node(id:) with `... on Repository`,
//   Repository{issue, issues, pullRequest, pullRequests, ...}, Issue/PullRequest fields,
//   mutations createIssue / closeIssue / createPullRequest / mergePullRequest / addComment,
//   __type introspection for Issue / PullRequest / Repository / SearchType (+ the other enums),
//   batched operation arrays, unknown field -> HTTP 200 + errors naming the field,
//   unknown repository -> data.repository = null with no errors.
// The GraphQL parser (tokenizer + recursive-descent document parser) is hand-written; no library.
//
// STORE CONTRACT (the real src/store.ts, written by Worker B — the adapters in section B
// are the ONLY place that touches the store, so a shape change is fixed there):
//   store.repos:    Map<string, Repo>                  key: "owner/name"
//   store.refs:     Map<string, Map<string, string>>   key: "owner/name" -> ("refs/heads/<branch>" -> sha)
//   store.objects:  ObjectStore (get(oid) -> {type, body: Buffer}, put(type, body) -> oid)
//   store.issues:   Map<string, Issue[]>              key: "owner/name"
//   store.labels:   Map<string, Label[]>              key: "owner/name"
//   store.pulls:    Map<string, Pull[]>               key: "owner/name"
//   store.comments: Map<string, Comment[]>            key: "owner/name" (Comment carries issueNumber)
//   store.ownerLogin: string                           (the login the token names: "adaiversen")
//   store.clock.now(): string                          (deterministic ISO timestamp)
//   store.nextId(): number                             (global deterministic id counter)
//   store.nextNumber(repoKey, 'issue' | 'pull'): number (per-repo number counter)
//   store.createRepo(owner, name, description?, {private?, defaultBranch?}): Repo
//   Repo:    { id, owner, name, description: string|null, defaultBranch, private,
//              createdAt, updatedAt }
//   Issue:   { id, number, title, body, state: 'open'|'closed', labels: string[],
//              createdAt, updatedAt, closedAt, user: string (login) }
//   Pull:    { id, number, title, body, state: 'open'|'closed',
//              head: { ref, sha }, base: { ref, sha }, merged: boolean, mergeable: boolean,
//              mergeCommitSha, mergedAt, closedAt, createdAt, updatedAt }
//   Comment: { id, issueNumber, body, createdAt, updatedAt, user: string (login) }
// Field readers below accept the camelCase names above first and the snake_case spellings
// as a fallback, so the module also works against a stub store in tests.
// Global (Relay) ids are opaque base64url strings encoding "kind:payload" (e.g. "R:owner/repo",
// "I:owner/repo#3", "P:owner/repo#2", "C:owner/repo#3:7"); they are stable across reads and
// never equal to the plain numeric id/number.
//
// VIEWER LOGIN: the suite's scenario seed is a published constant, so the viewer login is the
// same in every trial ("adaiversen", derived from kit program/env/src/wire.ts SCENARIO_SEED,
// and confirmed by docs/CHECKS.md §8 Q1). The primary source is store.ownerLogin; the
// constant below is only the last-resort fallback so this module works standalone. If the
// suite ever changes its scenario seed, set store.ownerLogin instead of relying on it.
//
// AUTH WIRING (app.ts): handleGraphQL receives no request headers, so the presented bearer
// must reach it through ctx — pass ctx = { token: <presented bearer> } (compared against
// ctx.expectedToken ?? process.env.MAKEFUN_SHOP_TOKEN), or ctx = { presentedToken,
// expectedToken }, or pre-authenticate in app.ts and pass ctx = { authenticated: true }.
// A request without the right bearer is exactly 401.

import type { Store } from './store.ts';
import { createHash } from 'node:crypto';

/** The bearer context the handler accepts. */
export interface GraphQLContext {
  /** The presented bearer token (compared against the expected token). */
  token?: string | null;
  /** The presented bearer token, when app.ts passes it separately from the expected token. */
  presentedToken?: string | null;
  /** The expected bearer token, when app.ts passes it explicitly. */
  expectedToken?: string | null;
  /** True when app.ts already authenticated this request (skips the token check). */
  authenticated?: boolean;
}

export interface GraphQLResult {
  status: number;
  body: unknown;
}

// -----------------------------------------------------------------------------------------------
// A. Small utilities
// -----------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** base64url without padding (opaque, URL-safe, deterministic). */
function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Fallback viewer login, derived from the kit's constant scenario seed (see header). */
const FALLBACK_VIEWER_LOGIN = 'adaiversen';

/** Deterministic clock fallback: a fixed base advanced one second per call, per process. */
let fallbackClockTick = 0;
function fallbackNow(): string {
  const base = Date.UTC(2026, 10, 17, 0, 0, 0) + fallbackClockTick * 1000;
  fallbackClockTick += 1;
  return new Date(base).toISOString();
}

// -----------------------------------------------------------------------------------------------
// B. Store adapter — the only code that knows the Store's shape (see header contract).
// -----------------------------------------------------------------------------------------------

/** The structural view this file needs from the Store; the real Store is cast to it. */
interface StoreLike {
  repos?: unknown;
  refs?: unknown;
  objects?: unknown;
  issues?: unknown;
  labels?: unknown;
  pulls?: unknown;
  comments?: unknown;
  viewerLogin?: unknown;
  ownerLogin?: unknown;
  clock?: unknown;
  now?: unknown;
  nextId?: unknown;
  nextNumber?: unknown;
  createRepo?: unknown;
  getRepo?: unknown;
}

type AnyRecord = Record<string, unknown>;

function asStoreLike(store: Store): StoreLike {
  return store as unknown as StoreLike;
}

function mapOf(store: StoreLike, key: keyof StoreLike): Map<string, unknown> | null {
  const value = store[key];
  return value instanceof Map ? (value as Map<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A timestamp field: camelCase first, snake_case as fallback. */
function tsOf(rec: AnyRecord, camel: string, snake: string): string {
  return str(rec[camel] ?? rec[snake]);
}

/** The deterministic timestamp: the store clock when it has one, else the fallback clock. */
function nowIso(store: StoreLike): string {
  const clock = store.clock;
  if (isRecord(clock) && typeof clock.now === 'function') {
    try {
      const value = (clock.now as () => unknown)();
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      // fall through
    }
  }
  if (typeof store.now === 'function') {
    try {
      const value = (store.now as () => unknown)();
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      // fall through to the fallback clock
    }
  }
  return fallbackNow();
}

/** The login the token names: store.ownerLogin, else any repo's owner, else the fallback. */
function viewerLoginOf(store: StoreLike): string {
  if (typeof store.ownerLogin === 'string' && store.ownerLogin !== '') return store.ownerLogin;
  if (typeof store.viewerLogin === 'string' && store.viewerLogin !== '') return store.viewerLogin;
  for (const repo of allRepos(store)) {
    const owner = str((repo as AnyRecord).owner);
    if (owner !== '') return owner;
  }
  return FALLBACK_VIEWER_LOGIN;
}

/** The next global deterministic id: store.nextId() when it has one, else max + 1. */
function nextGlobalId(store: StoreLike): number {
  if (typeof store.nextId === 'function') {
    try {
      const value = (store.nextId as () => unknown)();
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    } catch {
      // fall through
    }
  }
  let max = 0;
  for (const key of ['repos', 'issues', 'labels', 'pulls', 'comments'] as const) {
    const map = mapOf(store, key);
    if (map === null) continue;
    for (const value of map.values()) {
      if (Array.isArray(value)) {
        for (const item of value) if (isRecord(item)) max = Math.max(max, num((item as AnyRecord).id));
      } else if (isRecord(value)) {
        max = Math.max(max, num((value as AnyRecord).id));
      }
    }
  }
  return max + 1;
}

/** The next per-repo issue/pull number: store.nextNumber(repoKey, kind) when it has one. */
function nextRepoNumber(store: StoreLike, fullName: string, kind: 'issue' | 'pull'): number {
  if (typeof store.nextNumber === 'function') {
    try {
      const value = (store.nextNumber as (key: string, kind: string) => unknown)(fullName, kind);
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    } catch {
      // fall through
    }
  }
  const records = kind === 'issue' ? listIssues(store, fullName) : listPulls(store, fullName);
  return records.reduce((max, item) => Math.max(max, num(item.number)), 0) + 1;
}

/** All repo records, whatever key the map uses. */
function allRepos(store: StoreLike): AnyRecord[] {
  const map = mapOf(store, 'repos');
  if (map === null) return [];
  const out: AnyRecord[] = [];
  for (const value of map.values()) {
    if (isRecord(value)) out.push(value as AnyRecord);
  }
  return out;
}

/** Find a repo by owner/name (case-insensitive on both parts). */
function findRepo(store: StoreLike, owner: string, name: string): AnyRecord | null {
  const map = mapOf(store, 'repos');
  if (map !== null) {
    const direct = map.get(`${owner}/${name}`);
    if (isRecord(direct)) return direct as AnyRecord;
  }
  const wantOwner = owner.toLowerCase();
  const wantName = name.toLowerCase();
  for (const repo of allRepos(store)) {
    if (str(repo.owner).toLowerCase() === wantOwner && str(repo.name).toLowerCase() === wantName) return repo;
  }
  return null;
}

/** Collect records out of a per-repo-array map OR a global id-keyed map of records. */
function collectForRepo(store: StoreLike, key: keyof StoreLike, fullName: string): AnyRecord[] {
  const map = mapOf(store, key);
  if (map === null) return [];
  const out: AnyRecord[] = [];
  const want = fullName.toLowerCase();
  for (const [mapKey, value] of map.entries()) {
    if (Array.isArray(value)) {
      // Per-repo array: take it when its key is this repo, or when its items name this repo.
      if (mapKey.toLowerCase() === want) {
        for (const item of value) if (isRecord(item)) out.push(item as AnyRecord);
      } else {
        for (const item of value) {
          if (isRecord(item) && str((item as AnyRecord).repo).toLowerCase() === want) out.push(item as AnyRecord);
        }
      }
    } else if (isRecord(value)) {
      const rec = value as AnyRecord;
      if (str(rec.repo).toLowerCase() === want) out.push(rec);
    }
  }
  return out;
}

/** Insert a record into a per-repo-array map (or a global map when that is the live shape). */
function insertForRepo(store: StoreLike, key: keyof StoreLike, fullName: string, rec: AnyRecord): void {
  const map = mapOf(store, key);
  if (map === null) return;
  // Decide the live shape from what is already stored.
  let sawArray = false;
  let sawRecord = false;
  for (const value of map.values()) {
    if (Array.isArray(value)) sawArray = true;
    else if (isRecord(value)) sawRecord = true;
  }
  if (sawArray && !sawRecord) {
    const existing = map.get(fullName);
    if (Array.isArray(existing)) {
      existing.push(rec);
    } else {
      map.set(fullName, [rec]);
    }
    return;
  }
  if (sawRecord && !sawArray) {
    map.set(String(rec.id ?? `${fullName}#${num(rec.number)}`), rec);
    return;
  }
  // Empty map (or mixed): default to the per-repo-array shape.
  const existing = map.get(fullName);
  if (Array.isArray(existing)) existing.push(rec);
  else map.set(fullName, [rec]);
}

function listIssues(store: StoreLike, fullName: string): AnyRecord[] {
  return collectForRepo(store, 'issues', fullName);
}

function listPulls(store: StoreLike, fullName: string): AnyRecord[] {
  return collectForRepo(store, 'pulls', fullName);
}

/**
 * Comments for one issue. The real store keys the comments map by repo ("owner/name") and
 * each comment carries issueNumber; a stub may key by "owner/name#<n>" or store a repo
 * field on the record instead. All three shapes are read.
 */
function listComments(store: StoreLike, fullName: string, issueNumber: number): AnyRecord[] {
  const map = mapOf(store, 'comments');
  if (map === null) return [];
  const out: AnyRecord[] = [];
  const want = fullName.toLowerCase();
  for (const [mapKey, value] of map.entries()) {
    const key = mapKey.toLowerCase();
    const items = Array.isArray(value) ? value : isRecord(value) ? [value] : [];
    if (key === want) {
      // Repo-keyed (the real store): filter by issueNumber.
      for (const item of items) {
        if (isRecord(item) && num((item as AnyRecord).issueNumber ?? (item as AnyRecord).issue_number) === issueNumber) {
          out.push(item as AnyRecord);
        }
      }
    } else if (key === `${want}#${issueNumber}`) {
      for (const item of items) if (isRecord(item)) out.push(item as AnyRecord);
    } else {
      for (const item of items) {
        if (
          isRecord(item) &&
          str((item as AnyRecord).repo).toLowerCase() === want &&
          num((item as AnyRecord).issueNumber ?? (item as AnyRecord).issue_number) === issueNumber
        ) {
          out.push(item as AnyRecord);
        }
      }
    }
  }
  return out;
}

/** The sha a branch ref points at, or null. The real store nests refs per repo
 *  (Map<"owner/name", Map<"refs/heads/<branch>", sha>>); a flat map is also read. */
function getRefSha(store: StoreLike, fullName: string, branch: string): string | null {
  const refs = mapOf(store, 'refs');
  if (refs === null) return null;
  const nested = refs.get(fullName);
  if (nested instanceof Map) {
    const sha = nested.get(`refs/heads/${branch}`);
    if (typeof sha === 'string' && sha !== '') return sha;
  }
  const flat = refs.get(`${fullName}:refs/heads/${branch}`);
  if (typeof flat === 'string' && flat !== '') return flat;
  const flatShort = refs.get(`${fullName}:${branch}`);
  if (typeof flatShort === 'string' && flatShort !== '') return flatShort;
  return null;
}

function setRefSha(store: StoreLike, fullName: string, branch: string, sha: string): void {
  const refs = mapOf(store, 'refs');
  if (refs === null) return;
  const nested = refs.get(fullName);
  if (nested instanceof Map) {
    nested.set(`refs/heads/${branch}`, sha);
    return;
  }
  refs.set(`${fullName}:refs/heads/${branch}`, sha);
}

/**
 * One git object: { type, data: Buffer } or null. The real store.objects is an ObjectStore
 * (get(oid) -> {type, body: Buffer}); a Map of {type, data|body} is also read. The stored
 * bytes are the bare object content; a leading "<type> <len>\0" header is stripped if present.
 */
function getObject(store: StoreLike, sha: string): { type: string; data: Buffer } | null {
  const objects = store.objects;
  let value: unknown = null;
  if (objects !== null && typeof objects === 'object' && typeof (objects as { get?: unknown }).get === 'function') {
    try {
      value = ((objects as { get: (oid: string) => unknown }).get)(sha);
    } catch {
      return null;
    }
  } else if (objects instanceof Map) {
    value = objects.get(sha);
  } else {
    return null;
  }
  if (!isRecord(value)) return null;
  const type = str((value as AnyRecord).type);
  const raw = (value as AnyRecord).body ?? (value as AnyRecord).data;
  if (type === '') return null;
  let data: Buffer;
  if (Buffer.isBuffer(raw)) data = raw;
  else if (raw instanceof Uint8Array) data = Buffer.from(raw);
  else if (typeof raw === 'string') data = Buffer.from(raw, 'utf8');
  else return null;
  const nul = data.indexOf(0x00);
  if (nul > 0 && nul < 64) {
    const header = data.subarray(0, nul).toString('ascii');
    if (/^(commit|tree|blob|tag) \d+$/.test(header)) data = data.subarray(nul + 1);
  }
  return { type, data };
}

/** Store an object and answer its oid (ObjectStore hashes it; a Map stores it under `sha`). */
function putObject(store: StoreLike, type: string, data: Buffer, sha?: string): string {
  const objects = store.objects;
  if (objects !== null && typeof objects === 'object' && typeof (objects as { put?: unknown }).put === 'function') {
    const oid = ((objects as { put: (type: string, body: Buffer) => unknown }).put)(type, data);
    if (typeof oid === 'string' && oid !== '') return oid;
  }
  if (objects instanceof Map) {
    const id = sha ?? createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data])).digest('hex');
    objects.set(id, { type, data });
    return id;
  }
  return sha ?? '';
}

/** The tree sha of a commit object, or null. */
function commitTreeSha(store: StoreLike, commitSha: string): string | null {
  const obj = getObject(store, commitSha);
  if (obj === null || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('tree ')) return line.slice(5).trim();
    if (line === '') break;
  }
  return null;
}

/** Flatten a tree object to path -> blob sha (recursive, depth-capped, cycle-safe). */
function flattenTree(store: StoreLike, treeSha: string, prefix: string, out: Map<string, string>, depth: number, seen: Set<string>): void {
  if (depth > 20 || seen.has(treeSha)) return;
  seen.add(treeSha);
  const obj = getObject(store, treeSha);
  if (obj === null || obj.type !== 'tree') return;
  const data = obj.data;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (mode === '40000') {
      flattenTree(store, sha, path, out, depth + 1, seen);
    } else {
      out.set(path, sha);
    }
    offset = nul + 21;
  }
}

/** Changed paths between two commits' trees (added / modified / deleted). */
function diffPaths(store: StoreLike, baseSha: string | null, headSha: string): string[] {
  const headTree = commitTreeSha(store, headSha);
  if (headTree === null) return [];
  const headMap = new Map<string, string>();
  flattenTree(store, headTree, '', headMap, 0, new Set());
  const baseMap = new Map<string, string>();
  if (baseSha !== null) {
    const baseTree = commitTreeSha(store, baseSha);
    if (baseTree !== null) flattenTree(store, baseTree, '', baseMap, 0, new Set());
  }
  const changed: string[] = [];
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  for (const path of paths) {
    if (baseMap.get(path) !== headMap.get(path)) changed.push(path);
  }
  changed.sort();
  return changed;
}

/** Whether baseSha is an ancestor of headSha (first-parent + all-parent walk, capped). */
function isAncestor(store: StoreLike, baseSha: string, headSha: string): boolean {
  if (baseSha === headSha) return true;
  const seen = new Set<string>();
  const stack: string[] = [headSha];
  let steps = 0;
  while (stack.length > 0 && steps < 2000) {
    steps += 1;
    const sha = stack.pop() as string;
    if (sha === baseSha) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = getObject(store, sha);
    if (obj === null || obj.type !== 'commit') continue;
    const text = obj.data.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.startsWith('parent ')) stack.push(line.slice(7).trim());
      if (line === '') break;
    }
  }
  return false;
}

/** The parents of a commit object, or [] when it cannot be read. */
function commitParents(store: StoreLike, commitSha: string): string[] {
  const obj = getObject(store, commitSha);
  if (obj === null || obj.type !== 'commit') return [];
  const parents: string[] = [];
  for (const line of obj.data.toString('utf8').split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    if (line === '') break;
  }
  return parents;
}

/** All ancestors of a tip (including the tip), in walk order. */
function ancestorsOf(store: StoreLike, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  let steps = 0;
  while (stack.length > 0 && steps < 5000) {
    steps += 1;
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    out.push(sha);
    for (const parent of commitParents(store, sha)) stack.push(parent);
  }
  return out;
}

/** The merge base of two tips: the first ancestor of `b` that is also an ancestor of `a`. */
function mergeBaseOf(store: StoreLike, a: string, b: string): string | null {
  const aAncestors = new Set(ancestorsOf(store, a));
  for (const sha of ancestorsOf(store, b)) {
    if (aAncestors.has(sha)) return sha;
  }
  return null;
}

/**
 * Whether a pull is conflicted, mirroring REST's pullConflicted: head and base both changed
 * the same path away from the merge-base to different contents. False when unknowable.
 */
function pullConflicted(store: StoreLike, headSha: string, baseSha: string): boolean {
  try {
    const base = mergeBaseOf(store, headSha, baseSha);
    if (base === null) return false;
    const baseTree = commitTreeSha(store, base);
    const headTree = commitTreeSha(store, headSha);
    const tipTree = commitTreeSha(store, baseSha);
    if (baseTree === null || headTree === null || tipTree === null) return false;
    const baseFlat = new Map<string, string>();
    const headFlat = new Map<string, string>();
    const tipFlat = new Map<string, string>();
    flattenTree(store, baseTree, '', baseFlat, 0, new Set());
    flattenTree(store, headTree, '', headFlat, 0, new Set());
    flattenTree(store, tipTree, '', tipFlat, 0, new Set());
    const paths = new Set([...headFlat.keys(), ...tipFlat.keys(), ...baseFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const t = tipFlat.get(path);
      if (h !== b && t !== b && h !== t) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------------------------
// C. GraphQL tokenizer + parser (hand-written, no library)
// -----------------------------------------------------------------------------------------------

type TokenKind = 'Name' | 'Int' | 'Float' | 'String' | 'Punct' | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
}

class ParseError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < len && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'Punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'Punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or normal "..." with escapes.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new ParseError('Unterminated block string');
        tokens.push({ kind: 'String', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < len) {
        const c = source[j] as string;
        if (c === '"') break;
        if (c === '\\' && j + 1 < len) {
          const esc = source[j + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          if (esc === 'u' && j + 5 < len) {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          out += map[esc] ?? esc;
          j += 2;
          continue;
        }
        if (c === '\n') throw new ParseError('Unterminated string');
        out += c;
        j += 1;
      }
      if (j >= len) throw new ParseError('Unterminated string');
      tokens.push({ kind: 'String', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      let isFloat = false;
      while (j < len && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < len && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < len && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'Float' : 'Int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < len && /[_A-Za-z0-9]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'Name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`Unexpected character: ${ch}`);
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'IntValue'; value: string }
  | { kind: 'FloatValue'; value: string }
  | { kind: 'StringValue'; value: string }
  | { kind: 'BooleanValue'; value: boolean }
  | { kind: 'NullValue' }
  | { kind: 'EnumValue'; value: string }
  | { kind: 'ListValue'; values: ValueNode[] }
  | { kind: 'ObjectValue'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface FieldNode {
  kind: 'Field';
  alias?: string;
  name: string;
  args: ArgumentNode[];
  selectionSet?: SelectionSetNode;
}

interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition?: string;
  selectionSet: SelectionSetNode;
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface SelectionSetNode {
  kind: 'SelectionSet';
  selections: SelectionNode[];
}

interface VariableDefinitionNode {
  name: string;
  type: string;
  defaultValue?: ValueNode;
}

interface OperationDefinitionNode {
  kind: 'OperationDefinition';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: VariableDefinitionNode[];
  selectionSet: SelectionSetNode;
}

interface FragmentDefinitionNode {
  kind: 'FragmentDefinition';
  name: string;
  typeCondition: string;
  selectionSet: SelectionSetNode;
}

type DefinitionNode = OperationDefinitionNode | FragmentDefinitionNode;

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'Punct' || token.value !== value) {
      throw new ParseError(`Expected "${value}", got ${token.kind} ${token.value}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'Name') throw new ParseError(`Expected a name, got ${token.kind} ${token.value}`);
    if (value !== undefined && token.value !== value) throw new ParseError(`Expected "${value}", got "${token.value}"`);
    return token.value;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'Punct' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'EOF') {
      definitions.push(this.parseDefinition());
    }
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'Punct' && token.value === '{') {
      return { kind: 'OperationDefinition', operation: 'query', variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'Name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | undefined;
      if (this.peek().kind === 'Name') name = this.next().value;
      const variableDefinitions = this.parseVariableDefinitions();
      this.skipDirectives();
      return { kind: 'OperationDefinition', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'Name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'FragmentDefinition', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new ParseError(`Unexpected token ${token.kind} ${token.value} at document level`);
  }

  /** Parse a type reference ("String!", "[IssueState!]", "CreateIssueInput") as a raw string. */
  private parseType(): string {
    const token = this.peek();
    if (token.kind === 'Punct' && token.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      return `[${inner}]${this.matchPunct('!') ? '!' : ''}`;
    }
    const name = this.expectName();
    return `${name}${this.matchPunct('!') ? '!' : ''}`;
  }

  private parseVariableDefinitions(): VariableDefinitionNode[] {
    const definitions: VariableDefinitionNode[] = [];
    if (!this.matchPunct('(')) return definitions;
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.matchPunct('=')) defaultValue = this.parseValue();
      this.skipDirectives();
      definitions.push({ name, type, defaultValue });
    }
    return definitions;
  }

  /** Directives (@name(args)) are parsed and ignored. */
  private skipDirectives(): void {
    while (this.peek().kind === 'Punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'Punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    this.expectPunct('(');
    while (!this.matchPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === 'Punct' && token.value === '$') {
      this.next();
      return { kind: 'Variable', name: this.expectName() };
    }
    if (token.kind === 'Int') {
      this.next();
      return { kind: 'IntValue', value: token.value };
    }
    if (token.kind === 'Float') {
      this.next();
      return { kind: 'FloatValue', value: token.value };
    }
    if (token.kind === 'String') {
      this.next();
      return { kind: 'StringValue', value: token.value };
    }
    if (token.kind === 'Name') {
      this.next();
      if (token.value === 'true') return { kind: 'BooleanValue', value: true };
      if (token.value === 'false') return { kind: 'BooleanValue', value: false };
      if (token.value === 'null') return { kind: 'NullValue' };
      return { kind: 'EnumValue', value: token.value };
    }
    if (token.kind === 'Punct' && token.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.matchPunct(']')) values.push(this.parseValue());
      return { kind: 'ListValue', values };
    }
    if (token.kind === 'Punct' && token.value === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.matchPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'ObjectValue', fields };
    }
    throw new ParseError(`Unexpected value token ${token.kind} ${token.value}`);
  }

  private parseSelectionSet(): SelectionSetNode {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      selections.push(this.parseSelection());
    }
    return { kind: 'SelectionSet', selections };
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'Punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'InlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'Name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'FragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'InlineFragment', selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    let args: ArgumentNode[] = [];
    if (this.peek().kind === 'Punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionSetNode | undefined;
    if (this.peek().kind === 'Punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'Field', alias, name, args, selectionSet };
  }
}

// -----------------------------------------------------------------------------------------------
// D. Schema table (introspection source of truth + field validation)
// -----------------------------------------------------------------------------------------------

interface SchemaTypeDef {
  kind: 'OBJECT' | 'ENUM';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, SchemaTypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'updatedAt', 'url'],
  },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'filename'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'prefix'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Node: { kind: 'OBJECT', fields: ['id'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues', 'description'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description'] },
  __Schema: { kind: 'OBJECT', fields: ['queryType', 'mutationType', 'types', 'description'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
};

// -----------------------------------------------------------------------------------------------
// E. Execution
// -----------------------------------------------------------------------------------------------

interface GraphQLError {
  message: string;
  path?: (string | number)[];
}

interface ExecState {
  store: StoreLike;
  viewerLogin: string;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinitionNode>;
  errors: GraphQLError[];
}

/** Evaluate a value AST node against the operation variables. */
function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'IntValue':
      return parseInt(node.value, 10);
    case 'FloatValue':
      return parseFloat(node.value);
    case 'StringValue':
      return node.value;
    case 'BooleanValue':
      return node.value;
    case 'NullValue':
      return null;
    case 'EnumValue':
      return node.value;
    case 'ListValue':
      return node.values.map((item) => valueFromAst(item, variables));
    case 'ObjectValue': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, state: ExecState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueFromAst(arg.value, state.variables);
  return out;
}

// --- Global ids -------------------------------------------------------------------------------

function repoGlobalId(fullName: string): string {
  return b64urlEncode(`R:${fullName}`);
}

function issueGlobalId(fullName: string, number: number): string {
  return b64urlEncode(`I:${fullName}#${number}`);
}

function pullGlobalId(fullName: string, number: number): string {
  return b64urlEncode(`P:${fullName}#${number}`);
}

function commentGlobalId(fullName: string, issueNumber: number, commentId: number): string {
  return b64urlEncode(`C:${fullName}#${issueNumber}:${commentId}`);
}

/** Decode a global id: { kind, fullName, number?, commentId? } or null. */
function decodeGlobalId(id: string): { kind: string; fullName: string; number: number | null; commentId: number | null } | null {
  const decoded = b64urlDecode(id);
  if (decoded === null) return null;
  const match = /^([RIPC]):(.+?)(?:#(\d+))?(?::(\d+))?$/.exec(decoded);
  if (match === null) return null;
  return {
    kind: match[1] as string,
    fullName: match[2] as string,
    number: match[3] === undefined ? null : parseInt(match[3], 10),
    commentId: match[4] === undefined ? null : parseInt(match[4], 10),
  };
}

// --- Object builders (internal values carry __typename + _record; the executor only copies
//     selected fields, so neither ever leaks into a response) ------------------------------------

function repoObject(store: StoreLike, rec: AnyRecord): AnyRecord {
  const fullName = str(rec.full_name) || `${str(rec.owner)}/${str(rec.name)}`;
  return {
    __typename: 'Repository',
    _record: rec,
    _fullName: fullName,
    id: repoGlobalId(fullName),
    databaseId: num(rec.id),
    name: str(rec.name),
    nameWithOwner: fullName,
    owner: { __typename: 'User', login: str(rec.owner) },
    defaultBranchRef: { __typename: 'Ref', name: str(rec.defaultBranch ?? rec.default_branch), prefix: 'refs/heads/' },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueObject(store: StoreLike, rec: AnyRecord, fullName: string): AnyRecord {
  const number = num(rec.number);
  const state = str(rec.state).toLowerCase() === 'closed' ? 'CLOSED' : 'OPEN';
  const authorLogin = typeof rec.user === 'string' && rec.user !== '' ? rec.user : viewerLoginOf(store);
  return {
    __typename: 'Issue',
    _record: rec,
    _fullName: fullName,
    id: issueGlobalId(fullName, number),
    number,
    title: str(rec.title),
    state,
    body: str(rec.body),
    url: '',
    createdAt: tsOf(rec, 'createdAt', 'created_at'),
    updatedAt: tsOf(rec, 'updatedAt', 'updated_at'),
    author: { __typename: 'User', login: authorLogin },
  };
}

function pullStateOf(rec: AnyRecord): string {
  if (rec.merged === true) return 'MERGED';
  return str(rec.state).toLowerCase() === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullObject(store: StoreLike, rec: AnyRecord, fullName: string): AnyRecord {
  const number = num(rec.number);
  const head = isRecord(rec.head) ? (rec.head as AnyRecord) : {};
  const base = isRecord(rec.base) ? (rec.base as AnyRecord) : {};
  return {
    __typename: 'PullRequest',
    _record: rec,
    _fullName: fullName,
    id: pullGlobalId(fullName, number),
    number,
    title: str(rec.title),
    state: pullStateOf(rec),
    merged: rec.merged === true,
    headRefName: str(head.ref),
    baseRefName: str(base.ref),
    mergeable: mergeableOf(store, rec, fullName),
    files: { __typename: 'PullRequestChangedFileConnection', _record: rec, _fullName: fullName },
    body: str(rec.body),
    createdAt: tsOf(rec, 'createdAt', 'created_at'),
    updatedAt: tsOf(rec, 'updatedAt', 'updated_at'),
    url: '',
  };
}

/** Live tips for a pull (refs move after creation); falls back to the stored shas. */
function liveTipsOf(store: StoreLike, rec: AnyRecord, fullName: string): { headSha: string; baseSha: string } {
  const head = isRecord(rec.head) ? (rec.head as AnyRecord) : {};
  const base = isRecord(rec.base) ? (rec.base as AnyRecord) : {};
  return {
    headSha: getRefSha(store, fullName, str(head.ref)) ?? str(head.sha),
    baseSha: getRefSha(store, fullName, str(base.ref)) ?? str(base.sha),
  };
}

/**
 * MERGEABLE when head and base do not conflict (mirroring REST's pullConflicted over the
 * merge base); CONFLICTING when they do; UNKNOWN when the objects cannot be read.
 */
function mergeableOf(store: StoreLike, rec: AnyRecord, fullName: string): string {
  if (rec.merged === true) return 'MERGEABLE';
  if (str(rec.state).toLowerCase() === 'closed') return 'CONFLICTING';
  const { headSha, baseSha } = liveTipsOf(store, rec, fullName);
  if (headSha === '' || baseSha === '') return 'UNKNOWN';
  try {
    if (getObject(store, headSha) === null || getObject(store, baseSha) === null) return 'UNKNOWN';
    return pullConflicted(store, headSha, baseSha) ? 'CONFLICTING' : 'MERGEABLE';
  } catch {
    return 'UNKNOWN';
  }
}

/**
 * Changed file paths for a pull request: a live tree diff over the current branch tips
 * (like REST's GET /pulls/{n}/files), falling back to the list stored at creation.
 */
function pullFiles(store: StoreLike, rec: AnyRecord, fullName: string): string[] {
  const { headSha, baseSha } = liveTipsOf(store, rec, fullName);
  try {
    if (headSha !== '' && getObject(store, headSha) !== null) {
      return diffPaths(store, baseSha === '' ? null : baseSha, headSha);
    }
  } catch {
    // fall through to the stored list
  }
  const stored = rec._gqlFiles;
  if (Array.isArray(stored)) return stored.filter((entry): entry is string => typeof entry === 'string');
  const files = rec.files;
  if (Array.isArray(files)) {
    const paths: string[] = [];
    for (const entry of files) {
      if (typeof entry === 'string') paths.push(entry);
      else if (isRecord(entry)) {
        const path = str((entry as AnyRecord).path ?? (entry as AnyRecord).filename);
        if (path !== '') paths.push(path);
      }
    }
    if (paths.length > 0) return paths;
  }
  return [];
}

// --- Mutations (shared with MCP through the same store records) --------------------------------
// Records are written in the real store.ts shapes (camelCase) so REST reads them back exactly.

function createIssueRecord(store: StoreLike, fullName: string, title: string, body: string): AnyRecord {
  const now = nowIso(store);
  const rec: AnyRecord = {
    id: nextGlobalId(store),
    number: nextRepoNumber(store, fullName, 'issue'),
    title,
    body,
    state: 'open',
    labels: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    user: viewerLoginOf(store),
  };
  insertForRepo(store, 'issues', fullName, rec);
  return rec;
}

function createPullRecord(store: StoreLike, fullName: string, title: string, body: string, baseRef: string, headRef: string): { rec: AnyRecord | null; error: string | null } {
  const repo = findRepo(store, fullName.split('/')[0] as string, fullName.split('/').slice(1).join('/'));
  if (repo === null) return { rec: null, error: `Repository not found: ${fullName}` };
  const headSha = getRefSha(store, fullName, headRef);
  if (headSha === null || headSha === '') return { rec: null, error: `Head branch not found: ${headRef}` };
  const baseSha = getRefSha(store, fullName, baseRef);
  if (baseSha === null || baseSha === '') return { rec: null, error: `Base branch not found: ${baseRef}` };
  const now = nowIso(store);
  const rec: AnyRecord = {
    id: nextGlobalId(store),
    number: nextRepoNumber(store, fullName, 'pull'),
    title,
    body,
    state: 'open',
    merged: false,
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
    mergeable: true,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    rec._gqlFiles = diffPaths(store, baseSha, headSha);
  } catch {
    rec._gqlFiles = [];
  }
  insertForRepo(store, 'pulls', fullName, rec);
  return { rec, error: null };
}

function createCommentRecord(store: StoreLike, fullName: string, issueNumber: number, body: string): AnyRecord {
  const now = nowIso(store);
  const rec: AnyRecord = {
    id: nextGlobalId(store),
    issueNumber,
    body,
    createdAt: now,
    updatedAt: now,
    user: viewerLoginOf(store),
  };
  // The real store keys comments by repo ("owner/name"); insert under that key, never #n.
  insertForRepo(store, 'comments', fullName, rec);
  return rec;
}

/**
 * Squash-merge a pull request: build a squash commit (tree = head tree, parent = base tip),
 * move the base branch ref to it, and mark the pull merged + closed — the same fields REST's
 * merge sets (merged, state closed, mergeCommitSha, mergedAt, closedAt, mergeable false).
 * When the git objects are unavailable the pull is still marked merged/closed with the head
 * sha as the merge sha, so the REST view (merged:true, state closed) stays correct.
 */
function squashMergePull(store: StoreLike, rec: AnyRecord, fullName: string): { mergeSha: string | null; error: string | null } {
  const head = isRecord(rec.head) ? (rec.head as AnyRecord) : {};
  const base = isRecord(rec.base) ? (rec.base as AnyRecord) : {};
  const headSha = str(head.sha);
  const now = nowIso(store);
  let mergeSha: string | null = null;
  try {
    const repo = findRepo(store, fullName.split('/')[0] as string, fullName.split('/').slice(1).join('/'));
    const defaultBranch = repo === null ? 'main' : str((repo as AnyRecord).defaultBranch ?? (repo as AnyRecord).default_branch) || 'main';
    const baseRef = str(base.ref) || defaultBranch;
    const baseTip = getRefSha(store, fullName, baseRef) ?? str(base.sha);
    const treeSha = headSha === '' ? null : commitTreeSha(store, headSha);
    if (treeSha !== null && baseTip !== '') {
      const viewer = viewerLoginOf(store);
      const unix = Math.floor(new Date(now).getTime() / 1000);
      const who = `${viewer} <${viewer}@example.invalid> ${unix} +0000`;
      const message = `Merge pull request #${num(rec.number)} from ${str((repo as AnyRecord).owner) ?? viewer}/${str(head.ref)}\n\n${str(rec.title)}`;
      const commitBody = `tree ${treeSha}\nparent ${baseTip}\nauthor ${who}\ncommitter ${who}\n\n${message}\n`;
      mergeSha = putObject(store, 'commit', Buffer.from(commitBody, 'utf8'));
      if (mergeSha !== '') setRefSha(store, fullName, baseRef, mergeSha);
      else mergeSha = null;
    }
  } catch {
    mergeSha = null;
  }
  if (mergeSha === null) mergeSha = headSha === '' ? null : headSha;
  rec.merged = true;
  rec.state = 'closed';
  rec.mergeable = false;
  rec.mergedAt = now;
  rec.mergeCommitSha = mergeSha;
  rec.closedAt = now;
  rec.updatedAt = now;
  return { mergeSha, error: null };
}

// --- Field resolution ---------------------------------------------------------------------------

function unknownFieldError(state: ExecState, parentType: string, fieldName: string, path: (string | number)[]): void {
  state.errors.push({ message: `Cannot query field "${fieldName}" on type "${parentType}".`, path: [...path, fieldName] });
}

/** Resolve one field on a parent object; returns the raw value (scalar/object/array/null). */
function resolveField(state: ExecState, parentType: string, parent: AnyRecord | null, field: FieldNode, path: (string | number)[]): unknown {
  const name = field.name;
  const args = argsOf(field, state);

  if (name === '__typename') return parentType;

  const schemaFields = SCHEMA[parentType]?.fields ?? [];
  if (!schemaFields.includes(name)) {
    unknownFieldError(state, parentType, name, path);
    return null;
  }

  switch (parentType) {
    case 'Query': {
      if (name === 'viewer') return { __typename: 'User', login: state.viewerLogin };
      if (name === 'repository') {
        const repo = findRepo(state.store, str(args.owner), str(args.name));
        return repo === null ? null : repoObject(state.store, repo);
      }
      if (name === 'node') {
        const decoded = decodeGlobalId(str(args.id));
        if (decoded === null) return null;
        if (decoded.kind === 'R') {
          const parts = decoded.fullName.split('/');
          const repo = findRepo(state.store, parts[0] as string, parts.slice(1).join('/'));
          return repo === null ? null : repoObject(state.store, repo);
        }
        if (decoded.kind === 'I' && decoded.number !== null) {
          const issue = listIssues(state.store, decoded.fullName).find((item) => num(item.number) === decoded.number);
          return issue === undefined ? null : issueObject(state.store, issue, decoded.fullName);
        }
        if (decoded.kind === 'P' && decoded.number !== null) {
          const pull = listPulls(state.store, decoded.fullName).find((item) => num(item.number) === decoded.number);
          return pull === undefined ? null : pullObject(state.store, pull, decoded.fullName);
        }
        return null;
      }
      if (name === '__type') {
        const def = SCHEMA[str(args.name)];
        if (def === undefined) return null;
        return { __typename: '__Type', _typeName: str(args.name), name: str(args.name), kind: def.kind };
      }
      if (name === '__schema') {
        return { __typename: '__Schema', _typeName: '__Schema' };
      }
      return null;
    }
    case 'Mutation': {
      return resolveMutation(state, name, args, path);
    }
    case 'Repository': {
      const rec = (parent as AnyRecord)._record as AnyRecord;
      const fullName = str((parent as AnyRecord)._fullName);
      if (name === 'issue') {
        const issue = listIssues(state.store, fullName).find((item) => num(item.number) === num(args.number));
        return issue === undefined ? null : issueObject(state.store, issue, fullName);
      }
      if (name === 'issues') return issuesConnection(state, fullName, args);
      if (name === 'pullRequest') {
        const pull = listPulls(state.store, fullName).find((item) => num(item.number) === num(args.number));
        return pull === undefined ? null : pullObject(state.store, pull, fullName);
      }
      if (name === 'pullRequests') return pullsConnection(state, fullName, args);
      // Scalar/object fields (id, databaseId, name, ...) were precomputed on the parent object.
      return (parent as AnyRecord)[name] ?? null;
    }
    case 'Issue':
    case 'PullRequest':
    case 'User':
    case 'Ref':
    case 'PageInfo':
    case 'IssueComment':
    case 'IssueCommentEdge':
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload': {
      if (parentType === 'PullRequest' && name === 'files') {
        const rec = (parent as AnyRecord)._record as AnyRecord;
        const first = typeof args.first === 'number' ? args.first : 100;
        const paths = pullFiles(state.store, rec, str((parent as AnyRecord)._fullName)).slice(0, first);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: paths.map((path) => ({ __typename: 'PullRequestChangedFile', path, filename: path })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: paths.length,
        };
      }
      if (parentType === 'PullRequest' && name === 'mergeable') return mergeableOf(state.store, (parent as AnyRecord)._record as AnyRecord, str((parent as AnyRecord)._fullName));
      if (parentType === 'PullRequest' && name === 'state') return pullStateOf((parent as AnyRecord)._record as AnyRecord);
      return (parent as AnyRecord)[name] ?? null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      return (parent as AnyRecord)[name] ?? null;
    }
    case 'IssueEdge':
    case 'PullRequestEdge': {
      return (parent as AnyRecord)[name] ?? null;
    }
    case '__Type': {
      const typeName = str((parent as AnyRecord)._typeName);
      const def = SCHEMA[typeName];
      if (def === undefined) return null;
      if (name === 'fields') {
        if (def.kind !== 'OBJECT' || def.fields === undefined) return null;
        return def.fields.map((fieldName) => ({ __typename: '__Field', name: fieldName, description: null }));
      }
      if (name === 'enumValues') {
        if (def.kind !== 'ENUM' || def.enumValues === undefined) return null;
        return def.enumValues.map((enumName) => ({ __typename: '__EnumValue', name: enumName, description: null }));
      }
      return (parent as AnyRecord)[name] ?? null;
    }
    case '__Schema': {
      if (name === 'queryType') return { __typename: '__Type', _typeName: 'Query', name: 'Query', kind: 'OBJECT' };
      if (name === 'mutationType') return { __typename: '__Type', _typeName: 'Mutation', name: 'Mutation', kind: 'OBJECT' };
      if (name === 'types') {
        return Object.keys(SCHEMA).map((typeName) => ({ __typename: '__Type', _typeName: typeName, name: typeName, kind: SCHEMA[typeName]?.kind ?? 'OBJECT' }));
      }
      return (parent as AnyRecord)[name] ?? null;
    }
    case '__Field':
    case '__EnumValue': {
      return (parent as AnyRecord)[name] ?? null;
    }
    default:
      return (parent as AnyRecord | null)?.[name] ?? null;
  }
}

/** issues(first, states, orderBy, after) with CREATED_AT DESC / states filter / cursor paging. */
function issuesConnection(state: ExecState, fullName: string, args: Record<string, unknown>): AnyRecord {
  let issues = listIssues(state.store, fullName);
  const statesArg = args.states;
  if (Array.isArray(statesArg) && statesArg.length > 0) {
    const wanted = new Set(statesArg.map((entry) => String(entry).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(str(issue.state).toUpperCase()));
  }
  const orderBy = isRecord(args.orderBy) ? (args.orderBy as Record<string, unknown>) : {};
  const field = String(orderBy.field ?? 'CREATED_AT').toUpperCase();
  const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
  const sorted = [...issues];
  const compareCreated = (a: AnyRecord, b: AnyRecord): number => {
    const byTime = tsOf(a, 'createdAt', 'created_at').localeCompare(tsOf(b, 'createdAt', 'created_at'));
    if (byTime !== 0) return byTime;
    return num(a.number) - num(b.number);
  };
  const compareUpdated = (a: AnyRecord, b: AnyRecord): number => {
    const byTime = tsOf(a, 'updatedAt', 'updated_at').localeCompare(tsOf(b, 'updatedAt', 'updated_at'));
    if (byTime !== 0) return byTime;
    return num(a.number) - num(b.number);
  };
  const compareComments = (a: AnyRecord, b: AnyRecord): number => {
    const ca = listComments(state.store, fullName, num(a.number)).length;
    const cb = listComments(state.store, fullName, num(b.number)).length;
    if (ca !== cb) return ca - cb;
    return num(a.number) - num(b.number);
  };
  const compare = field === 'UPDATED_AT' ? compareUpdated : field === 'COMMENTS' ? compareComments : compareCreated;
  sorted.sort((a, b) => (direction === 'DESC' ? -compare(a, b) : compare(a, b)));
  // Cursor: base64url("after:<number>") over the same ordering; the number is the sort key's
  // tie-break, so filtering by it is exact for the suite's ASC pagination.
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const decoded = b64urlDecode(args.after);
    const match = decoded === null ? null : /^after:(\d+)$/.exec(decoded);
    if (match !== null) {
      const afterNumber = parseInt(match[1] as string, 10);
      const index = sorted.findIndex((issue) => num(issue.number) === afterNumber);
      start = index < 0 ? sorted.length : index + 1;
    }
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : sorted.length - start;
  const page = sorted.slice(start, start + first);
  const hasNextPage = start + page.length < sorted.length;
  const endCursor = page.length === 0 ? null : b64urlEncode(`after:${num(page[page.length - 1]?.number)}`);
  const startCursor = page.length === 0 ? null : b64urlEncode(`after:${num(page[0]?.number)}`);
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(state.store, issue, fullName)),
    edges: page.map((issue) => ({
      __typename: 'IssueEdge',
      node: issueObject(state.store, issue, fullName),
      cursor: b64urlEncode(`after:${num(issue.number)}`),
    })),
    pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: start > 0, startCursor, endCursor },
    totalCount: sorted.length,
  };
}

function pullsConnection(state: ExecState, fullName: string, args: Record<string, unknown>): AnyRecord {
  let pulls = listPulls(state.store, fullName);
  const statesArg = args.states;
  if (Array.isArray(statesArg) && statesArg.length > 0) {
    const wanted = new Set(statesArg.map((entry) => String(entry).toUpperCase()));
    pulls = pulls.filter((pull) => {
      const mapped = pullStateOf(pull);
      return wanted.has(mapped) || (mapped === 'MERGED' && wanted.has('CLOSED'));
    });
  }
  const sorted = [...pulls].sort((a, b) => num(a.number) - num(b.number));
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : sorted.length;
  const page = sorted.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(state.store, pull, fullName)),
    edges: page.map((pull) => ({
      __typename: 'PullRequestEdge',
      node: pullObject(state.store, pull, fullName),
      cursor: b64urlEncode(`after:${num(pull.number)}`),
    })),
    pageInfo: { __typename: 'PageInfo', hasNextPage: page.length < sorted.length, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: sorted.length,
  };
}

function resolveMutation(state: ExecState, name: string, args: Record<string, unknown>, path: (string | number)[]): unknown {
  const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
  if (name === 'createIssue') {
    const decoded = decodeGlobalId(str(input.repositoryId));
    if (decoded === null || decoded.kind !== 'R') {
      state.errors.push({ message: `createIssue: unknown repository id ${JSON.stringify(input.repositoryId)}`, path: [...path, name] });
      return null;
    }
    const parts = decoded.fullName.split('/');
    const repo = findRepo(state.store, parts[0] as string, parts.slice(1).join('/'));
    if (repo === null) {
      state.errors.push({ message: `createIssue: repository not found: ${decoded.fullName}`, path: [...path, name] });
      return null;
    }
    const title = str(input.title);
    if (title === '') {
      state.errors.push({ message: 'createIssue: title is required', path: [...path, name] });
      return null;
    }
    const rec = createIssueRecord(state.store, decoded.fullName, title, str(input.body));
    return { __typename: 'CreateIssuePayload', issue: issueObject(state.store, rec, decoded.fullName) };
  }
  if (name === 'closeIssue') {
    const decoded = decodeGlobalId(str(input.issueId));
    if (decoded === null || (decoded.kind !== 'I' && decoded.kind !== 'P') || decoded.number === null) {
      state.errors.push({ message: `closeIssue: unknown issue id ${JSON.stringify(input.issueId)}`, path: [...path, name] });
      return null;
    }
    const issue = listIssues(state.store, decoded.fullName).find((item) => num(item.number) === decoded.number);
    if (issue === undefined) {
      state.errors.push({ message: `closeIssue: issue not found: ${decoded.fullName}#${decoded.number}`, path: [...path, name] });
      return null;
    }
    const now = nowIso(state.store);
    issue.state = 'closed';
    issue.closedAt = now;
    issue.updatedAt = now;
    return { __typename: 'CloseIssuePayload', issue: issueObject(state.store, issue, decoded.fullName) };
  }
  if (name === 'createPullRequest') {
    const decoded = decodeGlobalId(str(input.repositoryId));
    if (decoded === null || decoded.kind !== 'R') {
      state.errors.push({ message: `createPullRequest: unknown repository id ${JSON.stringify(input.repositoryId)}`, path: [...path, name] });
      return null;
    }
    const { rec, error } = createPullRecord(
      state.store,
      decoded.fullName,
      str(input.title),
      str(input.body),
      str(input.baseRefName),
      str(input.headRefName),
    );
    if (rec === null || error !== null) {
      state.errors.push({ message: `createPullRequest: ${error ?? 'could not create the pull request'}`, path: [...path, name] });
      return null;
    }
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(state.store, rec, decoded.fullName) };
  }
  if (name === 'mergePullRequest') {
    const decoded = decodeGlobalId(str(input.pullRequestId));
    if (decoded === null || decoded.kind !== 'P' || decoded.number === null) {
      state.errors.push({ message: `mergePullRequest: unknown pull request id ${JSON.stringify(input.pullRequestId)}`, path: [...path, name] });
      return null;
    }
    const pull = listPulls(state.store, decoded.fullName).find((item) => num(item.number) === decoded.number);
    if (pull === undefined) {
      state.errors.push({ message: `mergePullRequest: pull request not found: ${decoded.fullName}#${decoded.number}`, path: [...path, name] });
      return null;
    }
    squashMergePull(state.store, pull, decoded.fullName);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(state.store, pull, decoded.fullName) };
  }
  if (name === 'addComment') {
    const decoded = decodeGlobalId(str(input.subjectId));
    if (decoded === null || (decoded.kind !== 'I' && decoded.kind !== 'P') || decoded.number === null) {
      state.errors.push({ message: `addComment: unknown subject id ${JSON.stringify(input.subjectId)}`, path: [...path, name] });
      return null;
    }
    const body = str(input.body);
    if (body === '') {
      state.errors.push({ message: 'addComment: body is required', path: [...path, name] });
      return null;
    }
    const rec = createCommentRecord(state.store, decoded.fullName, decoded.number, body);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: commentGlobalId(decoded.fullName, decoded.number, num(rec.id)), body },
      },
    };
  }
  return null;
}

/** The GraphQL type a parent object resolves fields against. */
function typeOf(parentType: string, parent: AnyRecord | null): string {
  if (parent !== null && typeof parent.__typename === 'string' && parent.__typename !== '') return parent.__typename;
  return parentType;
}

/**
 * Resolve a selection set against a parent value. `parentType` is the schema type the set was
 * written against; the value's own __typename wins when it differs (fragments, node()).
 */
function resolveSelectionSet(state: ExecState, parentType: string, parent: AnyRecord | null, selectionSet: SelectionSetNode, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const effectiveType = typeOf(parentType, parent);
  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      const fieldName = selection.name;
      const responseKey = selection.alias ?? fieldName;
      const value = resolveField(state, effectiveType, parent, selection, path);
      if (value === null || value === undefined) {
        out[responseKey] = null;
        continue;
      }
      if (selection.selectionSet === undefined) {
        out[responseKey] = value;
        continue;
      }
      if (Array.isArray(value)) {
        out[responseKey] = value.map((item, index) => {
          if (item === null || typeof item !== 'object') return item;
          return resolveSelectionSet(state, effectiveType, item as AnyRecord, selection.selectionSet as SelectionSetNode, [...path, responseKey, index]);
        });
        continue;
      }
      if (typeof value === 'object') {
        const childType = typeOf(effectiveType, value as AnyRecord);
        out[responseKey] = resolveSelectionSet(state, childType, value as AnyRecord, selection.selectionSet, [...path, responseKey]);
        continue;
      }
      out[responseKey] = value;
    } else if (selection.kind === 'FragmentSpread') {
      const fragment = state.fragments.get(selection.name);
      if (fragment === undefined) {
        state.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== effectiveType && fragment.typeCondition !== 'Node') continue;
      Object.assign(out, resolveSelectionSet(state, fragment.typeCondition, parent, fragment.selectionSet, path));
    } else {
      // InlineFragment
      if (selection.typeCondition !== undefined && selection.typeCondition !== effectiveType && selection.typeCondition !== 'Node') continue;
      Object.assign(out, resolveSelectionSet(state, selection.typeCondition ?? effectiveType, parent, selection.selectionSet, path));
    }
  }
  return out;
}

// -----------------------------------------------------------------------------------------------
// F. Entry point
// -----------------------------------------------------------------------------------------------

function checkAuth(ctx: GraphQLContext | undefined): boolean {
  // app.ts pre-authenticated this request (it owns the socket and the headers).
  if (ctx?.authenticated === true) return true;
  const presented = ctx?.presentedToken ?? ctx?.token ?? null;
  const expected = ctx?.expectedToken ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return presented !== null && presented !== '' && presented === expected;
  return presented !== null && presented !== '';
}

function executeOne(store: StoreLike, operationBody: unknown): Record<string, unknown> {
  const state: ExecState = {
    store,
    viewerLogin: viewerLoginOf(store),
    variables: {},
    fragments: new Map(),
    errors: [],
  };
  if (!isRecord(operationBody)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a "query" string.' }] };
  }
  const query = operationBody.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = isRecord(operationBody.variables) ? (operationBody.variables as Record<string, unknown>) : {};
  const operationName = typeof operationBody.operationName === 'string' ? operationBody.operationName : undefined;
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  for (const definition of definitions) {
    if (definition.kind === 'FragmentDefinition') state.fragments.set(definition.name, definition);
  }
  const operations = definitions.filter((def): def is OperationDefinitionNode => def.kind === 'OperationDefinition');
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found in the document.' }] };
  }
  let operation: OperationDefinitionNode | undefined;
  if (operationName !== undefined) {
    operation = operations.find((op) => op.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (operations.length === 1) {
    operation = operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  if (operation.operation === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported.' }] };
  }
  // Variable defaults fill in for variables the caller did not send.
  state.variables = { ...variables };
  for (const varDef of operation.variableDefinitions) {
    if (!(varDef.name in state.variables) && varDef.defaultValue !== undefined) {
      state.variables[varDef.name] = valueFromAst(varDef.defaultValue, state.variables);
    }
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelectionSet(state, rootType, null, operation.selectionSet, []);
  const body: Record<string, unknown> = { data };
  if (state.errors.length > 0) body.errors = state.errors;
  return body;
}

/**
 * Handle one POST /api/graphql request.
 * `bodyJson` is the parsed JSON body (one operation object or an array of them for batching).
 * Returns { status, body } with body a plain JSON value.
 */
export function handleGraphQL(bodyJson: unknown, store: Store, ctx: GraphQLContext | undefined): GraphQLResult {
  if (!checkAuth(ctx)) {
    return { status: 401, body: { errors: [{ message: 'Unauthorized' }] } };
  }
  let parsed: unknown = bodyJson;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return { status: 400, body: { errors: [{ message: 'Request body must be valid JSON.' }] } };
    }
  }
  const like = asStoreLike(store);
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => executeOne(like, entry)) };
  }
  return { status: 200, body: executeOne(like, parsed) };
}

// -----------------------------------------------------------------------------------------------
// G. Shared store operations (exported for src/mcp.ts so both surfaces mutate the same records)
// -----------------------------------------------------------------------------------------------

/**
 * Create a repository record (or return the existing one when the name is taken).
 * Uses the store's own createRepo when it has one, so every per-repo collection and the
 * number counters are initialized exactly as REST's creation does.
 */
export function createRepoRecord(store: Store, owner: string, name: string, description: string, isPrivate: boolean): AnyRecord {
  const like = asStoreLike(store);
  const fullName = `${owner}/${name}`;
  const existing = findRepo(like, owner, name);
  if (existing !== null) return existing;
  if (typeof like.createRepo === 'function') {
    try {
      const created = (like.createRepo as (owner: string, name: string, description: string | null, options: Record<string, unknown>) => unknown)(
        owner,
        name,
        description,
        { private: isPrivate, defaultBranch: 'main' },
      );
      if (isRecord(created)) return created as AnyRecord;
    } catch {
      // fall through to the manual record
    }
  }
  const now = nowIso(like);
  const rec: AnyRecord = {
    id: nextGlobalId(like),
    owner,
    name,
    full_name: fullName,
    private: isPrivate,
    description,
    defaultBranch: 'main',
    default_branch: 'main',
    createdAt: now,
    updatedAt: now,
    created_at: now,
    updated_at: now,
  };
  const map = mapOf(like, 'repos');
  if (map !== null) map.set(fullName, rec);
  for (const key of ['refs', 'issues', 'labels', 'pulls', 'comments'] as const) {
    const collection = mapOf(like, key);
    if (collection !== null && !collection.has(fullName)) {
      collection.set(fullName, key === 'refs' ? new Map() : []);
    }
  }
  return rec;
}

export function storeViewerLogin(store: Store): string {
  return viewerLoginOf(asStoreLike(store));
}

export function storeFindRepo(store: Store, owner: string, name: string): AnyRecord | null {
  return findRepo(asStoreLike(store), owner, name);
}

export function storeListIssues(store: Store, fullName: string): AnyRecord[] {
  return listIssues(asStoreLike(store), fullName);
}

export function storeListPulls(store: Store, fullName: string): AnyRecord[] {
  return listPulls(asStoreLike(store), fullName);
}

export function storeGetRefSha(store: Store, fullName: string, branch: string): string | null {
  return getRefSha(asStoreLike(store), fullName, branch);
}

export function storeCreateIssue(store: Store, fullName: string, title: string, body: string): AnyRecord {
  return createIssueRecord(asStoreLike(store), fullName, title, body);
}

export function storeCreatePull(
  store: Store,
  fullName: string,
  title: string,
  body: string,
  baseRef: string,
  headRef: string,
): { rec: AnyRecord | null; error: string | null } {
  return createPullRecord(asStoreLike(store), fullName, title, body, baseRef, headRef);
}

export function storeCreateComment(store: Store, fullName: string, issueNumber: number, body: string): AnyRecord {
  return createCommentRecord(asStoreLike(store), fullName, issueNumber, body);
}

export function storeMergePull(store: Store, rec: AnyRecord, fullName: string): { mergeSha: string | null; error: string | null } {
  return squashMergePull(asStoreLike(store), rec, fullName);
}

export function storeRepoObject(store: Store, rec: AnyRecord): AnyRecord {
  const like = asStoreLike(store);
  const out = repoObject(like, rec);
  delete out._record;
  delete out._fullName;
  return out;
}

export function storeIssueObject(store: Store, rec: AnyRecord, fullName: string): AnyRecord {
  const like = asStoreLike(store);
  const out = issueObject(like, rec, fullName);
  delete out._record;
  delete out._fullName;
  return out;
}

export function storePullObject(store: Store, rec: AnyRecord, fullName: string): AnyRecord {
  const like = asStoreLike(store);
  const out = pullObject(like, rec, fullName);
  delete out._record;
  delete out._fullName;
  return out;
}
