"""Raw source versions compose with native clocks and additive metadata claims.

This exercises the public backend contract used by the Paperclip integration,
not the plugin's ID-generation or trust-envelope formatter. Distinct version IDs
are a caller convention, not a backend promise that document IDs cannot be
replaced. A claimed supersession must not rewrite or invalidate the earlier raw
source. Provider interpretation is scripted; this does not judge extraction.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime
from hashlib import sha256

import pytest
from hindsight_client import Hindsight

from hindsight_system_tests import LLMStub
from hindsight_system_tests.payloads import consolidation, extracted, fact

pytestmark = pytest.mark.asyncio

PREFIX = "paperclip.provenance."
SOURCE_ID = "source-comment-1"
RECORDED_AT = "2026-10-25T14:30:00Z"
OBSERVED_AT = "2024-02-29T10:00:00+05:30"
FIRST_CONTENT = "Version-one source comment: the deployment lane is blue. Occurrence time unknown."
SECOND_CONTENT = "Version-two source comment: the deployment lane is green. This claims to supersede the blue version."
FIRST_FACT = "Version-one source reported the blue deployment lane"
SECOND_FACT = "Version-two source reported the green deployment lane"


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


async def test_source_versions_keep_raw_evidence_and_claims_additive(
    client: Hindsight,
    llm: LLMStub,
    bank_id: str,
    settled: Callable[[str], Awaitable[None]],
) -> None:
    llm.on_step("extract_facts", contains="Version-one source comment:").returns(extracted(fact(FIRST_FACT)))
    llm.on_step("extract_facts", contains="Version-two source comment:").returns(extracted(fact(SECOND_FACT)))
    # Background work remains enabled and awaited, even though this story does
    # not ask consolidation to create any derived observations.
    llm.on_step("consolidate").returns(consolidation())

    first_id = f"paperclip-comment-{SOURCE_ID}-{sha256(FIRST_CONTENT.encode()).hexdigest()}"
    second_id = f"paperclip-comment-{SOURCE_ID}-{sha256(SECOND_CONTENT.encode()).hexdigest()}"
    first_metadata = {
        "companyId": "fixture-company",
        "agentId": "fixture-agent",
        "issueId": "fixture-prior-task",
        "runId": "fixture-run-one",
        f"{PREFIX}source_type": "issue_comment",
        f"{PREFIX}source_id": SOURCE_ID,
        f"{PREFIX}source_ref": f"paperclip:issue-comment:{SOURCE_ID}",
        f"{PREFIX}role": "agent",
        f"{PREFIX}recorded_at": RECORDED_AT,
    }
    second_metadata = {
        **first_metadata,
        "runId": "fixture-run-two",
        f"{PREFIX}source_updated_at": OBSERVED_AT,
        f"{PREFIX}valid_until": "2030-01-01T00:00:00Z",
        f"{PREFIX}supersedes": first_id,
    }

    # Omitted/null timestamp means now. The explicit native sentinel is needed
    # to keep an unavailable source clock unknown instead of manufacturing one.
    await client.aretain_batch(
        bank_id=bank_id,
        items=[
            {
                "content": FIRST_CONTENT,
                "document_id": first_id,
                "timestamp": "unset",
                "metadata": first_metadata,
            }
        ],
    )
    await settled(bank_id)
    before_document = await client.documents.get_document(bank_id, first_id)
    before_memories = await client.memory.list_memories(bank_id, document_id=first_id, limit=100)
    assert before_document.original_text == FIRST_CONTENT
    assert before_memories.total == 1
    before = before_memories.items[0]
    assert before.text == FIRST_FACT
    assert before.metadata == first_metadata
    assert before.mentioned_at is None
    assert before.occurred_start is None
    assert before.occurred_end is None

    await client.aretain(
        bank_id=bank_id,
        content=SECOND_CONTENT,
        document_id=second_id,
        timestamp=_instant(OBSERVED_AT),
        metadata=second_metadata,
    )
    await settled(bank_id)

    listing = await client.documents.list_documents(bank_id, limit=100)
    assert listing.total == 2
    assert {document.id for document in listing.items} == {first_id, second_id}
    original = await client.documents.get_document(bank_id, first_id)
    revised = await client.documents.get_document(bank_id, second_id)
    assert original.original_text == FIRST_CONTENT
    assert original.content_hash == before_document.content_hash
    assert original.document_metadata == first_metadata
    assert revised.original_text == SECOND_CONTENT
    assert revised.document_metadata == second_metadata
    assert original.memory_unit_count == revised.memory_unit_count == 1

    memories = await client.memory.list_memories(bank_id, limit=100)
    assert memories.total == 2
    by_document = {item.document_id: item for item in memories.items}
    assert set(by_document) == {first_id, second_id}
    assert by_document[first_id].id == before.id
    assert by_document[first_id].text == before.text
    for document_id, expected_text, expected_metadata in [
        (first_id, FIRST_FACT, first_metadata),
        (second_id, SECOND_FACT, second_metadata),
    ]:
        item = by_document[document_id]
        assert item.text == expected_text
        assert item.metadata == expected_metadata
        assert item.chunk_id == f"{bank_id}_{document_id}_0"
        # "valid" here is native curation state, not verified truth or currency.
        assert item.state == "valid"
        assert item.invalidated_at is None
        assert item.invalidation_reason is None

    response = await client.arecall(
        bank_id=bank_id,
        query="What deployment lane did each source version report?",
        types=["world"],
        max_tokens=4096,
    )
    assert len(response.results) == 2
    recalled = {result.document_id: result for result in response.results}
    assert set(recalled) == {first_id, second_id}
    for document_id in [first_id, second_id]:
        result = recalled[document_id]
        stored = by_document[document_id]
        assert result.id == stored.id
        assert result.text == stored.text
        assert result.metadata == stored.metadata
        assert result.chunk_id == stored.chunk_id
        assert result.type == "world"
        assert result.context == ""
        assert result.tags == []
        assert result.occurred_start is None
        assert result.occurred_end is None
    unknown = recalled[first_id]
    observed = recalled[second_id]
    assert unknown.mentioned_at is None
    assert observed.mentioned_at is not None
    assert _instant(observed.mentioned_at) == _instant(OBSERVED_AT)
    assert unknown.metadata is not None
    assert observed.metadata is not None
    assert unknown.metadata[f"{PREFIX}recorded_at"] == RECORDED_AT
    assert observed.metadata[f"{PREFIX}supersedes"] == first_id
    assert response.trace is None
    assert response.entities is None
    assert response.chunks is None
    assert response.source_facts is None
