import { dirname, join } from "node:path";

import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  type Redacted,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

import type { BucketConfig } from "./backup/offsite.ts";

/** Where a listener binds: a host and a port. */
export interface Bind {
  readonly hostname: string;
  readonly port: number;
}

export interface Settings {
  readonly port: number;
  /**
   * Where Leaf serves its metrics, in Prometheus text at `/metrics`: a listener of its own that
   * nothing routes to, so only Prometheus on the server's network reaches it.
   */
  readonly metrics: Bind;
  /** The SQLite file. In production it is on a volume that survives deploys. */
  readonly databasePath: string;
  /** Where snapshots of the database are written. */
  readonly backupDirectory: string;
  /** Origin of sequoia-backend, which reports raids and wars and checks sessions. */
  readonly backendUrl: string;
  /** sequoia-backend's `APP_INTERNAL_API_TOKEN`. Without it the credit feed is not read. */
  readonly backendToken: Redacted.Redacted | undefined;
  /**
   * Origin of Sierra's internal API, which reports achievement milestones.
   * It takes the same internal token as the backend. Without it the awards
   * feed is not read and milestones pay nothing.
   */
  readonly sierraUrl: string | undefined;
  /**
   * A Discord webhook in the channel where Leaf keeps its rate card, which it
   * posts once and then edits as the rates change. A secret: anyone with it can
   * post there. Without it no rate card is kept.
   */
  readonly ratesWebhook: Redacted.Redacted | undefined;
  /** The bucket snapshots are copied to. Without it they stay on this machine only. */
  readonly offsite: BucketConfig | undefined;
  /** The `BACKUP_S3_*` variables that are set, when some but not all of them are. */
  readonly offsitePartlySet: readonly string[];
  /**
   * The origin Leaf's own pages are served from, such as `https://leaf.seqwawa.com`.
   * A write signed in with the session cookie must come from a page on it.
   */
  readonly publicOrigin: string;
  /** The directory of built game pages served under `/play`. Without it there is no `/play`. */
  readonly publicDir: string | undefined;
  /** Where the game sends a member to sign in: an address that ends in `return_to=`, to which it appends its own. */
  readonly gameSignInUrl: string;
  /** Whether the game may offer to spend Leaf. Only `/v1/game/hello` reads it, to tell the game. */
  readonly gameLeafSpending: boolean;
  /**
   * The most players Live holds at once, connected or in their grace; more are turned away
   * (`live_full`) until some go. Read as Leaf starts: a new number takes a restart.
   */
  readonly liveMostPlayers: number;
  /** The raid in a Discord call (`http/activity.ts`), when both its variables are set; otherwise there is none. */
  readonly activity: Activity | undefined;
}

/**
 * The Discord application the raid runs in inside a call: its client id, its secret, which Leaf
 * trades a page's sign-in code for the player's token with, its bot's token, which Leaf asks Discord
 * who is in a call with (without it nobody is seated at a call's table), and the origin Discord serves
 * the raid's pages from, `https://<client id>.discordsays.com`, which proxies them from Leaf.
 */
export interface Activity {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
  readonly botToken: Redacted.Redacted | undefined;
  readonly origin: string;
}

/** Discord's API, as its guides for the raid's frame ask it. */
export const DISCORD_API = "https://discord.com/api/v10";

/** Whether an `Origin` is one of Leaf's own pages': at its public origin, or in a Discord call. */
export const fromLeafPage = (settings: Settings, origin: string | undefined): boolean =>
  origin !== undefined && (origin === settings.publicOrigin || origin === settings.activity?.origin);

/**
 * How many players one Leaf carries in Live with room to spare, on the four cores production gives
 * it, by the load test (the README's "How long it takes", under Live).
 */
export const LIVE_MOST_PLAYERS = 2000;

/**
 * An origin, such as `https://leaf.seqwawa.com`: an http or https address with
 * nothing after the host and port. Anything else stops the app, naming the
 * variable but not repeating what it was set to.
 */
const Origin = Schema.URL.check(
  Schema.makeFilter(
    (url) =>
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "",
    { expected: "an http or https origin, with no path" },
  ),
);

/**
 * A `host:port` to bind, such as `0.0.0.0:9095`: a host of letters, digits, dots, dashes or colons
 * (an IPv6 address in brackets), and a port from 0 to 65535 (0, any free one).
 */
const HostPort = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Struct({ hostname: Schema.String, port: Schema.Int }),
    SchemaTransformation.transformEffect<Bind, string>({
      decode: (text, options) => {
        const found = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(text);
        const host = found?.[1];
        const port = Number(found?.[2]);
        return host === undefined || port > 65535
          ? Effect.fail(new SchemaIssue.InvalidValue({ expected: "host:port" }, text, options))
          : Effect.succeed({ hostname: host.replace(/^\[|\]$/g, ""), port });
      },
      encode: ({ hostname, port }) => Effect.succeed(`${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`),
    }),
  ),
);

/** A variable that may be left out. One set to the empty string counts as left out. */
const optional = <A>(config: Config.Config<A>) => config.pipe(Config.option, Config.map(Option.getOrUndefined));

/**
 * Leaf's settings, from environment variables, falling back to what local
 * development needs. A variable that is set but invalid, such as a `PORT` that
 * is not a port, stops the app at start.
 */
export const settings: Config.Config<Settings> = Config.all({
  port: Config.Port("PORT").pipe(Config.withDefault(3000)),
  // 9091 to 9094 are the backend's services'; nothing publishes this port or routes to it.
  metrics: Config.schema(HostPort, "LEAF_METRICS_BIND").pipe(Config.withDefault({ hostname: "0.0.0.0", port: 9095 })),
  databasePath: Config.String("DATABASE_PATH").pipe(Config.withDefault("data/leaf.db")),
  backupDirectory: optional(Config.String("BACKUP_DIR")),
  backendUrl: Config.String("BACKEND_URL").pipe(Config.withDefault("https://api.seqwawa.com")),
  backendToken: optional(Config.Redacted("BACKEND_INTERNAL_TOKEN")),
  sierraUrl: optional(Config.String("SIERRA_URL")),
  ratesWebhook: optional(Config.Redacted("LEAF_RATES_WEBHOOK_URL")),
  endpoint: optional(Config.String("BACKUP_S3_ENDPOINT")),
  bucket: optional(Config.String("BACKUP_S3_BUCKET")),
  accessKeyId: optional(Config.String("BACKUP_S3_ACCESS_KEY_ID")),
  secretAccessKey: optional(Config.Redacted("BACKUP_S3_SECRET_ACCESS_KEY")),
  publicOrigin: Config.schema(Origin, "PUBLIC_ORIGIN").pipe(
    Config.map((url) => url.origin),
    Config.withDefault("https://leaf.seqwawa.com"),
  ),
  publicDir: optional(Config.String("PUBLIC_DIR")),
  // The backend's web sign-in, which sends the member back to the `return_to` address once signed in.
  gameSignInUrl: Config.String("GAME_SIGN_IN_URL").pipe(
    Config.withDefault("https://api.seqwawa.com/auth/web/start?return_to="),
  ),
  gameLeafSpending: Config.Boolean("GAME_LEAF_SPENDING").pipe(Config.withDefault(false)),
  liveMostPlayers: Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), "LIVE_MOST_PLAYERS").pipe(
    Config.withDefault(LIVE_MOST_PLAYERS),
  ),
  // A Discord application's id is a snowflake: digits only, so it names one `discordsays.com` host.
  activityClientId: optional(
    Config.schema(Schema.String.check(Schema.isPattern(/^[0-9]{5,25}$/)), "LEAF_ACTIVITY_CLIENT_ID"),
  ),
  activityClientSecret: optional(Config.Redacted("LEAF_ACTIVITY_CLIENT_SECRET")),
  activityBotToken: optional(Config.Redacted("LEAF_ACTIVITY_BOT_TOKEN")),
}).pipe(
  Config.map((read): Settings => {
    const { databasePath, endpoint, bucket, accessKeyId, secretAccessKey, activityClientId: clientId } = read;
    const clientSecret = read.activityClientSecret;
    const offsite =
      endpoint !== undefined && bucket !== undefined && accessKeyId !== undefined && secretAccessKey !== undefined
        ? { endpoint, bucket, accessKeyId, secretAccessKey }
        : undefined;
    const set = Object.entries({
      BACKUP_S3_ENDPOINT: endpoint,
      BACKUP_S3_BUCKET: bucket,
      BACKUP_S3_ACCESS_KEY_ID: accessKeyId,
      BACKUP_S3_SECRET_ACCESS_KEY: secretAccessKey,
    }).flatMap(([name, value]) => (value === undefined ? [] : [name]));
    return {
      port: read.port,
      metrics: read.metrics,
      databasePath,
      backupDirectory: read.backupDirectory ?? join(dirname(databasePath), "backups"),
      backendUrl: read.backendUrl,
      backendToken: read.backendToken,
      sierraUrl: read.sierraUrl,
      ratesWebhook: read.ratesWebhook,
      offsite,
      offsitePartlySet: offsite === undefined ? set : [],
      publicOrigin: read.publicOrigin,
      publicDir: read.publicDir,
      gameSignInUrl: read.gameSignInUrl,
      gameLeafSpending: read.gameLeafSpending,
      liveMostPlayers: read.liveMostPlayers,
      activity:
        clientId === undefined || clientSecret === undefined
          ? undefined
          : {
              clientId,
              clientSecret,
              botToken: read.activityBotToken,
              origin: `https://${clientId}.discordsays.com`,
            },
    };
  }),
);

/** The settings the app runs with. */
export class AppConfig extends Context.Service<AppConfig, Settings>()("leaf/AppConfig") {
  /** Read from the environment as the app starts. */
  static readonly layer = Layer.effect(AppConfig, settings);
}
