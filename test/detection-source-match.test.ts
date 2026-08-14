import { describe, expect, it } from "vitest";
import { matchesDetectionSource } from "../src/detectionSourceMatch";
import type { ScryptedEventSource as Source } from "../src/utils";

// String literals rather than the enum: importing it would pull in the
// Scrypted SDK, which needs a live host. The enum is a string enum, so the
// values are identical.
const ScryptedEventSource = {
  Default: "Default",
  All: "All",
  RawDetection: "RawDetection",
  Onboard: "Onboard",
  NVR: "NVR",
  Frigate: "Frigate",
} as unknown as Record<string, Source>;

const NVR = ScryptedEventSource.NVR;
const RAW = ScryptedEventSource.RawDetection;

describe("matchesDetectionSource", () => {
  it("matches when the rule names the same source as the event", () => {
    expect(
      matchesDetectionSource({
        ruleSource: NVR,
        eventSource: NVR,
        defaultSource: NVR,
      }),
    ).toBe(true);
  });

  it("rejects a rule bound to a different source", () => {
    expect(
      matchesDetectionSource({
        ruleSource: ScryptedEventSource.Frigate,
        eventSource: NVR,
        defaultSource: NVR,
      }),
    ).toBe(false);
  });

  describe("Default — the value of a rule that was never explicitly saved", () => {
    // The settings form shows NVR as its `defaultValue`, but that is display
    // only: leave the field untouched and nothing is written to storage, so
    // the rule reads back as `Default`. Comparing that raw against an
    // incoming "NVR" event is what silently dropped these rules.
    it("resolves to the plugin default, so an untouched rule still sees NVR events", () => {
      expect(
        matchesDetectionSource({
          ruleSource: ScryptedEventSource.Default,
          eventSource: NVR,
          defaultSource: NVR,
        }),
      ).toBe(true);
    });

    it("treats a missing value the same as Default", () => {
      expect(
        matchesDetectionSource({
          ruleSource: undefined,
          eventSource: NVR,
          defaultSource: NVR,
        }),
      ).toBe(true);
    });

    it("does not blanket-accept: it follows whatever the default actually is", () => {
      // With no NVR device the plugin default is not NVR, and an untouched
      // rule must not start matching NVR events out of nowhere.
      expect(
        matchesDetectionSource({
          ruleSource: ScryptedEventSource.Default,
          eventSource: NVR,
          defaultSource: RAW,
        }),
      ).toBe(false);
      expect(
        matchesDetectionSource({
          ruleSource: ScryptedEventSource.Default,
          eventSource: RAW,
          defaultSource: RAW,
        }),
      ).toBe(true);
    });
  });

  describe("All — a selectable choice that matched nothing", () => {
    it.each([NVR, RAW, ScryptedEventSource.Frigate, ScryptedEventSource.Onboard])(
      "accepts an event from %s",
      (eventSource) => {
        expect(
          matchesDetectionSource({
            ruleSource: ScryptedEventSource.All,
            eventSource,
            defaultSource: NVR,
          }),
        ).toBe(true);
      },
    );

    it("also applies when All arrives via the default", () => {
      expect(
        matchesDetectionSource({
          ruleSource: ScryptedEventSource.Default,
          eventSource: ScryptedEventSource.Frigate,
          defaultSource: ScryptedEventSource.All,
        }),
      ).toBe(true);
    });
  });
});
