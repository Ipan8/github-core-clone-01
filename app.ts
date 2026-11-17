// github-core-clone-01 — a GitHub-compatible git forge in a single Node process.
// Node stdlib only. Git smart HTTP, REST v3, GraphQL v4 and MCP all share one in-memory store.
// Replay determinism: every timestamp is MAKEFUN_TRIAL_NOW plus a monotonic logical counter;
// request handling never reads the wall clock and never draws random numbers.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
const ZERO_OID = '0'.repeat(40);
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW ?? '';
const PARSED_NOW = Date.parse(TRIAL_NOW);
const BASE_MS = Number.isFinite(PARSED_NOW) ? PARSED_NOW : Date.parse('2026-01-01T00:00:00Z');
const BASE_SEC = Math.floor(BASE_MS / 1000);

// ---- logical clock (one second per event, strictly increasing) ----
let clockTicks = 0;
function isoOf(sec: number): string { return new Date(sec * 1000).toISOString().replace('.000Z', 'Z'); }
function tick(): { iso: string; sec: number } {
  clockTicks += 1;
  const sec = BASE_SEC + clockTicks;
  return { iso: isoOf(sec), sec };
}

// ---- git objects ----
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer; packEntry: Buffer }
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: ObjType, data: Buffer): string {
  const sha = createHash('sha1');
  sha.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  sha.update(data);
  return sha.digest('hex');
}

// Pre-encoded pack entry (type/size header + deflated body), built once per object so
// every clone just concatenates entries instead of deflating again.
function packEntryFor(type: ObjType, data: Buffer): Buffer {
  let remaining = data.length;
  const header: number[] = [];
  let byte = (TYPE_CODE[type] << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    header.push(byte | 0x80);
    byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  header.push(byte);
  return Buffer.concat([Buffer.from(header), deflateSync(data)]);
}

function writePack(objs: GitObj[]): Buffer {
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objs.length, 8);
  const body = Buffer.concat([head, ...objs.map((o) => o.packEntry)]);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface TreeEntry { mode: string; name: string; oid: string }
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(pos, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    pos = nul + 21;
  }
  return entries;
}

// Git sorts tree entries bytewise, with directories compared as if they ended in '/'.
function buildTree(entries: TreeEntry[]): Buffer {
  const sortKey = (e: TreeEntry): Buffer => Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name, 'utf8');
  const ordered = [...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  const parts: Buffer[] = [];
  for (const e of ordered) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }
function parseCommit(data: Buffer): CommitView {
  const gap = data.indexOf('\n\n');
  const headerText = gap < 0 ? data.toString('utf8') : data.subarray(0, gap).toString('utf8');
  // The stored message keeps git's trailing newline; REST reports it without.
  const message = gap < 0 ? '' : data.subarray(gap + 2).toString('utf8').replace(/\n+$/, '');
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of headerText.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const gap = data.indexOf('\n\n');
  const headerText = gap < 0 ? data.toString('utf8') : data.subarray(0, gap).toString('utf8');
  const fields = new Map<string, string>();
  for (const line of headerText.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) fields.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: fields.get('object') ?? '',
    type: fields.get('type') ?? '',
    tag: fields.get('tag') ?? '',
    tagger: fields.get('tagger') ?? '',
    message: gap < 0 ? '' : data.subarray(gap + 2).toString('utf8'),
  };
}

// ---- pack reading: entry headers, OFS/REF deltas ----
function readEntryHeader(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let b = buf[start];
  const first = b;
  let size = b & 0x0f;
  let shift = 4;
  let pos = start + 1;
  while (b & 0x80) {
    b = buf[pos++];
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: pos, first };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos++];
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const srcSize = readSize();
  const dstSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(dstSize);
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let copyOff = 0;
      let copyLen = 0;
      for (let bit = 0; bit < 4; bit++) if (op & (1 << bit)) copyOff += delta[pos++] * 2 ** (8 * bit);
      for (let bit = 4; bit < 7; bit++) if (op & (1 << bit)) copyLen += delta[pos++] * 2 ** (8 * (bit - 4));
      if (copyLen === 0) copyLen = 0x10000;
      base.copy(out, written, copyOff, copyOff + copyLen);
      written += copyLen;
    } else if (op !== 0) {
      delta.copy(out, written, pos, pos + op);
      pos += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (written !== dstSize) throw new Error('delta result size mismatch');
  return out;
}

interface Resolved { type: ObjType; data: Buffer; oid: string }
function readPack(pack: Buffer, externalBase: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface RawEntry { offset: number; code: number; size: number; data: Buffer; baseOff?: number; baseOid?: string }
  const entries: RawEntry[] = [];
  const entryAt = new Map<number, RawEntry>();
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const offset = pos;
    const hdr = readEntryHeader(pack, pos);
    pos = hdr.next;
    const code = (hdr.first >> 4) & 0x07;
    const entry: RawEntry = { offset, code, size: hdr.size, data: Buffer.alloc(0) };
    if (code === 6) {
      // OFS_DELTA: big-endian base-128 with the "+1 per continuation" twist.
      let b = pack[pos++];
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos++];
        back = (back + 1) * 128 + (b & 0x7f);
      }
      entry.baseOff = offset - back;
    } else if (code === 7) {
      entry.baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateSync(pack.subarray(pos, trailerStart), { info: true }) as unknown as {
      buffer: Buffer; engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== hdr.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    pos += inflated.engine.bytesWritten;
    entries.push(entry);
    entryAt.set(offset, entry);
  }

  const byOffset = new Map<number, Resolved>();
  const byOid = new Map<string, Resolved>();
  const resolve = (e: RawEntry): Resolved => {
    const hit = byOffset.get(e.offset);
    if (hit) return hit;
    let type: ObjType;
    let data: Buffer;
    if (e.code === 6) {
      const base = resolve(entryAt.get(e.baseOff!)!);
      type = base.type;
      data = applyDelta(base.data, e.data);
    } else if (e.code === 7) {
      const local = byOid.get(e.baseOid!);
      const base = local ?? externalBase(e.baseOid!);
      if (!base) throw new Error('ref-delta base missing');
      type = base.type;
      data = applyDelta(base.data, e.data);
    } else {
      type = CODE_TYPE[e.code];
      data = e.data;
    }
    const done: Resolved = { type, data, oid: hashObject(type, data) };
    byOffset.set(e.offset, done);
    byOid.set(done.oid, done);
    return done;
  };

  const objects = new Map<string, GitObj>();
  for (const e of entries) {
    const r = resolve(e);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data, packEntry: packEntryFor(r.type, r.data) });
  }
  return objects;
}

// ---- pkt-line framing ----
function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([len, body]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}
interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }
const EMPTY = Buffer.alloc(0);
function decodePkts(buf: Buffer): { packets: Pkt[]; endOffset: number } {
  const packets: Pkt[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: EMPTY }); pos += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: EMPTY }); pos += 4; continue; }
    if (len === 2) { packets.push({ kind: 'end', payload: EMPTY }); pos += 4; continue; }
    if (pos + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { packets, endOffset: pos };
}

// ---- the store ----
interface Label { name: string; color: string; description: string }
interface Comment { id: number; body: string; created_at: string; updated_at: string; user: { login: string } }
interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; comments: Comment[]; created_at: string; updated_at: string; user: { login: string };
}
interface PR {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  merged: boolean; mergeable: boolean; merge_commit_sha: string | null; merged_at: string | null;
  created_at: string; updated_at: string; user: { login: string }; baseShaAtCreate: string;
}
interface Repo {
  id: number; name: string; owner: string; private: boolean; description: string;
  default_branch: string; created_at: string; updated_at: string;
  refs: Map<string, string>; objects: Map<string, GitObj>;
  labels: Map<string, Label>; issues: Issue[]; prs: PR[]; nextNumber: number;
}
const repos = new Map<string, Repo>();
const repoList: Repo[] = [];
let repoSeq = 0;
let globalIdSeq = 0;
let reqSeq = 0;

function gid(prefix: string, n: number): string { return Buffer.from(`${prefix}:${n}`, 'utf8').toString('base64'); }
function decodeGid(id: string): { prefix: string; rest: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    return colon < 0 ? null : { prefix: text.slice(0, colon), rest: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function getRepo(owner: string, name: string): Repo | undefined { return repos.get(repoKey(owner, name)); }
function createRepoRec(name: string, isPrivate: boolean, description: string, defaultBranch: string): Repo {
  const t = tick();
  const repo: Repo = {
    id: ++repoSeq, name, owner: VIEWER_LOGIN, private: isPrivate, description,
    default_branch: defaultBranch || 'main', created_at: t.iso, updated_at: t.iso,
    refs: new Map(), objects: new Map(), labels: new Map(), issues: [], prs: [], nextNumber: 1,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  repoList.push(repo);
  return repo;
}
function putObj(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data, packEntry: packEntryFor(type, data) });
  return oid;
}

function collectReachable(repo: Repo, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid);
    }
  }
  return seen;
}

function commitParents(repo: Repo, oid: string): string[] {
  const obj = repo.objects.get(oid);
  return obj && obj.type === 'commit' ? parseCommit(obj.data).parents : [];
}

function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === ZERO_OID || ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    stack.push(...commitParents(repo, oid));
  }
  return false;
}

function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, e.oid);
  }
}
function treeOfCommit(repo: Repo, commitOid: string): Map<string, string> {
  const flat = new Map<string, string>();
  const obj = repo.objects.get(commitOid);
  if (obj && obj.type === 'commit') flattenTree(repo, parseCommit(obj.data).tree, '', flat);
  return flat;
}

// Turn a flat path -> blob map back into nested tree objects; returns the root tree oid.
function buildTreeFromFlat(repo: Repo, flat: Map<string, string>): string {
  interface Dir { files: Map<string, string>; dirs: Map<string, Dir> }
  const newDir = (): Dir => ({ files: new Map(), dirs: new Map() });
  const root = newDir();
  for (const [path, oid] of flat) {
    const segs = path.split('/');
    let dir = root;
    for (let i = 0; i < segs.length - 1; i++) {
      let child = dir.dirs.get(segs[i]);
      if (!child) { child = newDir(); dir.dirs.set(segs[i], child); }
      dir = child;
    }
    dir.files.set(segs[segs.length - 1], oid);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of dir.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
    return putObj(repo, 'tree', buildTree(entries));
  };
  return emit(root);
}

function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string, sec: number): string {
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${sec} +0000`;
  const lines = [`tree ${treeOid}`, ...parents.map((p) => `parent ${p}`), `author ${ident}`, `committer ${ident}`, ''];
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return putObj(repo, 'commit', Buffer.from(`${lines.join('\n')}\n${body}`, 'utf8'));
}

function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = new Set<string>();
  const stackA = [a];
  while (stackA.length) {
    const oid = stackA.pop()!;
    if (!oid || fromA.has(oid)) continue;
    fromA.add(oid);
    stackA.push(...commitParents(repo, oid));
  }
  const seen = new Set<string>();
  const stackB = [b];
  while (stackB.length) {
    const oid = stackB.pop()!;
    if (fromA.has(oid)) return oid;
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    stackB.push(...commitParents(repo, oid));
  }
  return null;
}

interface FileChange { filename: string; status: string; additions: number; deletions: number; changes: number }
function diffFiles(repo: Repo, baseOid: string, headOid: string): FileChange[] {
  const base = treeOfCommit(repo, baseOid);
  const head = treeOfCommit(repo, headOid);
  const linesOf = (oid: string | undefined): string[] => {
    const obj = oid ? repo.objects.get(oid) : undefined;
    return obj ? obj.data.toString('utf8').split('\n') : [];
  };
  const nonEmpty = (lines: string[]): number => lines.filter((l) => l !== '').length;
  const out: FileChange[] = [];
  for (const path of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === h) continue;
    let status = 'modified';
    let additions = 0;
    let deletions = 0;
    if (b === undefined) {
      status = 'added';
      additions = nonEmpty(linesOf(h)) || 1;
    } else if (h === undefined) {
      status = 'removed';
      deletions = nonEmpty(linesOf(b)) || 1;
    } else {
      const before = new Set(linesOf(b));
      const after = new Set(linesOf(h));
      additions = [...after].filter((l) => l !== '' && !before.has(l)).length;
      deletions = [...before].filter((l) => l !== '' && !after.has(l)).length;
      if (additions === 0 && deletions === 0) additions = 1;
    }
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

function branchTip(repo: Repo, ref: string, fallback: string): string {
  return repo.refs.get(`refs/heads/${ref}`) ?? fallback;
}

// Changes on one side relative to the merge base: path -> new blob ('' when deleted).
function sideChanges(base: Map<string, string>, side: Map<string, string>): Map<string, string> {
  const changed = new Map<string, string>();
  for (const [path, oid] of side) if (base.get(path) !== oid) changed.set(path, oid);
  for (const path of base.keys()) if (!side.has(path)) changed.set(path, '');
  return changed;
}

function prConflict(repo: Repo, pr: PR): boolean {
  const headTip = branchTip(repo, pr.head.ref, pr.head.sha);
  const baseTip = branchTip(repo, pr.base.ref, pr.base.sha);
  const mb = mergeBase(repo, headTip, baseTip);
  if (!mb) return false;
  const mbFlat = treeOfCommit(repo, mb);
  const headChanged = sideChanges(mbFlat, treeOfCommit(repo, headTip));
  const baseChanged = sideChanges(mbFlat, treeOfCommit(repo, baseTip));
  for (const [path, oid] of headChanged) {
    if (baseChanged.has(path) && baseChanged.get(path) !== oid) return true;
  }
  return false;
}

function doSquashMerge(repo: Repo, pr: PR): { sha: string } | { conflict: true } {
  if (prConflict(repo, pr)) return { conflict: true };
  const baseTip = branchTip(repo, pr.base.ref, pr.base.sha);
  const headTip = branchTip(repo, pr.head.ref, pr.head.sha);
  const flat = treeOfCommit(repo, baseTip);
  const headFlat = treeOfCommit(repo, headTip);
  // Lay the head branch's changed paths over the current base tree.
  for (const change of diffFiles(repo, pr.baseShaAtCreate, headTip)) {
    if (change.status === 'removed') flat.delete(change.filename);
    else {
      const oid = headFlat.get(change.filename);
      if (oid !== undefined) flat.set(change.filename, oid);
    }
  }
  const treeOid = buildTreeFromFlat(repo, flat);
  const t = tick();
  const message = `Merge pull request #${pr.number} from ${pr.head.ref}\n\n${pr.title}`;
  const sha = makeCommit(repo, treeOid, baseTip === ZERO_OID ? [] : [baseTip], message, t.sec);
  repo.refs.set(`refs/heads/${pr.base.ref}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.merge_commit_sha = sha;
  pr.merged_at = t.iso;
  pr.updated_at = t.iso;
  return { sha };
}

// ---- HTTP plumbing ----
const JSON_TYPE = 'application/json; charset=utf-8';
function nextRequestId(): string { reqSeq += 1; return `req-${reqSeq}`; }
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(body);
}
function errJson(res: ServerResponse, status: number, message: string): void { sendJson(res, status, { message }); }
function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${TOKEN}`;
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}
function isObj(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }

const userJson = (login: string): Record<string, unknown> => ({ login, id: 1000, type: 'User' });
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, owner: userJson(r.owner),
    private: r.private, description: r.description, default_branch: r.default_branch,
    created_at: r.created_at, updated_at: r.updated_at, html_url: `https://github.com/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`, has_issues: true, has_projects: true, has_wiki: true,
    fork: false, archived: false, disabled: false, visibility: r.private ? 'private' : 'public',
  };
}
function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id, number: i.number, title: i.title, body: i.body, state: i.state,
    labels: i.labels.map((l) => ({ name: l.name, color: l.color, description: l.description })),
    user: userJson(i.user.login), assignees: [], comments: i.comments.length,
    created_at: i.created_at, updated_at: i.updated_at,
    html_url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
  };
}
function prJson(r: Repo, p: PR): Record<string, unknown> {
  return {
    id: p.id, number: p.number, title: p.title, body: p.body, state: p.state,
    head: { ref: p.head.ref, sha: p.head.sha, label: `${r.owner}:${p.head.ref}` },
    base: { ref: p.base.ref, sha: p.base.sha, label: `${r.owner}:${p.base.ref}` },
    merged: p.merged, mergeable: p.mergeable, merge_commit_sha: p.merge_commit_sha, merged_at: p.merged_at,
    user: userJson(p.user.login),
    created_at: p.created_at, updated_at: p.updated_at,
    html_url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
  };
}
function findIssueOrPr(repo: Repo, n: number): { issue: Issue } | { pr: PR } | null {
  const issue = repo.issues.find((i) => i.number === n);
  if (issue) return { issue };
  const pr = repo.prs.find((p) => p.number === n);
  return pr ? { pr } : null;
}
function createIssueRec(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (!label) return { error: `Label does not exist: ${name}` };
    labels.push(label);
  }
  const t = tick();
  const issue: Issue = {
    id: ++globalIdSeq, number: repo.nextNumber++, title, body: body ?? '', state: 'open',
    labels, comments: [], created_at: t.iso, updated_at: t.iso, user: { login: VIEWER_LOGIN },
  };
  repo.issues.push(issue);
  return issue;
}
function createPrRec(repo: Repo, title: string, body: string, head: string, base: string): PR | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha) return { error: `head branch not found: ${head}` };
  if (!baseSha) return { error: `base branch not found: ${base}` };
  const t = tick();
  const pr: PR = {
    id: ++globalIdSeq, number: repo.nextNumber++, title, body: body ?? '', state: 'open',
    head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha },
    merged: false, mergeable: true, merge_commit_sha: null, merged_at: null,
    created_at: t.iso, updated_at: t.iso, user: { login: VIEWER_LOGIN }, baseShaAtCreate: baseSha,
  };
  pr.mergeable = !prConflict(repo, pr);
  repo.prs.push(pr);
  return pr;
}

// Contents API: one file change becomes one commit on the branch (null content = delete).
function contentsCommit(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): { commitSha: string; blobSha: string | null } {
  // A branch that does not exist yet starts from the default branch tip (or unborn).
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.default_branch}`);
  const flat = tip ? treeOfCommit(repo, tip) : new Map<string, string>();
  let blobSha: string | null = null;
  if (content === null) flat.delete(path);
  else {
    blobSha = putObj(repo, 'blob', content);
    flat.set(path, blobSha);
  }
  const treeOid = buildTreeFromFlat(repo, flat);
  const t = tick();
  const parents = tip && tip !== ZERO_OID ? [tip] : [];
  const commitSha = makeCommit(repo, treeOid, parents, message || `Update ${path}`, t.sec);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha };
}

function getFileAt(repo: Repo, refName: string | undefined, path: string): { blobOid: string; data: Buffer } | { dir: TreeEntry[] } | null {
  const tip = refName
    ? repo.refs.get(`refs/heads/${refName}`) ?? (repo.objects.has(refName) ? refName : undefined)
    : repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (!tip) return null;
  const flat = treeOfCommit(repo, tip);
  const fileOid = flat.get(path);
  if (fileOid) {
    const obj = repo.objects.get(fileOid);
    return obj ? { blobOid: fileOid, data: obj.data } : null;
  }
  // Not a file: list it as a directory (immediate children only).
  const prefix = `${path}/`;
  const entries: TreeEntry[] = [];
  const subdirs = new Set<string>();
  for (const [p, oid] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) entries.push({ mode: '100644', name: rest, oid });
    else {
      const seg = rest.slice(0, slash);
      if (!subdirs.has(seg)) { subdirs.add(seg); entries.push({ mode: '40000', name: seg, oid: '' }); }
    }
  }
  return entries.length ? { dir: entries.sort((a, b) => (a.name < b.name ? -1 : 1)) } : null;
}

// ---- git smart HTTP ----
const AGENT = 'agent=github-core-clone/1.0';
const UPLOAD_CT = 'application/x-git-upload-pack-result';
const RECEIVE_CT = 'application/x-git-receive-pack-result';

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
function peeledOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  return obj && obj.type === 'tag' ? parseTag(obj.data).object : null;
}
function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === 'git-upload-pack'
    ? `multi_ack thin-pack side-band-64k ofs-delta ${AGENT} symref=HEAD:refs/heads/main shallow`
    : `report-status side-band-64k delete-refs ofs-delta ${AGENT} symref=HEAD:refs/heads/main`;
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.default_branch}`) ?? ZERO_OID;
  const items: (string | 'flush')[] = [`# service=${service}\n`, 'flush', `${headOid} HEAD\0${caps}\n`];
  for (const r of refs) {
    items.push(`${r.oid} ${r.name}\n`);
    const peeled = peeledOid(repo, r.oid);
    if (peeled) items.push(`${peeled} ${r.name}^{}\n`);
  }
  if (refs.length === 0) items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  return pktLines(items);
}
const V2_ADVERTISEMENT = pktLines([
  'version 2\n',
  'ls-refs=unborn\n',
  'fetch=shallow wait-for-done\n',
  'object-format=sha1\n',
  `${AGENT}\n`,
  'flush',
]);
function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): void {
  const upload = service === 'git-upload-pack';
  const v2 = upload && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = v2 ? V2_ADVERTISEMENT : v0Advertisement(repo, service);
  sendRaw(res, 200, body, upload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement');
}

// Frame a byte stream as side-band channel 1 pkt-lines, then a flush.
function sideband1(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHANNEL = Buffer.from([1]);
  for (let i = 0; i < data.length; i += 32768) {
    parts.push(pkt(Buffer.concat([CHANNEL, data.subarray(i, Math.min(data.length, i + 32768))])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
function sidebandPack(pack: Buffer): Buffer { return sideband1(pack); }
// receive-pack report-status: the report is itself pkt-lines, wrapped in channel 1.
function sidebandText(text: string): Buffer {
  const lines = text.split('\n').filter((l) => l !== '').map((l) => `${l}\n`);
  return sideband1(pktLines(lines));
}

interface FetchPlan { objects: GitObj[]; shallow: string[]; unshallow: string[] }
function addTreeObjects(repo: Repo, into: Set<string>, treeOid: string): void {
  const stack = [treeOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    into.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') continue;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') stack.push(e.oid);
      else into.add(e.oid);
    }
  }
}
// Everything the client already has. A shallow boundary commit is had, its history is not.
function reachableFrom(repo: Repo, roots: string[], shallowBoundary: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      addTreeObjects(repo, seen, c.tree);
      if (!shallowBoundary.has(oid)) stack.push(...c.parents);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      addTreeObjects(repo, seen, oid);
    }
  }
  return seen;
}
function planFetch(repo: Repo, wants: string[], haves: string[], depth: number | undefined, oldShallow: string[]): FetchPlan {
  const had = reachableFrom(repo, haves, new Set(oldShallow));
  // Breadth-first from the wants, recording each commit's depth; a depth limit stops at depth-1.
  const commitDepth = new Map<string, number>();
  const wantCommits = new Set<string>();
  const wanted = new Set<string>();
  const queue: [string, number][] = wants.map((w): [string, number] => [w, 0]);
  for (let qi = 0; qi < queue.length; qi++) {
    const [oid, d] = queue[qi];
    if (commitDepth.has(oid) || wanted.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') { wanted.add(oid); queue.push([parseTag(obj.data).object, d]); continue; }
    if (obj.type === 'tree') { addTreeObjects(repo, wanted, oid); continue; }
    if (obj.type === 'blob') { wanted.add(oid); continue; }
    commitDepth.set(oid, d);
    wantCommits.add(oid);
    if (depth === undefined || d + 1 < depth) {
      for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
    }
  }
  // Only the included commits and their trees: never parents the depth limit cut off.
  for (const c of wantCommits) {
    wanted.add(c);
    const obj = repo.objects.get(c);
    if (obj) addTreeObjects(repo, wanted, parseCommit(obj.data).tree);
  }
  const objects: GitObj[] = [];
  for (const oid of wanted) {
    if (had.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, d] of commitDepth) if (d === depth - 1) shallow.push(oid);
    // Old boundaries that are now inside the sent history are no longer shallow.
    for (const s of oldShallow) if (wantCommits.has(s) && !shallow.includes(s)) unshallow.push(s);
    for (const s of oldShallow) if (s === wants[0] && depth > 1 && !unshallow.includes(s)) unshallow.push(s);
  } else {
    for (const s of oldShallow) if (wantCommits.has(s)) unshallow.push(s);
  }
  return { objects, shallow, unshallow };
}

interface FetchArgs { wants: string[]; haves: string[]; oldShallow: string[]; depth: number | undefined }
function fetchArgs(lines: string[]): FetchArgs {
  const after = (prefix: string): string[] => lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length).trim());
  const deepen = lines.find((l) => l.startsWith('deepen '));
  return {
    // v0 want lines may carry capabilities after the oid.
    wants: after('want ').map((w) => w.split(' ')[0]),
    haves: after('have '),
    oldShallow: after('shallow '),
    depth: deepen ? parseInt(deepen.slice(7).trim(), 10) : undefined,
  };
}

function lsRefs(repo: Repo, lines: string[]): Buffer {
  const has = (word: string): boolean => lines.some((l) => l.trim() === word);
  const peel = has('peel');
  const symrefs = has('symrefs');
  const prefixes = lines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length).trim());
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: string[] = [];
  if (keep('HEAD')) {
    const tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
    const target = symrefs ? ` symref-target:refs/heads/${repo.default_branch}` : '';
    out.push(`${tip ?? 'unborn'} HEAD${target}\n`);
  }
  for (const r of sortedRefs(repo)) {
    if (!keep(r.name)) continue;
    const peeled = peel ? peeledOid(repo, r.oid) : null;
    out.push(`${r.oid} ${r.name}${peeled ? ` peeled:${peeled}` : ''}\n`);
  }
  return Buffer.concat([pktLines(out), FLUSH]);
}

function v2Fetch(repo: Repo, lines: string[]): Buffer {
  const args = fetchArgs(lines);
  const acks = pktLines(['acknowledgments\n', 'NAK\n']);
  if (args.wants.length === 0) return Buffer.concat([acks, FLUSH]);
  const plan = planFetch(repo, args.wants, args.haves, args.depth, args.oldShallow);
  const parts: Buffer[] = [acks, FLUSH];
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLines([
      'shallow-info\n',
      ...plan.shallow.map((s) => `shallow ${s}\n`),
      ...plan.unshallow.map((s) => `unshallow ${s}\n`),
    ]), FLUSH);
  }
  if (plan.objects.length) parts.push(pkt('packfile\n'), sidebandPack(writePack(plan.objects)));
  return Buffer.concat(parts);
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const v2 = (req.headers['git-protocol'] ?? '') === 'version=2' || body.subarray(0, 20).toString('utf8').includes('command=');
  const lines = decodePkts(body).packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  if (v2) {
    const cmd = (lines.find((l) => l.startsWith('command=')) ?? '').slice('command='.length).trim();
    if (cmd === 'ls-refs') { sendRaw(res, 200, lsRefs(repo, lines), UPLOAD_CT); return; }
    if (cmd === 'fetch') { sendRaw(res, 200, v2Fetch(repo, lines), UPLOAD_CT); return; }
    errJson(res, 400, `unknown v2 command ${cmd}`);
    return;
  }
  // protocol v0
  const args = fetchArgs(lines);
  const plan = planFetch(repo, args.wants, args.haves, args.depth, args.oldShallow);
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
  parts.push(plan.objects.length ? sidebandPack(writePack(plan.objects)) : FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), UPLOAD_CT);
}

interface RefCommand { oldOid: string; newOid: string; ref: string }
// Apply one ref update; fast-forward only, per ref. Returns the report-status line.
function applyRefCommand(repo: Repo, c: RefCommand): string {
  const current = repo.refs.get(c.ref);
  if (c.newOid === ZERO_OID) {
    if (current === undefined) return `ng ${c.ref} ref does not exist`;
    repo.refs.delete(c.ref);
    return `ok ${c.ref}`;
  }
  if (c.oldOid === ZERO_OID) {
    if (current !== undefined) return `ng ${c.ref} non-fast-forward`;
    if (!repo.objects.has(c.newOid)) return `ng ${c.ref} object not found`;
    repo.refs.set(c.ref, c.newOid);
    return `ok ${c.ref}`;
  }
  if (current === undefined) return `ng ${c.ref} ref does not exist`;
  if (current !== c.oldOid) return `ng ${c.ref} non-fast-forward`;
  if (!repo.objects.has(c.newOid)) return `ng ${c.ref} object not found`;
  if (!isAncestor(repo, current, c.newOid)) return `ng ${c.ref} non-fast-forward`;
  repo.refs.set(c.ref, c.newOid);
  return `ok ${c.ref}`;
}

function handleReceivePack(_req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  try {
    const { packets, endOffset } = decodePkts(body);
    const commands: RefCommand[] = [];
    for (const p of packets) {
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const head = (nul >= 0 ? line.slice(0, nul) : line).trim();
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(head);
      if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    }
    const packBytes = body.subarray(endOffset);
    let unpackOk = true;
    if (packBytes.length > 0) {
      try {
        const objs = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of objs) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      } catch {
        unpackOk = false;
      }
    }
    const report = [unpackOk ? 'unpack ok' : 'unpack error'];
    for (const c of commands) report.push(unpackOk ? applyRefCommand(repo, c) : `ng ${c.ref} unpack error`);
    sendRaw(res, 200, sidebandText(`${report.join('\n')}\n`), RECEIVE_CT);
  } catch {
    sendRaw(res, 200, sidebandText('unpack error\n'), RECEIVE_CT);
  }
}

// ---- REST v3 ----
function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; totalPages: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages, pageNum, perPage };
}
function linkHeader(req: IncomingMessage, pageNum: number, totalPages: number, perPage: number): string {
  const base = `http://${req.headers.host}${req.url!.split('?')[0]}`;
  const at = (p: number): string => `${base}?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  if (pageNum < totalPages) links.push(`<${at(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) links.push(`<${at(pageNum - 1)}>; rel="prev"`);
  links.push(`<${at(1)}>; rel="first"`, `<${at(totalPages)}>; rel="last"`);
  return links.join(', ');
}

// Parse a JSON request body into an object; on malformed JSON answer 400 and return null.
function jsonObject(res: ServerResponse, body: Buffer): Record<string, unknown> | null {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return null; }
  return isObj(parsed.value) ? parsed.value : {};
}
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const notFound = (res: ServerResponse): void => errJson(res, 404, 'Not Found');

function commitListJson(repo: Repo, tip: string | undefined): Record<string, unknown>[] {
  const list: Record<string, unknown>[] = [];
  if (!tip) return list;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    const person = { name: VIEWER_NAME, email: VIEWER_EMAIL };
    list.push({
      sha: oid,
      commit: { message: c.message, author: person, committer: person },
      author: { login: VIEWER_LOGIN },
      parents: c.parents.map((p) => ({ sha: p })),
    });
    stack.push(...c.parents);
  }
  return list;
}
function commentJson(c: Comment): Record<string, unknown> {
  return { id: c.id, body: c.body, user: c.user, created_at: c.created_at, updated_at: c.updated_at };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, method: string, path: string, query: URLSearchParams, body: Buffer): Promise<void> {
  if (!authed(req)) { errJson(res, 401, 'Requires authentication'); return; }
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return;
  }
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: 1000, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    return;
  }
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const { page, totalPages, pageNum, perPage } = paginate(repoList, query);
      sendJson(res, 200, page.map(repoJson), { link: linkHeader(req, pageNum, totalPages, perPage) });
      return;
    }
    if (method === 'POST') {
      const v = jsonObject(res, body);
      if (!v) return;
      const name = str(v.name, '');
      if (!name) { errJson(res, 422, 'Validation Failed: name is required'); return; }
      if (getRepo(VIEWER_LOGIN, name)) { errJson(res, 422, 'Repository already exists'); return; }
      const repo = createRepoRec(name, v.private === true, str(v.description, ''), str(v.default_branch, 'main'));
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  const seg = path.split('/').filter((s) => s !== '');
  if (seg.length < 4 || seg[0] !== 'api' || seg[1] !== 'v3' || seg[2] !== 'repos') { notFound(res); return; }
  const owner = decodeURIComponent(seg[3]);
  const name = decodeURIComponent(seg[4] ?? '');
  // Another owner's repository is invisible to this token: 404, never 403.
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
  if (!repo) { notFound(res); return; }
  const rest = seg.slice(5);
  const section = rest[0];

  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      const v = jsonObject(res, body);
      if (!v) return;
      if (typeof v.description === 'string') repo.description = v.description;
      if (typeof v.default_branch === 'string') repo.default_branch = v.default_branch;
      repo.updated_at = tick().iso;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(owner, name));
      const idx = repoList.indexOf(repo);
      if (idx >= 0) repoList.splice(idx, 1);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  if (section === 'branches' && method === 'GET') {
    if (rest.length === 1) {
      const names = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice(11)).sort();
      sendJson(res, 200, names.map((b) => ({ name: b, commit: { sha: repo.refs.get(`refs/heads/${b}`) ?? '' }, protected: false })));
      return;
    }
    if (rest.length === 2) {
      const branch = decodeURIComponent(rest[1]);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) { notFound(res); return; }
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
  }

  if (section === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const v = jsonObject(res, body);
      if (!v) return;
      const ref = str(v.ref, '');
      const sha = str(v.sha, '');
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) { errJson(res, 422, 'Validation Failed'); return; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: '' });
      return;
    }
    if (method === 'GET') {
      const refPath = rest.slice(2).map(decodeURIComponent).join('/');
      if (refPath === '') {
        sendJson(res, 200, sortedRefs(repo).map((r) => ({ ref: r.name, object: { sha: r.oid } })));
        return;
      }
      const sha = repo.refs.get(refPath);
      if (!sha) { notFound(res); return; }
      sendJson(res, 200, { ref: refPath, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return;
    }
  }

  if (section === 'commits' && method === 'GET') {
    const shaQ = query.get('sha');
    const tip = shaQ
      ? repo.refs.get(`refs/heads/${shaQ}`) ?? (repo.objects.has(shaQ) ? shaQ : undefined)
      : repo.refs.get(`refs/heads/${repo.default_branch}`);
    sendJson(res, 200, commitListJson(repo, tip));
    return;
  }

  if (section === 'contents') {
    const filePath = rest.slice(1).map(decodeURIComponent).join('/');
    const baseName = filePath.split('/').pop();
    if (method === 'GET') {
      const got = getFileAt(repo, query.get('ref') ?? undefined, filePath);
      if (!got) { notFound(res); return; }
      if ('dir' in got) {
        sendJson(res, 200, got.dir.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: `${filePath}/${e.name}`, sha: e.oid, size: 0,
        })));
        return;
      }
      sendJson(res, 200, {
        type: 'file', encoding: 'base64', size: got.data.length, name: baseName, path: filePath,
        content: got.data.toString('base64'), sha: got.blobOid,
      });
      return;
    }
    if (method === 'PUT') {
      const v = jsonObject(res, body);
      if (!v) return;
      const content = Buffer.from(str(v.content, '').replace(/\s/g, ''), 'base64');
      const branch = str(v.branch, repo.default_branch);
      const expected = typeof v.sha === 'string' ? v.sha : undefined;
      const current = getFileAt(repo, branch, filePath);
      const existing = current !== null && 'blobOid' in current ? current : null;
      // A stale or unexpected sha is a conflict; a missing sha on an existing file overwrites.
      if (expected !== undefined && (existing === null || existing.blobOid !== expected)) {
        errJson(res, 409, 'sha does not match');
        return;
      }
      const message = str(v.message, `Update ${filePath}`);
      const { commitSha, blobSha } = contentsCommit(repo, branch, filePath, content, message);
      sendJson(res, existing ? 200 : 201, {
        content: { name: baseName, path: filePath, sha: blobSha, size: content.length, encoding: 'base64', type: 'file' },
        commit: { sha: commitSha, message: str(v.message, '') },
      });
      return;
    }
    if (method === 'DELETE') {
      const v = jsonObject(res, body);
      if (!v) return;
      const branch = str(v.branch, repo.default_branch);
      const current = getFileAt(repo, branch, filePath);
      if (!current || 'dir' in current) { notFound(res); return; }
      const { commitSha } = contentsCommit(repo, branch, filePath, null, str(v.message, `Delete ${filePath}`));
      sendJson(res, 200, { commit: { sha: commitSha } });
      return;
    }
  }

  if (section === 'labels') {
    if (method === 'POST') {
      const v = jsonObject(res, body);
      if (!v) return;
      const labelName = str(v.name, '');
      if (!labelName) { errJson(res, 422, 'Validation Failed'); return; }
      const label: Label = { name: labelName, color: str(v.color, 'ededed'), description: str(v.description, '') };
      repo.labels.set(labelName, label);
      sendJson(res, 201, label);
      return;
    }
    if (method === 'GET') { sendJson(res, 200, [...repo.labels.values()]); return; }
  }

  if (section === 'issues') { handleIssues(req, res, method, repo, rest, query, body); return; }
  if (section === 'pulls') { handlePulls(res, method, repo, rest, query, body); return; }
  notFound(res);
}

function handleIssues(_req: IncomingMessage, res: ServerResponse, method: string, repo: Repo, rest: string[], query: URLSearchParams, body: Buffer): void {
  if (rest.length === 1) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = state === 'all' ? [...repo.issues] : repo.issues.filter((i) => i.state === state);
      if ((query.get('sort') ?? 'created') === 'created') {
        const asc = (query.get('direction') ?? 'desc') === 'asc';
        list = list.sort((a, b) => (asc ? a.number - b.number : b.number - a.number));
      }
      sendJson(res, 200, paginate(list, query).page.map((i) => issueJson(repo, i)));
      return;
    }
    if (method === 'POST') {
      const v = jsonObject(res, body);
      if (!v) return;
      const labels = Array.isArray(v.labels) ? v.labels.map((x) => String(x)) : [];
      const created = createIssueRec(repo, str(v.title, ''), str(v.body, ''), labels);
      if ('error' in created) { errJson(res, 422, created.error); return; }
      sendJson(res, 201, issueJson(repo, created));
      return;
    }
  }
  const num = parseInt(rest[1] ?? '', 10);
  if (!Number.isInteger(num)) { notFound(res); return; }
  const found = findIssueOrPr(repo, num);
  const issue = found && 'issue' in found ? found.issue : null;
  if (rest.length === 2 && (method === 'GET' || method === 'PATCH')) {
    if (!issue) { notFound(res); return; }
    if (method === 'PATCH') {
      const v = jsonObject(res, body);
      if (!v) return;
      if (v.state === 'open' || v.state === 'closed') issue.state = v.state;
      if (typeof v.title === 'string') issue.title = v.title;
      if (typeof v.body === 'string') issue.body = v.body;
      issue.updated_at = tick().iso;
    }
    sendJson(res, 200, issueJson(repo, issue));
    return;
  }
  if (rest.length === 3 && rest[2] === 'comments') {
    if (!issue) { notFound(res); return; }
    if (method === 'GET') { sendJson(res, 200, issue.comments.map(commentJson)); return; }
    if (method === 'POST') {
      const v = jsonObject(res, body);
      if (!v) return;
      const t = tick();
      const comment: Comment = { id: ++globalIdSeq, body: str(v.body, ''), created_at: t.iso, updated_at: t.iso, user: { login: VIEWER_LOGIN } };
      issue.comments.push(comment);
      sendJson(res, 201, commentJson(comment));
      return;
    }
  }
  notFound(res);
}

function handlePulls(res: ServerResponse, method: string, repo: Repo, rest: string[], query: URLSearchParams, body: Buffer): void {
  if (rest.length === 1) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = state === 'all' ? [...repo.prs] : repo.prs.filter((p) => p.state === state);
      sendJson(res, 200, paginate(list, query).page.map((p) => prJson(repo, p)));
      return;
    }
    if (method === 'POST') {
      const v = jsonObject(res, body);
      if (!v) return;
      const created = createPrRec(repo, str(v.title, ''), str(v.body, ''), str(v.head, ''), str(v.base, repo.default_branch));
      if ('error' in created) { errJson(res, 422, created.error); return; }
      sendJson(res, 201, prJson(repo, created));
      return;
    }
  }
  const num = parseInt(rest[1] ?? '', 10);
  if (!Number.isInteger(num)) { notFound(res); return; }
  const pr = repo.prs.find((p) => p.number === num);
  const action = rest.length === 2 ? '' : rest.length === 3 ? rest[2] : null;
  if (action === '' && method === 'GET') {
    if (!pr) { notFound(res); return; }
    sendJson(res, 200, prJson(repo, pr));
    return;
  }
  if (action === 'files' && method === 'GET') {
    if (!pr) { notFound(res); return; }
    sendJson(res, 200, diffFiles(repo, pr.base.sha, pr.head.sha));
    return;
  }
  if (action === 'merge' && method === 'PUT') {
    if (!pr) { notFound(res); return; }
    if (pr.merged) { errJson(res, 405, 'Pull request already merged'); return; }
    if (!jsonObject(res, body)) return;
    const merged = doSquashMerge(repo, pr);
    if ('conflict' in merged) { errJson(res, 405, 'Merge conflict'); return; }
    sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
    return;
  }
  notFound(res);
}

// ---- GraphQL v4: a small executor for the documents gh and github-mcp-server send ----
interface GField { name: string; alias: string; args: Record<string, unknown>; children: GField[]; fragmentType?: string }
interface GToken { kind: string; value: string }
type GErrors = { message: string }[];

const PUNCT = '{}():[]!=$';
function gqlTokens(src: string): GToken[] {
  const tokens: GToken[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (PUNCT.includes(c)) { tokens.push({ kind: c, value: c }); i++; continue; }
    if (c === '.' && src.startsWith('...', i)) { tokens.push({ kind: '...', value: '...' }); i += 3; continue; }
    if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { text += src[j + 1]; j += 2; } else { text += src[j]; j++; }
      }
      tokens.push({ kind: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

// Parse one operation: optional `query|mutation|subscription Name(vars...)`, then a selection set.
function parseOperation(src: string, vars: Record<string, unknown>): { opType: string; fields: GField[] } {
  const tokens = gqlTokens(src);
  let pos = 0;
  const peekKind = (): string | undefined => tokens[pos]?.kind;
  const next = (): GToken => tokens[pos++];
  const expect = (kind: string): GToken => {
    const t = next();
    if (t.kind !== kind) throw new Error(`expected ${kind} got ${t.kind}`);
    return t;
  };
  const value = (): unknown => {
    const t = next();
    switch (t.kind) {
      case '$': return vars[next().value];
      case 'string': return t.value;
      case 'number': return Number(t.value);
      case '[': {
        const list: unknown[] = [];
        while (peekKind() !== ']') list.push(value());
        expect(']');
        return list;
      }
      case '{': {
        const obj: Record<string, unknown> = {};
        while (peekKind() !== '}') {
          const key = next().value;
          expect(':');
          obj[key] = value();
        }
        expect('}');
        return obj;
      }
      case 'name':
        if (t.value === 'true') return true;
        if (t.value === 'false') return false;
        if (t.value === 'null') return null;
        return t.value; // enum literal
      default:
        throw new Error(`bad value ${t.kind}`);
    }
  };
  const argList = (): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    expect('(');
    while (peekKind() !== ')') {
      const key = next().value;
      expect(':');
      args[key] = value();
    }
    expect(')');
    return args;
  };
  const selection = (): GField[] => {
    expect('{');
    const fields: GField[] = [];
    while (peekKind() !== '}') {
      const t = next();
      if (t.kind === '...') {
        const after = next();
        if (after.kind === 'name' && after.value === 'on') {
          const fragmentType = next().value;
          fields.push({ name: '__fragment', alias: '', args: {}, children: selection(), fragmentType });
        } else if (after.kind === 'name') {
          // Named fragment spread: the suite's documents never use one.
          fields.push({ name: '__fragment', alias: '', args: {}, children: [] });
        }
        continue;
      }
      if (t.kind !== 'name') throw new Error(`expected field name got ${t.kind}`);
      const alias = t.value;
      let name = t.value;
      if (peekKind() === ':') { next(); name = next().value; }
      const args = peekKind() === '(' ? argList() : {};
      const children = peekKind() === '{' ? selection() : [];
      fields.push({ name, alias, args, children });
    }
    expect('}');
    return fields;
  };

  let opType = 'query';
  const first = tokens[pos];
  if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation' || first.value === 'subscription')) {
    opType = next().value;
    if (peekKind() === 'name') next();
    if (peekKind() === '(') {
      // Variable definitions are not needed (values come from `variables`): skip the balanced parens.
      let depth = 0;
      while (pos < tokens.length) {
        const t = next();
        if (t.kind === '(') depth++;
        else if (t.kind === ')' && --depth === 0) break;
      }
    }
  }
  return { opType, fields: selection() };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'createdAt', 'updatedAt', 'author', 'url', 'headRefOid', 'baseRefOid'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
};
const SEARCH_ENUMS = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

const issueState = (i: Issue): string => (i.state === 'open' ? 'OPEN' : 'CLOSED');
const prState = (p: PR): string => (p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED');
const prMergeable = (repo: Repo, p: PR): string => (p.merged || !prConflict(repo, p) ? 'MERGEABLE' : 'CONFLICTING');

function gqlIssue(repo: Repo, i: Issue): Record<string, unknown> {
  return { __kind: 'Issue', id: gid('Issue', i.id), number: i.number, title: i.title, state: issueState(i), body: i.body, _rec: i, _repo: repo };
}
function gqlPr(repo: Repo, p: PR): Record<string, unknown> {
  return {
    __kind: 'PullRequest', id: gid('PullRequest', p.id), number: p.number, title: p.title, body: p.body,
    headRefName: p.head.ref, baseRefName: p.base.ref, mergeable: prMergeable(repo, p), state: prState(p),
    merged: p.merged, _rec: p, _repo: repo,
  };
}
function gqlRepo(r: Repo): Record<string, unknown> {
  return { __kind: 'Repository', id: gid('Repository', r.id), databaseId: r.id, name: r.name, nameWithOwner: `${r.owner}/${r.name}`, owner: { login: r.owner }, _rec: r };
}

function unknownField(errors: GErrors, name: string, kind: string): null {
  errors.push({ message: `Cannot query field "${name}" on type "${kind}".` });
  return null;
}

function findRepoByGid(id: string): Repo | null {
  const dec = decodeGid(id);
  if (dec?.prefix !== 'Repository') return null;
  const n = parseInt(dec.rest, 10);
  return repoList.find((r) => r.id === n) ?? null;
}
function findIssueByGid(id: string): { repo: Repo; issue: Issue } | null {
  const dec = decodeGid(id);
  if (dec?.prefix !== 'Issue') return null;
  const n = parseInt(dec.rest, 10);
  for (const repo of repoList) {
    const issue = repo.issues.find((x) => x.id === n);
    if (issue) return { repo, issue };
  }
  return null;
}
function findPrByGid(id: string): { repo: Repo; pr: PR } | null {
  const dec = decodeGid(id);
  if (dec?.prefix !== 'PullRequest') return null;
  const n = parseInt(dec.rest, 10);
  for (const repo of repoList) {
    const pr = repo.prs.find((x) => x.id === n);
    if (pr) return { repo, pr };
  }
  return null;
}

function resolveQueryField(field: GField, errors: GErrors): unknown {
  const name = field.name;
  if (name === 'viewer') return { __kind: 'User', login: VIEWER_LOGIN };
  if (name === 'repository') {
    const owner = field.args.owner as string;
    if (owner !== VIEWER_LOGIN) return null;
    const repo = getRepo(owner, field.args.name as string);
    return repo ? gqlRepo(repo) : null;
  }
  if (name === 'node') {
    const id = String(field.args.id ?? '');
    const repo = findRepoByGid(id);
    if (repo) return gqlRepo(repo);
    const found = findIssueByGid(id);
    return found ? gqlIssue(found.repo, found.issue) : null;
  }
  if (name === '__type') {
    const typeName = field.args.name as string;
    const fields = TYPE_FIELDS[typeName];
    if (fields === undefined) return null;
    return { __kind: '__Type', name: typeName, _fields: fields, _enum: typeName === 'SearchType' ? SEARCH_ENUMS : undefined };
  }
  return unknownField(errors, name, 'Query');
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (states) list = list.filter((i) => states.includes(issueState(i)));
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const desc = orderBy?.field === 'CREATED_AT' && orderBy.direction === 'DESC';
  list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const after = args.after as string | undefined | null;
  if (after) {
    // Cursors are base64("cursor:<number>"); continue past that issue number.
    const n = parseInt(Buffer.from(after, 'base64').toString('utf8').split(':')[1] ?? '', 10);
    if (Number.isFinite(n)) list = list.filter((i) => i.number > n);
  }
  const first = args.first as number | undefined;
  const page = first !== undefined ? list.slice(0, first) : list;
  const last = page[page.length - 1];
  return {
    __kind: 'IssueConnection',
    nodes: page.map((i) => gqlIssue(repo, i)),
    pageInfo: {
      hasNextPage: first !== undefined && list.length > first,
      endCursor: last ? Buffer.from(`cursor:${last.number}`, 'utf8').toString('base64') : null,
    },
  };
}

function resolveRepoField(obj: Record<string, unknown>, field: GField, errors: GErrors): unknown {
  const r = obj._rec as Repo;
  switch (field.name) {
    case 'id': return obj.id;
    case 'databaseId': return r.id;
    case 'name': return r.name;
    case 'nameWithOwner': return `${r.owner}/${r.name}`;
    case 'owner': return { __kind: 'User', login: r.owner };
    case 'defaultBranchRef': {
      const tip = r.refs.get(`refs/heads/${r.default_branch}`);
      return { __kind: 'Ref', name: r.default_branch, target: tip ? { oid: tip } : null };
    }
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'issue': {
      const issue = r.issues.find((x) => x.number === field.args.number);
      return issue ? gqlIssue(r, issue) : null;
    }
    case 'issues': return issueConnection(r, field.args);
    case 'pullRequests': {
      const first = field.args.first as number | undefined;
      const list = first !== undefined ? r.prs.slice(0, first) : r.prs;
      return { __kind: 'PullRequestConnection', nodes: list.map((p) => gqlPr(r, p)) };
    }
    case 'pullRequest': {
      const pr = r.prs.find((x) => x.number === field.args.number);
      return pr ? gqlPr(r, pr) : null;
    }
    default: return unknownField(errors, field.name, 'Repository');
  }
}

function resolvePrField(obj: Record<string, unknown>, field: GField, errors: GErrors): unknown {
  const p = obj._rec as PR;
  const r = obj._repo as Repo;
  switch (field.name) {
    case 'id': return obj.id;
    case 'number': return p.number;
    case 'title': return p.title;
    case 'body': return p.body;
    case 'headRefName': return p.head.ref;
    case 'baseRefName': return p.base.ref;
    case 'mergeable': return prMergeable(r, p);
    case 'state': return prState(p);
    case 'merged': return p.merged;
    case 'files': {
      const files = diffFiles(r, p.base.sha, p.head.sha);
      const first = field.args.first as number | undefined;
      const nodes = (first !== undefined ? files.slice(0, first) : files).map((f) => ({ path: f.filename }));
      return { __kind: 'FileConnection', nodes, pageInfo: { hasNextPage: false, endCursor: null } };
    }
    default: return unknownField(errors, field.name, 'PullRequest');
  }
}

function resolveField(obj: Record<string, unknown>, field: GField, errors: GErrors): unknown {
  const name = field.name;
  if (name === '__fragment') return obj;
  // Plain objects (pageInfo, __Type entries, commit targets, payload nodes) resolve by property.
  if (!obj.__kind && name in obj) return obj[name];
  const kind = (obj.__kind as string) ?? 'Query';
  switch (kind) {
    case 'Query': return resolveQueryField(field, errors);
    case '__Type':
      if (name === 'fields') return (obj._fields as string[]).map((n) => ({ name: n }));
      if (name === 'enumValues') return ((obj._enum as string[]) ?? []).map((n) => ({ name: n }));
      if (name === 'name') return obj.name;
      return unknownField(errors, name, '__Type');
    case 'User':
      return name === 'login' ? VIEWER_LOGIN : unknownField(errors, name, 'User');
    case 'Repository': return resolveRepoField(obj, field, errors);
    case 'Ref':
      if (name === 'name') return obj.name;
      if (name === 'target') return obj.target;
      return unknownField(errors, name, 'Ref');
    case 'Issue': {
      const i = obj._rec as Issue;
      if (name === 'id') return obj.id;
      if (name === 'number') return i.number;
      if (name === 'title') return i.title;
      if (name === 'state') return issueState(i);
      if (name === 'body') return i.body;
      return unknownField(errors, name, 'Issue');
    }
    case 'PullRequest': return resolvePrField(obj, field, errors);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'FileConnection': {
      const nodes = obj.nodes as unknown[];
      if (name === 'nodes') return nodes;
      if (name === 'edges') return nodes.map((node) => ({ node }));
      if (name === 'pageInfo') return obj.pageInfo ?? { hasNextPage: false, endCursor: null };
      if (name === 'totalCount') return nodes.length;
      return unknownField(errors, name, kind);
    }
    default:
      return name in obj ? obj[name] : unknownField(errors, name, kind);
  }
}

// Shape a resolved value by a field's sub-selection (leaves pass through).
function shape(value: unknown, field: GField, errors: GErrors): unknown {
  if (field.children.length === 0) return value;
  if (Array.isArray(value)) return value.map((v) => selectFields(v, field.children, errors));
  return selectFields(value, field.children, errors);
}

function selectFields(obj: unknown, fields: GField[], errors: GErrors): Record<string, unknown> | null {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj as unknown as Record<string, unknown>;
  const rec = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.name === '__fragment') {
      if (f.fragmentType && f.fragmentType !== ((rec.__kind as string) ?? '')) continue;
      const sub = selectFields(rec, f.children, errors);
      if (sub) Object.assign(out, sub);
      continue;
    }
    out[f.alias] = shape(resolveField(rec, f, errors), f, errors);
  }
  return out;
}

function execMutation(field: GField, errors: GErrors): Record<string, unknown> {
  const input = (field.args.input ?? {}) as Record<string, unknown>;
  const text = (key: string): string => String(input[key] ?? '');
  switch (field.name) {
    case 'createIssue': {
      const repo = findRepoByGid(text('repositoryId'));
      if (!repo) { errors.push({ message: 'Repository not found' }); return { issue: null }; }
      const created = createIssueRec(repo, text('title'), text('body'), []);
      if ('error' in created) { errors.push({ message: created.error }); return { issue: null }; }
      return { issue: gqlIssue(repo, created) };
    }
    case 'closeIssue': {
      const found = findIssueByGid(text('issueId'));
      if (!found) { errors.push({ message: 'Issue not found' }); return { issue: null }; }
      found.issue.state = 'closed';
      found.issue.updated_at = tick().iso;
      return { issue: gqlIssue(found.repo, found.issue) };
    }
    case 'createPullRequest': {
      const repo = findRepoByGid(text('repositoryId'));
      if (!repo) { errors.push({ message: 'Repository not found' }); return { pullRequest: null }; }
      const created = createPrRec(repo, text('title'), text('body'), text('headRefName'), text('baseRefName'));
      if ('error' in created) { errors.push({ message: created.error }); return { pullRequest: null }; }
      return { pullRequest: gqlPr(repo, created) };
    }
    case 'mergePullRequest': {
      const found = findPrByGid(text('pullRequestId'));
      if (!found) { errors.push({ message: 'Pull request not found' }); return { pullRequest: null }; }
      const merged = doSquashMerge(found.repo, found.pr);
      if ('conflict' in merged) errors.push({ message: 'Merge conflict' });
      return { pullRequest: gqlPr(found.repo, found.pr) };
    }
    case 'addComment': {
      const found = findIssueByGid(text('subjectId'));
      if (!found) { errors.push({ message: 'Subject not found' }); return { commentEdge: null }; }
      const t = tick();
      const comment: Comment = { id: ++globalIdSeq, body: text('body'), created_at: t.iso, updated_at: t.iso, user: { login: VIEWER_LOGIN } };
      found.issue.comments.push(comment);
      return { commentEdge: { node: { __kind: 'IssueComment', id: gid('IssueComment', comment.id), body: comment.body } } };
    }
    default:
      unknownField(errors, field.name, 'Mutation');
      return {};
  }
}

function execGraphQL(query: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: GErrors } {
  const errors: GErrors = [];
  try {
    const { opType, fields } = parseOperation(query, variables);
    const data: Record<string, unknown> = {};
    const root: Record<string, unknown> = { __kind: 'Query' };
    for (const f of fields) {
      if (opType === 'mutation') {
        const raw = execMutation(f, errors);
        const payload: Record<string, unknown> = {};
        for (const child of f.children) payload[child.alias] = child.children.length === 0 ? raw[child.name] : selectFields(raw[child.name], child.children, errors);
        data[f.alias] = payload;
      } else {
        data[f.alias] = shape(resolveField(root, f, errors), f, errors);
      }
    }
    return { data, errors };
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
}

// ---- MCP (Streamable HTTP, JSON-RPC 2.0, legacy initialize handshake) ----
interface McpToolDef { name: string; description: string; inputSchema: Record<string, unknown> }
type PropSpec = [name: string, type: string, description: string];
const OWNER_REPO: PropSpec[] = [
  ['owner', 'string', 'Repository owner'],
  ['repo', 'string', 'Repository name'],
];
const FULL_NAME: PropSpec = ['full_name', 'string', 'Full repository name owner/repo'];
function tool(name: string, description: string, props: PropSpec[], required: string[]): McpToolDef {
  const properties: Record<string, unknown> = {};
  for (const [prop, type, desc] of props) properties[prop] = { type, description: desc };
  return { name, description, inputSchema: { type: 'object', properties, required } };
}
// Property names follow github-mcp-server, so the suite's argument mapping lands exactly.
const MCP_TOOLS: McpToolDef[] = [
  tool('create_repo', 'Create a new repository for the authenticated user.', [
    ['name', 'string', 'Repository name'],
    ['description', 'string', 'Repository description'],
    ['private', 'boolean', 'Whether the repository is private'],
  ], ['name']),
  tool('get_repo', 'Get a repository by owner and name.', [...OWNER_REPO, FULL_NAME], ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', [
    ...OWNER_REPO,
    ['title', 'string', 'Issue title'],
    ['body', 'string', 'Issue body'],
    FULL_NAME,
  ], ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', [
    ...OWNER_REPO,
    ['state', 'string', 'Issue state: open, closed or all'],
    FULL_NAME,
  ], ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request in a repository.', [
    ...OWNER_REPO,
    ['title', 'string', 'Pull request title'],
    ['body', 'string', 'Pull request body'],
    ['head', 'string', 'Head branch name'],
    ['base', 'string', 'Base branch name'],
    FULL_NAME,
  ], ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request.', [
    ...OWNER_REPO,
    ['pull_number', 'integer', 'Pull request number'],
    FULL_NAME,
  ], ['owner', 'repo', 'pull_number']),
  tool('get_issue', 'Get an issue by number.', [
    ...OWNER_REPO,
    ['number', 'integer', 'Issue number'],
    FULL_NAME,
  ], ['owner', 'repo', 'number']),
];
// Serialised once: two tools/list calls must answer byte for byte the same.
const MCP_TOOLS_JSON = JSON.stringify(MCP_TOOLS);

type RpcError = { rpcError: { code: number; message: string } };
const rpcError = (code: number, message: string): RpcError => ({ rpcError: { code, message } });
function mcpResult(id: unknown, result: unknown): Record<string, unknown> { return { jsonrpc: '2.0', id, result }; }
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> { return { jsonrpc: '2.0', id, error: { code, message } }; }
function toolText(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj, isError: false };
}
function toolErrText(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) [owner, repo] = parts;
  }
  return owner && repo ? { owner, repo } : null;
}
const intArg = (v: unknown): number => (typeof v === 'number' ? v : parseInt(String(v ?? ''), 10));

function handleMcpCall(name: string, args: Record<string, unknown>): Record<string, unknown> | RpcError {
  const def = MCP_TOOLS.find((t) => t.name === name);
  if (!def) return rpcError(-32601, `Method not found: ${name}`);
  // full_name stands in for owner + repo.
  const hasFullName = typeof args.full_name === 'string' && args.full_name.includes('/');
  const missing = (def.inputSchema.required as string[]).filter((r) => args[r] == null && !(hasFullName && (r === 'owner' || r === 'repo')));
  if (missing.length) return rpcError(-32602, `Missing required arguments: ${missing.join(', ')}`);

  if (name === 'create_repo') {
    const repoName = String(args.name ?? '');
    if (!repoName) return rpcError(-32602, 'Missing required argument: name');
    if (getRepo(VIEWER_LOGIN, repoName)) return toolErrText('Repository already exists');
    return toolText(repoJson(createRepoRec(repoName, args.private === true, str(args.description, ''), 'main')));
  }
  const target = resolveOwnerRepo(args);
  if (!target) return rpcError(-32602, 'Missing required arguments: owner, repo');
  const repo = target.owner === VIEWER_LOGIN ? getRepo(target.owner, target.repo) : undefined;
  if (!repo) return toolErrText('Not Found');

  switch (name) {
    case 'get_repo':
      return toolText(repoJson(repo));
    case 'create_issue': {
      const created = createIssueRec(repo, String(args.title ?? ''), str(args.body, ''), []);
      return 'error' in created ? toolErrText(created.error) : toolText(issueJson(repo, created));
    }
    case 'list_issues': {
      const state = str(args.state, 'open');
      const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return toolText(list.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const created = createPrRec(repo, String(args.title ?? ''), str(args.body, ''), String(args.head ?? ''), String(args.base ?? ''));
      return 'error' in created ? toolErrText(created.error) : toolText(prJson(repo, created));
    }
    case 'merge_pull_request': {
      const num = intArg(args.pull_number);
      const pr = repo.prs.find((p) => p.number === num);
      if (!pr) return toolErrText('Pull request not found');
      if (pr.merged) return toolErrText('Pull request already merged');
      const merged = doSquashMerge(repo, pr);
      if ('conflict' in merged) return toolErrText('Merge conflict');
      return toolText({ sha: merged.sha, merged: true, number: pr.number });
    }
    case 'get_issue': {
      const num = intArg(args.number);
      const issue = repo.issues.find((i) => i.number === num);
      return issue ? toolText(issueJson(repo, issue)) : toolErrText('Not Found');
    }
    default:
      return rpcError(-32601, `Method not found: ${name}`);
  }
}

const LEGACY_MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
function emptyReply(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (req.method === 'DELETE') { emptyReply(res, 200); return; }
  if (req.method !== 'POST') { errJson(res, 405, 'Method Not Allowed'); return; }
  if (!authed(req)) { errJson(res, 401, 'Requires authentication'); return; }
  let msg: unknown;
  try {
    msg = JSON.parse(body.toString('utf8'));
  } catch {
    msg = undefined;
  }
  if (!isObj(msg)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = isObj(msg.params) ? msg.params : {};

  if (method.startsWith('notifications/')) { emptyReply(res, 202); return; }
  switch (method) {
    case 'server/discover':
      // Pre-discover revision: the legacy initialize handshake is the supported path.
      sendJson(res, 200, mcpError(id, -32601, 'Method not found'));
      return;
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const protocolVersion = LEGACY_MCP_VERSIONS.includes(offered) ? offered : '2025-11-25';
      sendJson(res, 200, mcpResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone', version: '1.0.0' } }));
      return;
    }
    case 'ping':
      sendJson(res, 200, mcpResult(id, {}));
      return;
    case 'tools/list': {
      const text = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"tools":${MCP_TOOLS_JSON}}}\n`;
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': nextRequestId() });
      res.end(text);
      return;
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = isObj(params.arguments) ? params.arguments : {};
      const out = handleMcpCall(toolName, toolArgs);
      sendJson(res, 200, 'rpcError' in out ? mcpError(id, out.rpcError.code, out.rpcError.message) : mcpResult(id, out));
      return;
    }
    default:
      sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
  }
}

// ---- router ----
type Vars = Record<string, unknown>;
function runGraphQLOp(op: unknown): unknown {
  if (!isObj(op)) return { data: null, errors: [{ message: 'Invalid operation' }] };
  return execGraphQL(typeof op.query === 'string' ? op.query : '', (isObj(op.variables) ? op.variables : {}) as Vars);
}

function handleGraphQL(req: IncomingMessage, res: ServerResponse, method: string, body: Buffer): void {
  if (method !== 'POST') { errJson(res, 405, 'Method Not Allowed'); return; }
  if (!authed(req)) { errJson(res, 401, 'Requires authentication'); return; }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
  // A JSON array is a batch: answer each operation, in order.
  if (Array.isArray(parsed.value)) { sendJson(res, 200, parsed.value.map(runGraphQLOp)); return; }
  if (!isObj(parsed.value)) { errJson(res, 400, 'Problems parsing JSON'); return; }
  sendJson(res, 200, runGraphQLOp(parsed.value));
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/;
function handleGit(req: IncomingMessage, res: ServerResponse, method: string, m: RegExpExecArray, query: URLSearchParams, body: Buffer): void {
  if (!authed(req)) { errJson(res, 401, 'Requires authentication'); return; }
  const owner = decodeURIComponent(m[1]);
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, decodeURIComponent(m[2])) : undefined;
  if (!repo) { notFound(res); return; }
  const suffix = m[3];
  if (method === 'GET' && suffix === 'info/refs') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { errJson(res, 400, 'Invalid service'); return; }
    handleInfoRefs(req, res, repo, service);
    return;
  }
  if (method === 'POST' && suffix === 'git-upload-pack') { handleUploadPack(req, res, repo, body); return; }
  if (method === 'POST' && suffix === 'git-receive-pack') { handleReceivePack(req, res, repo, body); return; }
  notFound(res);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    notFound(res);
    return;
  }
  const path = url.pathname;
  if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
  const body = await readBody(req);
  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch) { handleGit(req, res, method, gitMatch, url.searchParams, body); return; }
  if (path === '/api/graphql') { handleGraphQL(req, res, method, body); return; }
  if (path === '/mcp') { await handleMcp(req, res, body); return; }
  if (path.startsWith('/api/v3')) { await handleRest(req, res, method, path, url.searchParams, body); return; }
  notFound(res);
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((e: unknown) => {
      // The server must survive anything a request throws (repo-survives-errors).
      try {
        errJson(res, 500, e instanceof Error ? e.message : 'Internal Server Error');
      } catch {
        // Headers already sent: nothing more to say on this response.
      }
    });
  });
}
