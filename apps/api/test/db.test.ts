import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteClient } from "@effect/sql-sqlite-bun";
import { type Ctx, leaf, playerId } from "@sequoia-leaf/core";
import { PULLS } from "@sequoia-leaf/pulls";
import { eraAt } from "@sequoia-leaf/raid";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { fightColumns, fightLines, rowOf } from "../scripts/fight-lines.ts";
import { AppConfig } from "../src/config.ts";
import { Database } from "../src/db.ts";
import { Ledger } from "../src/ledger/store.ts";
import { rejection, testConfig } from "./support.ts";

const alice = playerId("00000000-0000-4000-8000-00000000000a");
/** When the fights the migrations meet were written: Tuesday 1 December 2026, before Groot Night, and a day after it opened. */
const FOUGHT_AT = Date.UTC(2026, 11, 1);
const LATER = Date.UTC(2026, 11, 9);

/** The awards the pulls give for further copies of prizes, from a state as stored, in order. */
function copies(text: string): string[] {
  const read = PULLS.decode(text);
  return (read ? (PULLS.awards?.(read) ?? []) : []).filter((id) => id.startsWith("copies:")).toSorted();
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "leaf-db-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true });
});

/** Runs a program against the database file at `path`, opened as the server opens it. */
function onFile<A, E>(path: string, program: Effect.Effect<A, E, SqlClient.SqlClient | Ledger>): Promise<A> {
  const database = Ledger.layer.pipe(
    Layer.provideMerge(Database),
    Layer.provide(Layer.succeed(AppConfig)(testConfig({ databasePath: path }))),
  );
  return Effect.runPromise(program.pipe(Effect.provide(database)));
}

/** Runs SQL against the database file at `path`. */
/** Undoes migration 50: no call's sitting kept. */
const beforeSittingCalls = (sql: SqlClient.SqlClient) => sql`DROP TABLE raid_sitting_calls`;

/** Undoes migrations 50 and 49: no call's sitting kept, and nobody a banner calls. */
const beforeBannerCalled = (sql: SqlClient.SqlClient) =>
  Effect.andThen(beforeSittingCalls(sql), sql`DROP TABLE banner_called`);

/** Undoes migrations 50 to 48: no call's sitting, nobody a banner calls, and no fight's setup kept. */
const beforeFightSetups = (sql: SqlClient.SqlClient) =>
  Effect.andThen(beforeBannerCalled(sql), sql`ALTER TABLE raid_fights DROP COLUMN setup`);

/** Undoes migrations 50 to 47: no call's sitting, nobody a banner calls, no fight's setup, nor its course, pool or era kept beside its way. */
const beforeFightsWay = (sql: SqlClient.SqlClient) =>
  Effect.andThen(
    beforeFightSetups(sql),
    Effect.all([
      sql`ALTER TABLE raid_fights DROP COLUMN course`,
      sql`ALTER TABLE raid_fights DROP COLUMN pool`,
      sql`ALTER TABLE raid_fights DROP COLUMN era`,
    ]),
  );

/** Undoes migrations 50 to 46: none of the raid's sittings kept, nor whose a call's is. */
const beforeRaidSittings = (sql: SqlClient.SqlClient) =>
  Effect.andThen(
    beforeFightsWay(sql),
    Effect.all([
      sql`DROP TABLE raid_sitting_seats`,
      sql`DROP TABLE raid_sitting_places`,
      sql`DROP TABLE raid_sittings`,
    ]),
  );

/** Undoes migrations 48 to 45: no raid fights kept. */
const beforeRaidFights = (sql: SqlClient.SqlClient) =>
  Effect.andThen(beforeRaidSittings(sql), sql`DROP TABLE raid_fights`);

/** Undoes migrations 45 and 43: the pieces players leave not indexed by game and slot (the pulls' counts it let go stay gone). */
const beforePlayKeptMet = (sql: SqlClient.SqlClient) =>
  Effect.andThen(beforeRaidFights(sql), sql`DROP INDEX IF EXISTS play_kept_slot`);

/** Undoes migrations 43 and 42: no `rev` kept of what each state's standing was worked out from. */
const beforePlayStood = (sql: SqlClient.SqlClient) =>
  Effect.andThen(
    beforePlayKeptMet(sql),
    Effect.andThen(sql`DROP INDEX play_state_unstood`, sql`ALTER TABLE play_state DROP COLUMN stood`),
  );

/** Undoes migrations 42 and 41: no Leaf sessions, no merges recorded, and no record of why an id is Leaf's. */
const beforeSignIns = (sql: SqlClient.SqlClient) =>
  Effect.andThen(
    beforePlayStood(sql),
    Effect.all([sql`DROP TABLE sign_ins`, sql`DROP TABLE merges`, sql`ALTER TABLE leaf_ids DROP COLUMN for_discord`]),
  );

/** Undoes migrations 41 and 40: no logins kept, and no player's id marked as not their account's. */
const beforeLogins = (sql: SqlClient.SqlClient) =>
  Effect.andThen(beforeSignIns(sql), Effect.andThen(sql`DROP TABLE logins`, sql`DROP TABLE leaf_ids`));

/** Undoes migrations 40 and 39: no postcards kept (the states it made due stay due, as Leaf's sweep would leave them). */
const beforePlayPostcards = (sql: SqlClient.SqlClient) =>
  Effect.andThen(beforeLogins(sql), sql`DROP TABLE play_postcards`);

/** Undoes migrations 39 and 38: no camp kept on visits, and the triggers as migration 37 made them. */
const beforeVisitCamps = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* beforePlayPostcards(sql);
    yield* sql`DROP TRIGGER visits_opened`;
    yield* sql`DROP TRIGGER visits_heard`;
    yield* sql`ALTER TABLE last_visits DROP COLUMN camp_owner`;
    yield* sql`ALTER TABLE visits DROP COLUMN camp_owner`;
    yield* sql`
      CREATE TRIGGER visits_opened
      AFTER INSERT ON visits
      BEGIN
        INSERT INTO last_visits (player_id, visit_id, place, guest, heard_at, left_at, stay)
        VALUES (NEW.player_id, NEW.id, NEW.place, NEW.guest, NEW.heard_at, NEW.left_at,
                coalesce((SELECT stay FROM players_seen WHERE player_id = NEW.player_id), 1))
        ON CONFLICT (player_id) DO UPDATE SET
          visit_id = excluded.visit_id, place = excluded.place, guest = excluded.guest,
          heard_at = excluded.heard_at, left_at = excluded.left_at
        WHERE excluded.visit_id > last_visits.visit_id;
      END
    `;
    yield* sql`
      CREATE TRIGGER visits_heard
      AFTER UPDATE OF place, guest, heard_at, left_at ON visits
      BEGIN
        UPDATE last_visits SET place = NEW.place, guest = NEW.guest, heard_at = NEW.heard_at, left_at = NEW.left_at
        WHERE player_id = NEW.player_id AND visit_id = NEW.id;
      END
    `;
  });

/** Undoes migrations 39 to 37: no newest visit kept for each player, and visits indexed by when they were last heard of. */
const beforeLastVisits = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* beforeVisitCamps(sql);
    for (const trigger of [
      "visits_opened",
      "visits_heard",
      "visits_removed",
      "players_seen_stay",
      "players_seen_first",
    ]) {
      yield* sql`DROP TRIGGER ${sql(trigger)}`;
    }
    yield* sql`DROP TABLE last_visits`;
    yield* sql`DROP INDEX visits_open_by_heard`;
    yield* sql`CREATE INDEX visits_by_heard ON visits (heard_at)`;
  });

/** Undoes migrations 39 to 36: and no check for missed levels kept. */
const beforeLevelChecks = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* beforeLastVisits(sql);
    yield* sql`DROP TABLE level_checks`;
  });

/** Undoes migrations 39 to 34: no likes of camps kept, and `presence` back, empty, as migrations 12 to 29 left it. */
const beforeDropPresence = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* beforeLevelChecks(sql);
    yield* sql`DROP TABLE camp_likes`;
    yield* sql`
      CREATE TABLE presence (
        player_id TEXT    PRIMARY KEY,
        username  TEXT    NOT NULL,
        place     TEXT    NOT NULL,
        seen_at   INTEGER NOT NULL,
        stay      INTEGER NOT NULL DEFAULT 1 CHECK (stay IN (0, 1)),
        guest     INTEGER NOT NULL DEFAULT 0 CHECK (guest IN (0, 1)),
        left_at   INTEGER
      ) STRICT
    `;
    yield* sql`CREATE INDEX presence_by_time ON presence (seen_at)`;
  });

/** Undoes migrations 34 and 33 (who is about from visits), for a test going back before them. */
const beforeAboutFromVisits = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* beforeDropPresence(sql);
    yield* sql`DROP INDEX visits_by_heard`;
    yield* sql`ALTER TABLE players_seen DROP COLUMN stay`;
  });

/** Undoes migrations 33 and 32 (when each state is next due a tend), for a test going back before them. */
const beforePlayDue = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* beforeAboutFromVisits(sql);
    yield* sql`DROP INDEX play_state_due`;
    yield* sql`ALTER TABLE play_state DROP COLUMN due_at`;
  });

/**
 * Undoes migrations 33 (`about_from_visits`), 32 (`play_due`), 31 (a state's generation,
 * `play_state.born`) and 30 (the Tally's `tallies` and `camp_visits`), for a test going back before them.
 */
const beforeTallies = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* beforePlayDue(sql);
    yield* sql`ALTER TABLE play_state DROP COLUMN born`;
    yield* sql`DROP TABLE tallies`;
    yield* sql`DROP TABLE camp_visits`;
  });

/**
 * Undoes migrations 33 to 28 (`about_from_visits`, `play_due`, `play_born`, `tallies`, `presence_left`, `time_in`), for a
 * test going back before them: `played` as migrations 23 and 27 left it.
 */
const beforeTimeIn = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* beforeTallies(sql);
    yield* sql`ALTER TABLE presence DROP COLUMN left_at`;
    yield* sql`DROP TABLE time_in`;
    yield* sql`ALTER TABLE visits DROP COLUMN acted_at`;
    yield* sql`
      CREATE TABLE played (
        player_id TEXT,
        game      TEXT,
        ms        INTEGER NOT NULL,
        seen_at   INTEGER NOT NULL,
        afk_ms    INTEGER NOT NULL DEFAULT 0,
        afk       INTEGER NOT NULL DEFAULT 0 CHECK (afk IN (0, 1)),
        PRIMARY KEY (player_id, game)
      ) STRICT, WITHOUT ROWID
    `;
  });

function query(path: string, statement: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<unknown>, unknown>) {
  return onFile(path, SqlClient.SqlClient.use(statement));
}

/** A raid fight of a way a record said, written at a moment as Leaf wrote them before migration 47. */
const insertFight = (sql: SqlClient.SqlClient, at: number, way: string) => sql`
    INSERT INTO raid_fights (player_id, at, rules, run, way, trail, room, kind, across, result, margin, seconds,
      resolve, level, acorns, party, against)
    VALUES (${alice}, ${at}, 'r', 1, ${way}, ${way === "main" ? 2 : 0}, 3, 'spar', 'plan:0', 'win', 0.5, 9,
      20, 3, 4, '{"figures":[],"traits":{},"boons":[]}', NULL)
  `;

describe("the database", () => {
  it("creates the file and its directory, and keeps what was written when opened again", async () => {
    const path = join(directory, "nested", "leaf.db");
    await onFile(
      path,
      Ledger.use((ledger) =>
        ledger.post({ kind: "earn", playerId: alice, amount: leaf(110), source: "raid", idempotencyKey: "a" }, 1),
      ),
    );

    const account = await onFile(
      path,
      Ledger.use((ledger) => ledger.account(alice)),
    );

    expect(account.balance).toBe(110);
  });

  it("sets up a new database from the schema migration, once", async () => {
    const path = join(directory, "leaf.db");
    await onFile(path, Effect.void);

    expect(await query(path, (sql) => sql`SELECT migration_id, name FROM effect_sql_migrations`)).toEqual([
      { migration_id: 10, name: "schema" },
      { migration_id: 11, name: "announcements" },
      { migration_id: 12, name: "game" },
      { migration_id: 13, name: "presence_stay" },
      { migration_id: 14, name: "guests" },
      { migration_id: 15, name: "save_history" },
      { migration_id: 16, name: "activity" },
      { migration_id: 17, name: "play" },
      { migration_id: 18, name: "earned" },
      { migration_id: 19, name: "standings" },
      { migration_id: 20, name: "purchases" },
      { migration_id: 21, name: "awards" },
      { migration_id: 22, name: "banner_people" },
      { migration_id: 23, name: "played" },
      { migration_id: 24, name: "play_guest" },
      { migration_id: 25, name: "wars_by_time" },
      { migration_id: 26, name: "play_kept" },
      { migration_id: 27, name: "afk" },
      { migration_id: 28, name: "time_in" },
      { migration_id: 29, name: "presence_left" },
      { migration_id: 30, name: "tallies" },
      { migration_id: 31, name: "play_born" },
      { migration_id: 32, name: "play_due" },
      { migration_id: 33, name: "about_from_visits" },
      { migration_id: 34, name: "drop_presence" },
      { migration_id: 35, name: "camp_likes" },
      { migration_id: 36, name: "level_checks" },
      { migration_id: 37, name: "last_visits" },
      { migration_id: 38, name: "visit_camps" },
      { migration_id: 39, name: "play_postcards" },
      { migration_id: 40, name: "logins" },
      { migration_id: 41, name: "sign_ins" },
      { migration_id: 42, name: "play_stood" },
      { migration_id: 43, name: "play_kept_met" },
      { migration_id: 44, name: "copies_awards" },
      { migration_id: 45, name: "raid_fights" },
      { migration_id: 46, name: "raid_sittings" },
      { migration_id: 47, name: "raid_fights_way" },
      { migration_id: 48, name: "raid_fights_setup" },
      { migration_id: 49, name: "banner_called" },
      { migration_id: 50, name: "raid_sitting_calls" },
    ]);
    // Each feed has its own lease and cursor, not started yet.
    expect(await query(path, (sql) => sql`SELECT name, started_at, cursor FROM sync_state ORDER BY name`)).toEqual([
      { name: "achievements", started_at: null, cursor: null },
      { name: "credits", started_at: null, cursor: null },
    ]);
  });

  it("opens a database migrated before Leaf used Effect's migrator, such as an older backup, applying only what came after", async () => {
    const path = join(directory, "leaf.db");
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Ledger.use((ledger) =>
          ledger.post({ kind: "earn", playerId: alice, amount: leaf(110), source: "raid", idempotencyKey: "a" }, 1),
        );
        // Put the record back the way the old migrator kept it, one row per file.
        yield* sql`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT, WITHOUT ROWID`;
        yield* sql`
          WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < 10)
          INSERT INTO schema_migrations SELECT printf('%04d_old.sql', id), 1763294400000 FROM n
        `;
        yield* sql`DROP TABLE effect_sql_migrations`;
        // Nor had it the tables added since.
        yield* sql`DROP TABLE announcements`;
        for (const table of [
          "saves",
          "skins",
          "player_names",
          "save_history",
          "visits",
          "sessions",
          "players_seen",
          "play_state",
          "play_commands",
          "coin_entries",
          "coins",
          "command_days",
          "activity",
          "standings",
          "cancelled_purchases",
          "awards",
          "banner_people",
          "play_kept",
          "time_in",
          "tallies",
          "camp_visits",
          "camp_likes",
          "level_checks",
          "last_visits",
          "play_postcards",
          "logins",
          "leaf_ids",
          "sign_ins",
          "merges",
          "raid_fights",
          "raid_sitting_calls",
          "raid_sitting_seats",
          "raid_sitting_places",
          "raid_sittings",
          "banner_called",
        ]) {
          yield* sql`DROP TABLE ${sql(table)}`;
        }
        yield* sql`DROP INDEX activities_wars`;
      }),
    );

    const account = await onFile(
      path,
      Ledger.use((ledger) => ledger.account(alice)),
    );

    expect(account.balance).toBe(110);
    expect(await query(path, (sql) => sql`SELECT max(migration_id) AS latest FROM effect_sql_migrations`)).toEqual([
      { latest: 50 },
    ]);
    expect(await query(path, (sql) => sql`SELECT count(*) AS n FROM announcements`)).toEqual([{ n: 0 }]);
    expect(await query(path, (sql) => sql`SELECT count(*) AS n FROM saves`)).toEqual([{ n: 0 }]);
    expect(await query(path, (sql) => sql`SELECT name FROM sqlite_master WHERE name = 'presence'`)).toEqual([]);
  });

  it("marks each state kept before it knew a guest's as theirs: from where it stands, or else as the player was last seen", async () => {
    const path = join(directory, "leaf.db");
    const guest = "00000000-0000-4000-8000-00000000000a";
    const member = "00000000-0000-4000-8000-00000000000b";
    const unknown = "00000000-0000-4000-8000-00000000000c";
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Back to before migration 24 (after 23, `played`), with a guest on a board, a guest last seen,
        // and a player never seen.
        yield* sql`ALTER TABLE play_state DROP COLUMN guest`;
        yield* sql`DROP INDEX activities_wars`;
        yield* sql`DROP TABLE play_kept`;
        yield* beforeTimeIn(sql);
        yield* sql`ALTER TABLE played DROP COLUMN afk_ms`;
        yield* sql`ALTER TABLE played DROP COLUMN afk`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 24`;
        for (const [player, game] of [
          [guest, "works"],
          [guest, "town"],
          [member, "works"],
          [unknown, "works"],
        ] as const) {
          yield* sql`INSERT INTO play_state (player_id, game, rev, state, updated_at) VALUES (${player}, ${game}, 1, '{}', 1)`;
        }
        yield* sql`INSERT INTO standings (player_id, game, score, also, guest, updated_at) VALUES (${guest}, 'works', 5, '{}', 1, 1)`;
        yield* sql`INSERT INTO players_seen (player_id, name, guest, first_seen_at, last_seen_at) VALUES (${guest}, 'G', 1, 1, 1)`;
        yield* sql`INSERT INTO players_seen (player_id, name, guest, first_seen_at, last_seen_at) VALUES (${member}, 'M', 0, 1, 1)`;
      }),
    );
    expect(
      await query(path, (sql) => sql`SELECT player_id AS player, game, guest FROM play_state ORDER BY player_id, game`),
    ).toEqual([
      { player: guest, game: "town", guest: 1 },
      { player: guest, game: "works", guest: 1 },
      { player: member, game: "works", guest: 0 },
      { player: unknown, game: "works", guest: 0 },
    ]);
  });

  it("kept how many of each prize each member who had pulled had, and lets go of them again, since nothing read them", async () => {
    const path = join(directory, "leaf.db");
    const pulled = "00000000-0000-4000-8000-00000000000a";
    const opened = "00000000-0000-4000-8000-00000000000b";
    const raided = "00000000-0000-4000-8000-00000000000c";
    const guest = "00000000-0000-4000-8000-00000000000d";
    const ctx: Ctx = {
      now: Date.UTC(2026, 10, 25),
      player: { id: pulled, guest: false },
      seed: 7,
      room: 0,
      awards: [],
      postcards: {},
    };
    const have = { "figure:greg": 2, "headliner:banner-1": 1 };
    // With a ware of the Treasury's, retired: let go of as the game reads the state.
    const state = PULLS.encode({ ...PULLS.create(ctx), have: { ...have, "ware:jar": 1 } });
    expect(PULLS.decode(state)?.have).toEqual(have);
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Back to before migration 26, with a member who has pulled, one who has only opened the
        // pulls, one who has only played the raid, and a guest.
        yield* sql`DROP TABLE play_kept`;
        yield* beforeTimeIn(sql);
        yield* sql`ALTER TABLE played DROP COLUMN afk_ms`;
        yield* sql`ALTER TABLE played DROP COLUMN afk`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 26`;
        for (const [player, game, text, isGuest] of [
          [pulled, "pulls", state, 0],
          [opened, "pulls", PULLS.encode(PULLS.create(ctx)), 0],
          [raided, "raid", "{}", 0],
          [guest, "pulls", state, 1],
        ] as const) {
          yield* sql`
            INSERT INTO play_state (player_id, game, rev, state, updated_at, guest)
            VALUES (${player}, ${game}, 1, ${text}, 5, ${isGuest})
          `;
        }
      }),
    );
    // Migration 26 kept the member's counts; migration 43 let them go.
    expect(
      await query(path, (sql) => sql`SELECT player_id AS player, game, slot, data, updated_at AS at FROM play_kept`),
    ).toEqual([]);
  });

  it("finds the pieces players leave for others by game and slot, and lets go of the pulls' counts nothing read", async () => {
    const path = join(directory, "leaf.db");
    const [a, b] = ["a", "b"].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Back to before migration 43: a member's board for a room of the raid, and two members' pulls counted.
        yield* beforePlayKeptMet(sql);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 43`;
        yield* sql`
          INSERT INTO play_kept (player_id, game, slot, data, updated_at) VALUES
            (${a}, 'raid', 'board:0:2', '{}', 1), (${a}, 'pulls', 'have', '{}', 1), (${b}, 'pulls', 'have', '{}', 1)
        `;
      }),
    );
    expect(await query(path, (sql) => sql`SELECT player_id AS player, game, slot FROM play_kept`)).toEqual([
      { player: a, game: "raid", slot: "board:0:2" },
    ]);
    const plan = await query(
      path,
      (sql) => sql`EXPLAIN QUERY PLAN SELECT count(*) FROM play_kept WHERE game = 'raid' AND slot = 'board:0:2'`,
    );
    expect(JSON.stringify(plan)).toContain("play_kept_slot");
  });

  it("starts each player's time in each game from what Leaf had: their pages' calls as played, the rest of their visits since as AFK", async () => {
    const path = join(directory, "leaf.db");
    const member = "00000000-0000-4000-8000-00000000000a";
    const stayer = "00000000-0000-4000-8000-00000000000b";
    const MINUTE = 60_000;
    const began = Date.UTC(2026, 10, 22, 22, 49, 27);
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Back to before migration 28, Leaf having begun counting calls at migration 23.
        yield* beforeTimeIn(sql);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 28`;
        yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-11-22 22:49:27' WHERE migration_id = 23`;
        // The member's pages called the town ten minutes, the pulls five and the raid two; the stayer's none.
        for (const [game, ms] of [
          ["town", 10 * MINUTE],
          ["pulls", 5 * MINUTE],
          ["raid", 2 * MINUTE],
        ] as const) {
          yield* sql`INSERT INTO played (player_id, game, ms, seen_at) VALUES (${member}, ${game}, ${ms}, ${began})`;
        }
        // Since then the member was in town 40 minutes, in a camp 5 and at the table 1 (less than its
        // calls); and in town before then, which counts for nothing. The stayer came to town half an
        // hour before then, and is there still, two hours after.
        const [session] = yield* sql<{ id: number }>`
          INSERT INTO sessions (player_id, guest, started_at) VALUES (${member}, 0, ${began}) RETURNING id
        `;
        for (const [player, place, from, minutes, open] of [
          [member, "town", began - 60 * MINUTE, 30, false],
          [member, "town", began + MINUTE, 40, false],
          [member, "camp", began + 50 * MINUTE, 5, false],
          [member, "table", began + 60 * MINUTE, 1, false],
          [stayer, "town", began - 30 * MINUTE, 150, true],
        ] as const) {
          const to = from + minutes * MINUTE;
          yield* sql`
            INSERT INTO visits (session_id, player_id, guest, place, source, entered_at, heard_at, instance, left_at, seconds)
            VALUES (${session?.id ?? 0}, ${player}, 0, ${place}, 'call', ${from}, ${to}, 'old', ${open ? null : to}, ${minutes * 60})
          `;
        }
      }),
    );
    expect(
      await query(
        path,
        (sql) => sql`SELECT player_id AS player, game, played_ms AS played, afk_ms AS afk FROM time_in ORDER BY 1, 2`,
      ),
    ).toEqual([
      { player: member, game: "raid", played: 2 * MINUTE, afk: 0 },
      { player: member, game: "town", played: 15 * MINUTE, afk: 30 * MINUTE },
      { player: stayer, game: "town", played: 0, afk: 120 * MINUTE },
    ]);
    expect(await query(path, (sql) => sql`SELECT name FROM sqlite_master WHERE name = 'played'`)).toEqual([]);
  });

  it("has each yard due a tend two minutes after it was last written, and no state of another game ever", async () => {
    const path = join(directory, "leaf.db");
    const member = "00000000-0000-4000-8000-00000000000a";
    const written = Date.UTC(2026, 10, 23, 20);
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Back to before migration 32, with a yard and a camp stored.
        yield* beforePlayDue(sql);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 32`;
        for (const game of ["works", "town"]) {
          yield* sql`INSERT INTO play_state (player_id, game, rev, state, updated_at) VALUES (${member}, ${game}, 3, '{}', ${written})`;
        }
      }),
    );
    expect(await query(path, (sql) => sql`SELECT game, due_at AS due FROM play_state ORDER BY game`)).toEqual([
      { game: "town", due: null },
      { game: "works", due: written + 120_000 },
    ]);
  });

  it("keeps whether each player's character stays from their presence row, and yes for one with none", async () => {
    const path = join(directory, "leaf.db");
    const [stays, goes, unsaid] = ["a", "b", "c"].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Back to before migration 33: two players with presence rows, one without.
        yield* beforeAboutFromVisits(sql);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 33`;
        for (const [player, stay] of [
          [stays, 1],
          [goes, 0],
          [unsaid, null],
        ] as const) {
          yield* sql`
            INSERT INTO players_seen (player_id, name, guest, first_seen_at, last_seen_at) VALUES (${player}, 'P', 0, 1, 1)
          `;
          if (stay !== null)
            yield* sql`
              INSERT INTO presence (player_id, username, place, seen_at, stay, guest) VALUES (${player}, 'P', 'town', 1, ${stay}, 0)
            `;
        }
      }),
    );
    expect(await query(path, (sql) => sql`SELECT player_id AS player, stay FROM players_seen ORDER BY 1`)).toEqual([
      { player: stays, stay: 1 },
      { player: goes, stay: 0 },
      { player: unsaid, stay: 1 },
    ]);
  });

  it("keeps each player's newest visit, and whether they stay, from the visits they had", async () => {
    const path = join(directory, "leaf.db");
    const [alice2, bob2, carol2] = ["a", "b", "c"].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Back to before migration 37: Alice in town now after a camp, Bob gone who would rather not stay, Carol never seen.
        yield* beforeLastVisits(sql);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 37`;
        yield* sql`INSERT INTO sessions (id, player_id, guest, started_at) VALUES (1, ${alice2}, 0, 1), (2, ${bob2}, 1, 1)`;
        yield* sql`
          INSERT INTO visits (session_id, player_id, guest, place, source, entered_at, heard_at, left_at, instance)
          VALUES (1, ${alice2}, 0, 'camp', 'call', 1, 5, 6, 'old'), (2, ${bob2}, 1, 'works', 'room', 2, 7, 9, 'old'),
                 (1, ${alice2}, 0, 'town', 'room', 6, 8, NULL, 'old')
        `;
        yield* sql`
          INSERT INTO players_seen (player_id, name, guest, first_seen_at, last_seen_at, stay)
          VALUES (${alice2}, 'A', 0, 1, 1, 1), (${bob2}, 'B', 1, 1, 1, 0), (${carol2}, 'C', 0, 1, 1, 1)
        `;
      }),
    );
    expect(
      await query(
        path,
        (sql) => sql`SELECT player_id, place, guest, heard_at, left_at, stay FROM last_visits ORDER BY 1`,
      ),
    ).toEqual([
      { player_id: alice2, place: "town", guest: 0, heard_at: 8, left_at: null, stay: 1 },
      { player_id: bob2, place: "works", guest: 1, heard_at: 7, left_at: 9, stay: 0 },
    ]);
  });

  it("keeps whose camp a visit to a camp is in, on its player's newest visit too, and none on visits from before", async () => {
    const path = join(directory, "leaf.db");
    const [alice2, bob2] = ["a", "b"].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Back to before migration 38: Alice at a camp, whose not kept.
        yield* beforeVisitCamps(sql);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 38`;
        yield* sql`INSERT INTO sessions (id, player_id, guest, started_at) VALUES (1, ${alice2}, 0, 1), (2, ${bob2}, 0, 1)`;
        yield* sql`
          INSERT INTO visits (session_id, player_id, guest, place, source, entered_at, heard_at, instance)
          VALUES (1, ${alice2}, 0, 'camp', 'call', 1, 5, 'old')
        `;
      }),
    );
    const refused = await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Bob at Alice's camp, heard of again, and then gone.
        yield* sql`
          INSERT INTO visits (session_id, player_id, guest, place, camp_owner, source, entered_at, heard_at, instance)
          VALUES (2, ${bob2}, 0, 'camp', ${alice2}, 'call', 6, 6, 'new')
        `;
        yield* sql`UPDATE visits SET heard_at = 7, left_at = 8 WHERE player_id = ${bob2}`;
        // Whose camp, anywhere but at a camp, is refused.
        return yield* Effect.flip(
          sql`
            INSERT INTO visits (session_id, player_id, guest, place, camp_owner, source, entered_at, heard_at, instance)
            VALUES (2, ${bob2}, 0, 'town', ${alice2}, 'call', 9, 9, 'new')
          `,
        );
      }),
    );

    expect(Bun.inspect(refused)).toContain("CHECK constraint failed");
    expect(
      await query(
        path,
        (sql) => sql`SELECT player_id, place, camp_owner, heard_at, left_at FROM last_visits ORDER BY 1`,
      ),
    ).toEqual([
      { player_id: alice2, place: "camp", camp_owner: null, heard_at: 5, left_at: null },
      { player_id: bob2, place: "camp", camp_owner: alice2, heard_at: 7, left_at: 8 },
    ]);
  });

  it("has each yard and table standing still due once, for Leaf to write its postcard, and no other state", async () => {
    const path = join(directory, "leaf.db");
    const [still, running] = ["a", "b"].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
    const migrated = Date.now();
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Back to before migration 39: a yard standing still, a yard due a tend, a table and a camp.
        yield* beforePlayPostcards(sql);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 39`;
        yield* sql`
          INSERT INTO play_state (player_id, game, rev, state, updated_at, due_at) VALUES
            (${still}, 'works', 3, '{}', 1, NULL), (${running}, 'works', 3, '{}', 1, 5),
            (${still}, 'raid', 3, '{}', 1, NULL), (${still}, 'town', 3, '{}', 1, NULL)
        `;
      }),
    );
    expect(
      await query(
        path,
        (sql) => sql`
          SELECT game, CASE WHEN due_at >= ${migrated} THEN 'now' ELSE due_at END AS due
          FROM play_state ORDER BY game, player_id
        `,
      ),
    ).toEqual([
      { game: "raid", due: "now" },
      { game: "town", due: null },
      { game: "works", due: "now" },
      { game: "works", due: 5 },
    ]);
    expect(await query(path, (sql) => sql`SELECT * FROM play_postcards`)).toEqual([]);
  });

  it("has each state stand as of its rev, but each Little Raid table written since it was made, which is worked out again", async () => {
    const path = join(directory, "leaf.db");
    const [a, b] = ["a", "b"].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Back to before migration 42: a table written, one never written, a yard and a camp.
        yield* beforePlayStood(sql);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 42`;
        yield* sql`
          INSERT INTO play_state (player_id, game, rev, state, updated_at) VALUES
            (${a}, 'raid', 3, '{}', 1), (${b}, 'raid', 0, '{}', 1), (${a}, 'works', 5, '{}', 1), (${a}, 'town', 2, '{}', 1)
        `;
      }),
    );
    expect(
      await query(
        path,
        (sql) => sql`SELECT game, rev, stood FROM play_state WHERE stood IS NOT rev ORDER BY game, player_id`,
      ),
    ).toEqual([{ game: "raid", rev: 3, stood: null }]);
    expect(
      await query(
        path,
        (sql) => sql`SELECT game, rev, stood FROM play_state WHERE stood IS rev ORDER BY game, player_id`,
      ),
    ).toEqual([
      { game: "raid", rev: 0, stood: 0 },
      { game: "town", rev: 2, stood: 2 },
      { game: "works", rev: 5, stood: 5 },
    ]);
  });

  it("gives each player who has pulled already an award for every further copy of a prize, up to the seventh, as the game awards them", async () => {
    const path = join(directory, "leaf.db");
    const pulled = "00000000-0000-4000-8000-00000000000a";
    const opened = "00000000-0000-4000-8000-00000000000b";
    const raided = "00000000-0000-4000-8000-00000000000c";
    const guest = "00000000-0000-4000-8000-00000000000d";
    const ctx: Ctx = {
      now: Date.UTC(2026, 10, 26),
      player: { id: alice, guest: false },
      seed: 7,
      room: 0,
      awards: [],
      postcards: {},
    };
    const have = { "figure:greg": 3, "figure:worm": 1, "figure:slug": 9, "thing:rock": 2 };
    // With a ware of the Treasury's, retired: let go of as the game reads the state.
    const state = PULLS.encode({ ...PULLS.create(ctx), have: { ...have, "ware:jar": 4 } });
    expect(copies(state)).toHaveLength(2 + 6 + 1);
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Back to before migration 44: a member who has pulled (one award for a copy kept already), one
        // who has only opened the pulls, one who has only played the raid, and a guest who has pulled.
        yield* beforeRaidFights(sql);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 44`;
        yield* sql`DELETE FROM awards`;
        yield* sql`INSERT INTO awards (player_id, id, at) VALUES (${pulled}, 'copies:figure:greg:2', 1), (${pulled}, 'pull:figure:greg', 1)`;
        for (const [player, game, text, isGuest] of [
          [pulled, "pulls", state, 0],
          [opened, "pulls", PULLS.encode(PULLS.create(ctx)), 0],
          [raided, "raid", "{}", 0],
          [guest, "pulls", state, 1],
        ] as const) {
          yield* sql`
            INSERT INTO play_state (player_id, game, rev, state, updated_at, guest)
            VALUES (${player}, ${game}, 1, ${text}, 5, ${isGuest})
          `;
        }
      }),
    );
    // The one kept already keeps when it was first won; a player who has pulled nothing is given none.
    const given = (player: string) =>
      copies(state).map((id) => ({ player, id, at: player === pulled && id === "copies:figure:greg:2" ? 1 : 5 }));
    expect(
      await query(
        path,
        (sql) => sql`SELECT player_id AS player, id, at FROM awards WHERE id LIKE 'copies:%' ORDER BY player_id, id`,
      ),
    ).toEqual([...given(pulled), ...given(guest)]);
  });

  it("rewrites no raid fight kept before it, nor one an older Leaf writes after: each is read as its way and its moment say, with no setup", async () => {
    const path = join(directory, "leaf.db");
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* beforeFightsWay(sql);
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 47`;
        for (const [n, way] of ["main", "own"].entries()) yield* insertFight(sql, FOUGHT_AT + n, way);
      }),
    );
    // After it, an older Leaf still writing during a deploy writes as it always did.
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [n, way] of ["wilds", "deep"].entries()) yield* insertFight(sql, LATER + n, way);
      }),
    );
    expect(await query(path, (sql) => sql`SELECT way, course, pool, era, setup FROM raid_fights ORDER BY at`)).toEqual(
      ["main", "own", "wilds", "deep"].map((way) => ({ way, course: null, pool: null, era: null, setup: null })),
    );
    const lines = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ line: Schema.String })))(
      await query(path, fightLines),
    );
    const read = lines.map(({ line }) => rowOf(line)?.fight);
    // Each of the era live when it was written: the later two of the release that opened between.
    expect(Number(eraAt(LATER))).toBe(eraAt(FOUGHT_AT) + 1);
    expect(read.map((f) => f && [f.way, f.course, f.trail, f.pool, f.era, f.setup])).toEqual([
      ["main", "trail", 2, "fair", eraAt(FOUGHT_AT), null],
      ["own", "trail", 0, "own", eraAt(FOUGHT_AT), null],
      ["wilds", "wilds", 0, "fair", eraAt(LATER), null],
      ["deep", "deep", 0, "fair", eraAt(LATER), null],
    ]);
  });

  it("exports the fights of a copy kept before the later columns, as the fight report reads a backup: those read as null", async () => {
    const path = join(directory, "leaf.db");
    await onFile(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* beforeFightsWay(sql);
        for (const [n, way] of ["main", "own"].entries()) yield* insertFight(sql, FOUGHT_AT + n, way);
      }),
    );
    // Opened as the report opens a copy: read-only, nothing migrated.
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const has = yield* fightColumns(sql);
        expect(["course", "pool", "era", "setup"].filter((c) => has.has(c))).toEqual([]);
        return Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ line: Schema.String })))(
          yield* fightLines(sql, has),
        );
      }).pipe(Effect.provide(SqliteClient.layer({ filename: path, readonly: true }))),
    );
    expect(lines.map(({ line }) => rowOf(line)?.fight).map((f) => f && [f.way, f.course, f.pool, f.setup])).toEqual([
      ["main", "trail", "fair", null],
      ["own", "trail", "own", null],
    ]);
  });

  it("enforces foreign keys, which SQLite leaves off unless asked", async () => {
    expect(await query(join(directory, "leaf.db"), (sql) => sql`PRAGMA foreign_keys`)).toEqual([{ foreign_keys: 1 }]);
  });

  it("refuses an entry that reverses one that does not exist", async () => {
    const refused = await rejection(
      query(
        join(directory, "leaf.db"),
        (sql) => sql`
          INSERT INTO ledger_entries
            (player_id, kind, balance_delta, xp_delta, origin, idempotency_key, reverses_id, created_at)
          VALUES (${alice}, 'reversal', -5, -5, 'raid', 'undo', 999, 1)
        `,
      ),
    );

    expect(Bun.inspect(refused)).toContain("reversal_mismatch");
  });
});
