# Self-Hosting Guide

Run the LLM Wiki as a Docker container with a single command.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (v20+)
- [Docker Compose](https://docs.docker.com/compose/install/) (v2+)
- An API key for at least one LLM provider

## Quick Start

1. **Clone the repository**

   ```sh
   git clone https://github.com/yologdev/yopedia.git
   cd yopedia
   ```

2. **Create a `.env` file** with your API key

   ```sh
   echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
   ```

3. **Start the app**

   ```sh
   docker compose up -d
   ```

4. **Open** [http://localhost:3000](http://localhost:3000)

That's it. Your wiki data persists in Docker volumes across restarts.

## Environment Variables

Configure your LLM provider by setting the relevant API key in `.env`:

| Variable | Provider | Example |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Claude | `sk-ant-api03-...` |
| `OPENAI_API_KEY` | OpenAI | `sk-proj-...` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini | `AIza...` |
| `DEEPSEEK_API_KEY` | DeepSeek | `sk-...` |
| `OLLAMA_BASE_URL` | Ollama (local) | `http://host.docker.internal:11434` |

You only need **one** provider. The app auto-detects which key is set.

### Additional Settings

| Variable | Description | Default |
|---|---|---|
| `LLM_MODEL` | Override the default model name | Provider default |
| `EMBEDDING_MODEL` | Override the embedding model name | Provider default |
| `PORT` | Server port inside the container | `3000` |

## Volume Mounts

The compose file defines two named volumes:

| Volume | Container Path | Purpose |
|---|---|---|
| `wiki-data` | `/app/wiki` | Generated wiki markdown pages |
| `raw-data` | `/app/raw` | Ingested source documents |

Your wiki data lives in these volumes and persists even if you remove the container.

### Using a local directory instead

To map wiki data to a directory on your host machine:

```yaml
# docker-compose.yml override
services:
  wiki:
    volumes:
      - ./my-wiki:/app/wiki
      - ./my-sources:/app/raw
```

## Using Ollama (Local LLMs)

If you run [Ollama](https://ollama.com) on your host machine, the container needs to reach it:

```sh
# .env
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

On Linux, you may need to add `--add-host=host.docker.internal:host-gateway` or use the host network:

```yaml
services:
  wiki:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

## Updating

Pull the latest code and rebuild:

```sh
git pull
docker compose up -d --build
```

Your wiki data in the volumes is preserved.

## Building from Source (without Docker)

If you prefer running directly on your machine:

1. **Install Node.js 22+** and **pnpm**

   ```sh
   corepack enable
   ```

2. **Install dependencies**

   ```sh
   pnpm install
   ```

3. **Create `.env.local`** with your API key

   ```sh
   echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
   ```

4. **Run in development mode**

   ```sh
   pnpm dev
   ```

   Or build and run in production mode:

   ```sh
   pnpm build
   pnpm start
   ```

## Troubleshooting

### Container exits immediately

Check the logs:

```sh
docker compose logs wiki
```

Most common cause: missing API key in `.env`.

### Port already in use

Change the host port mapping:

```yaml
ports:
  - "8080:3000"
```

### Permission errors on mounted directories

Ensure the host directories are writable, or use named volumes (the default).
