import Database from 'better-sqlite3';

let dbInstance = null;
let insertStatement = null;

export function initDatabase(dbPath = 'aos-results.db') {
    if (dbInstance) return dbInstance;

    dbInstance = new Database(dbPath);
    // Improve concurrency and durability
    dbInstance.pragma('journal_mode = wal');

    dbInstance.exec(`
        CREATE TABLE IF NOT EXISTS process_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL,
            process_id TEXT NOT NULL,
            target TEXT,
            assignment_nonce INTEGER,
            output TEXT,
            messages TEXT,
            spawns TEXT,
            error TEXT,
            assignments TEXT,
            gas_used INTEGER,
            emulated INTEGER NOT NULL DEFAULT 0,
            write_mode INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_process_results_message_id ON process_results(message_id);
        CREATE INDEX IF NOT EXISTS idx_process_results_process_id ON process_results(process_id);
    `);

    insertStatement = dbInstance.prepare(`
        INSERT INTO process_results (
            message_id, process_id, target, assignment_nonce,
            output, messages, spawns, error, assignments, gas_used,
            emulated, write_mode
        ) VALUES (
            @message_id, @process_id, @target, @assignment_nonce,
            @output, @messages, @spawns, @error, @assignments, @gas_used,
            @emulated, @write_mode
        )
    `);

    return dbInstance;
}

function safeStringify(value) {
    try {
        if (value === undefined) return null;
        return JSON.stringify(value);
    } catch (_err) {
        return null;
    }
}

export function saveProcessResult({
    messageId,
    processId,
    target,
    assignmentNonce,
    result,
    emulated = false,
    writeMode = false
}) {
    if (!dbInstance || !insertStatement) {
        throw new Error('Database not initialized. Call initDatabase() first.');
    }

    const row = {
        message_id: messageId ?? 'UNKNOWN',
        process_id: processId ?? 'UNKNOWN',
        target: target ?? null,
        assignment_nonce: Number.isFinite(assignmentNonce) ? assignmentNonce : null,
        output: safeStringify(result?.Output),
        messages: safeStringify(result?.Messages),
        spawns: safeStringify(result?.Spawns),
        error: safeStringify(result?.Error),
        assignments: safeStringify(result?.Assignments),
        gas_used: result?.GasUsed ?? null,
        emulated: emulated ? 1 : 0,
        write_mode: writeMode ? 1 : 0
    };

    const info = insertStatement.run(row);
    return info.lastInsertRowid;
}



