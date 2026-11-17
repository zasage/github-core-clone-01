// pkt-line codec and side-band-64k framing for the git smart-HTTP protocols.
// Pure Node 22 stdlib. A pkt-line is a 4-hex-digit length (payload + 4) followed by the
// payload; 0000 is flush, 0001 delim, 0002 response-end. Largest packet: 65520 bytes.

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length. */
export const PKT_LINE_MAX = 65520;
/** Largest pkt-line payload (length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** Largest data chunk in one sideband pkt-line: header (4) + band byte (1) + data. */
export const SIDEBAND_MAX_DATA = PKT_LINE_MAX - 5;

export type PktLine =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

function asBuffer(value: string | Buffer | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Buffer | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a mixed sequence; 'flush'/'delim'/'response-end' are the control packets. */
export function encodePktLines(
  items: ReadonlyArray<string | Buffer | Uint8Array | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

export interface DecodedPktLines {
  /** Packets decoded in order, up to the first trailing raw byte (or the end of the buffer). */
  readonly packets: PktLine[];
  /** Bytes consumed by the decoded packets. */
  readonly consumed: number;
  /** Bytes after the decoded packets (e.g. a raw packfile following a flush). Empty when fully framed. */
  readonly trailing: Buffer;
}

/**
 * Decode pkt-lines from the start of a buffer. Stops (without throwing) at the first four
 * bytes that are not a pkt-line length, returning them as `trailing` — that is how a
 * receive-pack command list ends and the raw packfile begins. Throws on a malformed header
 * (bad hex, length 0003, or a length over the maximum) or a truncated packet.
 */
export function decodePktLines(buf: Buffer): DecodedPktLines {
  const packets: PktLine[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new Error(`truncated pkt-line: ${buf.length - offset} trailing byte(s)`);
    }
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) break; // raw trailing bytes (a packfile) — not an error here
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > buf.length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${buf.length - offset} available`);
    }
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return { packets, consumed: offset, trailing: buf.subarray(offset) };
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly PktLine[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// side-band-64k
// ---------------------------------------------------------------------------------------------

/** Sideband channels: 1 = packfile/report data, 2 = progress, 3 = error. */
export type Sideband = 1 | 2 | 3;

/**
 * Frame `data` as sideband pkt-lines on `band`, splitting into chunks that fit one pkt-line
 * (header + band byte + at most SIDEBAND_MAX_DATA data bytes). Empty data frames nothing.
 */
export function encodeSideband(band: Sideband, data: Buffer): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_MAX_DATA) {
    const chunk = data.subarray(offset, offset + SIDEBAND_MAX_DATA);
    const framed = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(encodePktLine(framed));
  }
  return Buffer.concat(parts);
}

/** Split one band's concatenated payload back into its chunks (inverse of encodeSideband). */
export function decodeSideband(band: Sideband, packets: readonly PktLine[]): Buffer {
  const chunks: Buffer[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload.length < 1) continue;
    if (packet.payload[0] === band) chunks.push(packet.payload.subarray(1));
  }
  return Buffer.concat(chunks);
}
