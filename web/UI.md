# The interface, and why it looks like this

The first web UI was a faithful translation of the Qt application: a wheel of
parameters, a dialog for the bug, a histogram for the genes. That was the right
thing to do while the port was unproven — it made "the model behaves like the
original" checkable by anyone who knew the original — and it is the wrong thing
now. The port is done; the interface is no longer a claim about the model, it is
the thing people will actually use.

So this is a fresh design. What follows is what the old interface assumed, what
replaces it, and what the replacement is *for*.

## Who it is for

Two audiences, one page:

- **someone watching an ecosystem**, who wants a living picture, a population
  curve and the ability to poke an interesting creature;
- **someone learning how a program and an inherited genome relate**, who wants to
  read the machine, one instruction at a time, and see what the world did to it.

The second audience is the one the old UI served worst, and the one this is a
tool for. A bug is a CPU with 8-bit registers running an assembly program that it
also passes to its children, mutated. Almost every part of that sentence is
invisible in the Qt layout: the instruction pointer was a number in a dialog, the
senses were never shown at all, and the genome was a byte strip.

## The stage and the rail

Everything is one of two things: **the stage** — the world and its history, which
is what the simulation *is* — or **the rail**, the instruments you point at one
particular bug or one particular setting.

    +---------------------------------------------+-----------------+
    | header: world, tick, population, generation |                 |
    +---------------------------------------------+                 |
    |                                             |                 |
    |                 stage                       |      rail       |
    |         (dish, or charts, or both)          |  Bug  Genome    |
    |                                             |  Params  World  |
    +---------------------------------------------+                 |
    | stat tiles: pop, gen, diversity, energy ... |                 |
    +---------------------------------------------+-----------------+
    | chart strip: population | generations | ... |                 |
    +---------------------------------------------+-----------------+

The header carries the four numbers you check constantly. The rail holds the
instruments. The stage is switchable between **Dish**, **Split** and **Charts**,
because the honest answer to "do we need both at once" is: sometimes, and the
person watching knows which minute they are in.

The chart strip is always present under the stage — a population curve is the one
piece of context that makes a dish of dots mean something, and putting it in a tab
meant nobody ever saw it.

## What each instrument is

**Bug** — the machine. Registers, the stack, what it can see, what it decided, and
the program it decided it with. The listing highlights the instruction the
pointer is standing on and can be edited byte by byte. Above it, the previous
tick's deltas: ip moved this far, the accumulator went from this to that, energy
fell by this much, the bug stayed put. That line is the answer to "what is it
doing", which no view in the original answered.

**Genome** — inherited material. The genome as a strip coloured by instruction
class, the gene variance histogram (kept: it is the best picture of *convergence*
the port has), and the population's instruction repertoire — which opcodes exist
at all, and how much of the whole population runs them. Evolution of a
programming language, measured.

**Params** — grouped by what a dial actually does to the world, with the model's
own keys as titles so the panel cannot drift from the code. Mutation gets the
compressed slider: the interesting range is 1e-4 to 1e-1, and a linear slider
cannot express it.

**World** — new world, presets, save/load. Worlds are text, so they are also
something you can hand to somebody.

## Two bugs this design has to not repeat

- **The dish was drawn transposed.** The blit wrote `image32[hash]`, which places
  a column-major cell at a row-major pixel; every bug appeared mirrored across the
  diagonal, and a click selected the bug drawn at the mirrored point. Fixed in
  `src/ui/blit.ts` and asserted there, because it is the kind of thing that looks
  plausible when it is wrong.
- **Screen and cell coordinates are now one function.** `src/ui/worldView.ts`
  owns the mapping, including zoom, pan and a stage that is not square, so the
  marker, the hover probe and the click cannot disagree. Tested by round trip over
  a matrix of zooms and offsets.

## What is deliberately not here

- No framework. The page is modules and DOM, because the whole repo is a
  reference implementation and a build step that hides the wiring is a step
  nobody reads.
- No persistence of the selection across reloads. A bug reference does not
  survive a page reload, and a stale one is worse than none.
- No light theme yet. The dish is a black field by construction; a light chrome
  around it is a real design and deserves more than a variable swap.
