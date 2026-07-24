"""Repurpose a shipped blog into one channel-native piece (LinkedIn post, Medium article).

A repurpose run is a MUCH simpler cousin of a blog run, and it reuses the blog run's
machinery on purpose so it shows up on every surface a blog run does:

- It registers in runner.RUNS with kind="repurpose", so /api/runs lists it and the overview
  shows it as a running session, and runner.stop_client cancels it like any other run.
- Its progress is one status.jsonl the SSE tail already knows how to read, written through the
  SAME .claude/status.py the blog agents use.
- It opens ONE SDK session under the SAME TOPIC_SEMAPHORE, so concurrency stays bounded.

What it does NOT reuse: the R/W/E chain, gates, eval, the revise loop, questions/answers, the
ledger, and the record. A repurpose is generate -> review, nothing more. The runner (not an
agent) writes every status line here, so the run is robust even if the session forgets to log.

Artifacts and status live UNDER the source blog's dir, at
  outputs/<client>/<topic>/repurpose/<channel>/{source.md, post.md, status.jsonl}
The run's topic_slug is the synthetic "<topic>/repurpose/<channel>", which is what points the
SSE tail (runner.output_dir(client, topic_slug)/status.jsonl) at the right file. That synthetic
slug never reaches blog code: app._live_run_slugs skips kind="repurpose" runs, so it can never
surface as a phantom blog.

DB-free by design: the endpoint resolves the source blog markdown (disk or record) and hands the
body in, so this module depends only on runner.
"""
import asyncio
import sys
from contextlib import aclosing

from . import runner

CHANNELS = ("linkedin", "medium")


def synthetic_slug(source_topic_slug, channel):
    """The run's topic_slug. A path suffix with slashes, which output_dir joins into a nested
    dir under the source blog. Never a real blog slug, so blog code that skips repurpose runs
    never sees it."""
    return f"{source_topic_slug}/repurpose/{channel}"


def repurpose_dir(client_slug, source_topic_slug, channel, root=None):
    return runner.output_dir(client_slug, synthetic_slug(source_topic_slug, channel), root=root)


def _lead_prompt(client_slug, source_topic_slug, channel, out_dir):
    skill = f"{channel}-repurposer"
    label = "LinkedIn post" if channel == "linkedin" else "Medium article"
    source = out_dir / "source.md"
    artifact = out_dir / "post.md"
    clients_dir = runner.REPO_ROOT / "clients" / client_slug
    return (
        f"You are repurposing one finished client blog into a {label} for the client "
        f"`{client_slug}`.\n\n"
        f"The source blog is at:\n  {source}\nRead the whole file.\n\n"
        f"The client's binding configuration is under:\n  {clients_dir}/\n"
        f"Read client.md, gates.json, and canonical-facts.md there. canonical-facts.md is "
        f"BINDING: never write a claim that contradicts it. Honor the voice block, "
        f"banned_phrases, and competitor policy in gates.json.\n\n"
        f"Run the `{skill}` skill and follow it exactly. It writes ONE {label}, ghostwritten "
        f"in the client's brand voice, as a fresh cut of the source blog, never a copy-paste.\n\n"
        f"Write the finished {label} to EXACTLY this path:\n  {artifact}\n"
        f"Write nothing else to disk and do not print the piece to the conversation. The file "
        f"at that path IS the deliverable. When it is written, you are done."
    )


async def _sdk_session(client_slug, source_topic_slug, channel, out_dir):
    """One repurpose, one SDK session. Reuses the blog session options (MCP, env, the Skill and
    Write tools). aclosing for the same reason run_topic uses it: a cancelled session must tear
    its CLI child down deterministically rather than orphan it spending quota."""
    from claude_agent_sdk import query

    try:
        from claude_agent_sdk import ClaudeSDKError
    except ImportError:
        ClaudeSDKError = ()

    options = runner._session_options()
    prompt = _lead_prompt(client_slug, source_topic_slug, channel, out_dir)
    try:
        async with aclosing(query(prompt=prompt, options=options)) as session:
            async for _message in session:
                # Consume and discard. The runner reads the outcome from the artifact on disk,
                # never from agent output, exactly like the blog session.
                pass
    except ClaudeSDKError as exc:
        # A dead CLI is a died session, not a crash. Return; run_repurpose sees no post.md and
        # writes the failed terminal line.
        print(f"[repurpose] SDK session for {source_topic_slug}/{channel} died: {exc}",
              file=sys.stderr)
        return


def _stop_line(out_dir, synthetic, baseline):
    """Append the terminal 'stopped' line for a repurpose THIS session left without a verdict.

    Guarded exactly like runner._stop_line_if_unterminated: a draft that reached 'done'
    microseconds before the cancel landed keeps it, because status.jsonl is append-only and the
    tail reads the last terminal line. No questions arm, because a repurpose never asks anything.
    """
    lines = runner._read_status(out_dir)
    if runner._terminal_line(lines[baseline:]) is not None:
        return False
    last = lines[-1] if lines else {}
    runner._status_module().append_status(
        str(out_dir), synthetic,
        stage=last.get("stage", "write"), event="end",
        iter=last.get("iter", 1), status="stopped",
        note="operator stopped the run before the repurpose finished",
    )
    return True


async def run_repurpose(client_slug, source_topic_slug, channel, source_body,
                        *, run_id, run_dir_root=None):
    """One repurpose run: write the source, open the session, write the terminal line.

    The run is already registered (queued) by the endpoint. This flips it running when it takes
    a semaphore slot, and every status line here is written by the runner, not the agent.
    """
    out_dir = repurpose_dir(client_slug, source_topic_slug, channel, root=run_dir_root)
    out_dir.mkdir(parents=True, exist_ok=True)
    synthetic = synthetic_slug(source_topic_slug, channel)
    (out_dir / "source.md").write_text(source_body, encoding="utf-8")
    artifact = out_dir / "post.md"

    append = runner._status_module().append_status
    # Prior regenerate lines already in the file: the stop guard only weighs THIS session's slice.
    baseline = len(runner._read_status(out_dir))

    try:
        async with runner.TOPIC_SEMAPHORE:
            runner.mark_running(run_id)
            append(str(out_dir), synthetic, stage="write", event="start", iter=1,
                   status="running", note=f"repurpose to {channel}")
            await _sdk_session(client_slug, source_topic_slug, channel, out_dir)

        if artifact.is_file() and artifact.stat().st_size > 0:
            append(str(out_dir), synthetic, stage="write", event="end", iter=1,
                   status="done", note=f"{channel} draft ready")
        else:
            append(str(out_dir), synthetic, stage="write", event="end", iter=1,
                   status="failed", note="session produced no post.md")
    except asyncio.CancelledError:
        # Operator stop. Write the stopped line (guarded), then never swallow the cancel.
        _stop_line(out_dir, synthetic, baseline)
        raise
    except Exception as exc:
        print(f"[repurpose] {client_slug}/{source_topic_slug}/{channel} failed: {exc}",
              file=sys.stderr)
        # One terminal line so the SSE stream closes and the row stops showing "generating",
        # unless this session already wrote one.
        if runner._terminal_line(runner._read_status(out_dir)[baseline:]) is None:
            append(str(out_dir), synthetic, stage="write", event="end", iter=1,
                   status="failed", note=f"repurpose error: {exc}")


# ---------------------------------------------------------------------------
# Reads: the artifact and the per-channel listing. Both are plain disk scans; a repurpose is
# never in the record, so there is no split to reason about.
# ---------------------------------------------------------------------------

def _iso(mtime):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(mtime, timezone.utc).isoformat()


def artifact(client_slug, source_topic_slug, channel, root=None):
    """One channel artifact's text plus its stamp, or None when it was never generated."""
    art = repurpose_dir(client_slug, source_topic_slug, channel, root=root) / "post.md"
    if not art.is_file():
        return None
    st = art.stat()
    return {
        "content": art.read_text(encoding="utf-8"),
        "generated_at": _iso(st.st_mtime),
        "chars": st.st_size,
    }


def listing(client_slug, channel, root=None):
    """{source_topic_slug: {generated_at, chars}} for every blog that has a <channel> artifact.

    A flat disk scan of outputs/<client>/*/repurpose/<channel>/post.md, so the channel tab can
    tell in one call which published blogs already have a piece and which still need one.
    """
    root_dir = runner.client_output_dir(client_slug, root=root)
    out = {}
    if not root_dir.is_dir():
        return out
    for topic_dir in sorted(root_dir.iterdir()):
        if not topic_dir.is_dir():
            continue
        art = topic_dir / "repurpose" / channel / "post.md"
        if art.is_file():
            st = art.stat()
            out[topic_dir.name] = {"generated_at": _iso(st.st_mtime), "chars": st.st_size}
    return out
