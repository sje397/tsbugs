/**
 * Storing a world: the text format, and the browser storage it lives in.
 *
 * Upstream saved worlds as QDataStream binary with a bare leading version int
 * (`main_window.cpp:219`, written at `:337`), read at `>= 2` with a `>= 3` branch for
 * the newer fields — so it was versioned, but the version was a number with no format
 * name and the failure mode was one modal that could not tell a truncated file from a
 * foreign one. This format is deliberately not upstream's: a Qt-version-pinned private
 * serialisation is not part of the model, and reading it is not something anyone can
 * check. It names itself, so a wrong file is refused by name rather than by an
 * exception, and it refuses a version it does not know.
 *
 * FOUR DECISIONS WORTH THE READING
 *
 * 1. The genome is base64. It is the bulk of a world — 580,606 bytes across 98 bugs
 *    at tick 200, seed 2024, genomes from 4,106 to 8,064 bytes — and it does not
 *    compress, so the text would be 2,072,926 chars of JSON numbers against 774,272
 *    of base64. The grid arrays are the opposite: sparse and small, so they are
 *    written as [hash, value] pairs and can be read by eye.
 *
 * 2. The program is saved as a DIFF against the genome, not as a second copy. RAM is
 *    the genome until a STORE writes over it, so the two are equal byte for byte in
 *    almost every bug, and writing both would nearly double the file (774 kB of
 *    base64 each). Only the addresses a bug actually overwrote are written, as
 *    [address, byte] pairs.
 *
 * 3. The processor's inputs are NOT saved; its outputs are. Both look like the
 *    same kind of field and they are not: `Bug.update()` writes all twenty input
 *    slots before every `run()`, so a saved input can never be read, while a
 *    program that never executes OUT leaves `out` holding the previous tick's
 *    answer — which `Bug.update()` then reads as this tick's.
 *
 * 4. Nothing derived is saved. The palette arrays (`viewCol`, `bugCol`) are
 *    recomputed by a restore, because a saved copy of a rendering rule is a second
 *    copy of it.
 *
 * What is NOT here: a download or an upload. A world is handed out and taken back
 * as text by the caller, so this stays testable without a DOM.
 */

import type { WorldParams } from '../sim/params.js';
import { WORLD_SNAPSHOT_VERSION } from '../sim/dish.js';
import type { ViewMode, WorldSnapshot } from '../sim/dish.js';
import type { BugState } from '../sim/bug.js';

/** Marker so a stray string in storage is refused rather than parsed as a world. */
export const WORLD_FORMAT = 'tsbugs-world';

/** The shape version this build writes and the only one it reads. */
export const WORLD_FORMAT_VERSION = 1;

/** Keys are namespaced so the page's other preferences cannot collide with a world. */
export const WORLD_KEY_PREFIX = 'tsbugs.world.';

/** Long enough to say something, short enough that the list still reads. */
export const MAX_WORLD_NAME = 40;

/** The slice of `Storage` this needs — so a test can stand in for it. */
export interface WorldStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One entry in the list, as the panel shows it. */
export interface SavedWorld {
  name: string;
  /** Size of the stored text in characters — the honest cost, since storage counts them. */
  storedBytes: number;
  savedAt: string | null;
  tick: number | null;
  population: number | null;
  width: number | null;
  height: number | null;
  /** Set when the entry is there but unreadable, so one bad world cannot hide the rest. */
  problem: string | null;
}

// ------------------------------------------------------------------- base64

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse table for decoding, -1 for anything not in the alphabet. */
const B64_LOOKUP = ((): Int16Array => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  return table;
})();

/**
 * Base64, implemented here rather than taken from `btoa`/`atob`.
 *
 * Those two disagree across environments about what they accept (browsers throw
 * on a stray character, Node's decoder skips whitespace), and a world that decodes
 * in one place and not the other is a bug that only shows up in whichever
 * environment was not tested. Twenty lines and one behaviour, asserted in
 * test/worldStore.test.ts.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

/** Throws on padding in the wrong place, on a stray character, and on bad length. */
export function base64ToBytes(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new Error(`base64 length ${text.length} is not a multiple of 4`);
  let padding = 0;
  if (text.endsWith('==')) padding = 2;
  else if (text.endsWith('=')) padding = 1;

  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let out = 0;
  for (let i = 0; i < text.length; i += 4) {
    const chunk = [0, 1, 2, 3].map((k) => {
      const code = text.charCodeAt(i + k);
      if (code === 61) return 0; // '=' — position checked below
      const value = code < 128 ? B64_LOOKUP[code] : -1;
      if (value < 0) throw new Error(`base64 has an invalid character at ${i + k}`);
      return value;
    });
    const isLast = i + 4 === text.length;
    if (!isLast && (text.charCodeAt(i + 2) === 61 || text.charCodeAt(i + 3) === 61)) {
      throw new Error(`base64 has padding at ${i}, which is not the last group`);
    }
    const n = (chunk[0] << 18) | (chunk[1] << 12) | (chunk[2] << 6) | chunk[3];
    if (out < bytes.length) bytes[out++] = (n >> 16) & 255;
    if (out < bytes.length) bytes[out++] = (n >> 8) & 255;
    if (out < bytes.length) bytes[out++] = n & 255;
  }
  return bytes;
}

// ------------------------------------------------------------------- shapes

/** One bug, as the file carries it. Short keys because there are thousands. */
interface EncodedBug {
  /** Genome, base64. */
  g: string;
  /** Mutation rate. */
  m: number;
  d: number;
  c: number;
  s: number;
  a: number;
  /** Children. */
  k: number;
  /** Generation. */
  n: number;
  e: number;
  /** Marked — written only when true. */
  x?: 1;
  /**
   * Bytes the running program has stored over its own genome: [address, byte].
   *
   * Both arrays are saved, and this is why the second one is cheap. The machine's
   * memory starts as a copy of the genome and diverges wherever STORE or POPA
   * writes to it, so a save carrying only the genome would restore a bug whose
   * self-modifications were undone — and a save carrying only the memory would
   * restore a bug that had forgotten what its children inherit. Most bugs have
   * never stored anything, so most of these are absent.
   */
  r?: Array<[number, number]>;
  p: EncodedProcessor;
}

interface EncodedProcessor {
  /** Live stack contents (bytes 0..sp), base64. sp is this length. */
  st: string;
  ip: number;
  bp: number;
  /** Accumulator. */
  ac: number;
  /** The four outputs. */
  o: number[];
}

/** A world as the file carries it. */
interface EncodedWorld {
  format: string;
  version: number;
  params: WorldParams;
  counters: WorldSnapshot['counters'];
  view: { mode: ViewMode; showByte: number };
  /** [hash, value] for every non-zero cell. */
  energy: Array<[number, number]>;
  bugTotal: Array<[number, number]>;
  /** Hashes of poisoned cells. */
  poison: number[];
  cells: Array<{ h: number; b: EncodedBug[] }>;
}

/** The stored envelope: small enough to parse for a listing without touching the world. */
interface WorldEnvelope {
  format: string;
  name: string;
  savedAt: string;
  meta: { tick: number; population: number; width: number; height: number };
  /**
   * The encoded world, as a JSON *string* rather than as an object. Listing ten
   * worlds then costs ten small parses instead of ten half-megabyte ones, which is
   * the difference between a list that appears and a list that stalls the page.
   */
  world: string;
}

function sparsePairs(array: Int32Array): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let hash = 0; hash < array.length; hash++) {
    if (array[hash] !== 0) pairs.push([hash, array[hash]]);
  }
  return pairs;
}

function encodeBug(state: BugState): EncodedBug {
  const encoded: EncodedBug = {
    g: bytesToBase64(state.genome),
    m: state.mutationRate,
    d: state.dir,
    c: state.color,
    s: state.split,
    a: state.age,
    k: state.children,
    n: state.generation,
    e: state.energy,
    p: {
      st: bytesToBase64(state.processor.stack.slice(0, state.processor.sp)),
      ip: state.processor.ip,
      bp: state.processor.bp,
      ac: state.processor.accumulator,
      o: Array.from(state.processor.out),
    },
  };
  if (state.marked) encoded.x = 1;

  const { ram } = state.processor;
  if (ram.length !== state.genome.length) {
    throw new Error(
      `a bug's program is ${ram.length} bytes and its genome is ${state.genome.length} — ` +
      'this bug cannot be saved because it could not be restored',
    );
  }
  const diff: Array<[number, number]> = [];
  for (let address = 0; address < ram.length; address++) {
    if (ram[address] !== state.genome[address]) diff.push([address, ram[address]]);
  }
  if (diff.length > 0) encoded.r = diff;
  return encoded;
}

/** A world as text. Deterministic: the same snapshot always encodes to the same string. */
export function encodeWorld(snapshot: WorldSnapshot): string {
  const world: EncodedWorld = {
    format: WORLD_FORMAT,
    version: WORLD_FORMAT_VERSION,
    params: snapshot.params,
    counters: snapshot.counters,
    view: snapshot.view,
    energy: sparsePairs(snapshot.energy),
    bugTotal: sparsePairs(snapshot.bugTotal),
    poison: Array.from(snapshot.poison, (v, hash) => (v ? hash : -1)).filter((hash) => hash >= 0),
    cells: snapshot.cells.map((cell) => ({ h: cell.hash, b: cell.bugs.map(encodeBug) })),
  };
  return JSON.stringify(world);
}

// -------------------------------------------------------------- validation

const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const isByte = (value: unknown): value is number => isInteger(value) && value >= 0 && value <= 255;

/**
 * Read a field that must be an integer, naming it if it is not.
 *
 * Every check in this file exists so that a corrupt or hand-edited entry fails at
 * the field that is wrong. Loading a world that is silently half-right is the one
 * outcome worth this much code to prevent.
 */
function needInteger(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (!isInteger(value)) throw new Error(`${where}.${key} is not an integer`);
  return value;
}

function needByte(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (!isByte(value)) throw new Error(`${where}.${key} is not a byte`);
  return value;
}

function needRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

function needArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} is not an array`);
  return value;
}

function needString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`${where}.${key} is not a string`);
  return value;
}

function decodePairs(value: unknown, cellCount: number, where: string): Int32Array {
  const array = new Int32Array(cellCount);
  for (const entry of needArray(value, where)) {
    const pair = needArray(entry, `${where} entry`);
    if (pair.length !== 2) throw new Error(`${where} has an entry that is not a pair`);
    const hash = pair[0];
    const amount = pair[1];
    if (!isInteger(hash) || hash < 0 || hash >= cellCount) throw new Error(`${where} names cell ${String(hash)}`);
    if (!isInteger(amount)) throw new Error(`${where} gives cell ${hash} a non-integer amount`);
    if (array[hash] !== 0) throw new Error(`${where} lists cell ${hash} twice`);
    array[hash] = amount;
  }
  return array;
}

function decodeBug(value: unknown, stackSize: number, where: string): BugState {
  const bug = needRecord(value, where);
  const genome = base64ToBytes(needString(bug, 'g', where));

  const processor = needRecord(bug.p, `${where}.p`);
  const stackBytes = base64ToBytes(needString(processor, 'st', `${where}.p`));
  if (stackBytes.length > stackSize) {
    throw new Error(`${where} saved ${stackBytes.length} stack bytes but the stack is ${stackSize}`);
  }
  const stack = new Uint8Array(stackSize);
  stack.set(stackBytes);

  const out = needArray(processor.o, `${where}.p.o`).map((byte, index) => {
    if (!isByte(byte)) throw new Error(`${where}.p.o[${index}] is not a byte`);
    return byte;
  });
  if (out.length !== 4) throw new Error(`${where}.p.o has ${out.length} outputs, not 4`);

  // The machine's memory starts as a copy of the genome and diverges wherever the
  // program stores over itself; the file carries that divergence separately (see
  // EncodedBug.r), so restoring it here is what makes a saved bug run the same
  // program it was running.
  const ram = genome.slice();
  if (bug.r !== undefined) {
    for (const [index, entry] of needArray(bug.r, `${where}.r`).entries()) {
      const pair = needArray(entry, `${where}.r[${index}]`);
      if (pair.length !== 2) throw new Error(`${where}.r[${index}] is not a pair`);
      const address = pair[0];
      const byte = pair[1];
      if (!isInteger(address) || address < 0 || address >= ram.length) {
        throw new Error(`${where}.r[${index}] writes to ${String(address)}, outside a ${ram.length}-byte program`);
      }
      if (!isByte(byte)) throw new Error(`${where}.r[${index}] writes ${String(byte)}, which is not a byte`);
      ram[address] = byte;
    }
  }

  const ip = needInteger(processor, 'ip', `${where}.p`);
  if (ip >= ram.length) throw new Error(`${where}.p.ip ${ip} is past the end of a ${ram.length}-byte program`);

  return {
    genome,
    mutationRate: needNumber(bug, 'm', where),
    processor: {
      ram,
      stack,
      // Not saved: `Bug.update()` writes all twenty input slots before every run,
      // so a saved input could never be read. Zeros are the only honest value.
      inp: new Uint8Array(20),
      out: Uint8Array.from(out),
      ip,
      sp: stackBytes.length,
      bp: needInteger(processor, 'bp', `${where}.p`),
      accumulator: needByte(processor, 'ac', `${where}.p`),
    },
    dir: needInteger(bug, 'd', where),
    color: needInteger(bug, 'c', where),
    split: needInteger(bug, 's', where),
    age: needInteger(bug, 'a', where),
    children: needInteger(bug, 'k', where),
    generation: needInteger(bug, 'n', where),
    energy: needInteger(bug, 'e', where),
    marked: bug.x === 1,
  };
}

function needNumber(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where}.${key} is not a number`);
  return value;
}

/**
 * A saved world back into a snapshot, or a throw naming the first field that is
 * not what this format writes.
 *
 * Note where the line is: this checks *shape*, and `PetriDish.restore` checks
 * whether the shape describes a world that could exist (indices in range, a
 * population that matches the cells). Both refuse; neither pretends to be the
 * other.
 */
export function decodeWorld(text: string): WorldSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`not JSON: ${(error as Error).message}`);
  }
  // A file that is valid JSON but not an object is the commonest wrong-file case
  // (an array, a string, a number), and it deserves the sentence a person needs
  // rather than a field name.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('not a saved world: expected a JSON object');
  }
  const world = parsed as Record<string, unknown>;
  if (world.format !== WORLD_FORMAT) throw new Error(`not a saved world (format ${String(world.format)})`);
  if (world.version !== WORLD_FORMAT_VERSION) {
    throw new Error(`world format version ${String(world.version)}, but this build writes ${WORLD_FORMAT_VERSION}`);
  }

  const params = needRecord(world.params, 'world.params') as unknown as WorldParams;
  for (const key of ['width', 'height', 'stackSize'] as const) {
    if (!isInteger(params[key]) || params[key] <= 0) throw new Error(`world.params.${key} is ${String(params[key])}`);
  }
  const cellCount = params.width * params.height;

  const counters = needRecord(world.counters, 'world.counters');
  const view = needRecord(world.view, 'world.view');

  const cells: Array<{ hash: number; bugs: BugState[] }> = [];
  const seen = new Set<number>();
  for (const [index, entry] of needArray(world.cells, 'world.cells').entries()) {
    const cell = needRecord(entry, `world.cells[${index}]`);
    const hash = needInteger(cell, 'h', `world.cells[${index}]`);
    if (hash < 0 || hash >= cellCount) throw new Error(`world.cells[${index}] is cell ${hash} of ${cellCount}`);
    if (seen.has(hash)) throw new Error(`cell ${hash} is listed twice`);
    seen.add(hash);

    const bugs = needArray(cell.b, `world.cells[${index}].b`);
    if (bugs.length === 0) throw new Error(`cell ${hash} is listed with no bugs`);
    cells.push({
      hash,
      bugs: bugs.map((bug, at) => decodeBug(bug, params.stackSize, `cell ${hash} bug ${at}`)),
    });
  }

  return {
    // The MODEL's version, not the file's. The file's version was checked above and
    // the two are separate constants — a text format can change (a field renamed, a
    // number written as a string) without the snapshot shape moving at all. Handing
    // `PetriDish.restore` the file's number would make a decoder that has just
    // produced a current snapshot refuse it as an old one the moment they diverge.
    version: WORLD_SNAPSHOT_VERSION,
    params,
    counters: {
      time: needInteger(counters, 'time', 'world.counters'),
      maxGen: needInteger(counters, 'maxGen', 'world.counters'),
      maxAge: needInteger(counters, 'maxAge', 'world.counters'),
      population: needInteger(counters, 'population', 'world.counters'),
      bugEnergy: needInteger(counters, 'bugEnergy', 'world.counters'),
      energyEnergy: needInteger(counters, 'energyEnergy', 'world.counters'),
      births: needInteger(counters, 'births', 'world.counters'),
      deaths: needInteger(counters, 'deaths', 'world.counters'),
      injected: needInteger(counters, 'injected', 'world.counters'),
      stream: needInteger(counters, 'stream', 'world.counters'),
    },
    view: {
      mode: needInteger(view, 'mode', 'world.view') as ViewMode,
      showByte: needInteger(view, 'showByte', 'world.view'),
    },
    energy: decodePairs(world.energy, cellCount, 'world.energy'),
    bugTotal: decodePairs(world.bugTotal, cellCount, 'world.bugTotal'),
    poison: (() => {
      const poison = new Uint8Array(cellCount);
      needArray(world.poison, 'world.poison').forEach((hash, index) => {
        if (!isInteger(hash) || hash < 0 || hash >= cellCount) throw new Error(`world.poison[${index}] is ${String(hash)}`);
        if (poison[hash]) throw new Error(`poison lists cell ${hash} twice`);
        poison[hash] = 1;
      });
      return poison;
    })(),
    cells,
  };
}

// ------------------------------------------------------------------ storage

/** Names are keys, so the characters that matter are the ones that make a name unusable. */
export function isValidWorldName(name: string): boolean {
  return name.trim().length > 0 && name.length <= MAX_WORLD_NAME;
}

/**
 * Why a save failed, in a sentence a person can act on.
 *
 * Quota is the interesting one: a world is half a megabyte, browser storage is
 * about five, and the failure arrives as an exception from the platform whose
 * message is either a DOMException name or nothing useful at all. Saving silently
 * failing, or appearing to work, is the one outcome to rule out.
 */
function describeWriteFailure(error: unknown, name: string): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const quota = /quota|exceeded|storage/i.test(detail);
  if (quota) {
    return (
      `No room left in this browser's storage for "${name}". A populated world costs ` +
      'most of a megabyte and the whole store is a few megabytes — delete a world and ' +
      'try again. ' +
      `(${detail})`
    );
  }
  return `Could not save "${name}": ${detail}`;
}

/**
 * Write a world under a name, replacing one of the same name.
 *
 * Replaces rather than refusing: the caller asks the person first, because only
 * the caller knows whether they meant to overwrite. What this guarantees is that a
 * failed write leaves the previous world where it was — `setItem` either lands or
 * throws, so a quota failure cannot destroy the world it was replacing.
 */
export function saveWorld(storage: WorldStorage, name: string, snapshot: WorldSnapshot): SavedWorld {
  if (!isValidWorldName(name)) {
    throw new Error(`"${name}" is not a name this store accepts (1..${MAX_WORLD_NAME} characters)`);
  }
  const envelope: WorldEnvelope = {
    format: WORLD_FORMAT,
    name,
    savedAt: new Date().toISOString(),
    meta: {
      tick: snapshot.counters.time,
      population: snapshot.counters.population,
      width: snapshot.params.width,
      height: snapshot.params.height,
    },
    world: encodeWorld(snapshot),
  };
  const text = JSON.stringify(envelope);
  try {
    storage.setItem(WORLD_KEY_PREFIX + name, text);
  } catch (error) {
    throw new Error(describeWriteFailure(error, name));
  }
  return {
    name,
    storedBytes: text.length,
    savedAt: envelope.savedAt,
    tick: envelope.meta.tick,
    population: envelope.meta.population,
    width: envelope.meta.width,
    height: envelope.meta.height,
    problem: null,
  };
}

/**
 * The worlds in storage, newest first, each with a problem rather than an
 * exception when it cannot be read.
 *
 * A corrupt entry is listed with its problem: one bad world is a fact about that
 * world, and throwing would turn it into a fact about the whole store.
 */
export function listWorlds(storage: WorldStorage): SavedWorld[] {
  const found: SavedWorld[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(WORLD_KEY_PREFIX)) continue;
    const name = key.slice(WORLD_KEY_PREFIX.length);
    const text = storage.getItem(key) ?? '';

    const empty: SavedWorld = {
      name, storedBytes: text.length, savedAt: null, tick: null, population: null,
      width: null, height: null, problem: null,
    };

    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch (error) {
      found.push({ ...empty, problem: `unreadable: ${(error as Error).message}` });
      continue;
    }
    const record = envelope as Record<string, unknown>;
    if (typeof record !== 'object' || record === null || record.format !== WORLD_FORMAT) {
      found.push({ ...empty, problem: 'not a saved world' });
      continue;
    }
    // A listing is a claim about what can be loaded, so an entry that parses but
    // cannot be handed to decodeWorld is a problem rather than a row of nulls with
    // a Load button beside it. Both fields are what loadWorld insists on.
    if (typeof record.world !== 'string' || record.world === '') {
      found.push({ ...empty, problem: 'incomplete: carries no world' });
      continue;
    }
    if (typeof record.meta !== 'object' || record.meta === null) {
      found.push({ ...empty, problem: 'incomplete: carries no meta' });
      continue;
    }
    const meta = record.meta as Record<string, unknown>;
    found.push({
      ...empty,
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : null,
      tick: isInteger(meta.tick) ? meta.tick : null,
      population: isInteger(meta.population) ? meta.population : null,
      width: isInteger(meta.width) ? meta.width : null,
      height: isInteger(meta.height) ? meta.height : null,
    });
  }

  // Newest first, and anything undated last rather than first: a name is not a date.
  return found.sort((a, b) => {
    if (a.savedAt === null || b.savedAt === null) return (a.savedAt === null ? 1 : 0) - (b.savedAt === null ? 1 : 0);
    return b.savedAt.localeCompare(a.savedAt);
  });
}

/**
 * The stored text of one world, or null if there is no such entry.
 *
 * The inner world text, not the envelope: what comes back is what `encodeWorld`
 * writes and `decodeWorld` reads, so a world taken out of storage and a world read
 * from a file are the same string in the same format. The envelope — the name, the
 * timestamp, the listing fields — is storage's own business and does not travel.
 */
export function readWorldText(storage: WorldStorage, name: string): string | null {
  const text = storage.getItem(WORLD_KEY_PREFIX + name);
  if (text === null) return null;

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw new Error(`saved world "${name}" is unreadable: ${(error as Error).message}`);
  }
  const record = envelope as Record<string, unknown>;
  if (typeof record !== 'object' || record === null || record.format !== WORLD_FORMAT) {
    throw new Error(`saved world "${name}" is not a saved world`);
  }
  if (typeof record.world !== 'string') throw new Error(`saved world "${name}" carries no world`);

  // Returning a damaged world's text would defer the failure to a second call, so
  // the check happens at the same distance from the edit as everything else here:
  // a saved world that cannot be decoded is refused where it is read.
  decodeWorld(record.world);
  return record.world;
}

/**
 * A saved world as a snapshot, or null if there is no such entry.
 *
 * Two failures, kept apart: absent is null, and present-but-unreadable throws. A
 * caller that conflated them would report a corrupt world as a missing one, which
 * is the direction that tells someone to stop looking.
 */
export function loadWorld(storage: WorldStorage, name: string): WorldSnapshot | null {
  const text = readWorldText(storage, name);
  return text === null ? null : decodeWorld(text);
}

/** Delete an entry. Returns whether there was one. */
export function deleteWorld(storage: WorldStorage, name: string): boolean {
  const key = WORLD_KEY_PREFIX + name;
  if (storage.getItem(key) === null) return false;
  storage.removeItem(key);
  return true;
}

/** Total characters this store's worlds cost — what a quota is measured against. */
export function storageUsed(storage: WorldStorage): number {
  let total = 0;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(WORLD_KEY_PREFIX)) continue;
    total += key.length + (storage.getItem(key)?.length ?? 0);
  }
  return total;
}
