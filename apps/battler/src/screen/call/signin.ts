/**
 * Signing in to the raid in a Discord call, before anything else: the page asks Leaf for the Discord
 * application's id, greets Discord (its embedded app SDK, loaded only here), asks it to sign the
 * player in (`authorize`, `identify` alone, asking nothing of them when they have allowed it before),
 * and sends the code Discord gives to Leaf, which signs them in as Discord sign-in does and sets the
 * page's session. Leaf answers with the player's Discord token, handed back to Discord
 * (`authenticate`). Then the page opens as any page does (`start()`), signed in.
 */
import { ask, isRecord } from "@sequoia-leaf/kit/net.ts";
import { scope } from "@sequoia-leaf/kit/scope.ts";

/** How long Discord has to greet the page before the page says it is not in a call. */
const GREETED_WITHIN = 15_000;

/** Why the raid will not open in the call, as the page says it. */
export const CALL_WORDS = {
  notOpen: "The raid is not open in Discord yet.",
  notInCall: "Open the raid from a Discord call.",
  refused: "Discord did not sign you in. Try again.",
  noAnswer: "Leaf did not answer. Try again.",
} as const;

/** What a promise comes to, or null when it fails or does not come within `ms`. */
async function within<A>(ms: number, promise: Promise<A>): Promise<A | null> {
  const timer = { stop: (): void => undefined };
  const late = new Promise<null>((resolve) => {
    timer.stop = scope().after(ms, () => resolve(null));
  });
  try {
    return await Promise.race([promise.catch(() => null), late]);
  } finally {
    timer.stop();
  }
}

/** Leaf's word on why it did not sign the player in, or else that it did not answer. */
const leafSays = (body: unknown): string =>
  isRecord(body) && typeof body.message === "string" ? `${body.message}.` : CALL_WORDS.noAnswer;

/** Signs the player in through Discord. Null once they are; otherwise why not, in the page's words. */
export async function signInToCall(): Promise<string | null> {
  const hello = await ask("/v1/activity");
  const clientId = hello.status === 200 && isRecord(hello.body) ? hello.body.client_id : null;
  if (typeof clientId !== "string") return hello.status === 404 ? CALL_WORDS.notOpen : CALL_WORDS.noAnswer;
  const sdk = await within(
    GREETED_WITHIN,
    import("@discord/embedded-app-sdk").then(async ({ DiscordSDK }) => {
      // It reads the frame and the platform from the page's query, and throws without them.
      const made = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
      await made.ready();
      return made;
    }),
  );
  if (sdk === null) return CALL_WORDS.notInCall;
  const authorized = await sdk.commands
    .authorize({ client_id: clientId, response_type: "code", state: "", prompt: "none", scope: ["identify"] })
    .catch(() => null);
  if (authorized === null) return CALL_WORDS.refused;
  const signed = await ask("/v1/activity/sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: authorized.code }),
  });
  const token = signed.status === 200 && isRecord(signed.body) ? signed.body.access_token : null;
  if (typeof token !== "string") return leafSays(signed.body);
  // Discord's half of it: the raid uses nothing it gives, so a refusal here keeps nobody out.
  await sdk.commands.authenticate({ access_token: token }).catch(() => null);
  return null;
}
