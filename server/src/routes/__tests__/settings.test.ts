import { describe, expect, it } from "vitest";
import { publicSettingsFromRows } from "../settings.js";

describe("publicSettingsFromRows", () => {
  it("redacts saved secret setting values and reports presence separately", () => {
    const { settings, savedSecretKeys } = publicSettingsFromRows([
      { key: "HOUSEHOLD_NAME", value: "Carson" },
      { key: "GROQ_API_KEY", value: "gsk_secret_value" },
      { key: "ANTHROPIC_API_KEY", value: "sk-ant-secret-value" },
    ]);

    expect(settings).toEqual({
      HOUSEHOLD_NAME: "Carson",
      GROQ_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    });
    expect(savedSecretKeys).toEqual(["GROQ_API_KEY", "ANTHROPIC_API_KEY"]);
  });

  it("does not report empty secret settings as saved", () => {
    const { settings, savedSecretKeys } = publicSettingsFromRows([
      { key: "GROQ_API_KEY", value: "" },
    ]);

    expect(settings).toEqual({ GROQ_API_KEY: "" });
    expect(savedSecretKeys).toEqual([]);
  });

  it("does not redact unknown non-secret settings", () => {
    const { settings, savedSecretKeys } = publicSettingsFromRows([
      { key: "ADAPTER_TYPE", value: "anthropic-sdk" },
      { key: "CUSTOM_HEADER", value: "not-classified-as-secret" },
    ]);

    expect(settings).toEqual({
      ADAPTER_TYPE: "anthropic-sdk",
      CUSTOM_HEADER: "not-classified-as-secret",
    });
    expect(savedSecretKeys).toEqual([]);
  });
});
