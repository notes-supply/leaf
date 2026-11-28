/**
 * What Leaf keeps of the raid's sittings (migration 46): each sitting's state, who is seated where
 * while one is not over, and every member's place at one finished; and which a launch of the raid in a
 * Discord call sits at (migration 50). The sittings service (`service.ts`)
 * reads and writes them; every write but `create`, `shelve` and `letGo` is meant to run inside its
 * transaction. A database failure is a defect.
 */
import type { PlayerId } from "@sequoia-leaf/core";
import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

/** Where a sitting stands, as stored: the rules' `stage.at`. */
export type StageAt = "open" | "carousel" | "plan" | "fight" | "over";

/** A sitting as stored: its state as the rules encode it, how many writes changed it, and when it is due next (null: over). */
const Stored = Schema.Struct({ rev: Schema.Int, state: Schema.String, dueAt: Schema.NullOr(Schema.Int) });

/** An open sitting, for the list of those to sit at: its id, its state, and when it was opened. */
const Open = Schema.Struct({ id: Schema.String, state: Schema.String, openedAt: Schema.Int });

/** A member's record at the sittings: how many they finished, won, and finished in the first four. */
const Record = Schema.Struct({ played: Schema.Int, won: Schema.Int, four: Schema.Int });
export type Record = typeof Record.Type;

/** What a write leaves a sitting as: its state, where it stands, and when it is due (null: over) or ended. */
export interface Writing {
  readonly state: string;
  readonly stage: StageAt;
  readonly dueAt: number | null;
  readonly endedAt: number | null;
}

/** A finished member's place, as kept. */
export interface Place {
  readonly player: string;
  readonly place: number;
}

const Count = Schema.Struct({ n: Schema.Int });
const Moments = Schema.Struct({ now: Schema.Int, most: Schema.Int });

/** Reading the sittings themselves. */
function sittingsIn(sql: SqlClient.SqlClient) {
  const read = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Stored,
    execute: (id) => sql`SELECT rev, state, due_at AS dueAt FROM raid_sittings WHERE id = ${id}`,
  });
  const at = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ rev: Stored.fields.rev, dueAt: Stored.fields.dueAt }),
    execute: (id) => sql`SELECT rev, due_at AS dueAt FROM raid_sittings WHERE id = ${id}`,
  });
  const open = SqlSchema.findAll({
    Request: Moments,
    Result: Open,
    execute: ({ now, most }) => sql`
      SELECT id, state, opened_at AS openedAt FROM raid_sittings
      WHERE stage = 'open' AND due_at > ${now}
        AND NOT EXISTS (SELECT 1 FROM raid_sitting_calls WHERE sitting = raid_sittings.id)
      ORDER BY opened_at, id LIMIT ${most}
    `,
  });
  const due = SqlSchema.findAll({
    Request: Moments,
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ now, most }) =>
      sql`SELECT id FROM raid_sittings WHERE due_at <= ${now} ORDER BY due_at, id LIMIT ${most}`,
  });
  const notOver = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Count,
    execute: () => sql`SELECT count(*) AS n FROM raid_sittings WHERE ended_at IS NULL`,
  });
  const openedSince = SqlSchema.findOne({
    Request: Schema.Struct({ player: Schema.String, since: Schema.Int }),
    Result: Count,
    execute: ({ player, since }) =>
      sql`SELECT count(*) AS n FROM raid_sittings WHERE opened_by = ${player} AND opened_at > ${since}`,
  });
  return {
    /** A sitting as stored, or none. */
    read: (id: string) => read(id).pipe(Effect.orDie),
    /** A sitting's `rev`, and when it is due next, reading no more of it; or none. */
    at: (id: string) => at(id).pipe(Effect.orDie),
    /** The open sittings not yet closed at `now`, the longest open first, `most` at most: a call's are its own, and not among them. */
    open: (now: number, most: number) => open({ now, most }).pipe(Effect.orDie),
    /** The sittings due by `now`, the longest due first, `most` at most. */
    due: (now: number, most: number) =>
      due({ now, most }).pipe(
        Effect.map((rows) => rows.map((row) => row.id)),
        Effect.orDie,
      ),
    /** How many sittings are not over, as stored. */
    notOver: notOver(undefined).pipe(
      Effect.map((row) => row.n),
      Effect.orDie,
    ),
    /** How many sittings a player has opened since a moment. */
    openedSince: (player: PlayerId, since: number) =>
      openedSince({ player, since }).pipe(
        Effect.map((row) => row.n),
        Effect.orDie,
      ),
  };
}

/** Reading who is seated where, and the places kept. */
function seatsIn(sql: SqlClient.SqlClient) {
  const seatOf = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ sitting: Schema.String }),
    execute: (player) => sql`SELECT sitting FROM raid_sitting_seats WHERE player_id = ${player}`,
  });
  const seatsAt = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ player: Schema.String }),
    execute: (id) => sql`SELECT player_id AS player FROM raid_sitting_seats WHERE sitting = ${id}`,
  });
  const record = SqlSchema.findOne({
    Request: Schema.String,
    Result: Record,
    execute: (player) => sql`
      SELECT count(*) AS played, coalesce(sum(place = 1), 0) AS won, coalesce(sum(place <= 4), 0) AS four
      FROM raid_sitting_places WHERE player_id = ${player}
    `,
  });
  return {
    /** The sitting a player is seated at, if any. */
    seatOf: (player: string) => seatOf(player).pipe(Effect.map(Option.map((row) => row.sitting)), Effect.orDie),
    /** Everyone seated at a sitting. */
    seatsAt: (id: string) =>
      seatsAt(id).pipe(
        Effect.map((rows) => rows.map((row) => row.player)),
        Effect.orDie,
      ),
    /** A member's record, from their places. */
    record: (player: PlayerId) => record(player).pipe(Effect.orDie),
    /**
     * Seats a player at a sitting, unless they are seated somewhere already. Says whether they are
     * seated there now: false when they are seated at another.
     */
    seat: (player: string, id: string, now: number) =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO raid_sitting_seats (player_id, sitting, since) VALUES (${player}, ${id}, ${now})
          ON CONFLICT (player_id) DO NOTHING
        `;
        const held = yield* seatOf(player);
        return Option.isSome(held) && held.value.sitting === id;
      }).pipe(Effect.orDie),
    /** Frees these players' seats at a sitting. */
    unseat: (id: string, players: readonly string[]) =>
      players.length === 0
        ? Effect.void
        : sql`DELETE FROM raid_sitting_seats WHERE sitting = ${id} AND ${sql.in("player_id", players)}`.pipe(
            Effect.asVoid,
            Effect.orDie,
          ),
    /** Keeps each member's place at a finished sitting of `seats`, once. */
    place: (id: string, places: readonly Place[], seats: number, ended: number) =>
      Effect.forEach(
        places,
        ({ player, place }) => sql`
          INSERT INTO raid_sitting_places (sitting, player_id, place, seats, ended)
          VALUES (${id}, ${player}, ${place}, ${seats}, ${ended})
          ON CONFLICT (sitting, player_id) DO NOTHING
        `,
        { discard: true },
      ).pipe(Effect.orDie),
  };
}

/** Which sitting a launch of the raid in a Discord call sits at (migration 50). */
function callsIn(sql: SqlClient.SqlClient) {
  const callAt = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ sitting: Schema.String }),
    execute: (instance) => sql`SELECT sitting FROM raid_sitting_calls WHERE instance = ${instance}`,
  });
  const isCall = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ instance: Schema.String }),
    execute: (id) => sql`SELECT instance FROM raid_sitting_calls WHERE sitting = ${id}`,
  });
  return {
    /** The sitting a launch sits at, if it has one. */
    callAt: (instance: string) => callAt(instance).pipe(Effect.map(Option.map((row) => row.sitting)), Effect.orDie),
    /** Whether a sitting is a launch's in a Discord call. */
    isCall: (id: string) =>
      isCall(id).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    /**
     * Has a launch sit at a sitting, in place of one of its that is over. Says whether it does: false
     * when one of its is not over (another made it meanwhile). Meant to run inside the transaction
     * that creates the sitting.
     */
    call: (instance: string, id: string, now: number) =>
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM raid_sitting_calls WHERE instance = ${instance}
            AND sitting IN (SELECT id FROM raid_sittings WHERE ended_at IS NOT NULL)
        `;
        const made = yield* sql`
          INSERT INTO raid_sitting_calls (instance, sitting, since) VALUES (${instance}, ${id}, ${now})
          ON CONFLICT (instance) DO NOTHING RETURNING sitting
        `;
        return made.length > 0;
      }).pipe(Effect.orDie),
  };
}

/** Writing the sittings themselves. */
function writesIn(sql: SqlClient.SqlClient) {
  return {
    /** Stores a new sitting, `rev` 0. */
    create: (id: string, by: PlayerId, now: number, writing: Writing) =>
      sql`
        INSERT INTO raid_sittings (id, state, rev, opened_by, opened_at, stage, due_at, ended_at)
        VALUES (${id}, ${writing.state}, 0, ${by}, ${now}, ${writing.stage}, ${writing.dueAt}, ${writing.endedAt})
      `.pipe(Effect.asVoid, Effect.orDie),
    /** Whether a sitting is stored at `rev`. */
    isAt: (id: string, rev: number) =>
      sql`SELECT rev FROM raid_sittings WHERE id = ${id} AND rev = ${rev}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    /** Writes a sitting over the one stored at `rev`, its `rev` up by one. Says whether it did: false when it is no longer at `rev`. */
    write: (id: string, rev: number, writing: Writing) =>
      sql`
        UPDATE raid_sittings SET state = ${writing.state}, rev = rev + 1, stage = ${writing.stage},
          due_at = ${writing.dueAt}, ended_at = ${writing.endedAt}
        WHERE id = ${id} AND rev = ${rev} RETURNING rev
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    /**
     * Has a sitting stored at `rev` over at `now`, its state kept as it is, and frees its seats: for
     * one whose state does not read, so that nobody stays seated at it.
     */
    shelve: (id: string, rev: number, now: number) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const shelved = yield* sql`
              UPDATE raid_sittings SET stage = 'over', due_at = NULL, ended_at = ${now}
              WHERE id = ${id} AND rev = ${rev} AND ended_at IS NULL RETURNING id
            `;
            if (shelved.length > 0) yield* sql`DELETE FROM raid_sitting_seats WHERE sitting = ${id}`;
          }),
        )
        .pipe(Effect.orDie),
    /** Lets go of every sitting that ended before a moment (its places stay). */
    letGo: (before: number) =>
      sql`DELETE FROM raid_sittings WHERE ended_at < ${before}`.pipe(Effect.asVoid, Effect.orDie),
  };
}

/** The sittings' tables, on the database. */
export const sittingStore = Effect.map(SqlClient.SqlClient, (sql) => ({
  ...sittingsIn(sql),
  ...seatsIn(sql),
  ...callsIn(sql),
  ...writesIn(sql),
}));

export type SittingStore = Effect.Success<typeof sittingStore>;
