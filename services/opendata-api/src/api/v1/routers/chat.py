from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from openai import AsyncOpenAI

from api.v1.application.chat.service import (
    ChatRequest,
    ChatService,
    DailyQuota,
    resolve_client_ip,
    sse,
)
from core.settings import get_settings
from db import MongoDB

chat_router = APIRouter(prefix="/chat", tags=["chat"])


def iso_utc(value) -> str:
    return value.isoformat().replace("+00:00", "Z")


@chat_router.post("")
async def create_chat(request: Request, body: ChatRequest):
    settings = get_settings()
    if not all(
        [
            settings.OPENAI_API_KEY,
            settings.ODP_SERVICE_KEY,
            settings.RATE_LIMIT_SECRET,
        ]
    ):
        return JSONResponse(
            status_code=503,
            content={
                "code": "chat_unavailable",
                "message": "챗봇 준비 중입니다.",
            },
        )

    client_ip = resolve_client_ip(
        request,
        settings.CLIENT_IP_HEADER,
        settings.TRUSTED_PROXY_CIDRS,
    )
    quota = DailyQuota(
        MongoDB.get_db()["chat_daily_usage"], settings.RATE_LIMIT_SECRET
    )
    admission = await quota.consume(client_ip)
    if not admission.allowed:
        return JSONResponse(
            status_code=429,
            content={
                "code": "daily_limit",
                "message": "오늘 사용할 수 있는 3회를 모두 사용했습니다.",
                "remaining": 0,
                "resetAt": iso_utc(admission.reset_at),
            },
        )

    openai_client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    service = ChatService(
        openai_client,
        model=settings.OPENAI_MODEL,
        mcp_url=settings.MCP_SERVER_URL,
        odp_service_key=settings.ODP_SERVICE_KEY,
    )

    async def events():
        try:
            yield sse(
                "meta",
                {
                    "remaining": admission.remaining,
                    "resetAt": iso_utc(admission.reset_at),
                },
            )
            async for chunk in service.stream(body.messages):
                yield chunk
        finally:
            await openai_client.close()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
