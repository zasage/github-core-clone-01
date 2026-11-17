// Git object model: the real git loose-object format (`"<type> <len>\0" + body`,
// SHA-1 ids). Pure Node 22 stdlib (node:crypto only). No wall clock, no randomness:
// every timestamp lives inside the caller-supplied author/committer strings.

import { createHash } from 'node:crypto';

/** The four object types git stores. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** A git object: its type and its exact bytes (no header; the hash is computed over it). */
export type GitObject = { type: GitObjectType; body: Buffer };

/** The all-zero object id: an unborn branch's old/new value in receive-pack. */
export const ZERO_OID = '0'.repeat(40);

const HEX40 = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, body: Buffer): string {
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

/** The full loose-object bytes (header + content), as `git cat-file` would hash them. */
export function encodeObject(type: GitObjectType, body: Buffer): Buffer {
  return Buffer.concat([objectHeader(type, body.length), body]);
}

/** Split full loose-object bytes back into type + body; throws on a malformed header. */
export function decodeObject(raw: Buffer): GitObject {
  const nul = raw.indexOf(0x00);
  if (nul < 0) throw new Error('decodeObject: object has no header terminator');
  const header = raw.subarray(0, nul).toString('ascii');
  const space = header.indexOf(' ');
  if (space < 0) throw new Error(`decodeObject: bad header ${JSON.stringify(header)}`);
  const type = header.slice(0, space);
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`decodeObject: unknown object type ${JSON.stringify(type)}`);
  }
  const size = Number(header.slice(space + 1));
  if (!Number.isInteger(size) || size < 0 || raw.length - nul - 1 !== size) {
    throw new Error(`decodeObject: header size ${header.slice(space + 1)} does not match ${raw.length - nul - 1} body bytes`);
  }
  return { type, body: Buffer.from(raw.subarray(nul + 1)) };
}

/** In-memory object store backed by a Map. Object ids are content-derived, so the store is shared safely across repos. */
export class ObjectStore {
  private readonly map = new Map<string, GitObject>();

  get(oid: string): GitObject | undefined {
    return this.map.get(oid);
  }

  has(oid: string): boolean {
    return this.map.has(oid);
  }

  /** Hash and store an object; returns its id. Storing the same bytes twice is a no-op. */
  put(type: GitObjectType, body: Buffer): string {
    const oid = hashObject(type, body);
    if (!this.map.has(oid)) this.map.set(oid, { type, body: Buffer.from(body) });
    return oid;
  }

  /** Store an object under a caller-computed id (used by the pack reader after verifying the hash). */
  set(oid: string, object: GitObject): void {
    if (!this.map.has(oid)) this.map.set(oid, object);
  }

  get size(): number {
    return this.map.size;
  }

  oids(): string[] {
    return [...this.map.keys()];
  }
}

// ---------------------------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------------------------

export interface BuildCommitInput {
  readonly tree: string;
  readonly parents?: readonly string[];
  /** Full ident line: "Name <email> timestamp tz" (the caller owns the timestamp). */
  readonly author: string;
  /** Full ident line: "Name <email> timestamp tz". */
  readonly committer: string;
  readonly message: string;
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  /** Headers before the blank line that are not tree/parent/author/committer. */
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

/** Build a commit object's bytes. The message is used as given, gaining one trailing newline if it lacks one (git's convention). */
export function buildCommit(input: BuildCommitInput): Buffer {
  if (!isObjectId(input.tree)) throw new Error('buildCommit: tree is not a valid object id');
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('buildCommit: parent is not a valid object id');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${input.author}`, `committer ${input.committer}`, '');
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

/** Parse a commit object. Continuation lines (leading space, e.g. gpgsig) fold into the previous header. */
export function parseCommit(body: Buffer): ParsedCommit {
  const blank = body.indexOf('\n\n');
  const headerEnd = blank < 0 ? body.length : blank;
  const message = blank < 0 ? '' : body.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of body.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    if (line.startsWith(' ') && extra.length) {
      const last = extra[extra.length - 1];
      extra[extra.length - 1] = [last[0], `${last[1]}\n${line}`];
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new Error('parseCommit: commit has no valid tree header');
  for (const parent of parents) if (!isObjectId(parent)) throw new Error('parseCommit: commit has a bad parent id');
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntryInput {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export type TreeEntry = TreeEntryInput;

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntryInput, b: TreeEntryInput): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntryInput[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`buildTree: entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) throw new Error('parseTree: entry has no mode separator');
    const nul = body.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('parseTree: entry has no name terminator');
    if (nul + 21 > body.length) throw new Error('parseTree: entry has a truncated object id');
    const mode = body.subarray(offset, space).toString('ascii');
    const name = body.subarray(space + 1, nul).toString('utf8');
    const oid = body.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`parseTree: entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------------------------

export interface ParsedTag {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(body: Buffer): ParsedTag {
  const blank = body.indexOf('\n\n');
  const headerEnd = blank < 0 ? body.length : blank;
  const headers = new Map<string, string>();
  for (const line of body.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`parseTag: header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('parseTag: tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`parseTag: tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : body.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries (gitlinks
 * skipped), tag -> its target, blob -> nothing. Throws on a missing object unless `allowMissing`.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`collectReachable: object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.body);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.body).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.body)) {
        if (entry.mode === '160000') continue; // gitlink: a commit this repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}
