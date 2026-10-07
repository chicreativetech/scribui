import { describe, expect, it } from "vitest";
import { activityTitle, liveInput } from "../src/deviceInput.js";

describe("device tab input from the canvas", () => {
  it("passes well-formed input through", () => {
    expect(liveInput({ type: "pointer", action: "down", x: 0.2, y: 1 })).toEqual({ type: "pointer", action: "down", x: 0.2, y: 1 });
    expect(liveInput({ type: "key", key: "back" })).toEqual({ type: "key", key: "back" });
    expect(liveInput({ type: "edit", key: "backspace" })).toEqual({ type: "edit", key: "backspace" });
    expect(liveInput({ type: "text", text: "wifi" })).toEqual({ type: "text", text: "wifi" });
    expect(liveInput({ type: "rotate", extra: "ignored" })).toEqual({ type: "rotate" });
  });

  it("clamps scroll amounts to scrcpy's range", () => {
    expect(liveInput({ type: "scroll", x: 0.5, y: 0.5, dx: 0, dy: -400 })).toEqual({ type: "scroll", x: 0.5, y: 0.5, dx: 0, dy: -16 });
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      "tap",
      { type: "pointer", action: "down", x: 2, y: 0.5 },
      { type: "pointer", action: "click", x: 0.5, y: 0.5 },
      { type: "pointer", action: "down", x: "0.5", y: 0.5 },
      { type: "key", key: "volume_up" },
      { type: "edit", key: "F1" },
      { type: "text", text: "" },
      { type: "text", text: "x".repeat(2001) },
      { type: "shell", cmd: "reboot" },
      { type: "scroll", x: 0.5, y: 0.5, dx: Number.NaN, dy: 1 },
    ])
      expect(liveInput(bad)).toBeNull();
  });
});

describe("naming a captured view", () => {
  it("uses the resumed activity's class, as words", () => {
    expect(activityTitle("    topResumedActivity=ActivityRecord{82323659 u0 com.google.android.settings.intelligence/.modules.search.SearchActivity t52}")).toBe(
      "Search",
    );
    expect(activityTitle("  ResumedActivity: ActivityRecord{1 u0 com.android.settings/.wifi.WifiSettingsActivity t9}")).toBe("Wifi Settings");
    expect(activityTitle("  mResumedActivity: ActivityRecord{1 u0 com.example/com.example.ui.URLPreviewActivity t3}")).toBe("URL Preview");
  });

  it("has no name for a generic main activity or nothing in front", () => {
    expect(activityTitle("topResumedActivity=ActivityRecord{1 u0 com.example/.MainActivity t3}")).toBeNull();
    expect(activityTitle("no activities")).toBeNull();
  });
});
