import json
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

from pydantic import ValidationError
from starlette.requests import Request

from api.v1.application.chat.service import (
    ChatRequest,
    ChatService,
    DailyQuota,
    resolve_client_ip,
)
from api.v1.routers.chat import create_chat

KST = ZoneInfo("Asia/Seoul")
UTC = timezone.utc  # noqa: UP017 - project supports Python 3.10


def request_from(peer: str, headers: dict[str, str] | None = None) -> Request:
    encoded_headers = [
        (name.lower().encode(), value.encode())
        for name, value in (headers or {}).items()
    ]
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "https",
            "path": "/api/v1/chat",
            "raw_path": b"/api/v1/chat",
            "query_string": b"",
            "headers": encoded_headers,
            "client": (peer, 12345),
            "server": ("testserver", 443),
        }
    )


class FakeCollection:
    def __init__(self):
        self.documents: dict[str, dict] = {}

    async def find_one_and_update(
        self,
        query: dict,
        update: dict,
        *,
        upsert: bool,
        return_document,
    ) -> dict:
        del upsert, return_document
        key = query["_id"]
        document = self.documents.setdefault(
            key,
            {"_id": key, **deepcopy(update["$setOnInsert"])},
        )
        document["count"] = document.get("count", 0) + update["$inc"]["count"]
        return deepcopy(document)


class FakeStream:
    def __init__(self, events: list[SimpleNamespace]):
        self.events = events

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for event in self.events:
            yield event


class FakeResponses:
    def __init__(self, events: list[SimpleNamespace]):
        self.events = events
        self.kwargs: dict | None = None

    async def create(self, **kwargs):
        self.kwargs = kwargs
        return FakeStream(self.events)


class FakeOpenAI:
    def __init__(self, events: list[SimpleNamespace]):
        self.responses = FakeResponses(events)


class ChatRequestTests(unittest.TestCase):
    def test_accepts_completed_pairs_plus_current_user_message(self):
        request = ChatRequest(
            messages=[
                {"role": "user", "content": "서울 날씨를 찾아줘"},
                {"role": "assistant", "content": "어느 날짜인가요?"},
                {"role": "user", "content": "오늘"},
            ]
        )

        self.assertEqual(len(request.messages), 3)
        self.assertEqual(request.messages[-1].content, "오늘")

    def test_rejects_invalid_message_sequences_and_content(self):
        invalid_messages = [
            [],
            [{"role": "assistant", "content": "먼저 답변"}],
            [
                {"role": "user", "content": "첫 질문"},
                {"role": "user", "content": "연속 질문"},
            ],
            [
                {"role": "user", "content": "질문"},
                {"role": "assistant", "content": "답변"},
            ],
            [{"role": "user", "content": " "}],
            [{"role": "user", "content": "x" * 1_001}],
            [
                {"role": "user", "content": "1"},
                {"role": "assistant", "content": "2"},
                {"role": "user", "content": "3"},
                {"role": "assistant", "content": "4"},
                {"role": "user", "content": "5"},
                {"role": "assistant", "content": "6"},
                {"role": "user", "content": "7"},
            ],
        ]

        for messages in invalid_messages:
            with (
                self.subTest(messages=messages),
                self.assertRaises(ValidationError),
            ):
                ChatRequest(messages=messages)


class ClientIpTests(unittest.TestCase):
    def test_ignores_forwarded_headers_from_untrusted_peers(self):
        request = request_from(
            "198.51.100.4", {"CF-Connecting-IP": "203.0.113.8"}
        )

        self.assertEqual(
            resolve_client_ip(request, "CF-Connecting-IP", "10.0.0.0/8"),
            "198.51.100.4",
        )

    def test_reads_cloudflare_header_from_trusted_peer(self):
        request = request_from(
            "172.18.0.2", {"CF-Connecting-IP": "203.0.113.8"}
        )

        self.assertEqual(
            resolve_client_ip(request, "CF-Connecting-IP", "172.18.0.0/16"),
            "203.0.113.8",
        )

    def test_reads_first_nginx_address_and_rejects_malformed_values(self):
        trusted = request_from(
            "10.0.0.2", {"X-Forwarded-For": "203.0.113.9, 10.0.0.2"}
        )
        malformed = request_from(
            "10.0.0.2", {"X-Forwarded-For": "not-an-ip, 10.0.0.2"}
        )

        self.assertEqual(
            resolve_client_ip(trusted, "X-Forwarded-For", "10.0.0.0/8"),
            "203.0.113.9",
        )
        self.assertEqual(
            resolve_client_ip(malformed, "X-Forwarded-For", "10.0.0.0/8"),
            "10.0.0.2",
        )


class DailyQuotaTests(unittest.IsolatedAsyncioTestCase):
    async def test_enforces_three_requests_per_ip_and_kst_date(self):
        collection = FakeCollection()
        quota = DailyQuota(collection, "test-rate-limit-secret")
        first_day = datetime(2026, 9, 11, 23, 59, tzinfo=KST)

        results = [
            await quota.consume("203.0.113.8", now=first_day) for _ in range(4)
        ]

        self.assertEqual(
            [(result.allowed, result.remaining) for result in results],
            [(True, 2), (True, 1), (True, 0), (False, 0)],
        )
        next_day = await quota.consume(
            "203.0.113.8",
            now=datetime(2026, 9, 12, 0, 0, tzinfo=KST),
        )
        self.assertTrue(next_day.allowed)
        self.assertEqual(next_day.remaining, 2)
        self.assertTrue(
            all("203.0.113.8" not in key for key in collection.documents)
        )


class ChatServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_streams_safe_events_and_restricts_remote_mcp(self):
        client = FakeOpenAI(
            [
                SimpleNamespace(
                    type="response.output_item.added",
                    item=SimpleNamespace(type="mcp_call", name="search_api"),
                ),
                SimpleNamespace(
                    type="response.output_text.delta", delta="서울"
                ),
                SimpleNamespace(type="response.completed"),
            ]
        )
        service = ChatService(
            client,
            model="gpt-5-mini",
            mcp_url="https://mcp.example/mcp",
            odp_service_key="test-odp-key",
        )

        chunks = [
            chunk
            async for chunk in service.stream(
                ChatRequest(
                    messages=[{"role": "user", "content": "서울 날씨"}]
                ).messages
            )
        ]

        self.assertEqual(
            chunks,
            [
                'event: status\ndata: {"phase":"searching","message":"공공데이터 API를 찾고 있어요."}\n\n',
                'event: delta\ndata: {"text":"서울"}\n\n',
                "event: done\ndata: {}\n\n",
            ],
        )
        kwargs = client.responses.kwargs
        self.assertEqual(kwargs["model"], "gpt-5-mini")
        self.assertFalse(kwargs["store"])
        self.assertTrue(kwargs["stream"])
        self.assertEqual(kwargs["max_tool_calls"], 6)
        self.assertEqual(kwargs["max_output_tokens"], 1_500)
        self.assertEqual(
            kwargs["tools"][0]["allowed_tools"],
            ["search_api", "get_std_docs", "fetch_data"],
        )
        self.assertEqual(kwargs["tools"][0]["require_approval"], "never")
        self.assertEqual(
            kwargs["tools"][0]["headers"],
            {"x-odp-service-key": "test-odp-key"},
        )
        self.assertNotIn("test-odp-key", "".join(chunks))

    async def test_turns_upstream_failure_into_safe_sse_error(self):
        service = ChatService(
            FakeOpenAI([SimpleNamespace(type="response.failed")]),
            model="gpt-5-mini",
            mcp_url="https://mcp.example/mcp",
            odp_service_key="test-odp-key",
        )

        chunks = [
            chunk
            async for chunk in service.stream(
                ChatRequest(
                    messages=[{"role": "user", "content": "질문"}]
                ).messages
            )
        ]

        self.assertEqual(
            chunks,
            [
                'event: error\ndata: {"message":"답변을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."}\n\n'
            ],
        )


class ChatRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_config_returns_503_before_quota(self):
        settings = SimpleNamespace(
            OPENAI_API_KEY=None,
            ODP_SERVICE_KEY="odp",
            RATE_LIMIT_SECRET="rate",
        )

        with (
            patch("api.v1.routers.chat.get_settings", return_value=settings),
            patch("api.v1.routers.chat.MongoDB.get_db") as get_db,
        ):
            response = await create_chat(
                request_from("203.0.113.8"),
                ChatRequest(messages=[{"role": "user", "content": "질문"}]),
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            json.loads(response.body),
            {"code": "chat_unavailable", "message": "챗봇 준비 중입니다."},
        )
        get_db.assert_not_called()

    async def test_daily_limit_returns_429_contract(self):
        reset_at = datetime(2026, 9, 11, 15, tzinfo=UTC)
        settings = SimpleNamespace(
            OPENAI_API_KEY="openai",
            ODP_SERVICE_KEY="odp",
            RATE_LIMIT_SECRET="rate",
            CLIENT_IP_HEADER=None,
            TRUSTED_PROXY_CIDRS="",
        )
        rejected = SimpleNamespace(
            allowed=False, remaining=0, reset_at=reset_at
        )

        with (
            patch("api.v1.routers.chat.get_settings", return_value=settings),
            patch("api.v1.routers.chat.MongoDB.get_db"),
            patch(
                "api.v1.routers.chat.DailyQuota.consume",
                return_value=rejected,
            ),
        ):
            response = await create_chat(
                request_from("203.0.113.8"),
                ChatRequest(messages=[{"role": "user", "content": "질문"}]),
            )

        self.assertEqual(response.status_code, 429)
        self.assertEqual(
            json.loads(response.body),
            {
                "code": "daily_limit",
                "message": "오늘 사용할 수 있는 3회를 모두 사용했습니다.",
                "remaining": 0,
                "resetAt": "2026-09-11T15:00:00Z",
            },
        )


if __name__ == "__main__":
    unittest.main()
