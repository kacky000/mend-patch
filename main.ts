// mend: applies an edit an AI model wrote to a tree of text files (SPEC.md, version 1).
// Four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), three matching tiers, all-or-nothing writes.
// Node 22 and its standard library only. Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set; the last lines hand over to the kit's
// runner.ts, which runs this same file once per check without that variable.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------------------------------------------
// Outcomes

/** Exit 2: one line, nothing written. */
class Stop {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
/** One failed edit: `error: <code> <path>`. */
class Failure {
  readonly code: string;
  readonly path: string;
  constructor(code: 'no-match' | 'ambiguous' | 'missing' | 'exists' | 'unsafe', path: string) {
    this.code = code;
    this.path = path;
  }
}
const parseError = (lineNo: number): Stop => new Stop(`error: parse ${lineNo}`);

// ---------------------------------------------------------------------------------------------------------------
// Text helpers

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r dropped from each, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) if (seg === '' || seg === '.' || seg === '..') return false;
  return true;
}

/** A file as lines: its break, its lines and whether it ended with the break. */
interface Doc {
  br: string;
  lines: string[];
  final: boolean;
}

function readDoc(text: string): Doc {
  const lf = text.indexOf('\n');
  const br = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** A new file from lines: LF breaks, a final break when asked; no lines is an empty file. */
function newFile(lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (final ? '\n' : '');
}

// ---------------------------------------------------------------------------------------------------------------
// Matching (section 5)

const dropTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const dropBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const TIERS: ((s: string) => string)[] = [(s) => s, dropTrailing, dropBoth];
const leading = (s: string): string => /^[ \t]*/.exec(s)![0];

interface Found {
  tier: number;
  at: number[];
}

/**
 * The occurrences of `old` in `lines` at the first tier that has any, among positions `ok` accepts.
 * Returns null when no tier has one.
 */
function findBlock(lines: string[], old: string[], strict: boolean, ok: (i: number) => boolean = () => true): Found | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const norm = TIERS[tier]!;
    const want = old.map(norm);
    const have = lines.map(norm);
    const at: number[] = [];
    for (let i = 0; i + want.length <= have.length; i += 1) {
      if (!ok(i)) continue;
      let hit = true;
      for (let k = 0; k < want.length; k += 1) {
        if (have[i + k] !== want[k]) {
          hit = false;
          break;
        }
      }
      if (hit) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of N: either text of the patch, or the context line at O's index `ctx` (written as the file's own). */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** The lines that replace the k matched lines at `pos`, found at `tier` with old lines `old`. */
function replacement(lines: string[], pos: number, tier: number, old: string[], neu: NewLine[]): string[] {
  const fileIndent = old.length > 0 ? leading(lines[pos] ?? '') : '';
  const patchIndent = old.length > 0 ? leading(old[0]!) : '';
  return neu.map((n) => {
    if (n.ctx !== null) return lines[pos + n.ctx]!;
    if (tier === 2 && !isBlank(n.text) && n.text.startsWith(patchIndent)) return fileIndent + n.text.slice(patchIndent.length);
    return n.text;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The tree as the edits leave it

class Tree {
  private readonly before = new Map<string, string | null>();
  now = new Map<string, string | null>();
  moves: [string, string][] = [];

  original(p: string): string | null {
    if (!this.before.has(p)) {
      let text: string | null = null;
      try {
        if (statSync(p).isFile()) text = readFileSync(p, 'utf8');
      } catch {
        text = null;
      }
      this.before.set(p, text);
    }
    return this.before.get(p)!;
  }
  read(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  put(p: string, text: string | null): void {
    this.now.set(p, text);
  }
  save(): [Map<string, string | null>, [string, string][]] {
    return [new Map(this.now), [...this.moves]];
  }
  restore(s: [Map<string, string | null>, [string, string][]]): void {
    this.now = s[0];
    this.moves = s[1];
  }
}

interface Ctx {
  tree: Tree;
  strict: boolean;
}
type Edit = (c: Ctx) => void;

function mustBeSafe(...paths: string[]): void {
  for (const p of paths) if (!isSafe(p)) throw new Failure('unsafe', p);
}
function mustExist(t: Tree, p: string): string {
  const text = t.read(p);
  if (text === null) throw new Failure('missing', p);
  return text;
}
function mustNotExist(t: Tree, p: string): void {
  if (t.read(p) !== null) throw new Failure('exists', p);
}
function moveFile(t: Tree, from: string, to: string, text: string): void {
  t.put(from, null);
  t.put(to, text);
  t.moves.push([from, to]);
}

// ---------------------------------------------------------------------------------------------------------------
// Format detection (section 4)

function detect(lines: string[]): string | null {
  const first = lines.find((l) => !isBlank(l));
  if (first === undefined) return null;
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const c = first.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Unified diffs (section 6)

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  gitOld: string | null;
  gitNew: string | null;
  git: boolean;
  pair: boolean;
  minus: string | null; // null: /dev/null
  plus: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  created: boolean;
  deleted: boolean;
  hunks: Hunk[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function headerPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const cuts: number[] = [];
  for (let k = rest.indexOf(' b/'); k >= 0; k = rest.indexOf(' b/', k + 1)) cuts.push(k);
  if (cuts.length === 0) return null;
  for (const k of cuts) {
    const x = rest.slice(2, k);
    const y = rest.slice(k + 3);
    if (x === y && x !== '') return [x, y];
  }
  const k = cuts[0]!;
  const x = rest.slice(2, k);
  const y = rest.slice(k + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

const pairAt = (lines: string[], i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const open = (s: Partial<Section>): Section => {
    const sec: Section = {
      gitOld: null,
      gitNew: null,
      git: false,
      pair: false,
      minus: null,
      plus: null,
      renameFrom: null,
      renameTo: null,
      created: false,
      deleted: false,
      hunks: [],
      ...s,
    };
    sections.push(sec);
    inHeader = true;
    return sec;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const paths = gitPaths(line);
      if (paths === null) throw parseError(i + 1);
      cur = open({ git: true, gitOld: paths[0], gitNew: paths[1] });
      i += 1;
      continue;
    }
    if (pairAt(lines, i)) {
      if (cur !== null && inHeader && cur.git && !cur.pair) {
        cur.pair = true;
        cur.minus = headerPath(line);
        cur.plus = headerPath(lines[i + 1]!);
      } else {
        cur = open({ pair: true, minus: headerPath(line), plus: headerPath(lines[i + 1]!) });
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK.exec(line);
      if (m === null || cur === null) throw parseError(i + 1);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || pairAt(lines, j)) break;
        if (b === '') body.push({ kind: ' ', text: '' });
        else if (b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') body.push({ kind: b[0] as BodyLine['kind'], text: b.slice(1) });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '' && lines[i + body.length] === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw parseError(i + 2);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.created = true;
      else if (line.startsWith('deleted file mode')) cur.deleted = true;
    }
    i += 1;
  }
  return sections;
}

/** Whether a `\` line directly follows the last line of the hunk's N (its last context or `+` line). */
function noFinalBreak(body: BodyLine[], kinds: string): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (kinds.includes(body[k]!.kind)) return body[k + 1]?.kind === '\\';
  }
  return false;
}

function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const old: string[] = [];
    const neu: NewLine[] = [];
    for (const b of h.body) {
      if (b.kind === ' ') {
        neu.push({ text: b.text, ctx: old.length });
        old.push(b.text);
      } else if (b.kind === '-') old.push(b.text);
      else if (b.kind === '+') neu.push({ text: b.text, ctx: null });
    }
    const keepBreak = !noFinalBreak(h.body, ' +');
    if (old.length > 0) {
      const found = findBlock(doc.lines, old, strict);
      if (found === null) throw new Failure('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.at[0]!;
      for (const p of found.at) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      const toEnd = pos + old.length === doc.lines.length;
      doc.lines.splice(pos, old.length, ...replacement(doc.lines, pos, found.tier, old, neu));
      if (toEnd) doc.final = keepBreak;
    } else {
      const pos = Math.min(Math.max(h.a + d, 0), doc.lines.length);
      const atEnd = pos === doc.lines.length;
      doc.lines.splice(pos, 0, ...neu.map((n) => n.text));
      if (atEnd) doc.final = keepBreak;
    }
    d += neu.length - old.length;
  }
}

function unifiedEdit(s: Section): Edit {
  const oldPath = s.pair ? s.minus : (s.renameFrom ?? s.gitOld);
  const newPath = s.pair ? s.plus : (s.renameTo ?? s.gitNew);
  const creation = (s.pair && s.minus === null) || s.created;
  const deletion = !creation && ((s.pair && s.plus === null) || s.deleted);
  if (creation) {
    const path = newPath ?? s.gitNew ?? '';
    const added: string[] = [];
    for (const h of s.hunks) for (const b of h.body) if (b.kind === '+') added.push(b.text);
    const lastPlus = s.hunks.filter((h) => h.body.some((b) => b.kind === '+')).pop();
    const final = lastPlus === undefined ? true : !noFinalBreak(lastPlus.body, '+');
    return ({ tree }) => {
      mustBeSafe(path);
      mustNotExist(tree, path);
      tree.put(path, newFile(added, final));
    };
  }
  if (deletion) {
    const path = oldPath ?? s.gitOld ?? '';
    return ({ tree }) => {
      mustBeSafe(path);
      mustExist(tree, path);
      tree.put(path, null);
    };
  }
  const from = oldPath ?? '';
  const to = newPath ?? '';
  return ({ tree, strict }) => {
    if (from !== to) {
      mustBeSafe(from, to);
      const text = mustExist(tree, from);
      mustNotExist(tree, to);
      const doc = readDoc(text);
      applyHunks(doc, s.hunks, strict, from);
      moveFile(tree, from, to, writeDoc(doc));
    } else {
      mustBeSafe(from);
      const doc = readDoc(mustExist(tree, from));
      applyHunks(doc, s.hunks, strict, from);
      tree.put(from, writeDoc(doc));
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let lastPath: string | null = null;
  let from = 0; // first line after the previous block
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let k = i - 1; k >= from; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = lastPath;
    let mid = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        mid = k;
        break;
      }
    }
    let end = -1;
    if (mid >= 0) {
      for (let k = mid + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
    }
    if (path === null || end < 0) throw parseError(i + 1);
    lastPath = path;
    const old = lines.slice(i + 1, mid);
    const neu = lines.slice(mid + 1, end);
    edits.push(searchReplaceEdit(path, old, neu));
    from = end + 1;
    i = end;
  }
  return edits;
}

function searchReplaceEdit(path: string, old: string[], neu: string[]): Edit {
  return ({ tree, strict }) => {
    mustBeSafe(path);
    if (old.length === 0) {
      mustNotExist(tree, path);
      tree.put(path, newFile(neu, true));
      return;
    }
    const doc = readDoc(mustExist(tree, path));
    const found = findBlock(doc.lines, old, strict);
    if (found === null) throw new Failure('no-match', path);
    if (found.at.length > 1) throw new Failure('ambiguous', path);
    const pos = found.at[0]!;
    const rows = replacement(
      doc.lines,
      pos,
      found.tier,
      old,
      neu.map((text) => ({ text, ctx: null })),
    );
    doc.lines.splice(pos, old.length, ...rows);
    tree.put(path, writeDoc(doc));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// V4A patches (section 8)

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

const ADD = '*** Add File: ';
const DEL = '*** Delete File: ';
const UPD = '*** Update File: ';
const MOVE = '*** Move to: ';

function parseV4A(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw parseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseError(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (last <= first || lines[last]!.trim() !== '*** End Patch') throw parseError(lines.length + 1);

  // Cut the lines between the markers into sections.
  const sections: { kind: string; at: number; path: string; rows: number[] }[] = [];
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    const kind = l.startsWith(ADD) ? ADD : l.startsWith(DEL) ? DEL : l.startsWith(UPD) ? UPD : null;
    if (kind !== null) {
      sections.push({ kind, at: i, path: l.slice(kind.length).trim(), rows: [] });
      continue;
    }
    if (sections.length === 0) {
      if (isBlank(l)) continue;
      throw parseError(i + 1);
    }
    sections[sections.length - 1]!.rows.push(i);
  }
  for (const s of sections) while (s.rows.length > 0 && isBlank(lines[s.rows[s.rows.length - 1]!]!)) s.rows.pop();

  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === ADD) {
      const content: string[] = [];
      for (const r of s.rows) {
        const l = lines[r]!;
        if (l === '') content.push('');
        else if (l[0] === '+') content.push(l.slice(1));
        else throw parseError(r + 1);
      }
      edits.push(({ tree }) => {
        mustBeSafe(s.path);
        mustNotExist(tree, s.path);
        tree.put(s.path, newFile(content, true));
      });
    } else if (s.kind === DEL) {
      if (s.rows.length > 0) throw parseError(s.rows[0]! + 1);
      edits.push(({ tree }) => {
        mustBeSafe(s.path);
        mustExist(tree, s.path);
        tree.put(s.path, null);
      });
    } else {
      let moveTo: string | null = null;
      const chunks: Chunk[] = [];
      let open: Chunk | null = null;
      s.rows.forEach((r, n) => {
        const l = lines[r]!;
        if (n === 0 && l.startsWith(MOVE)) {
          moveTo = l.slice(MOVE.length).trim();
          return;
        }
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          open = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(open);
          return;
        }
        if (l === '*** End of File') {
          if (open === null) {
            if (chunks.length > 0) throw parseError(r + 1);
            open = { anchor: null, body: [], eof: false };
            chunks.push(open);
          }
          open.eof = true;
          open = null;
          return;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (open === null) {
            if (chunks.length > 0) throw parseError(r + 1);
            open = { anchor: null, body: [], eof: false };
            chunks.push(open);
          }
          (open as Chunk).body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0] as BodyLine['kind'], text: l.slice(1) });
          return;
        }
        throw parseError(r + 1);
      });
      if (chunks.length === 0 && moveTo === null) throw parseError(s.at + 1);
      edits.push(v4aUpdate(s.path, moveTo, chunks));
    }
  }
  return edits;
}

function v4aUpdate(path: string, moveTo: string | null, chunks: Chunk[]): Edit {
  return ({ tree, strict }) => {
    if (moveTo === null) mustBeSafe(path);
    else mustBeSafe(path, moveTo);
    const text = mustExist(tree, path);
    if (moveTo !== null) mustNotExist(tree, moveTo);
    const doc = readDoc(text);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const found = findBlock(doc.lines, [c.anchor], strict, (i) => i >= cursor);
        if (found === null) throw new Failure('no-match', path);
        cursor = found.at[0]! + 1;
      }
      const old: string[] = [];
      const neu: NewLine[] = [];
      for (const b of c.body) {
        if (b.kind === ' ') {
          neu.push({ text: b.text, ctx: old.length });
          old.push(b.text);
        } else if (b.kind === '-') old.push(b.text);
        else neu.push({ text: b.text, ctx: null });
      }
      if (old.length === 0) {
        const pos = c.eof ? doc.lines.length : Math.min(cursor, doc.lines.length);
        doc.lines.splice(pos, 0, ...neu.map((n) => n.text));
        cursor = pos + neu.length;
        continue;
      }
      const n = doc.lines.length;
      const found = findBlock(doc.lines, old, strict, (i) => i >= cursor && (!c.eof || i + old.length === n));
      if (found === null) throw new Failure('no-match', path);
      const pos = found.at[0]!;
      const rows = replacement(doc.lines, pos, found.tier, old, neu);
      doc.lines.splice(pos, old.length, ...rows);
      cursor = pos + rows.length;
    }
    if (moveTo !== null) moveFile(tree, path, moveTo, writeDoc(doc));
    else tree.put(path, writeDoc(doc));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// JSON edits (section 9)

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const path = o.path;
  if (typeof path !== 'string') return null;
  switch (o.command) {
    case 'create': {
      const body = o.file_text;
      if (typeof body !== 'string') return null;
      return ({ tree }) => {
        mustBeSafe(path);
        mustNotExist(tree, path);
        tree.put(path, body);
      };
    }
    case 'str_replace': {
      const from = o.old_str;
      const to = o.new_str === undefined ? '' : o.new_str;
      if (typeof from !== 'string' || from === '' || typeof to !== 'string') return null;
      return ({ tree }) => {
        mustBeSafe(path);
        const text = mustExist(tree, path);
        const crlf = readDoc(text).br === '\r\n';
        const unify = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
        const hay = unify(text);
        const needle = unify(from);
        let count = 0;
        for (let k = hay.indexOf(needle); k >= 0 && count < 2; k = hay.indexOf(needle, k + 1)) count += 1;
        if (count === 0) throw new Failure('no-match', path);
        if (count > 1) throw new Failure('ambiguous', path);
        const at = hay.indexOf(needle);
        const out = hay.slice(0, at) + unify(to) + hay.slice(at + needle.length);
        tree.put(path, crlf ? out.split('\n').join('\r\n') : out);
      };
    }
    case 'insert': {
      const line = o.insert_line;
      const add = o.new_str;
      if (typeof line !== 'number' || !Number.isInteger(line) || typeof add !== 'string') return null;
      const rows = splitPatch(add);
      return ({ tree }) => {
        mustBeSafe(path);
        const doc = readDoc(mustExist(tree, path));
        if (line < 0 || line > doc.lines.length) throw new Failure('no-match', path);
        doc.lines.splice(line, 0, ...rows);
        tree.put(path, writeDoc(doc));
      };
    }
    default:
      return null;
  }
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw parseError(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let all: unknown;
    try {
      all = JSON.parse(text);
    } catch {
      throw parseError(first + 1);
    }
    if (!Array.isArray(all)) throw parseError(first + 1);
    for (const item of all) {
      const e = jsonEdit(item);
      if (e === null) throw parseError(first + 1);
      edits.push(e);
    }
    return edits;
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (isBlank(lines[i]!)) continue;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(lines[i]!));
    } catch {
      e = null;
    }
    if (e === null) throw parseError(i + 1);
    edits.push(e);
  }
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------
// The command (sections 1, 2 and 10)

const FORMAT_NAMES = new Set(['auto', 'unified', 'search-replace', 'v4a', 'json']);

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function mend(argv: string[]): { code: number; lines: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let optionsDone = false;
  for (const a of argv) {
    if (!optionsDone && a === '--') {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.has(a.slice('--format='.length))) format = a.slice('--format='.length);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, lines: ['error: usage'] };
      continue;
    }
    positional.push(a);
  }
  if (positional.length > 1) return { code: 2, lines: ['error: usage'] };

  const source = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  if (source === null) {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(source, 'utf8');
    } catch {
      return { code: 2, lines: ['error: no-patch'] };
    }
  }

  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, lines: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'v4a') edits = parseV4A(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseUnified(lines).map(unifiedEdit);
    if (edits.length === 0) throw parseError(1);
  } catch (e) {
    if (e instanceof Stop) return { code: 2, lines: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const ctx: Ctx = { tree, strict };
  const failures: Failure[] = [];
  for (const edit of edits) {
    const saved = tree.save();
    try {
      edit(ctx);
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      tree.restore(saved);
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      lines: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }

  // What changed, path by path.
  const changed = new Map<string, 'A' | 'D' | 'M'>();
  for (const [p, now] of tree.now) {
    const was = tree.original(p);
    if (was === now) continue;
    changed.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: [string, string][] = [];
  const paired = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (paired.has(from) || paired.has(to)) continue;
    if (changed.get(from) === 'D' && changed.get(to) === 'A') {
      paired.add(from);
      paired.add(to);
      rows.push([to, `R ${from} -> ${to}`]);
    }
  }
  for (const [p, c] of changed) if (!paired.has(p)) rows.push([p, `${c} ${p}`]);
  rows.sort((x, y) => byteOrder(x[0], y[0]));

  if (!check) {
    for (const p of [...changed.keys()].sort(byteOrder)) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
    }
    for (const p of [...changed.keys()].sort(byteOrder)) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const n = rows.length;
  return { code: 0, lines: [...rows.map((r) => r[1]), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = mend(process.argv.slice(2));
  writeSync(1, r.lines.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
