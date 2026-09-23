import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests that exercise the graphify/deepseek path must not read the host's
// real ~/.pi/agent/navigation.yaml (its providers.allowed varies per machine
// and would classify the same test as auto on one host and guided on another).
// This fixture home keeps the loader on its defaults (which allow deepseek)
// while pinning the graph backend to the provider under test.

export async function hermeticNavigationHome(extraYaml = "") {
  const home = await mkdtemp(join(tmpdir(), "pi-nav-home-"));
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(join(home, ".pi", "agent", "navigation.yaml"), `backends:
  graph:
    mode: deepExtract
    provider: deepseek
    model: deepseek-v4-flash
${extraYaml}`);
  return home;
}
