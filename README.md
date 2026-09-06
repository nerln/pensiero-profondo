# ciurma

Run a crew of Claude Code agents as a research lab: roles, a shared blackboard, rituals of
adversarial verification, and machines anywhere.

What it adds to plain Claude Code is the method: who is allowed to claim a number, what
happens to a number after it is claimed, how a second agent is made to disagree on purpose,
and what has to be true before anything leaves the machine under your name.

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

The token is in `.ciurma/config.json`. A browser on the hub's own machine gets it from the
page; a browser on another host adds `?token=TOKEN` to the URL once. Bind the hub to a
non-loopback host with `ciurma hub --host 0.0.0.0` only on a network you trust.

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

Mandates are Markdown files. `ciurma init` copies them to `.ciurma/roles/` in your project, and
`ciurma hub` re-reads that folder every time it starts. Edit them; they are the product.

## Security model

The board carries text from one session into another. That is the feature and the risk. Four
things hold regardless of what an entry says: every delivery goes through one frame; every
quoted line starts with `| `; entries are capped at 700 characters and deliveries at 12; and
the hub never executes anything found on the board. The frame's wording is the fifth defence
and the weakest, which is why it is listed last.

Every API call and every UI socket presents the token, loopback included: a web page open on
the owner's machine is loopback too, and without the token it could sign on members or read
transcripts. The page served on loopback carries the token, and another origin cannot read that
page because the hub never sends CORS headers; a browser on another host adds `?token=` once.
Worker sockets carry the token in their first message and are refused if they come from a
browser. A worker may only speak for members on its own machine. There is no other
authentication.

## Status

v0.1. Working: init, hub, local and remote workers, live transcripts, send, interrupt, model
change, the board with frames and caps, the Attack ritual, budget cap. The Cartographer and
the Boatswain exist as roles you sign on by hand; their rituals (blind re-derivation,
arbitration) are not automated yet. Not yet in the UI:
council and consent rituals, gates, a Captain adapter for non-Claude models, a permission
approval flow for tool calls. Until that flow exists, a tool call that would ask for
permission is allowed for roles under `acceptEdits` and denied for roles under `dontAsk`, so a
role that must stay narrow lists its tools or uses `dontAsk`.

## Credit

Made by [Eugenio Nerelli](https://github.com/nerln). The design comes from the Vesuvius
Challenge campaign of August and September 2026; the implementation was written with Claude
Code under his direction. If you build on this, keep the credit.

MIT licence, see [LICENSE](LICENSE).
