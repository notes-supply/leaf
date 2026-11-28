import { describe, expect, it } from "bun:test";

import { ConfigProvider, Effect, Exit, Layer, Redacted } from "effect";

import { AppConfig, LIVE_MOST_PLAYERS } from "../src/config.ts";
import { LIVE_TUNING, LiveTuned, LiveTuning } from "../src/live/live.ts";
import { readSettings, testConfig } from "./support.ts";

const bucket = {
  BACKUP_S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  BACKUP_S3_BUCKET: "leaf-backups",
  BACKUP_S3_ACCESS_KEY_ID: "key-id",
  BACKUP_S3_SECRET_ACCESS_KEY: "key-secret",
};

/** How starting the app with this `PUBLIC_ORIGIN` goes, as far as its settings. */
function starting(origin: string) {
  return Effect.runSyncExit(
    Effect.scoped(Layer.build(AppConfig.layer)).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { PUBLIC_ORIGIN: origin } }))),
    ),
  );
}

describe("settings", () => {
  it("falls back to what local development needs", () => {
    expect(readSettings({})).toEqual({
      port: 3000,
      metrics: { hostname: "0.0.0.0", port: 9095 },
      databasePath: "data/leaf.db",
      backupDirectory: "data/backups",
      backendUrl: "https://api.seqwawa.com",
      backendToken: undefined,
      sierraUrl: undefined,
      ratesWebhook: undefined,
      offsite: undefined,
      offsitePartlySet: [],
      publicOrigin: "https://leaf.seqwawa.com",
      publicDir: undefined,
      gameSignInUrl: "https://api.seqwawa.com/auth/web/start?return_to=",
      gameLeafSpending: false,
      liveMostPlayers: LIVE_MOST_PLAYERS,
      activity: undefined,
    });
  });

  it("has the raid in a Discord call with both of its variables, its secret kept out of print, and none with one", () => {
    const both = readSettings({
      LEAF_ACTIVITY_CLIENT_ID: "1576204968619417712",
      LEAF_ACTIVITY_CLIENT_SECRET: "s3cret",
    });

    expect(both.activity?.clientId).toBe("1576204968619417712");
    expect(both.activity?.origin).toBe("https://1576204968619417712.discordsays.com");
    expect(JSON.stringify(both)).not.toContain("s3cret");
    expect(readSettings({ LEAF_ACTIVITY_CLIENT_ID: "1576204968619417712" }).activity).toBeUndefined();
    expect(readSettings({ LEAF_ACTIVITY_CLIENT_SECRET: "s3cret" }).activity).toBeUndefined();
    // An id is digits, so it names one of Discord's hosts and nothing else.
    expect(() =>
      readSettings({ LEAF_ACTIVITY_CLIENT_ID: "evil.example/x", LEAF_ACTIVITY_CLIENT_SECRET: "s3cret" }),
    ).toThrow();
  });

  it("holds as many players in Live as LIVE_MOST_PLAYERS says, and refuses anything but a whole number above 0", async () => {
    expect(readSettings({ LIVE_MOST_PLAYERS: "2500" }).liveMostPlayers).toBe(2500);
    for (const bad of ["0", "-5", "1.5", "lots"]) expect(() => readSettings({ LIVE_MOST_PLAYERS: bad })).toThrow();
    // Live is given the number Leaf started with, and its other tuning as ever.
    const tuned = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* LiveTuning;
        }),
        LiveTuned.pipe(Layer.provide(Layer.succeed(AppConfig)(testConfig({ liveMostPlayers: 7 })))),
      ),
    );
    expect([tuned.mostPlayers, tuned.recheckMs, tuned.graceMs, tuned.presenceMs]).toEqual([
      7,
      LIVE_TUNING.recheckMs,
      LIVE_TUNING.graceMs,
      LIVE_TUNING.presenceMs,
    ]);
  });

  it("serves metrics where LEAF_METRICS_BIND says, and refuses anything that is not host:port", () => {
    expect(readSettings({ LEAF_METRICS_BIND: "127.0.0.1:4401" }).metrics).toEqual({
      hostname: "127.0.0.1",
      port: 4401,
    });
    expect(readSettings({ LEAF_METRICS_BIND: "[::]:9095" }).metrics).toEqual({ hostname: "::", port: 9095 });
    for (const bad of ["9095", "0.0.0.0", "0.0.0.0:70000", "http://0.0.0.0:9095"]) {
      expect(() => readSettings({ LEAF_METRICS_BIND: bad })).toThrow();
    }
  });

  it("treats a variable set to nothing as left out", () => {
    expect(readSettings({ PORT: "", BACKEND_INTERNAL_TOKEN: "", DATABASE_PATH: "" })).toMatchObject({
      port: 3000,
      databasePath: "data/leaf.db",
      backendToken: undefined,
    });
  });

  it("keeps the internal token out of anything that prints it", () => {
    const { backendToken } = readSettings({ BACKEND_INTERNAL_TOKEN: "internal-secret" });

    expect(backendToken === undefined ? undefined : Redacted.value(backendToken)).toBe("internal-secret");
    expect(Bun.inspect(backendToken)).not.toContain("internal-secret");
    expect(JSON.stringify({ backendToken })).not.toContain("internal-secret");
  });

  it("reads Sierra's address for the awards feed", () => {
    expect(readSettings({ SIERRA_URL: "http://sequoia-sierra:8082" }).sierraUrl).toBe("http://sequoia-sierra:8082");
  });

  it("copies snapshots off the server when all four bucket variables are set", () => {
    const { offsite, offsitePartlySet } = readSettings(bucket);

    expect(offsite).toMatchObject({
      endpoint: "https://example.r2.cloudflarestorage.com",
      bucket: "leaf-backups",
      accessKeyId: "key-id",
    });
    expect(offsite === undefined ? undefined : Redacted.value(offsite.secretAccessKey)).toBe("key-secret");
    expect(offsitePartlySet).toEqual([]);
  });

  it("names the bucket variables that are set when some are missing, and copies nothing", () => {
    expect(readSettings({ ...bucket, BACKUP_S3_SECRET_ACCESS_KEY: "" })).toMatchObject({
      offsite: undefined,
      offsitePartlySet: ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID"],
    });
  });

  it("reads the game's settings", () => {
    expect(
      readSettings({
        PUBLIC_ORIGIN: "http://127.0.0.1:4000/",
        PUBLIC_DIR: "/app/public",
        GAME_SIGN_IN_URL: "https://staging.seqwawa.com/auth/web/start?return_to=",
        GAME_LEAF_SPENDING: "true",
      }),
    ).toMatchObject({
      publicOrigin: "http://127.0.0.1:4000",
      publicDir: "/app/public",
      gameSignInUrl: "https://staging.seqwawa.com/auth/web/start?return_to=",
      gameLeafSpending: true,
    });
  });

  it("refuses a public origin that is not an address", () => {
    expect(() => readSettings({ PUBLIC_ORIGIN: "leaf" })).toThrow("PUBLIC_ORIGIN");
  });

  it("refuses to start with a public origin that is not an http or https origin, naming it but not its value", () => {
    const wrong = [
      "file:///srv/leaf",
      "data:text/html,leaf",
      "ftp://leaf.seqwawa.com",
      "https://leaf.seqwawa.com/play",
      "https://leaf.seqwawa.com/?from=x",
      "https://leaf.seqwawa.com/#x",
      "https://someone:secret@leaf.seqwawa.com",
    ];

    for (const origin of wrong) {
      const exit = starting(origin);
      const why = Exit.isFailure(exit) ? String(exit.cause) : "it started";

      expect(why).toContain("PUBLIC_ORIGIN");
      expect(why).not.toContain(origin);
    }
    expect(Exit.isSuccess(starting("https://leaf.seqwawa.com"))).toBe(true);
  });

  it("refuses a port that is not a port number", () => {
    expect(() => readSettings({ PORT: "eighty" })).toThrow("PORT");
  });
});
