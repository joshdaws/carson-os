import { describe, it, expect } from "vitest";
import { getGreeting } from "@/pages/Dashboard";

// Pin the time-aware greeting bands so a future "let's tighten this" PR
// fails the test before users at 4am suddenly read "Good morning" or users
// at 6pm read "Good afternoon." The bands are documented in DESIGN.md's
// butler-on-duty model and the empty-Dashboard hero copy depends on them.

describe("getGreeting", () => {
  function at(h: number, m = 0): Date {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }

  it("returns Good evening for the 00:00–04:59 band (late-night/pre-dawn)", () => {
    expect(getGreeting(at(0))).toBe("Good evening");
    expect(getGreeting(at(2))).toBe("Good evening");
    expect(getGreeting(at(4, 59))).toBe("Good evening");
  });

  it("returns Good morning for the 05:00–11:59 band", () => {
    expect(getGreeting(at(5))).toBe("Good morning");
    expect(getGreeting(at(8, 30))).toBe("Good morning");
    expect(getGreeting(at(11, 59))).toBe("Good morning");
  });

  it("returns Good afternoon for the 12:00–17:59 band", () => {
    expect(getGreeting(at(12))).toBe("Good afternoon");
    expect(getGreeting(at(14, 30))).toBe("Good afternoon");
    expect(getGreeting(at(17, 59))).toBe("Good afternoon");
  });

  it("returns Good evening for the 18:00–23:59 band", () => {
    expect(getGreeting(at(18))).toBe("Good evening");
    expect(getGreeting(at(21, 0))).toBe("Good evening");
    expect(getGreeting(at(23, 59))).toBe("Good evening");
  });

  it("crosses bands at the documented boundary hours", () => {
    expect(getGreeting(at(4, 59))).toBe("Good evening");
    expect(getGreeting(at(5, 0))).toBe("Good morning");
    expect(getGreeting(at(11, 59))).toBe("Good morning");
    expect(getGreeting(at(12, 0))).toBe("Good afternoon");
    expect(getGreeting(at(17, 59))).toBe("Good afternoon");
    expect(getGreeting(at(18, 0))).toBe("Good evening");
  });
});
