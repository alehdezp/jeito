// ADR-002.001: the registry owns provider capability behind stable tool contracts; see docs/adr/0002-internal-architecture/0001-layered-provider-architecture.md.
import type { WebConfig } from "./config.ts";
import type { Adapter, Intent } from "./types.ts";

export class AdapterRegistry {
  readonly adapters: Adapter[];

  constructor(adapters: Adapter[]) {
    const ids = adapters.map((adapter) => adapter.capability.id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate provider id");
    this.adapters = adapters;
  }

  get(id: string): Adapter | undefined {
    return this.adapters.find((adapter) => adapter.capability.id === id);
  }

  forIntent(intent: Intent, config: WebConfig): Adapter[] {
    const candidates = this.adapters.filter((adapter) => adapter.capability.operations.includes(intent.operation));
    const priority = config.priority[intent.operation] ?? [];
    return candidates.sort((left, right) => {
      const l = priority.indexOf(left.capability.id);
      const r = priority.indexOf(right.capability.id);
      return (l < 0 ? Number.MAX_SAFE_INTEGER : l) - (r < 0 ? Number.MAX_SAFE_INTEGER : r);
    });
  }
}