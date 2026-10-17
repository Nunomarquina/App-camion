"""OpenAI TTS (Emergent universal key) for Spanish navigation prompts, cached in Mongo."""
import asyncio
import hashlib
import logging
import os
import re

from emergentintegrations.llm.openai import OpenAITextToSpeech

logger = logging.getLogger(__name__)

PRIMARY = {"model": "tts-1-hd", "voice": "nova", "speed": 1.0}
FALLBACK = {"model": "tts-1", "voice": "nova", "speed": 1.0}
FORMAT = "mp3"
TIMEOUT_S = 20


def clean(text: str) -> str:
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"[*_#>~|`]", "", text)
    return re.sub(r"\s+", " ", text).strip()[:500]


def cache_key(text: str, cfg: dict) -> str:
    raw = f"{text}|{cfg['voice']}|{cfg['speed']}|{cfg['model']}|{FORMAT}|"
    return hashlib.sha256(raw.encode()).hexdigest()


async def get_or_create(db, text: str) -> str:
    """Return cache key of the mp3 for text; generates on cache miss."""
    text = clean(text)
    if not text:
        raise ValueError("Texto vacío")
    key = cache_key(text, PRIMARY)
    if await db.tts_cache.find_one({"key": key}, {"_id": 1}):
        return key
    tts = OpenAITextToSpeech(api_key=os.environ["EMERGENT_LLM_KEY"])
    audio = None
    for cfg in (PRIMARY, FALLBACK):
        try:
            audio = await asyncio.wait_for(
                tts.generate_speech(text=text, model=cfg["model"], voice=cfg["voice"],
                                    speed=cfg["speed"], response_format=FORMAT),
                timeout=TIMEOUT_S,
            )
            break
        except Exception as e:  # provider error -> try fallback once
            logger.warning("TTS %s failed: %s", cfg["model"], e)
    if not audio:
        raise RuntimeError("No se pudo generar la voz")
    await db.tts_cache.update_one(
        {"key": key}, {"$set": {"key": key, "text": text, "audio": audio}}, upsert=True)
    return key


async def load(db, key: str):
    doc = await db.tts_cache.find_one({"key": key}, {"_id": 0, "audio": 1})
    return doc["audio"] if doc else None
