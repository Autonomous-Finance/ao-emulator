# AO Emulator 🚀

[![Status](https://img.shields.io/badge/status-archived-red.svg)](https://github.com/Autonomous-Finance/ao-emulator)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **⚠️ ARCHIVED & UNMAINTAINED**
>
> This project was initially developed by **Autonomous Research**. It is now archived and will not receive further updates, support, or maintenance. Use it as a reference or for educational purposes.

## What is this? 🤖

AO Emulator is a local environment for running and testing AO processes. It allows you to synchronize state, process messages, and dry-run interactions with your AO processes without needing to deploy to the live network constantly. Think of it as your local laboratory for AO development.

It provides a high-performance Node.js service that:
*   🔄 **Syncs Real-time**: Keeps a local copy of your process state updated.
*   ⚡ **Dry-Runs**: Test message interactions instantly via HTTP endpoints.
*   📦 **Checkpoint Management**: Load state from specific checkpoints or start from scratch.
*   🛡️ **Safe & Unsafe Modes**: Experiment with memory settings and metering.

## Getting Started 🛠️

### Prerequisites
*   **Node.js** (v20+)
*   **Docker** (Optional, for containerized orchestration)

### Installation

```bash
git clone https://github.com/your-org/ao-emulator.git
cd ao-emulator
npm install
```

### Quick Start

Run the emulator for a specific process ID:

```bash
node --experimental-wasm-memory64 index.js --process-id=YOUR_PROCESS_ID_HERE
```

*Note: The `--experimental-wasm-memory64` flag is required.*

## Configuration ⚙️

You can configure the emulator using environment variables or CLI arguments.

| Variable | CLI Argument | Description |
|----------|--------------|-------------|
| `PROCESS_ID_TO_MONITOR` | `--process-id` | The AO Process ID to monitor (Required) |
| `PORT` | `--port` | HTTP port (Default: 8080) |
| `SU_URL` | `--su-url` | State Update Router URL |
| `LOADER_UNSAFE_MEMORY` | `--unsafe-memory` | Enable unsafe memory mode |
| `FULL_STATE_REFRESH_INTERVAL_MS` | `--full-load-interval` | Interval for full state refresh |

### Docker Composition 🐳

We provide a `docker-compose.yml` template to run the emulator along with a monitoring stack (Prometheus + Grafana).

1.  Edit `docker-compose.yml` to uncomment the example service and set your `PROCESS_ID_TO_MONITOR`.
2.  Run the stack:

```bash
docker-compose up -d
```

## API Usage 📡

### Health Check
`GET /health`
Returns the service status (e.g., `OK`, `INITIALIZING`).

### Dry Run
`POST /dry-run?process-id=YOUR_PROCESS_ID`
Simulate a message interaction.

## Architecture 🏗️

The emulator connects to the AO network's SU (State Update) router to fetch messages and checkpoints. It uses a local SQLite database and in-memory caching to provide fast access to the process state.

*   `src/index.js`: Core logic.
*   `src/su.js`: SU Router integration.
*   `src/checkpoint.js`: Checkpoint handling.

## License 📄

This project is licensed under the [MIT License](LICENSE).

---
*Developed with ❤️ by Autonomous Research.*
