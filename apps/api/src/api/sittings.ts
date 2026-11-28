import { Schema } from "effect";

import { Purse } from "./schemas.ts";

// What the routes of the raid's sittings (its live tables) answer, and their own refusals. Times are
// ISO 8601 strings in UTC; inside `state`, the rules' own moments are Leaf's milliseconds.

const Time = Schema.String;

/** A member as a sitting names them: their Leaf id, and their name as Leaf shows it. */
const Member = Schema.Struct({ id: Schema.String, name: Schema.String });

/** The open sittings to sit at (`by` who opened it, how many `sat`, when it `closes`), and the caller's own, if any. */
export const SittingsListed = Schema.Struct({
  now: Time,
  open: Schema.Array(Schema.Struct({ id: Schema.String, by: Member, sat: Schema.Number, closes: Time })),
  yours: Schema.NullOr(Schema.String),
});

/** A sitting as the caller is shown it (`sittingView`), at its `rev`, with Leaf's clock and the caller's balances. */
export const SittingShown = Schema.Struct({
  id: Schema.String,
  rev: Schema.Number,
  now: Time,
  state: Schema.Unknown,
  purse: Purse,
});

/** A sitting read with the `rev` the page has, nothing changed since: nothing to show. */
const SittingUnchanged = Schema.Struct({
  id: Schema.String,
  rev: Schema.Number,
  now: Time,
  unchanged: Schema.Literal(true),
});

export const SittingRead = Schema.Union([SittingUnchanged, SittingShown]);

/** What each command did (the rules' notes), or the code and sentence it was refused with. */
const SittingResult = Schema.Union([
  Schema.Struct({ id: Schema.String, notes: Schema.Array(Schema.Unknown) }),
  Schema.Struct({ id: Schema.String, refused: Schema.String, why: Schema.String }),
]);

/** A batch done at a sitting: each command's result, in the order they came, and the sitting after them all. */
export const SittingPlayed = Schema.Struct({ ...SittingShown.fields, results: Schema.Array(SittingResult) });

/** A player's record at the sittings: how many they finished, won, and finished in the first four. */
export const SittingRecord = Schema.Struct({ played: Schema.Number, won: Schema.Number, top_four: Schema.Number });

/** Opening a sitting, from the player the page believes it is. */
export const OpenBody = Schema.Struct({ player: Schema.String });

/** Sitting at the sitting of a launch of the raid in a Discord call: the player, and the launch Discord named. */
export const CallBody = Schema.Struct({
  player: Schema.String,
  instance: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,128}$/)),
});

const answer = <const Codes extends readonly [string, ...string[]]>(...codes: Codes) => ({
  code: Schema.Literals(codes),
  message: Schema.String,
});

/** No sitting by that id: never one, or one over for a day and let go of. */
export class SittingMissing extends Schema.Error<SittingMissing>("SittingMissing")(answer("no_such_sitting"), {
  httpApiStatus: 404,
}) {}

/** A sitting a newer Leaf stored, as one runs beside this one in a deploy: nothing was done, and it is left as it is. */
export class SittingUpdating extends Schema.Error<SittingUpdating>("SittingUpdating")(answer("sitting_updating"), {
  httpApiStatus: 503,
}) {}

/**
 * A sitting not opened or sat at: the caller is seated at another, as many are going as may be, or
 * (in a Discord call) the call's has started without them. Nothing was done.
 */
export class SittingRefused extends Schema.Error<SittingRefused>("SittingRefused")(
  answer("seated_elsewhere", "sittings_full", "table_started"),
  { httpApiStatus: 409 },
) {}
