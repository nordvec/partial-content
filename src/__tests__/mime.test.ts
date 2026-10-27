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

    test("resolves streaming manifests and timed text", () => {
        expect(lookupMime("stream/index.m3u8")).toBe("application/vnd.apple.mpegurl");
        expect(lookupMime("captions.vtt")).toBe("text/vtt");
        expect(lookupMime("captions.srt")).toBe("application/x-subrip");
    });

    test("SubRip keeps the x- subtype that marks it unregistered", () => {
        // No IANA registration exists, so a standard-looking name would assert
        // one that cannot be cited (RFC 6838 Section 3.4).
        expect(lookupMime("captions.srt")?.startsWith("application/x-")).toBe(true);
    });

    test("resolves source maps and YAML", () => {
        expect(lookupMime("bundle.js.map")).toBe("application/json");
        expect(lookupMime("compose.yaml")).toBe("application/yaml");
        expect(lookupMime("compose.yml")).toBe("application/yaml");
    });

    test("install-prompting and browser-obsolete formats stay absent", () => {
        // The map is curated for XSS and download safety, not coverage: an
        // entry is an assertion that serving that type is safe by default.
        expect(lookupMime("app.apk")).toBeUndefined();
        expect(lookupMime("font.eot")).toBeUndefined();
        expect(lookupMime("photo.jxl")).toBeUndefined();
    });
});

describe("lookupMime prototype safety", () => {
    test("Object.prototype member names never resolve to a MIME", () => {
        expect(lookupMime("file.constructor")).toBeUndefined();
        expect(lookupMime("file.__proto__")).toBeUndefined();
        expect(lookupMime("file.hasOwnProperty")).toBeUndefined();
        expect(lookupMime("constructor")).toBeUndefined();
    });
});

describe("lookupMime web assets are opt-in", () => {
    test("script, style and wasm extensions are unknown by default", () => {
        for (const name of ["app.js", "mod.mjs", "site.css", "lib.wasm"]) {
            expect(lookupMime(name)).toBeUndefined();
        }
    });

    test("{ webAssets: true } resolves them", () => {
        expect(lookupMime("app.js", { webAssets: true })).toBe("text/javascript");
        expect(lookupMime("MOD.MJS", { webAssets: true })).toBe("text/javascript");
        expect(lookupMime("site.css", { webAssets: true })).toBe("text/css");
        expect(lookupMime("lib.wasm", { webAssets: true })).toBe("application/wasm");
    });

    test("the opt-in keeps every document type and prototype safety", () => {
        expect(lookupMime("report.pdf", { webAssets: true })).toBe("application/pdf");
        expect(lookupMime("file.constructor", { webAssets: true })).toBeUndefined();
        expect(lookupMime("file.__proto__", { webAssets: true })).toBeUndefined();
    });
});
