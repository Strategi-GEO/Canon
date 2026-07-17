#!/usr/bin/env python3
"""Static config checks for server/runner.py. Spawns NOTHING and calls NO model.

Everything real mode depends on that can be checked without a live run is
checked here: MCP transport resolution in all three states, the exact
ClaudeAgentOptions the runner would pass, the SDK field names those options use,
that .mcp.json carries no secret, and that a demo client REFUSES to run. The
mock execution path is removed from the engine, so a demo fixture no longer
resolves to anything: it 409s at the API and raises PreflightError in the
runner, before the facts phase can spend a single real API call on it.

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


def test_demo_refusal():
    print("\n[7] A demo fixture refuses to run, everywhere, before any spend")
    import asyncio
    import tempfile

    from fastapi import HTTPException

    from server import app as app_mod
    from server import facts_gen

    try:
        demo = runner.is_demo_client("demo")
    except runner.RunnerConfigError as exc:
        demo = False
        check("clients/demo/gates.json is readable", False, str(exc))
    check('is_demo_client("demo") is True', demo is True, repr(demo))
    check("a real client is not a demo fixture",
          runner.is_demo_client("vacation-village") is False)

    detail = runner.demo_refusal_detail("demo")
    check("the refusal detail states the reason: mock mode is removed",
          "mock mode is removed" in detail, detail)
    check("the refusal detail states the stake: no real API credits on a fixture",
          "must never spend real API credits" in detail, detail)
    check("the refusal detail names the alternative: real clients run the full pipeline",
          "Real clients run the full pipeline" in detail, detail)

    # run_batch raises BEFORE the facts phase. A demo client with no canonical-facts.md must
    # never reach ensure_facts, which would open a real session to build a fact base for a
    # fake brand, so the recorder below must stay empty.
    reached = []

    async def recording_ensure(slug, run_id=None):
        reached.append(("ensure_facts", slug))

    saved_ensure = facts_gen.ensure_facts
    saved_materialize = runner._materialize_client_scratch
    facts_gen.ensure_facts = recording_ensure
    runner._materialize_client_scratch = lambda slug: reached.append(("materialize", slug))
    try:
        try:
            asyncio.run(runner.run_batch(
                "demo", [{"topic": "Demo Topic", "topic_slug": "demo-topic", "index": 0}]))
            check("run_batch refuses a demo client outright", False, "it ran the batch")
        except runner.PreflightError as exc:
            check("run_batch refuses a demo client outright", True)
            check("run_batch's refusal carries the shared detail sentence",
                  str(exc) == runner.demo_refusal_detail("demo"), str(exc))
        check("the refusal fires before the facts phase: nothing materialized, nothing built",
              not reached, str(reached))
    finally:
        facts_gen.ensure_facts = saved_ensure
        runner._materialize_client_scratch = saved_materialize

    # revise_topic carries the same belt, so nothing that bypasses the route can spend money
    # on a fixture through the answer path either. A fake brand and a stubbed is_demo_client
    # keep this inert: the record does not know the brand, so every sync hook skips.
    saved_is_demo = runner.is_demo_client
    saved_root = runner.OUTPUTS_ROOT
    with tempfile.TemporaryDirectory() as tmp:
        runner.is_demo_client = lambda slug, clients_root=None: True
        runner.OUTPUTS_ROOT = Path(tmp)
        try:
            try:
                asyncio.run(runner.revise_topic("fixture-brand", "some-topic"))
                check("revise_topic refuses a demo client outright", False, "it ran the revise")
            except runner.PreflightError as exc:
                check("revise_topic refuses a demo client outright", True)
                check("revise_topic's refusal carries the shared detail sentence",
                      str(exc) == runner.demo_refusal_detail("fixture-brand"), str(exc))
        finally:
            runner.is_demo_client = saved_is_demo
            runner.OUTPUTS_ROOT = saved_root

    # The API boundary: both generate and answers 409 a demo client with the same sentence,
    # called directly so no server boots and nothing is written.
    try:
        asyncio.run(app_mod.api_generate("demo", app_mod.GenerateRequest(rows=[0])))
        check("POST /api/clients/demo/generate 409s", False, "it accepted the run")
    except HTTPException as exc:
        check("POST /api/clients/demo/generate 409s", exc.status_code == 409,
              f"status {exc.status_code}")
        check("the generate 409 detail is the refusal sentence",
              exc.detail == runner.demo_refusal_detail("demo"), str(exc.detail))

    try:
        asyncio.run(app_mod.api_answers("demo", "any-topic",
                                        app_mod.AnswersRequest(answers=[])))
        check("POST /api/clients/demo/blogs/.../answers 409s", False, "it accepted the answers")
    except HTTPException as exc:
        check("POST /api/clients/demo/blogs/.../answers 409s", exc.status_code == 409,
              f"status {exc.status_code}")
        check("the answers 409 detail is the refusal sentence",
              exc.detail == runner.demo_refusal_detail("demo"), str(exc.detail))


def test_repo_has_no_secrets():
    print("\n[8] No secret from ~/.claude.json anywhere under geo-factory")
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
                 test_demo_refusal, test_repo_has_no_secrets):
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    print("config_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
