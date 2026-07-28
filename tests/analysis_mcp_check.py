#!/usr/bin/env python3
"""The optional-analytics wiring for the Analysis session: present key -> tool wired, absent key ->
tool omitted (graceful degradation). Pins _optional_mcp_servers (SEO Gets, Clarity) and _optional_env
(Bing, reached by REST). No model, no network. Run: .venv/bin/python tests/analysis_mcp_check.py"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import analysis_gen, db  # noqa: E402

FAIL = []


def check(name, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'' if cond else ': ' + detail}")
    if not cond:
        FAIL.append(name)


def with_cfg(values):
    """Run the two builders against a fake server/.env content."""
    saved = db.config_value
    db.config_value = lambda name: values.get(name, "")
    try:
        return analysis_gen._optional_mcp_servers(), analysis_gen._optional_env()
    finally:
        db.config_value = saved


def main():
    print("analysis_mcp_check: optional analytics tools wire on a key and vanish without one.")

    # All three configured.
    mcp, env = with_cfg({
        "SEOGETS_API_KEY": "sg_mcp_x", "CLARITY_API_KEY": "eyJ.jwt", "BING_WEBMASTER_API_KEY": "abc123",
    })
    check("seogets is an http MCP at the SEO Gets endpoint",
          mcp.get("seogets", {}).get("type") == "http"
          and mcp["seogets"]["url"] == "https://app.seogets.com/mcp"
          and mcp["seogets"]["headers"]["Authorization"] == "Bearer sg_mcp_x")
    check("clarity is the official Microsoft stdio MCP, token passed as an arg",
          mcp.get("clarity", {}).get("command") == "npx"
          and "@microsoft/clarity-mcp-server" in mcp["clarity"]["args"]
          and "--clarity_api_token=eyJ.jwt" in mcp["clarity"]["args"])
    check("bing is NOT an MCP server (reached by REST), its key is injected into the session env",
          "bing" not in mcp and env.get("BING_WEBMASTER_API_KEY") == "abc123")

    # None configured -> everything degrades to absent.
    mcp0, env0 = with_cfg({})
    check("no keys -> no optional MCP servers", mcp0 == {}, f"got {list(mcp0)}")
    check("no keys -> no injected env", env0 == {}, f"got {list(env0)}")

    # Only one configured -> only that one appears.
    mcp1, env1 = with_cfg({"SEOGETS_API_KEY": "sg_mcp_y"})
    check("one key -> only that tool wired, the rest omitted",
          list(mcp1) == ["seogets"] and env1 == {}, f"got mcp={list(mcp1)} env={list(env1)}")

    print(f"\n{5 - len(FAIL)}/5 checks passed")
    if FAIL:
        print("FAILED: " + ", ".join(FAIL))
        return 1
    print("analysis_mcp_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
