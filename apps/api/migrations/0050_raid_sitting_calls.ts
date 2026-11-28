import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The raid in a Discord call (`http/activity.ts`): which sitting each launch of it in a call sits at.
// Discord names a launch (`instance`); everyone who opens that launch sits at its one sitting, the
// first to come having opened it. A launch has one sitting at a time and a sitting one launch; a new
// one takes the launch's place once its last is over. The row goes with its sitting, when Leaf lets
// the sitting go a day after it ended.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE raid_sitting_calls (
      instance TEXT    PRIMARY KEY,
      sitting  TEXT    NOT NULL UNIQUE REFERENCES raid_sittings (id) ON DELETE CASCADE,
      since    INTEGER NOT NULL
    ) STRICT
  `;
});
