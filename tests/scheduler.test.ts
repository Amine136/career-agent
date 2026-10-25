import { describe, expect, it } from "vitest";
import { SCHEDULE_CRON } from "../src/scheduler/index.js";
import { SCORE_SCHEDULE_CRON } from "../src/score/cli.js";

describe("scheduler", () => {
  it("runs every 3 days at 06:00", () => {
    expect(SCHEDULE_CRON).toBe("0 6 */3 * *");
  });

  it("scores daily at 09:00 UTC so leftovers carry over", () => {
    expect(SCORE_SCHEDULE_CRON).toBe("0 9 * * *");
  });
});
