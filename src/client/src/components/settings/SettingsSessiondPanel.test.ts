import { describe, expect, it } from "vitest";
import { sessiondPanelNotices } from "./SettingsSessiondPanel";

// Notice composition is pure; localized scope/restart guidance is covered by DOM tests.

describe("session daemon panel notices", () => {
  it("orders save/load error notices before the saved confirmation", () => {
    const notices = sessiondPanelNotices({
      error: "Failed to save session-daemon config.",
      savedMessage: "Session daemon settings saved.",
    });

    expect(notices).toEqual([
      { type: "error", content: "Failed to save session-daemon config." },
      { type: "success", content: "Session daemon settings saved." },
    ]);
  });

  it("reports only the blocking error when config is unavailable", () => {
    const notices = sessiondPanelNotices({
      error: "Could not reach Lab Mac for selected-machine settings. Check the machine connection and try again.",
      savedMessage: "",
    });

    expect(notices).toEqual([
      { type: "error", content: "Could not reach Lab Mac for selected-machine settings. Check the machine connection and try again." },
    ]);
  });

  it("reports nothing when there is no error or saved confirmation", () => {
    expect(sessiondPanelNotices({ error: "", savedMessage: "" })).toEqual([]);
  });
});
