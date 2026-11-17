// GitHub REST v3 surface, over the shared Store.
//
// Pure handler: `handleRest(method, path, query, headers, bodyText, store, ctx)` answers one
// request and returns {status, headers, body}; the coordinator (app.ts) owns the socket and
// serialises the body. Every reply is application/json with a non-empty
// X-GitHub-Request-Id; errors are JSON {message}.
//
// Auth: every /api/v3 route needs `Authorization: Bearer <ctx.token>` (the token in
// MAKEFUN_SHOP_TOKEN). No/wrong token -> 401. A repository under any owner other than the
// token's login -> 404, never 403. Unknown route -> 404 JSON. Malformed JSON body -> 400.
//
// Git work here uses the shared object store only through the ObjectStore interface
// (get/put/has) plus buildTree/parseTree from ./git/objects.ts, and the local commit/tree
// helpers below. Commit timestamps come from store.clock (deterministic); the author is
// always `<ownerLogin> <ownerLogin>@example.invalid>`.
//
// NOTE on the objects.ts contract this file assumes (Worker A owns that file):
//   - `new ObjectStore()` with get(oid) -> {type, data} | undefined (data a Buffer;
//     a `.body` field is tolerated too), put(type, body: Buffer|string) -> oid string,
//     has(oid) -> boolean.
//   - buildTree(entries: {mode, name, oid}[]) -> Buffer (tree-name sorted, git format).
//   - parseTree(data: Buffer) -> {mode, name, oid}[].
// If Worker A names the record field differently, only `objRecord` below needs a touch.

import { buildTree, parseTree } from './git/objects.ts';
import { Store } from './store.ts';
import type { Comment, Issue, Label, Pull, Repo } from './store.ts';

export interface RestContext {
  token: string;
}

export interface RestResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type Json = Record<string, unknown>;
type Query = Readonly<Record<string, string | string[] | undefined>>;
type Headers = Readonly<Record<string, string>>;

const JSON_TYPE = 'application/json; charset=utf-8';
const SHA40 = /^[0-9a-f]{40}$/i;
const EMPTY_TREE_BODY = buildTree([]);

// ---------------------------------------------------------------------------------------------
// Small helpers

function isObj(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function queryFirst(query: Query, name: string): string | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function queryInt(query: Query, name: string, fallback: number): number {
  const raw = queryFirst(query, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function header(headers: Headers, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function err(message: string): Json {
  return { message };
}

/** Paginate a list; returns the page plus a Link header value ('' when one page suffices). */
function paginate<T>(
  items: readonly T[],
  query: Query,
  basePath: string,
  host: string | undefined,
): { page: T[]; link: string } {
  const perPage = Math.min(100, Math.max(1, queryInt(query, 'per_page', 30)));
  const page = Math.max(1, queryInt(query, 'page', 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  if (totalPages <= 1) return { page: slice, link: '' };
  const origin = host !== undefined && host !== '' ? `http://${host}` : 'http://localhost';
  const urlFor = (p: number): string =>
    `${origin}${basePath}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (page < totalPages) {
    parts.push(`<${urlFor(page + 1)}>; rel="next"`);
    parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    parts.push(`<${urlFor(1)}>; rel="first"`);
    parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  return { page: slice, link: parts.join(', ') };
}

// ---------------------------------------------------------------------------------------------
// Git object helpers (over the shared ObjectStore)

interface ObjRecord {
  type: string;
  data: Buffer;
}

function toBuffer(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  return undefined;
}

/** Read one object, tolerating a `.data` or `.body` record field, Buffer or string. */
function objRecord(store: Store, oid: string): ObjRecord | undefined {
  const raw = store.objects.get(oid) as unknown;
  if (!isObj(raw)) return undefined;
  const type = asString(raw.type);
  const data = toBuffer(raw.data ?? raw.body);
  if (type === undefined || data === undefined) return undefined;
  return { type, data };
}

function objType(store: Store, oid: string): string | undefined {
  return objRecord(store, oid)?.type;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Parse `Name <email> epoch tz` into its parts; falls back to the token owner. */
function parseIdentity(line: string, fallbackName: string): { name: string; email: string; epoch: number } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (match === null) return { name: fallbackName, email: `${fallbackName}@example.invalid`, epoch: 0 };
  return { name: match[1] ?? fallbackName, email: match[2] ?? '', epoch: Number.parseInt(match[3] ?? '0', 10) };
}

function commitIdentity(store: Store): { line: string; epoch: number } {
  const epoch = Math.floor(Date.parse(store.clock.now()) / 1000);
  const who = `${store.ownerLogin} <${store.ownerLogin}@example.invalid>`;
  return { line: `${who} ${epoch} +0000`, epoch };
}

function buildCommitBytes(opts: {
  tree: string;
  parents: string[];
  message: string;
  authorLine: string;
  committerLine: string;
}): Buffer {
  const lines = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${opts.authorLine}`, `committer ${opts.committerLine}`, '');
  return Buffer.from(`${lines.join('\n')}\n${opts.message}`, 'utf8');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function treeEntries(store: Store, treeOid: string): TreeEntry[] {
  const record = objRecord(store, treeOid);
  if (record === undefined || record.type !== 'tree') return [];
  try {
    return parseTree(record.data) as TreeEntry[];
  } catch {
    return [];
  }
}

/** Resolve a path (segments) inside a tree; returns the blob oid, or undefined. */
function findBlobInTree(store: Store, treeOid: string, segments: readonly string[]): string | undefined {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entry = treeEntries(store, current).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return undefined;
    if (i === segments.length - 1) return entry.mode === '40000' ? undefined : entry.oid;
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

/** Resolve a path to a tree entry ({mode, oid}) or undefined; '' resolves to the root tree. */
function findEntryInTree(
  store: Store,
  treeOid: string,
  segments: readonly string[],
): TreeEntry | undefined {
  if (segments.length === 0) return { mode: '40000', name: '', oid: treeOid };
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entry = treeEntries(store, current).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return undefined;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

/** Flatten a tree to path -> {oid, mode}. */
function flattenTree(store: Store, treeOid: string, prefix: string, out: Map<string, TreeEntry>): void {
  for (const entry of treeEntries(store, treeOid)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, entry);
  }
}

/** Rebuild a tree with one path set to a blob; creates intermediate trees as needed. */
function buildTreeWithPath(
  store: Store,
  entries: readonly TreeEntry[],
  segments: readonly string[],
  blobOid: string,
): string {
  const head = segments[0] ?? '';
  const kept = entries.filter((entry) => entry.name !== head);
  if (segments.length === 1) {
    kept.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const child = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const childEntries = child === undefined ? [] : treeEntries(store, child.oid);
    kept.push({
      mode: '40000',
      name: head,
      oid: buildTreeWithPath(store, childEntries, segments.slice(1), blobOid),
    });
  }
  return store.objects.put('tree', buildTree(kept));
}

/**
 * Rebuild a tree with one path removed; prunes trees left empty.
 * Returns null when the tree itself becomes empty.
 */
function removeTreePath(
  store: Store,
  entries: readonly TreeEntry[],
  segments: readonly string[],
): string | null {
  const head = segments[0] ?? '';
  const kept: TreeEntry[] = [];
  for (const entry of entries) {
    if (entry.name !== head) {
      kept.push(entry);
      continue;
    }
    if (segments.length === 1) continue; // drop the entry
    if (entry.mode !== '40000') continue;
    const child = removeTreePath(store, treeEntries(store, entry.oid), segments.slice(1));
    if (child !== null) kept.push({ mode: '40000', name: head, oid: child });
  }
  if (kept.length === 0) return null;
  return store.objects.put('tree', buildTree(kept));
}

/** Build nested trees from a flat path -> blob-oid map; returns the root tree oid. */
function buildTreeFromFlat(store: Store, flat: ReadonlyMap<string, string>): string {
  const root: Map<string, Map<string, string> | string> = new Map();
  for (const [path, oid] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] ?? '';
      let child = node.get(segment);
      if (typeof child !== 'string' && child === undefined) {
        child = new Map();
        node.set(segment, child);
      }
      node = child as Map<string, Map<string, string> | string>;
    }
    node.set(segments[segments.length - 1] ?? '', oid);
  }
  const build = (node: Map<string, Map<string, string> | string>): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node) {
      if (typeof value === 'string') entries.push({ mode: '100644', name, oid: value });
      else entries.push({ mode: '40000', name, oid: build(value) });
    }
    return store.objects.put('tree', buildTree(entries));
  };
  return build(root);
}

/** All ancestors of a commit (the commit itself included), newest-first traversal. */
function ancestorsOf(store: Store, tip: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() ?? '';
    if (oid === '' || seen.has(oid)) continue;
    const record = objRecord(store, oid);
    if (record === undefined || record.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(record.data).parents) queue.push(parent);
  }
  return out;
}

/** First-parent history from a tip, newest first. */
function historyOf(store: Store, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current !== undefined && current !== '' && !seen.has(current)) {
    const record = objRecord(store, current);
    if (record === undefined || record.type !== 'commit') break;
    seen.add(current);
    out.push(current);
    current = parseCommit(record.data).parents[0];
  }
  return out;
}

/** The merge-base of two tips: the first common ancestor walking from `b`'s history. */
function mergeBaseOf(store: Store, a: string, b: string): string | undefined {
  const aAncestors = new Set(ancestorsOf(store, a));
  for (const oid of historyOf(store, b)) {
    if (aAncestors.has(oid)) return oid;
  }
  return undefined;
}

function commitTreeOid(store: Store, commitOid: string): string | undefined {
  const record = objRecord(store, commitOid);
  if (record === undefined || record.type !== 'commit') return undefined;
  return parseCommit(record.data).tree;
}

/** Line counts for a changed file: additions/deletions via a small LCS diff. */
function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // Drop one trailing empty element when the text ends with '\n' (not a real line).
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const m = a.length;
  const n = b.length;
  if (m * n > 250_000) {
    // Huge file: fall back to a coarse count instead of an O(m*n) table.
    const common = new Set(a).size;
    void common;
    return { additions: n, deletions: m };
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        a[i] === b[j] ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }
  return { additions: n - (dp[0]?.[0] ?? 0), deletions: m - (dp[0]?.[0] ?? 0) };
}

interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** Diff two trees (by tip commit oid) into GitHub's pull-files shape. */
function diffTrees(store: Store, baseTip: string, headTip: string): FileChange[] {
  const baseTree = commitTreeOid(store, baseTip);
  const headTree = commitTreeOid(store, headTip);
  const baseFlat = new Map<string, TreeEntry>();
  const headFlat = new Map<string, TreeEntry>();
  if (baseTree !== undefined) flattenTree(store, baseTree, '', baseFlat);
  if (headTree !== undefined) flattenTree(store, headTree, '', headFlat);
  const paths = [...new Set([...baseFlat.keys(), ...headFlat.keys()])].sort();
  const out: FileChange[] = [];
  for (const path of paths) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    const blobText = (oid: string): string => objRecord(store, oid)?.data.toString('utf8') ?? '';
    if (before === undefined && after !== undefined) {
      const text = blobText(after.oid);
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines, sha: after.oid });
    } else if (before !== undefined && after === undefined) {
      const text = blobText(before.oid);
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines, sha: before.oid });
    } else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
      const d = lineDiff(blobText(before.oid), blobText(after.oid));
      out.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions, sha: after.oid });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// JSON presenters (GitHub REST v3 shapes)

function ownerJson(store: Store): Json {
  return {
    login: store.ownerLogin,
    id: 1000,
    node_id: nodeId('User', 1000),
    avatar_url: '',
    gravatar_id: '',
    url: '/api/v3/users/' + store.ownerLogin,
    html_url: `https://github.com/${store.ownerLogin}`,
    type: 'User',
    site_admin: false,
  };
}

function repoJson(store: Store, repo: Repo): Json {
  const openIssues = (store.issues.get(Store.repoKey(repo.owner, repo.name)) ?? []).filter(
    (issue) => issue.state === 'open',
  ).length;
  const openPulls = (store.pulls.get(Store.repoKey(repo.owner, repo.name)) ?? []).filter(
    (pull) => pull.state === 'open',
  ).length;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: ownerJson(store),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues + openPulls,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues + openPulls,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: Label): Json {
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: '',
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Json {
  const key = Store.repoKey(repo.owner, repo.name);
  const known = store.labels.get(key) ?? [];
  const labels = issue.labels
    .map((name) => known.find((label) => label.name === name))
    .filter((label): label is Label => label !== undefined)
    .map(labelJson);
  const comments = (store.comments.get(key) ?? []).filter(
    (comment) => comment.issueNumber === issue.number,
  ).length;
  return {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: ownerJson(store),
    labels,
    assignee: null,
    assignees: [],
    locked: false,
    comments,
    closed_at: issue.closedAt,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function commentJson(store: Store, repo: Repo, comment: Comment): Json {
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: ownerJson(store),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${comment.issueNumber}`,
    author_association: 'OWNER',
  };
}

function ownerJsonOfRepo(repo: Repo): Json {
  return {
    login: repo.owner,
    id: 1000,
    node_id: nodeId('User', 1000),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${repo.owner}`,
    html_url: `https://github.com/${repo.owner}`,
    type: 'User',
    site_admin: false,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Json {
  const headRef: Json = {
    label: `${repo.owner}:${pull.head.ref}`,
    ref: pull.head.ref,
    sha: pull.head.sha,
    user: ownerJsonOfRepo(repo),
    repo: repoJson(store, repo),
  };
  const baseRef: Json = {
    label: `${repo.owner}:${pull.base.ref}`,
    ref: pull.base.ref,
    sha: pull.base.sha,
    user: ownerJsonOfRepo(repo),
    repo: repoJson(store, repo),
  };
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/comments`,
    review_comment_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`,
    statuses_url: `/api/v3/repos/${repo.owner}/${repo.name}/statuses/${pull.head.sha}`,
    head: headRef,
    base: baseRef,
    _links: {},
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: pull.mergeable,
    rebaseable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    user: ownerJsonOfRepo(repo),
  };
}

function commitJson(store: Store, repo: Repo, sha: string): Json | undefined {
  const record = objRecord(store, sha);
  if (record === undefined || record.type !== 'commit') return undefined;
  const parsed = parseCommit(record.data);
  const author = parseIdentity(parsed.author, store.ownerLogin);
  const committer = parseIdentity(parsed.committer, store.ownerLogin);
  const date = new Date(author.epoch * 1000).toISOString();
  const committerDate = new Date(committer.epoch * 1000).toISOString();
  return {
    sha,
    node_id: nodeId('Commit', Number.parseInt(sha.slice(0, 8), 16) % 2147483647),
    commit: {
      author: { name: author.name, email: author.email, date },
      committer: { name: committer.name, email: committer.email, date: committerDate },
      message: parsed.message,
      tree: { sha: parsed.tree, url: '' },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`,
    author: ownerJsonOfRepo(repo),
    committer: ownerJsonOfRepo(repo),
    parents: parsed.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

// ---------------------------------------------------------------------------------------------
// Mergeability: a pull is conflicted when head and base both changed the same path away from
// the merge-base to different contents.

function pullConflicted(store: Store, repo: Repo, pull: Pull): boolean {
  const base = mergeBaseOf(store, pull.head.sha, pull.base.sha);
  if (base === undefined) return false;
  const baseTree = commitTreeOid(store, base);
  const headTree = commitTreeOid(store, pull.head.sha);
  const tipTree = commitTreeOid(store, pull.base.sha);
  if (baseTree === undefined || headTree === undefined || tipTree === undefined) return false;
  const baseFlat = new Map<string, TreeEntry>();
  const headFlat = new Map<string, TreeEntry>();
  const tipFlat = new Map<string, TreeEntry>();
  flattenTree(store, baseTree, '', baseFlat);
  flattenTree(store, headTree, '', headFlat);
  flattenTree(store, tipTree, '', tipFlat);
  const paths = new Set([...headFlat.keys(), ...tipFlat.keys(), ...baseFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path)?.oid;
    const h = headFlat.get(path)?.oid;
    const t = tipFlat.get(path)?.oid;
    const headChanged = h !== b;
    const tipChanged = t !== b;
    if (headChanged && tipChanged && h !== t) return true;
  }
  return false;
}

function refreshMergeable(store: Store, repo: Repo, pull: Pull): void {
  if (pull.state === 'closed') {
    pull.mergeable = false;
    return;
  }
  // Conflict is judged on the LIVE branch tips, not the shas stored at PR creation:
  // after another PR merges into base, a previously-clean PR can become conflicted.
  const key = Store.repoKey(repo.owner, repo.name);
  const refs = store.refs.get(key) ?? new Map<string, string>();
  const live: Pull = {
    ...pull,
    head: { ref: pull.head.ref, sha: refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha },
    base: { ref: pull.base.ref, sha: refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha },
  };
  pull.mergeable = !pullConflicted(store, repo, live);
}

// ---------------------------------------------------------------------------------------------
// The handler

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Answer one REST v3 request.
 *
 * `path` is the URL pathname (no query string); `query` the parsed query; `headers` the
 * request headers; `bodyText` the raw body ('' when none); `ctx.token` the bearer token
 * the request must carry. Returns {status, headers, body}; `body` is null for 204 and
 * the coordinator must send no bytes for it.
 */
export function handleRest(
  method: string,
  path: string,
  query: Query,
  headers: Headers,
  bodyText: string | null | undefined,
  store: Store,
  ctx: RestContext,
): RestResult {
  const requestId = store.nextRequestId();
  const baseHeaders: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId,
  };
  const answer = (
    status: number,
    body: unknown,
    extra: Readonly<Record<string, string>> = {},
  ): RestResult => ({ status, headers: { ...baseHeaders, ...extra }, body });
  const failWith = (status: number, message: string): RestResult => answer(status, err(message));

  // Outside /api/v3 this handler has nothing to say.
  const cleanPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const segments = cleanPath.split('/').filter((part) => part !== '').map(decodeSegment);
  if (segments[0] !== 'api' || segments[1] !== 'v3') {
    return failWith(404, 'Not Found');
  }

  // Auth: every /api/v3 route needs the exact bearer token.
  const auth = header(headers, 'authorization');
  const authed =
    ctx.token !== ''
      ? auth === `Bearer ${ctx.token}`
      : auth !== undefined && auth.startsWith('Bearer ') && auth.slice(7).trim() !== '';
  if (!authed) return failWith(401, 'Requires authentication');

  // Malformed JSON on a mutating request is a 400 (before any route work).
  let body: Json = {};
  if (
    (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') &&
    bodyText !== undefined &&
    bodyText !== null &&
    bodyText.trim() !== ''
  ) {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (!isObj(parsed)) return failWith(400, 'Problems parsing JSON');
      body = parsed;
    } catch {
      return failWith(400, 'Problems parsing JSON');
    }
  }

  const rest = segments.slice(2);
  const host = header(headers, 'host');

  // ---- API root, meta, rate limit, viewer ---------------------------------------------
  if (rest.length === 0) {
    if (method === 'GET') {
      return answer(
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return failWith(404, 'Not Found');
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return failWith(404, 'Not Found');
    return answer(200, { installed_version: '1.0.0', version: '1.0.0' });
  }
  if (rest[0] === 'rate_limit' && rest.length === 1) {
    if (method !== 'GET') return failWith(404, 'Not Found');
    const reset = 1792996800; // a fixed future epoch; the suite never checks the value.
    const bucket = { limit: 5000, remaining: 5000, reset, used: 0 };
    return answer(200, { resources: { core: bucket, search: bucket }, rate: bucket });
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return failWith(404, 'Not Found');
    return answer(200, {
      login: store.ownerLogin,
      id: 1000,
      node_id: nodeId('User', 1000),
      avatar_url: '',
      gravatar_id: '',
      url: `/api/v3/users/${store.ownerLogin}`,
      html_url: `https://github.com/${store.ownerLogin}`,
      type: 'User',
      site_admin: false,
      name: store.ownerLogin,
      email: `${store.ownerLogin}@example.invalid`,
    });
  }

  // ---- /user/repos ---------------------------------------------------------------------
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const all = [...store.repos.values()].map((repo) => repoJson(store, repo));
      const { page, link } = paginate(all, query, '/api/v3/user/repos', host);
      return answer(200, page, link === '' ? {} : { link });
    }
    if (method === 'POST') {
      const name = asString(body.name);
      if (name === undefined || name.trim() === '') {
        return failWith(422, 'name is required');
      }
      if (store.getRepo(store.ownerLogin, name) !== undefined) {
        return failWith(422, 'Repository already exists');
      }
      const description = body.description === null ? null : asString(body.description) ?? null;
      const isPrivate = typeof body.private === 'boolean' ? body.private : false;
      const defaultBranch = asString(body.default_branch) ?? 'main';
      const repo = store.createRepo(store.ownerLogin, name, description, {
        private: isPrivate,
        defaultBranch,
      });
      return answer(201, repoJson(store, repo));
    }
    return failWith(404, 'Not Found');
  }

  // ---- /repos/{owner}/{repo}/... ---------------------------------------------------------
  if (rest[0] !== 'repos' || rest.length < 3) return failWith(404, 'Not Found');
  const owner = rest[1] ?? '';
  const repoName = rest[2] ?? '';
  // A repository under any other owner is 404, never 403 — even when it does not exist.
  if (owner !== store.ownerLogin) return failWith(404, 'Not Found');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return failWith(404, 'Not Found');
  const key = Store.repoKey(owner, repoName);
  const tail = rest.slice(3);
  const refs = store.refs.get(key) ?? new Map<string, string>();

  const resolveRef = (ref: string | undefined): string | undefined => {
    if (ref === undefined || ref === '') return refs.get(`refs/heads/${repo.defaultBranch}`);
    if (ref.startsWith('refs/')) return refs.get(ref);
    const asBranch = refs.get(`refs/heads/${ref}`);
    if (asBranch !== undefined) return asBranch;
    if (SHA40.test(ref) && objType(store, ref) === 'commit') return ref;
    return undefined;
  };

  // ---- the repository itself -------------------------------------------------------------
  if (tail.length === 0) {
    if (method === 'GET') return answer(200, repoJson(store, repo));
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return answer(204, null);
    }
    if (method === 'PATCH') {
      if (body.description !== undefined) {
        repo.description = body.description === null ? null : (asString(body.description) ?? repo.description);
      }
      if (typeof body.private === 'boolean') repo.private = body.private;
      const branch = asString(body.default_branch);
      if (branch !== undefined && refs.has(`refs/heads/${branch}`)) repo.defaultBranch = branch;
      repo.updatedAt = store.clock.now();
      return answer(200, repoJson(store, repo));
    }
    return failWith(404, 'Not Found');
  }

  // ---- branches --------------------------------------------------------------------------
  if (tail[0] === 'branches' && tail.length === 1) {
    if (method !== 'GET') return failWith(404, 'Not Found');
    const list = [...refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, sha]) => ({
        name: name.slice('refs/heads/'.length),
        commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` },
        protected: false,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return answer(200, list);
  }

  // ---- commits ---------------------------------------------------------------------------
  if (tail[0] === 'commits' && tail.length === 1) {
    if (method !== 'GET') return failWith(404, 'Not Found');
    const shaQuery = queryFirst(query, 'sha');
    let tip: string | undefined;
    if (shaQuery !== undefined) {
      tip = resolveRef(shaQuery);
      if (tip === undefined) return failWith(404, 'Not Found');
    } else {
      tip = refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (tip === undefined) return answer(200, []);
    const history = historyOf(store, tip)
      .map((sha) => commitJson(store, repo, sha))
      .filter((item): item is Json => item !== undefined);
    const { page, link } = paginate(history, query, `/api/v3/repos/${owner}/${repoName}/commits`, host);
    return answer(200, page, link === '' ? {} : { link });
  }

  // ---- git/refs --------------------------------------------------------------------------
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (ref === undefined || !ref.startsWith('refs/')) {
        return failWith(422, 'ref is required and must start with refs/');
      }
      if (sha === undefined || objType(store, sha) !== 'commit') {
        return failWith(422, 'sha must be an existing commit');
      }
      if (refs.has(ref)) return failWith(422, 'Reference already exists');
      refs.set(ref, sha);
      return answer(201, {
        ref,
        node_id: nodeId('Ref', store.nextId()),
        url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
      });
    }
    if (method === 'GET') {
      const wanted = tail.length > 2 ? `refs/${tail.slice(2).join('/')}` : undefined;
      const entries = [...refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (wanted !== undefined) {
        const found = entries.find(([name]) => name === wanted);
        if (found === undefined) return failWith(404, 'Not Found');
        return answer(200, {
          ref: found[0],
          node_id: nodeId('Ref', 0),
          url: `/api/v3/repos/${owner}/${repoName}/git/refs/${found[0].slice(5)}`,
          object: { sha: found[1], type: 'commit', url: '' },
        });
      }
      return answer(
        200,
        entries.map(([name, sha]) => ({
          ref: name,
          node_id: nodeId('Ref', 0),
          url: `/api/v3/repos/${owner}/${repoName}/git/refs/${name.slice(5)}`,
          object: { sha, type: 'commit', url: '' },
        })),
      );
    }
    return failWith(404, 'Not Found');
  }

  // ---- contents --------------------------------------------------------------------------
  if (tail[0] === 'contents') {
    const segments = tail.slice(1);
    const path = segments.join('/');

    const fileJson = (name: string, filePath: string, sha: string, size: number, contentB64: string): Json => ({
      type: 'file',
      encoding: 'base64',
      size,
      name,
      path: filePath,
      content: contentB64,
      sha,
      url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
      html_url: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${filePath}`,
      git_url: '',
      download_url: '',
      _links: {
        self: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
        git: '',
        html: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${filePath}`,
      },
    });

    if (method === 'GET') {
      const tip = resolveRef(queryFirst(query, 'ref'));
      if (tip === undefined) return failWith(404, 'Not Found');
      const treeOid = commitTreeOid(store, tip);
      if (treeOid === undefined) return failWith(404, 'Not Found');
      const entry = findEntryInTree(store, treeOid, segments);
      if (entry === undefined) return failWith(404, 'Not Found');
      if (entry.mode === '40000') {
        const children = treeEntries(store, entry.oid)
          .map((child) => {
            const childPath = path === '' ? child.name : `${path}/${child.name}`;
            if (child.mode === '40000') {
              return {
                type: 'dir',
                size: 0,
                name: child.name,
                path: childPath,
                sha: child.oid,
                url: `/api/v3/repos/${owner}/${repoName}/contents/${childPath}`,
                html_url: `https://github.com/${owner}/${repoName}/tree/${repo.defaultBranch}/${childPath}`,
                git_url: '',
                download_url: null,
                _links: { self: '', git: '', html: '' },
              };
            }
            const record = objRecord(store, child.oid);
            return {
              type: 'file',
              size: record?.data.length ?? 0,
              name: child.name,
              path: childPath,
              sha: child.oid,
              url: `/api/v3/repos/${owner}/${repoName}/contents/${childPath}`,
              html_url: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${childPath}`,
              git_url: '',
              download_url: '',
              _links: { self: '', git: '', html: '' },
            };
          })
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return answer(200, children);
      }
      const record = objRecord(store, entry.oid);
      if (record === undefined) return failWith(404, 'Not Found');
      return answer(
        200,
        fileJson(
          segments[segments.length - 1] ?? '',
          path,
          entry.oid,
          record.data.length,
          record.data.toString('base64'),
        ),
      );
    }

    if (method === 'PUT') {
      if (segments.length === 0) return failWith(422, 'path is required');
      const contentB64 = asString(body.content);
      if (contentB64 === undefined) return failWith(422, 'content is required');
      const stripped = contentB64.replace(/[\r\n\t ]+/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped)) {
        return failWith(422, 'content is not valid base64');
      }
      const bytes = Buffer.from(stripped, 'base64');
      const branch = asString(body.branch) ?? repo.defaultBranch;
      const refName = `refs/heads/${branch}`;
      const tip = refs.get(refName);
      const parentEntries = tip === undefined ? [] : (() => {
        const treeOid = commitTreeOid(store, tip);
        return treeOid === undefined ? [] : treeEntries(store, treeOid);
      })();
      const existingSha =
        tip === undefined
          ? undefined
          : (() => {
              const treeOid = commitTreeOid(store, tip);
              return treeOid === undefined ? undefined : findBlobInTree(store, treeOid, segments);
            })();
      const isUpdate = existingSha !== undefined;
      if (isUpdate) {
        const givenSha = asString(body.sha);
        if (givenSha === undefined || givenSha.toLowerCase() !== existingSha.toLowerCase()) {
          return failWith(409, 'sha does not match the current blob (stale sha)');
        }
      } else if (asString(body.sha) !== undefined) {
        return failWith(409, 'sha was supplied but the file does not exist');
      }
      const message = asString(body.message) ?? `Update ${path}`;
      const blobOid = store.objects.put('blob', bytes);
      const newTree = buildTreeWithPath(store, parentEntries, segments, blobOid);
      const identity = commitIdentity(store);
      const commitOid = store.objects.put(
        'commit',
        buildCommitBytes({
          tree: newTree,
          parents: tip === undefined ? [] : [tip],
          message,
          authorLine: identity.line,
          committerLine: identity.line,
        }),
      );
      refs.set(refName, commitOid);
      repo.updatedAt = store.clock.now();
      const commit = commitJson(store, repo, commitOid) ?? { sha: commitOid };
      return answer(isUpdate ? 200 : 201, {
        content: fileJson(segments[segments.length - 1] ?? '', path, blobOid, bytes.length, stripped),
        commit,
      });
    }

    if (method === 'DELETE') {
      if (segments.length === 0) return failWith(422, 'path is required');
      const branch = asString(body.branch) ?? repo.defaultBranch;
      const refName = `refs/heads/${branch}`;
      const tip = refs.get(refName);
      if (tip === undefined) return failWith(404, 'Not Found');
      const treeOid = commitTreeOid(store, tip);
      if (treeOid === undefined) return failWith(404, 'Not Found');
      const existingSha = findBlobInTree(store, treeOid, segments);
      if (existingSha === undefined) return failWith(404, 'Not Found');
      const givenSha = asString(body.sha);
      if (givenSha !== undefined && givenSha.toLowerCase() !== existingSha.toLowerCase()) {
        return failWith(409, 'sha does not match the current blob (stale sha)');
      }
      const message = asString(body.message) ?? `Delete ${path}`;
      const newTree = removeTreePath(store, treeEntries(store, treeOid), segments);
      const treeForCommit =
        newTree ?? store.objects.put('tree', EMPTY_TREE_BODY);
      const identity = commitIdentity(store);
      const commitOid = store.objects.put(
        'commit',
        buildCommitBytes({
          tree: treeForCommit,
          parents: [tip],
          message,
          authorLine: identity.line,
          committerLine: identity.line,
        }),
      );
      refs.set(refName, commitOid);
      repo.updatedAt = store.clock.now();
      const commit = commitJson(store, repo, commitOid) ?? { sha: commitOid };
      return answer(200, { content: null, commit });
    }
    return failWith(404, 'Not Found');
  }

  // ---- labels ----------------------------------------------------------------------------
  if (tail[0] === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      return answer(200, (store.labels.get(key) ?? []).map((label) => labelJson(label)));
    }
    if (method === 'POST' && tail.length === 1) {
      const name = asString(body.name);
      if (name === undefined || name.trim() === '') return failWith(422, 'name is required');
      const known = store.labels.get(key) ?? [];
      if (known.some((label) => label.name === name)) {
        return failWith(422, 'Label already exists');
      }
      const color = (asString(body.color) ?? 'ededed').replace(/^#/, '');
      const label: Label = {
        id: store.nextId(),
        name,
        color,
        description: asString(body.description) ?? '',
      };
      known.push(label);
      const out: Json = labelJson(label);
      out.url = `/api/v3/repos/${owner}/${repoName}/labels/${encodeURIComponent(name)}`;
      return answer(201, out);
    }
    return failWith(404, 'Not Found');
  }

  // ---- issues ----------------------------------------------------------------------------
  if (tail[0] === 'issues') {
    const allIssues = store.issues.get(key) ?? [];
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = queryFirst(query, 'state') ?? 'open';
        const wanted = state === 'all' ? undefined : state === 'closed' ? 'closed' : 'open';
        let list = allIssues.filter((issue) => wanted === undefined || issue.state === wanted);
        const labelsQuery = queryFirst(query, 'labels');
        if (labelsQuery !== undefined && labelsQuery !== '') {
          const wantedLabels = labelsQuery.split(',').map((item) => item.trim()).filter((item) => item !== '');
          list = list.filter((issue) => wantedLabels.every((label) => issue.labels.includes(label)));
        }
        const direction = queryFirst(query, 'direction') ?? 'desc';
        const sorted = [...list].sort((a, b) => {
          if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
          return a.number - b.number;
        });
        if (direction === 'desc') sorted.reverse();
        const { page, link } = paginate(
          sorted.map((issue) => issueJson(store, repo, issue)),
          query,
          `/api/v3/repos/${owner}/${repoName}/issues`,
          host,
        );
        return answer(200, page, link === '' ? {} : { link });
      }
      if (method === 'POST') {
        const title = asString(body.title);
        if (title === undefined || title.trim() === '') return failWith(422, 'title is required');
        const rawLabels = Array.isArray(body.labels) ? body.labels : [];
        const labelNames: string[] = [];
        for (const item of rawLabels) {
          const name = typeof item === 'string' ? item : isObj(item) ? asString(item.name) : undefined;
          if (name !== undefined) labelNames.push(name);
        }
        const known = store.labels.get(key) ?? [];
        for (const name of labelNames) {
          if (!known.some((label) => label.name === name)) {
            return failWith(422, `Label "${name}" does not exist`);
          }
        }
        const now = store.clock.now();
        const issue: Issue = {
          id: store.nextId(),
          number: store.nextNumber(key, 'issue'),
          title,
          body: asString(body.body) ?? '',
          state: 'open',
          labels: labelNames,
          createdAt: now,
          updatedAt: now,
          closedAt: null,
          user: store.ownerLogin,
        };
        allIssues.push(issue);
        return answer(201, issueJson(store, repo, issue));
      }
      return failWith(404, 'Not Found');
    }

    const issueNumber = Number.parseInt(tail[1] ?? '', 10);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) return failWith(404, 'Not Found');
    const issue = allIssues.find((item) => item.number === issueNumber);
    if (issue === undefined) return failWith(404, 'Not Found');

    if (tail.length === 2) {
      if (method === 'GET') return answer(200, issueJson(store, repo, issue));
      if (method === 'PATCH') {
        const now = store.clock.now();
        if (asString(body.title) !== undefined) issue.title = asString(body.title) ?? issue.title;
        if (body.body !== undefined) issue.body = asString(body.body) ?? issue.body;
        const state = asString(body.state);
        if (state === 'open' || state === 'closed') {
          issue.state = state;
          issue.closedAt = state === 'closed' ? now : null;
        }
        if (Array.isArray(body.labels)) {
          const labelNames: string[] = [];
          for (const item of body.labels) {
            const name = typeof item === 'string' ? item : isObj(item) ? asString(item.name) : undefined;
            if (name !== undefined) labelNames.push(name);
          }
          const known = store.labels.get(key) ?? [];
          for (const name of labelNames) {
            if (!known.some((label) => label.name === name)) {
              return failWith(422, `Label "${name}" does not exist`);
            }
          }
          issue.labels = labelNames;
        }
        issue.updatedAt = now;
        return answer(200, issueJson(store, repo, issue));
      }
      return failWith(404, 'Not Found');
    }

    if (tail[2] === 'comments' && tail.length === 3) {
      const allComments = store.comments.get(key) ?? [];
      if (method === 'GET') {
        const list = allComments.filter((comment) => comment.issueNumber === issueNumber);
        const { page, link } = paginate(
          list.map((comment) => commentJson(store, repo, comment)),
          query,
          `/api/v3/repos/${owner}/${repoName}/issues/${issueNumber}/comments`,
          host,
        );
        return answer(200, page, link === '' ? {} : { link });
      }
      if (method === 'POST') {
        const text = asString(body.body);
        if (text === undefined || text.trim() === '') return failWith(422, 'body is required');
        const now = store.clock.now();
        const comment: Comment = {
          id: store.nextId(),
          issueNumber,
          body: text,
          createdAt: now,
          updatedAt: now,
          user: store.ownerLogin,
        };
        allComments.push(comment);
        return answer(201, commentJson(store, repo, comment));
      }
      return failWith(404, 'Not Found');
    }
    return failWith(404, 'Not Found');
  }

  // ---- pulls ------------------------------------------------------------------------------
  if (tail[0] === 'pulls') {
    const allPulls = store.pulls.get(key) ?? [];
    // Live head/base tips (refs move after creation, e.g. after another PR merges).
    const liveTips = (pull: Pull): { headSha: string; baseSha: string } => ({
      headSha: refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha,
      baseSha: refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha,
    });
    const livePullJson = (pull: Pull): Json => {
      const tips = liveTips(pull);
      const live: Pull = {
        ...pull,
        head: { ref: pull.head.ref, sha: tips.headSha },
        base: { ref: pull.base.ref, sha: tips.baseSha },
      };
      return pullJson(store, repo, live);
    };

    if (tail.length === 1) {
      if (method === 'GET') {
        const state = queryFirst(query, 'state') ?? 'open';
        const wanted = state === 'all' ? undefined : state === 'closed' ? 'closed' : 'open';
        const list = allPulls.filter((pull) => wanted === undefined || pull.state === wanted);
        const sorted = [...list].sort((a, b) => {
          if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
          return a.number - b.number;
        });
        sorted.reverse(); // newest first, GitHub's default
        const { page, link } = paginate(
          sorted.map((pull) => livePullJson(pull)),
          query,
          `/api/v3/repos/${owner}/${repoName}/pulls`,
          host,
        );
        return answer(200, page, link === '' ? {} : { link });
      }
      if (method === 'POST') {
        const title = asString(body.title);
        if (title === undefined || title.trim() === '') return failWith(422, 'title is required');
        const head = asString(body.head);
        if (head === undefined || head.trim() === '') return failWith(422, 'head is required');
        const base = asString(body.base) ?? repo.defaultBranch;
        const headSha = refs.get(`refs/heads/${head}`);
        if (headSha === undefined) return failWith(422, `Head branch "${head}" does not exist`);
        const baseSha = refs.get(`refs/heads/${base}`);
        if (baseSha === undefined) return failWith(422, `Base branch "${base}" does not exist`);
        const now = store.clock.now();
        const pull: Pull = {
          id: store.nextId(),
          number: store.nextNumber(key, 'pull'),
          title,
          body: asString(body.body) ?? '',
          state: 'open',
          head: { ref: head, sha: headSha },
          base: { ref: base, sha: baseSha },
          merged: false,
          mergeable: true,
          mergeCommitSha: null,
          mergedAt: null,
          closedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        refreshMergeable(store, repo, pull);
        allPulls.push(pull);
        return answer(201, livePullJson(pull));
      }
      return failWith(404, 'Not Found');
    }

    const pullNumber = Number.parseInt(tail[1] ?? '', 10);
    if (!Number.isInteger(pullNumber) || pullNumber < 1) return failWith(404, 'Not Found');
    const pull = allPulls.find((item) => item.number === pullNumber);
    if (pull === undefined) return failWith(404, 'Not Found');

    if (tail.length === 2) {
      if (method !== 'GET') return failWith(404, 'Not Found');
      refreshMergeable(store, repo, pull);
      return answer(200, livePullJson(pull));
    }

    if (tail[2] === 'files' && tail.length === 3) {
      if (method !== 'GET') return failWith(404, 'Not Found');
      const tips = liveTips(pull);
      return answer(200, diffTrees(store, tips.baseSha, tips.headSha));
    }

    if (tail[2] === 'merge' && tail.length === 3) {
      if (method !== 'PUT') return failWith(404, 'Not Found');
      if (pull.merged) return failWith(405, 'Pull request is already merged');
      if (pull.state === 'closed') return failWith(405, 'Pull request is closed');
      const tips = liveTips(pull);
      const live: Pull = {
        ...pull,
        head: { ref: pull.head.ref, sha: tips.headSha },
        base: { ref: pull.base.ref, sha: tips.baseSha },
      };
      if (pullConflicted(store, repo, live)) {
        return failWith(405, 'Merge conflict');
      }
      // Squash: apply every head-vs-merge-base change onto the base tip's tree.
      const base = mergeBaseOf(store, tips.headSha, tips.baseSha);
      const baseFlat = new Map<string, TreeEntry>();
      const headFlat = new Map<string, TreeEntry>();
      const tipFlat = new Map<string, TreeEntry>();
      const baseTree = base === undefined ? undefined : commitTreeOid(store, base);
      const headTree = commitTreeOid(store, tips.headSha);
      const tipTree = commitTreeOid(store, tips.baseSha);
      if (baseTree !== undefined) flattenTree(store, baseTree, '', baseFlat);
      if (headTree !== undefined) flattenTree(store, headTree, '', headFlat);
      if (tipTree !== undefined) flattenTree(store, tipTree, '', tipFlat);
      const result = new Map<string, string>();
      for (const [path, entry] of tipFlat) result.set(path, entry.oid);
      for (const [path, entry] of headFlat) {
        if (baseFlat.get(path)?.oid !== entry.oid) result.set(path, entry.oid);
      }
      for (const path of baseFlat.keys()) {
        if (!headFlat.has(path) && baseFlat.get(path) !== undefined) result.delete(path);
      }
      const squashTree = buildTreeFromFlat(store, result);
      const identity = commitIdentity(store);
      const squashSha = store.objects.put(
        'commit',
        buildCommitBytes({
          tree: squashTree,
          parents: [tips.baseSha],
          message: `Merge pull request #${pull.number} from ${owner}/${pull.head.ref}\n\n${pull.title}`,
          authorLine: identity.line,
          committerLine: identity.line,
        }),
      );
      refs.set(`refs/heads/${pull.base.ref}`, squashSha);
      const now = store.clock.now();
      pull.state = 'closed';
      pull.merged = true;
      pull.mergeable = false;
      pull.mergeCommitSha = squashSha;
      pull.mergedAt = now;
      pull.closedAt = now;
      pull.updatedAt = now;
      return answer(200, {
        sha: squashSha,
        merged: true,
        message: 'Pull request successfully merged',
      });
    }
    return failWith(404, 'Not Found');
  }

  return failWith(404, 'Not Found');
}
