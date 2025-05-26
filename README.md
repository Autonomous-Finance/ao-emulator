# AOS Local State

A Node.js service that maintains a local state of an AO process, providing HTTP endpoints for state queries and message dry-runs.

## Overview

This service connects to the AO testnet and maintains a local copy of a specified process's state. It provides:
- Real-time state synchronization
- Message processing and validation
- Checkpoint loading and management
- HTTP endpoints for state queries and dry-runs

## Prerequisites

- Node.js 20 or higher
- Docker (optional, for containerized deployment)

## Configuration

The service can be configured through environment variables or command-line arguments:

### Required Configuration
- `PROCESS_ID_TO_MONITOR`: The AO process ID to monitor (mandatory)

### Optional Configuration
- `PORT`: HTTP server port (default: 8080)
- `AOS_MODULE_ID`: Specific module ID to use (default: derived from process or 'LATEST')
- `SU_URL`: State Update router URL (default: 'https://su-router.ao-testnet.xyz')
- `FULL_STATE_REFRESH_INTERVAL_MS`: Interval for full state refresh (default: 60000ms)
- `MESSAGE_POLL_INTERVAL_MS`: Interval for polling new messages (default: 5000ms)

### Loader Options
- `LOADER_UNSAFE_MEMORY`: Enable unsafe memory mode (default: false)
- `LOADER_DISABLE_METERING`: Disable metering (default: false)
- `LOAD_FROM_CHECKPOINT`: Load state from checkpoint (default: false)
- `CHECKPOINT_TX_ID`: Specific checkpoint transaction ID to load
- `LOAD_FROM_SCRATCH`: Start from scratch without loading state (default: false)
- `FORWARD_TO_NONCE_LIMIT`: Process messages up to a specific nonce, it will try to fetch the closest checkpoint to the nonce and process messages up to that nonce.

### Caveats
When ran with unsafe memory, the service purely relies on the WASM module to prevent state changes. This works by hard-coding every sender to DRY-RUN. If a handler still modifies state without checking the sender, the state on the local cu will diverge from the actual state.
You can somewhat mitigate this by the FULL_STATE_REFRESH_INTERVAL_MS which will reload the authoritive state from the network.

## Usage Examples

### Basic Usage
```bash
# Basic startup with required process ID
node --experimental-wasm-memory64 index.js --process-id=rxxU4g-7tUHGvF28W2l53hxarpbaFR4NaSnOaxx6MIE
```

### Advanced Configuration
```bash
# Custom port, intervals, and memory settings
node --experimental-wasm-memory64 index.js \
  --process-id=rxxU4g-7tUHGvF28W2l53hxarpbaFR4NaSnOaxx6MIE \
  --port=9000 \
  --unsafe-memory \
  --message-poll-interval=30000 \
  --full-load-interval=300000 \
  --load-from-scratch
```

### Checkpoint Loading
```bash
# Load from specific checkpoint
node --experimental-wasm-memory64 index.js \
  --process-id=rxxU4g-7tUHGvF28W2l53hxarpbaFR4NaSnOaxx6MIE \
  --checkpoint-tx=your_checkpoint_tx_id \
  --unsafe-memory
```

### Nonce-Limited Processing
```bash
# Process messages up to a specific nonce
node --experimental-wasm-memory64 index.js \
  --process-id=rxxU4g-7tUHGvF28W2l53hxarpbaFR4NaSnOaxx6MIE \
  --forward-to-nonce=1000 \
  --unsafe-memory
```

### Custom SU Router
```bash
# Use custom SU router URL
node --experimental-wasm-memory64 index.js \
  --process-id=rxxU4g-7tUHGvF28W2l53hxarpbaFR4NaSnOaxx6MIE \
  --su-url=https://custom-su-router.xyz \
  --unsafe-memory
```

## Docker Deployment

```bash
# Build the image
docker build -t aos-local-state .

# Basic container run
docker run -p 8080:8080 \
  -e PROCESS_ID_TO_MONITOR=your_process_id \
  aos-local-state

# Advanced container run with custom configuration
docker run -p 9000:8080 \
  -e PROCESS_ID_TO_MONITOR=your_process_id \
  -e PORT=8080 \
  -e LOADER_UNSAFE_MEMORY=true \
  -e MESSAGE_POLL_INTERVAL_MS=30000 \
  -e FULL_STATE_REFRESH_INTERVAL_MS=300000 \
  -e LOAD_FROM_CHECKPOINT=true \
  -e LOAD_FROM_SCRATCH=true \
  aos-local-state
```

## API Endpoints

### Health Check
```http
GET /health
```
Returns the current status of the service:
- `INITIALIZING`: Service is starting up
- `BUSY_LOADING_STATE`: Performing a full state load
- `BUSY_POLLING_MESSAGES`: Actively polling for messages
- `OK`: Service is running normally

### Dry Run
```http
POST /dry-run?process-id=optional_process_id
```
Simulates message processing without affecting the actual state.


## State Management

The service implements several state management strategies:

1. **Checkpoint Loading**
   - Can load from a specific checkpoint using `CHECKPOINT_TX_ID`
   - Can automatically find and load the latest checkpoint
   - Supports loading from scratch with `LOAD_FROM_SCRATCH`

2. **Message Processing**
   - Continuously polls for new messages
   - Processes messages in order
   - Supports nonce-based message limiting

3. **State Synchronization**
   - Periodic full state refreshes
   - Real-time message processing
   - Caching of process state

## Error Handling

The service includes comprehensive error handling for:
- Network failures
- Invalid messages
- State loading errors
- Checkpoint processing errors

## Development

### Project Structure
- `index.js`: Main application entry point
- `src/su.js`: State Update router integration
- `src/checkpoint.js`: Checkpoint management
- `src/index.js`: Core functionality

### Running Locally
```bash
# Install dependencies
npm install

# Start the service (always include experimental flag)
node --experimental-wasm-memory64 index.js --process-id=your_process_id
```

## Troubleshooting

### Common Issues

1. **WebAssembly Memory Error**
   - Always ensure you're using the `--experimental-wasm-memory64` flag
   - This is required for proper WebAssembly memory handling

2. **State Loading Failures**
   - Check network connectivity to SU router
   - Verify process ID is correct
   - Ensure checkpoint TX ID is valid (if using)

3. **Message Processing Issues**
   - Check message format and required fields
   - Verify process state is properly loaded
   - Monitor logs for specific error messages
