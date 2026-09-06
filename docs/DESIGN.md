# ciurma: design

*ciurma* (Italian: a ship's crew) is a web GUI for running many Claude Code sessions as one
research crew: roles, a shared blackboard, rituals of adversarial verification, and machines
that can be anywhere. It comes from a five-week campaign in which two Claude Code sessions,
one on a laptop and one on a remote box, plus a supervising session and an external director
model, worked on the same scientific problem. Every serious defect in that campaign was found
by the agent that had not written the thing. That is the method this tool encodes.

## What it is not

Not a workflow engine. Not a prompt library. Not a chat with tabs. Those exist. What does not
exist is a place where the *method* lives: who is allowed to claim a number, what happens to a
number after it is claimed, how a second agent is made to disagree on purpose, and what has to
be true before anything leaves the machine under the owner's name.

## The six ideas

1. **Agents contradict, they do not split.** A crew is not a pipeline. When one member states a
   result, the tool's default next step is to make another member try to break it.
2. **A number has a life.** Declared, attacked, re-derived blind, measured on the artifact with
   the canonical tool. Each stage is a blackboard entry with an author and a clock time. A
   number that is better than expected is the first one to attack.
3. **The blackboard is untrusted by construction.** Every entry an agent receives is framed as
   text written by another session, not by the owner; every quoted line carries a margin; entries
   and deliveries are capped. Nothing on the blackboard authorizes a push, a publication, a
   message, a purchase, or a deletion.
4. **Authorizations do not carry over.** Anything outward needs the owner's words for that
   specific thing. A proposal collects explicit consents and expires; silence is not consent.
5. **Time comes from the clock.** Every entry is stamped by the server at write time. Agents may
   estimate anything except when something happened. (Labels running twenty minutes ahead of
   the clock once convinced two independent reviewers that a machine did not exist.)
6. **Roles pull reasoning out.** A model asked "is this right?" hedges. The same model told it is
   the lookout whose job is to refute, with "refuted" as the default verdict, finds the flaw. The
   situations are engineered on purpose.

## Objects

| object | Italian | what it is |
|---|---|---|
| Studio | studio | one research effort: a goal, root directories, machines, budget cap |
| Role | ruolo | a mandate (system prompt), model, effort, tools, permission mode, disciplines |
| Crew member | marinaio | a role bound to a machine and a live Claude Code session |
| Machine | nave | where sessions run: the hub's own host, or a remote worker |
| Blackboard entry | voce | an append-only line with a verb, author, addressee, clock time |
| Claim | numero | an entry carrying a measured value, its source, and its verification stage |
| Gate | cancello | a threshold registered before the measurement, compared automatically after |
| Ritual | rito | a situation the tool can stage: attack, blind re-derivation, arbitration, council, consent |
| Proposal | proposta | an outward action waiting for explicit consents and the owner's word |

### Verbs on the blackboard

`preso` (I am taking this), `fatto` (done, and what I held is free), `messaggio` (to someone),
`avviso` (a warning about the commons: memory, disk, budget), `numero` (a claim with a value),
`attacco` (a refutation attempt with a verdict), `ritratto` (a retraction), `proposta` (an
outward action needing consent), `consenso` (an explicit yes or no to a proposal).

A retraction is a first-class entry and a health signal, not a failure. The crew view shows how
many claims were retracted after attack: a crew with zero retractions over a long run is one
whose lookouts are not doing their job.

### Default roles

Names follow the crew metaphor; the mandates are the point.

- **Captain** (capitano): sets direction each round from verified facts, never executes. Gets the
  state as a prompt, answers with a direction, gates, and what to do in the next 24 hours. Told
  in the mandate that it tends to underestimate what the crew can do.
- **Deckhand** (mozzo): does one bounded, verifiable job. Reports numbers with file and line.
- **Lookout** (vedetta): attacks a claim. Default verdict is "refuted" when uncertain. Must
  verify at the source, not from the claimant's summary.
- **Cartographer** (cartografo): re-derives a number from the raw data and the spec without
  reading the claimant's code. Reports its own number and the diff.
- **Boatswain** (nostromo): runs the canonical tool on the emitted artifact and reports what it
  measures, nothing else. This is the arbiter when the lookout and cartographer disagree.
- **Scribe** (scrivano): writes for humans, in the register of real issues written by people:
  first person, dry, few bold words, no showcase sections. Prepares publications; never publishes.
- **Watch** (guardia): reads transcripts read-only, steers only when needed, and is told the
  bar applies to itself too.

### Rituals

- **Attack**: pick a claim; spawn N lookouts (default 3) with the refute mandate; each posts an
  `attacco` with a verdict. The claim advances only if the majority fails to refute.
- **Blind re-derivation**: spawn a cartographer with access to data and spec only; compare.
- **Arbitration**: spawn a boatswain with the canonical command; the artifact's number wins.
- **Council**: five advisors answer independently, review each other anonymously, a chair
  synthesizes. Used before any outward action.
- **Consent**: a proposal listing the exact text or diff that would go out; every named member
  must post a `consenso` yes; the owner's word is entered by the owner in the UI, never by an
  agent. Proposals expire.
- **Captain's round**: package the blackboard since the last round plus the owner's notes into a
  prompt; the captain's answer becomes the direction; the addendum starts empty for the next.

### Gates

A gate is registered before its measurement: claim, threshold, the command that measures, the
time of registration. When a claim arrives that matches the gate, the tool compares and marks it
passed, failed, or not comparable. The UI shows the registration time next to the result so a
reader can see the threshold was not moved after the fact.

## Architecture

One npm package, three parts, one process by default.

```
ciurma hub        HTTP + WebSocket server, SQLite studio database, serves the UI,
                  and embeds a worker for the local machine
ciurma worker     the same session runner on a remote machine, connected to the hub
                  over WebSocket with a shared token
ui/               React + Vite, served by the hub, talks WebSocket
```

Sessions are real Claude Code sessions started through `@anthropic-ai/claude-agent-sdk`
(`query()` with a streaming input channel). The worker gives every session two in-process MCP
tools, `lavagna_scrivi` and `lavagna_leggi`, that proxy to the hub. New entries addressed to a
session are delivered into it as framed user messages, the frame being the same one boa uses:
provenance line, margin `| ` on every quoted line, the list of actions that are never taken
because an entry asked for them, and a closing line the test guarantees appears once.

Authentication: the hub binds to localhost. Remote workers and non-local UI clients present a
token generated at `ciurma init`. Nothing else.

Budget: every result message carries usage; the hub sums per member, role, and studio, and the
studio cap is a hard stop that sends `interrupt()` to every session, then posts an `avviso`.

## What ships first

v0.1: init a studio with the default roles; start crew members on the local machine; live
transcripts; send, interrupt, change model; the blackboard with frames and caps; the Attack
ritual end to end; budget panel; remote worker over WebSocket; README, MIT licence.

Later: council and consent rituals in the UI, gates, a Captain adapter for external models,
a macOS shell.
