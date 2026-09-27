// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/native/cfb.ts
 *
 * A small reader for Compound File Binary containers ([MS-CFB]) — the OLE
 * format of Outlook `.msg` files and of the `oleObject*.bin` packages Word
 * embeds. It follows the DIFAT → FAT chain, the directory's red-black sibling
 * trees, and the mini stream for small streams, and reads stream bytes. No
 * dependency.
 *
 * Defensive by construction: every chain walk is bounded and cycle-checked, a
 * sector outside the file ends the read, and a malformed container yields
 * `null` rather than an exception.
 */

/** One directory entry: a storage (folder) or a stream (file). */
export interface CfbEntry {
	name: string;
	type: "storage" | "stream";
	size: number;
	/** Children of a storage, in directory order (unsorted). */
	children: CfbEntry[];
	/** Child by exact name (case-insensitive, as CFB compares names). */
	child(name: string): CfbEntry | undefined;
	/** The stream's bytes (empty for a storage). */
	read(): Uint8Array;
}

const END_OF_CHAIN = 0xfffffffe;
const FREE_SECT = 0xffffffff;
const NO_STREAM = 0xffffffff;
const MAX_ENTRIES = 100_000;

/** Parse a CFB container; null when the bytes are not a readable compound file. */
export function readCfb(buffer: Uint8Array): CfbEntry | null {
	try {
		return parse(buffer);
	} catch {
		return null;
	}
}

function parse(bytes: Uint8Array): CfbEntry | null {
	if (bytes.byteLength < 512) return null;
	const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
	if (!signature.every((b, i) => view[i] === b)) return null;
	if (view.readUInt16LE(28) !== 0xfffe) return null;
	const sectorShift = view.readUInt16LE(30);
	if (sectorShift !== 9 && sectorShift !== 12) return null;
	const sectorSize = 1 << sectorShift;
	const miniSectorSize = 1 << view.readUInt16LE(32);
	const miniCutoff = view.readUInt32LE(56);
	const sectorCount = Math.floor((view.byteLength - sectorSize) / sectorSize) + 1;

	const sector = (id: number): Buffer | null => {
		if (id < 0 || id >= sectorCount) return null;
		const offset = (id + 1) * sectorSize;
		if (offset >= view.byteLength) return null;
		return view.subarray(offset, Math.min(offset + sectorSize, view.byteLength));
	};

	// DIFAT: 109 entries in the header, then a chain of DIFAT sectors.
	const fatSectors: number[] = [];
	for (let o = 76; o < 512; o += 4) {
		const id = view.readUInt32LE(o);
		if (id !== FREE_SECT && id !== END_OF_CHAIN) fatSectors.push(id);
	}
	let difat = view.readUInt32LE(68);
	const seenDifat = new Set<number>();
	while (difat !== END_OF_CHAIN && difat !== FREE_SECT) {
		if (seenDifat.has(difat) || seenDifat.size > sectorCount) return null;
		seenDifat.add(difat);
		const s = sector(difat);
		if (s === null) return null;
		for (let o = 0; o + 4 < s.length; o += 4) {
			const id = s.readUInt32LE(o);
			if (id !== FREE_SECT && id !== END_OF_CHAIN) fatSectors.push(id);
		}
		difat = s.readUInt32LE(s.length - 4);
	}
	const fat: number[] = [];
	for (const id of fatSectors) {
		const s = sector(id);
		if (s === null) return null;
		for (let o = 0; o + 4 <= s.length; o += 4) fat.push(s.readUInt32LE(o));
	}

	const chain = (start: number, table: number[], limit: number): number[] => {
		const out: number[] = [];
		const seen = new Set<number>();
		let id = start;
		while (id !== END_OF_CHAIN && id !== FREE_SECT) {
			if (seen.has(id) || out.length > limit) break;
			seen.add(id);
			out.push(id);
			const next = table[id];
			if (next === undefined) break;
			id = next;
		}
		return out;
	};

	const readChain = (start: number, size: number): Uint8Array => {
		const ids = chain(start, fat, sectorCount);
		const out = Buffer.alloc(Math.min(size, ids.length * sectorSize));
		let written = 0;
		for (const id of ids) {
			const s = sector(id);
			if (s === null) break;
			const n = Math.min(s.length, out.length - written);
			s.copy(out, written, 0, n);
			written += n;
			if (written >= out.length) break;
		}
		return out.subarray(0, written);
	};

	// Directory.
	const dirBytes = readChain(view.readUInt32LE(48), Number.MAX_SAFE_INTEGER);
	interface RawEntry {
		name: string;
		type: number;
		left: number;
		right: number;
		child: number;
		start: number;
		size: number;
	}
	const raw: RawEntry[] = [];
	for (let o = 0; o + 128 <= dirBytes.length && raw.length < MAX_ENTRIES; o += 128) {
		const d = Buffer.from(dirBytes.buffer, dirBytes.byteOffset + o, 128);
		const nameLen = d.readUInt16LE(64);
		const name = nameLen >= 2 && nameLen <= 64 ? d.subarray(0, nameLen - 2).toString("utf16le") : "";
		const high = sectorShift === 9 ? 0 : d.readUInt32LE(124);
		raw.push({
			name,
			type: d[66] ?? 0,
			left: d.readUInt32LE(68),
			right: d.readUInt32LE(72),
			child: d.readUInt32LE(76),
			start: d.readUInt32LE(116),
			size: d.readUInt32LE(120) + high * 2 ** 32,
		});
	}
	const root = raw[0];
	if (root === undefined || root.type !== 5) return null;

	// Mini stream (held by the root entry) and the mini FAT.
	const miniStream = readChain(root.start, root.size);
	const miniFatBytes = readChain(view.readUInt32LE(60), view.readUInt32LE(64) * sectorSize);
	const miniFat: number[] = [];
	for (let o = 0; o + 4 <= miniFatBytes.length; o += 4) miniFat.push(Buffer.from(miniFatBytes.buffer, miniFatBytes.byteOffset + o, 4).readUInt32LE(0));
	const readMini = (start: number, size: number): Uint8Array => {
		const ids = chain(start, miniFat, Math.ceil(miniStream.length / miniSectorSize) + 1);
		const out = Buffer.alloc(Math.min(size, ids.length * miniSectorSize));
		let written = 0;
		for (const id of ids) {
			const offset = id * miniSectorSize;
			if (offset >= miniStream.length) break;
			const n = Math.min(miniSectorSize, out.length - written, miniStream.length - offset);
			Buffer.from(miniStream.buffer, miniStream.byteOffset + offset, n).copy(out, written);
			written += n;
			if (written >= out.length) break;
		}
		return out.subarray(0, written);
	};

	const built = new Map<number, CfbEntry>();
	const visiting = new Set<number>();
	const entry = (index: number): CfbEntry => {
		const cached = built.get(index);
		if (cached) return cached;
		const r = raw[index] as RawEntry;
		const children: CfbEntry[] = [];
		const node: CfbEntry = {
			name: r.name,
			type: r.type === 2 ? "stream" : "storage",
			size: r.type === 2 ? r.size : 0,
			children,
			child(name) {
				const lower = name.toLowerCase();
				return children.find((c) => c.name.toLowerCase() === lower);
			},
			read() {
				if (r.type !== 2 || r.size === 0) return new Uint8Array(0);
				return r.size < miniCutoff ? readMini(r.start, r.size) : readChain(r.start, r.size);
			},
		};
		built.set(index, node);
		if (r.type !== 2 && r.child !== NO_STREAM) {
			visiting.add(index);
			// In-order walk of the sibling tree rooted at the storage's child.
			const stack: number[] = [];
			const seen = new Set<number>();
			let current = r.child;
			while ((current !== NO_STREAM && current < raw.length) || stack.length > 0) {
				while (current !== NO_STREAM && current < raw.length && !seen.has(current)) {
					seen.add(current);
					stack.push(current);
					current = (raw[current] as RawEntry).left;
				}
				const top = stack.pop();
				if (top === undefined) break;
				const topEntry = raw[top] as RawEntry;
				if (!visiting.has(top) && (topEntry.type === 1 || topEntry.type === 2)) children.push(entry(top));
				current = topEntry.right;
				if (seen.has(current)) current = NO_STREAM;
			}
			visiting.delete(index);
		}
		return node;
	};
	return entry(0);
}
