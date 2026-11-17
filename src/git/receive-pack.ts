// git-receive-pack: protocol v0 only. Accepts a command list + packfile, unpacks the pack
// (deltas included), and applies each ref update that fast-forwards. A refused ref is
// reported per ref (`ng <ref> non-fast-forward`), the ref does not move, and the other
// refs in the same command list are still applied. Pure Node 22 stdlib.

import { isObjectId, parseCommit, parseTag, ZERO_OID, type ObjectStore } from './objects.ts';
import { parsePack } from './pack.ts';
import { decodePktLines, encodePktLines, encodeSideband, pktLineFlush } from './protocol.ts';

export interface ReceivePackContext {
  /** Ref name -> tip oid for this repo (a live view: reads see the current tips). */
  readonly refs: Map<string, string>;
  readonly objects: ObjectStore;
  /**
   * Move a ref. Called with ZERO_OID to delete it. The store owner must treat ZERO_OID
   * as a delete.
   */
  readonly setRef: (ref: string, oid: string) => void;
}

export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

interface RefVerdict {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
}

/** Resolve a tag object through to its target commit (following tag chains). */
function resolveToCommit(oid: string, objects: ObjectStore): string | undefined {
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

/** True when `ancestor` is reachable from `tip` by walking commit parents (tip == ancestor counts). */
function isAncestor(ancestor: string, tip: string, objects: ObjectStore): boolean {
  if (ancestor === tip) return true;
  const tipCommit = resolveToCommit(tip, objects);
  const ancestorCommit = resolveToCommit(ancestor, objects);
  if (!tipCommit || !ancestorCommit) return false;
  if (tipCommit === ancestorCommit) return true;
  const seen = new Set<string>();
  const queue: string[] = [tipCommit];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.body).parents) {
      if (parent === ancestorCommit) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Parse a receive-pack request body into commands plus the raw packfile bytes after the flush. */
export function parseReceivePackRequest(body: Buffer): { commands: PushCommand[]; pack: Buffer; sideband: boolean } {
  const { packets, trailing } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const head = nul < 0 ? text : text.slice(0, nul);
    const caps = nul < 0 ? '' : text.slice(nul + 1);
    if (caps.includes('side-band-64k')) sideband = true;
    const line = head.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3 || !isObjectId(parts[0]) || !isObjectId(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new Error(`receive-pack: bad command line ${JSON.stringify(line.slice(0, 80))}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (!commands.length) throw new Error('receive-pack: no commands in request');
  return { commands, pack: Buffer.from(trailing), sideband };
}

/**
 * Handle one POST /git-receive-pack body. Returns the report-status response bytes
 * (sideband-framed when the client asked for side-band-64k, plain pkt-lines otherwise).
 * Never throws for a bad pack: an unpack failure is reported as `unpack <detail>` plus
 * one `ng` line per ref, and no ref moves.
 */
export function handleReceivePack(body: Buffer, ctx: ReceivePackContext): Buffer {
  let commands: PushCommand[] = [];
  let pack = Buffer.alloc(0);
  let sideband = false;
  let unpackError: string | undefined;
  try {
    const parsed = parseReceivePackRequest(body);
    commands = parsed.commands;
    pack = parsed.pack;
    sideband = parsed.sideband;
  } catch (err) {
    unpackError = (err as Error).message;
  }

  const verdicts: RefVerdict[] = [];
  if (!unpackError) {
    const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
    if (needsPack && pack.length > 0) {
      try {
        parsePack(pack, ctx.objects);
      } catch (err) {
        unpackError = (err as Error).message;
      }
    } else if (needsPack && pack.length === 0) {
      unpackError = 'no packfile in request';
    }
  }

  if (unpackError) {
    for (const command of commands) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    }
    return reportResponse(`unpack ${unpackError}\n`, verdicts, sideband);
  }

  for (const command of commands) {
    const current = ctx.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete: allowed when the ref exists and old matches (or old is zero).
      if (current === undefined) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        ctx.setRef(command.ref, ZERO_OID);
        verdicts.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!ctx.objects.has(command.newOid)) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      // Create: allowed only when old is zero.
      if (command.oldOid !== ZERO_OID) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        ctx.setRef(command.ref, command.newOid);
        verdicts.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid !== current) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    if (!isAncestor(current, command.newOid, ctx.objects)) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    ctx.setRef(command.ref, command.newOid);
    verdicts.push({ ref: command.ref, ok: true, reason: '' });
  }

  return reportResponse('unpack ok\n', verdicts, sideband);
}

function reportResponse(unpackLine: string, verdicts: readonly RefVerdict[], sideband: boolean): Buffer {
  const lines: string[] = [unpackLine];
  for (const verdict of verdicts) {
    lines.push(verdict.ok ? `ok ${verdict.ref}\n` : `ng ${verdict.ref} ${verdict.reason}\n`);
  }
  // The report stream itself ends with a flush pkt-line. With sideband that flush
  // lives INSIDE the band-1 data (real git's send_report appends it before framing);
  // without it git reads the report, hits EOF, and dies with "the remote end hung
  // up unexpectedly" even though every ref line was parsed. The outer flush then
  // terminates the sideband stream.
  const inner = encodePktLines([...lines, 'flush']);
  if (!sideband) return inner;
  return Buffer.concat([encodeSideband(1, inner), pktLineFlush()]);
}

/** The v0 receive-pack advertisement (without the `# service=` preamble, added by smart-http). */
export function buildReceivePackAdvertisementV0(ctx: { readonly refs: Map<string, string> }): Buffer {
  const caps = [
    'report-status',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    'agent=github-core-clone/1.0',
  ].join(' ');
  const entries = [...ctx.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines: Array<string | 'flush'> = [];
  if (entries.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headTarget =
      ctx.refs.get('refs/heads/main') !== undefined
        ? 'refs/heads/main'
        : entries.find(([name]) => name.startsWith('refs/heads/'))?.[0] ?? 'refs/heads/main';
    const headOid = ctx.refs.get(headTarget) ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps} symref=HEAD:${headTarget}\n`);
    for (const [name, oid] of entries) {
      lines.push(`${oid} ${name}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}
