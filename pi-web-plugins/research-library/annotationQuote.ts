import { MAX_RESEARCH_ANNOTATION_QUOTE, type ResearchAnnotationRect } from "./annotationModel.js";

/** One PDF text run expressed as a page-fraction box, in PDF.js reading order. */
export interface QuoteTextItem extends ResearchAnnotationRect {
  text: string;
}

/** The subset of a PDF.js `getTextContent()` item this module understands. */
export interface PdfTextContentItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
}

const MINIMUM_OVERLAP_RATIO = 0.5;

/**
 * Convert PDF.js text items into page-fraction boxes. PDF text space is
 * bottom-up, so the box is flipped into the top-down page box used by
 * annotation rectangles. Rotated pages are approximated by this flip; items
 * that fall outside the page box are dropped rather than clamped into it.
 */
export function textItemsToQuoteItems(items: readonly PdfTextContentItem[], pageWidth: number, pageHeight: number): QuoteTextItem[] {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return [];
  const quoteItems: QuoteTextItem[] = [];
  for (const item of items) {
    const text = typeof item.str === "string" ? item.str : "";
    if (text.trim() === "") continue;
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const originX = finiteNumber(transform[4]);
    const originY = finiteNumber(transform[5]);
    const width = finiteNumber(item.width);
    const height = finiteNumber(item.height);
    if (originX === undefined || originY === undefined || width === undefined || height === undefined) continue;
    if (width <= 0 || height <= 0) continue;

    const top = pageHeight - (originY + height);
    const box: QuoteTextItem = {
      text,
      x: originX / pageWidth,
      y: top / pageHeight,
      width: width / pageWidth,
      height: height / pageHeight,
    };
    if (box.x > 1 || box.y > 1 || box.x + box.width < 0 || box.y + box.height < 0) continue;
    quoteItems.push(box);
  }
  return quoteItems;
}

/**
 * Join every text run that meaningfully overlaps `rect` into one quote,
 * grouping runs into lines, repairing hyphenation, and bounding the result.
 */
export function quoteFromTextItems(items: readonly QuoteTextItem[], rect: ResearchAnnotationRect, maxLength = MAX_RESEARCH_ANNOTATION_QUOTE): string {
  const selected = items.filter((item) => overlapRatio(item, rect) >= MINIMUM_OVERLAP_RATIO);
  if (selected.length === 0) return "";

  const lines = groupIntoLines(selected);
  const text = lines.map(renderLine).reduce(joinLines, "");
  return boundQuote(text.replace(/[ \t]+/gu, " ").trim(), maxLength);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function overlapRatio(item: QuoteTextItem, rect: ResearchAnnotationRect): number {
  const overlapWidth = Math.min(item.x + item.width, rect.x + rect.width) - Math.max(item.x, rect.x);
  const overlapHeight = Math.min(item.y + item.height, rect.y + rect.height) - Math.max(item.y, rect.y);
  if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
  const area = item.width * item.height;
  return area <= 0 ? 0 : (overlapWidth * overlapHeight) / area;
}

function groupIntoLines(items: readonly QuoteTextItem[]): QuoteTextItem[][] {
  const ordered = [...items].sort((left, right) => centerY(left) - centerY(right) || left.x - right.x);
  const lines: QuoteTextItem[][] = [];
  let current: QuoteTextItem[] = [];
  let currentCenter = 0;
  for (const item of ordered) {
    const center = centerY(item);
    if (current.length > 0 && Math.abs(center - currentCenter) > item.height * 0.6) {
      lines.push(current);
      current = [];
    }
    if (current.length === 0) currentCenter = center;
    current.push(item);
  }
  if (current.length > 0) lines.push(current);
  return lines.map((line) => [...line].sort((left, right) => left.x - right.x));
}

function renderLine(line: readonly QuoteTextItem[]): string {
  let text = "";
  let previous: QuoteTextItem | undefined;
  for (const item of line) {
    if (previous !== undefined && needsSpace(previous, item, text)) text += " ";
    text += item.text;
    previous = item;
  }
  return text.trim();
}

function needsSpace(previous: QuoteTextItem, item: QuoteTextItem, text: string): boolean {
  if (text.endsWith(" ") || item.text.startsWith(" ")) return false;
  const gap = item.x - (previous.x + previous.width);
  return gap > previous.height * 0.2;
}

function joinLines(text: string, line: string): string {
  if (text === "") return line;
  if (line === "") return text;
  // Repair the hyphenation these two-column papers use at line ends.
  if (/[\p{Ll}]-$/u.test(text) && /^[\p{Ll}]/u.test(line)) return `${text.slice(0, -1)}${line}`;
  return `${text} ${line}`;
}

function boundQuote(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength - 1);
  const boundary = truncated.lastIndexOf(" ");
  return `${(boundary > maxLength / 2 ? truncated.slice(0, boundary) : truncated).trimEnd()}…`;
}

function centerY(item: QuoteTextItem): number {
  return item.y + item.height / 2;
}
