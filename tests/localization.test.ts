import { afterEach, describe, expect, it } from "vitest";
import en from "../src/localization/locales/en.json";
import ja from "../src/localization/locales/ja.json";
import { setLocale, textOf, translate, translateCount } from "../src/localization";

const PARAM = /\{\{(\w+)\}\}/g;
const paramsOf = (text: string) => [...text.matchAll(PARAM)].map((match) => match[1]).sort();

afterEach(() => setLocale("en"));

describe("localization", () => {
  it("has every key in both languages, with the same params", () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    for (const [key, text] of Object.entries(en)) {
      expect(paramsOf(ja[key as keyof typeof ja]), key).toEqual(paramsOf(text));
      expect(ja[key as keyof typeof ja], key).not.toBe("");
    }
  });

  it("fills params, picks the plural form and follows the language", () => {
    expect(translate("placeholder_connecting", { url: "http://host" })).toBe("Connecting to http://host...");
    expect(translateCount("copied_lines", 1)).toBe("Copied 1 line");
    expect(translateCount("copied_lines", 1200)).toBe("Copied 1,200 lines");
    setLocale("ja");
    expect(translateCount("copied_lines", 3)).toBe("3 行をコピーしました");
    expect(textOf({ key: "live_error_refused", params: { url: "x" } })).toBe("x が拒否されました");
    // text from the system is shown as it is
    expect(textOf("ENOENT")).toBe("ENOENT");
  });
});
