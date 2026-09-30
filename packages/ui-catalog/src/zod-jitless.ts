import { config } from "zod";

// zod 4 compiles object parsers with `new Function` and probes for it when an
// object schema is constructed (zod/v4/core/schemas.js:901-903). Under the
// renderer CSP `script-src 'self'` Chromium logs that probe as a CSP violation
// even though zod catches it, and the extended smoke fails on it (spec §8.7).
// catalog.ts imports this module first, so jitless mode is set before
// @json-render/core builds its module-level schemas.
config({ jitless: true });
