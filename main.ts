// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Section 5: one line compared at a tier. Tier 1 drops trailing spaces and tabs, tier 2 both ends. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position at or after `from` where O's lines match the file's lines at this tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only with --strict) at which O occurs at least once. */
function findFirstTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(lines, o, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/**
 * Section 5: the lines N that replace the matched lines at `pos`. A context line (a line of both O and N) is
 * written as the file's own matched line, never the patch's; at tier 2 every other line is re-indented, replacing
 * the leading spaces and tabs of O's first line with those of the file's first matched line. At tiers 0 and 1 the
 * other lines are written as they are.
 */
function transformN(lines: string[], pos: number, o: string[], n: string[], isCtxO: boolean[], isCtxN: boolean[], tier: number): string[] {
  const ctxO: number[] = [];
  for (let oi = 0; oi < o.length; oi++) if (isCtxO[oi]) ctxO.push(oi);
  const f = leadingWs(lines[pos]!);
  const p = leadingWs(o[0]!);
  let k = 0;
  return n.map((nl, nj) => {
    if (isCtxN[nj]) {
      const fileLine = lines[pos + ctxO[k]!]!;
      k += 1;
      return fileLine;
    }
    if (tier === 2 && nl !== '' && nl.trim() !== '' && nl.startsWith(p)) return f + nl.slice(p.length);
    return nl;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One body line of a unified hunk or a V4A chunk: context, old, new, or a backslash line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

/** Whether a `\` line follows the hunk's last context or `+` line (section 6, no-newline rule). */
function bsAfterLast(h: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < h.body.length; i++) {
    if (h.body[i]!.kind === 'ctx' || h.body[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return h.body[last + 1]?.kind === 'bs';
}

/** The old and new lines of a hunk body, in body order, with which of them are context lines. */
function hunkON(h: Hunk): { o: string[]; n: string[]; isCtxO: boolean[]; isCtxN: boolean[] } {
  const o: string[] = [];
  const n: string[] = [];
  const isCtxO: boolean[] = [];
  const isCtxN: boolean[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') { o.push(b.text); n.push(b.text); isCtxO.push(true); isCtxN.push(true); }
    else if (b.kind === 'old') { o.push(b.text); isCtxO.push(false); }
    else if (b.kind === 'new') { n.push(b.text); isCtxN.push(false); }
  }
  return { o, n, isCtxO, isCtxN };
}

/**
 * Section 6: apply a section's hunks in order to a file's text. `d` is the sum over the hunks applied so far of
 * (N's length minus O's length). A hunk with a non-empty O takes, of the occurrences at the tier where O is found,
 * the one nearest to A - 1 + d (the earlier of two equally near); a hunk with an empty O inserts N after the first
 * A + d lines. When the matched lines run to the end of the file (or an empty-O insertion lands at the end), the
 * result ends with a line break unless a `\` line follows the hunk's last context or `+` line; otherwise the
 * file's final break stays as it was.
 */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  const lines = f.lines;
  let final = f.final;
  const br = f.br;
  let d = 0;
  for (const h of hunks) {
    const { o, n, isCtxO, isCtxN } = hunkON(h);
    if (o.length === 0) {
      const atEnd = h.a + d >= lines.length;
      let idx = h.a + d;
      if (idx > lines.length) idx = lines.length;
      if (idx < 0) idx = 0;
      lines.splice(idx, 0, ...n);
      if (atEnd) final = !bsAfterLast(h);
      d += n.length;
      continue;
    }
    const found = findFirstTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const pos = best;
    const out = transformN(lines, pos, o, n, isCtxO, isCtxN, found.tier);
    const toEnd = pos + o.length === lines.length;
    lines.splice(pos, o.length, ...out);
    if (toEnd) final = !bsAfterLast(h);
    d += n.length - o.length;
  }
  return joinFile(lines, br, final);
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, surrounding spaces removed. */
function stripPath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.hasPair ? sec.pairOld : sec.renameFrom ?? sec.diffOld;
  const newP = sec.hasPair ? sec.pairNew : sec.renameTo ?? sec.diffNew;
  const kind = oldP === null || sec.newFile ? 'create' : newP === null || sec.deletedFile ? 'delete' : oldP !== newP ? 'move' : 'change';
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (kind === 'create') {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlusBs = false;
      for (const h of sec.hunks) {
        for (let bi = 0; bi < h.body.length; bi++) {
          const b = h.body[bi]!;
          if (b.kind === 'new') {
            plus.push(b.text);
            lastPlusBs = h.body[bi + 1]?.kind === 'bs';
          }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBs ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (kind === 'move' && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const out = applyHunks(before, sec.hunks, strict, op);
    if (kind === 'move') {
      tree.now.set(op, null);
      tree.now.set(newP!, out);
      tree.moves.push({ old: op, new: newP! });
    } else {
      tree.now.set(op, out);
    }
  };
}

/** Section 6: read the patch's unified sections. A section is one edit; prose outside bodies is ignored. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hunk: Hunk | null = null;
  let inHeader = false;
  const endBody = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0) {
      const last = hunk.body[hunk.body.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
      else break;
    }
    hunk = null;
  };
  const blankSection = (): UniSection => ({
    pairOld: null, pairNew: null, hasPair: false, renameFrom: null, renameTo: null,
    diffOld: null, diffNew: null, newFile: false, deletedFile: false, hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endBody();
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        const kind = line === '' ? 'ctx' : line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'bs';
        hunk.body.push({ kind, text: line === '' ? '' : line.slice(1) });
        i++;
        continue;
      } else {
        endBody();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      sections.push(s);
      cur = s;
      hunk = null;
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldRaw = stripPath(line.slice(4));
      const newRaw = stripPath(lines[i + 1]!.slice(4));
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.pairOld = oldRaw;
        cur.pairNew = newRaw;
        cur.hasPair = true;
      } else {
        const s = blankSection();
        s.pairOld = oldRaw;
        s.pairNew = newRaw;
        s.hasPair = true;
        sections.push(s);
        cur = s;
        hunk = null;
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(h);
      hunk = h;
      inHeader = false;
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  endBody();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One SEARCH/REPLACE block (section 7). Empty old lines create the file; otherwise exactly one occurrence. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findFirstTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const out = transformN(f.lines, pos, oldLines, newLines, oldLines.map(() => false), newLines.map(() => false), found.tier);
    f.lines.splice(pos, oldLines.length, ...out);
    tree.now.set(path, joinFile(f.lines, f.br, f.final));
  };
}

/** Section 7: read the patch's SEARCH/REPLACE blocks. Lines outside blocks are ignored. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let sep = -1;
    let rep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { sep = j; break; }
      if (t === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

/** One V4A section (section 8): Add, Delete, or Update with a cursor over the file's lines. */
function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    const lines = f.lines;
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let anchorAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          anchorAt = -1;
          for (let i = cursor; i < lines.length; i++) {
            if (normLine(lines[i]!, t) === normLine(chunk.anchor, t)) { anchorAt = i; break; }
          }
          if (anchorAt >= 0) break;
        }
        if (anchorAt < 0) throw new Fail('no-match', sec.path);
        cursor = anchorAt + 1;
      }
      const { o, n, isCtxO, isCtxN } = hunkON({ a: 0, body: chunk.body });
      if (o.length === 0) {
        const idx = chunk.eof ? lines.length : cursor;
        lines.splice(idx, 0, ...n);
        cursor = idx + n.length;
        continue;
      }
      const found = findFirstTier(lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', sec.path);
      let pos = -1;
      for (const p of found.positions) {
        if (chunk.eof && p + o.length !== lines.length) continue;
        pos = p;
        break;
      }
      if (pos < 0) throw new Fail('no-match', sec.path);
      const out = transformN(lines, pos, o, n, isCtxO, isCtxN, found.tier);
      lines.splice(pos, o.length, ...out);
      cursor = pos + out.length;
    }
    const out = joinFile(lines, f.br, f.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push({ old: sec.path, new: sec.moveTo });
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

/** Section 8: read the patch's V4A sections between `*** Begin Patch` and `*** End Patch`. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  // Split the middle into raw sections. Blank lines at the end of a section are not part of it, so they are
  // dropped before a section is read; a `+` line is not a blank line, so a trailing `+` line stays an empty
  // line of an added file.
  interface RawLine { text: string; no: number; }
  interface RawSection { kind: 'add' | 'delete' | 'update'; path: string; lineNo: number; raw: RawLine[]; }
  const rawSections: RawSection[] = [];
  let raw: RawSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      raw = { kind, path: line.slice(prefix.length).trim(), lineNo: i + 1, raw: [] };
      rawSections.push(raw);
      continue;
    }
    if (raw === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    raw.raw.push({ text: line, no: i + 1 });
  }
  const sections: V4aSection[] = [];
  for (const r of rawSections) {
    while (r.raw.length > 0 && blank(r.raw[r.raw.length - 1]!.text)) r.raw.pop();
    const sec: V4aSection = { kind: r.kind, path: r.path, lineNo: r.lineNo, addLines: [], moveTo: null, chunks: [] };
    if (r.kind === 'add') {
      for (const l of r.raw) {
        if (l.text.startsWith('+')) sec.addLines.push(l.text.slice(1));
        else if (l.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${l.no}`);
      }
    } else if (r.kind === 'delete') {
      for (const l of r.raw) {
        if (blank(l.text)) continue;
        throw new Exit2(`error: parse ${l.no}`);
      }
    } else {
      let chunk: V4aChunk | null = null;
      for (let ri = 0; ri < r.raw.length; ri++) {
        const l = r.raw[ri]!;
        const line = l.text;
        if (line.startsWith('*** Move to: ')) {
          if (ri === 0 && sec.moveTo === null) { sec.moveTo = line.slice('*** Move to: '.length).trim(); continue; }
          throw new Exit2(`error: parse ${l.no}`);
        }
        if (line.startsWith('@@')) {
          const anchor = line.slice(2).trim();
          const c: V4aChunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          sec.chunks.push(c);
          chunk = c;
          continue;
        }
        if (line === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${l.no}`);
          chunk.eof = true;
          chunk = null;
          continue;
        }
        if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
          if (chunk === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${l.no}`);
            chunk = { anchor: null, eof: false, body: [] };
            sec.chunks.push(chunk);
          }
          const kind = line === '' ? 'ctx' : line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : 'new';
          chunk.body.push({ kind, text: line === '' ? '' : line.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${l.no}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { p: string; was: string | null; now: string | null }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ p, was, now });
  }
  const rows: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const m of tree.moves) {
    const dRow = changed.find((c) => c.p === m.old && c.was !== null && c.now === null);
    const aRow = changed.find((c) => c.p === m.new && c.was === null && c.now !== null);
    if (dRow !== undefined && aRow !== undefined) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      used.add(m.old);
      used.add(m.new);
    }
  }
  for (const c of changed) {
    if (used.has(c.p)) continue;
    rows.push({ key: c.p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.p, { force: true });
      else {
        mkdirSync(dirname(c.p), { recursive: true });
        writeFileSync(c.p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
