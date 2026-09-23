// Bundle to runtime/core.cjs; the sealed kernel loader uses the adjacent .node asset.
export { QueryBuilder } from "./src/db/queries";
export { ReferenceResolver } from "./src/resolution/index";
export { decodeExtractBuffers } from "./src/extraction/kernel/decode";
export { getKernel } from "./src/extraction/kernel/loader";
export { installSource, assertSourceBoundary } from "./capture";
export { ANALYSIS_REVISION, KERNEL_VERSION } from "./identity.mjs";
export { detectLanguage } from "./src/extraction/grammars";
