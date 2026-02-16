default:
    @just --list

# Install all dependencies
install:
    cd frontend && bun install
    cd server && bun install
    cd simulator && bun install

# Run everything (server + frontend)
dev: dev-server dev-frontend

# Run server in dev mode (watch)
dev-server:
    cd server && bun run dev

# Run frontend in dev mode
dev-frontend:
    cd frontend && bun run dev

# Run simulator
sim:
    cd simulator && bun run start

# Run simulator in dev mode (watch)
sim-dev:
    cd simulator && bun run dev

# Typecheck all packages
typecheck:
    cd server && bun run typecheck
    cd frontend && bun run typecheck
    cd simulator && bun run typecheck

# Run server tests
test:
    cd server && bun test

# Build frontend
build:
    cd frontend && bun run build

# Run with docker compose
docker-up:
    docker compose up --build

# Stop docker compose
docker-down:
    docker compose down

# Clean node_modules and dist
clean:
    rm -rf frontend/node_modules frontend/dist
    rm -rf server/node_modules
    rm -rf simulator/node_modules
