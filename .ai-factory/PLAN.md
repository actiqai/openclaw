# Travelpayouts MCP Plugin for OpenClaw

**Created:** 2026-03-08
**Mode:** Fast

## Settings

- **Testing:** Yes (Vitest)
- **Logging:** Verbose (DEBUG)
- **Docs:** No

## Overview

Create an OpenClaw extension plugin that registers native agent tools for Travelpayouts API (flights, hotels, transfers, trains). Replaces current curl-based approach from AGENTS.md with proper tool integration — the bot gets structured tools instead of needing shell access.

### Architecture

```
User asks about flights
    ↓
Agent selects search_flights tool
    ↓
Plugin: HTTP GET → actiq-gateway /travelpayouts/...
    ↓
Gateway: appends token → api.travelpayouts.com
    ↓
Plugin: parses response → formatted result
    ↓
Agent presents results to user
```

### Key Design Decisions

- **Plugin location:** `extensions/travelpayouts/` in openclaw monorepo
- **Plugin SDK:** Uses `openclaw/plugin-sdk` (registerTool pattern)
- **API access:** Via actiq-gateway proxy (no direct API key in plugin)
- **Config:** `gatewayBaseUrl` from pluginConfig (default: `http://10.0.1.40:8080`)
- **Schema:** TypeBox (`@sinclair/typebox`) for tool parameters (matches existing tools)

## Tasks

### Phase 1: Foundation

- [x] **Task 1:** Create extension scaffold (`package.json`, `openclaw.plugin.json`, `index.ts`)
- [x] **Task 5:** Create shared utilities (api-client, types, format helpers)

### Phase 2: Tool Implementation

- [x] **Task 2:** Implement `search_flights` tool (prices_for_dates API)
- [x] **Task 3:** Implement `search_hotels` tool (Hotellook API)
- [x] **Task 4:** Implement `search_transfers` and `search_trains` tools

### Phase 3: Integration & Testing

- [x] **Task 6:** Wire plugin registration, update config, remove curl instructions from AGENTS.md
- [x] **Task 7:** Write Vitest tests (flights, hotels, api-client, format)

## File Structure

```
extensions/travelpayouts/
├── index.ts                    # Plugin definition + register()
├── package.json                # @openclaw/travelpayouts
├── openclaw.plugin.json        # Plugin metadata
└── src/
    ├── api-client.ts           # HTTP client for gateway proxy
    ├── types.ts                # API response types
    ├── format.ts               # Response formatting helpers
    └── tools/
        ├── flights.ts          # search_flights tool
        ├── flights.test.ts     # Tests
        ├── hotels.ts           # search_hotels tool
        ├── hotels.test.ts      # Tests
        ├── transfers.ts        # search_transfers tool
        ├── trains.ts           # search_trains tool
        └── ...

```

## Tools Summary

| Tool               | API Endpoint                                   | Parameters                                                       |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------- |
| `search_flights`   | `/travelpayouts/aviasales/v3/prices_for_dates` | origin, destination, departure_at, return_at?, currency?, limit? |
| `search_hotels`    | `/travelpayouts/hotellook/v2/cache.json`       | location, checkIn, checkOut, adults?, currency?, limit?          |
| `search_transfers` | `/travelpayouts/transfers/v1/search`           | origin, destination, date, passengers?, currency?                |
| `search_trains`    | `/travelpayouts/trains/v1/search`              | origin, destination, date, currency?                             |

## Commit Plan

1. **After Phase 1** (Tasks 1, 5): `feat(travelpayouts): add extension scaffold and shared utilities`
2. **After Phase 2** (Tasks 2, 3, 4): `feat(travelpayouts): implement flight, hotel, transfer, and train search tools`
3. **After Phase 3** (Tasks 6, 7): `feat(travelpayouts): wire plugin registration and add tests`

## Dependencies

- `openclaw` workspace (plugin SDK, TypeBox)
- `actiq-gateway` must have Travelpayouts proxy routes (already implemented)
- No new npm packages needed
