/**
 * Tests for Content-Disposition header builder.
 *
 * Test vectors ported from RFC 6266/8187 specification examples,
 * plus security-focused tests from the existing sanitize.security.test.ts.
 *
 * Coverage:
 *   - RFC 2616 quoted-string escaping (backslash + double-quote)
 *   - RFC 8187 filename* encoding (non-ASCII, special chars)
 *   - Token optimization (unquoted for simple ASCII)
 *   - Security: CRLF injection, path traversal, control chars
 *   - Inline vs attachment disposition types
 *   - Null/empty/undefined fallback behavior
 */
import { expect, test, describe } from "bun:test";
import { buildContentDisposition, isInlineSafeMediaType } from "../index";

// ─── Basic Type Handling ────────────────────────────────────────────────────

describe("buildContentDisposition type handling", () => {
    test("defaults to attachment when no options", () => {
        const result = buildContentDisposition("report.pdf");
        expect(result).toStartWith("attachment;");
    });

    test("attachment type when explicitly set", () => {
        const result = buildContentDisposition("report.pdf", { type: "attachment" });
        expect(result).toStartWith("attachment;");
    });

    test("inline type for previewable content", () => {
        const result = buildContentDisposition("slides.pdf", { type: "inline" });
        expect(result).toStartWith("inline;");
    });

    test("inline with no filename", () => {
        const result = buildContentDisposition(null, { type: "inline" });
        expect(result).toBe('inline; filename=document');
    });

    test("inline with custom fallback", () => {
        const result = buildContentDisposition(null, { type: "inline", fallback: "preview.pdf" });
        expect(result).toBe('inline; filename=preview.pdf');
    });
});

// ─── Token Optimization (unquoted ASCII) ────────────────────────────────────

describe("buildContentDisposition token optimization", () => {
    test("simple ASCII filename emitted unquoted", () => {
        // Token chars: no spaces, no separators, no quotes
        expect(buildContentDisposition("plans.pdf")).toBe("attachment; filename=plans.pdf");
    });

    test("filename with hyphen emitted unquoted", () => {
        expect(buildContentDisposition("my-report.pdf")).toBe("attachment; filename=my-report.pdf");
    });

    test("filename with underscore emitted unquoted", () => {
        expect(buildContentDisposition("annual_report.pdf")).toBe("attachment; filename=annual_report.pdf");
    });

    test("filename with dot emitted unquoted", () => {
        expect(buildContentDisposition("v2.1.patch")).toBe("attachment; filename=v2.1.patch");
    });

    test("filename with space requires quoting", () => {
        const result = buildContentDisposition("my report.pdf");
        expect(result).toBe('attachment; filename="my report.pdf"');
    });

    test("filename with parentheses requires quoting", () => {
        const result = buildContentDisposition("report (1).pdf");
        expect(result).toBe('attachment; filename="report (1).pdf"');
    });
});

// ─── RFC 2616 Quoted-String Escaping ────────────────────────────────────────

describe("buildContentDisposition RFC 2616 quoting", () => {
    test("double-quote is escaped with backslash AND gets a filename* companion", () => {
        // RFC 2616 Section 2.2: quoted-pair = "\" CHAR. RFC 6266 Appendix D
        // advises not to rely on quoted-pair alone (user agents mishandle
        // `\"`), so a filename* parameter carries the quote unambiguously.
        const result = buildContentDisposition('the "plans".pdf');
        expect(result).toBe(
            'attachment; filename="the \\"plans\\".pdf"; filename*=UTF-8\'\'the%20%22plans%22.pdf',
        );
    });

    test("multiple double-quotes are all escaped, with filename* companion", () => {
        const result = buildContentDisposition('"a" and "b".pdf');
        expect(result).toBe(
            'attachment; filename="\\"a\\" and \\"b\\".pdf"; filename*=UTF-8\'\'%22a%22%20and%20%22b%22.pdf',
        );
    });

    test("single-quote is a valid token character (no quoting needed)", () => {
        // RFC 2616: single-quote (0x27) is NOT a separator, so it's a valid
        // token character. No quoting or filename* encoding needed.
        const result = buildContentDisposition("it's_fine.pdf");
        expect(result).toBe("attachment; filename=it's_fine.pdf");
    });
});

// ─── Backslash + Path Separator Interaction ─────────────────────────────────
//
// Our sanitizer treats backslash as a path separator (basename extraction).
// This is correct security behavior: Windows integration APIs return paths
// like "C:\Users\uploads\report.pdf" and we must extract the basename.
// Consequence: backslash never reaches the quoting layer.

describe("buildContentDisposition backslash handling", () => {
    test("backslash treated as path separator, extracts basename", () => {
        // report\2024.pdf -> split on \ -> basename is "2024.pdf"
        const result = buildContentDisposition("report\\2024.pdf");
        expect(result).toBe("attachment; filename=2024.pdf");
    });

    test("Windows path extracts basename", () => {
        const result = buildContentDisposition("C:\\Users\\uploads\\Rapport.pdf");
        expect(result).toBe("attachment; filename=Rapport.pdf");
    });

    test("trailing backslash yields empty basename, uses fallback", () => {
        const result = buildContentDisposition("report\\");
        expect(result).toBe("attachment; filename=document");
    });

    test("backslash + double-quote: basename gets quote-escaped + filename*", () => {
        // path\to\"file".pdf -> basename is '"file".pdf' -> quotes escaped,
        // plus the unambiguous filename* form for the embedded quotes.
        const result = buildContentDisposition('path\\to\\"file".pdf');
        expect(result).toBe(
            'attachment; filename="\\"file\\".pdf"; filename*=UTF-8\'\'%22file%22.pdf',
        );
    });
});

// ─── RFC 8187 Non-ASCII Encoding ────────────────────────────────────────────

describe("buildContentDisposition RFC 8187 encoding", () => {
    test("Danish filename (Å -> %C3%85)", () => {
        const result = buildContentDisposition("Årlig_Rapport.pdf");
        // ASCII fallback folds Å to its NFKD base letter A (readable, token-safe)
        expect(result).toContain("filename=Arlig_Rapport.pdf");
        // RFC 8187 encoded version
        expect(result).toContain("filename*=UTF-8''%C3%85rlig_Rapport.pdf");
    });

    test("German filename (ä -> %C3%A4)", () => {
        const result = buildContentDisposition("foo-ä.html");
        expect(result).toContain("filename=foo-a.html");
        expect(result).toContain("filename*=UTF-8''foo-%C3%A4.html");
    });

    test("Cyrillic filename", () => {
        const result = buildContentDisposition("планы.pdf");
        expect(result).toContain('filename="?????.pdf"');
        expect(result).toContain("filename*=UTF-8''%D0%BF%D0%BB%D0%B0%D0%BD%D1%8B.pdf");
    });

    test("mixed ASCII and non-ASCII", () => {
        const result = buildContentDisposition("£ and € rates.pdf");
        expect(result).toContain('filename="? and ? rates.pdf"');
        expect(result).toContain("filename*=UTF-8''%C2%A3%20and%20%E2%82%AC%20rates.pdf");
    });

    test("single quotes are percent-encoded in filename* when non-ASCII present", () => {
        // Single quotes are the delimiter in RFC 8187 format: charset'lang'value
        // They must be percent-encoded when they appear in the filename* value.
        // Use a non-ASCII filename to trigger filename* generation.
        const result = buildContentDisposition("it's_fïne.pdf");
        expect(result).toContain("filename*=UTF-8''it%27s_f%C3%AFne.pdf");
    });

    test("emoji in filename", () => {
        const result = buildContentDisposition("🔥report.pdf");
        expect(result).toContain("attachment");
        expect(result).toContain("filename*=UTF-8''");
        // ASCII fallback replaces emoji with ?
        expect(result).toContain("?report.pdf");
    });

    test("special characters in RFC 8187 encoding", () => {
        const result = buildContentDisposition("€'*%().pdf");
        // Verify the filename* contains percent-encoded special chars
        expect(result).toContain("filename*=UTF-8''");
        expect(result).toContain("%27"); // single quote
    });
});

// ─── Hex Escape Handling ────────────────────────────────────────────────────

describe("buildContentDisposition hex escapes", () => {
    test("filename with %20 uses filename* to prevent double-decode", () => {
        // Legacy clients might decode %20 -> space, so we need filename* for safety
        const result = buildContentDisposition("the%20plans.pdf");
        expect(result).toContain("filename*=UTF-8''");
        // The %20 should be double-encoded in filename* (%25 for %)
        expect(result).toContain("%2520");
    });
});

// ─── Security: CRLF Injection Prevention ────────────────────────────────────

describe("buildContentDisposition CRLF injection", () => {
    test("strips CRLF characters (header injection prevention)", () => {
        const result = buildContentDisposition("evil\r\nSet-Cookie: stolen=yes\r\n\r\nfile.txt");
        expect(result).not.toContain("\r");
        expect(result).not.toContain("\n");
        expect(result).toContain("attachment");
    });

    test("strips null bytes and control characters", () => {
        const result = buildContentDisposition("file\x00with\x01control\x7Fchars.txt");
        expect(result).not.toContain("\x00");
        expect(result).not.toContain("\x01");
        expect(result).not.toContain("\x7F");
    });

    test("strips lone CR and lone LF independently", () => {
        const crOnly = buildContentDisposition("file\rname.txt");
        expect(crOnly).not.toContain("\r");
        const lfOnly = buildContentDisposition("file\nname.txt");
        expect(lfOnly).not.toContain("\n");
    });
});

// ─── Security: Path Traversal Prevention ────────────────────────────────────

describe("buildContentDisposition path traversal", () => {
    test("strips ../ path traversal sequences", () => {
        const result = buildContentDisposition("../../etc/passwd");
        expect(result).not.toContain("..");
        expect(result).toContain("attachment");
    });

    test("strips ..\\ Windows-style path traversal", () => {
        const result = buildContentDisposition("..\\..\\windows\\system32\\config.txt");
        expect(result).not.toContain("..\\");
    });

    test("extracts basename from full directory path", () => {
        const result = buildContentDisposition("/var/uploads/secret/report.pdf");
        expect(result).toContain("report.pdf");
        expect(result).not.toContain("/var/");
    });
});

// ─── Null/Empty/Undefined Fallback ──────────────────────────────────────────

describe("buildContentDisposition fallback", () => {
    test("null input uses default fallback", () => {
        expect(buildContentDisposition(null)).toBe('attachment; filename=document');
    });

    test("undefined input uses default fallback", () => {
        expect(buildContentDisposition(undefined)).toBe('attachment; filename=document');
    });

    test("empty string uses default fallback", () => {
        expect(buildContentDisposition("")).toBe('attachment; filename=document');
    });

    test("custom fallback", () => {
        expect(buildContentDisposition(null, { fallback: "export.csv" })).toBe('attachment; filename=export.csv');
    });

    test("filename that sanitizes to empty falls through to a SANITIZED fallback", () => {
        // A filename that is only controls/bidi/path components reduces to
        // empty; the fallback must ALSO be sanitized, not emitted raw. A raw
        // fallback carrying a bidi override (U+202E) would leak an unneutralized
        // spoof into filename*, defeating the anti-spoofing guarantee.
        const result = buildContentDisposition("\x00", { fallback: "a‮exe.pdf" });
        expect(result).not.toContain("‮");
        // The RLO must not survive in either parameter (raw or percent-encoded).
        expect(result.toLowerCase()).not.toContain("%e2%80%ae");
    });

    test("both filename and fallback empty after sanitization use the constant", () => {
        expect(buildContentDisposition("‮‮", { fallback: "///" }))
            .toBe("attachment; filename=document");
    });
});

describe("buildContentDisposition type parameter is not trusted", () => {
    test("a smuggled disposition type is coerced to attachment", () => {
        // A JS caller (or a mistyped disposition extractor) could return a
        // computed string; anything but "inline" must become "attachment",
        // so header parameters cannot be smuggled through the type slot.
        const result = buildContentDisposition("f.pdf", {
            type: "attachment\r\nSet-Cookie: evil=1" as "attachment",
        });
        expect(result).toBe("attachment; filename=f.pdf");
        expect(result).not.toContain("Set-Cookie");
        expect(result).not.toContain("\r");
    });

    test("inline is preserved", () => {
        expect(buildContentDisposition("f.pdf", { type: "inline" }))
            .toBe("inline; filename=f.pdf");
    });
});

// ─── Combined Attack Vectors ────────────────────────────────────────────────

describe("buildContentDisposition combined attacks", () => {
    test("CRLF + traversal + quotes", () => {
        const result = buildContentDisposition('../../\r\nX-Injected: yes\r\n"bad".pdf');
        expect(result).not.toContain("\r");
        expect(result).not.toContain("\n");
        expect(result).not.toContain("../");
        expect(result).toContain("attachment");
    });

    test("control chars + non-ASCII + backslash", () => {
        const result = buildContentDisposition("file\x00\\Ärlig.pdf");
        expect(result).not.toContain("\x00");
        expect(result).toContain("attachment");
        expect(result).toContain("filename*=UTF-8''");
    });
});

// ─── Regression: Inline + Non-ASCII (stream route use case) ─────────────────

describe("buildContentDisposition stream route patterns", () => {
    test("inline with ASCII filename for PDF preview", () => {
        const result = buildContentDisposition("quarterly-report.pdf", { type: "inline" });
        expect(result).toBe("inline; filename=quarterly-report.pdf");
    });

    test("inline with non-ASCII filename for PDF preview", () => {
        const result = buildContentDisposition("Årsberetning_2024.pdf", { type: "inline" });
        expect(result).toStartWith("inline;");
        expect(result).toContain("filename*=UTF-8''%C3%85rsberetning_2024.pdf");
    });

    test("inline with null filename", () => {
        const result = buildContentDisposition(null, { type: "inline" });
        expect(result).toBe('inline; filename=document');
    });

    test("attachment for non-previewable type", () => {
        const result = buildContentDisposition("malware.html", { type: "attachment" });
        expect(result).toStartWith("attachment;");
    });
});

// ─── Security: Bidi/RTL Override Stripping ──────────────────────────────────

describe("buildContentDisposition bidi control stripping", () => {
    test("strips RLO override that reverses filename display", () => {
        // U+202E (Right-to-Left Override) makes "report\u202Efdp.exe" render
        // as "reportexe.pdf" in OS file managers, tricking users into running executables
        const result = buildContentDisposition("report\u202Efdp.exe");
        expect(result).not.toContain("\u202E");
        expect(result).toContain("reportfdp.exe");
    });

    test("strips all bidi override characters (U+202A-U+202E)", () => {
        const result = buildContentDisposition("a\u202Ab\u202Bc\u202Cd\u202De\u202Ef.txt");
        expect(result).toContain("abcdef.txt");
    });

    test("strips bidi isolate characters (U+2066-U+2069)", () => {
        const result = buildContentDisposition("file\u2066hidden\u2069.txt");
        expect(result).toContain("filehidden.txt");
    });

    test("strips zero-width characters (U+200B-U+200F)", () => {
        const result = buildContentDisposition("file\u200B\u200C\u200D\u200E\u200Fname.txt");
        expect(result).toContain("filename.txt");
    });

    test("strips C1 control characters (U+0080-U+009F)", () => {
        const result = buildContentDisposition("file\x80\x8F\x9Fname.txt");
        expect(result).toContain("filename.txt");
    });

    test("strips NBSP (U+00A0)", () => {
        const result = buildContentDisposition("file\u00A0name.txt");
        expect(result).toContain("filename.txt");
    });

    test("strips line separator U+2028 and paragraph separator U+2029", () => {
        const result = buildContentDisposition("file\u2028name\u2029.txt");
        expect(result).toContain("filename.txt");
        expect(result).not.toContain("\u2028");
        expect(result).not.toContain("\u2029");
    });

    test("all-control filename falls back to default", () => {
        // A filename consisting entirely of control characters should be
        // stripped completely, leaving empty string, triggering fallback
        const result = buildContentDisposition("\x00\x01\x02\x03\x7F");
        expect(result).toBe("attachment; filename=document");
    });
});

// ─── Security: Surrogate Pair Safety ────────────────────────────────────────

describe("buildContentDisposition surrogate pair safety", () => {
    test("emoji filenames encode correctly", () => {
        const result = buildContentDisposition("🎉report📊.pdf");
        expect(result).toContain("filename*=UTF-8''");
        // Should not throw URIError
        expect(result).toContain("attachment");
    });

    test("lone high surrogate is stripped from RFC 8187 encoding", () => {
        // Manually create a string with a lone high surrogate at the end
        // This simulates what happens when .slice(0, N) splits an emoji
        const withLoneSurrogate = "report" + String.fromCharCode(0xD83C) + ".pdf";
        // Should not throw URIError from encodeURIComponent
        const result = buildContentDisposition(withLoneSurrogate);
        expect(result).toContain("attachment");
    });

    test("lone low surrogate is stripped from RFC 8187 encoding", () => {
        const withLoneSurrogate = "report" + String.fromCharCode(0xDFFF) + ".pdf";
        const result = buildContentDisposition(withLoneSurrogate);
        expect(result).toContain("attachment");
    });
});

// ─── Encoding Boundary Precision ─────────────────────────────────────────────
//
// These pin the exact encoding decisions at their boundaries. Each targets a
// specific line where a one-character change (regex quantifier, comparison
// operator, case transform) would still pass the looser tests above but
// silently corrupt a header. They are the difference between "roughly right"
// and "provably correct" for a public, security-sensitive header builder.

describe("buildContentDisposition encoding boundary precision", () => {
    test("a lone hex nibble after % is NOT treated as a hex escape", () => {
        // HEX_ESCAPE_REGEXP requires TWO hex digits (%XX). A single hex digit
        // after % ("a%2z") is not a percent-escape, so the name stays a plain
        // token and is emitted unquoted and unmodified. If the quantifier were
        // relaxed to one digit, "%2" would trip the hex path and the % would be
        // doubled to %25, mangling the filename.
        expect(buildContentDisposition("a%2z.pdf")).toBe("attachment; filename=a%2z.pdf");
    });

    test("double-dots not adjacent to a separator survive as a legit filename", () => {
        // Traversal stripping targets exactly "../" and "..\\". A version tag
        // like "archive..v2.zip" contains "..v" (dots followed by a normal
        // char), which must be preserved verbatim. A negated character class in
        // the traversal regex would eat "..v" and corrupt the name to
        // "archive2.zip".
        expect(buildContentDisposition("archive..v2.zip"))
            .toBe("attachment; filename=archive..v2.zip");
    });

    test("a separator at index 0 still triggers basename extraction", () => {
        // lastIndexOf returns 0 for a leading "/". The basename guard is
        // `lastSep >= 0`, not `> 0`: index 0 is a real separator position, so
        // the leading slash must be sliced off, yielding the bare token. A
        // strict `> 0` would keep "/report.pdf" and force quoting.
        expect(buildContentDisposition("/report.pdf"))
            .toBe("attachment; filename=report.pdf");
    });

    test("a token-safe hex-escaped name emits filename UNQUOTED alongside filename*", () => {
        // "report%20.pdf" is forced onto the filename* path (hex escape) but its
        // %-doubled fallback "report%2520.pdf" is still a valid token, so the
        // legacy filename= parameter stays unquoted. This pins the token branch
        // inside the filename* builder that the looser %2520 test never asserts.
        expect(buildContentDisposition("report%20.pdf"))
            .toBe("attachment; filename=report%2520.pdf; filename*=UTF-8''report%2520.pdf");
    });

    test("our attr-char percent-encoder emits UPPERCASE hex digits", () => {
        // "*" (0x2A) is left unescaped by encodeURIComponent but IS an RFC 8187
        // attr-char, so it flows through our own percentEncode, which must emit
        // %2A. This isolates OUR encoder from encodeURIComponent's (whose hex is
        // uppercase regardless): a lowercase transform here would emit %2a. The
        // leading non-ASCII "å" forces the filename* path.
        const result = buildContentDisposition("å*.pdf");
        expect(result).toContain("filename*=UTF-8''%C3%A5%2A.pdf");
    });
});

describe("buildContentDisposition extended invisible-character stripping", () => {
    test("bidi and invisible format characters outside the classic set are stripped", () => {
        // U+061C ALM, U+FEFF ZWNBSP/BOM, U+2060 word joiner, U+00AD soft
        // hyphen: all invisible, all usable for filename spoofing.
        const result = buildContentDisposition("re؜port﻿⁠­.pdf");
        expect(result).toBe("attachment; filename=report.pdf");
    });

    test("interlinear annotation and Mongolian vowel separator are stripped", () => {
        const result = buildContentDisposition("a￹b￺c￻d᠎.txt");
        expect(result).toBe("attachment; filename=abcd.txt");
    });
});

describe("buildContentDisposition ASCII fallback transliteration", () => {
    test("NFKD-decomposable letters fold to their base letters", () => {
        expect(buildContentDisposition("café.txt")).toContain("filename=cafe.txt");
        expect(buildContentDisposition("Ärlig_Söt.pdf")).toContain("filename=Arlig_Sot.pdf");
    });

    test("non-decomposable characters still degrade to ?", () => {
        // Danish ø and æ have no NFKD decomposition to ASCII.
        const result = buildContentDisposition("høj.pdf");
        expect(result).toContain('filename="h?j.pdf"');
        expect(result).toContain("filename*=UTF-8''h%C3%B8j.pdf");
    });
});

describe("isInlineSafeMediaType", () => {
    test("images are inline-safe except SVG", () => {
        expect(isInlineSafeMediaType("image/png")).toBe(true);
        expect(isInlineSafeMediaType("image/jpeg")).toBe(true);
        expect(isInlineSafeMediaType("image/webp")).toBe(true);
        expect(isInlineSafeMediaType("image/svg+xml")).toBe(false);
    });

    test("audio and video are inline-safe", () => {
        expect(isInlineSafeMediaType("video/mp4")).toBe(true);
        expect(isInlineSafeMediaType("audio/mpeg")).toBe(true);
    });

    test("script-capable document types are NOT inline-safe", () => {
        expect(isInlineSafeMediaType("text/html")).toBe(false);
        expect(isInlineSafeMediaType("application/xhtml+xml")).toBe(false);
        // PDF is excluded by default: serve it inline only from a CSP-sandboxed route.
        expect(isInlineSafeMediaType("application/pdf")).toBe(false);
    });

    test("a small allow-list of inert text/data types is inline-safe", () => {
        expect(isInlineSafeMediaType("text/plain")).toBe(true);
        expect(isInlineSafeMediaType("application/json")).toBe(true);
        expect(isInlineSafeMediaType("text/csv")).toBe(true);
        expect(isInlineSafeMediaType("text/markdown")).toBe(true);
    });

    test("parameters and casing are ignored (essence match)", () => {
        expect(isInlineSafeMediaType("TEXT/PLAIN; charset=utf-8")).toBe(true);
        expect(isInlineSafeMediaType("Image/PNG")).toBe(true);
        expect(isInlineSafeMediaType("image/svg+xml; charset=utf-8")).toBe(false);
    });

    test("unknown, empty, and nullish types default to NOT inline-safe", () => {
        expect(isInlineSafeMediaType("application/octet-stream")).toBe(false);
        expect(isInlineSafeMediaType("application/zip")).toBe(false);
        expect(isInlineSafeMediaType("")).toBe(false);
        expect(isInlineSafeMediaType("   ")).toBe(false);
        expect(isInlineSafeMediaType(null)).toBe(false);
        expect(isInlineSafeMediaType(undefined)).toBe(false);
    });

    test("composes with buildContentDisposition for untrusted content", () => {
        const forUntrusted = (name: string, mime: string) =>
            buildContentDisposition(name, { type: isInlineSafeMediaType(mime) ? "inline" : "attachment" });
        expect(forUntrusted("a.png", "image/png")).toStartWith("inline");
        expect(forUntrusted("x.svg", "image/svg+xml")).toStartWith("attachment");
        expect(forUntrusted("p.html", "text/html")).toStartWith("attachment");
    });
});
