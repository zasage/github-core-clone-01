// git-upload-pack: protocol v2 (advertisement, ls-refs, fetch) and the v0 fetch fallback.
// Pure Node 22 stdlib.
//
// Haves are HONOURED, never ignored: the fetch sends only objects reachable from the
// wants minus objects reachable from the haves (the have walk stops at the client's
// shallow boundaries, so a deepen can still deliver the parent of a shallow tip the
// client already holds), and it ACKs each have the server holds (NAK only when none
// matches). The pack itself carries full objects only — no deltas, no thin pack —
// which the client accepts: it resolves deltas only when the server sends them.

import {
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type ObjectStore,
} from './objects.ts';
import { buildPack } from './pack.ts';
import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  encodeSideband,
  pktLineDelim,
  pktLineFlush,
  type PktLine,
} from './protocol.ts';

export interface UploadPackContext {
  /** Ref name -> tip oid (refs/heads/*, refs/tags/*; HEAD is derived, not stored here). */
  readonly refs: Map<string, string>;
  readonly objects: ObjectStore;
}

export const UPLOAD_PACK_AGENT = 'github-core-clone/1.0';

/** HEAD's target: refs/heads/main when it exists (or the repo is empty), else the first head. */
export function headTargetFor(refs: Map<string, string>): string {
  if (refs.has('refs/heads/main')) return 'refs/heads/main';
  const heads = [...refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
  return heads.length ? heads[0] : 'refs/heads/main';
}

function sortedRefs(refs: Map<string, string>): Array<[string, string]> {
  return [...refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The target commit of a ref tip (peeling an annotated tag), or the tip itself. */
function peelToCommit(oid: string, objects: ObjectStore): string | undefined {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = objects.get(current);
    if (!object) return undefined;
    if (object.type === 'tag') {
      current = parseTag(object.body).object;
      continue;
    }
    return object.type === 'commit' ? current : undefined;
  }
  return undefined;
}

/** Peeled target of a ref tip when it is an annotated tag, else undefined. */
function peeledTarget(oid: string, objects: ObjectStore): string | undefined {
  const object = objects.get(oid);
  if (!object || object.type !== 'tag') return undefined;
  return parseTag(object.body).object;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/** Protocol v2 capability advertisement (the `# service=` preamble is added by smart-http). */
export function buildUploadPackAdvertisementV2(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${UPLOAD_PACK_AGENT}\n`,
    'flush',
  ]);
}

/** Protocol v0 ref advertisement (without the `# service=` preamble, added by smart-http). */
export function buildUploadPackAdvertisementV0(ctx: UploadPackContext): Buffer {
  const headTarget = headTargetFor(ctx.refs);
  const caps = [
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'multi_ack',
    'multi_ack_detailed',
    'no-progress',
    `symref=HEAD:${headTarget}`,
    `agent=${UPLOAD_PACK_AGENT}`,
  ].join(' ');
  const lines: Array<string | 'flush'> = [];
  const entries = sortedRefs(ctx.refs);
  if (entries.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headOid = ctx.refs.get(headTarget) ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const [name, oid] of entries) {
      lines.push(`${oid} ${name}\n`);
      const peeled = peeledTarget(oid, ctx.objects);
      if (peeled) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// fetch: shared reachability
// ---------------------------------------------------------------------------------------------

export interface FetchArgs {
  readonly wants: string[];
  readonly haves: string[];
  /** The client's current shallow boundaries. */
  readonly shallow: string[];
  readonly deepen?: number;
}

export interface FetchPlan {
  /** Objects to send (full closure of the new commits, minus what the client holds). */
  readonly send: Map<string, GitObject>;
  /** New shallow boundary commits (only when deepen was given). */
  readonly shallowOut: string[];
  /** Old shallow boundaries that now have their parents (only when deepen was given). */
  readonly unshallowOut: string[];
}

/**
 * Commit generations reachable from `wants`, capped at `deepen` (tip = generation 1).
 * Tag wants resolve to their target commit at generation 1. Returns the commit -> generation
 * map and the tag objects the wants themselves named.
 */
function wantCommits(
  wants: Iterable<string>,
  deepen: number | undefined,
  objects: ObjectStore,
): { commits: Map<string, number>; tags: string[] } {
  const commits = new Map<string, number>();
  const tags: string[] = [];
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    const object = objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      tags.push(want);
      const target = parseTag(object.body).object;
      queue.push({ oid: target, depth: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 1 });
    } else {
      // A want naming a tree/blob directly: not a commit walk; handled by collectTreeClosure below.
      queue.push({ oid: want, depth: 1 });
    }
  }
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    const known = commits.get(oid);
    if (known !== undefined && known <= depth) continue;
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    commits.set(oid, depth);
    if (deepen !== undefined && depth >= deepen) continue;
    for (const parent of parseCommit(object.body).parents) {
      queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return { commits, tags };
}

/**
 * Object closure WITHOUT following commit parents: commit -> its tree only, tag ->
 * its target, tree -> entries, blob -> nothing. Used for fetch planning, where the
 * commit set is already capped by `deepen` / the have walk and must not re-expand
 * through history (collectReachable follows parents and would undo both caps).
 */
function collectTreeClosure(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      queue.push(parseCommit(object.body).tree);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.body).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.body)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Objects the client already holds, from its haves: each have commit plus its tree
 * closure — but the walk stops at the client's shallow boundaries, whose parents the
 * client does NOT hold. (The closure must not follow parents, or the boundary stop
 * would be undone: collectReachable([boundary]) re-expands the whole history.)
 */
function haveObjects(haves: Iterable<string>, shallow: ReadonlySet<string>, objects: ObjectStore): Set<string> {
  const roots: string[] = [];
  const queue: string[] = [];
  for (const have of haves) {
    const object = objects.get(have);
    if (!object) continue;
    if (object.type === 'tag') {
      roots.push(have);
      queue.push(parseTag(object.body).object);
    } else {
      queue.push(have);
    }
  }
  const heldCommits = new Set<string>();
  while (queue.length) {
    const oid = queue.shift()!;
    if (heldCommits.has(oid)) continue;
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    heldCommits.add(oid);
    if (shallow.has(oid)) continue; // boundary: the client holds this commit, not its parents
    for (const parent of parseCommit(object.body).parents) queue.push(parent);
  }
  return collectTreeClosure([...roots, ...heldCommits], (oid) => objects.get(oid));
}

/** Exported for unit tests: compute the fetch plan (objects to send + shallow boundary). */
export function planFetch(args: FetchArgs, objects: ObjectStore): FetchPlan {
  const shallowSet = new Set(args.shallow);
  const held = haveObjects(args.haves, shallowSet, objects);
  const { commits, tags } = wantCommits(args.wants, args.deepen, objects);
  const sendRoots = [...tags, ...commits.keys()].filter((oid) => !held.has(oid));
  // Non-commit wants (tree/blob) still need their object sent.
  for (const want of args.wants) {
    const object = objects.get(want);
    if (object && object.type !== 'commit' && object.type !== 'tag' && !held.has(want)) {
      sendRoots.push(want);
    }
  }
  const sendIds = collectTreeClosure(sendRoots, (oid) => objects.get(oid));
  const send = new Map<string, GitObject>();
  for (const oid of sendIds) {
    if (held.has(oid)) continue;
    const object = objects.get(oid);
    if (object) send.set(oid, object);
  }
  let shallowOut: string[] = [];
  let unshallowOut: string[] = [];
  if (args.deepen !== undefined) {
    for (const [oid, depth] of commits) {
      if (depth === args.deepen) shallowOut.push(oid);
    }
    shallowOut.sort();
    for (const boundary of args.shallow) {
      const depth = commits.get(boundary);
      if (depth !== undefined && depth < args.deepen) unshallowOut.push(boundary);
    }
    unshallowOut.sort();
  }
  return { send, shallowOut, unshallowOut };
}

// ---------------------------------------------------------------------------------------------
// protocol v2: ls-refs / fetch
// ---------------------------------------------------------------------------------------------

interface V2Request {
  readonly command: string;
  /** Lines after the delim (arguments). */
  readonly args: string[];
}

/** Split a v2 request body into its command and argument lines. Throws on a malformed body. */
function parseV2Request(body: Buffer): V2Request {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  let command = '';
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (!afterDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length).replace(/\n$/, '');
      // agent=/object-format= lines before the delim are accepted and ignored.
    } else {
      lines.push(text.replace(/\n$/, ''));
    }
  }
  if (!command) throw new Error('upload-pack v2: request has no command line');
  return { command, args: lines };
}

function lsRefsResponse(ctx: UploadPackContext, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headTarget = headTargetFor(ctx.refs);
  const headOid = ctx.refs.get(headTarget);
  const parts: Buffer[] = [];
  const line = (text: string): void => {
    parts.push(encodePktLine(text));
  };
  if (keep('HEAD')) {
    if (headOid) {
      const attrs = symrefs ? ` symref-target:${headTarget}` : '';
      line(`${headOid} HEAD${attrs}\n`);
    } else if (unborn) {
      line(`unborn HEAD symref-target:${headTarget}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(ctx.refs)) {
    if (!keep(name)) continue;
    let text = `${oid} ${name}`;
    if (symrefs && name === 'HEAD') text += ` symref-target:${headTarget}`;
    if (peel) {
      const peeled = peeledTarget(oid, ctx.objects);
      if (peeled) text += ` peeled:${peeled}`;
    }
    line(`${text}\n`);
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) {
      const oid = arg.slice(5).trim();
      if (isObjectId(oid)) wants.push(oid);
    } else if (arg.startsWith('have ')) {
      const oid = arg.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    } else if (arg.startsWith('shallow ')) {
      const oid = arg.slice(8).trim();
      if (isObjectId(oid)) shallow.push(oid);
    } else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isInteger(n) && n > 0) deepen = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: accepted, ignored.
  }
  return { wants, haves, shallow, deepen };
}

/** Acknowledgment lines for a fetch: `ACK <oid>` per have the server holds, else `NAK`. */
function ackLines(haves: readonly string[], objects: ObjectStore): string[] {
  const lines: string[] = [];
  for (const have of haves) {
    if (objects.has(have)) lines.push(`ACK ${have}\n`);
  }
  if (!lines.length) lines.push('NAK\n');
  return lines;
}

function fetchResponseV2(ctx: UploadPackContext, args: readonly string[]): Buffer {
  const fetchArgs = parseFetchArgs(args);
  const plan = planFetch(fetchArgs, ctx.objects);
  const pack = buildPack([...plan.send.keys()], ctx.objects);
  const parts: Buffer[] = [];
  // Real git only reads an acknowledgments section when the request carried haves;
  // with no haves it goes straight to the packfile section (sending acknowledgments
  // there makes git die with "expected 'packfile', received 'acknowledgments'").
  // The suite's client accepts both shapes. When haves were sent, ACK each have the
  // server holds (NAK only when none matches) — never re-send a held object.
  if (fetchArgs.haves.length) {
    parts.push(encodePktLine('acknowledgments\n'));
    for (const line of ackLines(fetchArgs.haves, ctx.objects)) parts.push(encodePktLine(line));
    parts.push(encodePktLine('ready\n'));
    parts.push(pktLineDelim());
  }
  if (plan.shallowOut.length || plan.unshallowOut.length) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(encodeSideband(1, pack));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** Handle one POST /git-upload-pack body speaking protocol v2. Returns the raw response bytes. */
export function handleUploadPackV2(body: Buffer, ctx: UploadPackContext): Buffer {
  const request = parseV2Request(body);
  if (request.command === 'ls-refs') return lsRefsResponse(ctx, request.args);
  if (request.command === 'fetch') return fetchResponseV2(ctx, request.args);
  throw new Error(`upload-pack v2: unknown command ${JSON.stringify(request.command)}`);
}

// ---------------------------------------------------------------------------------------------
// protocol v0 fetch
// ---------------------------------------------------------------------------------------------

/** Handle one POST /git-upload-pack body speaking protocol v0 (want/have/done/deepen). */
export function handleUploadPackV0(body: Buffer, ctx: UploadPackContext): Buffer {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  let section = 0; // 0 = wants, 1 = negotiation (after the first flush)
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    // The first want line may carry capabilities after the oid: `want <oid> <caps>`.
    const firstSpace = line.indexOf(' ');
    const verb = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : line.slice(firstSpace + 1).split(' ')[0];
    if (verb === 'want' && isObjectId(rest)) wants.push(rest);
    else if (verb === 'have' && isObjectId(rest)) haves.push(rest);
    else if (verb === 'shallow' && isObjectId(rest)) shallow.push(rest);
    else if (verb === 'deepen') {
      const n = Number(rest);
      if (Number.isInteger(n) && n > 0) deepen = n;
    }
    // done, deepen-since, deepen-not: accepted, ignored.
  }
  void section;
  const plan = planFetch({ wants, haves, shallow, deepen }, ctx.objects);
  const pack = buildPack([...plan.send.keys()], ctx.objects);
  const parts: Buffer[] = [];
  // v0 has no sections, and a shallow response carries the shallow list TWICE: git's
  // fetch-pack reads it once right after the wants (a loop that dies with "expected
  // shallow/unshallow, got ..." on anything but shallow/unshallow lines, ending at
  // a flush) and once more after "done" (consume_shallow_list, which dies with
  // "expected shallow list" on anything but shallow/unshallow lines, again ending
  // at a flush). Only then do the ACK/NAK lines and the sideband pack follow.
  // ACK each have the server holds (NAK only when none matches); held objects are
  // never re-sent. Without a deepen there is no shallow list at all: NAK/ACK + pack.
  const shallowList = (): void => {
    for (const oid of plan.shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineFlush());
  };
  if (deepen !== undefined) {
    shallowList();
    shallowList();
  }
  for (const line of ackLines(haves, ctx.objects)) parts.push(encodePktLine(line));
  parts.push(encodeSideband(1, pack));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

/**
 * Handle one POST /git-upload-pack body, dispatching on its shape: a leading `command=`
 * line is protocol v2, a leading `want ` line is protocol v0.
 */
export function handleUploadPack(body: Buffer, ctx: UploadPackContext): Buffer {
  const { packets } = decodePktLines(body);
  const first = packets.find((packet) => packet.kind === 'data');
  if (first && first.kind === 'data' && first.payload.toString('utf8').startsWith('command=')) {
    return handleUploadPackV2(body, ctx);
  }
  return handleUploadPackV0(body, ctx);
}
