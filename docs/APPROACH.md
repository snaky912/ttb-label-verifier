# Approach

This document explains the decisions behind the prototype, organized around
what each stakeholder said in discovery. The requirements were mostly implicit
in those conversations rather than in the technical spec, so the design is
traced back to them directly.

---

## Architecture in one paragraph

A vision model reads the label and returns a verbatim transcription as JSON,
with a confidence score for every field and an assessment of image quality.
That output is treated as untrusted input: it is coerced into a fixed shape,
then handed to a deterministic rules engine that compares each field against
the application and applies TTB rules. The engine returns one of three
verdicts per field — pass, review, fail — plus a plain-English reason, and the
worst field sets the overall verdict. The engine is pure JavaScript with no
dependencies, shared byte-for-byte between the self-hosted server and the
hosted browser demo.

```
label image ──► vision model ──► coerceExtraction() ──► verifyLabel() ──► verdict
                (reads text)      (validates shape)      (decides, tested)
application data ─────────────────────────────────────────────┘
```

---

## Why the model doesn't make the decision

This was the first decision and it shaped the rest.

It is tempting to hand the model both the image and the application and ask
"does this label comply?" That would be less code. It would also produce a
compliance decision that can differ between two runs on the same input, that
no one can fully explain afterwards, and that can't be regression-tested.
None of that is acceptable for a regulatory determination an applicant may
contest.

So the model's job is narrowed to what it's best at — reading messy text off
an imperfect photograph — and it is explicitly told not to judge compliance.
Everything that matters legally happens in `src/core/verify.js`, which has 37
unit tests and reads the same way every time.

A side benefit: the extraction prompt, the rules, and the thresholds are each
independently tunable. Improving recognition never risks changing what counts
as a pass.

---

## Sarah Chen — the five-second requirement

> "If we can't get results back in about 5 seconds, nobody's going to use it.
> We learned that the hard way."

The previous vendor pilot died at 30-40 seconds per label. That makes latency a
hard requirement, not a nice-to-have, so it drove several choices:

- **A small, fast model by default.** Reading printed text off a label doesn't
  need the most capable model. The server uses Haiku; the hosted demo requests
  the `quick` tier. Both are overridable if a harder corpus needs more.
- **One model call per label, no tool loops.** Multi-round agentic calls add a
  full round trip each. Extraction is a single structured request.
- **Downscale before upload.** A phone photo is often 4-8 MB. Labels stay
  perfectly legible at 1600px on the long edge, and the smaller payload matters
  on government bandwidth. Done in the browser, falls back to the original on
  any failure.
- **Matching is local and instant.** The rules engine runs in well under a
  millisecond. There's no second model call to compare fields.
- **Latency is shown, not assumed.** Every result states how long it took and
  whether it met the five-second target. If this tool is ever slow, the agent
  sees it immediately and the number is on the record — which is what a
  procurement decision should be based on.

## Sarah Chen — usable by her 73-year-old mother

> "Clean, obvious, no hunting for buttons."

- **Two big buttons choose the mode.** Nothing is in a menu.
- **Numbered steps** for a process that genuinely is sequential: say what the
  application says, then give the picture.
- **The form opens filled in with a worked example**, so what goes in each box
  is obvious without instructions. One click clears it.
- **18px base text, near-black on white**, 48px+ button heights.
- **Verdicts are never colour alone.** Every result carries a word (*Passed*,
  *Review*, *Problem*) and a symbol as well as a colour, which works for
  colour-blind agents and survives a black-and-white photocopy.
- **Plain English throughout.** "Application says 45% ABV, label says 47% — a
  difference of 2 points, over the 0.15% tolerance," not an error code.

## Sarah Chen — batch uploads for 200-300 labels

- Drop a folder of images; optionally load a CSV of application data matched to
  images by file name. A blank template is one click away.
- Labels are processed **four at a time**, and results stream into the table as
  each finishes, rather than the agent staring at a spinner until the slowest
  of 300 completes.
- The server stays stateless: the client fires concurrent single-label requests.
  No job queue, no stored batch, nothing to clean up.
- A **Stop** button, a live count, and a CSV export of the results.

## Dave Morrison — "you need judgment"

> "'STONE'S THROW' on the label but 'Stone's Throw' in the application.
> Technically a mismatch? Sure. But it's obviously the same thing."

This is why there are **three verdicts instead of two**.

Text is compared in layers. Identical after fixing typography (curly versus
straight apostrophes, non-breaking spaces) is a pass. Identical after also
ignoring case and punctuation is a pass *with a note* — Dave's case, cleared
automatically, but the difference still recorded. Very similar (≥95%) passes.
Plausibly similar (≥72%) goes to **review**. Only clearly different values fail.

The tool never auto-rejects on a near miss. It removes the matching drudgery
Sarah described — "half their day doing what's essentially data entry
verification" — while routing every judgement call to the person whose
judgement it is.

Similarity is the higher of two measures: character edit distance (catches
typos) and word-set overlap (catches reordering like "Distillery, Old Tom").

Dave's other point — "don't make my life harder" — is why results print cleanly
on one page. He prints his email.

## Jenny Park — the warning has to be exact

> "Word-for-word, and the 'GOVERNMENT WARNING:' part has to be in all caps and
> bold. I caught one last month where they used 'Government Warning' in title
> case."

The health warning check is the strictest in the app and is reported as three
separate requirements, so the agent knows exactly which failed:

1. **Present at all.**
2. **Wording matches 27 CFR 16.21 exactly** — after typographic normalization
   only. A single changed word fails, and a **word-level diff** shows the agent
   precisely which words are missing or added. "The warning doesn't match" is
   useless feedback on a fifty-word paragraph.
3. **"GOVERNMENT WARNING:" is in capital letters.** Jenny's title-case example is
   a specific test case, and a specific sample label.

Getting this right required a prompt instruction as much as code. Left alone, a
model will "helpfully" normalize casing or complete a warning from memory — and
report the statutory text even when the label is paraphrased. The extraction
prompt tells it explicitly to preserve capitalization and to transcribe the
wording actually printed, even when it differs from the version it knows.

**Bold is reported, not scored.** The regulation does require bold. But judging
type weight from a photograph is less reliable than reading words, and a
false rejection costs an applicant real time. So it's shown to the agent and
left to their eye.

## Jenny Park — imperfect photographs

> "Photographed at weird angles, or the lighting is bad, or there's glare."

The model reads angled and glared images well — one sample label is rotated
nine degrees under a glare patch. But the more important design point is what
happens when it *can't* read something:

- The model reports a **confidence per field** and flags image problems (glare,
  blur, angle, cropping).
- If a field would **fail** but the model had low confidence reading it, the
  verdict is downgraded to **review** with an explanation. An unreadable
  photograph must never masquerade as a non-compliant label.
- A label the model says is **illegible overall** can never return a clean pass.

Right now an agent who can't read a label rejects it and asks for a better image.
This keeps the agent in that loop, but saves the round trip for everything that
is readable.

## Marcus Williams — the infrastructure reality

> "Our network blocks outbound traffic to a lot of domains."

- **Zero runtime dependencies in the rules engine.** String similarity, diffing,
  CSV parsing, and unit conversion are all implemented locally rather than
  pulled from npm. The server has three dependencies total.
- **System fonts only.** A page whose typography depends on fetching Google Fonts
  renders in silent fallback inside a restrictive network.
- **One outbound host.** The server build needs exactly one allow-listed
  destination. The model call is isolated in `src/extract/anthropic.js`, so
  pointing it at an Azure-hosted or on-premises endpoint is a one-file change —
  which matters for an agency already on Azure with FedRAMP obligations.
- **Nothing stored.** Images live in memory for one request. No database, no
  disk writes, no logs of image content. That sidesteps the PII and retention
  questions Marcus raised, which a production system would have to answer
  properly.

---

## Tools used

| Tool | Why |
|---|---|
| Node.js + Express | Small, conventional, easy for any reviewer to run |
| Anthropic Claude (vision) | Label transcription; Haiku for latency |
| Multer | In-memory multipart uploads, no disk |
| Node's built-in test runner | No test framework to install |
| Playwright (dev only) | Rendering sample labels; browser smoke test |
| ImageMagick (dev only) | Degrading samples with rotation, glare, blur |

The deployed demo runs on the Claude artifact runtime, which supplies the vision
model through its `sample` capability — so the live link works without the
reviewer needing an API key or a server.

---

## Test labels

Ten synthetic labels in `samples/`, each with a known expected verdict recorded
in `manifest.json`. They were drawn from HTML rather than generated with an
image model, deliberately: a fixture whose exact text you control is worth more
than a prettier one you have to squint at. It's what makes the set usable for
regression testing.

| File | Scenario | Expected |
|---|---|---|
| 01-compliant | Fully compliant bourbon | pass |
| 02-warning-title-case | "Government Warning:" — Jenny's case | fail |
| 03-warning-paraphrased | One clause reworded | fail |
| 04-warning-missing | No warning | fail |
| 05-abv-mismatch | Label says 47%, application 45% | fail |
| 06-brand-case-variant | "Stone's Throw" vs "STONE'S THROW" — Dave's case | pass |
| 07-import-scotch | Import with country of origin | pass |
| 08-tiny-warning | Correct warning in very small type | pass |
| 09-angled-glare | Rotated 9°, glare across the brand | pass |
| 10-blurred | Out of focus | review |

---

## What I'd do next

In rough priority order, if this moved toward production:

1. **Validate against real COLA data.** Run a few hundred historical applications
   with known outcomes through the engine and measure agreement with agents. The
   thresholds in `rules.js` were set by reasoning, not by data, and should be
   tuned against real decisions.
2. **Beverage-specific rules.** Wine and malt beverages have different mandatory
   fields and exemptions (some wines needn't state alcohol content). The engine
   infers the class but applies a common field set.
3. **Type size checking.** Measuring the warning's type size against container
   size needs a known reference dimension in the image.
4. **Model hosting inside the boundary.** An Azure-hosted model endpoint would
   remove the external dependency entirely.
5. **An audit trail.** Production use needs a record of what was checked, by
   whom, and what the tool said — which reopens the retention questions the
   prototype deliberately avoids.
6. **Agent feedback.** A one-click "the tool was wrong here" on each field would
   generate exactly the labelled data needed for step 1.
