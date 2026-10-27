import { packageBase } from "../../lint/package-base.mjs";
import { SEL_AS_ANY, SEL_MATH_RANDOM, SEL_NAIVE_COMMENT_STRIP, SEL_RECURSIVE_REMOVE } from "../../lint/selectors.mjs";

// See packages/shared/oxlint.config.mts for why these exist at all: a package
// with no `lint` script is silently skipped by `turbo run lint`.
//
// This package's guards are the two contracts its own AGENTS.md states and
// nothing enforced: zero runtime dependencies, and runtime-agnostic code. Both
// are the kind of promise that is easy to keep by hand until the one time it
// is not, and this package is PUBLISHED, so breaking either reaches every
// consumer rather than a colleague.
//
// A later override REPLACES a rule's options for the files it matches rather
// than merging them, so every selector applying to the same files must stay in
// ONE `nordvec/no-restricted-syntax` array. Do not add a second override.
const SEL_BUN_GLOBAL = {
    // The repo defaults to Bun builtins everywhere else, which is exactly why
    // this needs a guard rather than a convention: the habit is correct in every
    // other file an author touches. This package ships to Node, Deno and
    // Cloudflare Workers consumers, where `Bun` does not exist at all.
    selector: "MemberExpression[object.name='Bun']",
    message:
        "Runtime-agnostic by contract: this package ships to Node, Deno and Workers. Use Web or Node standard APIs, never Bun.* builtins.",
};

const SEL_OBJECT_KEY_IN_ERROR_MESSAGE = {
    // An object key is whatever the consumer names objects by, commonly a user's
    // filename, and an error message is free text that every log line and error
    // tracker prints whole, `cause` chain included. The read-side errors carry
    // the key on their `key` field, which a consumer can drop, hash or redact by
    // name; a message cannot be scrubbed without knowing the key. An upload
    // token is a bearer credential, and every adapter's bookkeeping names embed
    // it, so the builders of those names are refused alongside the token.
    // `bodyToBytes` is listed because its context string becomes its message.
    selector:
        ":matches(NewExpression, CallExpression[callee.type='Super'], CallExpression[callee.name='bodyToBytes']) > :matches(TemplateLiteral, BinaryExpression) Identifier[name=/^(key|path|prefix|objectKey|targetKey|token|uploadToken|infoKey|partKey|infoName|infoBlobName|manifestName|chunkName|chunkPrefix|composePrefix)$/]",
    message:
        "An error message never names the object key or an upload token: a key is often a user's filename, a token is a credential, and no consumer can scrub free text. Carry the key on the error's `key` field (ObjectNotFoundError and its siblings) or in the onError context.",
};

// `.stryker-tmp/` holds mutation-run sandboxes: whole copies of the package,
// tsconfig included. The sandbox is a build artifact of `test:mutation`,
// never a lint target.
const base = packageBase({ ignores: [".stryker-tmp/**"], allowRequireImports: true });

export default {
    ...base,
    overrides: [
        ...base.overrides,
        {
            // The package's own build and mutation scripts cannot import the
            // repo's remove-tree.mjs (the package stands alone), so a recursive
            // remove of a computed path here carries an inline justification.
            files: ["scripts/**/*.mjs"],
            rules: { "nordvec/no-restricted-syntax": ["error", SEL_RECURSIVE_REMOVE] },
        },
        {
            // SHIPPED source only. Tests are excluded from tsconfig and from the
            // tarball, and the suite is run with `bun test` by design, so banning Bun
            // builtins there would forbid the documented way of running it while
            // protecting nothing: the cross-runtime promise is about what lands in
            // dist/, not about what the suite is executed by.
            files: ["src/**/*.ts"],
            excludeFiles: ["src/__tests__/**/*.ts"],
            rules: {
                "nordvec/no-restricted-syntax": [
                    "error",
                    SEL_BUN_GLOBAL,
                    SEL_AS_ANY,
                    SEL_NAIVE_COMMENT_STRIP,
                    SEL_MATH_RANDOM,
                    SEL_OBJECT_KEY_IN_ERROR_MESSAGE,
                ],
                "no-empty": ["error", { allowEmptyCatch: false }],
                // The escape set in content-disposition.ts deliberately matches control
                // characters, and says so with a disable. Enabling the rule is what makes
                // that disable mean something: with the rule off it was inert, so a
                // second, accidental control-character class could have gone in unnoticed
                // beside an annotation that looked like it was guarding the file.
                "no-control-regex": "error",
                "no-restricted-imports": [
                    "error",
                    {
                        patterns: [
                            {
                                // Zero runtime dependencies is the package's headline property. A
                                // monorepo import would compile here and be unresolvable for every
                                // npm consumer, since none of these are published alongside it.
                                group: ["@nordvec/*", "@/*", "apps/*", "**/apps/**", "**/packages/**"],
                                message:
                                    "Zero dependencies and standalone-publishable: this package may not import from the monorepo. Its adapters live in its own subpath exports.",
                            },
                        ],
                    },
                ],
            },
        },
        {
            files: ["src/__tests__/**/*.ts"],
            rules: {
                "no-empty": ["error", { allowEmptyCatch: false }],
            },
        },
    ],
};
