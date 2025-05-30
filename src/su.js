// import { Transform } from 'node:stream'
// import { Resolved, of, fromPromise } from 'hyper-async'
// import { isNotNil, join, split, mergeRight, isNil } from 'ramda'
import { z } from 'zod'

// Schema definitions
const messageSchema = z.object({
    Id: z.string(),
    Timestamp: z.number(),
    Owner: z.string(),
    Tags: z.array(z.object({ name: z.string(), value: z.string() })),
    'Block-Height': z.number(),
    Data: z.string().optional(),
    Target: z.string().optional(),
    From: z.string().optional(),
    'Hash-Chain': z.string().optional(),
    Cron: z.boolean().optional(),
    Nonce: z.number().optional(),
    Epoch: z.number().optional()
})

const ctxSchema = z.object({
    processId: z.string(),
    timestamp: z.number(),
    nonce: z.number(),
    result: z.record(z.any()).optional(),
    from: z.number().optional(),
    fromBlockHeight: z.number().optional(),
    fromCron: z.string().optional(),
    exact: z.boolean().default(false),
    fromNonce: z.number().optional(),
    toNonce: z.number().optional()
}).passthrough()

// Utility functions
const trimSlash = (url) => url.replace(/\/$/, '')
const parseTags = (tags) => tags.reduce((acc, tag) => ({ ...acc, [tag.name]: tag.value }), {})

// In-memory storage for caching
const cache = {
    evaluations: new Map(),
    processMemory: new Map(),
    messageData: new Map(),
    messageMeta: new Map()
}

// Core functionality
export class AoReadState {
    constructor({
        fetch = globalThis.fetch,
        logger = console,
        cacheEnabled = true,
        suUrl = null
    }) {
        this.fetch = fetch
        this.logger = logger
        this.cacheEnabled = cacheEnabled
        this.suUrl = suUrl
    }

    // Helper method to get logger with context
    getLogger(context) {
        if (typeof this.logger.child === 'function') {
            return this.logger.child(context)
        }
        // If logger doesn't support child method, return a wrapper that adds context
        return {
            info: (...args) => this.logger.info(`[${context}]`, ...args),
            error: (...args) => this.logger.error(`[${context}]`, ...args),
            warn: (...args) => this.logger.warn(`[${context}]`, ...args),
            debug: (...args) => this.logger.debug(`[${context}]`, ...args)
        }
    }

    // Cache management
    async findEvaluation({ processId, to, ordinate, cron }) {
        if (!this.cacheEnabled) return null
        const key = `${processId}:${to}:${ordinate}:${cron}`
        return cache.evaluations.get(key)
    }

    async findLatestProcessMemory({ processId, timestamp }) {
        if (!this.cacheEnabled) return null
        const memories = cache.processMemory.get(processId) || []
        return memories.find(m => m.timestamp <= timestamp)?.memory || null
    }

    async saveLatestProcessMemory({ processId, memory, timestamp }) {
        if (!this.cacheEnabled) return
        const memories = cache.processMemory.get(processId) || []
        memories.push({ memory, timestamp })
        cache.processMemory.set(processId, memories)
    }

    async loadTransactionData(messageId) {
        if (this.cacheEnabled && cache.messageData.has(messageId)) {
            return cache.messageData.get(messageId)
        }
        const response = await this.fetch(`/data/${messageId}`)
        const data = await response.text()
        if (this.cacheEnabled) {
            cache.messageData.set(messageId, data)
        }
        return data
    }

    async loadTransactionMeta(messageId) {
        if (this.cacheEnabled && cache.messageMeta.has(messageId)) {
            return cache.messageMeta.get(messageId)
        }
        const response = await this.fetch(`/meta/${messageId}`)
        const meta = await response.json()
        if (this.cacheEnabled) {
            cache.messageMeta.set(messageId, meta)
        }
        return meta
    }

    async findMessageBefore({ messageId, deepHash, isAssignment, processId, epoch, nonce }) {
        if (!this.cacheEnabled) return false
        const key = `${processId}:${epoch}:${nonce}`
        return cache.evaluations.has(key)
    }

    async evaluateMessage({ first, message, prev, ctx }) {
        const logger = this.getLogger('evaluateMessage')

        try {
            // Handle assignment messages
            if (message.isAssignment) {
                const assignment = await this.loadTransactionData(message.Id)
                const assignmentData = JSON.parse(assignment)

                return {
                    ...prev,
                    assignments: {
                        ...(prev.assignments || {}),
                        [message.Id]: {
                            data: assignmentData,
                            timestamp: message.Timestamp,
                            blockHeight: message['Block-Height']
                        }
                    },
                    lastMessageId: message.Id,
                    lastTimestamp: message.Timestamp,
                    lastBlockHeight: message['Block-Height'],
                    GasUsed: 0
                }
            }

            // Handle regular messages
            const output = {
                ...prev,
                lastMessageId: message.Id,
                lastTimestamp: message.Timestamp,
                lastBlockHeight: message['Block-Height'],
                GasUsed: 0
            }

            // Process message data if present
            if (message.Data) {
                try {
                    const data = JSON.parse(message.Data)

                    // Combine with assignments if they exist
                    if (data.assignments && prev.assignments) {
                        data.assignments = {
                            ...prev.assignments,
                            ...data.assignments
                        }
                    }

                    output.lastData = data
                } catch (e) {
                    output.lastData = message.Data
                }
            }

            // Handle deep hash messages
            if (message.deepHash) {
                const deepHashData = await this.loadTransactionData(message.Id)
                try {
                    const parsedData = JSON.parse(deepHashData)
                    output.deepHashData = {
                        ...(output.deepHashData || {}),
                        [message.Id]: {
                            data: parsedData,
                            timestamp: message.Timestamp,
                            blockHeight: message['Block-Height']
                        }
                    }
                } catch (e) {
                    output.deepHashData = {
                        ...(output.deepHashData || {}),
                        [message.Id]: {
                            data: deepHashData,
                            timestamp: message.Timestamp,
                            blockHeight: message['Block-Height']
                        }
                    }
                }
            }

            return output
        } catch (error) {
            logger.error('Error evaluating message:', error)
            throw error
        }
    }

    async loadProcessMeta({ processId, messageId, to, ordinate, cron, fromNonce, toNonce }) {
        const logger = this.getLogger('loadProcessMeta')

        try {
            // If suUrl is configured, use it directly
            if (this.suUrl) {
                return {
                    suUrl: this.suUrl,
                    processId,
                    messageId,
                    to,
                    ordinate,
                    cron,
                    fromNonce,
                    toNonce
                }
            }

            // Otherwise load process metadata from SU
            const response = await this.fetch(`/su/${processId}/meta`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            })

            if (!response.ok) {
                throw new Error(`Failed to load process meta: ${response.status} ${response.statusText}`)
            }

            const processMeta = await response.json()

            return {
                suUrl: processMeta.suUrl,
                signature: processMeta.signature,
                data: processMeta.data,
                anchor: processMeta.anchor,
                owner: processMeta.owner,
                tags: processMeta.tags,
                block: processMeta.block,
                processId,
                messageId,
                to,
                ordinate,
                cron,
                fromNonce,
                toNonce
            }
        } catch (error) {
            logger.error('Error loading process meta:', error)
            throw error
        }
    }

    async loadProcess(ctx) {
        const logger = this.getLogger('loadProcess')

        try {
            // Check for cached evaluation
            const evaluation = await this.findEvaluation({
                processId: ctx.processId,
                to: ctx.to,
                ordinate: ctx.ordinate,
                cron: ctx.cron
            })

            if (evaluation) {
                logger.info('Found cached evaluation')
                return {
                    ...ctx,
                    result: evaluation.output,
                    from: evaluation.timestamp,
                    ordinate: evaluation.ordinate,
                    fromBlockHeight: evaluation.blockHeight,
                    fromCron: evaluation.cron,
                    exact: true,
                    fromNonce: ctx.fromNonce,
                    toNonce: ctx.toNonce
                }
            }

            // Load latest process memory
            const memory = await this.findLatestProcessMemory({
                processId: ctx.processId,
                timestamp: ctx.from
            })

            return {
                ...ctx,
                result: memory || {},
                from: ctx.from,
                ordinate: ctx.ordinate,
                fromBlockHeight: ctx.fromBlockHeight,
                fromCron: ctx.fromCron,
                fromNonce: ctx.fromNonce,
                toNonce: ctx.toNonce
            }
        } catch (error) {
            logger.error('Error loading process:', error)
            throw error
        }
    }

    async mapNode(node) {
        const logger = this.getLogger('mapNode')

        try {
            // Extract data from the nested message and assignment structures
            const messageData = node.message
            const assignmentData = node.assignment

            if (!messageData) {
                logger.warn('Node is missing message data:', node)
                // Decide how to handle this - throw error or return null/default?
                // For now, let's throw, as core data is missing.
                throw new Error('Node message data is missing')
            }

            // Parse assignment tags to get metadata
            const assignmentTags = assignmentData?.tags ? parseTags(assignmentData.tags) : {}

            // Extract basic message properties from node.message
            const message = {
                Id: messageData.id,
                // Timestamp from assignment tags, default to 0 or handle differently?
                Timestamp: assignmentTags.Timestamp ? parseInt(assignmentTags.Timestamp, 10) : undefined,
                Owner: messageData.owner?.address, // Get address from owner object
                Tags: messageData.tags || [],
                // Block-Height from assignment tags
                'Block-Height': assignmentTags['Block-Height'] ? parseInt(assignmentTags['Block-Height'], 10) : undefined,
                Data: messageData.data,
                // Use processId as fallback if message target is null/undefined
                Target: messageData.target ?? node.aoGlobal?.process?.id,
                From: messageData.tags?.find(t => t.name === 'From-Process')?.value || messageData.from,
                // Hash-Chain from assignment tags
                'Hash-Chain': assignmentTags['Hash-Chain'],
                // Cron - needs clarification where this comes from in the new structure
                Cron: messageData.cron || assignmentTags.Cron || false, // Assuming it might be in message or tags
                // Nonce from assignment tags
                Nonce: assignmentTags.Nonce ? parseInt(assignmentTags.Nonce, 10) : undefined,
                // Epoch from assignment tags
                Epoch: assignmentTags.Epoch ? parseInt(assignmentTags.Epoch, 10) : undefined,
                // How to determine deepHash and isAssignment from the new structure?
                // These might need specific tags or logic based on the presence of assignmentData
                deepHash: assignmentTags.deepHash, // Placeholder - assuming a tag exists
                isAssignment: !!assignmentData // Mark as assignment if assignmentData exists
            }

            // Add all tags as key-value pairs
            if (messageData.tags) {
                messageData.tags.forEach(tag => {
                    // Note: This might overwrite existing properties if tag names conflict
                    // Ensure numeric fields are parsed as numbers
                    if (['Nonce', 'Timestamp', 'Block-Height', 'Epoch'].includes(tag.name)) {
                        const parsedValue = parseInt(tag.value, 10)
                        // Only assign if parsing is successful, otherwise keep original or let validation handle it
                        if (!isNaN(parsedValue)) {
                            message[tag.name] = parsedValue
                        } else {
                            // Optionally log a warning if parsing fails for a numeric field
                            logger.warn(`Failed to parse numeric value for tag '${tag.name}': ${tag.value}`)
                            // Assign the original string value if parsing fails, Zod will catch it
                            message[tag.name] = tag.value
                        }
                    } else {
                        message[tag.name] = tag.value
                    }
                })
            }

            // Add AoGlobal context if available (adjust path if needed)
            // Assuming aoGlobal context is still relevant and passed correctly
            if (node.aoGlobal) {
                message.AoGlobal = {
                    Process: {
                        Id: node.aoGlobal.process?.id,
                        Owner: node.aoGlobal.process?.owner,
                        Tags: node.aoGlobal.process?.tags || []
                    }
                }
            }

            // Validate the mapped message
            const validationResult = messageSchema.safeParse(message)
            if (!validationResult.success) {
                logger.error('Zod validation failed for mapped node:', validationResult.error.errors)
                logger.error('Message object being validated:', message)
                logger.error('Original node:', JSON.stringify(node, null, 2)) // Log original node for debugging
                // Decide on error handling: throw, return null, or a default object?
                // Throwing for now to make issues visible.
                throw new Error(`Zod validation failed: ${validationResult.error.message}`)
            }
            // logger.info('Transformed message:', validationResult.data)
            return validationResult.data
        } catch (error) {
            logger.error('Error mapping node:', error)
            logger.error('Original node causing error:', JSON.stringify(node, null, 2)) // Log node on any error
            throw error // Re-throw the error after logging
        }
    }

    async loadMessages(ctx) {
        const logger = this.getLogger('loadMessages')

        try {
            // Build query parameters
            const queryParams = new URLSearchParams({
                limit: 500 // Configurable page size
            })

            // Only add nonce parameters if they are defined
            if (ctx.fromNonce) {
                queryParams.append('from-nonce', ctx.fromNonce)
            }
            if (ctx.toNonce) {
                queryParams.append('to-nonce', ctx.toNonce)
            }

            const requestUrl = `${ctx.suUrl}/${ctx.processId}?${queryParams.toString()}`
            logger.info('Making request to:', requestUrl)
            logger.info('Context:', JSON.stringify(ctx, null, 2))

            const response = await this.fetch(requestUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            })

            if (!response.ok) {
                const errorText = await response.text()
                logger.error('Response error:', {
                    status: response.status,
                    statusText: response.statusText,
                    body: errorText
                })
                throw new Error(`Failed to load messages: ${response.status} ${response.statusText}\n${errorText}`)
            }

            const messages = await response.json()

            // Map each node using mapNode
            const mappedMessages = await Promise.all(
                messages.edges.map(async (edge) => {
                    const node = {
                        ...edge.node,
                        aoGlobal: {
                            process: {
                                id: ctx.processId,
                                owner: ctx.owner,
                                tags: ctx.tags
                            }
                        }
                    }
                    return this.mapNode(node)
                })
            )

            return {
                ...ctx,
                messages: mappedMessages
            }
        } catch (error) {
            logger.error('Error loading messages:', error)
            throw error
        }
    }

    async hydrateMessages(ctx) {
        const logger = this.getLogger('hydrateMessages')

        try {
            const hydratedMessages = await Promise.all(
                ctx.messages.map(async (message) => {
                    // Load message data if needed
                    if (message.Data === undefined) {
                        const data = await this.loadTransactionData(message.Id)
                        message.Data = await data.text()
                    }

                    // Validate message against schema
                    return messageSchema.parse(message)
                })
            )

            return {
                ...ctx,
                messages: hydratedMessages
            }
        } catch (error) {
            logger.error('Error hydrating messages:', error)
            throw error
        }
    }

    async evaluate(ctx) {
        const logger = this.getLogger('evaluate')

        try {
            let prev = ctx.result
            let first = true
            let totalGasUsed = BigInt(0)

            for (const message of ctx.messages) {
                // Skip if message already evaluated
                if (message.deepHash || message.isAssignment) {
                    const exists = await this.findMessageBefore({
                        messageId: message.Id,
                        deepHash: message.deepHash,
                        isAssignment: message.isAssignment,
                        processId: ctx.processId,
                        epoch: message.Epoch,
                        nonce: message.Nonce
                    })

                    if (exists) {
                        logger.info(`Skipping already evaluated message: ${message.Id}`)
                        continue
                    }
                }

                // Evaluate message
                const output = await this.evaluateMessage({
                    first,
                    message,
                    prev,
                    ctx
                })

                // Update state
                prev = output
                first = false
                totalGasUsed += BigInt(output.GasUsed || 0)
            }

            // Save latest process memory
            await this.saveLatestProcessMemory({
                processId: ctx.processId,
                memory: prev,
                timestamp: ctx.messages[ctx.messages.length - 1]?.Timestamp
            })

            return {
                ...ctx,
                output: prev,
                last: {
                    timestamp: ctx.messages[ctx.messages.length - 1]?.Timestamp,
                    blockHeight: ctx.messages[ctx.messages.length - 1]?.['Block-Height'],
                    ordinate: ctx.messages[ctx.messages.length - 1]?.ordinate,
                    cron: ctx.messages[ctx.messages.length - 1]?.Cron
                }
            }
        } catch (error) {
            logger.error('Error evaluating messages:', error)
            throw error
        }
    }

    async readState({ processId, messageId, to, ordinate, cron, fromNonce, toNonce }) {
        const logger = this.getLogger('readState')
        const startTime = new Date()

        try {
            // Chain the operations, including nonce parameters
            const ctx = await this.loadProcessMeta({ processId, messageId, to, ordinate, cron, fromNonce, toNonce })
            const processCtx = await this.loadProcess(ctx)

            // If we found an exact match, return it
            if (processCtx.exact) {
                return {
                    result: processCtx.result,
                    from: processCtx.from,
                    ordinate: processCtx.ordinate,
                    fromBlockHeight: processCtx.fromBlockHeight,
                    fromCron: processCtx.fromCron,
                    fromNonce: processCtx.fromNonce,
                    toNonce: processCtx.toNonce
                }
            }

            // Otherwise continue with full evaluation
            const messagesCtx = await this.loadMessages(processCtx)
            const hydratedCtx = await this.hydrateMessages(messagesCtx)
            const result = await this.evaluate(hydratedCtx)

            const endTime = new Date()
            logger.info(`readState completed in ${endTime - startTime}ms`)

            return {
                result: result.output,
                from: result.last.timestamp,
                ordinate: result.last.ordinate,
                fromBlockHeight: result.last.blockHeight,
                fromCron: result.last.cron,
                fromNonce: result.fromNonce,
                toNonce: result.toNonce
            }
        } catch (error) {
            logger.error('Error in readState:', error)
            throw error
        }
    }
}

// Example usage:

// const readState = new AoReadState({
//     fetch: globalThis.fetch,
//     logger: console,
//     cacheEnabled: true,
//     suUrl: 'https://su-router.ao-testnet.xyz' // Set your SU URL here
// })

// const result = await readState.readState({
//     processId: 'rxxU4g-7tUHGvF28W2l53hxarpbaFR4NaSnOaxx6MIE',
//     // messageId: 'message-456',
//     // to: Date.now(),
//     fromNonce: 1,
//     toNonce: 1000,
//     cron: false
// })
// console.log(result)