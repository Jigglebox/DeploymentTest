"""Run any OpenAI-SDK agent through AgentFuse: two environment variables, no code changes.

    pip install openai
    export OPENAI_BASE_URL=http://localhost:8787/openai/v1   # your AgentFuse instance
    export OPENAI_API_KEY=af_live_...                        # an AgentFuse agent key, not your real key
    python examples/agentfuse-openai.py
"""
import os
from openai import OpenAI, APIStatusError

client = OpenAI()  # reads OPENAI_BASE_URL + OPENAI_API_KEY

try:
    for i in range(3):
        r = client.chat.completions.with_raw_response.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": f"Say hello #{i} in five words."}],
            max_tokens=50,
            extra_headers={"X-AgentFuse-Run": os.environ.get("RUN_ID", "demo-run")},  # optional per-run budget scope
        )
        print(r.parse().choices[0].message.content)
        print("  cost:", r.headers.get("x-agentfuse-cost-usd"), "remaining this month:", r.headers.get("x-agentfuse-month-remaining-usd"))
except APIStatusError as e:
    if e.status_code == 402:  # AgentFuse refused the call: budget, loop, or tripped breaker
        print("AgentFuse blocked the request:", e.body["error"]["code"], "-", e.body["error"]["message"])
    else:
        raise
