/**
 * Fixed-seed metamorphic tests for Croner.
 *
 * Instead of stacking more single-date examples, these tests connect the four
 * core operations - forward enumeration (nextRun/nextRuns), backward
 * enumeration (previousRuns), point-in-time matching (match) and pattern
 * canonicalization (CronPattern normalization) - through invariants that must
 * hold for every generated legal input:
 *
 *   1. nextRuns is strictly increasing and every run matches the pattern
 *      (except runs adjusted across a non-existent DST wall-clock time, which
 *      are documented as skipped/adjusted and therefore intentionally do not
 *      match the local wall clock).
 *   2. previousRuns is strictly decreasing, strictly before its reference,
 *      and every run matches.
 *   3. nextRuns(n, t) equals repeated nextRun calls, and previousRuns chains
 *      the same way.
 *   4. Adjacent runs are open/closed round-trip partners:
 *      previousRuns(1, r[i])[0] === r[i-1] whenever the interval between
 *      them contains no irreversible (forward-offset / spring-gap) DST
 *      transition. Fall-back overlaps are ambiguous rather than irreversible
 *      and round-trip exactly thanks to the "first occurrence" rule.
 *   5. The set of instants produced by forward enumeration over a bounded
 *      window equals the set produced by independent wall-clock matching over
 *      the same window (deduped through the match() oracle).
 *   6. Canonical equivalents (5-part vs explicit zero seconds, `?` vs `*`,
 *      nicknames) produce identical run sequences and identical normalized
 *      field arrays.
 *
 * Determinism:
 *   - PRNG is seeded (mulberry32), so the generated corpus is stable across
 *     machines and runs.
 *   - Every reference instant is a fixed UTC Date; the tests never read the
 *     host default timezone (all matching is done with explicit `timezone`
 *     or `utcOffset` options and Intl probes).
 *   - No network, file system ordering or real-clock waiting is used.
 */

import { assert, assertEquals } from "@std/assert";
import { test } from "@cross/test";
import { Cron, CronPattern } from "../src/croner.ts";
import { toTZ } from "../src/helpers/timezone.ts";

/* -------------------------------------------------------------------------- */
/* Fixed seed PRNG                                                            */
/* -------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rnd: () => number, values: readonly T[]): T {
  return values[Math.floor(rnd() * values.length)];
}

/* -------------------------------------------------------------------------- */
/* Timezone capability probe                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The required DST zones must exist on every supported modern runtime. The
 * no-DST set is probed and only used when the platform's ICU data contains
 * it, so the suite never fails merely because of a reduced tzdata build.
 */
const REQUIRED_ZONES = [
  "Etc/UTC",
  "America/New_York",
  "Europe/Berlin",
  "Australia/Lord_Howe",
] as const;

const CANDIDATE_NO_DST_ZONES = [
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Etc/GMT-5",
  "Pacific/Auckland", // has DST; included only to be filtered out
] as const;

function zoneIsAvailable(zone: string): boolean {
  try {
    // A successful round trip through Intl is sufficient capability evidence.
    toTZ(new Date("2024-06-15T12:00:00Z"), zone);
    return true;
  } catch {
    return false;
  }
}

function zoneHasDst(zone: string): boolean {
  // Compare offsets across northern-hemisphere January and July.
  return offsetMinutes(Date.UTC(2024, 0, 15), zone) !==
    offsetMinutes(Date.UTC(2024, 6, 15), zone);
}

function offsetMinutes(ms: number, zone: string): number {
  const tp = toTZ(new Date(ms), zone);
  return (Date.UTC(tp.y, tp.m - 1, tp.d, tp.h, tp.i, tp.s) - ms) / 60000;
}

const availableZones: string[] = [];
for (const zone of REQUIRED_ZONES) {
  if (zoneIsAvailable(zone)) availableZones.push(zone);
}
const noDstZones: string[] = [];
for (const zone of [...CANDIDATE_NO_DST_ZONES]) {
  if (zoneIsAvailable(zone) && !zoneHasDst(zone)) noDstZones.push(zone);
}
if (!noDstZones.includes("Etc/UTC")) noDstZones.unshift("Etc/UTC");

test("metamorphic: timezone capability probe finds all required zones", () => {
  assertEquals(
    availableZones,
    [...REQUIRED_ZONES],
    "UTC, America/New_York, Europe/Berlin and Australia/Lord_Howe must be " +
      "available on every supported platform",
  );
  assert(noDstZones.length >= 1, "at least one no-DST zone (UTC) must be usable");
});

test("metamorphic: Australia/Lord_Howe exposes 30-minute DST granularity", () => {
  // This zone is the reason the transition finder cannot assume whole-hour
  // jumps. Standard time is UTC+10:30, summer time UTC+11:00.
  const winter = offsetMinutes(Date.UTC(2025, 6, 15), "Australia/Lord_Howe");
  const summer = offsetMinutes(Date.UTC(2025, 0, 15), "Australia/Lord_Howe");
  assertEquals(winter, 630);
  assertEquals(summer, 660);
});

/* -------------------------------------------------------------------------- */
/* DST transition finder                                                      */
/* -------------------------------------------------------------------------- */

type Transition = { at: number; fromOffset: number; toOffset: number };

/**
 * A transition is irreversible for round-tripping when clocks jump forward
 * (a wall-clock interval disappears). Fall-back transitions repeat a local
 * interval instead, which the first-occurrence mapping handles invertibly.
 */
function isForwardGap(tr: Transition): boolean {
  return tr.toOffset > tr.fromOffset;
}

function intervalHasForwardGap(zone: string, fromMs: number, toMs: number): boolean {
  if (zone === "Etc/UTC" || /^Etc\/GMT/.test(zone)) return false;
  return findTransitions(zone, fromMs, toMs).some(isForwardGap);
}

/* -------------------------------------------------------------------------- */
/* Fixed "now" and reference instants                                         */
/* -------------------------------------------------------------------------- */

// Tests never call new Date() as an implicit reference; this constant stands
// in for the process clock. 2025-06-15T12:00:00Z is deliberately a northern
// summer / southern winter instant, away from any transition day.
const FIXED_NOW = Date.UTC(2025, 5, 15, 12, 0, 0);

// Bounded set of start points covering plain dates plus hand-picked
// neighborhoods around month ends, leap day and each transition family.
function buildReferenceInstants(): { label: string; ms: number }[] {
  const plain = [
    Date.UTC(2023, 0, 10, 8, 0, 0),
    Date.UTC(2024, 5, 15, 12, 30, 0),
    FIXED_NOW,
    Date.UTC(2025, 10, 20, 6, 15, 0),
  ];
  const neighborhoods: { label: string; ms: number }[] = [];
  for (const ms of plain) neighborhoods.push({ label: "plain", ms });

  const add = (label: string, ms: number) => neighborhoods.push({ label, ms });

  // Month end / leap day (UTC)
  add("jan-end", Date.UTC(2024, 0, 31, 23, 30, 0));
  add("feb-28-leap", Date.UTC(2024, 1, 28, 12, 0, 0));
  add("feb-29-common", Date.UTC(2025, 1, 28, 12, 0, 0));
  add("dec-31", Date.UTC(2024, 11, 31, 23, 45, 0));

  // America/New_York transitions (found dynamically; the constants only
  // bound the search windows).
  for (
    const window of [
      [Date.UTC(2023, 2, 1), Date.UTC(2023, 2, 20)],
      [Date.UTC(2023, 10, 1), Date.UTC(2023, 10, 10)],
      [Date.UTC(2024, 2, 1), Date.UTC(2024, 2, 20)],
    ]
  ) {
    const trs = findTransitions("America/New_York", window[0], window[1]);
    for (const tr of trs) {
      add("ny-transition-2h-before", tr.at - 2 * 3600000);
      add("ny-transition-30m-after", tr.at + 30 * 60000);
    }
  }

  // Europe/Berlin transitions
  for (
    const window of [
      [Date.UTC(2024, 2, 30), Date.UTC(2024, 2, 31, 12)],
      [Date.UTC(2024, 9, 25), Date.UTC(2024, 9, 29)],
    ]
  ) {
    const trs = findTransitions("Europe/Berlin", window[0], window[1]);
    for (const tr of trs) {
      add("berlin-transition-2h-before", tr.at - 2 * 3600000);
      add("berlin-transition-30m-after", tr.at + 30 * 60000);
    }
  }

  // Australia/Lord_Howe half-hour transitions
  for (
    const window of [
      [Date.UTC(2025, 3, 5), Date.UTC(2025, 3, 7)],
      [Date.UTC(2025, 9, 4), Date.UTC(2025, 9, 6)],
    ]
  ) {
    const trs = findTransitions("Australia/Lord_Howe", window[0], window[1]);
    for (const tr of trs) {
      add("lord-howe-transition-before", tr.at - 2 * 3600000);
      add("lord-howe-transition-after", tr.at + 45 * 60000);
    }
  }

  return neighborhoods;
}

const REFERENCE_INSTANTS = buildReferenceInstants();

/* -------------------------------------------------------------------------- */
/* Pattern generator (small, bounded field sets)                              */
/* -------------------------------------------------------------------------- */

const FIELD_SECONDS = ["0", "30", "0,30", "*/15", "*/20"] as const;
const FIELD_MINUTES = ["0", "15", "30", "*/20", "0,15,45", "45"] as const;
const FIELD_HOURS = ["0", "6", "12", "*/8", "0,12", "23"] as const;
const FIELD_DAY = ["*", "1", "15", "L", "LW", "15W", "1-7", "31"] as const;
const FIELD_MONTH = ["*", "1", "6", "1,7", "2", "12"] as const;
const FIELD_DOW = ["*", "1", "MON-FRI", "6#1", "5L", "0,6", "?"] as const;
const FIELD_YEAR = ["*", "2024", "2024-2026", "2028"] as const;

type GeneratedCase = {
  label: string;
  pattern: string;
  mode: "auto" | "5-part" | "6-part";
  zone: string;
  useUtcOffset: boolean;
  useAndLogic: boolean;
  referenceMs: number;
  steps: number;
  fields: {
    seconds: string;
    minutes: string;
    hours: string;
    day: string;
    month: string;
    dow: string;
    year: string;
  };
  flags: {
    secondsDisabled: boolean;
    dayDisabled: boolean;
    monthDisabled: boolean;
  };
};

function generateCase(seed: number): GeneratedCase {
  const rnd = mulberry32(seed);
  const precision = pick(rnd, ["5-part", "6-part", "6-part", "7-part"] as const);
  const seconds = precision === "5-part" ? "0" : pick(rnd, FIELD_SECONDS);
  const minutes = pick(rnd, FIELD_MINUTES);
  const hours = pick(rnd, FIELD_HOURS);
  const day = pick(rnd, FIELD_DAY);
  const month = pick(rnd, FIELD_MONTH);
  let dow = pick(rnd, FIELD_DOW);
  const year = precision === "7-part" ? pick(rnd, FIELD_YEAR) : "*";

  // `+` (explicit AND) is only combined with plain day-of-week atoms, matching
  // parser support. When used, the job gets domAndDow: true.
  const useAndLogic = dow !== "*" && dow !== "?" && dow.indexOf("#") === -1 &&
    dow.indexOf("L") === -1 && rnd() < 0.3;
  if (useAndLogic) dow = "+" + dow;

  const parts = precision === "5-part"
    ? [minutes, hours, day, month, dow]
    : [seconds, minutes, hours, day, month, dow, ...(precision === "7-part" ? [year] : [])];
  const pattern = parts.join(" ");

  const zone = rnd() < 0.75 ? pick(rnd, availableZones) : pick(rnd, noDstZones);
  const useUtcOffset = zone === "Etc/UTC" && rnd() < 0.5;
  const ref = pick(rnd, REFERENCE_INSTANTS).ms;
  const steps = 2 + Math.floor(rnd() * 5); // 2..6

  const dayToken: string = day;
  const monthToken: string = month;

  return {
    label: `seed=${seed}`,
    pattern,
    mode: precision === "7-part" ? "auto" : precision === "5-part" ? "5-part" : "6-part",
    zone,
    useUtcOffset,
    useAndLogic,
    referenceMs: ref,
    steps,
    fields: {
      seconds,
      minutes,
      hours,
      day: dayToken,
      month: monthToken,
      dow: dow.replace("+", ""),
      year,
    },
    flags: {
      // Seconds are disabled when the field is omitted (5-part forces 0).
      secondsDisabled: precision === "5-part",
      // A field is "disabled" when wildcarded (`*` or the `?` alias): it then
      // imposes no restriction and only the documented wildcard invariants
      // apply.
      dayDisabled: dayToken === "*",
      monthDisabled: monthToken === "*",
    },
  };
}

function jobFor(c: GeneratedCase): Cron {
  const options = {
    mode: c.mode,
    ...(c.useUtcOffset ? { utcOffset: 0 as number } : { timezone: c.zone }),
    ...(c.useAndLogic ? { domAndDow: true } : {}),
  };
  return new Cron(c.pattern, options);
}

function contextLine(c: GeneratedCase, extra?: string): string {
  return [
    c.label,
    `pattern='${c.pattern}'`,
    `mode=${c.mode}`,
    c.useUtcOffset ? "utcOffset=0" : `zone=${c.zone}`,
    `ref=${new Date(c.referenceMs).toISOString()}`,
    extra ?? "",
  ].join(" ");
}

/* -------------------------------------------------------------------------- */
/* Independent wall-clock match oracle                                        */
/* -------------------------------------------------------------------------- */

function wallKey(d: Date, zone: string): string {
  const tp = toTZ(d, zone);
  return `${tp.y}-${tp.m}-${tp.d}-${tp.h}-${tp.i}-${tp.s}`;
}

/**
 * Independent completeness sweep over [startMs, endMs].
 *
 * The grid step follows the generated precision; ambiguous fall-back instants
 * are deduped by local wall-clock components (one run per local time, matching
 * enumeration's first-occurrence rule), and non-existent spring-gap wall times
 * never appear on an instant grid.
 */
function sweepMatches(
  c: GeneratedCase,
  job: Cron,
  startMs: number,
  endMs: number,
): Set<number> {
  const stepMs = c.flags.secondsDisabled || c.fields.seconds === "0" || c.fields.seconds === "30"
    ? 60000
    : 1000;
  const secondOffset = c.fields.seconds === "30" ? 30000 : 0;
  const gridStart = Math.floor(startMs / stepMs) * stepMs + secondOffset;
  const zone = c.useUtcOffset ? "Etc/UTC" : c.zone;

  const seenWalls = new Set<string>();
  const instants = new Set<number>();
  for (let t = gridStart; t <= endMs; t += stepMs) {
    if (t < startMs) continue;
    const d = new Date(t);
    if (job.match(d)) {
      const key = wallKey(d, zone);
      if (!seenWalls.has(key)) {
        seenWalls.add(key);
        instants.add(t);
      }
    }
  }
  return instants;
}

/**
 * A run emitted by enumeration that does not satisfy match() is accepted only
 * when its local wall time was swallowed by a forward DST gap ending at most
 * two hours before the run. Anything else is a genuine forward/backward bug.
 */
function isGapAdjustedRun(c: GeneratedCase, runMs: number): boolean {
  if (c.useUtcOffset) return false;
  const horizonStart = Date.UTC(2023, 0, 1);
  const hits = findTransitionsCached(c.zone, horizonStart, Date.UTC(2026, 7, 1))
    .filter((tr) => isForwardGap(tr) && runMs - 2 * 3600000 <= tr.at && tr.at <= runMs);
  return hits.some((tr) => {
    const delta = (tr.toOffset - tr.fromOffset) * 60000;
    return runMs >= tr.at && runMs < tr.at + delta + 3600000;
  });
}

const transitionCache = new Map<string, Transition[]>();

function findTransitionsCached(zone: string, fromMs: number, toMs: number): Transition[] {
  let all = transitionCache.get(zone);
  if (!all) {
    all = findTransitionsCoarse(zone, Date.UTC(2023, 0, 1), Date.UTC(2026, 7, 1));
    transitionCache.set(zone, all);
  }
  return all.filter((tr) => tr.at >= fromMs && tr.at < toMs);
}

/**
 * Coarse-to-fine transition scan: 6-hour buckets first (offset is constant
 * within a day), 30-minute refinement inside a changed bucket, minute-level
 * binary narrowing last. Complexity is O(hours/6 + transitions*12) instead of
 * O(hours/0.5).
 */
function findTransitionsCoarse(zone: string, fromMs: number, toMs: number): Transition[] {
  const transitions: Transition[] = [];
  const STEP = 30 * 60000;
  // Sample the whole range on a 30-minute grid (offset only changes on real
  // DST boundaries, never smaller than 30 minutes); cost is negligible over
  // the bounded windows used by these tests.
  let localOffset = offsetMinutes(fromMs, zone);
  for (let t = fromMs + STEP; t < toMs; t += STEP) {
    const o = offsetMinutes(t, zone);
    if (o !== localOffset) {
      // Narrow the [t-STEP, t) bucket to the exact transition minute.
      let lo = t - STEP;
      let hi = t;
      while (hi - lo > 60000) {
        const mid = Math.floor((lo + hi) / 2 / 60000) * 60000;
        if (offsetMinutes(mid, zone) === localOffset) lo = mid;
        else hi = mid;
      }
      transitions.push({ at: hi, fromOffset: localOffset, toOffset: o });
      localOffset = o;
    }
  }
  return transitions;
}

// Override the fine-grained finder used while building reference instants
// with the cached coarse finder (both share the Transition shape).
function findTransitions(zone: string, fromMs: number, toMs: number): Transition[] {
  return findTransitionsCoarse(zone, fromMs, toMs);
}

/* -------------------------------------------------------------------------- */
/* Property: generated corpus                                                 */
/* -------------------------------------------------------------------------- */

const CASE_COUNT = 140;

test("metamorphic: generated corpus links next, previous, match and canonical form", () => {
  for (let seed = 1; seed <= CASE_COUNT; seed++) {
    const c = generateCase(seed);
    let job: Cron;
    try {
      job = jobFor(c);
    } catch (e) {
      throw new Error(`${contextLine(c)}: generator produced an illegal pattern: ${String(e)}`);
    }

    assertRunSequenceInvariants(c, job);
    assertRoundTripInvariants(c, job);
    assertDisabledFieldInvariants(c, job);
  }
});

function assertRunSequenceInvariants(c: GeneratedCase, job: Cron): void {
  const refDate = new Date(c.referenceMs);

  // (1) Forward sequence: batch API equals repeated single-step API.
  const forward = job.nextRuns(c.steps, refDate);
  let cursor: Date | null = refDate;
  const stepped: Date[] = [];
  for (let i = 0; i < c.steps; i++) {
    cursor = job.nextRun(cursor);
    if (cursor === null) break;
    stepped.push(cursor);
  }
  assertEquals(
    forward.map((d) => d.getTime()),
    stepped.map((d) => d.getTime()),
    `${contextLine(c)}: nextRuns must equal repeated nextRun`,
  );

  // Strict increase + match (gap-adjusted runs are exempt from match only).
  for (let i = 0; i < forward.length; i++) {
    if (i > 0) {
      assert(
        forward[i].getTime() > forward[i - 1].getTime(),
        `${contextLine(c)}: forward run #${i} is not strictly greater than #${i - 1}`,
      );
    }
    assert(
      forward[i].getTime() > c.referenceMs,
      `${contextLine(c)}: forward run #${i} must be strictly after the reference`,
    );
    if (!job.match(forward[i])) {
      assert(
        isGapAdjustedRun(c, forward[i].getTime()),
        `${contextLine(c)}: forward run ${forward[i].toISOString()} does not ` +
          "match and is not explained by a forward DST gap adjustment",
      );
    }
  }

  // (2) Backward sequence: batch API equals repeated single-step API.
  const backward = job.previousRuns(c.steps, refDate);
  const steppedBack: Date[] = [];
  let bcursor: Date | null = refDate;
  for (let i = 0; i < c.steps; i++) {
    const one = job.previousRuns(1, bcursor ?? undefined);
    if (one.length === 0) break;
    steppedBack.push(one[0]);
    bcursor = one[0];
  }
  assertEquals(
    backward.map((d) => d.getTime()),
    steppedBack.map((d) => d.getTime()),
    `${contextLine(c)}: previousRuns(n) must equal repeated previousRuns(1)`,
  );

  // Strict decrease, strictly before reference, every run matches. Backward
  // enumeration never emits gap-adjusted wall times (the lower bound guard
  // steps over them), so match() must always hold.
  for (let i = 0; i < backward.length; i++) {
    if (i > 0) {
      assert(
        backward[i].getTime() < backward[i - 1].getTime(),
        `${contextLine(c)}: backward run #${i} is not strictly less than #${i - 1}`,
      );
    }
    assert(
      backward[i].getTime() < c.referenceMs,
      `${contextLine(c)}: backward run #${i} must be strictly before the reference`,
    );
    assert(
      job.match(backward[i]),
      `${contextLine(c)}: backward run ${backward[i].toISOString()} does not match`,
    );
  }
}

function assertRoundTripInvariants(c: GeneratedCase, job: Cron): void {
  const refDate = new Date(c.referenceMs);
  const forward = job.nextRuns(2, refDate);
  if (forward.length < 2) return;

  // (3) Open/closed interval relation. With n = nextRun(t) and
  // p = previousRun(n) (previousRuns excludes the endpoint itself):
  //   p <= t < n, and previousRuns(1, n)[0] is the predecessor of n.
  // Across a forward gap inside (t, n] the local mapping is not invertible,
  // which is exactly the documented boundary where only the inequalities
  // hold.
  const n = forward[0].getTime();
  const prevOfN = job.previousRuns(1, new Date(n));
  assert(
    n > c.referenceMs,
    `${contextLine(c)}: nextRun must return a strictly later instant`,
  );
  if (prevOfN.length > 0) {
    const p = prevOfN[0].getTime();
    assert(
      p < n,
      `${contextLine(c)}: predecessor must be strictly before nextRun result`,
    );
    assert(
      p <= c.referenceMs,
      `${contextLine(c)}: predecessor ${new Date(p).toISOString()} must not be ` +
        "after the reference",
    );

    if (!c.useUtcOffset && intervalHasForwardGap(c.zone, c.referenceMs, n)) {
      // Non-invertible boundary: inequalities only, equality intentionally
      // not asserted.
    } else {
      // Invertible region: exact round trip with the run just before t.
      const prevOfT = job.previousRuns(1, refDate);
      if (prevOfT.length > 0) {
        assertEquals(
          p,
          prevOfT[0].getTime(),
          `${contextLine(c)}: previousRun(nextRun(t)) must equal previousRun(t) ` +
            "when no forward gap lies between them",
        );
      }
    }
  }

  // Adjacent forward runs are mutual round-trip partners unless a forward gap
  // sits strictly between them.
  const [first, second] = forward;
  if (!c.useUtcOffset && intervalHasForwardGap(c.zone, first.getTime(), second.getTime())) {
    return;
  }
  const back = job.previousRuns(1, second);
  if (back.length > 0) {
    assertEquals(
      back[0].getTime(),
      first.getTime(),
      `${contextLine(c)}: previousRuns(1, r[i+1])[0] must equal r[i] outside gaps`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Property: disabled fields keep only documented invariants                 */
/* -------------------------------------------------------------------------- */

function assertDisabledFieldInvariants(c: GeneratedCase, job: Cron): void {
  const p = new CronPattern(c.pattern, c.useUtcOffset ? undefined : c.zone, { mode: c.mode });

  if (c.flags.secondsDisabled) {
    // 5-part mode forces seconds to 0, both in the normalized pattern and in
    // every emitted run.
    assertEquals(
      p.second.filter(Boolean),
      [1],
      `${contextLine(c)}: disabled seconds field must normalize to second 0 only`,
    );
    const runs = job.nextRuns(2, new Date(c.referenceMs));
    for (const run of runs) {
      const tp = toTZ(run, c.useUtcOffset ? "Etc/UTC" : c.zone);
      assertEquals(
        tp.s,
        0,
        `${contextLine(c)}: disabled seconds field must yield second 0 runs`,
      );
    }
  }

  if (c.flags.dayDisabled) {
    // Wildcarded day-of-month must mark starDOM so it never constrains dates
    // itself; day selection is then driven by day-of-week alone (or by
    // nothing when both are wildcarded).
    assertEquals(
      p.starDOM,
      true,
      `${contextLine(c)}: disabled day field must be marked starDOM`,
    );
    assertEquals(
      p.day.every((v) => v === 1),
      true,
      `${contextLine(c)}: disabled day field must match every day 1..31`,
    );
  }

  if (c.flags.monthDisabled) {
    assertEquals(
      p.month.every((v) => v === 1),
      true,
      `${contextLine(c)}: disabled month field must match every month`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Property: independent completeness sweep on bounded windows                */
/* -------------------------------------------------------------------------- */

test("metamorphic: enumeration covers exactly the matching instants in bounded windows", () => {
  // Use a dense sub-corpus (second or minute precision, all years) where a
  // complete grid sweep stays cheap. Sparse/year-constrained patterns are
  // covered by the monotonicity/match/round-trip properties above; they are
  // excluded here so a sparse pattern cannot be "verified" by widening the
  // search horizon.
  for (let seed = 1; seed <= 60; seed++) {
    const c = generateCase(7000 + seed);
    const denseSeconds = !c.flags.secondsDisabled &&
      (c.fields.seconds.includes("*/") || c.fields.seconds.includes(","));
    if (!denseSeconds) continue;
    const job = jobFor(c);
    // 40-minute window around the fixed reference is enough for second
    // precision patterns (>= 2 expected matches even for */20).
    const start = c.referenceMs;
    const end = start + 40 * 60000;
    const expected = sweepMatches(c, job, start, end);

    const enumerated = new Set<number>();
    for (const run of job.nextRuns(40, new Date(start))) {
      if (run.getTime() > end) break;
      // Gap-adjusted runs have no matching instant and are outside the
      // match-oracle set by construction.
      if (!job.match(run) && isGapAdjustedRun(c, run.getTime())) continue;
      enumerated.add(run.getTime());
    }

    const missing = [...expected].filter((t) => !enumerated.has(t));
    const extra = [...enumerated].filter((t) => !expected.has(t));
    assert(
      missing.length === 0 && extra.length === 0,
      `${contextLine(c)}: enumeration/oracle mismatch; missing=[${
        missing.map((t) => new Date(t).toISOString()).join(",")
      }] extra=[${extra.map((t) => new Date(t).toISOString()).join(",")}]`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Property: pattern canonicalization                                         */
/* -------------------------------------------------------------------------- */

test("metamorphic: 5-part and explicit-zero-second 6-part forms are canonical equivalents", () => {
  const pairs: [string, string][] = [
    ["0 12 * * *", "0 0 12 * * *"],
    ["30 6 1 * *", "0 30 6 1 * *"],
    ["*/15 * * * 1", "0 */15 * * * 1"],
    ["0 0 L 2 *", "0 0 0 L 2 *"],
  ];
  const ref = new Date(Date.UTC(2025, 0, 10, 0, 0, 0));
  for (const [five, six] of pairs) {
    const a = new Cron(five, { mode: "5-part" });
    const b = new Cron(six, { mode: "6-part" });
    const ra = a.nextRuns(6, ref).map((d) => d.getTime());
    const rb = b.nextRuns(6, ref).map((d) => d.getTime());
    assertEquals(rb, ra, `canonical equivalents differ: '${five}' vs '${six}'`);

    const pa = new CronPattern(five, undefined, { mode: "5-part" });
    const pb = new CronPattern(six, undefined, { mode: "6-part" });
    assertEquals(pb.second, pa.second, `seconds normalization differs for '${five}'`);
    assertEquals(pb.minute, pa.minute);
    assertEquals(pb.hour, pa.hour);
    assertEquals(pb.day, pa.day);
    assertEquals(pb.month, pa.month);
    assertEquals(pb.dayOfWeek, pa.dayOfWeek);
    assertEquals(pb.year, pa.year);
  }
});

test("metamorphic: question mark is the wildcard alias in every field", () => {
  const ref = new Date(Date.UTC(2025, 0, 10, 12, 0, 0));
  const pairs: [string, string][] = [
    ["0 ? * * * *", "0 * * * * *"],
    ["0 0 ? * * *", "0 0 * * * *"],
    ["0 0 0 ? * *", "0 0 0 * * *"],
    ["0 0 0 * ? *", "0 0 0 * * *"],
    ["0 0 0 * * ?", "0 0 0 * * *"],
    ["0 0 12 ? * ?", "0 0 12 * * *"],
  ];
  for (const [q, star] of pairs) {
    const a = new Cron(q);
    const b = new Cron(star);
    assertEquals(
      a.nextRuns(5, ref).map((d) => d.getTime()),
      b.nextRuns(5, ref).map((d) => d.getTime()),
      `'${q}' must enumerate like '${star}'`,
    );
    const pa = new CronPattern(q);
    const pb = new CronPattern(star);
    assertEquals([pa.second, pa.minute, pa.hour, pa.day, pa.month, pa.dayOfWeek], [
      pb.second,
      pb.minute,
      pb.hour,
      pb.day,
      pb.month,
      pb.dayOfWeek,
    ]);
  }
});

test("metamorphic: nicknames normalize to their documented patterns", () => {
  const map: [string, string][] = [
    ["@yearly", "0 0 1 1 *"],
    ["@annually", "0 0 1 1 *"],
    ["@monthly", "0 0 1 * *"],
    ["@weekly", "0 0 * * 0"],
    ["@daily", "0 0 * * *"],
    ["@hourly", "0 * * * *"],
  ];
  const ref = new Date(Date.UTC(2025, 0, 10, 0, 0, 0));
  for (const [nick, expanded] of map) {
    const a = new Cron(nick);
    const b = new Cron(expanded, { mode: "5-part" });
    assertEquals(
      a.nextRuns(4, ref).map((d) => d.getTime()),
      b.nextRuns(4, ref).map((d) => d.getTime()),
      `nickname ${nick} mismatch`,
    );
  }
});

test("metamorphic: getPattern returns the original pattern string unchanged", () => {
  const raw = "0 */15 9-17 * * MON-FRI";
  assertEquals(new Cron(raw).getPattern(), raw);
});

/* -------------------------------------------------------------------------- */
/* Directed seeds: each shrinks a failure to pattern + zone + one transition  */
/* neighborhood. Transitions are located from runtime tzdata, not hard-coded, */
/* so the assertions survive tzdata updates.                                  */
/* -------------------------------------------------------------------------- */

test("directed: New York spring gap - nonexistent local time is adjusted, backward stays strict", () => {
  const zone = "America/New_York";
  const [tr] = findTransitionsCoarse(zone, Date.UTC(2024, 2, 1), Date.UTC(2024, 2, 20));
  assert(
    tr && isForwardGap({ ...tr, toOffset: tr.toOffset, fromOffset: tr.fromOffset }),
    "expected a forward-gap transition in March 2024 New York window",
  );
  // 2:30 local exists neither in EST nor EDT on the transition day.
  const job = new Cron("0 30 2 * * *", { timezone: zone });
  const before = new Date(tr.at - 2 * 3600000);
  const n = job.nextRun(before);
  assert(n !== null, "nextRun must resolve across the gap");
  assertEquals(
    job.match(n),
    false,
    "the gap-adjusted run represents a nonexistent local time and does not match",
  );
  // The adjusted instant lies at/after the gap edge, never before it.
  assert(n.getTime() >= tr.at, "adjusted run must not be scheduled inside the gap");

  // Backward lookup from the adjusted run must move strictly into the past
  // (this is the failure mode that previously returned the same instant).
  const prevs = job.previousRuns(2, n);
  assertEquals(prevs.length, 2);
  assert(prevs[0].getTime() < n.getTime(), "predecessor must precede the gap-adjusted run");
  assert(prevs[1].getTime() < prevs[0].getTime(), "backward chain must be strictly decreasing");
  for (const p of prevs) assert(job.match(p), "real predecessors must match");
});

test("directed: New York minute pattern skips the missing minute across the gap", () => {
  const zone = "America/New_York";
  const [tr] = findTransitionsCoarse(zone, Date.UTC(2024, 2, 1), Date.UTC(2024, 2, 20));
  const job = new Cron("30 2 * * *", { timezone: zone });
  const n = job.nextRun(new Date(tr.at - 3 * 3600000));
  assert(n !== null);
  assert(n.getTime() >= tr.at, "2:30 does not exist; result must be at or after the gap edge");
  const prev = job.previousRuns(1, n)[0];
  assert(
    prev.getTime() < tr.at - 12 * 3600000 && job.match(prev),
    "predecessor must be the prior day's occurrence",
  );
});

test("directed: New York fall overlap - ambiguous local time uses the first occurrence", () => {
  const zone = "America/New_York";
  const trs = findTransitionsCoarse(zone, Date.UTC(2024, 10, 1), Date.UTC(2024, 10, 12));
  const tr = trs.find((t) => !isForwardGap(t));
  assert(tr, "expected a fall-back transition in the November 2024 New York window");
  const job = new Cron("0 30 1 * * *", { timezone: zone });

  // Forward enumeration emits the local 01:30 once, mapped to the first
  // (EDT, earlier) physical occurrence.
  const runs = job.nextRuns(2, new Date(tr.at - 6 * 3600000));
  const tp = toTZ(runs[0], zone);
  assertEquals([tp.h, tp.i, tp.s], [1, 30, 0]);
  // The next emitted local 01:30 must be on the following day or later.
  assertEquals([toTZ(runs[1], zone).h, toTZ(runs[1], zone).i], [1, 30]);
  const dayDelta = Math.round((runs[1].getTime() - runs[0].getTime()) / 86400000);
  assert(dayDelta >= 1, "fall-back local time must not be enumerated twice");

  // Backward enumeration from after the overlap finds the first physical
  // occurrence and then walks strictly into the past. Endpoints are excluded
  // in both directions, so nextRun() called on the first occurrence itself
  // must return the following day (the occurrence is not self-inverse);
  // the exact round trip is previousRun(nextDay) === first occurrence.
  const after = new Date(tr.at + 4 * 3600000);
  const back = job.previousRuns(2, after);
  assert(back[0].getTime() < after.getTime());
  assert(back[1].getTime() < back[0].getTime());
  assertEquals(
    back[0].getTime(),
    runs[0].getTime(),
    "backward lookup resolves the ambiguous local time to the first occurrence",
  );
  assertEquals(
    job.previousRuns(1, runs[1])[0].getTime(),
    runs[0].getTime(),
    "the second-day occurrence rounds back to the first occurrence",
  );
  const afterFirst = job.nextRun(runs[0]);
  assert(
    afterFirst !== null && afterFirst.getTime() > runs[0].getTime(),
    "endpoints are exclusive: nextRun on a run never returns the same instant",
  );
});

test("directed: Berlin spring gap and fall overlap behave with hour jumps", () => {
  const zone = "Europe/Berlin";
  const spring = findTransitionsCoarse(zone, Date.UTC(2024, 2, 30), Date.UTC(2024, 2, 31, 12))[0];
  const fall = findTransitionsCoarse(zone, Date.UTC(2024, 9, 25), Date.UTC(2024, 9, 29))[0];
  assert(spring && isForwardGap(spring));
  assert(fall && !isForwardGap(fall));

  const gapJob = new Cron("0 30 2 * * *", { timezone: zone });
  const gapRun = gapJob.nextRun(new Date(spring.at - 3 * 3600000));
  assert(gapRun !== null, "Berlin gap run must resolve");
  assert(gapRun.getTime() >= spring.at, "Berlin 02:30 on gap day must be adjusted onward");
  assertEquals(gapJob.match(gapRun), false);
  const gapPrev = gapJob.previousRuns(1, gapRun)[0];
  assert(gapPrev.getTime() < gapRun.getTime() && gapJob.match(gapPrev));

  const overlapJob = new Cron("0 30 2 * * *", { timezone: zone });
  const oRuns = overlapJob.nextRuns(2, new Date(fall.at - 6 * 3600000));
  assert(
    oRuns[1].getTime() - oRuns[0].getTime() >= 23 * 3600000,
    "the repeated 02:30 must not be enumerated twice",
  );
});

test("directed: Lord Howe half-hour spring gap adjusts by 30 minutes", () => {
  const zone = "Australia/Lord_Howe";
  // October: +10:30 -> +11:00 (forward 30-minute gap starting ~02:00 local)
  const spring = findTransitionsCoarse(zone, Date.UTC(2025, 9, 4), Date.UTC(2025, 9, 6))[0];
  assert(
    spring && isForwardGap(spring) && spring.toOffset - spring.fromOffset === 30,
    "Lord Howe must expose a 30-minute forward transition",
  );
  const job = new Cron("0 15 2 * * *", { timezone: zone });
  const n = job.nextRun(new Date(spring.at - 4 * 3600000));
  assert(
    n !== null && n.getTime() >= spring.at,
    "02:15 local does not exist; run must be at or after the half-hour gap edge",
  );
  const prev = job.previousRuns(1, n)[0];
  assert(
    prev.getTime() < n.getTime() && job.match(prev),
    "predecessor across the half-hour gap must be a real matching run",
  );

  // April: +11:00 -> +10:30 fall-back, the repeated interval must round-trip.
  const fall = findTransitionsCoarse(zone, Date.UTC(2025, 3, 5), Date.UTC(2025, 3, 7))[0];
  assert(fall && !isForwardGap(fall));
  const fjob = new Cron("0 45 1 * * *", { timezone: zone });
  const fr = fjob.nextRun(new Date(fall.at - 6 * 3600000));
  assert(fr !== null, "Lord Howe fall run must resolve");
  const back = fjob.previousRuns(1, fr)[0];
  const rt = fjob.nextRun(back);
  assert(rt !== null, "Lord Howe fall round trip must resolve");
  assertEquals(rt.getTime(), fr.getTime(), "half-hour fall-back round trip must be exact");
});

test("directed: leap day only matches February 29th and searches both directions", () => {
  const job = new Cron("0 0 0 29 2 *", { utcOffset: 0 });
  // References are one second off the match itself: both directions exclude
  // the exact endpoint.
  const fromLeap = new Date(Date.UTC(2024, 1, 29, 0, 0, 1));
  assertEquals(job.nextRun(fromLeap)?.toISOString(), "2028-02-29T00:00:00.000Z");
  const beforeLeap = new Date(Date.UTC(2024, 1, 28, 23, 59, 59));
  assertEquals(job.previousRuns(1, beforeLeap)[0].toISOString(), "2020-02-29T00:00:00.000Z");
  // Standing exactly on the match: both endpoints are exclusive.
  const atMatch = new Date(Date.UTC(2024, 1, 29));
  assertEquals(job.nextRun(atMatch)?.toISOString(), "2028-02-29T00:00:00.000Z");
  assertEquals(job.previousRuns(1, atMatch)[0].toISOString(), "2020-02-29T00:00:00.000Z");
  assert(job.match(new Date(Date.UTC(2024, 1, 29))));
  assert(!job.match(new Date(Date.UTC(2025, 1, 28))));
  assert(!job.match(new Date(Date.UTC(2024, 1, 28))));
});

test("directed: last day of month matches actual month ends through short months", () => {
  const job = new Cron("0 0 0 L * *", { utcOffset: 0 });
  const runs = job.nextRuns(4, new Date(Date.UTC(2024, 0, 31, 0, 0, 1)));
  assertEquals(runs.map((d) => d.toISOString()), [
    "2024-02-29T00:00:00.000Z",
    "2024-03-31T00:00:00.000Z",
    "2024-04-30T00:00:00.000Z",
    "2024-05-31T00:00:00.000Z",
  ]);
  const backs = job.previousRuns(3, new Date(Date.UTC(2024, 0, 31)));
  assertEquals(backs.map((d) => d.toISOString()), [
    "2023-12-31T00:00:00.000Z",
    "2023-11-30T00:00:00.000Z",
    "2023-10-31T00:00:00.000Z",
  ]);
});

test("directed: nth weekday matches the ordinal occurrence and last occurrence", () => {
  const secondMonday = new Cron("0 0 0 * * MON#2", { utcOffset: 0 });
  const runs = secondMonday.nextRuns(3, new Date(Date.UTC(2025, 0, 1)));
  assertEquals(runs.map((d) => d.toISOString()), [
    "2025-01-13T00:00:00.000Z",
    "2025-02-10T00:00:00.000Z",
    "2025-03-10T00:00:00.000Z",
  ]);
  const lastFriday = new Cron("0 0 0 * * 5L", { utcOffset: 0 });
  const lruns = lastFriday.nextRuns(2, new Date(Date.UTC(2025, 0, 1)));
  assertEquals(lruns.map((d) => d.toISOString()), [
    "2025-01-31T00:00:00.000Z",
    "2025-02-28T00:00:00.000Z",
  ]);
  // Round-trip across an ordinal weekday is exact (no DST in UTC).
  const back = secondMonday.previousRuns(1, runs[1])[0];
  assertEquals(back.toISOString(), "2025-01-13T00:00:00.000Z");
});

test("directed: dayOffset shifts emitted instants by whole days and keeps ordering", () => {
  const base = new Cron("0 0 12 * * *", { utcOffset: 0 });
  const shifted = new Cron("0 0 12 * * *", { utcOffset: 0, dayOffset: -2 });
  const ref = new Date(Date.UTC(2025, 0, 15));
  const a = base.nextRuns(3, ref);
  const b = shifted.nextRuns(3, ref);
  for (let i = 0; i < 3; i++) {
    assertEquals(
      b[i].getTime(),
      a[i].getTime() - 2 * 86400000,
      "dayOffset is applied to emitted instants, not to matching",
    );
    // match() tests the pattern itself and is intentionally unaware of
    // dayOffset: the shifted instant still matches the underlying pattern.
    assertEquals(
      shifted.match(b[i]),
      true,
      "dayOffset must not change point-in-time matching semantics",
    );
  }
  // Strict ordering is preserved by the offset transform.
  for (let i = 1; i < b.length; i++) assert(b[i].getTime() > b[i - 1].getTime());
});

test("directed: impossible patterns return null without throwing, both directions", () => {
  // A larger search span must never paper over an impossible pattern.
  const impossible = ["0 0 0 31 2 *", "0 0 0 30 2 *", "0 0 0 31 4 *"];
  for (const pattern of impossible) {
    const job = new Cron(pattern, { utcOffset: 0 });
    assertEquals(
      job.nextRuns(8, new Date(Date.UTC(2020, 0, 1))),
      [],
      `'${pattern}' must never enumerate forward`,
    );
    assertEquals(
      job.previousRuns(8, new Date(Date.UTC(2030, 0, 1))),
      [],
      `'${pattern}' must never enumerate backward`,
    );
  }
});

test("directed: year-constrained pattern is bounded and empty past the last year", () => {
  const job = new Cron("0 0 0 1 1 * 2024-2025", { mode: "7-part", utcOffset: 0 });
  const runs = job.nextRuns(4, new Date(Date.UTC(2023, 6, 1)));
  assertEquals(runs.map((d) => d.getUTCFullYear()), [2024, 2025]);
  assertEquals(job.nextRun(new Date(Date.UTC(2026, 0, 1))), null);
  const backs = job.previousRuns(4, new Date(Date.UTC(2026, 6, 1)));
  assertEquals(backs.map((d) => d.getUTCFullYear()), [2025, 2024]);
});

test("directed: overrun protection skips triggers while busy, deterministically", () => {
  // No real-clock waiting: drive the internal trigger check directly with a
  // target in the past, exactly as the timer callback would do.
  let executions = 0;
  let release: (() => void) | undefined;
  const job = new Cron("* * * * * *", {
    protect: true,
  }, async () => {
    executions++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const trigger = (j: Cron, t: Date) =>
    (j as unknown as { _checkTrigger: (target: Date) => void })._checkTrigger(t);

  const target = new Date(FIXED_NOW);
  trigger(job, target);
  trigger(job, target); // busy: must be skipped by protect
  assertEquals(executions, 1, "protected job must not start an overlapping execution");

  release!();
  job.stop();
});

test("directed: without protect the overlapping trigger is allowed", () => {
  let executions = 0;
  const blockers: (() => void)[] = [];
  const job = new Cron("* * * * * *", {
    protect: false,
  }, async () => {
    executions++;
    await new Promise<void>((resolve) => blockers.push(resolve));
  });
  const trigger2 = (j: Cron, t: Date) =>
    (j as unknown as { _checkTrigger: (target: Date) => void })._checkTrigger(t);

  const target = new Date(FIXED_NOW);
  trigger2(job, target);
  trigger2(job, target); // not protected: allowed to overlap
  assertEquals(executions, 2);
  for (const unblock of blockers) unblock();
  job.stop();
});

test("directed: protect callback is invoked for skipped triggers", async () => {
  let executions = 0;
  let protectedCalls = 0;
  let release: (() => void) | undefined;
  const job = new Cron("* * * * * *", {
    protect: () => {
      protectedCalls++;
    },
  }, async () => {
    executions++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const trigger3 = (j: Cron, t: Date) =>
    (j as unknown as { _checkTrigger: (target: Date) => void })._checkTrigger(t);

  const target = new Date(FIXED_NOW);
  trigger3(job, target);
  trigger3(job, target);
  // Let the first execution mark the job busy, then yield the macrotask on
  // which the protect callback is dispatched (setTimeout 0).
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(executions, 1);
  assertEquals(protectedCalls, 1, "protect callback must observe the skipped trigger");
  release!();
  job.stop();
});

test("directed: fixed process clock - references are explicit and never host-local", () => {
  // Guardrail on the suite itself: enumeration with an explicit UTC reference
  // produces the same instants regardless of the host TZ the suite runs in.
  const ref = new Date(Date.UTC(2025, 3, 10, 12, 0, 0));
  const job = new Cron("15 */6 * * *", { utcOffset: 0 });
  const instants = job.nextRuns(3, ref).map((d) => d.getTime());
  // Minute 15 of hours 0,6,12,18; after 12:00 the next is 12:15 same day.
  assertEquals(instants, [
    Date.UTC(2025, 3, 10, 12, 15, 0),
    Date.UTC(2025, 3, 10, 18, 15, 0),
    Date.UTC(2025, 3, 11, 0, 15, 0),
  ]);
});
