import { deflateSync } from "node:zlib";

import { BunServices } from "@effect/platform-bun";
import { gameId, minecraftId, type PlayerId, type Posting, type ReportedActivity, whole } from "@sequoia-leaf/core";
import {
  Clock,
  ConfigProvider,
  Duration,
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Metric,
  Option,
  Redacted,
  References,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { SqlClient } from "effect/sql";
import { TestClock as EffectTestClock } from "effect/testing";

import { routerConfig, Routes, serveLeaf, Stores } from "../src/app.ts";
import { AppConfig, type Settings, settings } from "../src/config.ts";
import { databaseAt } from "../src/db.ts";
import { Credits } from "../src/earning/run.ts";
import type { CreditSource } from "../src/earning/sync.ts";
import { Events } from "../src/events/store.ts";
import { Mojang, MojangError, type MojangProfile } from "../src/game/mojang.ts";
import { LeafInstance } from "../src/instance.ts";
import { Ledger } from "../src/ledger/store.ts";
import { Live, LiveMeter, LiveTuning, type TickTimes } from "../src/live/live.ts";
import { LivePlayers } from "../src/live/players.ts";
import { Watchers } from "../src/live/watchers.ts";
import { MetricsListener, metricsText, RuntimeMetrics } from "../src/metrics.ts";
import { GAMES } from "../src/play/games.ts";
import { type JobTimes, Play, PlayMeter } from "../src/play/service.ts";
import { PlayStore } from "../src/play/store.ts";
import { CallMembers } from "../src/sittings/members.ts";
import { Sittings } from "../src/sittings/service.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A clock that tests set by hand. */
export interface TestClock {
  now: number;
}

/** A stand-in for the network: answers each request Leaf makes. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** A network that answers nothing, for tests that make no calls. */
export const noNetwork: Fetcher = () => Promise.reject(new Error("No network in this test"));

/** A `fetch` whose answer never comes, until the request is given up. */
export const unanswered = (_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

/** A raid `player`'s own Minecraft account took part in, as the credit feed reports it. */
export function raid(id: number, player: PlayerId, occurredAt: number, seasonRating = 110): ReportedActivity {
  return {
    kind: "raid",
    sourceKey: `raid:${id}:${player}`,
    account: minecraftId(player),
    occurredAt,
    seasonRating,
    raid: "tna",
    raidName: "The Nameless Anomaly",
  };
}

/** A credit feed that answers each window with the activities inside it. */
export function feed(activities: readonly ReportedActivity[]): CreditSource {
  return (from, to) =>
    Effect.succeed(activities.filter((activity) => activity.occurredAt >= from && activity.occurredAt < to));
}

/** Leaf's settings as these environment variables give them, or fails with why they are invalid. */
export function readSettings(env: Record<string, string>): Settings {
  return Effect.runSync(settings.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))));
}

/** Leaf's settings in tests: a backend and Sierra at made-up addresses, with an internal token. */
export function testConfig(overrides: Partial<Settings> = {}): Settings {
  return {
    ...readSettings({}),
    databasePath: ":memory:",
    backendUrl: "https://backend.test",
    backendToken: Redacted.make("internal-token"),
    sierraUrl: "https://sierra.test",
    ...overrides,
  };
}

/** Stand-ins for services Leaf reaches outside the network stand-in. */
export interface Fakes {
  /** Mojang, for skins and names. Without it Leaf asks the network stand-in, as it would ask Mojang. */
  readonly mojang?: Mojang["Service"];
  /** Steps in between Leaf and its ledger, such as to have something happen between two reads of it. */
  readonly ledger?: (real: Ledger["Service"]) => Ledger["Service"];
  /** Steps in between Leaf and its events, the same way. */
  readonly events?: (real: Events["Service"]) => Events["Service"];
  /** Steps in between the play service and what it keeps, the same way. */
  readonly play?: (real: PlayStore["Service"]) => PlayStore["Service"];
  /** Steps in between Leaf and its credit sync, the same way, such as to hear a request take its turn. */
  readonly credits?: (real: Credits["Service"]) => Credits["Service"];
  /** Steps in between the play service and what asks it for jobs, the same way, such as to hear a job arrive. */
  readonly playing?: (real: Play["Service"]) => Play["Service"];
  /** Live's timings and sizes, for tests that cannot wait for the real ones. */
  readonly live?: Partial<LiveTuning>;
  /** Which Leaf process this is (`LeafInstance`). Each test Leaf is a process of its own unless given one. */
  readonly instance?: string;
  /** Leaf's dice, for tests that need them to fall the same way every time. Without it they are the machine's. */
  readonly dice?: SecureRandom.SecureRandom["Service"];
  /** Leaf's own warnings and errors, printed as production prints them (the play server's `--log`). Without it Leaf logs nothing. */
  readonly log?: boolean;
  /**
   * How many of Effect's steps a fiber takes before it lets others have a turn. One has every fiber
   * let the others run between any two of its steps, as Effect may: a test of what must happen in
   * one step (a check and the act it guards) fails at the first split.
   */
  readonly stepsBeforeYield?: number;
  /** Told what each of Live's ticks took (`LiveMeter`), for the load test. */
  readonly liveMeter?: (times: TickTimes) => void;
  /** Told where each of the play service's jobs spent its time (`PlayMeter`), for the load test. */
  readonly meter?: (times: JobTimes) => void;
  /** Where Leaf's warnings and errors go, as the JSON logger would write them, for tests that read them. */
  readonly logged?: LogLine[];
  /**
   * Leaf's clock as Effect's test clock, from `clock.now` as Leaf starts: its waits (Live's ticks,
   * a stream's beats, a session's recheck) pass only as the test moves it, with `adjust`. Without
   * it, the hand-set clock tells the time and waits really pass.
   */
  readonly testClock?: boolean;
}

/** A line Leaf logged, as the JSON logger writes it. */
export type LogLine = typeof Logger.formatStructured extends Logger.Logger<unknown, infer Line> ? Line : never;

/** Dice that fall the same way every time from the same seed: a counter, mixed (for tests and play only). */
export function steadyDice(seed: number): SecureRandom.SecureRandom["Service"] {
  let n = seed >>> 0;
  return SecureRandom.make((size) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      n = (n + 0x6d2b79f5) >>> 0;
      let t = n;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      bytes[i] = (t ^ (t >>> 14)) & 0xff;
    }
    return bytes;
  });
}

/**
 * Leaf around a fresh, fully migrated database in memory (or the file
 * `config.databasePath` names, for two Leafs on one file as in a deploy), a
 * hand-set clock and a stand-in network: the layer Leaf's code runs with, `run`
 * to run an effect against it, and `app` for its HTTP API. They all share the
 * one database.
 */
export function testLeaf(clock: TestClock, fetcher: Fetcher, config: Partial<Settings> = {}, fakes: Fakes = {}) {
  const configured = testConfig(config);
  const handClock = Layer.effect(
    Clock.Clock,
    Clock.clockWith((real) =>
      Effect.succeed({
        currentTimeMillisUnsafe: () => clock.now,
        currentTimeMillis: Effect.sync(() => clock.now),
        currentTimeNanosUnsafe: () => BigInt(clock.now) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => BigInt(clock.now) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: real.monotonicTimeNanos,
        // Waits really pass, so an event stream polls as it would.
        sleep: (duration) => real.sleep(duration),
      }),
    ),
  );
  const network = FetchHttpClient.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(FetchHttpClient.Fetch)(
        // Bun's fetch type carries `preconnect` as well.
        Object.assign(
          (input: string | URL | Request, init?: RequestInit) =>
            fetcher(input instanceof Request ? input.url : input.toString(), init ?? {}),
          {
            preconnect: globalThis.fetch.preconnect,
          },
        ),
      ),
    ),
  );
  // Leaf's loops always have a wait due, so the test clock's warning that nobody moves it would be noise.
  const testClock = EffectTestClock.layer({ warningDelay: "1 minute" }).pipe(
    Layer.tap((built) => EffectTestClock.setTime(clock.now).pipe(Effect.provideContext(built))),
  );
  const outside = Layer.mergeAll(
    Layer.succeed(AppConfig)(configured),
    fakes.mojang === undefined ? Mojang.layer.pipe(Layer.provideMerge(network)) : Layer.succeed(Mojang)(fakes.mojang),
    network,
    fakes.testClock === true ? testClock : handClock,
    Layer.succeed(LeafInstance)(fakes.instance ?? crypto.randomUUID()),
    Layer.succeed(PlayMeter)(fakes.meter ?? null),
    BunServices.layer,
    fakes.dice === undefined ? SecureRandom.layerWebCrypto : Layer.succeed(SecureRandom.SecureRandom)(fakes.dice),
    fakes.log === true || fakes.logged !== undefined
      ? Layer.mergeAll(
          Logger.layer(
            fakes.logged === undefined
              ? [Logger.consoleJson]
              : [Logger.map(Logger.formatStructured, (line) => void fakes.logged?.push(line))],
          ),
          Layer.succeed(References.MinimumLogLevel)("Warn"),
        )
      : Layer.succeed(References.MinimumLogLevel)("None"),
    // Each Leaf counts on its own.
    Layer.succeed(Metric.MetricRegistry)(new Map()),
  );
  const stores = Stores.pipe(Layer.provideMerge(databaseAt(configured.databasePath)), Layer.provideMerge(outside));
  // The real stores, or whatever the test puts in between; everything built on top sees the same.
  const between = Layer.mergeAll(
    Layer.effect(
      Ledger,
      Ledger.useSync((real) => fakes.ledger?.(real) ?? real),
    ),
    Layer.effect(
      Events,
      Events.useSync((real) => fakes.events?.(real) ?? real),
    ),
    Layer.effect(
      PlayStore,
      PlayStore.useSync((real) => fakes.play?.(real) ?? real),
    ),
  );
  const live = Live.layer.pipe(
    Layer.provide(stores),
    Layer.provide(outside),
    Layer.provide(
      Layer.succeed(LiveTuning)({
        recheckMs: fakes.live?.recheckMs ?? LiveTuning.defaultValue().recheckMs,
        graceMs: fakes.live?.graceMs ?? LiveTuning.defaultValue().graceMs,
        mostPlayers: fakes.live?.mostPlayers ?? LiveTuning.defaultValue().mostPlayers,
        presenceMs: fakes.live?.presenceMs ?? LiveTuning.defaultValue().presenceMs,
      }),
    ),
    Layer.provide(Layer.succeed(LiveMeter)(fakes.liveMeter ?? null)),
  );
  // Who hears what Leaf does to a state: the play service tells them, Live puts them there; and
  // Live's players by id, whom the sittings tell when one they are at moves on.
  const credits = Layer.effect(
    Credits,
    Credits.useSync((real) => fakes.credits?.(real) ?? real),
  ).pipe(Layer.provide(Credits.layer));
  const playing = Layer.effect(
    Play,
    Play.useSync((real) => fakes.playing?.(real) ?? real),
  ).pipe(Layer.provide(Play.layer));
  const layer = Layer.merge(
    Layer.mergeAll(playing, credits, Sittings.layer.pipe(Layer.provideMerge(CallMembers.layer))).pipe(
      Layer.provideMerge(between.pipe(Layer.provideMerge(stores))),
    ),
    live,
  ).pipe(
    Layer.provideMerge(Watchers.layer),
    Layer.provideMerge(LivePlayers.layer),
    Layer.provideMerge(Layer.succeed(References.MaxOpsBeforeYield)(fakes.stepsBeforeYield ?? 2048)),
  );
  // Layers built through the same memo map are built once, so `run` and `app` see the same database.
  const memoMap = Layer.makeMemoMapUnsafe();
  const runtime = ManagedRuntime.make(layer, { memoMap });
  return {
    /** Runs an effect against this Leaf. */
    run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>): Promise<A> => runtime.runPromise(effect),
    /** Moves Leaf's test clock (`Fakes.testClock`) on, and waits for whatever was due by then to have run up to its next wait. */
    adjust: (duration: Duration.Input) => runtime.runPromise(EffectTestClock.adjust(duration)),
    /** A player's account, as the ledger has it now. */
    account: (playerId: PlayerId) => runtime.runPromise(Ledger.use((ledger) => ledger.account(playerId))),
    /** Posts one entry to the ledger, as setup for a test. */
    post: (posting: Posting, now: number) => runtime.runPromise(Ledger.use((ledger) => ledger.post(posting, now))),
    /** Runs SQL against the database directly, as a script would. */
    query: <A>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
      runtime.runPromise(SqlClient.SqlClient.use(statement)),
    /** Leaf's metrics, as Prometheus reads them from its metrics listener. */
    metrics: () => runtime.runPromise(metricsText),
    /** Closes the database. */
    dispose: () => runtime.dispose(),
    /** The HTTP API, answering a standard Request with a standard Response, without opening a port. */
    app: (extra: Layer.Layer<never> = Layer.empty) => {
      const { handler, dispose } = HttpRouter.toWebHandler(
        Routes.pipe(Layer.provideMerge(layer), Layer.provide(extra), Layer.provide(HttpServer.layerServices)),
        { disableLogger: true, routerConfig, memoMap },
      );
      return {
        dispose,
        /** Answers a request as the server would, such as one a browser sent. */
        handle: (request: Request) => handler(request),
        request: (path: string, init: RequestInit = {}) => handler(new Request(`http://leaf.test${path}`, init)),
      };
    },
    /** Leaf's metrics listener, where the settings' `metrics` say, with the process's figures, as production starts it. */
    listen: async () => {
      const listener = ManagedRuntime.make(Layer.merge(MetricsListener, RuntimeMetrics).pipe(Layer.provide(layer)), {
        memoMap,
      });
      await listener.runPromise(Effect.void);
      return { close: () => listener.dispose() };
    },
    /**
     * Leaf on a real port of this machine, served by Bun as in production, live connections and
     * all, with any routes of the caller's beside its own. Port 0 takes any free one.
     */
    serve: async (port = 0, extra: Layer.Layer<never, never, HttpRouter.HttpRouter> = Layer.empty) => {
      const server = serveLeaf({ port, hostname: "127.0.0.1", extra }).pipe(Layer.provide(layer));
      const served = ManagedRuntime.make(server, { memoMap });
      const address = await served.runPromise(
        Effect.gen(function* () {
          const http = yield* HttpServer.HttpServer;
          return http.address;
        }),
      );
      const at = "port" in address ? address.port : 0;
      return {
        port: at,
        origin: `http://127.0.0.1:${at}`,
        /** Stops serving as production stops: live connections are told Leaf is restarting, event streams end. */
        close: () => served.dispose(),
      };
    },
  };
}

/** What a promise rejects with. Fails the test when the promise resolves instead. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject, but it resolved");
}

/** A member's session as the backend's `/auth/web/me` describes it. `rank` null is someone not in the guild. */
/** A Discord id of the player's own, made from their UUID: each player in a test has one. */
export function discordOf(player: string): string {
  return `1${BigInt(`0x${player.replaceAll("-", "").slice(-15)}`)
    .toString()
    .padStart(18, "0")}`;
}

export function sessionOf(player: string, username: string, rank: string | null = "CAPTAIN") {
  return {
    discord_id: discordOf(player),
    discord_username: username.toLowerCase(),
    minecraft_uuid: player,
    minecraft_username: username,
    expires_at: "2026-12-01T00:00:00Z",
    guild_rank: rank,
    website_admin: false,
    primary_account: true,
  };
}

/** What a stand-in backend answers. Each is read when asked, so a test can change it as it goes. */
export interface Backend {
  /** The answer to `/auth/web/me`, by the session token Leaf sends; any other token is refused. */
  sessions: Record<string, () => Response>;
  /** The credit feed's answer for the window [from, to), in milliseconds. */
  credits: (from: number, to: number) => unknown;
  /** Sierra's awards feed's answer for the window [from, to). */
  awards: (from: number, to: number) => unknown;
  /** The answer to anything under `/api`, the routes asked with a member's own session. */
  api: (request: Request) => Response | Promise<Response>;
  /** The answer to redeeming a Discord-only sign-in's one-time code, by the code. */
  proofs: Record<string, () => Response>;
  /** The path of every request it was sent, in order. */
  readonly calls: string[];
}

/** A stand-in sequoia-backend and Sierra, with no sessions and empty feeds until a test gives them some. */
export function fakeBackend(sessions: Record<string, () => Response> = {}): { backend: Backend; fetcher: Fetcher } {
  const backend: Backend = {
    sessions,
    credits: () => ({ raids: [], wars: [] }),
    awards: () => ({ awards: [] }),
    api: () => new Response("not found", { status: 404 }),
    proofs: {},
    calls: [],
  };
  const fetcher: Fetcher = (url, init) => {
    const request = new Request(url, init);
    const path = new URL(request.url).pathname;
    backend.calls.push(path);
    if (path === "/auth/web/me") {
      const token = request.headers.get("Authorization")?.slice("Bearer ".length) ?? "";
      const answer = backend.sessions[token] ?? (() => Response.json({ error: "unauthorized" }, { status: 401 }));
      return Promise.resolve(answer());
    }
    const params = new URL(request.url).searchParams;
    const from = Date.parse(params.get("from") ?? "");
    const to = Date.parse(params.get("to") ?? "");
    if (path === "/internal/player-credits") {
      return Promise.resolve(Response.json(backend.credits(from, to)));
    }
    if (path === "/internal/v1/achievements/awards") {
      return Promise.resolve(Response.json(backend.awards(from, to)));
    }
    if (path.startsWith("/api/")) {
      return Promise.resolve(backend.api(request));
    }
    const proof = /^\/internal\/leaf\/discord-proofs\/(.+)$/.exec(path)?.[1];
    if (proof !== undefined && request.headers.get("Authorization") === "Bearer internal-token") {
      const answer = backend.proofs[decodeURIComponent(proof)];
      // Each code is redeemed once.
      delete backend.proofs[decodeURIComponent(proof)];
      return Promise.resolve(answer?.() ?? Response.json({ error: "unknown or expired code" }, { status: 404 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { backend, fetcher };
}

/** A refusal from the stand-in reward queue, with the backend's words in it. */
const no = (status: number, message: string) => Response.json({ status, message }, { status });

/** One member's place with the stand-in reward queue (`rewardQueue`). */
export interface Queued {
  /** Days in the guild: paying Leaf for a request takes 7. */
  days: number;
  /** The kinds the member has a request waiting for. */
  readonly waiting: Set<string>;
  /** Paid requests ahead of the member's next one in each kind's queue. */
  ahead: number;
}

/** LE as the stand-in reward queue sells it, as the backend's config has it: 200 Leaf for 1 LE, at least 32. */
export const LE_OFFER = { leaf_per_le: 200, minimum: 32 } as const;

/**
 * A stand-in for the backend's reward queue (`/api/reward-queue`) for one member, signed in as
 * `token`, as `Backend.api`: it says whether they may pay Leaf for a request as the backend does, and
 * makes one as the backend does, by buying it from Leaf's own purchase route (`leaf`, as the backend
 * reaches it) before it answers, and cancelling it there when Leaf refuses. Aspects and tomes cost
 * 3,000 Leaf each, and LE as `LE_OFFER` says. Its refusals carry the backend's words.
 */
export function rewardQueue(
  token: string,
  player: PlayerId,
  leaf: (path: string, init: RequestInit) => Promise<Response>,
): { readonly queued: Queued; readonly api: (request: Request) => Promise<Response> } {
  const queued: Queued = { days: 30, waiting: new Set(), ahead: 1 };
  const PRICE = 3000;
  const api = async (request: Request): Promise<Response> => {
    if (request.headers.get("Authorization") !== `Bearer ${token}`) {
      return Response.json({ code: "token_invalid", message: "Invalid token" }, { status: 401 });
    }
    const path = new URL(request.url).pathname;
    if (path === "/api/reward-queue/eligibility") {
      return Response.json({
        eligible: false,
        has_hq_role: false,
        raid_count_last_7_days: 3,
        in_guild_time_in_days: queued.days,
        required_raids: 40,
        required_days: 7,
        message:
          "You need at least 7 days in the guild and either the HQ Team role or at least 40 guild raids in the past 7 days to use this queue.",
        in_guild: true,
        leaf_eligible: queued.days >= 7,
        leaf_balance: null,
        prices: { tome: PRICE, aspect: PRICE, le: LE_OFFER },
      });
    }
    if (path !== "/api/reward-queue/requests" || request.method !== "POST") {
      return no(404, "Not found");
    }
    const body: unknown = await request.json();
    const read = (key: string): unknown =>
      typeof body === "object" && body !== null ? Object.getOwnPropertyDescriptor(body, key)?.value : undefined;
    const type = read("type");
    if (type !== "aspect" && type !== "tome" && type !== "le") {
      return no(400, `Unknown reward queue type: ${String(type)}`);
    }
    const amount = read("amount");
    if (type === "le" && (typeof amount !== "number" || !Number.isInteger(amount) || amount < LE_OFFER.minimum)) {
      return no(400, `Ask for at least ${whole(LE_OFFER.minimum)} LE, in whole LE.`);
    }
    if (type === "le" && read("pay_with_leaf") !== true) {
      return no(400, "LE is paid for with Leaf.");
    }
    const le = typeof amount === "number" && type === "le" ? amount : null;
    const price = le === null ? PRICE : le * LE_OFFER.leaf_per_le;
    if (queued.days < 7) {
      return no(403, "You need at least 7 days in the guild to use this queue.");
    }
    if (queued.waiting.has(type)) {
      return no(409, `You already have a pending ${type} request in the queue.`);
    }
    const key = `request:${crypto.randomUUID()}`;
    const internal = { Authorization: "Bearer internal-token", "Content-Type": "application/json" };
    const bought = await leaf(`/internal/v1/purchases/${key}`, {
      method: "PUT",
      headers: internal,
      body: JSON.stringify({ player_id: player, kind: type, leaf: price }),
    });
    const paid: unknown = await bought.json();
    if (bought.status !== 200 || typeof paid !== "object" || paid === null || !("balance" in paid)) {
      await leaf(`/internal/v1/purchases/${key}`, { method: "DELETE", headers: internal });
      const what = le === null ? (type === "aspect" ? "An aspect request" : "A tome request") : `${whole(le)} LE`;
      return no(403, `${what} costs ${whole(price)} Leaf, and you don't have that much.`);
    }
    queued.waiting.add(type);
    return Response.json(
      { request_id: 7, type, position: queued.ahead + 1, leaf_paid: price, leaf_balance: paid.balance, amount: le },
      { status: 201 },
    );
  };
  return { queued, api };
}

/** What a stand-in Mojang knows, and what it was asked. */
export interface FakeMojang {
  /** Each player's profile; a player missing is one Mojang knows nothing of. */
  readonly profiles: Map<string, MojangProfile>;
  /** The skin sheet at each address. */
  readonly textures: Map<string, Uint8Array>;
  /** While true, every request fails as if Mojang could not be reached. */
  down: boolean;
  /** How long, in milliseconds, each answer takes. */
  latencyMs: number;
  /** Every request, as `profile <uuid>` or `texture <address>`. */
  readonly calls: string[];
  readonly service: Mojang["Service"];
}

/** Answers after the fake's latency, if it has any. */
const after =
  (fake: FakeMojang) =>
  <A, E>(answer: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    fake.latencyMs === 0 ? answer : Effect.delay(answer, Duration.millis(fake.latencyMs));

/** A stand-in for Mojang that answers from what a test gives it, and never reaches the network. */
export function fakeMojang(): FakeMojang {
  const fake: FakeMojang = {
    profiles: new Map(),
    textures: new Map(),
    down: false,
    latencyMs: 0,
    calls: [],
    service: {
      profile: (player) =>
        Effect.suspend(() => {
          fake.calls.push(`profile ${player}`);
          return fake.down
            ? Effect.fail(new MojangError({ message: "Mojang is down in this test" }))
            : Effect.succeed(Option.fromUndefinedOr(fake.profiles.get(player)));
        }).pipe(after(fake)),
      texture: (address) =>
        Effect.suspend(() => {
          fake.calls.push(`texture ${address.href}`);
          const png = fake.textures.get(address.href);
          return fake.down || png === undefined
            ? Effect.fail(new MojangError({ message: "No such texture in this test" }))
            : Effect.succeed(png);
        }).pipe(after(fake)),
    },
  };
  return fake;
}

/** One chunk of a PNG file: its length, type, data and checksum. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typed = new Uint8Array([...new TextEncoder().encode(type), ...data]);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typed, 4);
  view.setUint32(8 + data.length, Bun.hash.crc32(typed));
  return chunk;
}

/** A colour as red, green, blue and alpha. */
export type Rgba = readonly [number, number, number, number];

/** A real PNG of `width` by `height` pixels, from their colours as red, green, blue and alpha, row by row. */
export function encodePng(width: number, height: number, pixels: Uint8Array) {
  const stride = width * 4;
  const rows = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    rows.set(pixels.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits a channel, red, green, blue and alpha
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...pngChunk("IHDR", header),
    ...pngChunk("IDAT", deflateSync(rows)),
    ...pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/** A picture of `width` by `height` pixels in one colour, as a real PNG. */
export function plainPng(width: number, height: number, colour: Rgba) {
  const pixels = new Uint8Array(width * height * 4);
  for (let at = 0; at < pixels.length; at += 4) {
    pixels.set(colour, at);
  }
  return encodePng(width, height, pixels);
}

/**
 * A 64 by 64 skin sheet as a real PNG: the parts of a character, laid out as
 * Minecraft lays them out, in plain colours, with a face.
 */
export function skinPng(colours: {
  readonly skin: Rgba;
  readonly hair: Rgba;
  readonly shirt: Rgba;
  readonly legs: Rgba;
}) {
  const pixels = new Uint8Array(64 * 64 * 4);
  const fill = (x0: number, y0: number, x1: number, y1: number, colour: Rgba) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        pixels.set(colour, (y * 64 + x) * 4);
      }
    }
  };
  fill(0, 0, 32, 16, colours.skin); // the head
  fill(8, 0, 16, 8, colours.hair); // its top
  for (const x of [0, 8, 16, 24]) {
    fill(x, 8, x + 8, 10, colours.hair); // a fringe all round
  }
  fill(24, 10, 32, 16, colours.hair); // the back of the head
  fill(9, 12, 11, 13, [255, 255, 255, 255]); // the eyes, on the face
  fill(13, 12, 15, 13, [255, 255, 255, 255]);
  fill(10, 12, 11, 13, [40, 40, 60, 255]);
  fill(13, 12, 14, 13, [40, 40, 60, 255]);
  fill(16, 16, 40, 32, colours.shirt); // the body
  fill(40, 16, 56, 32, colours.shirt); // the right arm
  fill(32, 48, 48, 64, colours.shirt); // the left arm
  fill(44, 28, 48, 32, colours.skin); // the hands
  fill(36, 60, 40, 64, colours.skin);
  fill(0, 16, 16, 32, colours.legs); // the right leg
  fill(16, 48, 32, 64, colours.legs); // the left leg
  return encodePng(64, 64, pixels);
}

/**
 * A body as a game's page sends it to `path`: a batch of commands (`/v1/game/play/<game>`) says the
 * rules the page plays by, Leaf's own, unless it says some itself, as the kit's page does (`play.ts`).
 */
export function asPage(path: string, body: unknown): unknown {
  const name = /^\/v1\/game\/play\/([a-z]+)$/.exec(path)?.[1];
  const id = name === undefined ? undefined : gameId(name);
  if (id === undefined || typeof body !== "object" || body === null || Array.isArray(body) || "rules" in body)
    return body;
  return { rules: GAMES[id].rules, ...body };
}
