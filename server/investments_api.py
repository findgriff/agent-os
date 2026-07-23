"""AGENT OS — Investments data API.
Fetches live stock prices, news, and dividend data via yfinance.
All data cached to avoid hitting Yahoo rate limits.
"""
from __future__ import annotations
import json
import os
import time
from dataclasses import dataclass, asdict
from typing import Any

# Cache: {cache_key: (timestamp, data)}
_cache: dict[str, tuple[float, Any]] = {}
CACHE_TTL = 300  # 5 min for prices, 30 min for news

# ── The three watchlists ─────────────────────────────────────────────
HIGH_DIVIDEND_TICKERS = ["ARR", "DX", "NLY", "AGNC", "HTGC", "STWD", "TWO", "BXMT", "ARCC", "PBR"]
FLOOR_PRICE_TICKERS = ["INFY", "SMCI", "SE", "NKE", "BABA", "PDD", "KWEB", "PSEC"]
EMERGING_TICKERS = ["TCEHY", "BABA", "HDB", "PBR", "IBN", "ITUB", "INFY", "JD", "BBD"]


def _get_cache(key: str, ttl: int = CACHE_TTL) -> Any | None:
    ts, data = _cache.get(key, (0, None))
    return data if time.time() - ts < ttl else None


def _set_cache(key: str, data: Any) -> None:
    _cache[key] = (time.time(), data)


def fetch_prices(tickers: list[str]) -> list[dict]:
    """Fetch live prices for a list of tickers via yfinance.
    Returns list of {ticker, name, price, ...}.
    """
    cache_key = "prices:" + ",".join(sorted(tickers))
    cached = _get_cache(cache_key)
    if cached:
        return cached

    try:
        import yfinance as yf
    except ImportError:
        return [{"ticker": t, "error": "yfinance not installed"} for t in tickers]

    results = []
    for t in tickers:
        try:
            tk = yf.Ticker(t)
            info = tk.info or {}
            price = info.get("currentPrice") or info.get("regularMarketPrice") or 0
            prev_close = info.get("previousClose") or 0
            change_pct = round((price - prev_close) / prev_close * 100, 2) if prev_close else 0

            div_rate = info.get("dividendRate") or info.get("trailingAnnualDividendRate") or 0
            div_yield = round(div_rate / price * 100, 2) if price and div_rate else 0

            fifty_two_high = info.get("fiftyTwoWeekHigh") or 0
            fifty_two_low = info.get("fiftyTwoWeekLow") or 0
            pct_from_high = round((price - fifty_two_high) / fifty_two_high * 100, 1) if fifty_two_high and price else 0

            results.append({
                "ticker": t,
                "name": info.get("shortName") or info.get("longName") or t,
                "price": round(price, 2),
                "change_pct": change_pct,
                "dividend_yield_pct": div_yield,
                "52w_high": round(fifty_two_high, 2) if fifty_two_high else 0,
                "52w_low": round(fifty_two_low, 2) if fifty_two_low else 0,
                "pct_from_52w_high": pct_from_high,
                "market_cap": info.get("marketCap") or 0,
                "sector": info.get("sector") or "N/A",
                "country": info.get("country") or "US",
                "pe_ratio": round(info.get("trailingPE") or 0, 1) or 0,
            })
        except Exception as e:
            results.append({"ticker": t, "error": str(e)[:100]})

    _set_cache(cache_key, results)
    return results


def fetch_news(tickers: list[str]) -> list[dict]:
    """Fetch recent news for tickers."""
    cache_key = "news:" + ",".join(sorted(tickers))
    cached = _get_cache(cache_key, ttl=1800)
    if cached:
        return cached

    try:
        import yfinance as yf
    except ImportError:
        return []

    seen = set()
    news = []
    for t in tickers[:5]:  # Limit to 5 tickers to avoid rate limits
        try:
            tk = yf.Ticker(t)
            items = (tk.news or [])[:5]
            for item in items:
                nid = item.get("id") or item.get("link", "")
                if nid in seen:
                    continue
                seen.add(nid)
                news.append({
                    "ticker": t,
                    "title": item.get("title", ""),
                    "link": item.get("link", ""),
                    "publisher": item.get("publisher", ""),
                    "timestamp": item.get("providerPublishTime", 0),
                })
        except Exception:
            pass

    news.sort(key=lambda x: x["timestamp"], reverse=True)
    _set_cache(cache_key, news[:30])
    return news[:30]


def get_lists() -> dict:
    """Return the three pre-defined watchlists with notes."""
    return {
        "high_dividend": {
            "name": "High Dividend Yield",
            "description": "REITs, BDCs, and high-yield equities paying 9-17%",
            "tickers": HIGH_DIVIDEND_TICKERS,
        },
        "floor_price": {
            "name": "Near 52-Week Low",
            "description": "Beaten-down stocks 35-60% off their highs",
            "tickers": FLOOR_PRICE_TICKERS,
        },
        "emerging_markets": {
            "name": "Emerging Markets",
            "description": "China, India, Brazil exposure via ADRs",
            "tickers": EMERGING_TICKERS,
        },
    }
