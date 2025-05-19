import { gunzipSync } from 'zlib'
import fs from 'fs'
export async function fetchCheckpoint(tx) {
  try {
    const fileName = `${tx}.bin`
    if (fs.existsSync(fileName)) {
      return await readLargeFile(fileName)
    }
    const response = await fetch(`https://arweave.net/${tx}`)

    if (!response.ok) {
      throw new Error(`Failed to fetch: ${tx} : ${response.statusText}`)
    }
    const compressedBuffer = await response.arrayBuffer()

    const decompressedBuffer = gunzipSync(compressedBuffer)
    const buffer = decompressedBuffer.buffer;
    //fs.writeFileSync(fileName, Buffer.from(buffer))
    await writeLargeBufferToFile(fileName, Buffer.from(buffer))
    return buffer
  } catch (err) {
    console.log("Error: ", err)
    throw err
  }
}

export async function getCheckpointTx(pid) {
  try {
    const response = await fetch(`https://arweave-search.goldsky.com/graphql`, {
      method: 'POST',
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: `
query {
  transactions (first: 1, tags: [
      { name: "Type", values: ["Checkpoint"]},
      { name: "Process", values: ["${pid}"]}
  ]) {
    edges {
      node {
        id
        tags {
          name
          value
        }
      }
    }    
  }
}
      `})
    })

    if (!response.ok) {
      throw new Error(`Could not find checkpoint: ${pid} Error Code: ${response.statusText}`)
    }
    const result = await response.json()
    // console.log(result)
    return result.data?.transactions?.edges[0]?.node
  } catch (err) {
    console.log("Error: ", err)
    throw err
  }
}

export async function fetchLiveState(processId) {
  try {
    const fileName = `${processId}-live.bin`;
    // Removed local cache check to always fetch from endpoint

    console.log(`Fetching live state metadata for ${processId} from https://cu.ao-testnet.xyz/state/${processId}`);
    const response = await fetch(`https://cu.ao-testnet.xyz/state/${processId}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch live state for ${processId}: ${response.statusText} (status: ${response.status})`);
    }

    const buffer = await response.arrayBuffer();

    // Extract desired headers
    const lastTimestamp = response.headers.get('last-timestamp');
    const lastOrdinate = response.headers.get('last-ordinate');
    const lastBlockHeight = response.headers.get('last-block-height');

    // Write to cache
    await writeLargeBufferToFile(fileName, Buffer.from(buffer));

    return {
      buffer,
      headers: {
        'last-timestamp': lastTimestamp,
        'last-ordinate': lastOrdinate,
        'last-block-height': lastBlockHeight
      }
    };
  } catch (err) {
    console.log("Error fetching live state: ", err);
    throw err;
  }
}

/**
 * Writes a buffer to a file using a stream, allowing large files (>2GB).
 * @param {Buffer} buffer - The buffer to write to the file.
 * @param {string} filePath - The path of the file to write to.
 * @returns {Promise<void>}
 */
function writeLargeBufferToFile(filePath, buffer) {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);

    // Split the buffer into chunks for streaming
    const chunkSize = 64 * 1024; // 64KB
    let offset = 0;

    const writeNextChunk = () => {
      while (offset < buffer.length) {
        const chunk = buffer.slice(offset, offset + chunkSize);
        offset += chunkSize;

        // Check if the stream buffer is full
        if (!writeStream.write(chunk)) {
          writeStream.once('drain', writeNextChunk);
          return;
        }
      }

      // End the stream once all chunks are written
      writeStream.end();
    };

    writeStream.on('finish', resolve);
    writeStream.on('error', reject);

    // Start writing the first chunk
    writeNextChunk();
  });
}

/**
 * Reads a large file and returns its content as a single Buffer.
 * @param {string} filePath - The path of the file to read.
 * @returns {Promise<Buffer>} - A promise that resolves to the file's content as a Buffer.
 */
function readLargeFile(filePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const readStream = fs.createReadStream(filePath);

    readStream.on('data', (chunk) => {
      // Collect each chunk into the array
      chunks.push(chunk);
    });

    readStream.on('end', () => {
      // Concatenate all chunks into a single Buffer
      resolve(Buffer.concat(chunks));
    });

    readStream.on('error', (err) => {
      // Handle errors
      reject(err);
    });
  });
}

export async function findCheckpointBeforeOrEqualToNonce(pid, targetNonce, batchSize = 20) {
  let cursor = null;
  let foundCheckpoint = null;

  console.log(`[findCheckpointBeforeOrEqualToNonce] Searching for checkpoint for PID ${pid} with nonce <= ${targetNonce}, batch size ${batchSize}`);

  try {
    while (true) {
      const query = `
query GetCheckpoints($processId: String!, $numToFetch: Int!, $cursor: String) {
  transactions(
    first: $numToFetch,
    after: $cursor,
    sort: HEIGHT_DESC, 
    tags: [
      { name: "Type", values: ["Checkpoint"] },
      { name: "Process", values: [$processId] }
    ]
  ) {
    edges {
      cursor
      node {
        id
        tags {
          name
          value
        }
      }
    }
    pageInfo {
      hasNextPage
    }
  }
}`;
      const variables = {
        processId: pid,
        numToFetch: batchSize,
        cursor: cursor
      };

      // console.log(`[findCheckpointBeforeOrEqualToNonce] Fetching with cursor: ${cursor}`);
      const response = await fetch(`https://arweave-search.goldsky.com/graphql`, {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables })
      });

      if (!response.ok) {
        throw new Error(`GraphQL query failed for PID ${pid}: ${response.statusText} (status: ${response.status})`);
      }

      const result = await response.json();

      if (result.errors) {
        console.error("[findCheckpointBeforeOrEqualToNonce] GraphQL errors:", JSON.stringify(result.errors, null, 2));
        throw new Error(`GraphQL query returned errors: ${result.errors.map(e => e.message).join(', ')}`);
      }

      const edges = result.data?.transactions?.edges;

      if (!edges || edges.length === 0) {
        console.log("[findCheckpointBeforeOrEqualToNonce] No more checkpoints found in this page or ever.");
        break; // No more items
      }

      for (const edge of edges) {
        const checkpointNode = edge.node;
        const nonceTag = checkpointNode.tags.find(tag => tag.name === 'Nonce' || tag.name === 'Ordinate');

        if (nonceTag && nonceTag.value) {
          const checkpointNonce = Number(nonceTag.value);
          // console.log(`[findCheckpointBeforeOrEqualToNonce] Checking checkpoint ID ${checkpointNode.id} with nonce ${checkpointNonce}`);
          if (!isNaN(checkpointNonce) && checkpointNonce <= targetNonce) {
            console.log(`[findCheckpointBeforeOrEqualToNonce] Found suitable checkpoint ID ${checkpointNode.id} with nonce ${checkpointNonce} (<= target ${targetNonce}).`);
            foundCheckpoint = checkpointNode;
            return foundCheckpoint; // Found the most recent checkpoint satisfying the condition
          }
        }
      }

      if (result.data.transactions.pageInfo.hasNextPage && edges.length > 0) {
        cursor = edges[edges.length - 1].cursor;
        // console.log(`[findCheckpointBeforeOrEqualToNonce] Moving to next page with new cursor: ${cursor}`);
      } else {
        console.log("[findCheckpointBeforeOrEqualToNonce] No suitable checkpoint found and no more pages.");
        break; // No more pages
      }
    }
  } catch (err) {
    console.error(`[findCheckpointBeforeOrEqualToNonce] Error searching for checkpoint for PID ${pid} before nonce ${targetNonce}:`, err);
    throw err; // Re-throw the error after logging
  }

  if (!foundCheckpoint) {
    console.log(`[findCheckpointBeforeOrEqualToNonce] No checkpoint found for PID ${pid} with nonce <= ${targetNonce} after checking all pages.`);
  }
  return foundCheckpoint; // Will be null if nothing was found
}

export async function getTxDetails(txId) {
  try {
    const response = await fetch(`https://arweave-search.goldsky.com/graphql`, {
      method: 'POST',
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: `
query GetTransactionDetails($txId: ID!) {
  transaction(id: $txId) {
    id
    tags {
      name
      value
    }
  }
}
      `,
        variables: { txId }
      })
    });

    if (!response.ok) {
      throw new Error(`GraphQL query failed for TX ID ${txId}: ${response.statusText} (status: ${response.status})`);
    }

    const result = await response.json();

    if (result.errors) {
      console.error("[getTxDetails] GraphQL errors:", JSON.stringify(result.errors, null, 2));
      throw new Error(`GraphQL query for TX ID ${txId} returned errors: ${result.errors.map(e => e.message).join(', ')}`);
    }

    if (!result.data?.transaction) {
      console.warn(`[getTxDetails] No transaction data found for TX ID: ${txId}`);
      return null;
    }

    return result.data.transaction; // Returns node { id, tags }
  } catch (err) {
    console.error(`[getTxDetails] Error fetching details for TX ID ${txId}:`, err);
    throw err;
  }
}

export async function prepareSpecificCheckpoint(processId, checkpointTxId) {
  console.log(`[prepareSpecificCheckpoint] Preparing checkpoint ${checkpointTxId} for process ${processId}`);
  try {
    // Step 1: Fetch checkpoint data and ensure it's saved (fetchCheckpoint saves it as {checkpointTxId}.bin)
    const checkpointStateBuffer = await fetchCheckpoint(checkpointTxId);
    if (!checkpointStateBuffer) {
      return { success: false, error: `Failed to fetch checkpoint data buffer for TX ID: ${checkpointTxId}` };
    }

    const sourceCheckpointPath = `${checkpointTxId}.bin`;
    const targetStatePathForAosLoad = `${processId}.bin`;

    // Step 2: Rename the fetched file to the target name for aos.load()
    console.log(`[prepareSpecificCheckpoint] Preparing checkpoint file. Source: ${sourceCheckpointPath}, Target: ${targetStatePathForAosLoad}`);
    if (fs.existsSync(sourceCheckpointPath)) {
      if (sourceCheckpointPath !== targetStatePathForAosLoad) {
        console.log(`[prepareSpecificCheckpoint] Renaming ${sourceCheckpointPath} to ${targetStatePathForAosLoad}.`);
        await fs.promises.rename(sourceCheckpointPath, targetStatePathForAosLoad);
      } else {
        console.log(`[prepareSpecificCheckpoint] Checkpoint file ${sourceCheckpointPath} is already named as expected by aos.load for this process.`);
      }
    } else {
      // This should ideally not happen if fetchCheckpoint was successful and created the file.
      return { success: false, error: `Source checkpoint file ${sourceCheckpointPath} not found after fetchCheckpoint call.` };
    }

    // Step 3: Fetch transaction details to get the nonce
    console.log(`[prepareSpecificCheckpoint] Fetching metadata for checkpoint TX ID: ${checkpointTxId}`);
    const txDetails = await getTxDetails(checkpointTxId);
    let checkpointNonce = null;

    if (txDetails && txDetails.tags) {
      const nonceTag = txDetails.tags.find(tag => tag.name === 'Nonce' || tag.name === 'Ordinate');
      if (nonceTag && nonceTag.value) {
        const parsedNonce = Number(nonceTag.value);
        if (!isNaN(parsedNonce)) {
          checkpointNonce = parsedNonce;
          console.log(`[prepareSpecificCheckpoint] Extracted Nonce/Ordinate from checkpoint metadata: ${checkpointNonce}`);
        } else {
          console.warn(`[prepareSpecificCheckpoint] Checkpoint ${checkpointTxId} reported non-numeric Nonce/Ordinate: ${nonceTag.value}`);
        }
      } else {
        console.warn(`[prepareSpecificCheckpoint] Nonce/Ordinate tag not found in checkpoint ${checkpointTxId} metadata.`);
      }
    } else {
      console.warn(`[prepareSpecificCheckpoint] Could not retrieve tags for checkpoint TX ID ${checkpointTxId} to determine nonce.`);
    }

    return { success: true, nonce: checkpointNonce, preparedFilePath: targetStatePathForAosLoad };

  } catch (error) {
    console.error(`[prepareSpecificCheckpoint] Error preparing checkpoint ${checkpointTxId} for process ${processId}:`, error);
    return { success: false, error: error.message || 'Unknown error during checkpoint preparation' };
  }
}