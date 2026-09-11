import hashlib
import hmac
import ipaddress
import json
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, field_validator, model_validator
from pymongo import ReturnDocument
from starlette.requests import Request

KST = ZoneInfo("Asia/Seoul")
UTC = timezone.utc  # noqa: UP017 - project supports Python 3.10
ALLOWED_CLIENT_IP_HEADERS = {"CF-Connecting-IP", "X-Forwarded-For"}
MCP_TOOLS = ["search_api", "get_std_docs", "fetch_data"]
SYSTEM_INSTRUCTIONS = """당신은 공공데이터 조회 도우미입니다. 사용자가 다른
언어를 요청하지 않으면 한국어로 답하세요. 공공데이터의 존재나 현재 값은 반드시
도구로 확인하세요. search_api로 API를 찾고 get_std_docs로 명세를 확인한 뒤,
실제 값을 요청하면 fetch_data를 사용하세요. 값, 단위, 기관, 갱신 시점, URL을
추측하지 마세요. 결과가 없거나 제한되면 명확히 알리세요. 가능한 경우 데이터셋
제목, 제공 기관, 상세 URL을 포함하고 표 형태 데이터는 Markdown 표로 간결하게
정리하세요."""
UPSTREAM_ERROR = "답변을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=1_000)

    @field_validator("content", mode="before")
    @classmethod
    def strip_content(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=5)

    @model_validator(mode="after")
    def validate_message_order(self):
        if self.messages[0].role != "user" or self.messages[-1].role != "user":
            raise ValueError("messages must start and end with a user message")
        for previous, current in zip(self.messages, self.messages[1:]):
            if previous.role == current.role:
                raise ValueError("message roles must alternate")
        return self


def sse(event: str, data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"


class ChatService:
    def __init__(
        self,
        client,
        *,
        model: str,
        mcp_url: str,
        odp_service_key: str,
    ):
        self.client = client
        self.model = model
        self.mcp_url = mcp_url
        self.odp_service_key = odp_service_key

    async def stream(self, messages: list[ChatMessage]):
        try:
            stream = await self.client.responses.create(
                model=self.model,
                input=[message.model_dump() for message in messages],
                instructions=SYSTEM_INSTRUCTIONS,
                tools=[
                    {
                        "type": "mcp",
                        "server_label": "opendata",
                        "server_description": "대한민국 공공데이터 API 검색 및 조회",
                        "server_url": self.mcp_url,
                        "allowed_tools": MCP_TOOLS,
                        "require_approval": "never",
                        "headers": {"x-odp-service-key": self.odp_service_key},
                    }
                ],
                max_tool_calls=6,
                max_output_tokens=1_500,
                store=False,
                stream=True,
            )
            async for event in stream:
                if event.type == "response.output_item.added":
                    item = event.item
                    if item.type == "mcp_call":
                        statuses = {
                            "search_api": (
                                "searching",
                                "공공데이터 API를 찾고 있어요.",
                            ),
                            "get_std_docs": (
                                "reading_document",
                                "API 명세를 확인하고 있어요.",
                            ),
                            "fetch_data": (
                                "fetching_data",
                                "공공데이터를 조회하고 있어요.",
                            ),
                        }
                        phase, message = statuses.get(
                            item.name,
                            (
                                "fetching_data",
                                "공공데이터를 확인하고 있어요.",
                            ),
                        )
                        yield sse(
                            "status",
                            {"phase": phase, "message": message},
                        )
                elif event.type == "response.output_text.delta":
                    yield sse("delta", {"text": event.delta})
                elif event.type == "response.completed":
                    yield sse("done", {})
                elif event.type in {
                    "error",
                    "response.failed",
                    "response.incomplete",
                    "response.mcp_call.failed",
                }:
                    yield sse("error", {"message": UPSTREAM_ERROR})
                    return
        except Exception:  # noqa: BLE001 - keep upstream details out of SSE
            yield sse("error", {"message": UPSTREAM_ERROR})


def resolve_client_ip(
    request: Request,
    client_ip_header: str | None,
    trusted_proxy_cidrs: str,
) -> str:
    peer = request.client.host if request.client else "unknown"
    try:
        peer_ip = ipaddress.ip_address(peer)
    except ValueError:
        return peer

    trusted_networks = []
    for value in trusted_proxy_cidrs.split(","):
        try:
            trusted_networks.append(
                ipaddress.ip_network(value.strip(), strict=False)
            )
        except ValueError:
            continue

    if client_ip_header not in ALLOWED_CLIENT_IP_HEADERS or not any(
        peer_ip in network for network in trusted_networks
    ):
        return str(peer_ip)

    forwarded = request.headers.get(client_ip_header)
    if not forwarded:
        return str(peer_ip)
    candidate = forwarded.split(",", 1)[0].strip()
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return str(peer_ip)


@dataclass(frozen=True)
class QuotaResult:
    allowed: bool
    remaining: int
    reset_at: datetime


class DailyQuota:
    limit = 3

    def __init__(self, collection, secret: str):
        if not secret:
            raise ValueError("RATE_LIMIT_SECRET is required")
        self.collection = collection
        self.secret = secret.encode()

    async def consume(
        self, client_ip: str, *, now: datetime | None = None
    ) -> QuotaResult:
        current = (now or datetime.now(KST)).astimezone(KST)
        reset_at = datetime.combine(
            current.date() + timedelta(days=1), time.min, tzinfo=KST
        )
        digest = hmac.new(
            self.secret, client_ip.encode(), hashlib.sha256
        ).hexdigest()
        document = await self.collection.find_one_and_update(
            {"_id": f"{current.date().isoformat()}:{digest}"},
            {
                "$inc": {"count": 1},
                "$setOnInsert": {
                    "expiresAt": reset_at.astimezone(UTC) + timedelta(days=2)
                },
            },
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        count = int(document["count"])
        return QuotaResult(
            allowed=count <= self.limit,
            remaining=max(0, self.limit - count),
            reset_at=reset_at.astimezone(UTC),
        )
