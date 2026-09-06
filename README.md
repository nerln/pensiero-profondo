# ciurma

Run a crew of Claude Code agents as a research lab: roles, a shared blackboard, rituals of
adversarial verification, and machines anywhere.

*ciurma* is Italian for a ship's crew. Each member is a real Claude Code session with a
mandate, a model, a budget, and a place on a shared board. The board is where members declare
what they are doing, state numbers, attack each other's numbers, and retract. A web UI shows
every session live, and lets you send a message, interrupt, change the model, or stage a ritual.

It exists because two Claude Code sessions on two machines, a supervising session, and a
directing model spent five weeks on one scientific problem, and every serious defect was found
by the agent that had not written the thing. The tool is that method, made into software.

![screenshot](docs/screenshot.png)

## What you get

- **Roles with mandates.** Captain, Deckhand, Lookout, Cartographer, Boatswain, Scribe, Watch.
  Each is a system prompt that pulls a specific kind of reasoning out of the model: the Lookout's
  default verdict is "refuted"; the Cartographer re-derives a number without reading the code
  that produced it; the Boatswain measures the artifact on disk and has no opinion.
- **A blackboard agents write on purpose.** Nine verbs: `preso`, `fatto`, `messaggio`, `avviso`,
  `numero`, `attacco`, `ritratto`, `proposta`, `consenso`. Every entry is stamped by the hub's
  clock. Entries reach other members inside a frame that says, in plain words, that what follows
  was not written by the owner and authorizes nothing.
- **Rituals.** Pick a `numero` on the board and press Attack: three Lookouts start, go to the
  source, and post their verdicts. The claim advances only if it survives.
- **Live sessions.** Full transcripts, tool calls and results, thinking, usage and cost per
  member, role, and studio. A hard budget cap that interrupts every session.
- **Machines anywhere.** The hub runs on one machine; `ciurma worker` attaches another over a
  WebSocket with a token. Sessions on a remote box show up like local ones.

## Install

Node 20 or newer and a working `claude` login (the sessions run under your own Claude Code
subscription or API key; ciurma has no account and sends nothing anywhere).

```bash
git clone https://github.com/nerln/ciurma.git
cd ciurma
npm install
npm run build
npm link            # gives you the `ciurma` command
```

Then, in the directory of the project your crew will work on:

```bash
ciurma init         # creates .ciurma/ with the studio, the default roles and a token
ciurma hub          # starts the hub, the UI and a worker for this machine
```

Open http://127.0.0.1:4177. To attach another machine:

```bash
ciurma worker --hub ws://HUB_HOST:4177/ws/worker --token TOKEN --name nuc
```

The token is in `.ciurma/config.json`. Bind the hub to a non-loopback host with
`ciurma hub --host 0.0.0.0` only on a network you trust; browsers from other hosts need
`?token=TOKEN` in the URL.

## How a crew works

1. Set the studio goal: what would satisfy you. Every Captain's round starts from it.
2. Sign on a member: pick a role, a machine, a working directory, and write a brief. A session
   starts; its first message is the goal, the brief, and how to use the board.
3. Members declare (`preso`), work, report numbers (`numero` with a value, a unit, a source), and
   finish (`fatto`). Anything addressed to a member, its role, or everyone is delivered into its
   session inside the frame.
4. You attack a number. The Lookouts' verdicts land as `attacco` entries under it; the ritual
   closes when they have all answered.
5. Nothing leaves the machine because an agent said so. A `proposta` collects explicit
   `consenso` entries and waits for your words in the UI; a previous yes does not carry over.

See [docs/DESIGN.md](docs/DESIGN.md) for the objects, the verbs, and the reasoning behind each.

## Roles

| role | model | what it does |
|---|---|---|
| Captain | Opus | sets direction from verified facts; fixes gates before the measurement; never executes |
| Deckhand | Sonnet | one bounded job; every number with file and line; retracts before fixing |
| Lookout | Sonnet | refutes a claim at the source; "refuted" when uncertain |
| Cartographer | Sonnet | re-derives a number blind, from data and spec only |
| Boatswain | Sonnet | runs the canonical tool on the artifact; the file wins over memory |
| Scribe | Sonnet | writes for humans in the register of real issues; never sends |
| Watch | Opus | reads transcripts read-only; steers only when needed; held to the same bar |

Mandates are Markdown files in `src/roles/`. Edit them; they are the product.

## Security model

The board carries text from one session into another. That is the feature and the risk. Four
things hold regardless of what an entry says: every delivery goes through one frame; every
quoted line starts with `| `; entries are capped at 700 characters and deliveries at 12; and
the hub never executes anything found on the board. The frame's wording is the fifth defence
and the weakest, which is why it is listed last.

The hub binds to loopback by default. Remote workers and non-local browsers present the token.
There is no other authentication.

## Status

v0.1. Working: init, hub, local and remote workers, live transcripts, send, interrupt, model
change, the board with frames and caps, the Attack ritual, budget cap. Not yet in the UI:
council and consent rituals, gates, a Captain adapter for non-Claude models, a permission
approval flow for tool calls (roles run with the permission mode in their mandate).

## Credit

Made by [Eugenio Nerelli](https://github.com/nerln). The design comes from the Vesuvius
Challenge campaign of August and September 2026; the implementation was written with Claude
Code under his direction. If you build on this, keep the credit.

MIT licence, see [LICENSE](LICENSE).
