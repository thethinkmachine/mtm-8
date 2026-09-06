# The 8-tape minimal accumulator CPU — ISA and programming guide

For `mtm-cpu.automaton`, an 8-tape Turing machine (`MTM`) that fetches, decodes and
executes a stored program. It is a real CPU: the program is data on tape 1, and the
machine walks it, decodes opcodes, and runs an ALU, a RAM, an index register and a
call stack against it.

## Specifications

| | |
|---|---|
| Machine | 8-tape deterministic Turing machine, 614 states, 19,191 transitions |
| Word size | 5 bits, unsigned, wraps mod 32 (two's complement for SUB) |
| Registers | `A` accumulator, `X` index register, one flag |
| RAM | 32 words, addresses 0–31, 5 cells per word, total 160 bits |
| Program | up to 256 instructions (8-bit absolute jump targets) |
| Call stack | 8-bit return addresses, one frame deep in practice |
| Opcodes | 19 |
| Halting | reaching `!` is the machine's single accepting state |

### The tapes

| # | Role |
|---|---|
| 1 | **ROM** — the program, and the only tape the input is written on |
| 2 | **A** — accumulator, 5 bits |
| 3 | **FLAG** — `f` (set) or `g` (clear) |
| 4 | **OPERAND** — the decoded operand, then the unary tally the RAM walk consumes |
| 5 | **RAM** — 32 words × 5 cells |
| 6 | **CALL counter** — unary work tape for the return-address computation |
| 7 | **X** — index register, 5 bits |
| 8 | **Return stack** — 8-bit return addresses |

Only tape 1 is written by you. The rest start blank and are set up by the machine's
own initialisation sequence.

## Closest real-life counterpart

**A 5-bit MOS 6502.** The correspondence is not superficial — it is the register file
and the mnemonics:

- One accumulator plus **one X index register**, with `TAX` / `TXA` to move between
  them and `LDX` / `STX` for X-indexed memory. Those are 6502 mnemonics, and this
  machine's `U V D E` are exactly them.
  
- `CMP` sets the flag on **`A >= operand`** — that is the 6502's carry flag after a
  compare, not a zero flag, and the conditional branch is therefore a `BCS`.
- Accumulator-plus-index with immediate and indexed addressing, and `JSR`/`RTS`
  subroutines, is the 6502 programming model in miniature.

Architecturally it also sits in the **PDP-8 / Intersil 6100** lineage — a single
accumulator, memory-reference instructions, no general-purpose register file. What it
lacks against both is interrupts, a stack pointer you can touch, indirect addressing
through memory, and any I/O; and its jumps are unusually shaped (see below).

## Program format

```
^ flag # seed # <instruction>... !
```

- `flag` is `f` or `g` — the flag's initial value.
- `seed` is 5 bits — the initial accumulator.
- Every instruction is `OP # operand #`, **including the trailing `#`**. Leaving it
  off is the single most common mistake; the machine will reject.
- `!` is `HLT`, and reaching it is what makes the run accept.

Instructions are numbered from **0** for jump targets.

```
^f#00000#A#00011#!          A = 0 + 3, halt
```

## Instruction set specification

Operand widths differ by group; the assembler handles this for you.

### Arithmetic and logic — 5-bit immediate

| Op | Mnemonic | Effect |
|---|---|---|
| `A` | `ADD n` | `A = A + n` (mod 32) |
| `S` | `SUB n` | `A = A - n` (mod 32) |
| `N` | `AND n` | `A = A & n` |
| `O` | `ORA n` | `A = A \| n` |
| `X` | `EOR n` | `A = A ^ n` |
| `C` | `CMP n` | flag `f` if `A >= n`, else `g`. `A` unchanged |

### Memory — 5-bit address

| Op | Mnemonic | Effect |
|---|---|---|
| `L` | `LDA addr` | `A = RAM[addr]` |
| `T` | `STA addr` | `RAM[addr] = A` |

### Index register — operand is the literal `0`

| Op | Mnemonic | Effect |
|---|---|---|
| `U` | `TAX` | `X = A` |
| `V` | `TXA` | `A = X` |
| `E` | `STX` | `RAM[X] = A` (indexed store) |
| `D` | `LDX` | `A = RAM[X]` (indexed load) |
| `W` | `JMPX` | jump to the instruction numbered `X` |

### Control flow

| Op | Mnemonic | Operand | Effect |
|---|---|---|---|
| `J` | `BCS d` | one digit 0–9 | if flag is `f`, skip `d` instructions |
| `M` | `SKP d` | one digit 0–9 | skip `d` instructions, always |
| `P` | `JMP n` | 8-bit | jump to absolute instruction `n` |
| `K` | `JSR n` | 8-bit | push return address, jump to `n` |
| `R` | `RTS` | literal `0` | pop and return |
| `!` | `HLT` | none | halt and accept |

**The two branch shapes are the thing to internalise.** `BCS`/`SKP` are *relative
forward skips* capped at 9 instructions, so they can only jump ahead and only a
short way. `JMP`/`JSR` are *absolute* and can go anywhere, including backwards.
So every loop is built the same way: a `BCS` forward to the exit, and a `JMP`
backward to the top.

## Writing programs

The idiom for a counted loop:

```
        .acc 0
loop:   ADD 1           ; 0
        CMP 3           ; 1   flag = f once A >= 3
        BCS done        ; 2   forward, short
        JMP loop        ; 3   backward, absolute
done:   HLT             ; 4
```

Multiply by repeated addition — same shape, different step:

```
        .acc 0
loop:   ADD 4
        CMP 12
        BCS done
        JMP loop
done:   HLT
```

A subroutine. `JSR` pushes the address of the instruction *after* it, so `RTS`
resumes there; the caller has to jump over the subroutine body:

```
        .acc 0
        ADD 1           ; 0
        JSR sub         ; 1   returns to 2
        ADD 1           ; 2
        SKP 2           ; 3   hop over the body
sub:    ADD 10          ; 4
        RTS             ; 5
        HLT             ; 6
```

Indexed access, walking a small table:

```
        .acc 7
        TAX             ; X = 7
        STX             ; RAM[7] = A
        AND 0           ; clear A
        LDX             ; A = RAM[7]
        HLT
```

### Things that will catch you

- **The trailing `#` is mandatory** on every operand.
- **`BCS`/`SKP` cannot reach backwards** and cannot skip more than 9. The assembler
  will refuse a label that is out of range and tell you to use `JMP`.
- **`CMP` is `>=`, not `==`.** A loop that waits for equality will overshoot if the
  step does not divide the target; test `A >= limit`.
- **Words wrap at 32.** `ADD 5` on 30 gives 3.
- **`RTS` with an empty stack halts**, it does not fault.
- **A jump past the last instruction halts** rather than running off the end.
- Instruction numbering starts at 0 and counts *instructions*, not characters.

## Assembler

`mtm-cpu-asm.mjs` in this folder assembles and disassembles.

```bash
node mtm-cpu-asm.mjs asm prog.s          # assembly -> tape string
node mtm-cpu-asm.mjs dis '^f#00000#...'  # tape string -> assembly
node mtm-cpu-asm.mjs demo                # the worked examples above
```

Paste the tape string into the app's run box with `mtm-cpu.automaton` open.
Directives are `.acc n` (initial accumulator) and `.flag f|g`; `;` starts a comment;
`label:` marks an instruction.

## How to run

The complete process is straightforward:

1. **Load the automaton.**
   Open **Automata Studio** and load the `mtm-cpu.automaton` file into the application.

2. **Write your program.**
   Open `mtm-cpu-asm.mjs` and write your program using the assembly language defined in this specification. Follow the machine's ISA, operand formats, directives, and control-flow rules described above.

   For example:

   ```asm
   .flag f
   .acc 0

   ADD 3
   HLT
   ```

3. **Assemble the program.**
   Run the assembler to convert the assembly program into the machine's tape-string format:

   ```bash
   node mtm-cpu-asm.mjs asm prog.s
   ```

   The assembler will produce a string beginning with the required program header and containing the encoded instructions, for example:

   ```text
   ^f#00000#A#00011#! 
   ```

4. **Copy the generated machine code.**
   Copy the complete tape string produced by the assembler. Do not modify it manually—the separators, operand encoding, and trailing `#` characters are part of the machine's input format.

5. **Paste it into Automata Studio.**
   In Automata Studio, open the **Simulate String** section for the loaded `mtm-cpu.automaton`. Paste the generated tape string into the input/language field.

6. **Run the machine.**
   Start the simulation by pressing **Play**. Automata Studio will execute the 8-tape Turing machine automatically. The machine will initialize its internal tapes, fetch and decode the program from tape 1, execute each instruction, and perform the required ALU, RAM, index-register, and control-flow operations.

7. **Inspect the result.**
   Once the simulation runs, the resulting machine state/output is displayed in Automata Studio below the simulation area. This is where you can observe the result produced by your program and inspect the machine's execution.

In short, the workflow is:

```text
mtm-cpu.automaton
       ↓
Load into Automata Studio
       ↓
Write assembly program (.s)
       ↓
Run mtm-cpu-asm.mjs
       ↓
Generated tape string / machine code
       ↓
Copy the string
       ↓
Paste into Automata Studio → Simulate String
       ↓
Press Play
       ↓
Machine executes the program
       ↓
Inspect the result below the simulation
```

The important distinction is that **you never manually construct the machine's tape encoding**. Write the program in the provided assembly language, let `mtm-cpu-asm.mjs` assemble it (or use the web based interface), and use the resulting tape string as the input to `mtm-cpu.automaton`.
