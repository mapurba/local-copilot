from typing import TypedDict, Optional
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, START, END
from pydantic import SecretStr
import os

from token_manager import get_token as get_copilot_token, COPILOT_HEADERS as _TM_HEADERS

COPILOT_BASE_URL = "https://api.githubcopilot.com"
COPILOT_HEADERS = {
    **_TM_HEADERS,
    "OpenAI-Intent": "conversation-panel",
}

llm = None
_llm_token = None

class PipelineState(TypedDict, total=False):
    chunk: str        # original input documentation
    final_output: str # refined output


def build_llm(model: str = "gpt-4.1"):
    return ChatOpenAI(
        model=model,
        temperature=0,
        api_key=SecretStr(get_copilot_token()),
        base_url=COPILOT_BASE_URL,
        default_headers=COPILOT_HEADERS,
        timeout=300,
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

def refiner_node(state: PipelineState):
    chunk = state.get("chunk", "")

    prompt = f"""You are an expert Technical Documentation Refiner. In a single pass, analyze and rewrite the following documentation to be complete, unambiguous, and fully LLM-friendly.

Documentation:
{chunk}

Instructions:
1. First silently identify all gaps: missing prerequisites, ambiguous steps, assumed knowledge, missing validation steps, incomplete config examples, unclear ordering, missing error handling.
2. Then produce the complete rewritten documentation that fixes every gap found.

Output requirements:
- Preserve all original content — expand and clarify, never remove.
- Add an explicit Prerequisites section (packages, users, env vars, permissions).
- Replace vague steps with precise, unambiguous instructions.
- Add a verification checkpoint after each major step.
- Complete all configuration examples — no placeholders.
- Make all implicit knowledge explicit.
- Use consistent markdown: H1/H2/H3 headings, fenced code blocks with language tags, numbered steps.

Output only the final refined documentation in clean markdown. Do not include your gap analysis or any meta-commentary. Do not truncate."""

    print("[Pipeline] refiner_node: Calling LLM...")
    response = get_llm().invoke([SystemMessage(content="You are an expert Technical Documentation Refiner."), HumanMessage(content=prompt)])
    print(f"[Pipeline] refiner_node: Got response ({len(str(response.content))} chars)")
    return {"final_output": str(response.content).strip()}

# Build the Graph
workflow = StateGraph(PipelineState)

workflow.add_node("refiner", refiner_node)

# START → refiner → END  (single LLM call)
workflow.add_edge(START, "refiner")
workflow.add_edge("refiner", END)

# Compile graph
app = workflow.compile()
