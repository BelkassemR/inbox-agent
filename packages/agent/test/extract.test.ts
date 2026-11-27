import { describe, expect, it } from "vitest";
import { classify, detectLanguage, extractAudience, extractBudget, extractDate } from "../src/scripted/extract.ts";

describe("scripted extractor", () => {
  it.each([
    ["op 14 juni 2027", "2027-06-14"],
    ["on June 14, 2027", "2027-06-14"],
    ["le 3 mars 2027", "2027-03-03"],
    ["datum: 2027-06-14", "2027-06-14"],
    ["14-06-2027", "2027-06-14"],
    ["op 2 januari", "2027-01-02"], // no year and already past → next year
  ])("parses %s", (text, expected) => expect(extractDate(text, "2026-11-27")).toBe(expected));

  it("parses amounts", () => {
    expect(extractBudget("budget €12.000")).toBe(12000);
    expect(extractBudget("around 20k EUR")).toBe(20000);
    expect(extractBudget("2.500 euro")).toBe(2500);
    expect(extractAudience("zo'n 5.000 bezoekers")).toBe(5000);
  });

  it("detects language and category", () => {
    expect(detectLanguage("Hoi, wij willen je graag boeken voor een feest")).toBe("nl");
    expect(detectLanguage("Hi, we would love to have you")).toBe("en");
    expect(classify("Win bitcoin now, click here").category).toBe("spam");
    expect(classify("Interview voor onze podcast").category).toBe("press");
  });
});
