import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createContext7Adapter } from "./src/adapters/context7.ts";
import { createExaAdapter } from "./src/adapters/exa.ts";
import { createWebclawAdapter } from "./src/adapters/webclaw.ts";
import { createLinkupAdapter } from "./src/adapters/linkup.ts";
import { createPiPackagesAdapter } from "./src/adapters/pi-packages.ts";
import { createSerperAdapter } from "./src/adapters/serper.ts";
import { createSkillsMpAdapter } from "./src/adapters/skillsmp.ts";
import { createTavilyAdapter } from "./src/adapters/tavily.ts";
import { createXSearchAdapter } from "./src/adapters/xsearch.ts";
import { loadConfig } from "./src/config.ts";
import { registerWebDoctor } from "./src/doctor.ts";
import { registerWebSetup } from "./src/provider-control.ts";
import { AdapterRegistry } from "./src/registry.ts";
import { registerWebAnswer } from "./src/tools/web-answer.ts";
import { registerWebAnswerSpecialists } from "./src/tools/web-answer-specialists.ts";
import { registerWebFetch } from "./src/tools/web-fetch.ts";
import { registerContext7 } from "./src/tools/context7-tool.ts";
import { registerWebLookup } from "./src/tools/web-lookup.ts";
import { registerWebSearch } from "./src/tools/web-search.ts";
import { registerWebSearchSpecialists } from "./src/tools/web-search-specialists.ts";

export default function jeitoWeb(pi: ExtensionAPI): void {
  const config = loadConfig();
  const registry = new AdapterRegistry([
    createSerperAdapter(), createExaAdapter(), createTavilyAdapter(), createLinkupAdapter(), createXSearchAdapter(),
    createWebclawAdapter({ timeoutMs: config.limits.timeoutMs, responseBytes: config.limits.responseBytes, destinationPolicy: config.network }), createContext7Adapter(), createSkillsMpAdapter(), createPiPackagesAdapter(),
  ]);
  registerWebDoctor(pi, registry);
  registerWebSetup(pi, registry);
  registerWebAnswer(pi, registry);
  registerWebSearch(pi, registry);
  registerWebFetch(pi, registry);
  registerWebLookup(pi, registry);
  registerContext7(pi, registry);
  registerWebSearchSpecialists(pi, registry);
  registerWebAnswerSpecialists(pi, registry);
}
