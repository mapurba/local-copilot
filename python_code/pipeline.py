from typing import TypedDict, Optional, Annotated
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, START, END
from pydantic import SecretStr
import subprocess
import docker
from docker.errors import APIError, ContainerError, DockerException, ImageNotFound
import tempfile
import os

from token_manager import get_token as get_copilot_token, COPILOT_HEADERS as _TM_HEADERS

COPILOT_BASE_URL = "https://api.githubcopilot.com"
COPILOT_HEADERS = {
    **_TM_HEADERS,
    "OpenAI-Intent": "conversation-panel",
}

MAX_RETRIES = 3


llm = None
_llm_token = None

def overwrite_reducer(existing: Optional[str], new: Optional[str]) -> str:
    if new is None:
        return ""
    return new

def increment_reducer(existing: Optional[int], new: Optional[int]) -> int:
    return (existing or 0) + (new or 0)

class PipelineState(TypedDict, total=False):
    chunk: str
    os_target: str
    inferred_deps: str
    draft_script: str
    lint_results: Annotated[str, overwrite_reducer]
    execution_logs: Annotated[str, overwrite_reducer]
    final_output: str
    retry_count: Annotated[int, increment_reducer]
    lint_retry_count: Annotated[int, increment_reducer]


def build_llm(model: str = "gpt-4.1"):
    return ChatOpenAI(
        model=model,
        temperature=0,
        api_key=SecretStr(get_copilot_token()),
        base_url=COPILOT_BASE_URL,
        default_headers=COPILOT_HEADERS,
        timeout=120,
        max_retries=2,
    )


def get_llm():
    global llm, _llm_token

    current_token = get_copilot_token()
    if llm is None or _llm_token != current_token:
        print(f"[Pipeline] Building LLM instance (base_url={COPILOT_BASE_URL}, model=gpt-4.1)")
        _llm_token = current_token
        llm = build_llm()
    return llm

def architect_node(state: PipelineState):
    chunk = state.get("chunk", "")
    os_target = state.get("os_target", "")

    prompt = f"""You are an Expert System Architect. Read the following 80% detailed installation documentation and identify what OS-level prerequisites are missing to make it run 100% accurately on {os_target}.

Documentation:
{chunk}

List the missing prerequisites explicitly (e.g., missing library dependencies, unconfigured environment variables like LD_LIBRARY_PATH, missing user/group creation, or missing utility packages like unzip or tar)."""

    print("[Pipeline] architect_node: Calling LLM...")
    response = get_llm().invoke([SystemMessage(content="You are a System Architect."), HumanMessage(content=prompt)])
    print(f"[Pipeline] architect_node: Got response ({len(str(response.content))} chars)")
    return {"inferred_deps": str(response.content)}

def coder_node(state: PipelineState):
    chunk = state.get("chunk", "")
    inferred_deps = state.get("inferred_deps", "")
    lint_results = state.get("lint_results", "")
    execution_logs = state.get("execution_logs", "")
    os_target = state.get("os_target", "")
    draft_script = state.get("draft_script", "")

    prompt = f"""You are a DevOps Automation Engineer. Write a fully automated, idempotent Bash script for {os_target} based on the following documentation and inferred prerequisites.

Documentation:
{chunk}

Inferred Prerequisites:
{inferred_deps}
"""
    if draft_script and (lint_results or execution_logs):
        prompt += f"\n\nPrevious Draft Script:\n{draft_script}\n"
        if lint_results:
            prompt += f"\nLint Errors to fix:\n{lint_results}\n"
        if execution_logs:
            prompt += f"\nExecution Logs/Feedback to fix:\n{execution_logs}\n"

    prompt += """
Requirements:
1. Every script must begin with `#!/bin/bash` and `set -euo pipefail`.
2. Idempotency is mandatory (e.g., `mkdir -p`, check if file exists before appending, use sed/grep to check settings).
3. No Placeholders. If unknown, define as a variable with a safe default at the top.
4. Output ONLY the raw bash script in a fenced bash block, nothing else. Never truncate the code.
"""

    print("[Pipeline] coder_node: Calling LLM...")
    response = get_llm().invoke([SystemMessage(content="You are a DevOps Automation Engineer."), HumanMessage(content=prompt)])
    print(f"[Pipeline] coder_node: Got response ({len(str(response.content))} chars)")
    content = str(response.content)

    if "```bash" in content:
        script = content.split("```bash")[1].split("```")[0].strip()
    elif "```" in content:
        script = content.split("```")[1].split("```")[0].strip()
    else:
        script = content.strip()

    # Crucial: return None for lint_results and execution_logs to override any previous failures in the state using the reducer
    lint_increment = 1 if (lint_results and lint_results.strip()) else 0
    return {"draft_script": script, "lint_results": None, "execution_logs": None, "lint_retry_count": lint_increment}

def senior_dev_node(state: PipelineState):
    execution_logs = state.get("execution_logs", "")
    draft_script = state.get("draft_script", "")

    prompt = f"""You are a Senior Dev. The following script failed to execute in the sandbox.

Script:
{draft_script}

Stderr Logs:
{execution_logs}

Analyze why it failed and provide instructions on what needs to be fixed to append to the inferred dependencies."""

    print("[Pipeline] senior_dev_node: Calling LLM...")
    response = get_llm().invoke([SystemMessage(content="You are a Senior Dev."), HumanMessage(content=prompt)])
    print(f"[Pipeline] senior_dev_node: Got response ({len(str(response.content))} chars)")
    analysis = str(response.content)

    new_inferred_deps = state.get("inferred_deps", "") + "\n\nSenior Dev Analysis of Failure:\n" + analysis
    return {"inferred_deps": new_inferred_deps, "retry_count": 1}

def publisher_node(state: PipelineState):
    chunk = state.get("chunk", "")
    draft_script = state.get("draft_script", "")
    inferred_deps = state.get("inferred_deps", "")

    prompt = f"""You are a Publisher. Create a clean Markdown document that includes:
1. Context: Briefly explain what this script accomplishes and highlight any prerequisites inferred.
2. The Script: Provide the complete, runnable Bash script in a fenced bash block.

Original documentation:
{chunk}

Inferred dependencies/context:
{inferred_deps}

Final Script:
{draft_script}

Do not truncate the code."""

    print("[Pipeline] publisher_node: Calling LLM...")
    response = get_llm().invoke([SystemMessage(content="You are a Publisher."), HumanMessage(content=prompt)])
    print(f"[Pipeline] publisher_node: Got response ({len(str(response.content))} chars)")
    content = str(response.content).strip()

    if content:
        return {"final_output": content}

    fallback_output = f"""# Final Script

## Context
{inferred_deps or 'No inferred prerequisites were provided.'}

## Script
```bash
{draft_script}
```

## Source
{chunk.strip()}
""".strip()
    return {"final_output": fallback_output}

def linter_node(state: PipelineState):
    print("[Pipeline] linter_node: Running shellcheck/bash -n...")
    draft_script = state.get("draft_script", "")

    # Save script to a temporary file
    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.sh') as f:
        f.write(draft_script)
        temp_path = f.name

    try:
        try:
            result = subprocess.run(
                ["shellcheck", temp_path],
                capture_output=True,
                text=True,
                check=False,
            )
        except FileNotFoundError:
            result = subprocess.run(
                ["bash", "-n", temp_path],
                capture_output=True,
                text=True,
                check=False,
            )

        if result.returncode != 0:
            print(f"[Pipeline] linter_node: FAILED (rc={result.returncode})")
            return {"lint_results": (result.stdout + "\n" + result.stderr).strip()}
        print("[Pipeline] linter_node: PASSED")
        return {"lint_results": ""}
    finally:
        os.remove(temp_path)

def sandbox_node(state: PipelineState):
    print("[Pipeline] sandbox_node: Running script in Docker...")
    draft_script = state.get("draft_script", "")
    os_target = state.get("os_target", "almalinux:8")

    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.sh') as f:
        f.write(draft_script)
        temp_path = f.name

    try:
        client = docker.from_env()

        # Pull image if not present locally
        try:
            client.images.get(os_target)
        except ImageNotFound:
            client.images.pull(os_target)

        # Ensure script is executable and readable by Docker daemon
        os.chmod(temp_path, 0o777)

        container = client.containers.run(
            image=os_target,
            command=["/bin/bash", "-c", "/script.sh"],
            volumes={temp_path: {'bind': '/script.sh', 'mode': 'ro'}},
            detach=True,
        )

        result = container.wait()
        logs = container.logs().decode('utf-8')
        container.remove()

        if result['StatusCode'] != 0:
            print(f"[Pipeline] sandbox_node: FAILED (exit={result['StatusCode']})")
            return {"execution_logs": logs}
        print("[Pipeline] sandbox_node: PASSED")
        return {"execution_logs": ""}

    except ContainerError as e:
        stderr = e.stderr.decode('utf-8', errors='replace') if isinstance(e.stderr, bytes) else str(e.stderr or '')
        return {"execution_logs": stderr}
    except DockerException as e:
        return {"execution_logs": str(e)}
    finally:
        os.remove(temp_path)

def route_after_lint(state: PipelineState):
    lint_res = state.get("lint_results")
    # if it's explicitly set to an error string (and not None or "")
    if lint_res and len(str(lint_res).strip()) > 0:
        if (state.get("lint_retry_count") or 0) >= MAX_RETRIES:
            print(f"[Pipeline] route_after_lint: max lint retries ({MAX_RETRIES}) reached, proceeding to sandbox")
            return "sandbox"
        return "coder"
    return "sandbox"

def route_after_sandbox(state: PipelineState):
    exec_logs = state.get("execution_logs")
    if exec_logs and len(str(exec_logs).strip()) > 0:
        if (state.get("retry_count") or 0) >= MAX_RETRIES:
            return "publisher"
        return "senior_dev"
    return "publisher"

# Build the Graph
workflow = StateGraph(PipelineState)

# Add nodes
workflow.add_node("architect", architect_node)
workflow.add_node("coder", coder_node)
workflow.add_node("linter", linter_node)
workflow.add_node("sandbox", sandbox_node)
workflow.add_node("senior_dev", senior_dev_node)
workflow.add_node("publisher", publisher_node)

# Add edges
workflow.add_edge(START, "architect")
workflow.add_edge("architect", "coder")
workflow.add_edge("coder", "linter")

workflow.add_conditional_edges(
    "linter",
    route_after_lint,
    {
        "coder": "coder",
        "sandbox": "sandbox"
    }
)

workflow.add_conditional_edges(
    "sandbox",
    route_after_sandbox,
    {
        "senior_dev": "senior_dev",
        "publisher": "publisher"
    }
)

workflow.add_edge("senior_dev", "coder")
workflow.add_edge("publisher", END)

# Compile graph
app = workflow.compile()
