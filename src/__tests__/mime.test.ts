import { describe, test, expect } from "bun:test";
import { lookupMime } from "../mime";

describe("lookupMime", () => {
    test("resolves common document types", () => {
        expect(lookupMime("report.pdf")).toBe("application/pdf");
        expect(lookupMime("data.csv")).toBe("text/csv");
        expect(lookupMime("notes.md")).toBe("text/markdown");
        expect(lookupMime("contract.docx")).toBe(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
    });

    test("resolves media types", () => {
        expect(lookupMime("video.mp4")).toBe("video/mp4");
        expect(lookupMime("song.mp3")).toBe("audio/mpeg");
        expect(lookupMime("photo.webp")).toBe("image/webp");
        expect(lookupMime("icon.svg")).toBe("image/svg+xml");
    });

    test("is case-insensitive", () => {
        expect(lookupMime("Q4 Report.PDF")).toBe("application/pdf");
        expect(lookupMime("IMAGE.JpEg")).toBe("image/jpeg");
    });

    test("uses the last dot segment (storage keys, double extensions)", () => {
        expect(lookupMime("2025/reports/summary.pdf")).toBe("application/pdf");
        expect(lookupMime("archive.tar.gz")).toBe("application/gzip");
        expect(lookupMime("backup.2025.zip")).toBe("application/zip");
    });

    test("accepts bare extensions", () => {
        expect(lookupMime("pdf")).toBe("application/pdf");
        expect(lookupMime("7z")).toBe("application/x-7z-compressed");
    });

    test("slices the extension when the dot is at index 1 (single-char stem)", () => {
        // Pins the no-dot boundary: a single-char stem must still slice off the
        // extension, not be mistaken for a dotless bare-extension input.
        expect(lookupMime("a.pdf")).toBe("application/pdf");
        expect(lookupMime("x.mp4")).toBe("video/mp4");
    });

    test("returns undefined for unknown or missing extensions", () => {
        expect(lookupMime("file.xyz123")).toBeUndefined();
        expect(lookupMime("trailing-dot.")).toBeUndefined();
        expect(lookupMime("")).toBeUndefined();
    });

    test("tolerates null/undefined input (JS consumers, no throw)", () => {
        // The signature accepts null | undefined so JS callers passing a missing
        // key get undefined rather than a TypeError from .lastIndexOf.
        expect(lookupMime(null)).toBeUndefined();
        expect(lookupMime(undefined)).toBeUndefined();
    });

    test("html is deliberately absent (stored-XSS guard)", () => {
        expect(lookupMime("page.html")).toBeUndefined();
        expect(lookupMime("page.htm")).toBeUndefined();
        expect(lookupMime("page.xhtml")).toBeUndefined();
    });
});
