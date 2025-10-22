import fs from 'fs'
import AoLoader from '@permaweb/ao-loader'
import Async from 'hyper-async'
import { fetchCheckpoint, fetchLiveState } from './checkpoint.js'
import { pack } from './pack-lua.js'
import weaveDrive from '@permaweb/weavedrive'
import { loadEnv } from './load-env.js'
import { mergeDeepRight } from 'ramda'

// Export loadEnv so other packages can use it
export { loadEnv };

const { of, fromPromise } = Async

let WASM64 = {
  format: "wasm64-unknown-emscripten-draft_2024_02_15",
  memoryLimit: "17179869184"
}

let DEFAULT_ENV = {
  Process: {
    Id: "TEST_PROCESS_ID",
    Tags: [
      { name: "Data-Protocol", value: "ao" },
      { name: "Variant", value: "ao.TN.1" },
      { name: "Type", value: "Process" },
      { name: "Authority", value: "OWNER" }
    ],
    Owner: "OWNER",
  },
  Module: {
    Id: "TESTING_ID",
    Tags: [
      { name: "Data-Protocol", value: "ao" },
      { name: "Variant", value: "ao.TN.1" },
      { name: "Type", value: "Module" },
    ]
  }
}

// CONSTANTS
export let SQLITE = "sqlite"
export let LLAMA = "llama"
export let LATEST = "module"

let aosHandle = null
let memory = null
let dryRunMemory = null

/**
 * @param {string} aosmodule - module label or txId to wasm binary
 * @param {object} [env] - The environment object.
 * @param {object} [loaderOptions] - Options for the AoLoader, e.g., { DISABLE_METERING: true, UNSAFE_MEMORY: true }.
 */
export async function aoslocal(aosmodule = LATEST, env, loaderOptions = {}) {
  // Construct options for AoLoader locally for this call
  // Start with base WASM64, add dynamic properties, then overlay loaderOptions
  const aoLoaderActualOptions = {
    ...WASM64, // Base options from module-level WASM64
    WeaveDrive: weaveDrive,
    ARWEAVE: 'https://arweave.net',
    blockHeight: 1000, // Default blockHeight for loader initialization
    spawn: {
      tags: env?.Process?.Tags ?? DEFAULT_ENV.Process.Tags
    },
    module: {
      tags: env?.Process?.Tags ?? DEFAULT_ENV.Module.Tags // Preserving original logic for module tags
    },
    ...loaderOptions // Apply new flags like DISABLE_METERING, UNSAFE_MEMORY
  };

  // const src = source ? pack(source, 'utf-8') : null

  const mod = await fetch('https://raw.githubusercontent.com/permaweb/aos/refs/heads/main/package.json')
    .then(res => res.json())
    .then(result => result.aos[aosmodule] || aosmodule)

  // Fetch module format from gateway
  const moduleInfo = await fetch('https://arweave.net/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `{
        transactions(
          ids: ["${mod}"]
        ) {
          edges {
            node {
              tags {
                name
                value
              }
            }
          }
        }
      }`
    })
  }).then(res => res.json())
    .then(result => result.data.transactions.edges[0]?.node)

  // Extract Module-Format from tags
  const moduleFormat = moduleInfo?.tags.find(tag => tag.name === 'Module-Format')?.value || 'wasm64-unknown-emscripten-draft_2024_02_15'

  // Update WASM64 format with the fetched module format
  aoLoaderActualOptions.format = moduleFormat

  const binary = await fetch('https://arweave.net/' + mod).then(res => res.blob()).then(blob => blob.arrayBuffer())

  aosHandle = await AoLoader(binary, aoLoaderActualOptions)

  // load memory with source
  let updateMemory = (ctx) => {
    memory = ctx.Memory
    return ctx
  }

  // load process message
  //if (src) {
  await of({ msg: DEFAULT_ENV.Process, env: env ?? DEFAULT_ENV })
    .map(formatAOS)
    .chain(handle(binary, memory))
    .map(updateMemory)
    .toPromise()
  //}

  return {
    cloneDryRunSnapshot: () => {
      try {
        dryRunMemory = memory ? Buffer.from(memory) : null
        return { success: true, hasSnapshot: !!dryRunMemory }
      } catch (e) {
        return { success: false, error: e?.message }
      }
    },
    asOwner: async (pid) => {
      DEFAULT_ENV = await loadEnv(pid)
      // use pid to get the process tags and module tags to set as env
      return true
    },
    src: (srcFile, env = {}) =>
      of(srcFile)
        .map(pack)
        .map(src => ({ expr: src, env: mergeDeepRight(DEFAULT_ENV, env) }))
        .map(formatEval)
        .chain(handle(binary, memory))
        .map(updateMemory)
        .toPromise(),
    fromCheckpoint: (cid) => of(cid)
      .chain(fromPromise(fetchCheckpoint))
      .map(Buffer.from)
      .map(m => {
        updateMemory({ Memory: m })
        // For consistency, if fromCheckpoint might also return headers in future,
        // it should be structured similarly. For now, just return true or a simple object.
        return { success: true, source: 'checkpoint' };
      })

      .toPromise(),
    load: (pid) => of(pid)
      .chain(fromPromise(fetchLiveState)) // fetchLiveState now returns { buffer, headers }
      .map(result => {
        updateMemory({ Memory: Buffer.from(result.buffer) })
        return result.headers // Return the headers object
      })
      .toPromise(),
    eval: (expr, env = {}) => of({ expr, env: mergeDeepRight(DEFAULT_ENV, env) })
      .map(formatEval)
      .chain(handle(binary, memory))
      .toPromise()
    ,
    send: (msg, env = {}, updateMemoryFlag = true) => {
      const strategy = process.env.DRY_RUN_STRATEGY || 'snapshot'
      let memToUse
      if (updateMemoryFlag) {
        memToUse = memory
      } else if (strategy === 'snapshot') {
        // Use the maintained snapshot; if missing, fall back to a one-off clone
        memToUse = dryRunMemory || (memory ? Buffer.from(memory) : memory)
      } else if (strategy === 'clone') {
        memToUse = memory ? Buffer.from(memory) : memory
      } else {
        // default safe behavior
        memToUse = memory ? Buffer.from(memory) : memory
      }
      return of({ msg, env: mergeDeepRight(DEFAULT_ENV, env) })
        .map(formatAOS)
        .chain(handle(binary, memToUse))
        .map(ctx => {
          if (updateMemoryFlag) {
            return updateMemory(ctx)
          }
          return ctx
        })
        .toPromise()
    }
  }
}



function formatEval(ctx) {
  ctx.msg = {
    Id: "MESSAGE_ID",
    Target: ctx.env?.Process?.Id || "TEST_PROCESS_ID",
    Owner: ctx.env?.Process?.Owner || "OWNER",
    Data: ctx.expr,
    Tags: [
      { name: "Action", value: "Eval" }
    ],
    From: ctx.env?.Process.Owner || "OWNER",
    Timestamp: Date.now().toString(),
    Module: ctx.env?.Module?.Id || "MODULE",
    ["Block-Height"]: "1"
  }

  return ctx
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
  //console.log(aoMsg)
  ctx.msg = aoMsg
  return ctx
}

function handle(binary, mem) {
  return (ctx) => {

    return fromPromise(aosHandle)(mem, ctx.msg, ctx.env)
    // return fromPromise(AoLoader)(binary, WASM64)
    //   .chain(h => {
    //     console.log('memory: ', mem.byteLength)
    //     return fromPromise(h)(mem, ctx.msg, ctx.env)
    //   })
  }
}

