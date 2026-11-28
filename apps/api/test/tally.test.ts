import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { leaf, LOGGED, type PlayerId, playerId, TALLY_BOARDS } from "@sequoia-leaf/core";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Visits } from "../src/activity/visits.ts";
import { PlayStore } from "../src/play/store.ts";
import { SOURCES, Tallies, tally } from "../src/tally/store.ts";
import { asPage, DAY, fakeBackend, HOUR, MINUTE, sessionOf, testLeaf } from "./support.ts";

const alice = playerId("10000000-0000-0000-0000-000000000001");
const bob = playerId("10000000-0000-0000-0000-000000000002");
const carol = playerId("10000000-0000-0000-0000-000000000003");
const dave = playerId("10000000-0000-0000-0000-000000000004");
/** Wednesday 25 November 2026, 12:00 UTC: its week began on Monday the 23rd. */
const T0 = Date.UTC(2026, 10, 25, 12);
const MONDAY = Date.UTC(2026, 10, 23);
const LAST_WEEK = MONDAY - 2 * DAY;

const clock = { now: T0 };
let services: ReturnType<typeof testLeaf>;
let app: ReturnType<(typeof services)["app"]>;

beforeEach(async () => {
  clock.now = T0;
  const fake = fakeBackend({
    "alice-token": () => Response.json(sessionOf(alice, "Alice", "CAPTAIN")),
    "bob-token": () => Response.json(sessionOf(bob, "Bob", "RECRUIT")),
    // Not in the guild: a guest.
    "carol-token": () => Response.json(sessionOf(carol, "Carol", null)),
  });
  services = testLeaf(clock, fake.fetcher);
  app = services.app();
  await services.query(
    (sql) => sql`
      INSERT INTO player_names (player_id, username, updated_at, asked_at)
      VALUES (${alice}, 'Alice', ${T0}, ${T0}), (${bob}, 'Bob', ${T0}, ${T0}), (${carol}, 'Carol', ${T0}, ${T0}),
             (${dave}, 'Dave', ${T0}, ${T0})
    `,
  );
});

afterEach(async () => {
  await app.dispose();
  await services.dispose();
});

const Shown = Schema.Struct({
  board: Schema.String,
  period: Schema.String,
  from: Schema.NullOr(Schema.String),
  top: Schema.Array(
    Schema.Struct({
      place: Schema.Number,
      id: Schema.String,
      name: Schema.String,
      guest: Schema.Boolean,
      score: Schema.Number,
      you: Schema.Boolean,
    }),
  ),
  you: Schema.NullOr(Schema.Struct({ place: Schema.Number, score: Schema.Number })),
});

/** A board as `who` is shown it. */
async function board(id: string, period: "week" | "all", who = "alice") {
  const response = await app.request(`/v1/game/tally/${id}/${period}`, {
    headers: { Authorization: `Bearer ${who}-token` },
  });
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(Shown)(await response.json());
}

/** Who is on a board and with what, in order: `name place score`. */
async function rows(id: string, period: "week" | "all", who = "alice") {
  return (await board(id, period, who)).top.map((r) => `${r.name} ${r.place} ${r.score}`);
}

let activityId = 0;
/** A raid or war the credit feed recorded. */
const activity = (
  player: PlayerId,
  kind: "raid" | "war",
  at: number,
  more: { raid?: string; rating?: number; claim?: 0 | 1 } = {},
) =>
  services.query(
    (sql) => sql`
      INSERT INTO activities (source_key, player_id, kind, raid, detail, season_rating, occurred_at, recorded_at, in_claim)
      VALUES (${`${kind}:${++activityId}:${player}`}, ${player}, ${kind}, ${more.raid ?? null}, 'Somewhere',
              ${more.rating ?? 100}, ${at}, ${at}, ${more.claim ?? null})
    `,
  );

/** Does `f` with each of `items` in turn, each once the one before has been done. */
const inTurn = <A>(items: readonly A[], f: (item: A) => Promise<unknown>): Promise<unknown> =>
  items.reduce<Promise<unknown>>((before, item) => before.then(() => f(item)), Promise.resolve());

/** What the games log, as the play service has it logged for a player. */
const log = (
  player: PlayerId,
  game: string,
  kinds: readonly (readonly [string, Record<string, unknown>])[],
  at: number,
) =>
  services.run(
    PlayStore.use((store) =>
      store.log(
        player,
        game,
        kinds.map(([kind, data]) => ({ kind, data })),
        at,
      ),
    ),
  );

/** A batch of Carol's commands to her town; what Leaf answers. */
async function carolsTown(commands: readonly Record<string, unknown>[]) {
  const response = await app.request("/v1/game/play/town", {
    method: "POST",
    headers: { Authorization: "Bearer carol-token", "Content-Type": "application/json" },
    body: JSON.stringify(asPage("/v1/game/play/town", { player: carol, commands })),
  });
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(
    Schema.Struct({ results: Schema.Array(Schema.Unknown), state: Schema.Struct({ visit: Schema.Unknown }) }),
  )(await response.json());
}

/** Something Alice does in a live room, as the room tells the Tally. */
const act = (kind: string, arg: string, at: number) => services.run(Tallies.use((t) => t.acted(alice, kind, arg, at)));

/** `who` reads `whose` camp at `at`, as their page does every half minute while there. */
async function look(who: string, whose: PlayerId, at: number) {
  clock.now = at;
  const response = await app.request(`/v1/game/play/town/of/${whose}`, {
    headers: { Authorization: `Bearer ${who}-token` },
  });
  expect(response.status).toBe(200);
}

/** Asks for a board that is not, and is told so. */
async function notKept(path: string) {
  const response = await app.request(path, { headers: { Authorization: "Bearer alice-token" } });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "no_such_board" });
}

/** Runs something against Leaf's own database, as the counters' writers do. */
const withSql = <A>(f: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  services.run(Effect.orDie(SqlClient.SqlClient.use(f)));

describe("the Tally's boards", () => {
  it("each have their numbers from Leaf", () => {
    expect(TALLY_BOARDS.map((b) => b.id).toSorted()).toEqual(Object.keys(SOURCES).toSorted());
  });

  it("are not kept for a board there is not, nor a week for a board that is all time only", async () => {
    await inTurn(["/v1/game/tally/pulls/all", "/v1/game/tally/raids/day", "/v1/game/tally/level/week"], notKept);
  });
});

describe("the guild's boards", () => {
  it("count raids, each raid, wars and defences, for the week and all time, a tie sharing a place", async () => {
    await activity(alice, "raid", T0 - HOUR, { raid: "nol" });
    await activity(alice, "raid", T0 - 2 * HOUR, { raid: "nol" });
    await activity(alice, "raid", LAST_WEEK, { raid: "tna" });
    await activity(bob, "raid", T0 - 3 * HOUR, { raid: "nol" });
    await activity(bob, "raid", T0 - 30 * MINUTE, { raid: "tna" });
    await activity(bob, "war", T0 - HOUR, { claim: 1, rating: 60 });
    await activity(bob, "war", T0 - HOUR, { claim: 0, rating: 40 });
    await activity(dave, "war", LAST_WEEK, { claim: 1 });

    // Alice reached her two this week before Bob reached his.
    expect(await rows("raids", "week")).toEqual(["Alice 1 2", "Bob 1 2"]);
    expect(await rows("raids", "all")).toEqual(["Alice 1 3", "Bob 2 2"]);
    expect(await rows("raid-nol", "all")).toEqual(["Alice 1 2", "Bob 2 1"]);
    expect(await rows("raid-tna", "week")).toEqual(["Bob 1 1"]);
    expect(await rows("wars", "all")).toEqual(["Bob 1 2", "Dave 2 1"]);
    expect(await rows("defences", "week")).toEqual(["Bob 1 1"]);
    expect(await rows("rating", "week")).toEqual(["Bob 1 300", "Alice 2 200"]);
    const week = await board("raids", "week");
    expect(week.from).toBe(new Date(MONDAY).toISOString());
    expect(week.top[0]).toMatchObject({ you: true, guest: false });
    expect(week.you).toEqual({ place: 1, score: 2 });
  });

  it("count the quests finished", async () => {
    let sequence = 0;
    const quest = (player: PlayerId, completedAt: number | null) =>
      services.query(
        (sql) => sql`
          INSERT INTO quests (player_id, slot, sequence, template_id, objective_type, target, reward_leaf, reward_xp,
                              progress, started_at, completed_at)
          VALUES (${player}, 'daily', ${++sequence}, 'd', 'raids', 1, 10, 10, ${completedAt === null ? 0 : 1},
                  ${LAST_WEEK - DAY}, ${completedAt})
        `,
      );
    await quest(alice, T0 - HOUR);
    await quest(alice, LAST_WEEK);
    await quest(bob, T0 - 2 * HOUR);
    await quest(bob, null);
    expect(await rows("quests", "all")).toEqual(["Alice 1 2", "Bob 2 1"]);
    expect(await rows("quests", "week")).toEqual(["Bob 1 1", "Alice 1 1"]);
  });

  it("count the Leaf earned, but not the staff's grants, what was spent or what was taken back", async () => {
    const raidPay = await services.post(
      { kind: "earn", playerId: alice, amount: leaf(500), source: "raid", idempotencyKey: "raid:1" },
      LAST_WEEK,
    );
    await services.post(
      { kind: "earn", playerId: alice, amount: leaf(80), source: "quest", idempotencyKey: "quest:1" },
      T0 - HOUR,
    );
    await services.post(
      { kind: "earn", playerId: alice, amount: leaf(5000), source: "staff", idempotencyKey: "staff:1" },
      T0 - HOUR,
    );
    await services.post(
      { kind: "spend", playerId: alice, amount: leaf(300), sink: "shop", idempotencyKey: "shop:1" },
      T0 - HOUR,
    );
    await services.post(
      { kind: "earn", playerId: bob, amount: leaf(200), source: "war", idempotencyKey: "war:1" },
      T0 - HOUR,
    );
    expect(raidPay.status).toBe("posted");
    if (raidPay.status === "posted") {
      await services.post(
        { kind: "reversal", playerId: alice, reverses: raidPay.entry, idempotencyKey: "raid:1:back" },
        T0 - 30 * MINUTE,
      );
    }
    expect(await rows("leaf", "all")).toEqual(["Bob 1 200", "Alice 2 80"]);
    expect(await rows("leaf", "week")).toEqual(["Bob 1 200"]);
  });

  it("rank SEQ levels by level, more XP first within one, and count milestones", async () => {
    await services.post(
      { kind: "earn", playerId: alice, amount: leaf(10), xp: 1100, source: "achievement", idempotencyKey: "a:1" },
      T0 - HOUR,
    );
    await services.post(
      { kind: "earn", playerId: bob, amount: leaf(10), xp: 1900, source: "achievement", idempotencyKey: "a:2" },
      LAST_WEEK,
    );
    await services.post(
      { kind: "earn", playerId: bob, amount: leaf(10), xp: 0, source: "achievement", idempotencyKey: "a:3" },
      T0 - HOUR,
    );
    await services.post(
      { kind: "earn", playerId: dave, amount: leaf(10), xp: 300, source: "raid", idempotencyKey: "r:1" },
      T0 - HOUR,
    );
    expect(await rows("level", "all")).toEqual(["Bob 1 2", "Alice 1 2", "Dave 3 1"]);
    expect(await rows("milestones", "all")).toEqual(["Bob 1 2", "Alice 2 1"]);
    expect(await rows("milestones", "week")).toEqual(["Alice 1 1", "Bob 1 1"]);
  });
});

describe("the boards of where the games stand", () => {
  it("rank yards by the Coins they earned and by tier, and the raid by bosses beaten, guests marked", async () => {
    await services.query(
      (sql) =>
        sql`INSERT INTO players_seen (player_id, name, guest, first_seen_at, last_seen_at) VALUES (${carol}, 'Carol', 1, ${T0}, ${T0})`,
    );
    // Each score reached as long before now as it is big, so a tie goes to the bigger yard.
    await services.query(
      (sql) => sql`
        INSERT INTO standings (player_id, game, score, also, guest, updated_at) VALUES
          (${alice}, 'works', 1840, '{"tier":1}', 0, ${T0 - 1840}),
          (${bob}, 'works', 5120, '{"tier":2}', 0, ${T0 - 5120}),
          (${carol}, 'works', 960, '{"tier":2}', 1, ${T0 - 960}),
          (${dave}, 'works', 0, '{"tier":0}', 0, ${T0}),
          (${alice}, 'raid', 3, '{"runs":9,"room":8}', 0, ${T0})
      `,
    );
    expect(await rows("yards", "all")).toEqual(["Bob 1 5120", "Alice 2 1840", "Carol 3 960"]);
    expect(await rows("tier", "all")).toEqual(["Bob 1 2", "Carol 1 2", "Alice 3 1"]);
    expect((await board("tier", "all")).top.map((r) => r.guest)).toEqual([false, true, false]);
    expect(await rows("bosses", "all")).toEqual(["Alice 1 3"]);
  });
});

describe("the counters", () => {
  it("count what the games log, in the call that logs it, for the week and all time", async () => {
    await log(
      alice,
      "raid",
      [
        [LOGGED.raidRoom, { tallied: true }],
        [LOGGED.raidRoom, { tallied: true }],
        [LOGGED.raidEnded, { ended: "won", tallied: true }],
      ],
      LAST_WEEK,
    );
    await log(
      alice,
      "raid",
      [
        [LOGGED.raidRoom, { tallied: true }],
        [LOGGED.raidEnded, { ended: "lost", tallied: true }],
      ],
      T0 - HOUR,
    );
    await log(
      bob,
      "works",
      [
        [LOGGED.worksOrder, {}],
        [LOGGED.worksPlot, {}],
      ],
      T0 - HOUR,
    );
    expect(await rows("rooms", "all")).toEqual(["Alice 1 3"]);
    expect(await rows("rooms", "week")).toEqual(["Alice 1 1"]);
    expect(await rows("runs-won", "all")).toEqual(["Alice 1 1"]);
    expect(await rows("runs-won", "week")).toEqual([]);
    expect(await rows("orders", "week")).toEqual(["Bob 1 1"]);
  });

  it("count the crab spotted and callers greeted in a town, as Leaf does the commands", async () => {
    await carolsTown([{ id: "c-1", do: "spotCrab" }]);
    // Once a hiding place: the same 60 seconds counts nothing more.
    await carolsTown([{ id: "c-2", do: "spotCrab" }]);
    clock.now += 2 * MINUTE;
    const later = await carolsTown([{ id: "c-3", do: "spotCrab" }]);
    const visit = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number }))(later.state.visit);
    await carolsTown([{ id: "c-4", do: "greet", visit: visit.id }]);
    expect(await rows("crab", "week", "carol")).toEqual(["Carol 1 2"]);
    expect(await rows("greeted", "all", "carol")).toEqual(["Carol 1 1"]);
  });

  it("count the time in each game from visits, as a person's card counts it", async () => {
    // She does something as she comes, and nothing after.
    await services.run(Visits.use((v) => v.acted(alice, T0)));
    // Her page says where she is each minute, as time passes: four at the Works, then town.
    await inTurn(
      Array.from({ length: 11 }, (_, i) => T0 + i * MINUTE),
      (at) => {
        clock.now = at;
        return app.request("/v1/game/presence", {
          method: "PUT",
          headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
          body: JSON.stringify({ place: at < T0 + 4 * MINUTE ? "works" : "town" }),
        });
      },
    );
    expect(await rows("works-time", "week")).toEqual(["Alice 1 240"]);
    // Nothing done since she came: from five minutes on, she is AFK in town.
    expect(await rows("town-time", "all")).toEqual(["Alice 1 60"]);
    expect(await rows("dozing", "week")).toEqual(["Alice 1 300"]);
  });

  it("count an act in a live room at most once in its time for each counter", async () => {
    // A script sending a log on the fire and a wave each second, for a minute.
    await inTurn(
      Array.from({ length: 60 }, (_, s) => T0 + s * 1000),
      (at) => act("touch", "fire:256,211", at).then(() => act("emote", "wave", at)),
    );
    await act("touch", "roll", T0);
    await act("emote", "cheer", T0);
    expect(await rows("taps", "week")).toEqual(["Alice 1 12"]);
    expect(await rows("logs", "all")).toEqual(["Alice 1 12"]);
    expect(await rows("waves", "all")).toEqual(["Alice 1 2"]);
    expect(await rows("rolls", "all")).toEqual(["Alice 1 1"]);
  });

  it("start the week again on Monday, keeping all time; a count from an earlier week, come late, adds to all time only", async () => {
    await withSql((sql) => tally(sql, bob, "waves", 4, LAST_WEEK));
    await withSql((sql) => tally(sql, bob, "waves", 1, T0 - HOUR));
    await withSql((sql) => tally(sql, bob, "waves", 2, LAST_WEEK));
    expect(await rows("waves", "week")).toEqual(["Bob 1 1"]);
    expect(await rows("waves", "all")).toEqual(["Bob 1 7"]);
  });
});

describe("visits to camps", () => {
  it("count a stay of 30 seconds, once a camp, by whoever stayed and whoever's camp it was", async () => {
    // Their camps made.
    await inTurn(["bob", "carol"], (who) =>
      app.request("/v1/game/play/town", { headers: { Authorization: `Bearer ${who}-token` } }),
    );
    // Alice stays in Bob's camp a minute, and goes back the next day; she looks in on Carol's for
    // under 30 seconds, then Carol's again after Bob's, and neither is a stay. Carol stays in Bob's,
    // and Bob's own reading of his camp counts nothing.
    await inTurn(
      [
        ["alice", bob, 0],
        ["alice", bob, 30_000],
        ["alice", bob, 60_000],
        ["alice", bob, DAY],
        ["alice", bob, DAY + 30_000],
        ["alice", carol, DAY + 40_000],
        ["alice", bob, DAY + 60_000],
        ["alice", carol, DAY + 90_000],
        ["carol", bob, 2 * DAY],
        ["bob", bob, 2 * DAY],
        ["carol", bob, 2 * DAY + 30_000],
        ["bob", bob, 2 * DAY + 30_000],
      ] as const,
      ([who, whose, at]) => look(who, whose, T0 + at),
    );
    expect(await rows("camps", "all")).toEqual(["Alice 1 1", "Carol 1 1"]);
    expect(await rows("visitors", "week")).toEqual(["Bob 1 2"]);
  });
});

describe("a board worked out", () => {
  it("is kept a minute, and worked out again after it", async () => {
    await activity(bob, "raid", T0 - HOUR);
    expect(await rows("raids", "week")).toEqual(["Bob 1 1"]);
    await activity(alice, "raid", T0 - HOUR);
    await activity(alice, "raid", T0 - HOUR);
    clock.now = T0 + 59_000;
    expect(await rows("raids", "week")).toEqual(["Bob 1 1"]);
    clock.now = T0 + 61_000;
    expect(await rows("raids", "week")).toEqual(["Alice 1 2", "Bob 2 1"]);
    // The caller off the top is given their own place.
    expect((await board("raids", "week", "carol")).you).toBeNull();
    expect((await board("raids", "week", "bob")).you).toEqual({ place: 2, score: 1 });
  });

  it("lists the top ten, and anybody's own place below them", async () => {
    const many = Array.from({ length: 12 }, (_, i) => playerId(`20000000-0000-0000-0000-0000000000${10 + i}`));
    await withSql((sql) =>
      Effect.forEach(many.entries(), ([i, player]) => tally(sql, player, "taps", 20 - i, T0 - HOUR), { discard: true }),
    );
    await withSql((sql) => tally(sql, alice, "taps", 1, T0 - HOUR));
    const shown = await board("taps", "all");
    expect(shown.top.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(shown.top.map((r) => r.name)).toContain("Someone");
    expect(shown.you).toEqual({ place: 13, score: 1 });
  });
});

describe("the counters' first counts", () => {
  it("come from what Leaf had: the raid's and the Works' logs, where camps stand, and time in each game", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leaf-tally-"));
    const file = join(dir, "leaf.db");
    try {
      const before = testLeaf(clock, fakeBackend().fetcher, { databasePath: file });
      await before.query(
        (sql) => sql`
          INSERT INTO activity (player_id, at, game, kind, data) VALUES
            (${alice}, ${T0 - HOUR}, 'raid', 'raid_room', '{}'),
            (${alice}, ${LAST_WEEK}, 'raid', 'raid_room', '{}'),
            (${alice}, ${LAST_WEEK}, 'raid', 'raid_ended', '{"ended":"won"}'),
            (${alice}, ${LAST_WEEK}, 'raid', 'raid_ended', '{"ended":"left"}'),
            (${bob}, ${T0 - HOUR}, 'works', 'works_order', '{}')
        `,
      );
      await before.query(
        (sql) => sql`
          INSERT INTO standings (player_id, game, score, also, guest, updated_at)
          VALUES (${carol}, 'town', 12, '{"greeted":4,"sightings":9}', 1, ${T0})
        `,
      );
      await before.query(
        (sql) => sql`INSERT INTO time_in (player_id, game, played_ms, afk_ms) VALUES (${bob}, 'town', 7200000, 60000)`,
      );
      // Leaf as it was before the Tally: the counters' migration, and those after it, not yet run.
      await before.query(
        (sql) => sql`
          CREATE TABLE presence (
            player_id TEXT PRIMARY KEY, username TEXT NOT NULL, place TEXT NOT NULL, seen_at INTEGER NOT NULL,
            stay INTEGER NOT NULL DEFAULT 1, guest INTEGER NOT NULL DEFAULT 0, left_at INTEGER
          ) STRICT
        `,
      );
      for (const trigger of [
        "visits_opened",
        "visits_heard",
        "visits_removed",
        "players_seen_stay",
        "players_seen_first",
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one after another
        await before.query((sql) => sql`DROP TRIGGER ${sql(trigger)}`);
      }
      await before.query((sql) => sql`DROP TABLE last_visits`);
      for (const table of [
        "banner_called",
        "raid_sitting_calls",
        "raid_sitting_seats",
        "raid_sitting_places",
        "raid_sittings",
        "raid_fights",
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one after another
        await before.query((sql) => sql`DROP TABLE ${sql(table)}`);
      }
      await before.query((sql) => sql`DROP INDEX play_kept_slot`);
      await before.query((sql) => sql`DROP INDEX play_state_unstood`);
      await before.query((sql) => sql`ALTER TABLE play_state DROP COLUMN stood`);
      await before.query((sql) => sql`DROP TABLE sign_ins`);
      await before.query((sql) => sql`DROP TABLE merges`);
      await before.query((sql) => sql`DROP TABLE logins`);
      await before.query((sql) => sql`DROP TABLE leaf_ids`);
      await before.query((sql) => sql`DROP TABLE play_postcards`);
      await before.query((sql) => sql`ALTER TABLE visits DROP COLUMN camp_owner`);
      await before.query((sql) => sql`DROP INDEX visits_open_by_heard`);
      await before.query((sql) => sql`DROP TABLE level_checks`);
      await before.query((sql) => sql`ALTER TABLE players_seen DROP COLUMN stay`);
      await before.query((sql) => sql`DROP INDEX play_state_due`);
      await before.query((sql) => sql`ALTER TABLE play_state DROP COLUMN due_at`);
      await before.query((sql) => sql`ALTER TABLE play_state DROP COLUMN born`);
      await before.query((sql) => sql`DROP TABLE tallies`);
      await before.query((sql) => sql`DROP TABLE camp_visits`);
      await before.query((sql) => sql`DROP TABLE camp_likes`);
      await before.query((sql) => sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 30`);
      await before.dispose();
      const after = testLeaf(clock, fakeBackend().fetcher, { databasePath: file });
      const Tally = Schema.Struct({ playerId: Schema.String, stat: Schema.String, n: Schema.Number });
      const counted = Schema.decodeUnknownSync(Schema.Array(Tally))(
        await after.query((sql) => sql`SELECT player_id AS playerId, stat, n FROM tallies ORDER BY player_id, stat`),
      );
      await after.dispose();
      expect(counted.map((t) => `${t.playerId.slice(-1)} ${t.stat} ${t.n}`)).toEqual([
        "1 raid_rooms 2",
        "1 raid_wins 1",
        "2 afk:town 60000",
        "2 played:town 7200000",
        "2 works_orders 1",
        "3 crab 9",
        "3 greeted 4",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
