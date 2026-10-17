"""Deploy (or update) the back-office agent on Vertex AI Agent Engine and print its resource name.

    python deploy.py --project hear-it-once --location us-central1 --bucket gs://hear-it-once-agent-staging
"""
import argparse
import os
import sys

import vertexai
from vertexai import agent_engines

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

DISPLAY_NAME = "northstar-backoffice"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--location", default="us-central1")
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--dataset", default="northstar_bank")
    ap.add_argument("--bq-location", default="asia-southeast1")
    ap.add_argument("--model", default="gemini-2.5-flash")
    a = ap.parse_args()
    if a.project == "ulink-claimflow":
        sys.exit("Refusing to touch project ulink-claimflow.")

    os.environ.update(BQ_PROJECT=a.project, BQ_DATASET=a.dataset, BQ_LOCATION=a.bq_location, AGENT_MODEL=a.model)
    vertexai.init(project=a.project, location=a.location, staging_bucket=a.bucket)
    from northstar_backoffice.agent import root_agent  # noqa: E402  (reads the env above)

    app = agent_engines.AdkApp(agent=root_agent, enable_tracing=True)
    kwargs = dict(
        requirements=[l.strip() for l in open(os.path.join(HERE, "requirements.txt")) if l.strip() and not l.startswith("#")],
        extra_packages=[os.path.join(HERE, "northstar_backoffice")],
        display_name=DISPLAY_NAME,
        description="Read-only back-office analyst over the Northstar Bank BigQuery dataset (Hear It Once).",
        env_vars={"BQ_PROJECT": a.project, "BQ_DATASET": a.dataset, "BQ_LOCATION": a.bq_location, "AGENT_MODEL": a.model},
    )
    existing = [e for e in agent_engines.list(filter=f'display_name="{DISPLAY_NAME}"')]
    if existing:
        print(f"Updating {existing[0].resource_name} …", flush=True)
        remote = agent_engines.update(resource_name=existing[0].resource_name, agent_engine=app, **kwargs)
    else:
        print("Creating the agent on Vertex AI Agent Engine (about 5 to 10 minutes) …", flush=True)
        remote = agent_engines.create(agent_engine=app, **kwargs)
    print(f"AGENT_ENGINE_RESOURCE={remote.resource_name}")


if __name__ == "__main__":
    main()
