#!/usr/bin/env python3
"""Static config checks for server/runner.py. Spawns NOTHING and calls NO model.

Everything real mode depends on that can be checked without a live run is
checked here: MCP transport resolution in all three states, the exact
ClaudeAgentOptions the runner would pass, the SDK field names those options use,
and that .mcp.json carries no secret.

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

# The credentials .mcp.json interpolates into the two stdio servers. CLEARED by no_mcp_env and
# SET explicitly by the test that wants them, which is the only way either state is deterministic:
# a developer machine has these exported (scripts/dev-serve.sh lifts them out of ~/.claude.json)
# and a CI runner does not, so a test that simply inherited the ambient environment would assert
# the opposite thing depending on where it ran. That is how the missing credential check went
# unnoticed in the first place, since the suite only ever ran where the keys happened to exist.
STDIO_CRED_VARS = runner._STDIO_CRED_VARS
STDIO_CREDS_PRESENT = {name: f"test-{name.lower()}" for name in STDIO_CRED_VARS}


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
    """No transport configured AND no stdio credentials: the state a freshly unpacked install is
    in. Both groups are cleared together because "no MCP env" has to mean the same thing on every
    machine that runs this suite."""
    with env(**{key: None for key in MCP_ENV_VARS + STDIO_CRED_VARS}):
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
    print("\n[2] MCP transport: no URL env, .mcp.json present, credentials set -> {} and the CLI loads it")
    with no_mcp_env(), env(**STDIO_CREDS_PRESENT):
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


def test_transport_stdio_without_credentials():
    """THE CHECK A TEAMMATE'S DEAD RUN PAID FOR. .mcp.json is checked into the repo, so it is
    present and well formed on every machine that ever unpacked this app, and the shape test
    alone therefore said "stdio transport available" on a machine holding not one credential.
    The CLI launched the servers, every tool call came back 401, and the run died minutes later
    with a message that named no credential anywhere in it.

    BOTH ARMS MATTER AND THEY PULL OPPOSITE WAYS. A blog session must REFUSE, because gates.py
    checks that the last H2 is titled "Sources and References" rather than that it holds a
    reachable URL, so an unsourced draft has little else standing in its way. A repurpose session
    must still RUN, because it rewrites an already shipped blog and fetches nothing, and refusing
    it would take a working feature away over a credential it was never going to use."""
    print("\n[2b] MCP transport: .mcp.json present but NO credentials -> refused, repurpose exempt")
    with no_mcp_env():
        try:
            runner._resolve_mcp_servers()
            check("a blog session is refused when the credentials are unset", False,
                  "no exception raised: an unsourced draft would have been written")
        except runner.RunnerConfigError as exc:
            message = str(exc)
            check("a blog session is refused when the credentials are unset", True)
            check("the refusal NAMES every missing FETCH variable",
                  all(name in message for name in runner._FETCH_CRED_VARS), message)
            check("and says the config file's presence proves nothing",
                  "checked into the repo" in message, message)

        ok, reason = runner.check_real_mode_ready()
        check("check_real_mode_ready reports not ready, so a run is refused at submit time",
              not ok and "cannot fetch" in reason, reason)

        try:
            servers = runner._resolve_mcp_servers(research=False)
            check("a repurpose session still resolves, because it fetches nothing",
                  servers == {}, repr(servers))
        except runner.RunnerConfigError as exc:
            check("a repurpose session still resolves, because it fetches nothing", False, str(exc))

    # THE TWO CREDENTIAL GROUPS ARE NOT THE SAME KIND OF THING, and this pair of checks is where
    # that is pinned. The refusal exists because a session that cannot FETCH invents sources; that
    # argument is entirely about Firecrawl. DataForSEO fetches nothing, and this contract says its
    # only contribution, keyword volume, "is NEVER a reason to drop the prompt". Refusing over it
    # blocked every blog on the machine in exchange for H2 phrasing, and said "could not fetch a
    # single page" while Firecrawl was working.
    with no_mcp_env(), env(FIRECRAWL_API_KEY="fc-test"):
        try:
            servers = runner._resolve_mcp_servers()
            check("FETCH alone is enough to run: DataForSEO no longer blocks a blog",
                  servers == {}, repr(servers))
        except runner.RunnerConfigError as exc:
            check("FETCH alone is enough to run: DataForSEO no longer blocks a blog", False,
                  str(exc))
        ok, reason = runner.check_real_mode_ready()
        check("and submit time agrees", ok, reason)

    # THE CONVERSE STILL REFUSES, which is what stops this being a way to run with no tools at all.
    with no_mcp_env(), env(DATAFORSEO_USERNAME="u", DATAFORSEO_PASSWORD="p"):
        try:
            runner._resolve_mcp_servers()
            check("keyword credentials alone are still a refusal", False, "no exception raised")
        except runner.RunnerConfigError as exc:
            check("keyword credentials alone are still a refusal, naming the fetch key",
                  "FIRECRAWL_API_KEY" in str(exc), str(exc))

    # A BLANK VALUE IS NOT A VALUE. An empty var is how a half written .env or a cleared secret
    # arrives, and a bare `in os.environ` would call it present.
    with no_mcp_env(), env(**{name: "   " for name in runner._FETCH_CRED_VARS}):
        try:
            runner._resolve_mcp_servers()
            check("a blank credential is treated as missing", False, "no exception raised")
        except runner.RunnerConfigError:
            check("a blank credential is treated as missing", True)


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
    # Credentials present: this test is about the OPTIONS, and a session on a machine with no
    # research credentials no longer builds any (see [2b]).
    with no_mcp_env(), env(**STDIO_CREDS_PRESENT):
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
    with no_mcp_env(), env(**STDIO_CREDS_PRESENT):
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
            for key, value in (entry.get("env") or {}).items():
                # A USERNAME IS NOT A SECRET, AND SCANNING FOR ONE IS A FALSE POSITIVE FACTORY.
                # DATAFORSEO_USERNAME is an email address, and the operator's email is a name this
                # app writes down on purpose: every promotion note reads "operator promotion:
                # <email> shipped this blog at 89". Grepping the tree for it flags those notes as
                # leaked credentials, so this check went red on three gitignored files with
                # nothing wrong in them, which is exactly how a guard check trains people to
                # ignore it. The password is still scanned for, and it is the half that matters.
                if key.upper().endswith(("_USERNAME", "_USER", "_LOGIN", "_EMAIL")):
                    continue
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
    for test in (test_transport_http, test_transport_stdio,
                 test_transport_stdio_without_credentials, test_transport_missing,
                 test_session_options, test_sdk_field_names, test_mcp_json_file,
                 test_repo_has_no_secrets):
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    print("config_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
