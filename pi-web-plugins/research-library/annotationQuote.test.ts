import { describe, expect, it } from "vitest";
import { quoteFromTextItems, textItemsToQuoteItems, type QuoteTextItem } from "./annotationQuote.js";

describe("textItemsToQuoteItems", () => {
  it("flips bottom-up PDF text boxes into top-down page fractions", () => {
    const items = textItemsToQuoteItems([{ str: "Mip-NeRF", transform: [10, 0, 0, 10, 100, 700], width: 50, height: 10 }], 500, 1_000);

    expect(items).toEqual([{ text: "Mip-NeRF", x: 0.2, y: 0.29, width: 0.1, height: 0.01 }]);
  });

  it("drops blank, malformed, degenerate, and off-page runs", () => {
    const items = textItemsToQuoteItems([
      { str: "   ", transform: [1, 0, 0, 1, 10, 10], width: 5, height: 5 },
      { str: "missing transform", width: 5, height: 5 },
      { str: "short transform", transform: [1, 0, 0, 1, 10], width: 5, height: 5 },
      { str: "no size", transform: [1, 0, 0, 1, 10, 10], width: 0, height: 5 },
      { str: "not finite", transform: [1, 0, 0, 1, Number.NaN, 10], width: 5, height: 5 },
      { str: "off page", transform: [1, 0, 0, 1, 900, 10], width: 5, height: 5 },
      { str: "kept", transform: [1, 0, 0, 1, 10, 10], width: 5, height: 5 },
    ], 100, 100);

    expect(items.map((item) => item.text)).toEqual(["kept"]);
  });

  it("returns nothing for a degenerate page box", () => {
    expect(textItemsToQuoteItems([{ str: "x", transform: [1, 0, 0, 1, 1, 1], width: 1, height: 1 }], 0, 100)).toEqual([]);
  });
});

describe("quoteFromTextItems", () => {
  it("reads selected runs in line order and repairs end-of-line hyphenation", () => {
    const items: QuoteTextItem[] = [
      { text: "By efficiently rendering anti-", x: 0.1, y: 0.10, width: 0.5, height: 0.02 },
      { text: "aliased conical frustums", x: 0.1, y: 0.14, width: 0.4, height: 0.02 },
    ];

    expect(quoteFromTextItems(items, { x: 0.05, y: 0.05, width: 0.9, height: 0.2 }))
      .toBe("By efficiently rendering antialiased conical frustums");
  });

  it("separates runs only where the page leaves a horizontal gap", () => {
    const items: QuoteTextItem[] = [
      { text: "mip", x: 0.10, y: 0.10, width: 0.05, height: 0.02 },
      { text: "-NeRF", x: 0.15, y: 0.10, width: 0.05, height: 0.02 },
      { text: "extends", x: 0.28, y: 0.10, width: 0.08, height: 0.02 },
    ];

    expect(quoteFromTextItems(items, { x: 0, y: 0, width: 1, height: 1 })).toBe("mip-NeRF extends");
  });

  it("ignores runs that barely clip the drawn rectangle", () => {
    const items: QuoteTextItem[] = [
      { text: "inside", x: 0.20, y: 0.20, width: 0.10, height: 0.02 },
      { text: "clipped", x: 0.48, y: 0.20, width: 0.10, height: 0.02 },
    ];

    expect(quoteFromTextItems(items, { x: 0.15, y: 0.15, width: 0.35, height: 0.1 })).toBe("inside");
  });

  it("returns an empty quote when the selection holds no text", () => {
    expect(quoteFromTextItems([{ text: "elsewhere", x: 0.8, y: 0.8, width: 0.1, height: 0.02 }], { x: 0.1, y: 0.1, width: 0.2, height: 0.2 })).toBe("");
    expect(quoteFromTextItems([], { x: 0.1, y: 0.1, width: 0.2, height: 0.2 })).toBe("");
  });

  it("bounds an oversized quote at a word boundary", () => {
    const items: QuoteTextItem[] = [{ text: `${"word ".repeat(40)}tail`, x: 0.1, y: 0.1, width: 0.5, height: 0.02 }];

    const quote = quoteFromTextItems(items, { x: 0, y: 0, width: 1, height: 1 }, 50);

    expect(quote.length).toBeLessThanOrEqual(50);
    expect(quote.endsWith("…")).toBe(true);
    expect(quote.startsWith("word word")).toBe(true);
  });
});
