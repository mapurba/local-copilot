"""
run_pipeline.py — Reads input JSON files from input/ folder,
runs the actual pipeline (using Copilot LLM via token_manager),
and stores markdown output in output/ folder.

Input JSON format (two options):

  Option A — inline text:
  {
    "chunk": "documentation text...",
    "os_target": "ubuntu:22.04"
  }

  Option B — reference a separate markdown/text file:
  {
    "chunk_file": "sample_chunk.md",
    "os_target": "ubuntu:22.04"
  }

  chunk_file paths are reltive to the input/ directory.
"""
import json
import sys
from pathlib import Path

from pipeline import app


def main():
    input_dir = Path(__file__).parent / "input"
    output_dir = Path(__file__).parent / "output"
    output_dir.mkdir(exist_ok=True)

    input_files = sorted(input_dir.glob("*.json"))
    if not input_files:
        print(f"No JSON files found in {input_dir}")
        sys.exit(1)

    for input_file in input_files:
        print(f"\n{'='*60}")
        print(f"Processing: {input_file.name}")
        print(f"{'='*60}")

        with open(input_file) as f:
            data = json.load(f)

        chunk = data.get("chunk", "")
        os_target = data.get("os_target", "ubuntu:22.04")

        # Support chunk_file: a path to a .md/.txt file relative to input/
        if not chunk and data.get("chunk_file"):
            chunk_path = input_dir / data["chunk_file"]
            if not chunk_path.exists():
                print(f"  Skipping {input_file.name}: chunk_file '{chunk_path}' not found")
                continue
            chunk = chunk_path.read_text(encoding="utf-8")
            print(f"  Loaded chunk from: {chunk_path.name} ({len(chunk)} chars)")

        if not chunk:
            print(f"  Skipping {input_file.name}: no 'chunk' or 'chunk_file' provided")
            continue

        initial_state = {
            "chunk": chunk,
            "os_target": os_target,
        }

        print(f"  OS target: {os_target}")
        print(f"  Running pipeline...")

        result = app.invoke(initial_state)

        final_output = result.get("final_output", "")
        if not final_output:
            print(f"  WARNING: No final output generated for {input_file.name}")
            final_output = "# No output generated\n\nThe pipeline did not produce a final output."

        output_file = output_dir / f"{input_file.stem}.md"
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(final_output)

        print(f"  Output saved to: {output_file}")

    print(f"\nDone. Results in {output_dir}/")


if __name__ == "__main__":
    main()
