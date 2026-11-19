import { describe, expect, it } from "vitest";
import { EventSummarizer } from "../../src/sdk/events/summarizer.js";

describe("EventSummarizer", () => {
  it("reports each drop in exactly one batch, since the server sums them", () => {
    const summarizer = new EventSummarizer({ maxBuckets: 1 });
    summarizer.record("a", 0, "FALLTHROUGH");
    summarizer.record("b", 0, "FALLTHROUGH"); // dropped: over the bucket cap
    expect(summarizer.flush().dropped).toBe(1);
    expect(summarizer.flush().dropped).toBe(0);
    expect(summarizer.dropped).toBe(1);
  });
});
