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


def configure_memory_bank(project: str, location: str, resource_name: str, model: str) -> None:
    """Turn on Memory Bank for this engine.

    It is not a parameter of agent_engines.create or .update — neither accepts one — and it is not
    in the v1 API at all. It is a field on the ReasoningEngine resource itself, in v1beta1, so it
    is set here by patching the engine once it exists.

    What it holds is soft context between calls: a preferred name, that someone travels, a merchant
    they have raised before. Never anything a decision rests on — identity, card status, balances
    and eligibility are read from the bank's records on every call. src/memory/memory-bank.ts is
    where that line is enforced, on the way in and on the way out.

    A failure here is reported and does not fail the deploy: the agent answers perfectly well
    without memory, and a half-deployed agent would be worse than one with no memory.
    """
    try:
        from google.cloud import aiplatform_v1beta1 as v1b1
        from google.protobuf import field_mask_pb2

        client = v1b1.ReasoningEngineServiceClient(
            client_options={"api_endpoint": f"{location}-aiplatform.googleapis.com"}
        )
        pub = f"projects/{project}/locations/{location}/publishers/google/models"
        engine = v1b1.ReasoningEngine(
            name=resource_name,
            context_spec=v1b1.ReasoningEngineContextSpec(
                memory_bank_config=v1b1.ReasoningEngineContextSpec.MemoryBankConfig(
                    generation_config=v1b1.ReasoningEngineContextSpec.MemoryBankConfig.GenerationConfig(
                        model=f"{pub}/{model}"
                    ),
                    similarity_search_config=v1b1.ReasoningEngineContextSpec.MemoryBankConfig.SimilaritySearchConfig(
                        embedding_model=f"{pub}/text-embedding-005"
                    ),
                )
            ),
        )
        client.update_reasoning_engine(
            reasoning_engine=engine,
            update_mask=field_mask_pb2.FieldMask(paths=["context_spec"]),
        )
        print("Memory Bank configured on the engine.", flush=True)
    except Exception as e:  # noqa: BLE001 — the agent is useful without memory
        print(f"WARNING: could not configure Memory Bank ({e}). The agent is deployed and works; memory is off.", flush=True)


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
    # The agent's own package travels as a relative path: it is unpacked beside the app on the
    # server and imported by that name, so an absolute path from this machine would not be found.
    os.chdir(HERE)
    vertexai.init(project=a.project, location=a.location, staging_bucket=a.bucket)
    from northstar_backoffice.agent import root_agent  # noqa: E402  (reads the env above)

    app = agent_engines.AdkApp(agent=root_agent, enable_tracing=True)
    kwargs = dict(
        requirements=[l.strip() for l in open("requirements.txt") if l.strip() and not l.startswith("#")],
        extra_packages=["northstar_backoffice"],
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
    configure_memory_bank(a.project, a.location, remote.resource_name, a.model)
    print(f"AGENT_ENGINE_RESOURCE={remote.resource_name}")


if __name__ == "__main__":
    main()
