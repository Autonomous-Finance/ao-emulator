import express from 'express';
import { aoslocal, loadEnv } from './src/index.js';
import { AoReadState } from './src/su.js';
import { getCheckpointTx, fetchCheckpoint, findCheckpointBeforeOrEqualToNonce, prepareSpecificCheckpoint } from './src/checkpoint.js';
import fs from 'fs'; // Added fs import for file operations
import cors from 'cors'; // Add cors import

// --- Helper function to parse CLI Args (simple version) ---
function parseCliArgs(argv) {
    const cliArgs = {};
    argv.slice(2).forEach(arg => {
        if (arg.startsWith('--')) {
            const [keyWithValue, ...rest] = arg.slice(2).split('=');
            const value = rest.join('='); // Handles cases where value might contain '='

            if (keyWithValue === 'unsafe-memory') {
                cliArgs.LOADER_UNSAFE_MEMORY = true;
            } else if (keyWithValue === 'disable-metering') {
                cliArgs.LOADER_DISABLE_METERING = true;
            } else if (keyWithValue === 'load-from-checkpoint') {
                cliArgs.LOAD_FROM_CHECKPOINT_CLI = true;
            } else if (keyWithValue === 'load-from-scratch') {
                cliArgs.LOAD_FROM_SCRATCH_CLI = true;
            } else if (value !== undefined && value !== '') { // For key=value pairs
                if (keyWithValue === 'port') cliArgs.PORT_CLI = value;
                else if (keyWithValue === 'module-id') cliArgs.AOS_MODULE_ID_CLI = value;
                else if (keyWithValue === 'process-id') cliArgs.PROCESS_ID_TO_MONITOR_CLI = value;
                else if (keyWithValue === 'full-load-interval') cliArgs.FULL_STATE_REFRESH_INTERVAL_MS_CLI = value;
                else if (keyWithValue === 'message-poll-interval') cliArgs.MESSAGE_POLL_INTERVAL_MS_CLI = value;
                else if (keyWithValue === 'su-url') cliArgs.SU_URL_CLI = value;
                else if (keyWithValue === 'forward-to-nonce') cliArgs.FORWARD_TO_NONCE_CLI = value;
                else if (keyWithValue === 'checkpoint-tx') cliArgs.CHECKPOINT_TX_ID_CLI = value;
            }
        }
    });
    return cliArgs;
}

const cliArgs = parseCliArgs(process.argv);

// --- Configuration (CLI > Environment Variables > Defaults) ---

// PORT
const DEFAULT_PORT = 8080;
let argPort = cliArgs.PORT_CLI || process.env.PORT;
const PORT = argPort ? parseInt(argPort, 10) : DEFAULT_PORT;
if (isNaN(PORT)) {
    console.warn(`Invalid PORT value '${argPort}'. Using default ${DEFAULT_PORT}.`);
    argPort = DEFAULT_PORT; // Reassign for clarity if needed, though PORT is already set
}

// PROCESS_ID_TO_MONITOR (Mandatory)
const PROCESS_ID_TO_MONITOR = cliArgs.PROCESS_ID_TO_MONITOR_CLI || process.env.PROCESS_ID_TO_MONITOR;
if (!PROCESS_ID_TO_MONITOR) {
    console.error('FATAL: PROCESS_ID_TO_MONITOR must be set via --process-id=<id> or environment variable.');
    process.exit(1);
}

// AOS_MODULE_ID (Optional, will be derived if not set)
let AOS_MODULE_ID = cliArgs.AOS_MODULE_ID_CLI || process.env.AOS_MODULE_ID;

// FULL_STATE_REFRESH_INTERVAL_MS (Renamed from CACHE_REFRESH_INTERVAL_MS)
const DEFAULT_FULL_REFRESH_INTERVAL = 60000;
let argFullRefreshInterval = cliArgs.FULL_STATE_REFRESH_INTERVAL_MS_CLI || process.env.FULL_STATE_REFRESH_INTERVAL_MS;
const FULL_STATE_REFRESH_INTERVAL_MS = argFullRefreshInterval ? parseInt(argFullRefreshInterval, 10) : DEFAULT_FULL_REFRESH_INTERVAL;
if (isNaN(FULL_STATE_REFRESH_INTERVAL_MS)) {
    console.warn(`Invalid FULL_STATE_REFRESH_INTERVAL_MS value '${argFullRefreshInterval}'. Using default ${DEFAULT_FULL_REFRESH_INTERVAL}.`);
    argFullRefreshInterval = DEFAULT_FULL_REFRESH_INTERVAL;
}

// MESSAGE_POLL_INTERVAL_MS
const DEFAULT_MESSAGE_POLL_INTERVAL = 5000; // Default to 5 seconds
let argMessagePollInterval = cliArgs.MESSAGE_POLL_INTERVAL_MS_CLI || process.env.MESSAGE_POLL_INTERVAL_MS;
const MESSAGE_POLL_INTERVAL_MS = argMessagePollInterval ? parseInt(argMessagePollInterval, 10) : DEFAULT_MESSAGE_POLL_INTERVAL;
if (isNaN(MESSAGE_POLL_INTERVAL_MS) || MESSAGE_POLL_INTERVAL_MS <= 0) {
    console.warn(`Invalid MESSAGE_POLL_INTERVAL_MS value '${argMessagePollInterval}'. Using default ${DEFAULT_MESSAGE_POLL_INTERVAL}.`);
    argMessagePollInterval = DEFAULT_MESSAGE_POLL_INTERVAL;
}

// SU_URL
const DEFAULT_SU_URL = 'https://su-router.ao-testnet.xyz'; // Default SU URL
const SU_URL = cliArgs.SU_URL_CLI || process.env.SU_URL || DEFAULT_SU_URL;

// LOADER_UNSAFE_MEMORY (Boolean)
const LOADER_UNSAFE_MEMORY = cliArgs.LOADER_UNSAFE_MEMORY !== undefined ? cliArgs.LOADER_UNSAFE_MEMORY :
    (process.env.LOADER_UNSAFE_MEMORY !== undefined ? process.env.LOADER_UNSAFE_MEMORY === 'true' : true);

// LOADER_DISABLE_METERING (Boolean)
const LOADER_DISABLE_METERING = cliArgs.LOADER_DISABLE_METERING !== undefined ? cliArgs.LOADER_DISABLE_METERING :
    (process.env.LOADER_DISABLE_METERING !== undefined ? process.env.LOADER_DISABLE_METERING === 'true' : false);

// LOAD_FROM_CHECKPOINT (Boolean)
const LOAD_FROM_CHECKPOINT = cliArgs.LOAD_FROM_CHECKPOINT_CLI || process.env.LOAD_FROM_CHECKPOINT === 'true' || false; // Default to false

// FORWARD_TO_NONCE (Number, optional)
const argForwardToNonce = cliArgs.FORWARD_TO_NONCE_CLI || process.env.FORWARD_TO_NONCE;
let FORWARD_TO_NONCE_LIMIT = null;
if (argForwardToNonce !== undefined) {
    const parsedNonce = parseInt(argForwardToNonce, 10);
    if (!isNaN(parsedNonce) && parsedNonce >= 0) {
        FORWARD_TO_NONCE_LIMIT = parsedNonce;
    } else {
        console.warn(`Invalid FORWARD_TO_NONCE value '${argForwardToNonce}'. It will be ignored. Must be a non-negative integer.`);
    }
}

// CHECKPOINT_TX_ID (Optional, string)
const CHECKPOINT_TX_ID = cliArgs.CHECKPOINT_TX_ID_CLI || process.env.CHECKPOINT_TX_ID;
if (CHECKPOINT_TX_ID) {
    console.log(`Specified Checkpoint TX ID to load: ${CHECKPOINT_TX_ID}`);
}

// LOAD_FROM_SCRATCH (Boolean) - New configuration option
const LOAD_FROM_SCRATCH = cliArgs.LOAD_FROM_SCRATCH_CLI !== undefined ? cliArgs.LOAD_FROM_SCRATCH_CLI :
    (process.env.LOAD_FROM_SCRATCH !== undefined ? process.env.LOAD_FROM_SCRATCH === 'true' : false);

// Warning if LOAD_FROM_SCRATCH is used with conflicting checkpoint flags
if (LOAD_FROM_SCRATCH && (CHECKPOINT_TX_ID || LOAD_FROM_CHECKPOINT)) {
    console.warn('WARNING: LOAD_FROM_SCRATCH is enabled. CHECKPOINT_TX_ID and LOAD_FROM_CHECKPOINT settings will be ignored as the system will start from nonce 0.');
}

// --- Helper function to add jitter ---
function applyJitter(intervalMs, maxJitterMs = 5000) {
    const jitter = Math.random() * maxJitterMs;
    const newInterval = Math.floor(intervalMs + jitter);
    console.log(`Applied jitter: original interval ${intervalMs}ms, new interval ${newInterval}ms (jitter up to ${maxJitterMs}ms)`);
    return newInterval;
}

// --- Globals ---
let aos = null; // aoslocal instance
let isPerformingFullLoad = false;
let isPollingMessages = false;
let lastProcessedNonce = -1; // Tracks the nonce of the last successfully processed message
let globalProcessEnv = {};
let aoReadState = null; // AoReadState instance

// --- New core logic functions ---

async function fetchAndProcessMessages(fromNonceOverride) {
    if (!aos || !aoReadState) {
        console.warn('[fetchAndProcessMessages] aos or aoReadState not initialized, skipping fetch.');
        return;
    }

    if (FORWARD_TO_NONCE_LIMIT !== null && lastProcessedNonce >= FORWARD_TO_NONCE_LIMIT) {
        console.log(`[fetchAndProcessMessages] Current lastProcessedNonce (${lastProcessedNonce}) has reached or exceeded FORWARD_TO_NONCE_LIMIT (${FORWARD_TO_NONCE_LIMIT}). No further messages will be fetched or processed.`);
        return;
    }

    const effectiveFromNonce = typeof fromNonceOverride === 'number' ? fromNonceOverride : lastProcessedNonce + 1;

    if (effectiveFromNonce < 0) { // Ensure nonce is non-negative, common if lastProcessedNonce is -1
        console.warn(`[fetchAndProcessMessages] Corrected fromNonce from ${effectiveFromNonce} to 0.`);
        // effectiveFromNonce = 0; // SU likely expects nonces >= 0 or 1. Let's assume su.js handles 0 or 1 appropriately.
    }

    console.log(`[fetchAndProcessMessages] Attempting to fetch messages for ${PROCESS_ID_TO_MONITOR} from SU (${SU_URL}) starting after nonce ${lastProcessedNonce} (i.e., fromNonce ${effectiveFromNonce}).`);

    try {
        const messagesContext = {
            processId: PROCESS_ID_TO_MONITOR,
            fromNonce: effectiveFromNonce,
            suUrl: SU_URL
        };
        const fetchedData = await aoReadState.loadMessages(messagesContext);
        const extraMessages = (fetchedData.messages || []).sort((a, b) => a.Nonce - b.Nonce);

        if (extraMessages && extraMessages.length > 0) {
            console.log(`[fetchAndProcessMessages] Fetched ${extraMessages.length} additional messages to process.`);
            for (const message of extraMessages) {
                if (FORWARD_TO_NONCE_LIMIT !== null && message.Nonce > FORWARD_TO_NONCE_LIMIT) {
                    console.log(`[fetchAndProcessMessages] Message (ID: ${message.Id}, Nonce: ${message.Nonce}) exceeds FORWARD_TO_NONCE_LIMIT (${FORWARD_TO_NONCE_LIMIT}). Stopping processing for this batch.`);
                    break; // Stop processing further messages in this batch
                }

                let messageToSend = { ...message };
                if (messageToSend.Tags && Array.isArray(messageToSend.Tags)) {
                    messageToSend = flattenMessageTags(messageToSend);
                }

                if (!messageToSend.Target) {
                    messageToSend.Target = PROCESS_ID_TO_MONITOR;
                }

                console.log(`[fetchAndProcessMessages] Processing message (ID: ${messageToSend.Id}, Nonce: ${messageToSend.Nonce}) for ${messageToSend.Target}...`);
                try {
                    // console.log(`[fetchAndProcessMessages] messageToSend:`, messageToSend);
                    const r = await aos.send(messageToSend, globalProcessEnv);
                    // console.log(`[fetchAndProcessMessages] aos.send() result:`, r);
                    lastProcessedNonce = messageToSend.Nonce; // Update nonce only after successful send
                    console.log(`[fetchAndProcessMessages] Successfully processed message ID: ${messageToSend.Id}. New lastProcessedNonce: ${lastProcessedNonce}`);

                    // Print result of the last message when nonce limit is reached
                    if (FORWARD_TO_NONCE_LIMIT !== null && lastProcessedNonce >= FORWARD_TO_NONCE_LIMIT) {
                        console.log('\n-------------------------------------------------------');
                        console.log('LAST MESSAGE RESULT (Nonce Limit Reached):');
                        console.log('-------------------------------------------------------');
                        console.log('Message Details:');
                        console.log(`  ID: ${messageToSend.Id}`);
                        console.log(`  Nonce: ${messageToSend.Nonce}`);
                        console.log(`  Target: ${messageToSend.Target}`);
                        console.log('\nResult:');
                        console.log(JSON.stringify(r, null, 2));
                        console.log('-------------------------------------------------------\n');
                    }
                } catch (sendError) {
                    console.error(`[fetchAndProcessMessages] Error sending message ID ${messageToSend.Id} (Nonce: ${messageToSend.Nonce}) to aos.send:`, sendError);
                    console.error('[fetchAndProcessMessages] Stopping further message processing in this batch to maintain order.');
                    return; // Stop processing this batch
                }
                if (FORWARD_TO_NONCE_LIMIT !== null && lastProcessedNonce >= FORWARD_TO_NONCE_LIMIT) {
                    console.log(`[fetchAndProcessMessages] lastProcessedNonce (${lastProcessedNonce}) has reached FORWARD_TO_NONCE_LIMIT (${FORWARD_TO_NONCE_LIMIT}) after processing message ID: ${messageToSend.Id}. Stopping further message processing.`);
                    return; // Stop processing and exit function
                }
            }
            console.log('[fetchAndProcessMessages] All fetched messages in this batch processed (or limit reached).');
        } else {
            console.log('[fetchAndProcessMessages] No new messages found or fetched from SU.');
        }
    } catch (fetchProcessError) {
        console.error(`[fetchAndProcessMessages] Error fetching or processing messages from SU (fromNonce ${effectiveFromNonce}):`, fetchProcessError);
    }
}

async function pollForNewMessages() {
    if (!aos) {
        // console.log('[pollForNewMessages] aos not initialized, skipping poll.'); // Can be noisy
        return;
    }
    if (isPerformingFullLoad || isPollingMessages) {
        // console.log('[pollForNewMessages] Full load or another poll in progress, skipping.'); // Can be noisy
        return;
    }

    if (FORWARD_TO_NONCE_LIMIT !== null && lastProcessedNonce >= FORWARD_TO_NONCE_LIMIT) {
        console.log(`[pollForNewMessages] Current lastProcessedNonce (${lastProcessedNonce}) has reached or exceeded FORWARD_TO_NONCE_LIMIT (${FORWARD_TO_NONCE_LIMIT}). Message polling will be paused.`);
        // Optionally, clear the interval if we want to permanently stop polling once limit is reached.
        // For now, it will just skip polls until the condition changes (e.g., limit removed or nonce reset, though reset is unlikely here).
        return;
    }

    isPollingMessages = true;
    // console.log('[pollForNewMessages] Starting poll cycle...');
    try {
        await fetchAndProcessMessages(); // Uses global lastProcessedNonce
    } catch (error) {
        console.error('[pollForNewMessages] Error during message polling cycle:', error);
    }
    finally {
        isPollingMessages = false;
        // console.log('[pollForNewMessages] Poll cycle finished.');
    }
}

async function initialLoadAndCatchup() {
    if (!aos) {
        console.warn('[initialLoadAndCatchup] aos not initialized, cannot perform initial load.');
        return;
    }
    if (isPerformingFullLoad) {
        console.log('[initialLoadAndCatchup] Full load already in progress, skipping.');
        return;
    }
    console.log('[initialLoadAndCatchup] Performing initial state load and message catch-up...');
    isPerformingFullLoad = true;
    let loadedSuccessfully = false;
    let checkpointToLoadTxId = null;
    const wasExplicitCheckpointRequested = (CHECKPOINT_TX_ID != null && !LOAD_FROM_SCRATCH); // LOAD_FROM_SCRATCH overrides explicit checkpoint

    try {
        if (LOAD_FROM_SCRATCH) {
            console.log('[initialLoadAndCatchup] LOAD_FROM_SCRATCH is true. Initializing module without loading prior state.');
            lastProcessedNonce = -1;
            loadedSuccessfully = true;
            console.log(`[initialLoadAndCatchup] Module ready. lastProcessedNonce set to ${lastProcessedNonce} to fetch all available messages from SU.`);
        } else if (LOAD_FROM_CHECKPOINT || wasExplicitCheckpointRequested) {
            // Skip live state load and go straight to checkpoint loading
            console.log('[initialLoadAndCatchup] LOAD_FROM_CHECKPOINT is true or explicit checkpoint requested. Skipping live state load.');

            if (wasExplicitCheckpointRequested) {
                console.log(`[initialLoadAndCatchup] Explicit CHECKPOINT_TX_ID (${CHECKPOINT_TX_ID}) provided. This will be attempted.`);
                checkpointToLoadTxId = CHECKPOINT_TX_ID;
            } else {
                console.log('[initialLoadAndCatchup] LOAD_FROM_CHECKPOINT is true. Attempting to find a suitable checkpoint automatically.');
                try {
                    let checkpointNode = null;
                    if (FORWARD_TO_NONCE_LIMIT !== null) {
                        console.log(`[initialLoadAndCatchup] FORWARD_TO_NONCE_LIMIT is set to ${FORWARD_TO_NONCE_LIMIT}. Searching for a checkpoint <= this nonce.`);
                        checkpointNode = await findCheckpointBeforeOrEqualToNonce(PROCESS_ID_TO_MONITOR, FORWARD_TO_NONCE_LIMIT);
                        if (checkpointNode) {
                            console.log(`[initialLoadAndCatchup] Found checkpoint ID ${checkpointNode.id} (Nonce: ${checkpointNode.tags.find(t => t.name === 'Nonce' || t.name === 'Ordinate')?.value}) suitable for nonce limit.`);
                        } else {
                            console.warn(`[initialLoadAndCatchup] No checkpoint found for ${PROCESS_ID_TO_MONITOR} with nonce <= ${FORWARD_TO_NONCE_LIMIT}.`);
                        }
                    } else {
                        console.log('[initialLoadAndCatchup] Fetching the latest checkpoint for the process.');
                        checkpointNode = await getCheckpointTx(PROCESS_ID_TO_MONITOR);
                        if (checkpointNode) {
                            console.log(`[initialLoadAndCatchup] Found latest checkpoint ID ${checkpointNode.id} (Nonce: ${checkpointNode.tags.find(t => t.name === 'Nonce' || t.name === 'Ordinate')?.value}).`);
                        }
                    }

                    if (checkpointNode && checkpointNode.id) {
                        checkpointToLoadTxId = checkpointNode.id;
                    } else {
                        console.warn(`[initialLoadAndCatchup] Could not automatically determine a checkpoint TX ID for ${PROCESS_ID_TO_MONITOR}. Checkpoint loading will be skipped.`);
                    }
                } catch (findError) {
                    console.error('[initialLoadAndCatchup] Error while trying to find a suitable checkpoint TX ID:', findError);
                }
            }

            // Attempt to load checkpoint if one was identified
            if (checkpointToLoadTxId) {
                console.log(`[initialLoadAndCatchup] Attempting to prepare and load from checkpoint TX ID: ${checkpointToLoadTxId}`);
                try {
                    const prepResult = await prepareSpecificCheckpoint(PROCESS_ID_TO_MONITOR, checkpointToLoadTxId);

                    if (prepResult.success) {
                        console.log(`[initialLoadAndCatchup] Checkpoint ${checkpointToLoadTxId} successfully prepared. File: ${prepResult.preparedFilePath}. Nonce: ${prepResult.nonce}.`);
                        console.log(`[initialLoadAndCatchup] Calling aos.fromCheckpoint(${checkpointToLoadTxId}) to load the prepared checkpoint state into AOS memory.`);
                        const loadResult = await aos.fromCheckpoint(checkpointToLoadTxId);
                        console.log('[initialLoadAndCatchup] aos.fromCheckpoint() result after preparing checkpoint:', loadResult);
                        loadedSuccessfully = true;

                        if (prepResult.nonce !== null) {
                            console.log(`[initialLoadAndCatchup] Updating lastProcessedNonce from prepared checkpoint: ${prepResult.nonce}.`);
                            lastProcessedNonce = prepResult.nonce;
                        } else {
                            console.warn('[initialLoadAndCatchup] Nonce not available from prepared checkpoint metadata. lastProcessedNonce not updated from checkpoint meta, remains', lastProcessedNonce);
                        }
                    } else {
                        console.error(`[initialLoadAndCatchup] Failed to prepare checkpoint ${checkpointToLoadTxId}: ${prepResult.error}`);
                        if (wasExplicitCheckpointRequested) {
                            console.error(`[initialLoadAndCatchup] CRITICAL: The explicitly requested checkpoint TX ID ${CHECKPOINT_TX_ID} could not be prepared. Halting initial load.`);
                            isPerformingFullLoad = false;
                            return;
                        }
                    }
                } catch (prepLoadError) {
                    console.error(`[initialLoadAndCatchup] Critical error during preparation or loading of checkpoint TX ID ${checkpointToLoadTxId}:`, prepLoadError);
                    if (wasExplicitCheckpointRequested) {
                        console.error(`[initialLoadAndCatchup] CRITICAL: The explicitly requested checkpoint TX ID ${CHECKPOINT_TX_ID} failed during load process. Halting initial load.`);
                        isPerformingFullLoad = false;
                        return;
                    }
                }
            }
        } else {
            // First try to load from live state by default
            console.log('[initialLoadAndCatchup] Attempting to load latest state via live state download...');
            try {
                const loadResult = await aos.load(PROCESS_ID_TO_MONITOR);
                console.log('[initialLoadAndCatchup] loadResult (live state):', loadResult);

                let ordinateFromLoad;
                if (loadResult && typeof loadResult === 'object' && !loadResult['cached-state']) {
                    // Check 'last-ordinate' specifically for valid, non-null numeric value
                    if (loadResult['last-ordinate'] !== undefined && loadResult['last-ordinate'] !== null) {
                        ordinateFromLoad = Number(loadResult['last-ordinate']);
                        // Ensure it's a valid, non-negative number
                        if (!isNaN(ordinateFromLoad) && ordinateFromLoad >= 0) {
                            console.log(`[initialLoadAndCatchup] Live state load complete. Last Ordinate reported: ${ordinateFromLoad}. Updating lastProcessedNonce.`);
                            lastProcessedNonce = ordinateFromLoad;
                            loadedSuccessfully = true;
                        } else {
                            console.warn(`[initialLoadAndCatchup] Live state load reported invalid (non-numeric, negative, or NaN) last-ordinate: ${loadResult['last-ordinate']}. Will attempt SU fallback.`);
                            loadedSuccessfully = false;
                        }
                    } else { // 'last-ordinate' is undefined or null
                        console.warn(`[initialLoadAndCatchup] Live state load provided no valid last-ordinate (it was undefined or null: ${loadResult['last-ordinate']}). Will attempt SU fallback.`);
                        loadedSuccessfully = false;
                    }
                } else if (loadResult && loadResult['cached-state']) {
                    console.log('[initialLoadAndCatchup] State was loaded from local cache (state.bin). lastProcessedNonce remains: ', lastProcessedNonce);
                    loadedSuccessfully = true;
                } else { // Catches loadResult being null, not an object, or other unexpected structures
                    console.warn('[initialLoadAndCatchup] Live state load returned null, was not an object, or had an unexpected structure. Will attempt SU fallback.', loadResult);
                    loadedSuccessfully = false;
                }

                // Fallback: If live load didn't yield a valid nonce, try fetching from SU /latest endpoint
                if (!loadedSuccessfully && !LOAD_FROM_SCRATCH && !CHECKPOINT_TX_ID && !LOAD_FROM_CHECKPOINT) { // Only if no other specific load strategy is active
                    console.log(`[initialLoadAndCatchup] Live state load did not provide a valid nonce. Attempting to fetch nonce from SU /latest endpoint for ${PROCESS_ID_TO_MONITOR}.`);
                    try {
                        const latestSuUrl = `${SU_URL}/${PROCESS_ID_TO_MONITOR}/latest`;
                        const suResponse = await fetch(latestSuUrl);
                        if (suResponse.ok) {
                            const suData = await suResponse.json();
                            if (suData && suData.assignment && Array.isArray(suData.assignment.tags)) {
                                const nonceTag = suData.assignment.tags.find(tag => tag && tag.name === 'Nonce');
                                if (nonceTag && nonceTag.value !== undefined) {
                                    const nonceFromSu = parseInt(nonceTag.value, 10);
                                    if (!isNaN(nonceFromSu) && nonceFromSu >= 0) {
                                        console.log(`[initialLoadAndCatchup] Successfully fetched Nonce ${nonceFromSu} from SU /latest endpoint (via assignment.tags). Updating lastProcessedNonce.`);
                                        lastProcessedNonce = nonceFromSu;
                                        loadedSuccessfully = true;
                                    } else {
                                        console.warn(`[initialLoadAndCatchup] Nonce value from SU /latest (assignment.tags.Nonce) is invalid: ${nonceTag.value}.`);
                                    }
                                } else {
                                    console.warn('[initialLoadAndCatchup] Could not find Nonce tag or its value in suData.assignment.tags from SU /latest endpoint.', suData.assignment.tags);
                                }
                            } else {
                                console.warn('[initialLoadAndCatchup] SU /latest endpoint response did not contain expected assignment.tags array structure.', suData);
                            }
                        } else {
                            console.warn(`[initialLoadAndCatchup] Failed to fetch from SU /latest endpoint. Status: ${suResponse.status}`);
                        }
                    } catch (suFetchError) {
                        console.error(`[initialLoadAndCatchup] Error fetching or processing from SU /latest endpoint for ${PROCESS_ID_TO_MONITOR}:`, suFetchError);
                    }
                }

            } catch (liveLoadError) {
                console.error(`[initialLoadAndCatchup] Error during live state load for ${PROCESS_ID_TO_MONITOR}:`, liveLoadError);
                loadedSuccessfully = false;
            }

            // Only attempt checkpoint loading if live state load failed or if explicitly requested
            // and SU fallback also didn't succeed
            if (!loadedSuccessfully && (wasExplicitCheckpointRequested || LOAD_FROM_CHECKPOINT)) {
                if (wasExplicitCheckpointRequested) {
                    console.log(`[initialLoadAndCatchup] Explicit CHECKPOINT_TX_ID (${CHECKPOINT_TX_ID}) provided. This will be attempted.`);
                    checkpointToLoadTxId = CHECKPOINT_TX_ID;
                } else if (LOAD_FROM_CHECKPOINT) {
                    console.log('[initialLoadAndCatchup] LOAD_FROM_CHECKPOINT is true. Attempting to find a suitable checkpoint automatically.');
                    try {
                        let checkpointNode = null;
                        if (FORWARD_TO_NONCE_LIMIT !== null) {
                            console.log(`[initialLoadAndCatchup] FORWARD_TO_NONCE_LIMIT is set to ${FORWARD_TO_NONCE_LIMIT}. Searching for a checkpoint <= this nonce.`);
                            checkpointNode = await findCheckpointBeforeOrEqualToNonce(PROCESS_ID_TO_MONITOR, FORWARD_TO_NONCE_LIMIT);
                            if (checkpointNode) {
                                console.log(`[initialLoadAndCatchup] Found checkpoint ID ${checkpointNode.id} (Nonce: ${checkpointNode.tags.find(t => t.name === 'Nonce' || t.name === 'Ordinate')?.value}) suitable for nonce limit.`);
                            } else {
                                console.warn(`[initialLoadAndCatchup] No checkpoint found for ${PROCESS_ID_TO_MONITOR} with nonce <= ${FORWARD_TO_NONCE_LIMIT}.`);
                            }
                        } else {
                            console.log('[initialLoadAndCatchup] Fetching the latest checkpoint for the process.');
                            checkpointNode = await getCheckpointTx(PROCESS_ID_TO_MONITOR);
                            if (checkpointNode) {
                                console.log(`[initialLoadAndCatchup] Found latest checkpoint ID ${checkpointNode.id} (Nonce: ${checkpointNode.tags.find(t => t.name === 'Nonce' || t.name === 'Ordinate')?.value}).`);
                            }
                        }

                        if (checkpointNode && checkpointNode.id) {
                            checkpointToLoadTxId = checkpointNode.id;
                        } else {
                            console.warn(`[initialLoadAndCatchup] Could not automatically determine a checkpoint TX ID for ${PROCESS_ID_TO_MONITOR}. Checkpoint loading will be skipped for auto-find path.`);
                        }
                    } catch (findError) {
                        console.error('[initialLoadAndCatchup] Error while trying to find a suitable checkpoint TX ID for auto-find path:', findError);
                    }
                }

                // Attempt to load checkpoint if one was identified
                if (checkpointToLoadTxId) {
                    console.log(`[initialLoadAndCatchup] Attempting to prepare and load from checkpoint TX ID: ${checkpointToLoadTxId}`);
                    try {
                        const prepResult = await prepareSpecificCheckpoint(PROCESS_ID_TO_MONITOR, checkpointToLoadTxId);

                        if (prepResult.success) {
                            console.log(`[initialLoadAndCatchup] Checkpoint ${checkpointToLoadTxId} successfully prepared. File: ${prepResult.preparedFilePath}. Nonce: ${prepResult.nonce}.`);
                            console.log(`[initialLoadAndCatchup] Calling aos.fromCheckpoint(${checkpointToLoadTxId}) to load the prepared checkpoint state into AOS memory.`);
                            const loadResult = await aos.fromCheckpoint(checkpointToLoadTxId);
                            console.log('[initialLoadAndCatchup] aos.fromCheckpoint() result after preparing checkpoint:', loadResult);
                            loadedSuccessfully = true;

                            if (prepResult.nonce !== null) {
                                console.log(`[initialLoadAndCatchup] Updating lastProcessedNonce from prepared checkpoint: ${prepResult.nonce}.`);
                                lastProcessedNonce = prepResult.nonce;
                            } else {
                                console.warn('[initialLoadAndCatchup] Nonce not available from prepared checkpoint metadata. lastProcessedNonce not updated from checkpoint meta, remains', lastProcessedNonce);
                            }
                        } else {
                            console.error(`[initialLoadAndCatchup] Failed to prepare checkpoint ${checkpointToLoadTxId}: ${prepResult.error}`);
                            if (wasExplicitCheckpointRequested) {
                                console.error(`[initialLoadAndCatchup] CRITICAL: The explicitly requested checkpoint TX ID ${CHECKPOINT_TX_ID} could not be prepared. Halting initial load.`);
                                isPerformingFullLoad = false;
                                return;
                            }
                        }
                    } catch (prepLoadError) {
                        console.error(`[initialLoadAndCatchup] Critical error during preparation or loading of checkpoint TX ID ${checkpointToLoadTxId}:`, prepLoadError);
                        if (wasExplicitCheckpointRequested) {
                            console.error(`[initialLoadAndCatchup] CRITICAL: The explicitly requested checkpoint TX ID ${CHECKPOINT_TX_ID} failed during load process. Halting initial load.`);
                            isPerformingFullLoad = false;
                            return;
                        }
                    }
                }
            }
        }

        // Message Catch-up Logic
        if (loadedSuccessfully) {
            let shouldCatchup = true;
            if (LOAD_FROM_SCRATCH) {
                console.log(`[initialLoadAndCatchup] LOAD_FROM_SCRATCH active. Proceeding with message catch-up from nonce ${lastProcessedNonce + 1} (respecting FORWARD_TO_NONCE_LIMIT: ${FORWARD_TO_NONCE_LIMIT}).`);
            } else if (wasExplicitCheckpointRequested) {
                if (FORWARD_TO_NONCE_LIMIT === null || lastProcessedNonce >= FORWARD_TO_NONCE_LIMIT) {
                    console.log(`[initialLoadAndCatchup] Loaded explicit checkpoint ${CHECKPOINT_TX_ID} (Nonce: ${lastProcessedNonce}). FORWARD_TO_NONCE_LIMIT (${FORWARD_TO_NONCE_LIMIT}) does not require further message processing. Initial message catch-up will be skipped.`);
                    shouldCatchup = false;
                } else {
                    console.log(`[initialLoadAndCatchup] Loaded explicit checkpoint ${CHECKPOINT_TX_ID} (Nonce: ${lastProcessedNonce}). FORWARD_TO_NONCE_LIMIT (${FORWARD_TO_NONCE_LIMIT}) is higher. Proceeding with message catch-up.`);
                }
            } else if (checkpointToLoadTxId) {
                console.log(`[initialLoadAndCatchup] State loaded from automatically determined checkpoint ${checkpointToLoadTxId} (Nonce: ${lastProcessedNonce}). Proceeding with standard message catch-up logic (respecting FORWARD_TO_NONCE_LIMIT: ${FORWARD_TO_NONCE_LIMIT}).`);
            } else {
                console.log(`[initialLoadAndCatchup] State loaded via live state download. Proceeding with standard message catch-up logic from nonce ${lastProcessedNonce} (respecting FORWARD_TO_NONCE_LIMIT: ${FORWARD_TO_NONCE_LIMIT}).`);
            }

            if (shouldCatchup) {
                console.log(`[initialLoadAndCatchup] Attempting initial message catch-up from lastProcessedNonce: ${lastProcessedNonce}.`);
                await fetchAndProcessMessages();
            }
        } else {
            console.error(`[initialLoadAndCatchup] CRITICAL: State could not be loaded for ${PROCESS_ID_TO_MONITOR}.`);
            if (wasExplicitCheckpointRequested) {
                console.error(`[initialLoadAndCatchup] This was attempted due to an explicitly provided CHECKPOINT_TX_ID: ${CHECKPOINT_TX_ID}, which failed to load.`);
            } else if (LOAD_FROM_CHECKPOINT && !checkpointToLoadTxId) {
                console.error('[initialLoadAndCatchup] This was attempted via automatic checkpoint finding (LOAD_FROM_CHECKPOINT=true), but no suitable checkpoint was found or loaded, and fallback to live state also failed.');
            } else if (LOAD_FROM_CHECKPOINT && checkpointToLoadTxId) {
                console.error(`[initialLoadAndCatchup] This was attempted via automatic checkpoint finding (LOAD_FROM_CHECKPOINT=true), found ${checkpointToLoadTxId}, but it failed to load, and fallback to live state also failed.`);
            } else {
                console.error('[initialLoadAndCatchup] Loading via live state (no checkpoint requested or LOAD_FROM_CHECKPOINT=false) also failed.');
            }
            console.error('[initialLoadAndCatchup] Message catch-up will be skipped. The service may not function correctly or start processing messages.');
        }

    } catch (error) {
        console.error(`[initialLoadAndCatchup] Outer error during initial load or catch-up for ${PROCESS_ID_TO_MONITOR}:`, error);
    } finally {
        isPerformingFullLoad = false;
        console.log('[initialLoadAndCatchup] Initial state load and message catch-up process finished.');
    }
}

async function performPeriodicFullLoad() {
    if (!aos) {
        // console.warn('[performPeriodicFullLoad] aos not initialized, skipping periodic load.'); // Can be noisy
        return;
    }
    if (isPerformingFullLoad || isPollingMessages) { // Don't run if a poll is active either, to be safe
        // console.log('[performPeriodicFullLoad] Another load or poll in progress, skipping.'); // Can be noisy
        return;
    }
    console.log('[performPeriodicFullLoad] Starting periodic full state load...');
    isPerformingFullLoad = true;
    try {
        const loadResult = await aos.load(PROCESS_ID_TO_MONITOR);
        console.log('[performPeriodicFullLoad] loadResult:', loadResult); // User added log
        console.log(`[performPeriodicFullLoad] Periodic state load into Wasm memory for ${PROCESS_ID_TO_MONITOR} complete.`);

        let ordinateFromLoad;
        if (loadResult && typeof loadResult === 'object' && !loadResult['cached-state'] && loadResult['last-ordinate'] !== undefined) {
            ordinateFromLoad = Number(loadResult['last-ordinate']);
            if (!isNaN(ordinateFromLoad)) {
                if (ordinateFromLoad > lastProcessedNonce) {
                    console.log(`[performPeriodicFullLoad] Full load provided a newer last-ordinate: ${ordinateFromLoad} (current lastProcessedNonce: ${lastProcessedNonce}). Updating lastProcessedNonce.`);
                    lastProcessedNonce = ordinateFromLoad;
                    // Optionally, trigger an immediate catch-up if there's a gap, though polling should handle it.
                    // console.log('[performPeriodicFullLoad] Triggering message catch-up after full load update...');
                    // await fetchAndProcessMessages(); // This might be redundant if polling is frequent
                } else {
                    console.log(`[performPeriodicFullLoad] Full load provided last-ordinate: ${ordinateFromLoad}, which is not newer than current lastProcessedNonce: ${lastProcessedNonce}. No update to lastProcessedNonce from this load.`);
                }
            } else {
                console.warn(`[performPeriodicFullLoad] Full load reported non-numeric last-ordinate: ${loadResult['last-ordinate']}. lastProcessedNonce not updated.`);
            }
        } else if (loadResult && loadResult['cached-state']) {
            console.log('[performPeriodicFullLoad] Periodic state was loaded from local cache. No last-ordinate provided. lastProcessedNonce (${lastProcessedNonce}) remains unchanged by this load operation.');
        } else {
            console.warn('[performPeriodicFullLoad] Unexpected result from periodic aos.load(), or no last-ordinate provided:', loadResult, '. lastProcessedNonce (${lastProcessedNonce}) remains unchanged.');
        }

    } catch (error) {
        console.error(`[performPeriodicFullLoad] Error during periodic full state load for ${PROCESS_ID_TO_MONITOR}:`, error);
    } finally {
        isPerformingFullLoad = false;
        console.log('[performPeriodicFullLoad] Periodic full state load process finished.');
    }
}

// --- aoslocal Initialization and State Management ---
async function initializeAndPrepareAos() {
    if (aos) return aos;

    // Instantiate AoReadState
    aoReadState = new AoReadState({
        fetch: globalThis.fetch, // Assuming global fetch is available and appropriate
        logger: console, // Or a more sophisticated logger
        cacheEnabled: false, // Ensure fresh message metadata from SU
        suUrl: SU_URL
    });
    console.log(`AoReadState initialized with SU URL: ${SU_URL} and cacheEnabled: false`);

    let effectiveModuleId = AOS_MODULE_ID; // AOS_MODULE_ID is now resolved from CLI/env
    globalProcessEnv = {};

    try {
        console.log(`Fetching environment for process: ${PROCESS_ID_TO_MONITOR} using loadEnv...`);
        const loadedEnv = await loadEnv(PROCESS_ID_TO_MONITOR);
        if (loadedEnv && loadedEnv.Module && loadedEnv.Module.Id) {
            if (!effectiveModuleId) { // If AOS_MODULE_ID was not set via CLI or env, use the one from loadEnv
                effectiveModuleId = loadedEnv.Module.Id;
                console.log(`Derived Module ID from loadEnv: ${effectiveModuleId}`);
            }
            globalProcessEnv = loadedEnv;
        } else {
            console.warn(`Could not derive module ID or full env from loadEnv for ${PROCESS_ID_TO_MONITOR}.`);
            if (!effectiveModuleId) {
                effectiveModuleId = 'LATEST'; // Fallback if not set by CLI/env and not derivable
                console.log(`Falling back to Module ID: ${effectiveModuleId}`);
            }
        }

        if (!effectiveModuleId) {
            // This should be rare now as PROCESS_ID_TO_MONITOR is mandatory, and loadEnv or LATEST are fallbacks
            console.error('FATAL: Module ID could not be determined.');
            throw new Error('Module ID for aoslocal could not be determined.');
        }

        console.log(`Initializing aoslocal with effective module: ${effectiveModuleId}...`);
        const loaderOptions = {
            UNSAFE_MEMORY: LOADER_UNSAFE_MEMORY,
            DISABLE_METERING: LOADER_DISABLE_METERING,
            LOAD_FROM_CHECKPOINT: LOAD_FROM_CHECKPOINT
        };
        console.log('Using loader options:', loaderOptions);
        aos = await aoslocal(effectiveModuleId, globalProcessEnv, loaderOptions);
        console.log('aoslocal initialized.');

        await initialLoadAndCatchup();

        if (!CHECKPOINT_TX_ID) {
            console.log(`[initializeAndPrepareAos] Periodic full state load interval will be set (if uncommented below). CHECKPOINT_TX_ID is not set.`);
            // setInterval(performPeriodicFullLoad, applyJitter(FULL_STATE_REFRESH_INTERVAL_MS));
        } else {
            console.log(`[initializeAndPrepareAos] Periodic full state load will NOT be set (even if uncommented below) because a specific CHECKPOINT_TX_ID (${CHECKPOINT_TX_ID}) was provided.`);
            // If the line was uncommented, it would be here, but still effectively disabled by the 'else' block.
            // setInterval(performPeriodicFullLoad, applyJitter(FULL_STATE_REFRESH_INTERVAL_MS));
        }

        const jitteredMessagePollInterval = applyJitter(MESSAGE_POLL_INTERVAL_MS);
        setInterval(pollForNewMessages, jitteredMessagePollInterval);
        return aos;
    } catch (error) {
        console.error('Failed to initialize aoslocal:', error);
        throw error;
    }
}

const app = express();
app.use(cors()); // Enable CORS for all routes
app.use(express.json());

// --- Helper function to flatten Tags ---
function flattenTags(tagsArray) {
    if (!Array.isArray(tagsArray)) {
        return tagsArray; // Return as is if not an array (e.g., already flattened or not present)
    }
    return tagsArray.reduce((obj, item) => {
        if (item && typeof item.name === 'string') {
            obj[item.name] = item.value;
        }
        return obj;
    }, {});
}

function flattenMessageTags(message) {
    // Create a copy of the message to avoid modifying the original
    const flattenedMessage = { ...message };

    // Initialize Tags object if it doesn't exist
    if (!flattenedMessage.Tags) {
        flattenedMessage.Tags = {};
    }

    // If Tags is an array, flatten it
    if (Array.isArray(message.Tags)) {
        message.Tags.forEach(tag => {
            if (tag && tag.name && tag.value !== undefined) {
                // Only add to root level if it doesn't already exist
                if (flattenedMessage[tag.name] === undefined) {
                    flattenedMessage[tag.name] = tag.value;
                }
                // Always add to Tags object
                flattenedMessage.Tags[tag.name] = tag.value;
            }
        });
    }

    return flattenedMessage;
}

function formatAOS(ctx) {
    const aoMsg = {
        Id: "MESSAGE_ID",
        Target: ctx.msg?.Target || DEFAULT_ENV.Process.Id,
        Owner: ctx.msg?.Owner || DEFAULT_ENV.Process.Owner,
        Data: ctx.msg?.Data || "",
        Module: "MODULE",
        ["Block-Height"]: "1",
        From: ctx.msg?.From || ctx.msg?.Owner || DEFAULT_ENV.Process.Owner,
        Timestamp: (new Date().getTime()).toString(),
        Tags: Object
            .keys(ctx.msg)
            .filter(k => !["Target", "Owner", "Data", "Anchor", "Tags"].includes(k))
            .map(k => ({ name: k, value: ctx.msg[k] }))
    }

    // Flatten the tags in the message
    ctx.msg = flattenMessageTags(aoMsg);
    return ctx
}

app.post('/dry-run', async (req, res) => {
    if (!aos) {
        return res.status(503).json({ error: 'aoslocal service not yet initialized. Please try again shortly.' });
    }

    const message = req.body;
    const queryProcessId = req.query['process-id'];

    console.log(`Received /dry-run request for query process-id: ${queryProcessId || 'Not Provided'}`);
    console.log('Original message:', JSON.stringify(message, null, 2));

    if (typeof message !== 'object' || message === null || !message.Target || !message.Tags) {
        return res.status(400).json({ error: 'Invalid or incomplete message object in request body. \'Target\' and \'Tags\' are required.' });
    }

    if (queryProcessId && message.Target !== queryProcessId) {
        console.warn(`Warning: Query parameter process-id ('${queryProcessId}') does not match message.Target ('${message.Target}'). Will proceed with message.Target.`);
    }

    console.log(`Dry-running message for Target: ${message.Target} (Wasm state is for ${PROCESS_ID_TO_MONITOR})`);

    try {
        // Create a new message object with flattened tags
        const processedMessage = flattenMessageTags(message);
        console.log('Processed message after flattening:', JSON.stringify(processedMessage, null, 2));

        console.log('sending message to aos.send...');
        const startTime = Date.now();
        console.log('message:', processedMessage);
        const result = await aos.send(processedMessage, globalProcessEnv, false);
        const duration = Date.now() - startTime;
        console.log(`Dry-run for message to ${message.Target} completed in ${duration}ms.`);

        console.log('Result:', JSON.stringify(result, null, 2));
        // Create a response payload excluding the Memory field
        const responsePayload = {
            Output: result.Output,
            Messages: result.Messages,
            Spawns: result.Spawns,
            Error: result.Error,
            Assignments: result.Assignments,
            GasUsed: result.GasUsed,
            Emulated: true,
            ProcessId: PROCESS_ID_TO_MONITOR
        };

        // Clean up undefined fields from responsePayload to make it cleaner
        Object.keys(responsePayload).forEach(key => {
            if (responsePayload[key] === undefined) {
                delete responsePayload[key];
            }
        });

        res.json(responsePayload);

    } catch (error) {
        console.error('Error during /dry-run:', error);
        res.status(500).json({ error: 'Failed to process dry-run request.', details: error.message });
    }
});

app.get('/health', (req, res) => {
    if (!aos) {
        return res.status(503).json({ status: 'INITIALIZING', message: 'aoslocal not yet initialized.' });
    }
    if (isPerformingFullLoad) {
        return res.status(200).json({ status: 'BUSY_LOADING_STATE', message: 'aoslocal is performing a full state load.' });
    }
    if (isPollingMessages) {
        return res.status(200).json({ status: 'BUSY_POLLING_MESSAGES', message: 'aoslocal is polling for new messages.' });
    }
    res.status(200).json({ status: 'OK', message: 'aoslocal initialized and idle or actively polling.' });
});

async function startServer() {
    try {
        await initializeAndPrepareAos();
        app.listen(PORT, () => {
            console.log('-------------------------------------------------------');
            console.log(` aos-http-service listening on port ${PORT}`);
            console.log('-------------------------------------------------------');
            console.log(`  Monitored Process ID : ${PROCESS_ID_TO_MONITOR}`);
            console.log(`  Effective Module ID  : ${AOS_MODULE_ID || 'Derived from Monitored Process or LATEST'}`);
            console.log(`  Full State Load Interval : ${FULL_STATE_REFRESH_INTERVAL_MS / 1000} seconds`);
            console.log(`  Message Poll Interval  : ${MESSAGE_POLL_INTERVAL_MS / 1000} seconds`);
            console.log(`  SU URL for messages  : ${SU_URL}`);
            console.log(`  Loader UNSAFE_MEMORY : ${LOADER_UNSAFE_MEMORY}`);
            console.log(`  Loader DISABLE_METERING: ${LOADER_DISABLE_METERING}`);
            console.log(`  Load from Checkpoint : ${LOAD_FROM_CHECKPOINT}`);
            console.log(`  Load from Scratch    : ${LOAD_FROM_SCRATCH}`);
            if (CHECKPOINT_TX_ID && !LOAD_FROM_SCRATCH) {
                console.log(`  Specific Checkpoint TX : ${CHECKPOINT_TX_ID}`);
            }
            if (FORWARD_TO_NONCE_LIMIT !== null) {
                console.log(`  Forward to Nonce Limit: ${FORWARD_TO_NONCE_LIMIT}`);
            }
            console.log('-------------------------------------------------------');
        });
    } catch (error) {
        console.error('Error starting server:', error);
        process.exit(1);
    }
}

startServer();