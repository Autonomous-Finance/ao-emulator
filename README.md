<div align="center">

# ⚡️ AO Emulator

**Your local laboratory for AO process development.**
  
[![Status](https://img.shields.io/badge/Status-Archived-red.svg?style=flat-square&logo=archive)](https://github.com/Autonomous-Finance/ao-emulator)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-v20%2B-green.svg?style=flat-square&logo=node.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Supported-blue.svg?style=flat-square&logo=docker)](https://www.docker.com/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)

<p align="center">
  <a href="#features-">Features</a> •
  <a href="#getting-started-">Getting Started</a> •
  <a href="#configuration-">Configuration</a> •
  <a href="#api-">API</a> •
  <a href="#architecture-">Architecture</a>
</p>

---

> **⚠️ ARCHIVED & UNMAINTAINED**
>
> This project was initially developed by **Autonomous Research**. It is now archived and will not receive further updates, support, or maintenance. Use it as a reference or for educational purposes.

</div>

## What is this? 🤖

**AO Emulator** is a high-performance local environment designed to mirror the behavior of the AO network. It allows developers to synchronize process state, execute dry-runs, and debug interactions in real-time—without the latency of the live network.

Whether you are building complex agents, DeFi protocols, or simple message handlers, the AO Emulator provides the feedback loop you need to iterate faster.

## Features 🚀

| Feature | Description |
| :--- | :--- |
| **🔄 Real-time Sync** | Maintains a local, up-to-the-second copy of your process state from the AO network. |
| **⚡️ Instant Dry-Runs** | Test message interactions via HTTP endpoints with zero cost and immediate feedback. |
| **📦 Checkpoint Control** | Load state from specific transaction checkpoints or start fresh from genesis. |
| **🛡️ Flexible Memory** | Toggle between safe execution and unsafe memory modes for deep debugging. |
| **🐳 Docker Ready** | Comes with a production-ready `docker-compose` stack including Prometheus & Grafana. |

---

## Getting Started 🛠️

### Prerequisites

- **Node.js** (v20+)
- **Docker** (Optional, for full stack orchestration)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/ao-emulator.git

# Navigate to the directory
cd ao-emulator

# Install dependencies
npm install
```

### Quick Start

Fire up the emulator for a specific AO Process ID:

```bash
node --experimental-wasm-memory64 index.js --process-id=YOUR_PROCESS_ID_HERE
```

> **Note:** The `--experimental-wasm-memory64` flag is **required** for WASM support.

---

## Configuration ⚙️

Customize your emulator environment using CLI arguments or Environment Variables.

| Variable | CLI Argument | Default | Description |
| :--- | :--- | :--- | :--- |
| `PROCESS_ID_TO_MONITOR` | `--process-id` | *Required* | The AO Process ID you want to emulate. |
| `PORT` | `--port` | `8080` | The HTTP port for the API server. |
| `SU_URL` | `--su-url` | `ao-testnet` | The State Update Router URL to fetch data from. |
| `LOADER_UNSAFE_MEMORY` | `--unsafe-memory` | `false` | Enable unsafe memory mode (faster, less secure). |
| `FULL_STATE_REFRESH_INTERVAL_MS` | `--full-load-interval` | `60000` | How often to refresh the full state from the network. |

### 🐳 Docker Composition

We provide a robust `docker-compose.yml` template to run the emulator alongside a monitoring stack (Prometheus + Grafana).

1.  Open `docker-compose.yml`.
2.  Uncomment the example service and set your `PROCESS_ID_TO_MONITOR`.
3.  Launch the stack:

```bash
docker-compose up -d
```

---

## API Reference 📡

Interact with your local emulator using simple HTTP requests.

### ❤️ Health Check

**GET** `/health`

Returns the service status. Useful for readiness probes.

```json
"OK"
```

### 🧪 Dry Run

**POST** `/dry-run?process-id=YOUR_PROCESS_ID`

Simulate a message interaction without committing it to the network.

**Body:**
```json
{
  "Id": "1234",
  "Target": "YOUR_PROCESS_ID",
  "Data": "Your Message Data",
  "Tags": [
    { "name": "Action", "value": "Transfer" }
  ]
}
```

---

## Architecture 🏗️

The emulator acts as a bridge between your local environment and the AO Network.

1.  **SU Integration** (`src/su.js`): Connects to the State Update router to fetch the latest messages and checkpoints.
2.  **State Management** (`src/index.js`): Maintains an in-memory and SQLite-backed copy of the process state.
3.  **Checkpointing** (`src/checkpoint.js`): Handles loading and saving of process snapshots for efficient restarts.

---

## License 📄

This project is open-sourced under the [MIT License](LICENSE).

<div align="center">
  <br>
  <i>Initially developed with ❤️ by <b>Autonomous Research</b></i>
</div>
