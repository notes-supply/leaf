import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { playerId } from "@sequoia-leaf/core";
import { CHAIRS } from "@sequoia-leaf/raid/sitting/sitting.ts";
import { Redacted, Schema } from "effect";

import { DISCORD_API } from "../src/config.ts";
import { discordOf, fakeBackend, type Fetcher, sessionOf, testLeaf } from "./support.ts";

/** Wednesday 25 November 2026, 12:00 UTC. */
const T0 = Date.UTC(2026, 10, 25, 12);
const ORIGIN = "https://leaf.seqwawa.com";
const CLIENT = "1576204968619417712";
/** Where Discord serves the raid in a call, proxying Leaf. */
const FRAME = `https://${CLIENT}.discordsays.com`;
const SECRET = "the-application-secret";
const BOT = "the-bot-token";
const alice = playerId("10000000-0000-0000-0000-000000000001");

/**
 * A stand-in Discord: codes it would take, each for an account, and the tokens they give; and its
 * launches of the raid, each with the Discord ids in it. With `down` it does not answer at all; with
 * `failing` it answers 500.
 */
interface Discord {
  codes: Record<string, { id: string; username: string }>;
  instances: Record<string, string[]>;
  down: boolean;
  failing: boolean;
  /** Seconds a 429 asks Leaf to wait, while Discord says Leaf has asked too much; 0 when it has not. */
  limited: number;
  /** The form of every code traded, as Discord got it. */
  readonly traded: URLSearchParams[];
  /** Every launch Leaf asked about, in order. */
  readonly asked: string[];
}

let discord: Discord;
/** Leaf's clock, set by hand. */
const clock = { now: T0 };
let leafs: ReturnType<typeof testLeaf>;
let app: ReturnType<(typeof leafs)["app"]>;

/** A launch as Discord answers for it, with the bot's token: who is in it, or 404 for one it does not know. */
function instanceAnswer(request: Request, instance: string): Response {
  if (request.headers.get("Authorization") !== `Bot ${BOT}`)
    return Response.json({ message: "401: Unauthorized" }, { status: 401 });
  discord.asked.push(instance);
  if (discord.limited > 0)
    return Response.json(
      { message: "You are being rate limited.", retry_after: discord.limited, global: false },
      { status: 429, headers: { "Retry-After": String(discord.limited) } },
    );
  const users = discord.instances[instance];
  return users === undefined
    ? Response.json({ message: "404: Not Found", code: 0 }, { status: 404 })
    : Response.json({
        application_id: CLIENT,
        instance_id: instance,
        launch_id: "1",
        location: { id: "gc-1-2", kind: "gc", channel_id: "2", guild_id: "1" },
        users,
      });
}

/** Discord's routes Leaf asks, around the backend's stand-in. */
function withDiscord(backend: Fetcher): Fetcher {
  return async (url, init) => {
    if (!url.startsWith(`${DISCORD_API}/`)) return backend(url, init);
    if (discord.down) throw new Error("Discord is down");
    if (discord.failing) return new Response("oh no", { status: 500 });
    const request = new Request(url, init);
    const path = url.slice(DISCORD_API.length);
    if (path === "/oauth2/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      discord.traded.push(form);
      const user = discord.codes[form.get("code") ?? ""];
      if (form.get("client_secret") !== SECRET || user === undefined)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      // Each code is used once.
      delete discord.codes[form.get("code") ?? ""];
      return Response.json({ access_token: `token-of-${user.id}`, token_type: "Bearer", expires_in: 604800 });
    }
    const instance = new RegExp(`^/applications/${CLIENT}/activity-instances/(.+)$`).exec(path)?.[1];
    if (instance !== undefined && request.method === "GET")
      return instanceAnswer(request, decodeURIComponent(instance));
    if (path === "/users/@me") {
      const id = /^Bearer token-of-(\d+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
      const user = Object.values(known).find((u) => u.id === id);
      return user === undefined
        ? Response.json({ message: "401: Unauthorized" }, { status: 401 })
        : Response.json({ ...user, discriminator: "0", global_name: null, avatar: null });
    }
    return new Response("not found", { status: 404 });
  };
}
/** Every account a code was made for, by id: who a token is. */
let known: Record<string, { id: string; username: string }>;

/** A code Discord would take, for a Discord account of its own (`n`), named `player<n>`. */
function codeFor(n: number, id = `2${String(n).padStart(17, "0")}`): string {
  const user = { id, username: `player${n}` };
  known[id] = user;
  discord.codes[`code-${n}`] = user;
  return `code-${n}`;
}

/** A Leaf with the Discord application (`activity`), and its bot's token (`bot`). */
function start(activity = true, bot = true) {
  discord = { codes: {}, instances: {}, down: false, failing: false, limited: 0, traded: [], asked: [] };
  known = {};
  clock.now = T0;
  const { fetcher } = fakeBackend({ "alice-token": () => Response.json(sessionOf(alice, "Alice")) });
  const botToken = bot ? Redacted.make(BOT) : undefined;
  leafs = testLeaf(
    clock,
    withDiscord(fetcher),
    activity ? { activity: { clientId: CLIENT, clientSecret: Redacted.make(SECRET), botToken, origin: FRAME } } : {},
  );
  app = leafs.app();
}
beforeEach(() => start());
afterEach(async () => {
  await app.dispose();
  await leafs.dispose();
});

/** The page in Discord's frame sending the code Discord gave it. */
const signIn = (code: unknown, origin = FRAME) =>
  app.request("/v1/activity/sign-in", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

/** The session's cookie a response sets: its value, and the whole line. */
function sessionCookie(response: Response): { value: string; line: string } {
  const line = response.headers.getSetCookie().find((l) => l.startsWith("__Host-leaf_session=")) ?? "";
  return { value: line.split(";")[0]?.split("=")[1] ?? "", line };
}

/** Signs in in Discord's frame with a code for account `n`: the session's token. */
async function signedIn(n: number, id?: string): Promise<string> {
  const response = await signIn(codeFor(n, id));
  expect(response.status).toBe(200);
  return sessionCookie(response).value;
}

const Me = Schema.Struct({ player: Schema.Struct({ id: Schema.String, username: Schema.String }) });
/** Who a frame's session is, by `/v1/game/me`. */
async function me(token: string): Promise<typeof Me.Type & { body: unknown }> {
  const response = await app.request("/v1/game/me", { headers: { Cookie: `__Host-leaf_session=${token}` } });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return { ...Schema.decodeUnknownSync(Me)(body), body };
}

describe("signing in to the raid in a Discord call", () => {
  it("tells the page the Discord application's client id, and nothing when there is none", async () => {
    const hello = await app.request("/v1/activity");
    expect(hello.status).toBe(200);
    expect(await hello.json()).toEqual({ client_id: CLIENT });

    await app.dispose();
    await leafs.dispose();
    start(false);
    expect((await app.request("/v1/activity")).status).toBe(404);
    expect((await signIn("code-1")).status).toBe(404);
  });

  it("trades the page's code with Discord for the player's token, with the secret, and answers the token", async () => {
    const response = await signIn(codeFor(1));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ access_token: `token-of-${known["200000000000000001"]?.id}` });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(discord.traded.map((form) => Object.fromEntries(form))).toEqual([
      { client_id: CLIENT, client_secret: SECRET, grant_type: "authorization_code", code: "code-1" },
    ]);
  });

  it("makes a new player of a Discord account Leaf does not know, named by its username", async () => {
    const token = await signedIn(1);

    const who = await me(token);

    expect(who.player.username).toBe("player1");
    expect(who.body).toMatchObject({ guest: true, signed_in_with: "discord" });
    expect(await leafs.query((sql) => sql`SELECT player_id AS id FROM leaf_ids`)).toEqual([{ id: who.player.id }]);
  });

  it("signs a Discord account Leaf knows in as its player: a member's, with their Minecraft account", async () => {
    // Alice signed in on the guild's website once, with her Discord account: Leaf knows it is hers.
    const site = await app.request("/v1/game/me", { headers: { Cookie: "seq_session=alice-token" } });
    expect(site.status).toBe(200);

    const who = await me(await signedIn(1, discordOf(alice)));

    expect(who.player.id).toBe(alice);
    expect(await leafs.query((sql) => sql`SELECT player_id AS id FROM leaf_ids`)).toEqual([]);
  });

  it("signs the same Discord account in as the same player each time", async () => {
    const first = await me(await signedIn(1));
    const again = await me(await signedIn(2, "200000000000000001"));

    expect(again.player.id).toBe(first.player.id);
  });

  it("refuses a code Discord will not take, and makes nobody", async () => {
    const response = await signIn("made-up");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "discord_refused",
      message: "Discord did not sign you in. Try again",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await leafs.query((sql) => sql`SELECT count(*) AS n FROM leaf_ids`)).toEqual([{ n: 0 }]);
  });

  it("says Discord did not answer when it is down or failing, and signs nobody in", async () => {
    discord.down = true;
    const down = await signIn(codeFor(1));
    discord.down = false;
    discord.failing = true;
    const failing = await signIn(codeFor(2));

    for (const response of [down, failing]) {
      expect(response.status).toBe(503);
      // oxlint-disable-next-line no-await-in-loop -- one answer after another
      expect(await response.json()).toEqual({
        code: "discord_unavailable",
        message: "Discord did not answer. Try again shortly",
      });
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it("takes a code only from Leaf's own pages, and only as a code", async () => {
    expect((await signIn(codeFor(1), "https://evil.example")).status).toBe(403);
    expect((await signIn(codeFor(2), ORIGIN)).status).toBe(200);
    const bad = await signIn(42);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_code" });
    expect(discord.traded).toHaveLength(1);
  });
});

describe("the session's cookie", () => {
  it("is kept for Discord's frame alone inside it: SameSite=None, Secure and Partitioned, host-only", async () => {
    const { line } = sessionCookie(await signIn(codeFor(1)));

    const [pair = "", ...attributes] = line.split("; ");

    expect(pair).toMatch(/^__Host-leaf_session=[\w-]{43}$/);
    expect(attributes.toSorted()).toEqual(
      ["HttpOnly", "Max-Age=2592000", "Partitioned", "Path=/", "SameSite=None", "Secure"].toSorted(),
    );
  });

  it("is as it was at Leaf's own address: SameSite=Lax, and not partitioned", async () => {
    const started = await app.request("/v1/game/sign-in?to=%2Fplay%2Ftown%2F");
    const [nonce = ""] = started.headers.getSetCookie();

    expect(nonce).toContain("SameSite=Lax");
    expect(nonce).not.toContain("Partitioned");
    expect(nonce).not.toContain("SameSite=None");
  });

  it("lets a write from the page in Discord's frame through, and not one from another site", async () => {
    const { token, id } = await player(1);
    const write = (origin: string) =>
      app.request("/v1/game/sittings", {
        method: "POST",
        headers: { Cookie: `__Host-leaf_session=${token}`, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ player: id }),
      });

    expect((await write("https://evil.example")).status).toBe(403);
    expect((await write(FRAME)).status).toBe(200);
  });
});

/** Who sits where, from an answer: the stage, and the names sat, in order. */
const Seated = Schema.Struct({
  id: Schema.String,
  state: Schema.Struct({
    stage: Schema.Struct({
      at: Schema.String,
      sat: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
    }),
  }),
});

/** A player signed in in the frame: their token, their Leaf id, and their Discord id. */
interface Signed {
  readonly token: string;
  readonly id: string;
  readonly discord: string;
}
async function player(n: number): Promise<Signed> {
  const token = await signedIn(n);
  return { token, id: (await me(token)).player.id, discord: `2${String(n).padStart(17, "0")}` };
}
/** Discord has `who` in the launch `instance`, as it has everyone who opens it. */
function intoCall(who: Signed, instance: string): void {
  const users = (discord.instances[instance] ??= []);
  if (!users.includes(who.discord)) users.push(who.discord);
}
/** `who` opens the raid in the launch `instance` as the page does once signed in, Discord having them in it. */
function join(who: Signed, instance: string) {
  intoCall(who, instance);
  return ask(who, instance);
}
/** `who` asks for the table of the launch `instance`, whoever Discord has in it. */
async function ask(who: Signed, instance: string) {
  const response = await app.request("/v1/game/sittings/call", {
    method: "POST",
    headers: { Cookie: `__Host-leaf_session=${who.token}`, Origin: FRAME, "Content-Type": "application/json" },
    body: JSON.stringify({ player: who.id, instance }),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}
const seated = (body: unknown) => Schema.decodeUnknownSync(Seated)(body);

describe("a call's table", () => {
  it("seats everyone who opens one launch at one table, in the order they came, the first having opened it", async () => {
    const first = await player(1);
    const second = await player(2);
    for (const who of [first, second]) intoCall(who, "i-100-gc-1-2");

    const opened = await join(first, "i-100-gc-1-2");
    const sat = await join(second, "i-100-gc-1-2");

    expect([opened.status, sat.status]).toEqual([200, 200]);
    expect(seated(sat.body).id).toBe(seated(opened.body).id);
    expect(seated(sat.body).state.stage).toEqual({ at: "open", sat: [{ name: "player1" }, { name: "player2" }] });
    // Opened again, as a page reloaded: the same table, nothing changed.
    expect(seated((await join(first, "i-100-gc-1-2")).body)).toEqual(seated(sat.body));
  });

  it("starts with the eighth, and turns a ninth away", async () => {
    const players = [];
    // oxlint-disable-next-line no-await-in-loop -- one after another, in order
    for (let n = 1; n <= CHAIRS + 1; n++) players.push(await player(n));
    for (const who of players) intoCall(who, "i-200-gc-1-2");

    const answers = [];
    // oxlint-disable-next-line no-await-in-loop -- they come one after another, in order
    for (const who of players) answers.push(await join(who, "i-200-gc-1-2"));

    expect(answers.slice(0, CHAIRS).map((a) => a.status)).toEqual(Array.from({ length: CHAIRS }, () => 200));
    expect(seated(answers[CHAIRS - 1]?.body).state.stage.at).toBe("carousel");
    expect(answers[CHAIRS]).toEqual({
      status: 409,
      body: { code: "table_started", message: "This table has started. Join the next one when it ends" },
    });
  });

  it("seats another launch at another table, and lists neither among the tables anyone may sit at", async () => {
    const first = await player(1);
    const second = await player(2);

    const one = seated((await join(first, "i-300-gc-1-2")).body).id;
    const other = seated((await join(second, "i-301-gc-1-2")).body).id;
    const listed = await app.request("/v1/game/sittings", {
      headers: { Cookie: `__Host-leaf_session=${first.token}` },
    });

    expect(other).not.toBe(one);
    expect(await listed.json()).toMatchObject({ open: [], yours: one });
  });

  it("opens the launch's next table once its last is over", async () => {
    const first = await player(1);
    const second = await player(2);
    for (const who of [first, second]) intoCall(who, "i-400-gc-1-2");
    const before = seated((await join(first, "i-400-gc-1-2")).body).id;
    // The only one sat gets up: the table is over.
    const left = await app.request(`/v1/game/sittings/${before}`, {
      method: "POST",
      headers: { Cookie: `__Host-leaf_session=${first.token}`, Origin: FRAME, "Content-Type": "application/json" },
      body: JSON.stringify({ player: first.id, commands: [{ id: "leave-1", do: "leave" }] }),
    });
    expect(left.status).toBe(200);

    const next = await join(second, "i-400-gc-1-2");

    expect(next.status).toBe(200);
    expect(seated(next.body).id).not.toBe(before);
    expect(seated(next.body).state.stage).toEqual({ at: "open", sat: [{ name: "player2" }] });
  });

  it("gets someone up from another call's table that has not started, as they join another call", async () => {
    const first = await player(1);
    const second = await player(2);
    for (const who of [first, second]) intoCall(who, "i-600-gc-1-2");
    const old = seated((await join(first, "i-600-gc-1-2")).body).id;
    expect((await join(second, "i-600-gc-1-2")).status).toBe(200);
    // A minute on, so that opening another is not too soon.
    await leafs.query((sql) => sql`UPDATE raid_sittings SET opened_at = opened_at - 120000`);

    const moved = await join(first, "i-601-gc-1-2");

    expect(moved.status).toBe(200);
    expect(seated(moved.body).id).not.toBe(old);
    // The old call's table goes on without them.
    expect(seated((await join(second, "i-600-gc-1-2")).body).state.stage).toEqual({
      at: "open",
      sat: [{ name: "player2" }],
    });
  });

  it("leaves someone at a table anyone may sit at where they are, and says they are at another", async () => {
    const first = await player(1);
    const open = await app.request("/v1/game/sittings", {
      method: "POST",
      headers: { Cookie: `__Host-leaf_session=${first.token}`, Origin: FRAME, "Content-Type": "application/json" },
      body: JSON.stringify({ player: first.id }),
    });
    expect(open.status).toBe(200);
    // A minute on, so that opening another is not too soon.
    await leafs.query((sql) => sql`UPDATE raid_sittings SET opened_at = opened_at - 120000`);

    expect(await join(first, "i-700-gc-1-2")).toEqual({
      status: 409,
      body: { code: "seated_elsewhere", message: "You are at another table." },
    });
  });

  it("takes a launch only as Discord names one, from the player the page says it is", async () => {
    const first = await player(1);
    expect((await join(first, "")).status).toBe(400);
    expect((await join(first, "a/b")).status).toBe(400);
    expect(await join({ ...first, id: alice }, "i-500-gc-1-2")).toMatchObject({
      status: 409,
      body: { code: "not_you" },
    });
  });
});

/** What a call's table answers when Discord cannot say who is in the call. */
const CANNOT = {
  status: 503,
  body: { code: "call_unchecked", message: "Can't check this call right now. Try again in a moment" },
};
const NOT_IN = { status: 409, body: { code: "not_in_call", message: "You are not in this call" } };
const sittingsMade = () => leafs.query((sql) => sql`SELECT count(*) AS n FROM raid_sittings`);

describe("who sits at a call's table, as Discord says", () => {
  it("seats someone Discord has in the launch, and turns away someone it has not", async () => {
    const inside = await player(1);
    const outside = await player(2);

    expect((await join(inside, "i-800-gc-1-2")).status).toBe(200);
    // A second on: someone missing from Discord's kept answer has it asked again.
    clock.now += 2000;
    expect(await ask(outside, "i-800-gc-1-2")).toEqual(NOT_IN);
    expect(discord.asked).toEqual(["i-800-gc-1-2", "i-800-gc-1-2"]);
  });

  it("turns everyone away from a launch Discord does not know, and opens nothing", async () => {
    const who = await player(1);

    expect(await ask(who, "i-made-up")).toEqual(NOT_IN);
    expect(await sittingsMade()).toEqual([{ n: 0 }]);
  });

  it("asks Discord once for a call's arrivals together, again for one who came after, and not for each try of an outsider", async () => {
    const [a, b, c, d, e] = [await player(1), await player(2), await player(3), await player(4), await player(5)];
    for (const who of [a, b, c]) intoCall(who, "i-810-gc-1-2");

    // oxlint-disable-next-line no-await-in-loop -- they come one after another
    for (const who of [a, b, c]) expect((await ask(who, "i-810-gc-1-2")).status).toBe(200);
    expect(discord.asked).toHaveLength(1);

    // d comes into the call after Discord's answer: asked again, once that answer is a second old.
    intoCall(d, "i-810-gc-1-2");
    clock.now += 2000;
    expect((await ask(d, "i-810-gc-1-2")).status).toBe(200);
    expect(discord.asked).toHaveLength(2);

    // Someone outside the call trying again and again within that second asks Discord nothing more.
    expect([await ask(e, "i-810-gc-1-2"), await ask(e, "i-810-gc-1-2")]).toEqual([NOT_IN, NOT_IN]);
    expect(discord.asked).toHaveLength(2);

    // Discord's answer is kept a few seconds only.
    clock.now += 10_000;
    expect((await ask(a, "i-810-gc-1-2")).status).toBe(200);
    expect(discord.asked).toHaveLength(3);
  });

  it("seats nobody without the bot's token to ask Discord with", async () => {
    await app.dispose();
    await leafs.dispose();
    start(true, false);
    const who = await player(1);

    expect(await join(who, "i-820-gc-1-2")).toEqual(CANNOT);
    expect(discord.asked).toEqual([]);
    expect(await sittingsMade()).toEqual([{ n: 0 }]);
  });

  it("seats nobody when Discord does not answer, keeps that a few seconds as any answer, then asks again", async () => {
    const who = await player(1);
    intoCall(who, "i-830-gc-1-2");
    intoCall(who, "i-831-gc-1-2");

    discord.down = true;
    const down = await ask(who, "i-830-gc-1-2");
    discord.down = false;
    discord.failing = true;
    const failing = await ask(who, "i-831-gc-1-2");
    discord.failing = false;

    expect([down, failing]).toEqual([CANNOT, CANNOT]);
    expect(await sittingsMade()).toEqual([{ n: 0 }]);
    // Discord is back, but no answer is what Leaf heard of this launch a moment ago.
    expect(await ask(who, "i-830-gc-1-2")).toEqual(CANNOT);
    clock.now += 6000;
    expect((await ask(who, "i-830-gc-1-2")).status).toBe(200);
  });

  it("asks Discord for one player only a few times a minute, so made-up launches cannot spend the bot's limits", async () => {
    const who = await player(1);
    const answers = [];
    // oxlint-disable-next-line no-await-in-loop -- one after another
    for (let n = 0; n < 7; n++) answers.push(await ask(who, `i-made-up-${n}`));

    expect(answers.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => NOT_IN));
    expect(answers[6]).toEqual(CANNOT);
    expect(discord.asked).toHaveLength(6);
    // Ten seconds on, one more.
    clock.now += 10_000;
    expect(await ask(who, "i-made-up-7")).toEqual(NOT_IN);
    expect(discord.asked).toHaveLength(7);
  });

  it("asks Discord nothing for anyone while a 429 says to wait, and asks again once it has passed", async () => {
    const first = await player(1);
    const second = await player(2);
    intoCall(first, "i-840-gc-1-2");
    intoCall(second, "i-841-gc-1-2");

    discord.limited = 30;
    expect(await ask(first, "i-840-gc-1-2")).toEqual(CANNOT);
    discord.limited = 0;
    expect(await ask(second, "i-841-gc-1-2")).toEqual(CANNOT);
    expect(discord.asked).toEqual(["i-840-gc-1-2"]);

    clock.now += 31_000;
    expect((await ask(second, "i-841-gc-1-2")).status).toBe(200);
    expect(discord.asked).toEqual(["i-840-gc-1-2", "i-841-gc-1-2"]);
  });
});

/** `who` sends commands to a sitting by its id, as any page may. */
async function command(who: Signed, id: string, commands: readonly object[]) {
  const response = await app.request(`/v1/game/sittings/${id}`, {
    method: "POST",
    headers: { Cookie: `__Host-leaf_session=${who.token}`, Origin: FRAME, "Content-Type": "application/json" },
    body: JSON.stringify({ player: who.id, commands }),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

describe("a call's table, whichever way someone asks", () => {
  it("seats nobody Discord does not have in the call, by its id: an outsider takes no eighth seat and starts nothing", async () => {
    const players = [];
    // oxlint-disable-next-line no-await-in-loop -- one after another, in order
    for (let n = 1; n <= CHAIRS; n++) players.push(await player(n));
    const members = players.slice(0, CHAIRS - 1);
    const [outsider] = players.slice(CHAIRS - 1);
    if (outsider === undefined) throw new Error("No outsider");
    for (const who of members) intoCall(who, "i-900-gc-1-2");
    const answers = [];
    // oxlint-disable-next-line no-await-in-loop -- they come one after another, in order
    for (const who of members) answers.push(await join(who, "i-900-gc-1-2"));
    const id = seated(answers[0]?.body).id;
    clock.now += 2000;

    expect(await command(outsider, id, [{ id: "sit-1", do: "sit" }])).toEqual(NOT_IN);
    const started = await command(outsider, id, [{ id: "start-1", do: "start" }]);

    expect(started).toMatchObject({ status: 200, body: { results: [{ id: "start-1", refused: "not_opener" }] } });
    expect(seated(started.body).state.stage).toMatchObject({ at: "open" });
    expect(seated(started.body).state.stage.sat).toHaveLength(CHAIRS - 1);
  });

  it("lets someone in the call sit at its table by its id, as the page's own sit does", async () => {
    const first = await player(1);
    const second = await player(2);
    for (const who of [first, second]) intoCall(who, "i-910-gc-1-2");
    const id = seated((await join(first, "i-910-gc-1-2")).body).id;

    const sat = await command(second, id, [{ id: "sit-1", do: "sit" }]);

    expect(sat.status).toBe(200);
    expect(seated(sat.body).state.stage.sat).toEqual([{ name: "player1" }, { name: "player2" }]);
  });

  it("keeps someone at their table when the call they open has started without them", async () => {
    const lone = await player(1);
    const [b1, b2] = [await player(2), await player(3)];
    intoCall(lone, "i-920-gc-1-2");
    for (const who of [lone, b1, b2]) intoCall(who, "i-921-gc-1-2");
    const mine = seated((await join(lone, "i-920-gc-1-2")).body).id;
    const theirs = seated((await join(b1, "i-921-gc-1-2")).body).id;
    expect((await join(b2, "i-921-gc-1-2")).status).toBe(200);
    expect((await command(b1, theirs, [{ id: "start-1", do: "start" }])).status).toBe(200);

    expect(await join(lone, "i-921-gc-1-2")).toEqual({
      status: 409,
      body: { code: "table_started", message: "This table has started. Join the next one when it ends" },
    });
    // Still at their own, which goes on with them.
    expect(seated((await join(lone, "i-920-gc-1-2")).body)).toMatchObject({
      id: mine,
      state: { stage: { at: "open", sat: [{ name: "player1" }] } },
    });
  });

  it("keeps someone at their table when it is too soon for them to open the call's", async () => {
    const lone = await player(1);
    intoCall(lone, "i-930-gc-1-2");
    intoCall(lone, "i-931-gc-1-2");
    const mine = seated((await join(lone, "i-930-gc-1-2")).body).id;

    expect(await join(lone, "i-931-gc-1-2")).toMatchObject({ status: 429, body: { code: "slow_down" } });
    expect(seated((await join(lone, "i-930-gc-1-2")).body)).toMatchObject({
      id: mine,
      state: { stage: { at: "open", sat: [{ name: "player1" }] } },
    });
  });
});
