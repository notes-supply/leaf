/**
 * The raid in a Discord call. Discord opens the raid's page in its own frame, at its proxy for Leaf,
 * with what it is launching in the page's query: the frame, the platform, and the launch itself
 * (`instance_id`), which everyone in the call who opens it shares. The page in a call is the raid
 * alone: the call's table, and nothing of the rest of Leaf.
 */

/** Discord's launch of the raid, as the page's query names it. */
export interface Launch {
  /** The launch, one for everyone in the call who opens it: Leaf seats them all at its table. */
  readonly instance: string;
}

/** Discord's launch in a query, or null for a page Discord did not open. */
export function launchOf(search: string): Launch | null {
  const query = new URLSearchParams(search);
  const instance = query.get("instance_id") ?? "";
  return instance !== "" && (query.get("frame_id") ?? "") !== "" ? { instance } : null;
}

/** This page's launch: read once, as the page's address never changes under it. */
export const LAUNCH: Launch | null = typeof location === "undefined" ? null : launchOf(location.search);

/** Whether the page is the raid in a Discord call. */
export const inCall = (): boolean => LAUNCH !== null;
