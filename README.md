# X402 Demo

Pay-per-request API monetization using [HTTP 402](https://x402.org) and the Evolve SDK.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh)
- A running Evolve node (`evd`) with external consensus on `:50051`

### Install & Run

```bash
just install

# Terminal 1: API server
just dev-server

# Terminal 2: Frontend dashboard
just dev-frontend

# Terminal 3: Simulator (needs FAUCET_PRIVATE_KEY)
FAUCET_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  just sim -- --agents 5 --rps 2 --duration 60
```

Dashboard at http://localhost:5173 | Server at http://localhost:3000

### Verify

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/pricing
curl http://localhost:3000/api/treasury
```

## Documentation

- [Architecture & Design](DESIGN.md)
- [X402 Client Integration](docs/x402-client-integration.md)
- [Demo Requirements](docs/x402-demo-requirements.md)
