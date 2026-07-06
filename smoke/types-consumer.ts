/**
 * Consumer type-resolution guard for F5: verifies the shipped `.d.ts` surface is
 * `new Response(...)`-assignable under `lib: ["DOM"]` on TS >= 5.7, where BodyInit
 * requires an ArrayBuffer-backed view. Compiled with the DOM lib by `check:consumer-types`
 * so the return-position generics can't regress to `<ArrayBufferLike>`.
 */
import type { ObjectStream } from "../dist/index.js";
import type { RawResponseParts } from "../dist/web.js";

declare const s: ObjectStream;
declare const parts: RawResponseParts;

// The exact papercut the fix targets: these must compile under DOM lib.
export const fromStream: Response = new Response(s.body);
export const fromParts: Response | null =
  parts.body === null ? null : new Response(parts.body);
