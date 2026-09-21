---
title: "Enumeration, Matching and DST"
parent: "Usage"
nav_order: 4
---

# Enumeration, Matching and DST

---

This page documents the exact semantics shared by `nextRun()`, `nextRuns()`,
`previousRuns()` and `match()`, including how they relate to each other across
daylight-saving boundaries. The behavior is covered by the fixed-seed
metamorphic test suite in `test/metamorphic.test.ts`.

## Endpoint semantics

Every enumeration method treats its reference instant as an **excluded**
endpoint:

- `nextRun(t)` returns the first scheduled run **strictly after** `t`.
- `previousRuns(n, t)[0]` returns the first scheduled run **strictly before**
  `t`.
- Passing an instant that is itself a run therefore moves one step in the
  requested direction; enumeration never returns the reference instant itself.

Forward sequences are strictly increasing and backward sequences are strictly
decreasing. `nextRuns(n, t)` produces exactly the same instants as calling
`nextRun()` `n` times, chaining each result into the next call; the same holds
for `previousRuns()`.

## Open/closed interval relation

For consecutive runs `r[i]` and `r[i+1]` and any reference `t` with
`r[i] <= t < r[i+1]`:

```text
nextRun(t)        === r[i+1]
previousRuns(1, t)[0] === r[i]
```

The two directions are exact inverses on this half-open interval **as long as
no irreversible clock transition lies inside it**. When such a boundary is
present (see below), the ordering inequalities still hold in both directions,
but the equality round trip does not: backward search from the adjusted run
lands on the last run before the boundary.

## DST gaps and overlaps

Croner resolves scheduled wall-clock times with the platform's timezone data
(`Intl.DateTimeFormat`) and applies the OCPS rules:

- **Spring gap (clocks jump forward).** A scheduled local time that does not
  exist (for example 02:30 while the clock moves 02:00 → 03:00) is adjusted
  forward onto the first existing instant after the gap. Because the local
  wall components are then different from the pattern (03:30 when 02:30 was
  requested), `match()` returns `false` for that adjusted instant. It is
  still emitted by forward enumeration and remains strictly ordered. Backward
  enumeration never emits a gap-adjusted instant: it steps over the gap to the
  last genuine match, keeping `previousRuns()` strictly decreasing.
- **Fall overlap (clocks repeat a local interval).** An ambiguous local time
  resolves to its **first** physical occurrence (the pre-transition instant).
  The repeated interval is therefore enumerated once, not twice. A fall-back
  boundary is reversible: forward and backward enumeration round-trip exactly
  on it.
- **Half-hour transitions.** Zones such as `Australia/Lord_Howe`
  (+10:30/+11:00) shift by 30 minutes rather than an hour; the same rules apply
  with 30-minute granularity.

These guarantees hold independently of the host machine's default timezone as
long as an explicit `timezone` or `utcOffset` is supplied. The test suite pins
its own reference instants and never reads the process default zone.

## match() versus enumeration

`match(date)` answers a single question: do the date's wall-clock components
in the job's timezone (or at its UTC offset) satisfy every constrained field
of the pattern? Two consequences follow:

1. A gap-adjusted forward run does not match (see above); this is the only
   situation where an emitted run fails `match()`.
2. `dayOffset` is applied only to the instants returned by `nextRun()` /
   `nextRuns()` / `previousRuns()`. It does not alter `match()`, which always
   tests the underlying pattern.

The metamorphic suite cross-checks enumeration against an independent
wall-clock `match()` sweep over bounded windows: the two oracles agree after
deduplicating fall-back instants by local wall components (one run per local
time).

## Pattern canonicalization

Equivalent patterns produce identical normalized field arrays and identical run
sequences:

- A 5-field pattern and the same pattern with an explicit leading `0` second
  are the same schedule.
- `?` is an alias for `*` in every field.
- Nicknames (`@daily`, `@monthly`, …) expand to the documented base patterns.
- Disabled fields keep only their documented invariants: omitting seconds
  forces every run to second `0`; a wildcarded day field matches every day and
  is marked accordingly so day-of-week selection works unchanged; a wildcarded
  month field matches every month.

## Complexity and limits

- Enumerating the next/previous run walks the pattern fields from coarsest to
  finest. The common case is O(fields). Crossing constrained boundaries (e.g.
  `31` of short months, `29` February, L/W/# selectors) skips at most one
  month or year per rollover; an internal guard bounds the total work instead
  of searching forever.
- Forward search stops at year 3000 for unbounded year fields and at year
  9999 when a year field is given (OCPS 1.2 supported range is 1-9999).
  Backward search stops at year 1.
- Impossible combinations such as `0 0 0 31 2 *` return an empty sequence in
  both directions; they are not made to "match" by widening the search window.

## Compatibility notes

- Enumeration operates in memory and needs only the runtime's ICU timezone
  data; no network, clock waiting or file system access is involved.
- Timestamps are second precision; milliseconds are stripped on enumeration.
- Combining `timezone` with `utcOffset` is rejected. `utcOffset` schedules at a
  fixed offset and intentionally has no DST handling; use an IANA `timezone`
  for zones that observe daylight saving.
{ .note }
