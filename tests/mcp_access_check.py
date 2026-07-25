#!/usr/bin/env python3
"""check_research_access gates a blog run on the research MCPs being reachable: config shape PLUS
the stdio creds actually resolving. A blank key is config-valid but not accessible, and that is
the exact gap this guards, so it must FAIL the run rather than let it die at Sourcing."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server import runner  # noqa: E402

# Isolate from whatever the shell exported: drive the transport purely through this test's env.
for var in ("FIRECRAWL_MCP_URL", "DATAFORSEO_MCP_URL",
            "FIRECRAWL_API_KEY", "DATAFORSEO_USERNAME", "DATAFORSEO_PASSWORD"):
    os.environ.pop(var, None)

# .mcp.json exists in the repo, so config shape is fine; with no creds the stdio transport is
# config-valid but NOT accessible -> refuse.
ok, reason = runner.check_research_access()
assert ok is False, "no creds must refuse"
assert "FIRECRAWL_API_KEY" in reason and "DATAFORSEO_USERNAME" in reason, reason

# Firecrawl present but DataForSEO half-missing still refuses, naming only what is missing.
os.environ["FIRECRAWL_API_KEY"] = "fc-test"
ok, reason = runner.check_research_access()
assert ok is False and "FIRECRAWL_API_KEY" not in reason and "DATAFORSEO_USERNAME" in reason, reason

# All three present -> accessible.
os.environ["DATAFORSEO_USERNAME"] = "u"
os.environ["DATAFORSEO_PASSWORD"] = "p"
ok, reason = runner.check_research_access()
assert ok is True, reason

print("PASS mcp access gate")
