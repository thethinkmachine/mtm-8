#!/usr/bin/env node
// Assembler and disassembler for mtm-cpu.automaton. See mtm-cpu-isa.md.
//
//   node mtm-cpu-asm.mjs asm prog.s
//   node mtm-cpu-asm.mjs dis '^f#00000#A#00011#!'
//   node mtm-cpu-asm.mjs demo
//
// Operand widths differ by group, which is most of what this exists to hide:
// the ALU and memory ops take 5 bits, JMP/JSR take 8, the index ops take a
// literal 0, and the two relative branches take a single decimal digit.

/** kind: imm5 | addr5 | zero | rel | abs8 | none */
export const OPS = {
  ADD: { c: 'A', kind: 'imm5' }, SUB: { c: 'S', kind: 'imm5' },
  AND: { c: 'N', kind: 'imm5' }, ORA: { c: 'O', kind: 'imm5' },
  EOR: { c: 'X', kind: 'imm5' }, CMP: { c: 'C', kind: 'imm5' },
  LDA: { c: 'L', kind: 'addr5' }, STA: { c: 'T', kind: 'addr5' },
  TAX: { c: 'U', kind: 'zero' }, TXA: { c: 'V', kind: 'zero' },
  STX: { c: 'E', kind: 'zero' }, LDX: { c: 'D', kind: 'zero' },
  JMPX: { c: 'W', kind: 'zero' },
  BCS: { c: 'J', kind: 'rel' }, SKP: { c: 'M', kind: 'rel' },
  JMP: { c: 'P', kind: 'abs8' }, JSR: { c: 'K', kind: 'abs8' },
  RTS: { c: 'R', kind: 'zero' },
  HLT: { c: '!', kind: 'none' },
};
const BY_CODE = Object.fromEntries(Object.entries(OPS).map(([m, o]) => [o.c, { m, ...o }]));
const b5 = n => (((n % 32) + 32) % 32).toString(2).padStart(5, '0');
const b8 = n => (((n % 256) + 256) % 256).toString(2).padStart(8, '0');

class AsmError extends Error {}
const fail = (line, msg) => { throw new AsmError(line ? `line ${line}: ${msg}` : msg); };

export function assemble(src) {
  let acc = 0, flag = 'f';
  const rows = [];                       // {mn, arg, line}
  const labels = new Map();

  for (const [i, raw] of src.split(/\r?\n/).entries()) {
    const line = i + 1;
    const text = raw.replace(/;.*$/, '').trim();
    if (!text) continue;
    let rest = text;
    const lab = /^([A-Za-z_][\w]*)\s*:\s*/.exec(rest);
    if (lab) {
      if (labels.has(lab[1])) fail(line, `duplicate label "${lab[1]}"`);
      labels.set(lab[1], rows.length);
      rest = rest.slice(lab[0].length).trim();
      if (!rest) continue;
    }
    const [head, ...args] = rest.split(/[\s,]+/);
    const dir = head.toLowerCase();
    if (dir === '.acc') { acc = num(args[0], line); continue; }
    if (dir === '.flag') {
      const f = (args[0] || '').toLowerCase();
      if (f !== 'f' && f !== 'g') fail(line, `.flag takes f or g, got "${args[0]}"`);
      flag = f; continue;
    }
    if (dir.startsWith('.')) fail(line, `unknown directive "${head}"`);
    const mn = head.toUpperCase();
    if (!OPS[mn]) fail(line, `unknown mnemonic "${head}"`);
    if (args.length > 1) fail(line, `${mn} takes at most one operand`);
    rows.push({ mn, arg: args[0], line });
  }
  if (!rows.length || rows[rows.length - 1].mn !== 'HLT') rows.push({ mn: 'HLT' });

  const out = [`^${flag}#${b5(acc)}#`];
  for (const [pc, r] of rows.entries()) {
    const { c, kind } = OPS[r.mn];
    if (kind === 'none') { out.push('!'); continue; }
    if (kind === 'zero') {
      if (r.arg !== undefined) fail(r.line, `${r.mn} takes no operand`);
      out.push(`${c}#0#`); continue;
    }
    if (r.arg === undefined) fail(r.line, `${r.mn} needs an operand`);
    if (kind === 'imm5') { out.push(`${c}#${b5(num(r.arg, r.line))}#`); continue; }
    if (kind === 'addr5') {
      const a = num(r.arg, r.line);
      if (a < 0 || a > 31) fail(r.line, `address ${a} is outside RAM (0..31)`);
      out.push(`${c}#${b5(a)}#`); continue;
    }
    const target = resolve(r.arg, labels, r.line);
    if (kind === 'abs8') {
      if (target < 0 || target > 255) fail(r.line, `target ${target} is outside 0..255`);
      out.push(`${c}#${b8(target)}#`); continue;
    }
    // rel: a label means "skip to there", a bare number is the skip count itself
    const skip = labels.has(r.arg) ? target - (pc + 1) : target;
    if (skip < 0) fail(r.line, `${r.mn} cannot branch backwards (target is ${-skip} before it) - use JMP`);
    if (skip > 9) fail(r.line, `${r.mn} can skip at most 9 instructions, needs ${skip} - use JMP`);
    out.push(`${c}#${skip}#`);
  }
  return out.join('');
}
function num(tok, line) {
  if (tok === undefined) fail(line, 'expected a number');
  const m = /^(0[bB][01]+|0[xX][0-9a-fA-F]+|-?\d+)$/.exec(tok.trim());
  if (!m) fail(line, `"${tok}" is not a number`);
  return Number(tok.replace(/^0[bB]/, '0b'));
}
function resolve(tok, labels, line) {
  if (labels.has(tok)) return labels.get(tok);
  if (/^[A-Za-z_]/.test(tok)) fail(line, `unknown label "${tok}"`);
  return num(tok, line);
}

export function disassemble(tape) {
  const m = /^\^([fg])#([01]{5})#(.*)!$/.exec(tape.trim());
  if (!m) throw new AsmError('not a program: expected ^flag#seed5#...!');
  const [, flag, seed, body] = m;
  const rows = [];
  let i = 0;
  while (i < body.length) {
    const op = BY_CODE[body[i]];
    if (!op) throw new AsmError(`byte ${i}: unknown opcode "${body[i]}"`);
    i++;
    if (op.kind === 'none') { rows.push([op.m]); continue; }
    if (body[i] !== '#') throw new AsmError(`byte ${i}: expected # after ${op.m}`);
    i++;
    const end = body.indexOf('#', i);
    if (end < 0) throw new AsmError(`byte ${i}: unterminated operand for ${op.m}`);
    const field = body.slice(i, end);
    i = end + 1;
    rows.push(op.kind === 'zero' ? [op.m]
      : op.kind === 'rel' ? [op.m, Number(field)]
        : [op.m, parseInt(field, 2)]);
  }
  rows.push(['HLT']);   // the '!' the header regex consumed is a real instruction
  // name the instructions that are jumped to, so the listing reads as a program
  const named = new Map();
  rows.forEach(([mn, arg], pc) => {
    const k = OPS[mn].kind;
    const t = k === 'abs8' ? arg : k === 'rel' ? pc + 1 + arg : null;
    if (t !== null && t >= 0 && t < rows.length && !named.has(t)) named.set(t, `L${named.size}`);
  });
  const lines = [`        .flag ${flag}`, `        .acc ${parseInt(seed, 2)}`, ''];
  rows.forEach(([mn, arg], pc) => {
    const k = OPS[mn].kind;
    const ref = k === 'abs8' ? named.get(arg) : k === 'rel' ? named.get(pc + 1 + arg) : null;
    const operand = arg === undefined ? '' : ' ' + (ref || arg);
    lines.push(`${(named.get(pc) ? named.get(pc) + ':' : '').padEnd(8)}${mn}${operand}`.trimEnd()
      + `${' '.repeat(Math.max(1, 24 - (8 + mn.length + operand.length)))}; ${pc}`);
  });
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────
const DEMOS = {
  'count to 3': `        .acc 0
loop:   ADD 1
        CMP 3
        BCS done
        JMP loop
done:   HLT`,
  '4 x 3 by repeated addition': `        .acc 0
loop:   ADD 4
        CMP 12
        BCS done
        JMP loop
done:   HLT`,
  'subroutine call and return': `        .acc 0
        ADD 1
        JSR sub
        ADD 1
        SKP 2
sub:    ADD 10
        RTS
        HLT`,
  'X-indexed store then load': `        .acc 7
        TAX
        STX
        AND 0
        LDX
        HLT`,
};

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('mtm-cpu-asm.mjs')) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'asm') {
      const { readFileSync } = await import('node:fs');
      const src = rest[0] ? readFileSync(rest[0], 'utf8') : readFileSync(0, 'utf8');
      console.log(assemble(src));
    } else if (cmd === 'dis') {
      console.log(disassemble(rest.join(' ')));
    } else if (cmd === 'demo') {
      for (const [name, src] of Object.entries(DEMOS)) {
        console.log(`\n=== ${name} ===`);
        console.log(src.split('\n').map(l => '  ' + l).join('\n'));
        console.log('  -> ' + assemble(src));
      }
    } else {
      console.log('usage: mtm-cpu-asm.mjs asm <file> | dis <tape> | demo');
      process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    console.error(e instanceof AsmError ? 'error: ' + e.message : e);
    process.exit(1);
  }
}
