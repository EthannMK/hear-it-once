"""What the back-office agent's SQL tool refuses, checked against a fake BigQuery client.

The agent is read-only by design: it may run one SELECT, only over the agent_* views, and only if
the dry run says it will not scan more than the cap. These tests stand a fake client in place of
BigQuery so the guards can be checked without a project, credentials or a bill.

Run:  python -m pytest agents/backoffice/test_tools.py -q
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

# google.cloud.bigquery is not installed in every environment this runs in, and none of these tests
# need the real thing: a stand-in with the one class the tool builds gives the same code path.
if "google.cloud.bigquery" not in sys.modules:  # pragma: no cover - depends on the environment
    try:
        from google.cloud import bigquery  # type: ignore # noqa: F401
    except Exception:
        google = sys.modules.setdefault("google", types.ModuleType("google"))
        cloud = sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
        bq = types.ModuleType("google.cloud.bigquery")

        class QueryJobConfig:  # noqa: D401 - a stand-in for the real config object
            def __init__(self, **kw):
                self.__dict__.update(kw)

        bq.QueryJobConfig = QueryJobConfig
        sys.modules["google.cloud.bigquery"] = bq
        google.cloud = cloud
        cloud.bigquery = bq

# Import the tools module on its own. The package's __init__ pulls in the ADK agent, which needs
# google-adk installed; these tests are about the SQL guards and do not need the agent at all.
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("northstar_tools", Path(__file__).resolve().parent / "northstar_backoffice" / "tools.py")
tools = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(tools)


class FakeTable:
    def __init__(self, project, dataset_id, table_id):
        self.project, self.dataset_id, self.table_id = project, dataset_id, table_id


class FakeRow(dict):
    """A BigQuery row as the tool reads it: a mapping with .items()."""


class FakeJob:
    """What client.query returns: a dry run carries the plan, a real run carries rows."""

    def __init__(self, *, statement_type="SELECT", tables=(), scanned=1_000, rows=()):
        self.statement_type = statement_type
        self.referenced_tables = list(tables)
        self.total_bytes_processed = scanned
        self._rows = list(rows)

    def result(self, max_results=None):
        return self._rows[: max_results or len(self._rows)]

    def __iter__(self):
        return iter(self._rows)


class FakeClient:
    """Records every query it is asked to run, so a test can prove nothing was executed."""

    def __init__(self, dry=None, live=None, raises=None):
        self.dry = dry or FakeJob(tables=[FakeTable(tools.PROJECT, tools.DATASET, "agent_transactions")])
        self.live = live or FakeJob(rows=[FakeRow(n=3)])
        self.raises = raises
        self.dry_runs: list[str] = []
        self.executed: list[str] = []

    def query(self, sql, job_config=None):
        if self.raises:
            raise self.raises
        if getattr(job_config, "dry_run", False):
            self.dry_runs.append(sql)
            return self.dry
        self.executed.append(sql)
        return self.live


@pytest.fixture()
def client():
    c = FakeClient()
    tools.set_client_for_tests(c)
    yield c
    tools.set_client_for_tests(None)


def test_a_plain_select_over_an_allowed_view_runs(client):
    out = tools.run_sql("SELECT COUNT(*) AS n FROM agent_transactions WHERE customer_id = 'CUS-1001'")
    assert out["status"] == "ok"
    assert out["row_count"] == 1
    assert client.executed, "the query should have been run after the dry run passed"


@pytest.mark.parametrize("sql", ["", "   ", None])
def test_empty_sql_is_refused_without_touching_bigquery(client, sql):
    out = tools.run_sql(sql)
    assert out["status"] == "refused"
    assert not client.dry_runs and not client.executed


def test_two_statements_are_refused(client):
    out = tools.run_sql("SELECT 1; DROP TABLE agent_transactions")
    assert out["status"] == "refused"
    assert "one statement" in out["reason"].lower()
    assert not client.executed


def test_a_very_long_query_is_refused(client):
    out = tools.run_sql("SELECT " + "1," * 3000 + "1 FROM agent_transactions")
    assert out["status"] == "refused"
    assert not client.executed


@pytest.mark.parametrize(
    "statement_type",
    ["INSERT", "UPDATE", "DELETE", "MERGE", "CREATE_TABLE", "DROP_TABLE", "ALTER_TABLE", "SCRIPT", "CALL"],
)
def test_anything_that_is_not_a_select_is_refused(statement_type):
    c = FakeClient(dry=FakeJob(statement_type=statement_type, tables=[FakeTable(tools.PROJECT, tools.DATASET, "agent_transactions")]))
    tools.set_client_for_tests(c)
    try:
        out = tools.run_sql("UPDATE agent_transactions SET status = 'posted'")
        assert out["status"] == "refused"
        assert "select" in out["reason"].lower()
        assert not c.executed, "a write must never reach BigQuery"
    finally:
        tools.set_client_for_tests(None)


def test_a_table_outside_the_agent_views_is_refused():
    c = FakeClient(dry=FakeJob(tables=[FakeTable(tools.PROJECT, tools.DATASET, "customers")]))
    tools.set_client_for_tests(c)
    try:
        out = tools.run_sql("SELECT * FROM customers")
        assert out["status"] == "refused"
        assert "agent_" in out["reason"]
        assert f"{tools.PROJECT}.{tools.DATASET}.customers" in out["reason"]
        assert not c.executed
    finally:
        tools.set_client_for_tests(None)


def test_another_project_or_dataset_is_refused():
    c = FakeClient(dry=FakeJob(tables=[FakeTable("some-other-project", tools.DATASET, "agent_transactions")]))
    tools.set_client_for_tests(c)
    try:
        out = tools.run_sql("SELECT * FROM `some-other-project.northstar_bank.agent_transactions`")
        assert out["status"] == "refused"
        assert not c.executed
    finally:
        tools.set_client_for_tests(None)


def test_one_disallowed_table_among_allowed_ones_still_refuses():
    c = FakeClient(dry=FakeJob(tables=[
        FakeTable(tools.PROJECT, tools.DATASET, "agent_transactions"),
        FakeTable(tools.PROJECT, tools.DATASET, "cards"),
    ]))
    tools.set_client_for_tests(c)
    try:
        out = tools.run_sql("SELECT * FROM agent_transactions JOIN cards USING (card_id)")
        assert out["status"] == "refused"
        assert "cards" in out["reason"]
        assert not c.executed
    finally:
        tools.set_client_for_tests(None)


def test_a_query_that_would_scan_too_much_is_refused():
    c = FakeClient(dry=FakeJob(tables=[FakeTable(tools.PROJECT, tools.DATASET, "agent_transactions")], scanned=tools.MAX_BYTES + 1))
    tools.set_client_for_tests(c)
    try:
        out = tools.run_sql("SELECT * FROM agent_transactions")
        assert out["status"] == "refused"
        assert "scan" in out["reason"].lower()
        assert not c.executed
    finally:
        tools.set_client_for_tests(None)


def test_a_query_right_at_the_limit_is_allowed():
    c = FakeClient(dry=FakeJob(tables=[FakeTable(tools.PROJECT, tools.DATASET, "agent_transactions")], scanned=tools.MAX_BYTES))
    tools.set_client_for_tests(c)
    try:
        assert tools.run_sql("SELECT * FROM agent_transactions")["status"] == "ok"
    finally:
        tools.set_client_for_tests(None)


def test_bad_sql_comes_back_as_an_error_not_a_crash():
    c = FakeClient(raises=ValueError("Syntax error: Unexpected keyword FROM at [1:8]"))
    tools.set_client_for_tests(c)
    try:
        out = tools.run_sql("SELECT FROM")
        assert out["status"] == "error"
        assert "Syntax error" in out["reason"]
    finally:
        tools.set_client_for_tests(None)


def test_an_error_reason_is_cut_short_so_nothing_large_is_echoed_back():
    c = FakeClient(raises=ValueError("x" * 5000))
    tools.set_client_for_tests(c)
    try:
        assert len(tools.run_sql("SELECT 1")["reason"]) <= 400
    finally:
        tools.set_client_for_tests(None)


def test_every_allowed_table_is_an_agent_view_or_the_public_reference_data():
    for name in tools.ALLOWED_TABLES:
        assert name.startswith("agent_") or name == "reference_card_transactions", name
