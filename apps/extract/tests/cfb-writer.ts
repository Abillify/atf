// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * A minimal CFB (OLE compound file, version 3) writer for tests: storages and
 * streams, small streams in the mini stream, large ones in regular sectors.
 * Enough to build `.msg` and `oleObject*.bin` fixtures in memory.
 */

export type CfbNode = { name: string; data: Uint8Array } | { name: string; children: CfbNode[] };

const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;
const END = 0xfffffffe;
const FREE = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

interface Flat {
  name: string;
  type: 1 | 2 | 5;
  data?: Uint8Array;
  child: number;
  right: number;
  start: number;
  size: number;
}

export function writeCfb(children: CfbNode[]): Uint8Array {
  const flat: Flat[] = [{ name: "Root Entry", type: 5, child: NOSTREAM, right: NOSTREAM, start: END, size: 0 }];
  const add = (nodes: CfbNode[], parent: number): void => {
    let prev = -1;
    for (const node of nodes) {
      const index = flat.length;
      flat.push({
        name: node.name,
        type: "data" in node ? 2 : 1,
        ...("data" in node ? { data: node.data } : {}),
        child: NOSTREAM,
        right: NOSTREAM,
        start: END,
        size: "data" in node ? node.data.length : 0,
      });
      const link = flat[prev < 0 ? parent : prev] as Flat;
      if (prev < 0) link.child = index;
      else link.right = index;
      prev = index;
      if (!("data" in node)) add(node.children, index);
    }
  };
  add(children, 0);

  // Mini stream.
  const miniFat: number[] = [];
  const miniChunks: Uint8Array[] = [];
  for (const e of flat) {
    if (e.type !== 2 || e.data === undefined || e.data.length === 0 || e.data.length >= CUTOFF) continue;
    const count = Math.ceil(e.data.length / MINI);
    e.start = miniFat.length;
    for (let i = 0; i < count; i++) miniFat.push(i === count - 1 ? END : miniFat.length + 1);
    const padded = new Uint8Array(count * MINI);
    padded.set(e.data);
    miniChunks.push(padded);
  }
  const miniStream = concat(miniChunks);
  const rootEntry = flat[0] as Flat;
  rootEntry.size = miniStream.length;

  const big = flat.filter((e) => e.type === 2 && e.data !== undefined && e.data.length >= CUTOFF);
  const sectorsOf = (n: number): number => Math.ceil(n / SECTOR);
  const miniFatSectors = sectorsOf(miniFat.length * 4);
  const dirSectors = sectorsOf(flat.length * 128);
  const miniStreamSectors = sectorsOf(miniStream.length);
  const bigSectors = big.reduce((s, e) => s + sectorsOf(e.size), 0);
  let fatSectors = 1;
  for (;;) {
    const total = fatSectors + miniFatSectors + dirSectors + miniStreamSectors + bigSectors;
    const needed = sectorsOf(total * 4);
    if (needed <= fatSectors) break;
    fatSectors = needed;
  }
  const total = fatSectors + miniFatSectors + dirSectors + miniStreamSectors + bigSectors;
  const fat = new Array<number>(fatSectors * (SECTOR / 4)).fill(FREE);
  let next = 0;
  const run = (count: number): number => {
    if (count === 0) return END;
    const start = next;
    for (let i = 0; i < count; i++) fat[next + i] = i === count - 1 ? END : next + i + 1;
    next += count;
    return start;
  };
  for (let i = 0; i < fatSectors; i++) fat[next++] = FATSECT;
  const miniFatStart = run(miniFatSectors);
  const dirStart = run(dirSectors);
  rootEntry.start = run(miniStreamSectors);
  for (const e of big) e.start = run(sectorsOf(e.size));

  const out = new Uint8Array((total + 1) * SECTOR);
  const view = Buffer.from(out.buffer);
  view.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  view.writeUInt16LE(0x3e, 24);
  view.writeUInt16LE(3, 26);
  view.writeUInt16LE(0xfffe, 28);
  view.writeUInt16LE(9, 30);
  view.writeUInt16LE(6, 32);
  view.writeUInt32LE(fatSectors, 44);
  view.writeUInt32LE(dirStart, 48);
  view.writeUInt32LE(CUTOFF, 56);
  view.writeUInt32LE(miniFatSectors > 0 ? miniFatStart : END, 60);
  view.writeUInt32LE(miniFatSectors, 64);
  view.writeUInt32LE(END, 68);
  view.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) view.writeUInt32LE(i < fatSectors ? i : FREE, 76 + i * 4);
  const at = (sector: number): number => (sector + 1) * SECTOR;
  fat.forEach((v, i) => {
    view.writeUInt32LE(v >>> 0, at(0) + i * 4);
  });
  const miniFatBytes = Buffer.alloc(miniFatSectors * SECTOR, 0xff);
  miniFat.forEach((v, i) => {
    miniFatBytes.writeUInt32LE(v >>> 0, i * 4);
  });
  if (miniFatSectors > 0) view.set(miniFatBytes, at(miniFatStart));
  flat.forEach((e, i) => {
    const o = at(dirStart) + i * 128;
    const name = Buffer.from(`${e.name}\0`, "utf16le");
    view.set(name.subarray(0, 64), o);
    view.writeUInt16LE(Math.min(name.length, 64), o + 64);
    view[o + 66] = e.type;
    view[o + 67] = 1;
    view.writeUInt32LE(NOSTREAM, o + 68);
    view.writeUInt32LE(e.right >>> 0, o + 72);
    view.writeUInt32LE(e.child >>> 0, o + 76);
    view.writeUInt32LE(e.start >>> 0, o + 116);
    view.writeUInt32LE(e.size, o + 120);
  });
  for (let i = flat.length; i < dirSectors * 4; i++) {
    const o = at(dirStart) + i * 128;
    view.writeUInt32LE(NOSTREAM, o + 68);
    view.writeUInt32LE(NOSTREAM, o + 72);
    view.writeUInt32LE(NOSTREAM, o + 76);
  }
  if (miniStream.length > 0) view.set(miniStream, at(rootEntry.start));
  for (const e of big) if (e.data !== undefined) view.set(e.data, at(e.start));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ─── .msg helpers ───────────────────────────────────────────────────────────

const hex = (n: number, w: number): string => n.toString(16).toUpperCase().padStart(w, "0");

/** A Unicode string property stream. */
export function msgString(id: number, value: string): CfbNode {
  return { name: `__substg1.0_${hex(id, 4)}001F`, data: Buffer.from(value, "utf16le") };
}

/** A binary property stream. */
export function msgBinary(id: number, value: Uint8Array): CfbNode {
  return { name: `__substg1.0_${hex(id, 4)}0102`, data: value };
}

/** A property stream with fixed-length values (PT_LONG / PT_SYSTIME). */
export function msgProperties(
  headerSize: number,
  props: Array<{ id: number; long?: number; time?: Date }>,
): CfbNode {
  const buf = Buffer.alloc(headerSize + props.length * 16);
  props.forEach((p, i) => {
    const o = headerSize + i * 16;
    const type = p.time !== undefined ? 0x0040 : 0x0003;
    buf.writeUInt32LE(((p.id << 16) | type) >>> 0, o);
    buf.writeUInt32LE(6, o + 4);
    if (p.time !== undefined) {
      buf.writeBigUInt64LE(BigInt(p.time.getTime() + 11_644_473_600_000) * 10_000n, o + 8);
    } else {
      buf.writeInt32LE(p.long ?? 0, o + 8);
    }
  });
  return { name: "__properties_version1.0", data: buf };
}
