import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getLocalPilotAnnotation,
  listLocalPilotAnnotations,
  listLocalPilotPapers,
} from "./pilotCore.js";
import { RESEARCH_LIBRARY_PILOT_CONFIG_PATH, RESEARCH_LIBRARY_PILOT_RIGHTS } from "./pilotModel.js";
import { RESEARCH_LIBRARY_ANNOTATIONS_ROOT, type ResearchPilotAnnotation } from "./pilotAnnotation.js";

const roots: string[] = [];
const libraryId = "pilot-llmwiki-graphics-three";
const firstPaperId = "pilot-barron2021";
const secondPaperId = "pilot-muller2022instantngp";
const firstPdfSha = "a".repeat(64);
const secondPdfSha = "b".repeat(64);

function paper(id: string, bibkey: string, title: string, pdfSha256: string) {
  return {
    id,
    bibkey,
    title,
    authors: ["Ada Example"],
    year: 2021,
    abstract: `Abstract for ${title}`,
    sourceNotePath: `Thesis/Citations/@${bibkey}.md`,
    sourceNoteSha256: "c".repeat(64),
    relatedTopics: ["Neural Rendering"],
    metaCategories: ["Inverse Reconstruction"],
    usedBy: ["1_intro/related-work.tex"],
    pdf: {
      path: `raw/research-library-pilot/pdfs/${bibkey}.pdf`,
      sha256: pdfSha256,
      size: 4096,
      sourceUrl: "https://example.test/paper.pdf",
      sourcePageUrl: "https://example.test/paper",
      retrievedAt: "2026-08-08T12:00:00.000Z",
      rights: RESEARCH_LIBRARY_PILOT_RIGHTS,
    },
  };
}

function manifest() {
  return {
    version: 1,
    pilot: true,
    libraryId,
    papers: [paper(firstPaperId, "Barron2021", "Mip-NeRF", firstPdfSha), paper(secondPaperId, "Muller2022InstantNGP", "Instant-NGP", secondPdfSha)],
  };
}

function annotation(overrides: Partial<ResearchPilotAnnotation> = {}): ResearchPilotAnnotation {
  return {
    version: 1,
    id: "ann-0123456789abcdef0123456789abcdef",
    libraryId,
    paperId: firstPaperId,
    pdfSha256: firstPdfSha,
    page: 2,
    rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.05 },
    quote: "A selected passage.",
    kind: "question",
    body: "What does this imply?",
    status: "open",
    createdAt: "2026-08-08T12:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-pilot-core-"));
  roots.push(root);
  await mkdir(join(root, ".pi-web"), { recursive: true });
  await mkdir(join(root, "raw", "_processed", "research-library-pilot"), { recursive: true });
  await writeFile(join(root, RESEARCH_LIBRARY_PILOT_CONFIG_PATH), `${JSON.stringify(manifest())}\n`);
  return root;
}

async function writeAnnotation(root: string, value: ResearchPilotAnnotation, fileName = `${value.id}.json`): Promise<void> {
  const directory = join(root, ...RESEARCH_LIBRARY_ANNOTATIONS_ROOT.split("/"), value.paperId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), `${JSON.stringify(value)}\n`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local pilot read core", () => {
  it("lists manifest papers and counts only annotations bound to the current PDF", async () => {
    const root = await setup();
    await writeAnnotation(root, annotation());
    await writeAnnotation(root, annotation({ id: "ann-fedcba9876543210fedcba9876543210", status: "resolved", kind: "note" }));
    await writeAnnotation(root, annotation({ id: "ann-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", pdfSha256: secondPdfSha }), "ann-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json");

    const result = await listLocalPilotPapers(root);

    expect(result.papers.map((item) => [item.id, item.annotationCount, item.openAnnotationCount])).toEqual([
      [firstPaperId, 2, 1],
      [secondPaperId, 0, 0],
    ]);
    expect(result.warnings.join(" ")).toContain("different PDF revision");
    expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("filters annotation summaries and keeps quote/body previews bounded", async () => {
    const root = await setup();
    await writeAnnotation(root, annotation({ quote: "q".repeat(2_000), body: "b".repeat(2_000) }));
    await writeAnnotation(root, annotation({ id: "ann-fedcba9876543210fedcba9876543210", kind: "note", status: "resolved" }));

    const result = await listLocalPilotAnnotations(root, { paperId: firstPaperId, kind: "question", status: "open", limit: 1 });

    expect(result.matchedAnnotationCount).toBe(1);
    expect(result.returnedAnnotationCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.annotations[0]?.quote.length).toBeLessThanOrEqual(1_001);
    expect(result.annotations[0]?.quoteTruncated).toBe(true);
    expect(result.annotations[0]?.bodyTruncated).toBe(true);
  });

  it("returns a complete annotation context and rejects a missing record", async () => {
    const root = await setup();
    const stored = annotation();
    await writeAnnotation(root, stored);

    await expect(getLocalPilotAnnotation(root, firstPaperId, stored.id)).resolves.toMatchObject({
      libraryId,
      paper: { bibkey: "Barron2021", title: "Mip-NeRF", pdf: { sha256: firstPdfSha } },
      annotation: stored,
    });
    await expect(getLocalPilotAnnotation(root, firstPaperId, "ann-fedcba9876543210fedcba9876543210")).rejects.toThrow("does not exist");
  });

  it("reports malformed, foreign, and incorrectly named files instead of treating them as annotations", async () => {
    const root = await setup();
    await writeAnnotation(root, annotation({ id: "ann-fedcba9876543210fedcba9876543210", libraryId: "pilot-other-library" }));
    await writeAnnotation(root, annotation({ id: "ann-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), "bad-name.json");
    await writeAnnotation(root, annotation(), "ann-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json");

    const result = await listLocalPilotAnnotations(root);

    expect(result.annotations).toHaveLength(0);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join(" ")).toMatch(/different library|invalid annotation filename|does not match its file name/u);
  });

  it("fails closed when the manifest is malformed or a requested paper is unknown", async () => {
    const root = await setup();
    await writeFile(join(root, RESEARCH_LIBRARY_PILOT_CONFIG_PATH), "{\n");
    await expect(listLocalPilotPapers(root)).rejects.toThrow("Invalid pilot JSON");

    const repaired = await setup();
    await expect(listLocalPilotAnnotations(repaired, { paperId: "pilot-missing" })).rejects.toThrow("does not exist");
  });
});
