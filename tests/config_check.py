#!/usr/bin/env python3
"""Static config checks for server/runner.py. Spawns NOTHING and calls NO model.

Everything real mode depends on that can be checked without a live run is
checked here: MCP transport resolution in all three states, the exact
ClaudeAgentOptions the runner would pass, the SDK field names those options use,
that .mcp.json carries no secret, and that the demo client resolves to mock.
A live run is the wrong place to discover any of this, and for the demo client
a live run is forbidden outright.

  .venv/bin/python tests/config_check.py
"""
import contextlib
import dataclasses
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from claude_agent_sdk import AgentDefinition, ClaudeAgentOptions  # noqa: E402

from server import runner  # noqa: E402

FAILURES = []
CHECKS = [0]

MCP_ENV_VARS = ("FIRECRAWL_MCP_URL", "FIRECRAWL_MCP_AUTH",
                "DATAFORSEO_MCP_URL", "DATAFORSEO_MCP_AUTH")


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


@contextlib.contextmanager
def env(**overrides):
    """Set or clear env vars for the block, restoring exactly what was there."""
    saved = {key: os.environ.get(key) for key in overrides}
    for key, value in overrides.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@contextlib.contextmanager
def no_mcp_env():
    with env(**{key: None for key in MCP_ENV_VARS}):
        yield


@contextlib.contextmanager
def mcp_config_path(path):
    """Monkeypatch the .mcp.json location, so the "neither transport" state is
    testable without deleting the operator's real file."""
    saved = runner.MCP_CONFIG_PATH
    runner.MCP_CONFIG_PATH = path
    try:
        yield
    finally:
        runner.MCP_CONFIG_PATH = saved


# ---------------------------------------------------------------------------

def test_transport_http():
    print("\n[1] MCP transport: URL env vars set -> http map")
    with env(FIRECRAWL_MCP_URL="https://mcp.example.invalid/firecrawl",
             DATAFORSEO_MCP_URL="https://mcp.example.invalid/dataforseo",
             FIRECRAWL_MCP_AUTH="Bearer test-token", DATAFORSEO_MCP_AUTH=None):
        servers = runner._resolve_mcp_servers()
        check("returns both servers", set(servers) == {"firecrawl", "dataforseo"}, str(list(servers)))
        check("firecrawl is http with the env url",
              servers["firecrawl"] == {"type": "http",
                                       "url": "https://mcp.example.invalid/firecrawl",
                                       "headers": {"Authorization": "Bearer test-token"}},
              str(servers.get("firecrawl")))
        check("dataforseo carries no header when no auth var is set",
              "headers" not in servers["dataforseo"], str(servers.get("dataforseo")))
        ok, reason = runner.check_real_mode_ready()
        check("check_real_mode_ready ok, names the http transport", ok and "http" in reason, reason)

    print("\n[1b] MCP transport: half configured http is loud, never a silent skip")
    with env(FIRECRAWL_MCP_URL="https://mcp.example.invalid/firecrawl",
             DATAFORSEO_MCP_URL=None, FIRECRAWL_MCP_AUTH=None, DATAFORSEO_MCP_AUTH=None):
        try:
            runner._resolve_mcp_servers()
            check("raises RunnerConfigError", False, "no exception raised")
        except runner.RunnerConfigError as exc:
            check("raises RunnerConfigError naming the missing var",
                  "DATAFORSEO_MCP_URL" in str(exc), str(exc))


def test_transport_stdio():
    print("\n[2] MCP transport: no URL env, .mcp.json present -> {} and the CLI loads it")
    with no_mcp_env():
        check(".mcp.json exists at the repo root", runner.MCP_CONFIG_PATH.is_file(),
              str(runner.MCP_CONFIG_PATH))
        servers = runner._resolve_mcp_servers()
        check("returns {} so the project config is not overridden", servers == {}, repr(servers))
        ok, reason = runner.check_real_mode_ready()
        check("check_real_mode_ready ok, names the stdio transport",
              ok and "stdio" in reason, reason)
        # An empty map only reaches the CLI's project config because
        # setting_sources includes "project" AND strict_mcp_config stays False.
        field = {f.name: f for f in dataclasses.fields(ClaudeAgentOptions)}["strict_mcp_config"]
        check("SDK strict_mcp_config still defaults False (True would suppress .mcp.json)",
              field.default is False, repr(field.default))
        options = runner._session_options()
        check("the runner never sets strict_mcp_config True",
              options.strict_mcp_config is False, repr(options.strict_mcp_config))


def test_transport_missing():
    print("\n[3] MCP transport: neither env nor .mcp.json -> loud RunnerConfigError")
    with no_mcp_env(), mcp_config_path(REPO_ROOT / "tests" / "does-not-exist.mcp.json"):
        try:
            runner._resolve_mcp_servers()
            check("raises RunnerConfigError", False, "no exception raised")
        except runner.RunnerConfigError as exc:
            message = str(exc)
            check("the error names BOTH options",
                  "FIRECRAWL_MCP_URL" in message and ".mcp.json" in message, message)
        ok, reason = runner.check_real_mode_ready()
        check("check_real_mode_ready not ok, with the reason", not ok and reason, reason)


def test_session_options():
    print("\n[4] The ClaudeAgentOptions a real session would run with")
    with no_mcp_env():
        options = runner._session_options()

    check("cwd is the repo root, resolved from __file__ not os.getcwd()",
          options.cwd == str(REPO_ROOT), str(options.cwd))
    check('setting_sources == ["project"], or CLAUDE.md and .mcp.json never load',
          options.setting_sources == ["project"], str(options.setting_sources))
    check('permission_mode == "acceptEdits"', options.permission_mode == "acceptEdits",
          str(options.permission_mode))
    check('allowed_tools includes "Agent", or subagents never spawn',
          "Agent" in options.allowed_tools, str(options.allowed_tools))
    check('allowed_tools includes "Skill", or the skills never run',
          "Skill" in options.allowed_tools, str(options.allowed_tools))

    agents = options.agents or {}
    check("three AgentDefinitions: researcher, writer, evaluator",
          set(agents) == {"researcher", "writer", "evaluator"}, str(sorted(agents)))
    check("all three are AgentDefinition instances",
          all(isinstance(a, AgentDefinition) for a in agents.values()))
    evaluator = agents.get("evaluator")
    # Read-only there means Agent E dies on its first eval: it MUST write eval.md.
    check('evaluator tools include "Write" so it can write eval.md',
          bool(evaluator) and "Write" in (evaluator.tools or []),
          str(getattr(evaluator, "tools", None)))


def test_sdk_field_names():
    print("\n[5] Every option field the runner sets exists on the installed SDK")
    with no_mcp_env():
        options = runner._session_options()
    sdk_fields = {f.name for f in dataclasses.fields(ClaudeAgentOptions)}
    # A future SDK bump that renames or drops a field fails HERE, cheaply,
    # instead of twenty minutes into a live run.
    used = {"cwd", "setting_sources", "permission_mode", "allowed_tools", "mcp_servers",
            "agents", "max_turns", "max_budget_usd", "model", "env", "strict_mcp_config"}
    missing = sorted(used - sdk_fields)
    check("no field the runner sets has been renamed or dropped", not missing, str(missing))
    check("the built options object is a ClaudeAgentOptions",
          isinstance(options, ClaudeAgentOptions))


def _secret_values():
    """The literal secret values from the operator's ~/.claude.json, so the repo
    can be grepped for them. Never printed, never written anywhere."""
    path = Path.home() / ".claude.json"
    if not path.is_file():
        return []
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    found = []

    def collect(servers):
        for name in ("firecrawl", "dataforseo"):
            entry = servers.get(name) or {}
            for value in (entry.get("env") or {}).values():
                if isinstance(value, str) and len(value) >= 8:
                    found.append(value)

    collect(config.get("mcpServers") or {})
    for project in (config.get("projects") or {}).values():
        if isinstance(project, dict):
            collect(project.get("mcpServers") or {})
    return found


def test_mcp_json_file():
    print("\n[6] .mcp.json parses, declares both servers, and holds no secret")
    path = REPO_ROOT / ".mcp.json"
    check(".mcp.json exists", path.is_file(), str(path))
    if not path.is_file():
        return
    raw = path.read_text(encoding="utf-8")
    try:
        config = json.loads(raw)
        parsed = True
    except json.JSONDecodeError as exc:
        config, parsed = {}, False
        check(".mcp.json parses as JSON", False, str(exc))
    if parsed:
        check(".mcp.json parses as JSON", True)
    servers = config.get("mcpServers") or {}
    check("declares firecrawl and dataforseo",
          {"firecrawl", "dataforseo"} <= set(servers), str(sorted(servers)))
    for name in ("firecrawl", "dataforseo"):
        entry = servers.get(name) or {}
        check(f"{name} is stdio (command plus args)",
              bool(entry.get("command")) and isinstance(entry.get("args"), list), str(entry))
        values = list((entry.get("env") or {}).values())
        check(f"{name} env values are all ${{VAR}} interpolation",
              bool(values) and all(v.startswith("${") and v.endswith("}") for v in values),
              str(values))

    secrets = _secret_values()
    check("found the operator's real MCP secrets to grep for", bool(secrets),
          "none found in ~/.claude.json; the no-secrets check would be vacuous")
    leaked = [s for s in secrets if s in raw]
    check("no secret value from ~/.claude.json appears in .mcp.json", not leaked,
          f"{len(leaked)} secret(s) leaked")


def test_demo_client():
    print("\n[7] The demo client is always mock, in every environment")
    with env(GEO_MOCK=None):
        try:
            demo = runner.is_demo_client("demo")
        except runner.RunnerConfigError as exc:
            demo = False
            check("clients/demo/gates.json is readable", False, str(exc))
        check('is_demo_client("demo") is True', demo is True, repr(demo))
        # The decision run_topic makes, inspected without running the topic.
        check("run_topic would choose mock for demo with GEO_MOCK unset",
              runner.should_mock("demo") is True, repr(runner.should_mock("demo")))
        check("mock=False cannot force a demo client real",
              runner.should_mock("demo", mock=False) is True)
        check("a real client with GEO_MOCK unset stays real",
              runner.should_mock("vacation-village") is False)
    with env(GEO_MOCK="1"):
        check("GEO_MOCK=1 still mocks a real client",
              runner.should_mock("vacation-village") is True)


def test_demo_blog_shape():
    print("\n[8] The precoded demo blog: deterministic, templated, marked")
    row = {"topic": "Anything an Operator Uploads",
           "covers": "An arbitrary covers cell from an arbitrary CSV.",
           "prompts": ["What is the thing?", "How do I pick one?"],
           "topic_slug": "anything-an-operator-uploads"}
    slug = row["topic_slug"]
    first = runner._demo_blog("demo", row, slug, 1)
    again = runner._demo_blog("demo", row, slug, 1)
    check("deterministic from the topic slug", first == again)
    check("the marker leads the file", first.startswith(runner.DEMO_MARKER), first[:80])
    check("the marker names no research and no API calls",
          "without research or API calls" in runner.DEMO_MARKER)
    check("H1 is the uploaded topic", f"# {row['topic']}" in first)
    check("carries a TL;DR", "**TL;DR:**" in first)
    check("the covers text shapes the piece", row["covers"] in first)
    heads = [line for line in first.splitlines() if line.startswith("## ")]
    check("2 or 3 H2s plus FAQ and Sources", 4 <= len(heads) <= 5, str(heads))
    check("every target prompt reaches an H2", all(f"## {p}" in first for p in row["prompts"]))
    check("carries a markdown table", "| Criterion | What it decides |" in first)
    check("carries an FAQ", "## FAQ" in first)
    check("carries a Sources line", "## Sources and References" in first)
    # Escaped, so this file obeys the same no-dash house rule it enforces.
    check("no em or en dash in generated demo content",
          "\u2014" not in first and "\u2013" not in first)

    # An arbitrary upload means a one-prompt row and an empty covers cell too.
    thin = runner._demo_blog("demo", {"topic": "One Prompt Only", "prompts": ["What is it?"]},
                             "one-prompt-only", 1)
    thin_heads = [line for line in thin.splitlines() if line.startswith("## ")]
    check("a one-prompt row still gets 2 H2s", 4 <= len(thin_heads) <= 5, str(thin_heads))
    empty = runner._demo_blog("demo", {"topic": "", "prompts": []}, "bare-slug", 1)
    check("a bare row still produces a marked blog", empty.startswith(runner.DEMO_MARKER))
    other = runner._demo_blog("demo", row, "a-different-slug", 1)
    check("a different slug produces different content", other != first)


def test_repo_has_no_secrets():
    print("\n[9] No secret from ~/.claude.json anywhere under geo-factory")
    secrets = _secret_values()
    if not secrets:
        check("secrets available to grep for", False, "none found in ~/.claude.json")
        return
    skip_dirs = {".venv", ".git", "__pycache__", "node_modules"}
    hits = []
    for path in REPO_ROOT.rglob("*"):
        if not path.is_file() or any(part in skip_dirs for part in path.parts):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if any(secret in text for secret in secrets):
            hits.append(str(path.relative_to(REPO_ROOT)))
    check("no repo file contains an MCP secret value", not hits, str(hits))


def main():
    print("config_check: static checks only. No CLI spawned, no query() called, "
          "no blog generated.")
    for test in (test_transport_http, test_transport_stdio, test_transport_missing,
                 test_session_options, test_sdk_field_names, test_mcp_json_file,
                 test_demo_client, test_demo_blog_shape, test_repo_has_no_secrets):
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    print("config_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
