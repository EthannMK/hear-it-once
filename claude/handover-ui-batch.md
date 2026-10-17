# Handover — the UI batch of 17 Oct

Read `claude/hear-it-once-handover.md` first for the project as a whole. This file covers one batch
of front-end requests, three of which are done and three of which are not started.

Head is `e2ca92c`, pushed to `main`.

```bash
cd ~/hear-it-once && git pull origin main
npm ci && npm test        # see "verify first" below
gcloud run deploy hear-it-once --source . --region=asia-southeast1
```

## Verify first

**`npm test` has not been run since commit `e2ca92c`.** The suite was green at 639 passed / 7 skipped
as of `f98d2d1`, and `e2ca92c` typechecks, but the voice change went in under a stop and nobody has
run the tests against it. Run them before building on this. `tests/e2e/live.test.ts` is the one most
likely to care, because it exercises the bridge through a scripted provider.

## Done

**Product and bank are now distinguishable.** The header carries the product at full weight — new
mark plus "Hear It Once" — then a divider, the word "for", the bank's own mark in its own navy and
red, and the bank name, all smaller. `public/brand/hear-it-once.svg` is the ear with the numeral one
standing in it; `public/brand/northstar.svg` is the bank's supplied artwork with the white box
dropped; `public/brand/northstar-lockup.svg` is the full mark-plus-wordmark for places with room.
The favicon and both browser tab titles carry the product.

**The hero is a call playing out.** `hero()` in `public/lily/app.js`, styles under "the hero
animation" in `public/lily/lily.css`. A card plays a short conversation, a waveform sits under it,
and three stages — Understand, Act, Connect — are in a rail beside it, linked by a connector. It
loops on a 5.2 s hold. Hovering a stage previews it, clicking pins it until clicked again, and the
loop then picks up where it was left; the rail is a real tablist so the keyboard does the same.
`prefers-reduced-motion` gets the first stage, all messages at once, no loop.

One trap worth knowing: the loop's stop function lives **on the element** (`data-loop="hero"`,
`el.stopLoop`) and `render()` calls it on the outgoing children. It cannot live in a shared variable,
because `hero()` runs while `render()`'s arguments are still being evaluated, so a central hook is
torn down by the very render that puts it on screen. That bug was there and is fixed; do not
"simplify" it back.

**One voice for the whole call.** `LIVE_MODEL` lists three models and the first that opens wins. They
do not share a voice catalogue, and a model that does not recognise the requested voice uses its own
default, which on several Live models is male — so a mid-call reconnect could change who was
speaking. `LiveBridge.modelEntry` now remembers the model the call opened on and passes it as
`pinnedEntry`, which `GeminiLiveProvider.connect` tries first; the voice is named on every path
including English, which previously passed nothing; and every session logs agent, voice and model.

## Not started

1. **Lily's delivery: warmer, slower.** Ethan chose "keep Aoede, slow it down". The voice is now
   pinned, but nothing has been added to the prompt about pace or warmth. Put a short speaking-style
   direction in `lilySystemInstruction` (`src/live/lily.ts`) — unhurried, warm, a beat before
   numbers and references. Keep it to two or three sentences; long style blocks make the model
   perform rather than talk. Cannot be verified here: it needs Google credentials and an ear.

2. **A "Demo data" tab on the agent screen.** Five customers, full details in a ready-to-copy form,
   their transactions behind expand/collapse, and instructions around it where the space allows.
   Build it as a fourth tab in the customer panel (`custPanel` in `public/lily/crm.js`, which already
   does Account · Transactions · History) or as its own panel tab — Ethan asked for "1 more tab", so
   a tab is the shape he wants. The data is already there: `/api/demo/customers` returns the cards
   with `cardNumber`, `nrcLast4`, `situation` and `tryPhrase`, and `public/lily/app.js` has a
   `demoTable()` that is no longer rendered and shows the copy-button pattern to follow. Transactions
   per customer come from the CRM endpoints. Use the existing `.txd2` expandable rows rather than
   inventing a second expand/collapse style.

3. **The Guardrails screen.** The old Safety screen must go entirely — `public/lily/safety.js`, its
   styles, and `initSafety`/`safetyRoute` in `app.js`. The header tab **already points at
   `#/guardrails`**, which currently routes nowhere, so this is the one thing that is visibly broken
   on `main` right now: fix it first. Ethan wants it rebuilt as a presentation, not an operations
   console — stepped slides a judge is walked through, showing how each safeguard is implemented,
   rather than live controls. The material is all served already and needs no new endpoints:
   `/api/fraud-patterns` (the ten documented patterns with the files that enforce each),
   `/api/audit/verify` (the hash chain, checked live), `/api/scorecard` (the last accuracy run),
   `/api/safety` (the off switch). `tests/e2e/safety-page.test.ts` covers those four endpoints and
   should be kept; it is about the data, not the page. Keep the operations controls reachable
   somewhere for a judge who asks to see the switch thrown.

## Things that will catch you out

Everything in the main handover still applies. On top of it:

- **The CSP is strict.** No inline `<script>` or `<style>`. New screens need their own `.js` and the
  styles appended to `lily.css`.
- **`render()` stops anything with `data-loop`.** Any new animated screen should register
  `el.stopLoop` the same way, or its timers outlive the screen.
- **Check the four desktop widths and 390px before pushing.** The caller's screen must not scroll at
  1280x720, 1366x768, 1440x900 or 1920x1080. Chromium is at `/opt/pw-browsers/chromium`.
- **The bank's mark keeps the bank's colours.** Do not recolour `northstar.svg` into the violet
  palette; the point of the header change is that the two brands look like two brands.

## Working agreements with Ethan

- Short sentences, plain English, no bullet-point walls in chat. Sign off as **Paing Thit Htoo**.
- Ask clarifying questions before starting a batch rather than guessing.
- Say plainly what was tested and what was not. Never claim a check that was not run.
- Code comments read like documentation for the next developer: why, not a log of the work. Never
  name him in a comment.
