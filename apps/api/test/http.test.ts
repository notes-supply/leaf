import { describe, expect, it } from "bun:test";

import { DEFAULT_RULES, RULE_CHANGES } from "@sequoia-leaf/core";
import { Schema } from "effect";

import { rateCard } from "../src/announce/rate-card.ts";
import { testLeaf } from "./support.ts";

/** The parts of an OpenAPI document these tests read. */
const OpenApiDocument = Schema.decodeUnknownSync(
  Schema.Struct({
    paths: Schema.Record(Schema.String, Schema.Unknown),
    components: Schema.Struct({
      securitySchemes: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
    }),
  }),
);

const noBackend = () => Promise.reject(new Error("No backend in this test"));
const app = testLeaf({ now: 0 }, noBackend).app();

describe("HTTP", () => {
  it("reports healthy", async () => {
    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("tells anyone, signed in or not, what Leaf pays, in the rate card's own words", async () => {
    const response = await app.request("/v1/rates");
    const card = rateCard(DEFAULT_RULES, RULE_CHANGES);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.json()).toEqual({
      title: card.title,
      description: card.description,
      sections: card.fields.map((field) => ({ name: field.name, text: field.value })),
      changed_at: card.timestamp ?? null,
    });
  });

  it("answers an unknown route with the standard error shape", async () => {
    const requests = [
      ["/nope", "GET"],
      ["/", "GET"],
      ["/healthz/", "GET"],
      ["/healthz", "POST"],
    ] as const;
    const answers = await Promise.all(
      requests.map(async ([path, method]) => {
        const response = await app.request(path, { method });
        return [response.status, await response.json()];
      }),
    );

    expect(answers).toEqual(requests.map(() => [404, { code: "not_found", message: "No such route" }]));
  });

  it("answers a failure nothing expected with the standard error shape", async () => {
    // A backend that confirms any session as a member's.
    const broken = testLeaf({ now: 0 }, () =>
      Promise.resolve(
        Response.json({
          minecraft_uuid: "10000000-0000-0000-0000-000000000001",
          minecraft_username: "Alice",
          guild_rank: "Member",
        }),
      ),
    );
    const brokenApp = broken.app();
    await broken.query((sql) => sql`DROP TABLE accounts`);

    const response = await brokenApp.request("/v1/me", { headers: { Authorization: "Bearer alice-token" } });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "internal_error", message: "Something went wrong" });
    await brokenApp.dispose();
    await broken.dispose();
  });

  it("describes itself as an OpenAPI document, sessions included", async () => {
    const document = OpenApiDocument(await (await app.request("/openapi.json")).json());

    expect(Object.keys(document.paths).toSorted()).toEqual([
      "/healthz",
      "/internal/v1/players/{player}/leaf",
      "/internal/v1/purchases/{key}",
      "/v1/game/admin/activity",
      "/v1/game/admin/grants",
      "/v1/game/banners",
      "/v1/game/camps",
      "/v1/game/camps/visitors",
      "/v1/game/camps/{player}/like",
      "/v1/game/guild/events",
      "/v1/game/guild/events/stream",
      "/v1/game/hello",
      "/v1/game/me",
      "/v1/game/page-errors",
      "/v1/game/people/{player}",
      "/v1/game/play/{game}",
      "/v1/game/play/{game}/of/{player}",
      "/v1/game/play/{game}/standings",
      "/v1/game/presence",
      "/v1/game/raid/depths/{way}/{span}",
      "/v1/game/raid/held",
      "/v1/game/requests",
      "/v1/game/sittings",
      "/v1/game/sittings/call",
      "/v1/game/sittings/record",
      "/v1/game/sittings/{id}",
      "/v1/game/skins/{uuid}",
      "/v1/game/tally/{board}/{period}",
      "/v1/me",
      "/v1/me/events",
      "/v1/me/events/stream",
      "/v1/me/quests",
      "/v1/me/quests/{id}/reroll",
      "/v1/rates",
    ]);
    expect(Object.values(document.components.securitySchemes)).toEqual([
      expect.objectContaining({ type: "http", scheme: "Bearer" }),
      expect.objectContaining({ type: "apiKey", in: "cookie", name: "seq_session" }),
    ]);
  });
});
